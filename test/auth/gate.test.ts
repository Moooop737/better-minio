import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'
import type { AddressInfo } from 'node:net'
import { createDataPlaneGate, createOciGate, createServiceGate, parseDataPlanePath } from '../../src/auth/gate'
import { mountTokenRoute } from '../../src/auth/routes'
import { createServiceTokenVerifier } from '../../src/auth/service-token'
import { createTokenService } from '../../src/auth/token'
import { parseCidrList, parseServiceTokens } from '../../src/config'
import { GatewayError } from '../../src/core/errors'
import { renderJsonError } from '../../src/core/render'
import type { AppEnv } from '../../src/core/types'

const Tokens = createTokenService('s'.repeat(40))
const BACKEND = 'b'.repeat(32)
const D1 = 'd'.repeat(32)
const D2 = 'e'.repeat(32)
const Verifier = createServiceTokenVerifier(parseServiceTokens(`backend:${BACKEND},d1:${D1},d2:${D2}`))

let Server: ServerType
let Base = ''

beforeAll(async () => {
  const App = new Hono<AppEnv>()
  App.onError((Err, c) => {
    const Challenge = Err instanceof GatewayError ? Err.extra?.challenge : undefined
    if (typeof Challenge === 'string') c.header('WWW-Authenticate', Challenge)
    return renderJsonError(c, Err)
  })
  const Gate = createDataPlaneGate({ tokens: Tokens, bucket: 'kbfile', trustedProxies: parseCidrList('127.0.0.1,::1'), ipGateEnabled: true })
  App.on(['GET', 'HEAD', 'PUT'], '/kbfile/*', Gate, (c) => c.json({ identity: c.get('identity') }))
  App.on(['GET', 'PUT'], '/other/*', Gate, (c) => c.text('no'))
  App.post('/presign/put', createServiceGate(Verifier), (c) => c.json(c.get('identity')))
  mountTokenRoute(App, { tokens: Tokens, verifier: Verifier, pushServices: ['d1'] })
  const Oci = createOciGate(Tokens, 'https://gw.example.com')
  App.get('/v2/*', async (c) => {
    await Oci.authorize(c, 'kcplan/a', c.req.method === 'GET' && c.req.query('push') === '1' ? 'push' : 'pull')
    return c.json({ ok: true })
  })
  await new Promise<void>((Resolve) => {
    Server = serve({ fetch: App.fetch, port: 0, hostname: '127.0.0.1' }, () => Resolve())
  })
  Base = `http://127.0.0.1:${(Server.address() as AddressInfo).port}`
})

afterAll(() => {
  Server.close()
})

async function dataToken(Op: 'get' | 'put', Key: string, Ip = '203.0.113.7', ExpiresIn = 60): Promise<string> {
  return (await Tokens.issueDataPlane({ sub: 'u1', key: Key, op: Op, ip: Ip, expiresIn: ExpiresIn })).token
}

describe('dataPlaneGate', () => {
  it('合法 token + 同 IP（可信反代 XFF）→ 放行，identity 挂上', async () => {
    const Token = await dataToken('get', 'a b/中+.txt')
    const Res = await fetch(`${Base}/kbfile/a%20b/%E4%B8%AD%2B.txt?access_token=${Token}`, { headers: { 'x-forwarded-for': '203.0.113.7' } })
    expect(Res.status).toBe(200)
    expect((await Res.json()).identity).toMatchObject({ kind: 'browser', sub: 'u1', key: 'a b/中+.txt', ip: '203.0.113.7' })
  })

  it('缺 token → 401 E_TOKEN_MISSING；篡改 → 401 E_TOKEN_INVALID', async () => {
    const Missing = await fetch(`${Base}/kbfile/k`)
    expect(Missing.status).toBe(401)
    expect((await Missing.json()).code).toBe('E_TOKEN_MISSING')
    const Token = await dataToken('get', 'k')
    const Bad = await fetch(`${Base}/kbfile/k?access_token=${Token.slice(0, -3)}abc`, { headers: { 'x-forwarded-for': '203.0.113.7' } })
    expect(Bad.status).toBe(401)
    expect((await Bad.json()).code).toBe('E_TOKEN_INVALID')
  })

  it('换 IP → 403 E_IP_MISMATCH', async () => {
    const Token = await dataToken('get', 'k')
    const Res = await fetch(`${Base}/kbfile/k?access_token=${Token}`, { headers: { 'x-forwarded-for': '198.51.100.1' } })
    expect(Res.status).toBe(403)
    expect((await Res.json()).code).toBe('E_IP_MISMATCH')
  })

  it('op 错配（get token 打 PUT）→ 403；路径错配 / 别的桶 → 403', async () => {
    const Token = await dataToken('get', 'k')
    const Put = await fetch(`${Base}/kbfile/k?access_token=${Token}`, { method: 'PUT', body: 'x', headers: { 'x-forwarded-for': '203.0.113.7' } })
    expect((await Put.json()).code).toBe('E_OP_MISMATCH')
    const Other = await fetch(`${Base}/kbfile/k2?access_token=${Token}`, { headers: { 'x-forwarded-for': '203.0.113.7' } })
    expect((await Other.json()).code).toBe('E_PATH_MISMATCH')
    const Bucket = await fetch(`${Base}/other/k?access_token=${Token}`, { headers: { 'x-forwarded-for': '203.0.113.7' } })
    expect((await Bucket.json()).code).toBe('E_PATH_MISMATCH')
  })

  it('分片 PUT 的 query 不影响路径归属', async () => {
    const Token = await dataToken('put', 'big.bin')
    const Res = await fetch(`${Base}/kbfile/big.bin?partNumber=2&uploadId=abc&access_token=${Token}`, { method: 'PUT', body: 'x', headers: { 'x-forwarded-for': '203.0.113.7' } })
    expect(Res.status).toBe(200)
  })

  it('IP_GATE_ENABLED=false：跳过 IP 比对', async () => {
    const App = new Hono<AppEnv>()
    App.onError((Err, c) => renderJsonError(c, Err))
    App.get('/kbfile/*', createDataPlaneGate({ tokens: Tokens, bucket: 'kbfile', trustedProxies: [], ipGateEnabled: false }), (c) => c.text('ok'))
    const Token = await dataToken('get', 'k', '198.51.100.1')
    const Res = await App.request(`/kbfile/k?access_token=${Token}`)
    expect(Res.status).toBe(200)
  })

  it('parseDataPlanePath 解码 percent-encoding，`+` 保持字面量', () => {
    expect(parseDataPlanePath('/kbfile/a%20b/c+d.txt?x=1')).toEqual({ bucket: 'kbfile', key: 'a b/c+d.txt' })
    expect(parseDataPlanePath('/kbfile')).toBeNull()
  })
})

describe('serviceGate', () => {
  it('对的过、错的/缺失 401', async () => {
    const Ok = await fetch(`${Base}/presign/put`, { method: 'POST', headers: { authorization: `Bearer ${BACKEND}` } })
    expect(await Ok.json()).toEqual({ kind: 'service', name: 'backend' })
    const Bad = await fetch(`${Base}/presign/put`, { method: 'POST', headers: { authorization: `Bearer ${'z'.repeat(32)}` } })
    expect(Bad.status).toBe(401)
    expect((await Bad.json()).code).toBe('E_SERVICE_TOKEN')
    expect((await fetch(`${Base}/presign/put`, { method: 'POST' })).status).toBe(401)
  })
})

describe('OCI bearer', () => {
  const basic = (Name: string, Token: string): string => `Basic ${Buffer.from(`${Name}:${Token}`).toString('base64')}`

  it('无 bearer → 401 + challenge（realm/service/scope）', async () => {
    const Res = await fetch(`${Base}/v2/`)
    expect(Res.status).toBe(401)
    expect(Res.headers.get('www-authenticate')).toBe('Bearer realm="https://gw.example.com/token",service="better-minio",scope="repository:kcplan/a:pull"')
  })

  it('Basic 换 token → bearer 可 pull；d2 要 push 被裁 → 403', async () => {
    const D2Res = await fetch(`${Base}/token?service=better-minio&scope=repository:kcplan/a:pull,push`, { headers: { authorization: basic('d2', D2) } })
    expect(D2Res.status).toBe(200)
    const D2Body = await D2Res.json()
    expect(D2Body.expires_in).toBe(300)
    const Pull = await fetch(`${Base}/v2/`, { headers: { authorization: `Bearer ${D2Body.token}` } })
    expect(Pull.status).toBe(200)
    const Push = await fetch(`${Base}/v2/?push=1`, { headers: { authorization: `Bearer ${D2Body.token}` } })
    expect(Push.status).toBe(403)
    expect((await Push.json()).code).toBe('E_SCOPE')

    const D1Body = await (await fetch(`${Base}/token?service=better-minio&scope=repository:kcplan/a:pull,push`, { headers: { authorization: basic('d1', D1) } })).json()
    expect((await fetch(`${Base}/v2/?push=1`, { headers: { authorization: `Bearer ${D1Body.token}` } })).status).toBe(200)
  })

  it('/token：Basic 缺失/坏 → 401；service 不符 → 400', async () => {
    expect((await fetch(`${Base}/token?service=better-minio`)).status).toBe(401)
    expect((await fetch(`${Base}/token?service=better-minio`, { headers: { authorization: basic('d1', D2) } })).status).toBe(401)
    expect((await fetch(`${Base}/token?service=evil`, { headers: { authorization: basic('d1', D1) } })).status).toBe(400)
  })

  it('数据面 token 当 bearer 打 /v2 → 401', async () => {
    const Token = await dataToken('get', 'k')
    expect((await fetch(`${Base}/v2/`, { headers: { authorization: `Bearer ${Token}` } })).status).toBe(401)
  })
})
