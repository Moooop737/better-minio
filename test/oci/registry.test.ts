/**
 * OCI registry 全链路 —— moto 作 MinIO 替身，fetch 模拟 OCI client（oras 未安装，按其协议行为手写）：
 * Basic 换 bearer → POST 开会话 → PATCH 分块 → PUT ?digest 收尾 → manifest PUT（.kcplan mediaType + annotations）
 * → tags/list → 按 tag / digest 拉 manifest → 拉 blob 校验 SHA-256。
 * 另覆盖：monolithic、digest 篡改清理、tag 不可变、引用完整性、scope / challenge、跨 repo 未链 404、
 * 无 Redis 重启索引仍在、上传临时对象清理、错误体格式与限流。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ensureBucket } from '../../src/api/bucket'
import { getBytes, listByPrefix, putBytes } from '../../src/api/registry'
import { GatewayError } from '../../src/core/errors'
import { createMemoryStateStore } from '../../src/core/state'
import { startOciCleanup } from '../../src/oci/gc'
import { startS3, s3Available } from '../helpers/s3'
import type { TestS3 } from '../helpers/s3'
import { REGISTRY_BUCKET, startRegistry } from './harness'
import type { Registry } from './harness'

const REPO = 'kcplan/demo-app'
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json'
const KC_CONFIG = 'application/vnd.kc.plan.config.v1+json'
const KC_LAYER = 'application/vnd.kc.plan.layer.v1.tar+gzip'

describe.skipIf(!s3Available)('oci registry（moto）', () => {
  let S3: TestS3
  let Reg: Registry
  let Push: string
  let Pull: string

  beforeAll(async () => {
    S3 = await startS3()
    await ensureBucket(S3.client, REGISTRY_BUCKET)
    Reg = await startRegistry({ client: S3.client })
    Push = await Reg.token('d1', `repository:${REPO}:pull,push`)
    Pull = await Reg.token('d2', `repository:${REPO}:pull`)
  }, 30_000)

  afterAll(async () => {
    await Reg?.close()
    await S3?.stop()
  })

  describe('鉴权面', () => {
    it('GET /v2/ 无 bearer → 401 UNAUTHORIZED + WWW-Authenticate challenge；有 bearer → 200 {}', async () => {
      const Anon = await Reg.call('/v2/', null)
      expect(Anon.status).toBe(401)
      expect(Anon.headers.get('www-authenticate')).toBe(`Bearer realm="${Reg.url}/token",service="better-minio"`)
      expect(Anon.headers.get('docker-distribution-api-version')).toBe('registry/2.0')
      expect(((await Anon.json()) as ErrorBody).errors[0]?.code).toBe('UNAUTHORIZED')

      const Ok = await Reg.call('/v2/', Pull)
      expect(Ok.status).toBe(200)
      expect(Ok.headers.get('docker-distribution-api-version')).toBe('registry/2.0')
      expect(await Ok.json()).toEqual({})
    })

    it('repo 端点无 bearer → 401，challenge 带当前请求 scope', async () => {
      const Res = await Reg.call(`/v2/${REPO}/blobs/uploads/`, null, { method: 'POST' })
      expect(Res.status).toBe(401)
      expect(Res.headers.get('www-authenticate')).toContain(`scope="repository:${REPO}:pull,push"`)
    })

    it('d2 申请 push → token 被裁成只 pull → push 403 DENIED（insufficient_scope），pull 端点放行', async () => {
      const D2 = await Reg.token('d2', `repository:${REPO}:pull,push`)
      const Res = await Reg.call(`/v2/${REPO}/blobs/uploads/`, D2, { method: 'POST' })
      expect(Res.status).toBe(403)
      expect(Res.headers.get('www-authenticate')).toContain('error="insufficient_scope"')
      expect(((await Res.json()) as ErrorBody).errors[0]?.code).toBe('DENIED')
    })

    it('篡改 bearer → 401 invalid_token', async () => {
      const Res = await Reg.call('/v2/', `${Pull.slice(0, -2)}xx`)
      expect(Res.status).toBe(401)
      expect(Res.headers.get('www-authenticate')).toContain('error="invalid_token"')
    })

    it('非法 repo 名 → 400 NAME_INVALID；未知端点 → 404', async () => {
      const Bad = await Reg.call('/v2/Bad_Name/tags/list', Pull)
      expect(Bad.status).toBe(400)
      expect(((await Bad.json()) as ErrorBody).errors[0]?.code).toBe('NAME_INVALID')
      expect((await Reg.call(`/v2/${REPO}/whatever`, Pull)).status).toBe(404)
    })
  })

  describe('push / pull 全链路', () => {
    const Config = Buffer.from(JSON.stringify({ name: 'demo-app', version: '1.2.0', protocol_version: 1 }))
    const Layer = randomBytes(8 * 1024 * 1024 + 300_000) // > 一个 8 MiB part：收尾拼接走 multipart
    let ManifestBody: Buffer
    let ManifestDigest: string

    it('config monolithic（POST → PUT 带全量 body）→ 201', async () => {
      const Digest = digestOf(Config)
      const Uuid = await openSession(Reg, REPO, Push)
      const Res = await Reg.call(`${Uuid}?digest=${Digest}`, Push, { method: 'PUT', body: Config, headers: { 'Content-Type': 'application/octet-stream' } })
      expect(Res.status).toBe(201)
      expect(Res.headers.get('docker-content-digest')).toBe(Digest)
      expect(Res.headers.get('location')).toBe(`/v2/${REPO}/blobs/${Digest}`)
    })

    it('layer 分块 PATCH（Content-Range）→ PUT ?digest 带末段 → 201，临时对象清干净', async () => {
      const Digest = digestOf(Layer)
      const Location = await openSession(Reg, REPO, Push)
      const Cuts = [0, 3_000_000, 6_500_000, Layer.byteLength - 1000, Layer.byteLength]
      for (let I = 0; I < 3; I++) {
        const Start = Cuts[I] ?? 0
        const End = Cuts[I + 1] ?? 0
        const Res = await Reg.call(Location, Push, {
          method: 'PATCH',
          body: Layer.subarray(Start, End),
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': `${Start}-${End - 1}` },
        })
        expect(Res.status).toBe(202)
        expect(Res.headers.get('range')).toBe(`0-${End - 1}`)
        expect(Res.headers.get('docker-upload-uuid')).toBe(Location.split('/').pop())
      }
      const Status = await Reg.call(Location, Push)
      expect(Status.status).toBe(204)
      expect(Status.headers.get('range')).toBe(`0-${(Cuts[3] ?? 0) - 1}`)

      const Done = await Reg.call(`${Location}?digest=${Digest}`, Push, { method: 'PUT', body: Layer.subarray(Cuts[3]) })
      expect(Done.status).toBe(201)
      expect(Done.headers.get('docker-content-digest')).toBe(Digest)
      expect(await listByPrefix(S3.client, REGISTRY_BUCKET, 'uploads/')).toEqual([])
      expect(await Reg.stateStore.scan('better-minio:oci:upload:')).toEqual([])
    })

    it('HEAD blob → 200 + Content-Length + Docker-Content-Digest', async () => {
      const Res = await Reg.call(`/v2/${REPO}/blobs/${digestOf(Layer)}`, Pull, { method: 'HEAD' })
      expect(Res.status).toBe(200)
      expect(Res.headers.get('content-length')).toBe(String(Layer.byteLength))
      expect(Res.headers.get('docker-content-digest')).toBe(digestOf(Layer))
    })

    it('manifest PUT（.kcplan mediaType + annotations，ref=tag）→ 201', async () => {
      ManifestBody = Buffer.from(
        JSON.stringify({
          schemaVersion: 2,
          mediaType: OCI_MANIFEST,
          config: { mediaType: KC_CONFIG, digest: digestOf(Config), size: Config.byteLength },
          layers: [{ mediaType: KC_LAYER, digest: digestOf(Layer), size: Layer.byteLength, annotations: { 'org.opencontainers.image.title': 'demo-app.kcplan' } }],
          annotations: {
            name: 'demo-app',
            version: '1.2.0',
            plan_id: 'plan-123',
            protocol_version: '1',
            source: 'd1',
            required_capabilities: 'net,fs',
          },
        }),
      )
      ManifestDigest = digestOf(ManifestBody)
      const Res = await Reg.call(`/v2/${REPO}/manifests/1.2.0`, Push, { method: 'PUT', body: ManifestBody, headers: { 'Content-Type': OCI_MANIFEST } })
      expect(Res.status).toBe(201)
      expect(Res.headers.get('docker-content-digest')).toBe(ManifestDigest)
      expect(Res.headers.get('location')).toBe(`/v2/${REPO}/manifests/${ManifestDigest}`)
    })

    it('tags/list → {name, tags}', async () => {
      const Res = await Reg.call(`/v2/${REPO}/tags/list`, Pull)
      expect(Res.status).toBe(200)
      expect(await Res.json()).toEqual({ name: REPO, tags: ['1.2.0'] })
    })

    it('按 tag 与按 digest 拉 manifest 一致；HEAD 只回头', async () => {
      for (const Ref of ['1.2.0', ManifestDigest]) {
        const Res = await Reg.call(`/v2/${REPO}/manifests/${Ref}`, Pull, { headers: { Accept: OCI_MANIFEST } })
        expect(Res.status).toBe(200)
        expect(Res.headers.get('content-type')).toBe(OCI_MANIFEST)
        expect(Res.headers.get('docker-content-digest')).toBe(ManifestDigest)
        const Body = Buffer.from(await Res.arrayBuffer())
        expect(Body.equals(ManifestBody)).toBe(true)
      }
      const Head = await Reg.call(`/v2/${REPO}/manifests/1.2.0`, Pull, { method: 'HEAD' })
      expect(Head.status).toBe(200)
      expect(Head.headers.get('content-length')).toBe(String(ManifestBody.byteLength))
      expect(Head.headers.get('docker-content-digest')).toBe(ManifestDigest)
    })

    it('按 manifest 解出的 layer digest 拉 blob → SHA-256 一致；Range → 206', async () => {
      const Manifest = (await (await Reg.call(`/v2/${REPO}/manifests/1.2.0`, Pull)).json()) as { layers: { digest: string }[]; annotations: Record<string, string> }
      expect(Manifest.annotations.plan_id).toBe('plan-123')
      const LayerDigest = Manifest.layers[0]?.digest ?? ''
      const Res = await Reg.call(`/v2/${REPO}/blobs/${LayerDigest}`, Pull)
      expect(Res.status).toBe(200)
      expect(Res.headers.get('docker-content-digest')).toBe(LayerDigest)
      expect(digestOf(Buffer.from(await Res.arrayBuffer()))).toBe(LayerDigest)

      const Part = await Reg.call(`/v2/${REPO}/blobs/${LayerDigest}`, Pull, { headers: { Range: 'bytes=10-19' } })
      expect(Part.status).toBe(206)
      expect(Part.headers.get('content-range')).toBe(`bytes 10-19/${Layer.byteLength}`)
      expect(Buffer.from(await Part.arrayBuffer()).equals(Layer.subarray(10, 20))).toBe(true)
    })

    it('tag 不可变：同 digest 重推幂等 201；异 digest 重推 409 TAG_INVALID', async () => {
      const Same = await Reg.call(`/v2/${REPO}/manifests/1.2.0`, Push, { method: 'PUT', body: ManifestBody, headers: { 'Content-Type': OCI_MANIFEST } })
      expect(Same.status).toBe(201)
      const Other = Buffer.from(ManifestBody.toString().replace('plan-123', 'plan-456'))
      const Diff = await Reg.call(`/v2/${REPO}/manifests/1.2.0`, Push, { method: 'PUT', body: Other, headers: { 'Content-Type': OCI_MANIFEST } })
      expect(Diff.status).toBe(409)
      expect(((await Diff.json()) as ErrorBody).errors[0]?.code).toBe('TAG_INVALID')
    })

    it('manifest 按 digest 推：digest 不符 → 400 DIGEST_INVALID', async () => {
      const Res = await Reg.call(`/v2/${REPO}/manifests/${digestOf(Buffer.from('x'))}`, Push, { method: 'PUT', body: ManifestBody, headers: { 'Content-Type': OCI_MANIFEST } })
      expect(Res.status).toBe(400)
      expect(((await Res.json()) as ErrorBody).errors[0]?.code).toBe('DIGEST_INVALID')
    })

    it('跨 repo：blob 未链入的 repo 拉 → 404 BLOB_UNKNOWN；该 repo 重传同内容（幂等 201）后可拉', async () => {
      const Other = 'kcplan/other-app'
      const OtherPush = await Reg.token('d1', `repository:${Other}:pull,push`)
      const Seed = Buffer.from('seed')
      await monolithic(Reg, Other, OtherPush, Seed)

      const Missing = await Reg.call(`/v2/${Other}/blobs/${digestOf(Config)}`, OtherPush)
      expect(Missing.status).toBe(404)
      expect(((await Missing.json()) as ErrorBody).errors[0]?.code).toBe('BLOB_UNKNOWN')

      const Unknown = await Reg.call(`/v2/kcplan/never-pushed/blobs/${digestOf(Config)}`, await Reg.token('d1', 'repository:kcplan/never-pushed:pull'))
      expect(Unknown.status).toBe(404)
      expect(((await Unknown.json()) as ErrorBody).errors[0]?.code).toBe('NAME_UNKNOWN')

      expect((await monolithic(Reg, Other, OtherPush, Config)).status).toBe(201)
      const Linked = await Reg.call(`/v2/${Other}/blobs/${digestOf(Config)}`, OtherPush)
      expect(Linked.status).toBe(200)
      expect(Buffer.from(await Linked.arrayBuffer()).equals(Config)).toBe(true)
    })

    it('无 Redis 重启：新 mountOci + 新内存 StateStore，tag / manifest / blob 仍在', async () => {
      const Restarted = await startRegistry({ client: S3.client, stateStore: createMemoryStateStore() })
      try {
        const Token = await Restarted.token('d2', `repository:${REPO}:pull`)
        expect(await (await Restarted.call(`/v2/${REPO}/tags/list`, Token)).json()).toEqual({ name: REPO, tags: ['1.2.0'] })
        const Manifest = await Restarted.call(`/v2/${REPO}/manifests/1.2.0`, Token)
        expect(Manifest.headers.get('docker-content-digest')).toBe(ManifestDigest)
        await Manifest.arrayBuffer()
        const Blob = await Restarted.call(`/v2/${REPO}/blobs/${digestOf(Layer)}`, Token)
        expect(digestOf(Buffer.from(await Blob.arrayBuffer()))).toBe(digestOf(Layer))
      } finally {
        await Restarted.close()
      }
    })

    it('DELETE tag → 202，tag 摘除、按 digest 仍可拉；DELETE digest → 202，再拉 404 MANIFEST_UNKNOWN', async () => {
      const Repo = 'kcplan/delete-me'
      const Token = await Reg.token('d1', `repository:${Repo}:pull,push`)
      await monolithic(Reg, Repo, Token, Config)
      await monolithic(Reg, Repo, Token, Buffer.from('layer'))
      const Body = Buffer.from(
        JSON.stringify({
          schemaVersion: 2,
          mediaType: OCI_MANIFEST,
          config: { mediaType: KC_CONFIG, digest: digestOf(Config), size: Config.byteLength },
          layers: [{ mediaType: KC_LAYER, digest: digestOf(Buffer.from('layer')), size: 5 }],
        }),
      )
      expect((await Reg.call(`/v2/${Repo}/manifests/0.1.0`, Token, { method: 'PUT', body: Body, headers: { 'Content-Type': OCI_MANIFEST } })).status).toBe(201)
      expect((await Reg.call(`/v2/${Repo}/manifests/0.1.0`, Token, { method: 'DELETE' })).status).toBe(202)
      expect(await (await Reg.call(`/v2/${Repo}/tags/list`, Token)).json()).toEqual({ name: Repo, tags: [] })
      expect((await Reg.call(`/v2/${Repo}/manifests/${digestOf(Body)}`, Token, { method: 'HEAD' })).status).toBe(200)
      expect((await Reg.call(`/v2/${Repo}/manifests/${digestOf(Body)}`, Token, { method: 'DELETE' })).status).toBe(202)
      const Gone = await Reg.call(`/v2/${Repo}/manifests/${digestOf(Body)}`, Token)
      expect(Gone.status).toBe(404)
      expect(((await Gone.json()) as ErrorBody).errors[0]?.code).toBe('MANIFEST_UNKNOWN')
      /* DELETE blob 只解链：本 repo 拉不到，对象仍在（其他 repo 可能共享） */
      expect((await Reg.call(`/v2/${Repo}/blobs/${digestOf(Config)}`, Token, { method: 'DELETE' })).status).toBe(202)
      expect((await Reg.call(`/v2/${Repo}/blobs/${digestOf(Config)}`, Token, { method: 'HEAD' })).status).toBe(404)
      expect(await getBytes(S3.client, REGISTRY_BUCKET, `blobs/sha256/${digestOf(Config).slice(7)}`)).not.toBeNull()
    })
  })

  describe('上传异常路径', () => {
    it('单请求 monolithic：POST ?digest= 带 body → 201', async () => {
      const Data = Buffer.from('one-shot blob')
      const Res = await Reg.call(`/v2/${REPO}/blobs/uploads/?digest=${digestOf(Data)}`, Push, { method: 'POST', body: Data })
      expect(Res.status).toBe(201)
      expect(Res.headers.get('docker-content-digest')).toBe(digestOf(Data))
      expect((await Reg.call(`/v2/${REPO}/blobs/${digestOf(Data)}`, Pull, { method: 'HEAD' })).status).toBe(200)
    })

    it('digest 篡改 → 400 DIGEST_INVALID；final / chunk / 会话清干净；blob 不进内容寻址区', async () => {
      const Data = randomBytes(4096)
      const Wrong = digestOf(Buffer.from('something else'))
      const Location = await openSession(Reg, REPO, Push)
      const Uuid = Location.split('/').pop() ?? ''
      expect((await Reg.call(Location, Push, { method: 'PATCH', body: Data.subarray(0, 1000) })).status).toBe(202)
      const Res = await Reg.call(`${Location}?digest=${Wrong}`, Push, { method: 'PUT', body: Data.subarray(1000) })
      expect(Res.status).toBe(400)
      expect(((await Res.json()) as ErrorBody).errors[0]?.code).toBe('DIGEST_INVALID')
      expect(await listByPrefix(S3.client, REGISTRY_BUCKET, `uploads/${Uuid}/`)).toEqual([])
      expect(await getBytes(S3.client, REGISTRY_BUCKET, `blobs/sha256/${Wrong.slice(7)}`)).toBeNull()
      expect(await getBytes(S3.client, REGISTRY_BUCKET, `blobs/sha256/${digestOf(Data).slice(7)}`)).toBeNull()
      const Again = await Reg.call(Location, Push, { method: 'PATCH', body: Data })
      expect(Again.status).toBe(404)
      expect(((await Again.json()) as ErrorBody).errors[0]?.code).toBe('BLOB_UPLOAD_UNKNOWN')
    })

    it('PATCH Content-Range 起点不符 → 416 + 当前 Range', async () => {
      const Location = await openSession(Reg, REPO, Push)
      expect((await Reg.call(Location, Push, { method: 'PATCH', body: Buffer.from('abc'), headers: { 'Content-Range': '0-2' } })).status).toBe(202)
      const Res = await Reg.call(Location, Push, { method: 'PATCH', body: Buffer.from('def'), headers: { 'Content-Range': '10-12' } })
      expect(Res.status).toBe(416)
      expect(Res.headers.get('range')).toBe('0-2')
      expect((await Reg.call(Location, Push, { method: 'DELETE' })).status).toBe(204)
      expect((await Reg.call(Location, Push)).status).toBe(404)
    })

    it('manifest 引用未上传 blob → 400 MANIFEST_BLOB_UNKNOWN', async () => {
      const Body = JSON.stringify({
        schemaVersion: 2,
        mediaType: OCI_MANIFEST,
        config: { mediaType: KC_CONFIG, digest: digestOf(Buffer.from('nope-config')), size: 11 },
        layers: [],
      })
      const Res = await Reg.call(`/v2/${REPO}/manifests/9.9.9`, Push, { method: 'PUT', body: Body, headers: { 'Content-Type': OCI_MANIFEST } })
      expect(Res.status).toBe(400)
      const Error_ = ((await Res.json()) as ErrorBody).errors[0]
      expect(Error_?.code).toBe('MANIFEST_BLOB_UNKNOWN')
      expect(Error_?.detail).toEqual({ digests: [digestOf(Buffer.from('nope-config'))] })
    })

    it('manifest 结构坏 → 400 MANIFEST_INVALID；mediaType 不支持 → 415 UNSUPPORTED', async () => {
      const Bad = await Reg.call(`/v2/${REPO}/manifests/x`, Push, { method: 'PUT', body: '{not json', headers: { 'Content-Type': OCI_MANIFEST } })
      expect(Bad.status).toBe(400)
      expect(((await Bad.json()) as ErrorBody).errors[0]?.code).toBe('MANIFEST_INVALID')
      const Index = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [] })
      const Unsupported = await Reg.call(`/v2/${REPO}/manifests/x`, Push, { method: 'PUT', body: Index, headers: { 'Content-Type': 'application/vnd.oci.image.index.v1+json' } })
      expect(Unsupported.status).toBe(415)
      expect(((await Unsupported.json()) as ErrorBody).errors[0]?.code).toBe('UNSUPPORTED')
    })

    it('manifest > 4 MiB → 400 MANIFEST_INVALID', async () => {
      const Huge = Buffer.alloc(4 * 1024 * 1024 + 1, 0x20)
      const Res = await Reg.call(`/v2/${REPO}/manifests/huge`, Push, { method: 'PUT', body: Huge, headers: { 'Content-Type': OCI_MANIFEST } })
      expect(Res.status).toBe(400)
      expect(((await Res.json()) as ErrorBody).errors[0]?.code).toBe('MANIFEST_INVALID')
    })

    it('不存在的 repo：tags/list / manifest → 404 NAME_UNKNOWN', async () => {
      const Token = await Reg.token('d2', 'repository:kcplan/ghost:pull')
      const Res = await Reg.call('/v2/kcplan/ghost/tags/list', Token)
      expect(Res.status).toBe(404)
      expect(((await Res.json()) as ErrorBody).errors[0]?.code).toBe('NAME_UNKNOWN')
    })
  })

  describe('上传临时对象清理（gc）', () => {
    it('过期会话 → 删 chunk + 会话；无会话孤儿对象超 TTL → 删；未过期的不动', async () => {
      const Store = createMemoryStateStore()
      const Short = await startRegistry({ client: S3.client, stateStore: Store, uploadTtl: 60 })
      try {
        const Token = await Short.token('d1', `repository:${REPO}:pull,push`)
        const Location = await openSession(Short, REPO, Token)
        const Uuid = Location.split('/').pop() ?? ''
        expect((await Short.call(Location, Token, { method: 'PATCH', body: Buffer.from('chunk-data') })).status).toBe(202)
        const Orphan = `uploads/${randomUUID()}/chunk-0`
        await putBytes(S3.client, REGISTRY_BUCKET, Orphan, Buffer.from('orphan'), { contentType: 'application/octet-stream' })

        const Fresh = startOciCleanup({ internalClient: S3.client, registryBucket: REGISTRY_BUCKET, stateStore: Store, uploadTtl: 60 })
        expect(await Fresh.runOnce()).toBe(0)
        Fresh.stop()
        expect(await listByPrefix(S3.client, REGISTRY_BUCKET, `uploads/${Uuid}/`)).toHaveLength(1)

        const Later = Date.now() + 61_000
        const Expired = startOciCleanup({ internalClient: S3.client, registryBucket: REGISTRY_BUCKET, stateStore: Store, uploadTtl: 60, now: () => Later })
        expect(await Expired.runOnce()).toBe(2)
        Expired.stop()
        expect(await listByPrefix(S3.client, REGISTRY_BUCKET, 'uploads/')).toEqual([])
        expect(await Store.scan('better-minio:oci:upload:')).toEqual([])
      } finally {
        await Short.close()
      }
    })
  })

  describe('限流', () => {
    it('rateLimit 在闸之后调用，超额 → 429 TOOMANYREQUESTS + Retry-After', async () => {
      const Calls: string[] = []
      const Limited = await startRegistry({
        client: S3.client,
        rateLimit: async (c) => {
          Calls.push(c.get('identity').kind)
          throw new GatewayError('E_RATE_LIMIT', '请求过于频繁', { retryAfter: 7 })
        },
      })
      try {
        expect((await Limited.call('/v2/', null)).status).toBe(401)
        expect(Calls).toEqual([])
        const Res = await Limited.call('/v2/', await Limited.token('d2', `repository:${REPO}:pull`))
        expect(Res.status).toBe(429)
        expect(Res.headers.get('retry-after')).toBe('7')
        expect(((await Res.json()) as ErrorBody).errors[0]?.code).toBe('TOOMANYREQUESTS')
        expect(Calls).toEqual(['registry'])
      } finally {
        await Limited.close()
      }
    })
  })
})

interface ErrorBody {
  errors: { code: string; message: string; detail?: unknown }[]
}

function digestOf(Data: Buffer): string {
  return `sha256:${createHash('sha256').update(Data).digest('hex')}`
}

/* POST 开会话 → 返回 Location（相对路径） */
async function openSession(Reg: Registry, Repo: string, Token: string): Promise<string> {
  const Res = await Reg.call(`/v2/${Repo}/blobs/uploads/`, Token, { method: 'POST' })
  expect(Res.status).toBe(202)
  const Location = Res.headers.get('location') ?? ''
  expect(Location).toMatch(new RegExp(`^/v2/${Repo}/blobs/uploads/[0-9a-f-]{36}$`))
  expect(Res.headers.get('docker-upload-uuid')).toBe(Location.split('/').pop())
  return Location
}

async function monolithic(Reg: Registry, Repo: string, Token: string, Data: Buffer): Promise<Response> {
  const Location = await openSession(Reg, Repo, Token)
  return Reg.call(`${Location}?digest=${digestOf(Data)}`, Token, { method: 'PUT', body: Data })
}
