/**
 * presign 路由 —— service gate、400 边界、响应形状、KEY_SCHEME、限流时机、脱敏。签名本地完成，无需 S3 后端。
 * 端到端（URL 经网关打 moto）在 test/proxy/routes.test.ts。
 */

import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createS3Client } from '../../src/api/client'
import { createServiceGate } from '../../src/auth/gate'
import { createServiceTokenVerifier } from '../../src/auth/service-token'
import { createTokenService } from '../../src/auth/token'
import type { KeyScheme } from '../../src/config'
import { GatewayError } from '../../src/core/errors'
import { renderJsonError } from '../../src/core/render'
import type { AppEnv, RateLimit } from '../../src/core/types'
import { logger } from '../../src/ops/logger'
import { mountPresign } from '../../src/presign/routes'

const PUBLIC = 'https://files.example.com'
const SERVICE_TOKEN = 'svc_token_abcdefghijklmnopqrstuvwxyz012345'
const Tokens = createTokenService('test-secret-test-secret-test-secret')
const OK = { key: 'a/b.pdf', expiresIn: 300, client_ip: '203.0.113.7', sub: 'u1' }

function build(Options: { keyScheme?: KeyScheme; rateLimit?: RateLimit | null; now?: () => Date } = {}): Hono<AppEnv> {
  const App = new Hono<AppEnv>()
  App.onError((Err, c) => renderJsonError(c, Err))
  mountPresign(App, {
    publicClient: createS3Client({ endpoint: PUBLIC, region: 'us-east-1', forcePathStyle: true, accessKeyId: 'ak', secretAccessKey: 'sk' }),
    bucket: 'kbfile',
    tokens: Tokens,
    serviceGate: createServiceGate(createServiceTokenVerifier([{ name: 'backend', token: SERVICE_TOKEN }])),
    keyScheme: Options.keyScheme ?? 'flat',
    rateLimit: Options.rateLimit ?? null,
    ...(Options.now !== undefined ? { now: Options.now } : {}),
  })
  return App
}

function post(App: Hono<AppEnv>, Path: string, Body: unknown, Token: string | null = SERVICE_TOKEN): Promise<Response> {
  return Promise.resolve(
    App.request(Path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(Token !== null ? { authorization: `Bearer ${Token}` } : {}) },
      body: typeof Body === 'string' ? Body : JSON.stringify(Body),
    }),
  )
}

let Logged: string[] = []
beforeEach(() => {
  Logged = []
  vi.spyOn(logger, 'info').mockImplementation(((...Args: unknown[]) => void Logged.push(JSON.stringify(Args))) as never)
})
afterEach(() => vi.restoreAllMocks())

describe('service gate', () => {
  it('无 / 错 service token → 401 E_SERVICE_TOKEN；合法 → 200', async () => {
    const App = build()
    for (const Path of ['/presign/put', '/presign/get']) {
      for (const Token of [null, 'nope-nope-nope-nope-nope-nope-nope-nope']) {
        const Res = await post(App, Path, OK, Token)
        expect(Res.status).toBe(401)
        expect(((await Res.json()) as { code: string }).code).toBe('E_SERVICE_TOKEN')
      }
      expect((await post(App, Path, OK)).status).toBe(200)
    }
  })
})

describe('400 E_VALIDATION 边界', () => {
  const { client_ip: _Ip, ...NoIp } = OK
  const { sub: _Sub, ...NoSub } = OK
  const Bad: [string, unknown][] = [
    ['缺 client_ip', NoIp],
    ['缺 sub', NoSub],
    ['TTL 0', { ...OK, expiresIn: 0 }],
    ['TTL 604801', { ...OK, expiresIn: 604801 }],
    ['key 以 / 开头', { ...OK, key: '/a' }],
    ['client_ip 非法', { ...OK, client_ip: 'not-an-ip' }],
    ['坏 JSON', '{nope'],
    ['非对象', '[1,2]'],
  ]
  it.each(Bad)('%s → 400', async (_Name, Body) => {
    for (const Path of ['/presign/put', '/presign/get']) {
      const Res = await post(build(), Path, Body)
      expect(Res.status).toBe(400)
      const Json = (await Res.json()) as { code: string }
      expect(Json.code).toBe('E_VALIDATION')
    }
  })

  it('issues 只给字段路径，不回显请求值', async () => {
    const Res = await post(build(), '/presign/put', { ...OK, client_ip: 'evil-value-xyz', expiresIn: 604801 })
    const Text = await Res.text()
    expect(Text).toContain('client_ip')
    expect(Text).toContain('expiresIn')
    expect(Text).not.toContain('evil-value-xyz')
  })

  it('TTL 边界值 1 / 604800 通过', async () => {
    for (const ExpiresIn of [1, 604800]) expect((await post(build(), '/presign/get', { ...OK, expiresIn: ExpiresIn })).status).toBe(200)
  })
})

describe('响应形状', () => {
  it('put：{url, method:PUT, contentType, key}；URL Host = public、含 access_token 与签名', async () => {
    const Res = await post(build(), '/presign/put', { ...OK, contentType: 'application/pdf' })
    const Body = (await Res.json()) as Record<string, string>
    expect(Object.keys(Body).sort()).toEqual(['contentType', 'key', 'method', 'url'])
    expect(Body).toMatchObject({ method: 'PUT', contentType: 'application/pdf', key: 'a/b.pdf' })
    const Url = new URL(Body.url ?? '')
    expect(Url.origin).toBe(PUBLIC)
    expect(Url.searchParams.get('access_token')).toBeTruthy()
    expect(Url.searchParams.get('X-Amz-Signature')).toBeTruthy()
    expect(Url.searchParams.get('X-Amz-Expires')).toBe('300')
  })

  it('put 无 contentType：响应不含 contentType', async () => {
    const Body = (await (await post(build(), '/presign/put', OK)).json()) as Record<string, string>
    expect(Object.keys(Body).sort()).toEqual(['key', 'method', 'url'])
  })

  it('get：{url, key}，client_ip 规范化后进 token', async () => {
    const Body = (await (await post(build(), '/presign/get', { ...OK, client_ip: '::ffff:203.0.113.7' })).json()) as Record<string, string>
    expect(Object.keys(Body).sort()).toEqual(['key', 'url'])
    const Claims = await Tokens.verifyDataPlane(new URL(Body.url ?? '').searchParams.get('access_token') ?? '')
    expect(Claims.ip).toBe('203.0.113.7')
    expect(Claims.op).toBe('get')
  })
})

describe('KEY_SCHEME', () => {
  const Now = () => new Date('2026-11-23T08:00:00Z')

  it('date：put 回带 YYYY/MM/ 前缀的实际 key，URL 路径与 token.key 一致', async () => {
    const Body = (await (await post(build({ keyScheme: 'date', now: Now }), '/presign/put', OK)).json()) as Record<string, string>
    expect(Body.key).toBe('2026/11/a/b.pdf')
    const Url = new URL(Body.url ?? '')
    expect(Url.pathname).toBe('/kbfile/2026/11/a/b.pdf')
    expect((await Tokens.verifyDataPlane(Url.searchParams.get('access_token') ?? '')).key).toBe('2026/11/a/b.pdf')
  })

  it('date：get 不变换', async () => {
    const Body = (await (await post(build({ keyScheme: 'date', now: Now }), '/presign/get', OK)).json()) as Record<string, string>
    expect(Body.key).toBe('a/b.pdf')
    expect(new URL(Body.url ?? '').pathname).toBe('/kbfile/a/b.pdf')
  })

  it('flat：put 回显请求 key', async () => {
    const Body = (await (await post(build({ now: Now }), '/presign/put', OK)).json()) as Record<string, string>
    expect(Body.key).toBe('a/b.pdf')
  })
})

describe('限流与脱敏', () => {
  it('rateLimit 在 service gate 之后调用（看得到 identity），超额 429 + Retry-After', async () => {
    const Seen: string[] = []
    const App = build({
      rateLimit: async (c) => {
        const Who = c.get('identity')
        Seen.push(Who.kind === 'service' ? Who.name : Who.kind)
        throw new GatewayError('E_RATE_LIMIT', '请求过于频繁', { retryAfter: 3 })
      },
    })
    expect((await post(App, '/presign/put', OK, null)).status).toBe(401)
    const Res = await post(App, '/presign/put', OK)
    expect(Res.status).toBe(429)
    expect(Res.headers.get('retry-after')).toBe('3')
    expect(Seen).toEqual(['backend'])
  })

  it('签发日志记事实（服务名 / sub / key / op / ip / jti / exp），不含 URL / token / 签名', async () => {
    const Body = (await (await post(build(), '/presign/put', { ...OK, resource_id: 'res_9' })).json()) as Record<string, string>
    const Token = new URL(Body.url ?? '').searchParams.get('access_token') ?? ''
    expect(Logged).toHaveLength(1)
    const Line = Logged[0] ?? ''
    for (const Fact of ['"service":"backend"', '"sub":"u1"', '"key":"a/b.pdf"', '"op":"put"', '"ip":"203.0.113.7"', '"jti":', '"exp":']) {
      expect(Line).toContain(Fact)
    }
    expect(Line).not.toContain(Token)
    expect(Line).not.toContain('X-Amz-Signature')
    expect(Line).not.toContain(PUBLIC)
  })
})
