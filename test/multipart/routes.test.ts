import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { CreateBucketCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import type { AddressInfo } from 'node:net'
import { createDataPlaneGate, createServiceGate } from '../../src/auth/gate'
import { createServiceTokenVerifier } from '../../src/auth/service-token'
import { createTokenService } from '../../src/auth/token'
import { createEventBus } from '../../src/core/events'
import type { GatewayEvents } from '../../src/core/events'
import { renderJsonError } from '../../src/core/render'
import { createMemoryStateStore } from '../../src/core/state'
import type { StateStore } from '../../src/core/state'
import type { AppEnv } from '../../src/core/types'
import { mountMultipart } from '../../src/multipart/routes'
import { SESSION_GRACE_SECONDS, sessionKey } from '../../src/multipart/session'
import { startS3, s3Available } from '../helpers/s3'
import type { TestS3 } from '../helpers/s3'

const BUCKET = 'mp-routes'
const MiB = 1024 * 1024
const PS = 5 * MiB
const SERVICE = 'svc-token-'.padEnd(32, 'x')
const IP = '203.0.113.7'
const Tokens = createTokenService('s'.repeat(40))

interface Harness {
  app: Hono<AppEnv>
  store: StateStore
  completed: GatewayEvents['object:complete'][]
  clock: { now: number }
}

describe.skipIf(!s3Available)('multipart 控制面（moto）', () => {
  let S3: TestS3

  beforeAll(async () => {
    S3 = await startS3()
    await S3.client.send(new CreateBucketCommand({ Bucket: BUCKET }))
  }, 30000)

  afterAll(async () => {
    await S3?.stop()
  })

  function harness(Options: { keyScheme?: 'flat' | 'date'; sessionTtl?: number; rateLimited?: boolean } = {}): Harness {
    const App = new Hono<AppEnv>()
    App.onError((Err, c) => renderJsonError(c, Err))
    const Store = createMemoryStateStore()
    const Events = createEventBus()
    const Completed: GatewayEvents['object:complete'][] = []
    Events.on('object:complete', (P) => Completed.push(P))
    const Clock = { now: Date.UTC(2026, 10, 23, 12, 0, 0) }
    mountMultipart(App, {
      internalClient: S3.client,
      publicClient: S3.client,
      bucket: BUCKET,
      stateStore: Store,
      tokens: Tokens,
      serviceGate: createServiceGate(createServiceTokenVerifier([{ name: 'backend', token: SERVICE }])),
      sessionTtl: Options.sessionTtl ?? 86400,
      keyScheme: Options.keyScheme ?? 'flat',
      events: Events,
      rateLimit: Options.rateLimited === true
        ? async () => {
            const { GatewayError } = await import('../../src/core/errors')
            throw new GatewayError('E_RATE_LIMIT', '请求过于频繁', { retryAfter: 7 })
          }
        : null,
      now: () => Clock.now,
    })
    return { app: App, store: Store, completed: Completed, clock: Clock }
  }

  async function post(H: Harness, Path: string, Body: unknown, Auth: string | null = SERVICE): Promise<Response> {
    return H.app.request(`/multipart/${Path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(Auth !== null ? { authorization: `Bearer ${Auth}` } : {}) },
      body: typeof Body === 'string' ? Body : JSON.stringify(Body),
    })
  }

  async function create(H: Harness, Key: string, Extra: Record<string, unknown> = {}) {
    const Res = await post(H, 'create', { key: Key, sub: 'user-1', client_ip: IP, partSize: PS, ...Extra })
    expect(Res.status).toBe(200)
    return (await Res.json()) as { uploadId: string; key: string; partSize: number; expiresAt: number }
  }

  async function sign(H: Harness, UploadId: string, PartNumber: number): Promise<string> {
    const Res = await post(H, 'sign-part', { uploadId: UploadId, partNumber: PartNumber })
    expect(Res.status).toBe(200)
    return ((await Res.json()) as { url: string }).url
  }

  async function upload(Url: string, Body: Uint8Array): Promise<string> {
    const Res = await fetch(Url, { method: 'PUT', body: Body })
    expect(Res.status).toBe(200)
    return Res.headers.get('etag') ?? ''
  }

  function source(Size: number, Seed: number): Uint8Array {
    const Bytes = new Uint8Array(Size)
    for (let I = 0; I < Size; I++) Bytes[I] = (I * 31 + Seed) & 0xff
    return Bytes
  }

  function slices(Bytes: Uint8Array): Uint8Array[] {
    const Out: Uint8Array[] = []
    for (let Off = 0; Off < Bytes.length; Off += PS) Out.push(Bytes.subarray(Off, Off + PS))
    return Out
  }

  async function objectSha(Key: string): Promise<string> {
    const Obj = await S3.client.send(new GetObjectCommand({ Bucket: BUCKET, Key }))
    return createHash('sha256').update(await Obj.Body!.transformToByteArray()).digest('hex')
  }

  it('3×5MiB + 小末片：create → sign-part → PUT → complete，SHA-256 与源一致；emit object:complete；会话删除', async () => {
    const H = harness()
    const Src = source(3 * PS + 12345, 7)
    const S = await create(H, 'big/file.zip', { contentType: 'application/zip', resource_id: 'r-1' })
    expect(S.key).toBe('big/file.zip')
    expect(S.partSize).toBe(PS)
    expect(S.expiresAt).toBe(H.clock.now / 1000 + 86400)
    const Parts = []
    for (const [I, Chunk] of slices(Src).entries()) {
      Parts.push({ partNumber: I + 1, etag: await upload(await sign(H, S.uploadId, I + 1), Chunk) })
    }
    const Res = await post(H, 'complete', { uploadId: S.uploadId, parts: Parts })
    expect(Res.status).toBe(200)
    const Body = (await Res.json()) as { status: string; etag: string; key: string }
    expect(Body.status).toBe('complete')
    expect(Body.key).toBe('big/file.zip')
    expect(Body.etag).toBeTruthy()
    expect(await objectSha('big/file.zip')).toBe(createHash('sha256').update(Src).digest('hex'))
    expect(H.completed).toEqual([{ key: 'big/file.zip', contentType: 'application/zip' }])
    expect(await H.store.get(sessionKey(S.uploadId))).toBeNull()
    // complete 两次：第二次 404
    const Again = await post(H, 'complete', { uploadId: S.uploadId, parts: Parts })
    expect(Again.status).toBe(404)
    expect(((await Again.json()) as { code: string }).code).toBe('E_SESSION_NOT_FOUND')
  }, 60000)

  it('分片 URL 含 partNumber / uploadId / access_token；token 验出 op put + 会话 key + ip', async () => {
    const H = harness()
    const S = await create(H, 'sig/a.bin', { resource_id: 'r-9' })
    const Res = await post(H, 'sign-part', { uploadId: S.uploadId, partNumber: 4, expiresIn: 120 })
    const Body = (await Res.json()) as { url: string; partNumber: number; expiresIn: number }
    expect(Body.partNumber).toBe(4)
    expect(Body.expiresIn).toBe(120)
    const Url = new URL(Body.url)
    expect(Url.pathname).toBe(`/${BUCKET}/sig/a.bin`)
    expect(Url.searchParams.get('partNumber')).toBe('4')
    expect(Url.searchParams.get('uploadId')).toBe(S.uploadId)
    const Claims = await Tokens.verifyDataPlane(Url.searchParams.get('access_token') ?? '')
    expect(Claims).toMatchObject({ op: 'put', key: 'sig/a.bin', ip: IP, sub: 'user-1', resource_id: 'r-9' })
    // 每次铸新 token
    const Url2 = new URL(await sign(H, S.uploadId, 4))
    expect(Url2.searchParams.get('access_token')).not.toBe(Url.searchParams.get('access_token'))
  })

  it('缺片 → 200 incomplete + 重签 URL；补传后 complete 成功', async () => {
    const H = harness()
    const Src = source(2 * PS + 100, 3)
    const [P1, P2, P3] = slices(Src)
    const S = await create(H, 'gap/file.bin')
    const E1 = await upload(await sign(H, S.uploadId, 1), P1!)
    const E3 = await upload(await sign(H, S.uploadId, 3), P3!)
    const Parts = [{ partNumber: 1, etag: E1 }, { partNumber: 3, etag: E3 }]
    const Res = await post(H, 'complete', { uploadId: S.uploadId, parts: Parts })
    expect(Res.status).toBe(200)
    const Body = (await Res.json()) as { status: string; missing: { partNumber: number; reason: string; url: string; expiresIn: number }[] }
    expect(Body.status).toBe('incomplete')
    expect(Body.missing.map((M) => [M.partNumber, M.reason, M.expiresIn])).toEqual([[2, 'missing', 300]])
    const E2 = await upload(Body.missing[0]!.url, P2!)
    const Done = await post(H, 'complete', { uploadId: S.uploadId, parts: [...Parts, { partNumber: 2, etag: E2 }] })
    expect(((await Done.json()) as { status: string }).status).toBe('complete')
    expect(await objectSha('gap/file.bin')).toBe(createHash('sha256').update(Src).digest('hex'))
  }, 60000)

  it('ETag 不符 → etag_mismatch + 重签 URL', async () => {
    const H = harness()
    const [P1, P2] = slices(source(PS + 10, 5))
    const S = await create(H, 'etag/file.bin')
    const E1 = await upload(await sign(H, S.uploadId, 1), P1!)
    const E2 = await upload(await sign(H, S.uploadId, 2), P2!)
    const Res = await post(H, 'complete', {
      uploadId: S.uploadId,
      parts: [{ partNumber: 1, etag: '"00000000000000000000000000000000"' }, { partNumber: 2, etag: E2 }],
    })
    const Body = (await Res.json()) as { status: string; missing: { partNumber: number; reason: string; url: string }[] }
    expect(Body.status).toBe('incomplete')
    expect(Body.missing.map((M) => [M.partNumber, M.reason])).toEqual([[1, 'etag_mismatch']])
    expect(new URL(Body.missing[0]!.url).searchParams.get('partNumber')).toBe('1')
    const Done = await post(H, 'complete', { uploadId: S.uploadId, parts: [{ partNumber: 1, etag: E1 }, { partNumber: 2, etag: E2 }] })
    expect(((await Done.json()) as { status: string }).status).toBe('complete')
  }, 60000)

  it('非末片 ≠ partSize（换分法混传）→ 400 E_PART_SIZE_MISMATCH 附编号', async () => {
    const H = harness()
    const S = await create(H, 'size/mixed.bin')
    const E1 = await upload(await sign(H, S.uploadId, 1), source(PS, 1))
    const E2 = await upload(await sign(H, S.uploadId, 2), source(3 * MiB, 2))
    const E3 = await upload(await sign(H, S.uploadId, 3), source(10, 3))
    const Res = await post(H, 'complete', {
      uploadId: S.uploadId,
      parts: [{ partNumber: 1, etag: E1 }, { partNumber: 2, etag: E2 }, { partNumber: 3, etag: E3 }],
    })
    expect(Res.status).toBe(400)
    expect(await Res.json()).toMatchObject({ code: 'E_PART_SIZE_MISMATCH', partNumbers: [2] })
    // 会话仍在（可 abort 换会话）
    expect(await H.store.get(sessionKey(S.uploadId))).not.toBeNull()
  }, 60000)

  it('末片 > partSize → 400', async () => {
    const H = harness()
    const S = await create(H, 'size/last.bin')
    const E1 = await upload(await sign(H, S.uploadId, 1), source(PS, 1))
    const E2 = await upload(await sign(H, S.uploadId, 2), source(PS + 1, 2))
    const Res = await post(H, 'complete', { uploadId: S.uploadId, parts: [{ partNumber: 1, etag: E1 }, { partNumber: 2, etag: E2 }] })
    expect(Res.status).toBe(400)
    expect(await Res.json()).toMatchObject({ code: 'E_PART_SIZE_MISMATCH', partNumbers: [2] })
  }, 60000)

  it('list-parts 回已传片（断点续传）；会话过期 → 404', async () => {
    const H = harness({ sessionTtl: 600 })
    const S = await create(H, 'resume/file.bin')
    const E2 = await upload(await sign(H, S.uploadId, 2), source(100, 2))
    const E1 = await upload(await sign(H, S.uploadId, 1), source(PS, 1))
    const Res = await post(H, 'list-parts', { uploadId: S.uploadId })
    expect(Res.status).toBe(200)
    expect(await Res.json()).toEqual({
      uploadId: S.uploadId,
      key: 'resume/file.bin',
      expiresAt: S.expiresAt,
      parts: [
        { partNumber: 1, etag: E1, size: PS },
        { partNumber: 2, etag: E2, size: 100 },
      ],
    })
    H.clock.now += 600_000
    for (const Path of ['list-parts', 'sign-part', 'complete']) {
      const Expired = await post(H, Path, { uploadId: S.uploadId, partNumber: 1, parts: [{ partNumber: 1, etag: E1 }] })
      expect(Expired.status).toBe(404)
      expect(((await Expired.json()) as { code: string }).code).toBe('E_SESSION_NOT_FOUND')
    }
  }, 60000)

  it('会话存储 TTL = sessionTtl + 3600 grace', async () => {
    const H = harness({ sessionTtl: 100 })
    const Calls: (number | undefined)[] = []
    const Original = H.store.set.bind(H.store)
    H.store.set = async (K, V, Ttl) => {
      Calls.push(Ttl)
      await Original(K, V, Ttl)
    }
    await create(H, 'ttl/file.bin')
    expect(Calls).toEqual([100 + SESSION_GRACE_SECONDS])
  })

  it('abort 幂等 204；abort 后 MinIO upload 消失、会话删除', async () => {
    const H = harness()
    const S = await create(H, 'abort/file.bin')
    await upload(await sign(H, S.uploadId, 1), source(10, 1))
    const A = await post(H, 'abort', { uploadId: S.uploadId })
    expect(A.status).toBe(204)
    expect(await H.store.get(sessionKey(S.uploadId))).toBeNull()
    const B = await post(H, 'abort', { uploadId: S.uploadId })
    expect(B.status).toBe(204)
    expect((await post(H, 'abort', { uploadId: 'never-existed' })).status).toBe(204)
    expect((await post(H, 'list-parts', { uploadId: S.uploadId })).status).toBe(404)
  })

  it('MinIO 已不认 uploadId（会话还在）→ list-parts 404 并删会话', async () => {
    const H = harness()
    const S = await create(H, 'orphan/file.bin')
    const { abortMultipartUpload } = await import('../../src/api/multipart')
    await abortMultipartUpload(S3.client, BUCKET, S.key, S.uploadId)
    const Res = await post(H, 'list-parts', { uploadId: S.uploadId })
    expect(Res.status).toBe(404)
    expect(await H.store.get(sessionKey(S.uploadId))).toBeNull()
  })

  it('KEY_SCHEME=date：create 响应与会话为 YYYY/MM/ 前缀实际 key，分片 token 绑实际 key', async () => {
    const H = harness({ keyScheme: 'date' })
    const S = await create(H, 'docs/a.pdf')
    expect(S.key).toBe('2026/11/docs/a.pdf')
    const Stored = JSON.parse((await H.store.get(sessionKey(S.uploadId))) ?? '{}') as { key: string }
    expect(Stored.key).toBe('2026/11/docs/a.pdf')
    const Url = new URL(await sign(H, S.uploadId, 1))
    expect(Url.pathname).toBe(`/${BUCKET}/2026/11/docs/a.pdf`)
    expect((await Tokens.verifyDataPlane(Url.searchParams.get('access_token') ?? '')).key).toBe('2026/11/docs/a.pdf')
  })

  it('无 / 错 service token → 401 E_SERVICE_TOKEN', async () => {
    const H = harness()
    for (const Path of ['create', 'sign-part', 'list-parts', 'complete', 'abort']) {
      const Res = await post(H, Path, { uploadId: 'x' }, null)
      expect(Res.status).toBe(401)
      expect(((await Res.json()) as { code: string }).code).toBe('E_SERVICE_TOKEN')
    }
    expect((await post(H, 'abort', { uploadId: 'x' }, 'wrong')).status).toBe(401)
  })

  it('限流：闸后调用，429 + Retry-After', async () => {
    const H = harness({ rateLimited: true })
    const Res = await post(H, 'create', { key: 'k', sub: 'u', client_ip: IP, partSize: PS })
    expect(Res.status).toBe(429)
    expect(Res.headers.get('retry-after')).toBe('7')
    // 闸先于限流：无 token 仍 401
    expect((await post(H, 'create', {}, null)).status).toBe(401)
  })

  it('校验 400 E_VALIDATION', async () => {
    const H = harness()
    const Base = { key: 'v/a.bin', sub: 'u', client_ip: IP, partSize: PS }
    const Bad: [string, unknown][] = [
      ['create', '{not json'],
      ['create', { ...Base, partSize: PS - 1 }],
      ['create', { ...Base, partSize: 5.5 * MiB + 0.5 }],
      ['create', { ...Base, client_ip: 'nope' }],
      ['create', { ...Base, key: '/abs' }],
      ['create', { ...Base, sub: '' }],
      ['create', { key: 'v/a.bin', sub: 'u', partSize: PS }],
      ['sign-part', { uploadId: 'u', partNumber: 0 }],
      ['sign-part', { uploadId: 'u', partNumber: 10001 }],
      ['sign-part', { uploadId: 'u', partNumber: 1, expiresIn: 604801 }],
      ['complete', { uploadId: 'u', parts: [] }],
      ['complete', { uploadId: 'u', parts: [{ partNumber: 1, etag: 'a' }, { partNumber: 1, etag: 'b' }] }],
      ['list-parts', { uploadId: '' }],
    ]
    for (const [Path, Body] of Bad) {
      const Res = await post(H, Path, Body)
      expect(Res.status, `${Path} ${JSON.stringify(Body)}`).toBe(400)
      expect(((await Res.json()) as { code: string }).code).toBe('E_VALIDATION')
    }
    // client_ip ::ffff: 映射规范化为 IPv4（与数据面闸同规则）
    const S = await create(H, 'v/ok.bin', { client_ip: `::ffff:${IP}` })
    const Url = new URL(await sign(H, S.uploadId, 1))
    expect((await Tokens.verifyDataPlane(Url.searchParams.get('access_token') ?? '')).ip).toBe(IP)
  })

  it('分片 URL 过数据面闸：同 IP 放行，换 IP → 403 E_IP_MISMATCH', async () => {
    const H = harness()
    const Gate = new Hono<AppEnv>()
    Gate.onError((Err, c) => renderJsonError(c, Err))
    Gate.put('/*', createDataPlaneGate({ tokens: Tokens, bucket: BUCKET, trustedProxies: [], ipGateEnabled: true }), (c) => c.body(null, 200))
    const Server = serve({ fetch: Gate.fetch, port: 0, hostname: '127.0.0.1' })
    await new Promise((R) => Server.once('listening', R))
    const Port = (Server.address() as AddressInfo).port
    const viaGate = (Url: string) => {
      const U = new URL(Url)
      return `http://127.0.0.1:${Port}${U.pathname}${U.search}`
    }
    try {
      const Same = await create(H, 'gate/same.bin', { client_ip: '127.0.0.1' })
      expect((await fetch(viaGate(await sign(H, Same.uploadId, 1)), { method: 'PUT', body: 'x' })).status).toBe(200)
      const Other = await create(H, 'gate/other.bin')
      const Res = await fetch(viaGate(await sign(H, Other.uploadId, 1)), { method: 'PUT', body: 'x' })
      expect(Res.status).toBe(403)
      expect(((await Res.json()) as { code: string }).code).toBe('E_IP_MISMATCH')
    } finally {
      await new Promise((R) => Server.close(R))
    }
  })

  it('MinIO 不可达 → 502 E_UPSTREAM，message 不泄地址', async () => {
    const { createS3Client } = await import('../../src/api/client')
    const Dead = createS3Client({ endpoint: 'http://127.0.0.1:1', region: 'us-east-1', forcePathStyle: true, accessKeyId: 'a', secretAccessKey: 'b' })
    const App = new Hono<AppEnv>()
    App.onError((Err, c) => renderJsonError(c, Err))
    mountMultipart(App, {
      internalClient: Dead,
      publicClient: Dead,
      bucket: BUCKET,
      stateStore: createMemoryStateStore(),
      tokens: Tokens,
      serviceGate: createServiceGate(createServiceTokenVerifier([{ name: 'backend', token: SERVICE }])),
      sessionTtl: 60,
      keyScheme: 'flat',
      events: createEventBus(),
      rateLimit: null,
    })
    const Res = await App.request('/multipart/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE}` },
      body: JSON.stringify({ key: 'k', sub: 'u', client_ip: IP, partSize: PS }),
    })
    expect(Res.status).toBe(502)
    const Text = await Res.text()
    expect(Text).toContain('E_UPSTREAM')
    expect(Text).not.toContain('127.0.0.1')
    expect(Text).not.toContain(BUCKET)
    Dead.destroy()
  }, 30000)
})
