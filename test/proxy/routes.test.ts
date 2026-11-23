/**
 * proxy 端到端（moto 作 MinIO 替身）：mountPresign 签 URL → 真网关 server（mountProxyData）→ moto。
 * moto 不验 SigV4，故签名篡改 / 换 Content-Type 的 403 由 MinIO 出、此处不测；网关闸（JWT / IP / op）在此全测。
 */

import { CreateBucketCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { GatewayError } from '../../src/core/errors'
import { logger } from '../../src/ops/logger'
import { startS3, s3Available } from '../helpers/s3'
import type { TestS3 } from '../helpers/s3'
import { startGateway } from './harness'
import type { Gateway } from './harness'

const BUCKET = 'kbfile'
const CLIENT_IP = '127.0.0.1'

describe.skipIf(!s3Available)('proxy 数据面 + 控制端点（moto）', () => {
  let S3: TestS3
  let Gw: Gateway
  let Proxied: Gateway
  let Logged: string[] = []

  beforeAll(async () => {
    S3 = await startS3()
    await S3.client.send(new CreateBucketCommand({ Bucket: BUCKET }))
    Gw = await startGateway({ s3Endpoint: S3.endpoint, bucket: BUCKET, corsOrigins: ['https://app.example'] })
    Proxied = await startGateway({ s3Endpoint: S3.endpoint, bucket: BUCKET, trustedProxies: '127.0.0.1/32' })
    for (const Level of ['info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(logger, Level).mockImplementation(((...Args: unknown[]) => {
        Logged.push(JSON.stringify(Args))
      }) as never)
    }
  }, 30_000)

  afterAll(async () => {
    vi.restoreAllMocks()
    await Gw?.close()
    await Proxied?.close()
    await S3?.stop()
  })

  afterEach(() => {
    Logged = []
  })

  async function presignUrl(G: Gateway, Op: 'put' | 'get', Key: string, Extra: Record<string, unknown> = {}): Promise<string> {
    const Res = await G.presign(Op, { key: Key, expiresIn: 300, client_ip: CLIENT_IP, sub: 'u1', ...Extra })
    expect(Res.status).toBe(200)
    return ((await Res.json()) as { url: string }).url
  }

  async function seed(Key: string, Body: string, ContentType = 'text/plain'): Promise<void> {
    await S3.client.send(new PutObjectCommand({ Bucket: BUCKET, Key, Body, ContentType }))
  }

  describe('presigned 直连网关', () => {
    it('GET 200 / Range 206 + Content-Range / HEAD 200 带 ETag', async () => {
      await seed('docs/a.txt', 'hello world')
      const Url = await presignUrl(Gw, 'get', 'docs/a.txt')
      const Full = await fetch(Url)
      expect(Full.status).toBe(200)
      expect(await Full.text()).toBe('hello world')
      const Ranged = await fetch(Url, { headers: { range: 'bytes=0-4' } })
      expect(Ranged.status).toBe(206)
      expect(Ranged.headers.get('content-range')).toBe('bytes 0-4/11')
      expect(await Ranged.text()).toBe('hello')
      const Head = await fetch(Url, { method: 'HEAD' })
      expect(Head.status).toBe(200)
      expect(Head.headers.get('etag')).toMatch(/^"[0-9a-f]+"$/)
      expect(Head.headers.get('content-length')).toBe('11')
    })

    it('responseContentDisposition 原样出现在响应头', async () => {
      await seed('docs/d.pdf', 'pdf')
      const Disposition = "attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf"
      const Url = await presignUrl(Gw, 'get', 'docs/d.pdf', { responseContentDisposition: Disposition, responseContentType: 'application/pdf' })
      const Res = await fetch(Url)
      expect(Res.status).toBe(200)
      expect(Res.headers.get('content-disposition')).toBe(Disposition)
      expect(Res.headers.get('content-type')).toBe('application/pdf')
    })

    it('PUT 200 → 对象落成 + object:put 事件（key / contentType / size）', async () => {
      const Seen: unknown[] = []
      const Off = Gw.events.on('object:put', (P) => Seen.push(P))
      const Url = await presignUrl(Gw, 'put', 'up/b.txt', { contentType: 'text/plain' })
      const Res = await fetch(Url, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'uploaded!' })
      Off()
      expect(Res.status).toBe(200)
      expect(Res.headers.get('etag')).toBeTruthy()
      const Got = await S3.client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'up/b.txt' }))
      expect(await Got.Body?.transformToString()).toBe('uploaded!')
      expect(Seen).toEqual([{ key: 'up/b.txt', contentType: 'text/plain', size: 9 }])
    })

    it('分片 PUT（query 带 partNumber/uploadId）不发 object:put', async () => {
      const Seen: unknown[] = []
      const Off = Gw.events.on('object:put', (P) => Seen.push(P))
      const Url = new URL(await presignUrl(Gw, 'put', 'up/part.bin'))
      Url.searchParams.set('partNumber', '1')
      Url.searchParams.set('uploadId', 'nonexistent')
      const Res = await fetch(Url, { method: 'PUT', body: 'x' })
      Off()
      expect(Res.status).not.toBe(200)
      expect(Seen).toEqual([])
    })

    it('If-None-Match: * 命中已存在对象 → 412（上游出，透传）', async () => {
      await seed('up/exists.txt', 'old')
      const Url = await presignUrl(Gw, 'put', 'up/exists.txt')
      const Res = await fetch(Url, { method: 'PUT', headers: { 'if-none-match': '*' }, body: 'new' })
      expect(Res.status).toBe(412)
      expect(await Res.text()).toContain('PreconditionFailed')
    })

    it('key 含空格 / 中文 / + 往返一致（原始编码保真，闸路径匹配）', async () => {
      const Key = 'dir/a b+c 中文.txt'
      const Put = await presignUrl(Gw, 'put', Key)
      expect((await fetch(Put, { method: 'PUT', body: 'special' })).status).toBe(200)
      const Got = await S3.client.send(new GetObjectCommand({ Bucket: BUCKET, Key }))
      expect(await Got.Body?.transformToString()).toBe('special')
      const Get = await fetch(await presignUrl(Gw, 'get', Key))
      expect(Get.status).toBe(200)
      expect(await Get.text()).toBe('special')
    })
  })

  describe('闸（S3 XML 错误）', () => {
    it('无 token → 401 InvalidRequest XML，带网关 RequestId', async () => {
      await seed('docs/a.txt', 'hello world')
      const Url = new URL(await presignUrl(Gw, 'get', 'docs/a.txt'))
      Url.searchParams.delete('access_token')
      const Res = await fetch(Url)
      expect(Res.status).toBe(401)
      expect(Res.headers.get('content-type')).toContain('application/xml')
      const Body = await Res.text()
      expect(Body).toContain('<Code>InvalidRequest</Code>')
      expect(Body).toMatch(/<RequestId>req-\d+<\/RequestId>/)
    })

    it('篡改 token → 401', async () => {
      const Url = new URL(await presignUrl(Gw, 'get', 'docs/a.txt'))
      const Token = Url.searchParams.get('access_token') ?? ''
      Url.searchParams.set('access_token', `${Token.slice(0, -2)}xx`)
      const Res = await fetch(Url)
      expect(Res.status).toBe(401)
      expect(await Res.text()).toContain('<Code>InvalidRequest</Code>')
    })

    it('过期 token → 401', async () => {
      await seed('docs/exp.txt', 'x')
      const Expired = await Gw.tokens.issueDataPlane({ sub: 'u', key: 'docs/exp.txt', op: 'get', ip: CLIENT_IP, expiresIn: -10 })
      const Res = await fetch(`${Gw.url}/${BUCKET}/docs/exp.txt?access_token=${Expired.token}`)
      expect(Res.status).toBe(401)
    })

    it('换 IP → 403 AccessDenied（可信反代 XFF 模拟另一客户端）；同 IP 通过', async () => {
      await seed('docs/ip.txt', 'ip')
      const Res = await Proxied.presign('get', { key: 'docs/ip.txt', expiresIn: 300, client_ip: '203.0.113.7', sub: 'u1' })
      const { url } = (await Res.json()) as { url: string }
      const Other = await fetch(url, { headers: { 'x-forwarded-for': '198.51.100.9' } })
      expect(Other.status).toBe(403)
      expect(await Other.text()).toContain('<Code>AccessDenied</Code>')
      const Same = await fetch(url, { headers: { 'x-forwarded-for': '203.0.113.7' } })
      expect(Same.status).toBe(200)
      expect(await Same.text()).toBe('ip')
    })

    it('get token 打 PUT → 403；put token 打 GET → 403', async () => {
      const GetUrl = await presignUrl(Gw, 'get', 'docs/a.txt')
      expect((await fetch(GetUrl, { method: 'PUT', body: 'x' })).status).toBe(403)
      const PutUrl = await presignUrl(Gw, 'put', 'docs/a.txt')
      expect((await fetch(PutUrl)).status).toBe(403)
    })

    it('token 绑定的 key 与路径不符 → 403', async () => {
      const Url = new URL(await presignUrl(Gw, 'get', 'docs/a.txt'))
      const Res = await fetch(`${Gw.url}/${BUCKET}/docs/other.txt${Url.search}`)
      expect(Res.status).toBe(403)
    })

    it('DELETE / POST → 405 MethodNotAllowed XML（闸前，无 token 也 405）', async () => {
      for (const Method of ['DELETE', 'POST', 'PATCH']) {
        const Res = await fetch(`${Gw.url}/${BUCKET}/docs/a.txt`, { method: Method })
        expect(Res.status).toBe(405)
        expect(Res.headers.get('allow')).toBe('GET, HEAD, PUT, OPTIONS')
        expect(await Res.text()).toContain('<Code>MethodNotAllowed</Code>')
      }
      expect((await S3.client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'docs/a.txt' }))).ContentLength).toBe(11)
    })

    it('其他 bucket → 404 NoSuchBucket（闸前）；桶级路径 → 404 NoSuchKey', async () => {
      const Other = await fetch(`${Gw.url}/otherbucket/docs/a.txt`)
      expect(Other.status).toBe(404)
      expect(await Other.text()).toContain('<Code>NoSuchBucket</Code>')
      for (const Path of [`/${BUCKET}`, `/${BUCKET}/`]) {
        const Res = await fetch(`${Gw.url}${Path}`)
        expect(Res.status).toBe(404)
        expect(await Res.text()).toContain('<Code>NoSuchKey</Code>')
      }
    })

    it('HEAD 被闸拒 → 状态码对、无 body', async () => {
      const Res = await fetch(`${Gw.url}/${BUCKET}/docs/a.txt`, { method: 'HEAD' })
      expect(Res.status).toBe(401)
      expect(await Res.text()).toBe('')
    })

    it('rateLimit 在闸之后调用，超额 429 SlowDown + Retry-After', async () => {
      const Calls: string[] = []
      const Limited = await startGateway({
        s3Endpoint: S3.endpoint,
        bucket: BUCKET,
        rateLimit: async (c) => {
          const Who = c.get('identity')
          Calls.push(Who.kind)
          if (Who.kind === 'browser') throw new GatewayError('E_RATE_LIMIT', '请求过于频繁', { retryAfter: 7 })
        },
      })
      try {
        const Url = await presignUrl(Limited, 'get', 'docs/a.txt')
        const Res = await fetch(Url)
        expect(Res.status).toBe(429)
        expect(Res.headers.get('retry-after')).toBe('7')
        expect(await Res.text()).toContain('<Code>SlowDown</Code>')
        expect((await fetch(`${Limited.url}/${BUCKET}/docs/a.txt`)).status).toBe(401)
        expect(Calls).toEqual(['service', 'browser'])
      } finally {
        await Limited.close()
      }
    })
  })

  describe('控制端点 /objects/*', () => {
    it('stat 存在 200 {size, contentType, etag} / 不存在 404 E_NOT_FOUND', async () => {
      await seed('ctl/s.txt', '12345', 'text/csv')
      const Hit = await Gw.control('/objects/stat', { key: 'ctl/s.txt' })
      expect(Hit.status).toBe(200)
      const Body = (await Hit.json()) as { size: number; contentType: string; etag: string }
      expect(Body.size).toBe(5)
      expect(Body.contentType).toBe('text/csv')
      expect(Body.etag).toMatch(/^"/)
      const Miss = await Gw.control('/objects/stat', { key: 'ctl/missing.txt' })
      expect(Miss.status).toBe(404)
      expect(((await Miss.json()) as { code: string }).code).toBe('E_NOT_FOUND')
    })

    it('delete 204 幂等（两次都 204）+ object:delete 事件', async () => {
      await seed('ctl/d.txt', 'bye')
      const Seen: unknown[] = []
      const Off = Gw.events.on('object:delete', (P) => Seen.push(P))
      expect((await Gw.control('/objects/delete', { key: 'ctl/d.txt' })).status).toBe(204)
      expect((await Gw.control('/objects/delete', { key: 'ctl/d.txt' })).status).toBe(204)
      Off()
      expect((await Gw.control('/objects/stat', { key: 'ctl/d.txt' })).status).toBe(404)
      expect(Seen).toEqual([{ key: 'ctl/d.txt' }, { key: 'ctl/d.txt' }])
    })

    it('无 / 错 service token → 401 E_SERVICE_TOKEN JSON', async () => {
      for (const Token of [null, 'wrong-token-wrong-token-wrong-token-xx']) {
        const Res = await Gw.control('/objects/stat', { key: 'ctl/s.txt' }, Token)
        expect(Res.status).toBe(401)
        expect(((await Res.json()) as { code: string }).code).toBe('E_SERVICE_TOKEN')
      }
    })

    it('key 校验同 presign：空 / 以 / 开头 / 坏 JSON → 400 E_VALIDATION', async () => {
      for (const Body of [{ key: '' }, { key: '/abs' }, {}, 'not json']) {
        const Res = await Gw.control('/objects/delete', Body)
        expect(Res.status).toBe(400)
        expect(((await Res.json()) as { code: string }).code).toBe('E_VALIDATION')
      }
    })

    it('上游不可达 → 502 E_UPSTREAM，错误体不含 MinIO 地址', async () => {
      const Dead = await startGateway({ s3Endpoint: 'http://127.0.0.1:1', bucket: BUCKET })
      try {
        const Res = await Dead.control('/objects/stat', { key: 'ctl/s.txt' })
        expect(Res.status).toBe(502)
        const Text = await Res.text()
        expect(Text).toContain('E_UPSTREAM')
        expect(Text).not.toContain('127.0.0.1:1')
        expect(Text).not.toContain('ctl/s.txt')
      } finally {
        await Dead.close()
      }
    }, 20_000)
  })

  describe('CORS', () => {
    it('白名单 origin 预检：204 + Allow-*，不带 token 也通，不带 Allow-Credentials', async () => {
      const Res = await fetch(`${Gw.url}/${BUCKET}/docs/a.txt?X-Amz-Signature=x`, {
        method: 'OPTIONS',
        headers: { origin: 'https://app.example', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type,x-amz-meta-foo' },
      })
      expect(Res.status).toBe(204)
      expect(Res.headers.get('access-control-allow-origin')).toBe('https://app.example')
      expect(Res.headers.get('access-control-allow-methods')).toBe('GET, PUT, HEAD, OPTIONS')
      expect(Res.headers.get('access-control-allow-headers')).toContain('x-amz-meta-foo')
      expect(Res.headers.get('access-control-max-age')).toBe('86400')
      expect(Res.headers.get('access-control-allow-credentials')).toBeNull()
      expect(Res.headers.get('vary')).toContain('Origin')
    })

    it('非白名单 origin 预检 → 204 无 CORS 头', async () => {
      const Res = await fetch(`${Gw.url}/${BUCKET}/docs/a.txt`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } })
      expect(Res.status).toBe(204)
      expect(Res.headers.get('access-control-allow-origin')).toBeNull()
    })

    it('实际响应：白名单 origin 回显 + expose ETag（上游 CORS 头被剥）；错误响应也带', async () => {
      await seed('docs/a.txt', 'hello world')
      const Url = await presignUrl(Gw, 'get', 'docs/a.txt')
      const Res = await fetch(Url, { headers: { origin: 'https://app.example' } })
      expect(Res.status).toBe(200)
      expect(Res.headers.get('access-control-allow-origin')).toBe('https://app.example')
      expect(Res.headers.get('access-control-expose-headers')).toContain('ETag')
      const Denied = await fetch(`${Gw.url}/${BUCKET}/docs/a.txt`, { headers: { origin: 'https://app.example' } })
      expect(Denied.status).toBe(401)
      expect(Denied.headers.get('access-control-allow-origin')).toBe('https://app.example')
      const Foreign = await fetch(Url, { headers: { origin: 'https://evil.example' } })
      expect(Foreign.headers.get('access-control-allow-origin')).toBeNull()
    })

    it('CORS_ORIGINS 为空 → 预检 204 且无任何 CORS 头', async () => {
      const Res = await fetch(`${Proxied.url}/${BUCKET}/docs/a.txt`, { method: 'OPTIONS', headers: { origin: 'https://app.example', 'access-control-request-method': 'GET' } })
      expect(Res.status).toBe(204)
      expect([...Res.headers.keys()].filter((Name) => Name.startsWith('access-control-'))).toEqual([])
      expect(Res.headers.get('vary')).toBeNull()
    })
  })

  describe('脱敏', () => {
    it('错误体与日志不含 MinIO 地址 / token / 完整 URL', async () => {
      const Url = await presignUrl(Gw, 'get', 'docs/a.txt')
      const Token = new URL(Url).searchParams.get('access_token') ?? ''
      const Bodies: string[] = []
      Bodies.push(await (await fetch(Url, { method: 'PUT', body: 'x' })).text())
      Bodies.push(await (await fetch(`${Gw.url}/otherbucket/k`)).text())
      Bodies.push(await (await Gw.presign('get', { key: '/bad', expiresIn: 0 })).text())
      const Moto = new URL(S3.endpoint).host
      for (const Text of [...Bodies, ...Logged]) {
        expect(Text).not.toContain(Moto)
        expect(Text).not.toContain(Token)
        expect(Text).not.toContain('X-Amz-Signature')
      }
      expect(Logged.some((Line) => Line.includes('presign'))).toBe(true)
    })

    it('数据面上游不可达 → 502 XML，体与日志不含地址', async () => {
      const Dead = await startGateway({ s3Endpoint: 'http://127.0.0.1:1', bucket: BUCKET })
      try {
        const Url = await presignUrl(Dead, 'get', 'docs/a.txt')
        const Res = await fetch(Url)
        expect(Res.status).toBe(502)
        const Text = await Res.text()
        expect(Text).toContain('<Code>ServiceUnavailable</Code>')
        for (const Line of [Text, ...Logged]) expect(Line).not.toContain('127.0.0.1:1')
        expect(Logged.some((Line) => Line.includes('ECONNREFUSED'))).toBe(true)
      } finally {
        await Dead.close()
      }
    }, 20_000)
  })
})
