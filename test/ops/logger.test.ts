import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createDataPlaneGate } from '../../src/auth/gate'
import { createTokenService } from '../../src/auth/token'
import { parseCidrList } from '../../src/config'
import { renderJsonError } from '../../src/core/render'
import type { AppEnv } from '../../src/core/types'
import { auditMiddleware } from '../../src/ops/audit'
import { safePath } from '../../src/ops/logger'
import { requestIdMiddleware, requestLogMiddleware } from '../../src/ops/request-id'
import { captureLogger, startServer } from './harness'
import type { Running } from './harness'

const Tokens = createTokenService('s'.repeat(40))
const Log = captureLogger()
let Srv: Running

beforeAll(async () => {
  const App = new Hono<AppEnv>()
  App.onError((Err, c) => renderJsonError(c, Err))
  App.use('*', requestIdMiddleware())
  App.use('*', requestLogMiddleware(Log.logger))
  App.use('*', auditMiddleware(Log.logger))
  const Gate = createDataPlaneGate({ tokens: Tokens, bucket: 'kbfile', trustedProxies: [], ipGateEnabled: true })
  App.get('/kbfile/*', Gate, (c) => {
    /* 模拟业务里误把整条 URL / 头 / token 塞进日志 */
    Log.logger.info({ url: c.req.url, headers: { authorization: c.req.header('authorization') }, access_token: c.req.query('access_token') }, 'handler')
    Log.logger.info({ location: c.req.url, nested: { token: 'nested-secret-token', secret: 'nested-secret' } }, 'presign')
    return c.text('hello')
  })
  Srv = await startServer(App)
})

afterAll(() => Srv.close())

describe('logger 脱敏', () => {
  it('presign 下载链路：日志不含 access_token 值 / X-Amz-Signature / Authorization / 完整 URL', async () => {
    const { token } = await Tokens.issueDataPlane({ sub: 'u1', key: 'a/b.txt', op: 'get', ip: '127.0.0.1', expiresIn: 60 })
    const Signature = 'deadbeefcafebabe1234567890abcdef'
    const Url = `${Srv.base}/kbfile/a/b.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=${Signature}&access_token=${token}`
    const Res = await fetch(Url, { headers: { authorization: 'Bearer super-secret-service-token' } })
    expect(Res.status).toBe(200)
    expect(await Res.text()).toBe('hello')
    await new Promise((Resolve) => setTimeout(Resolve, 50))
    const Raw = Log.raw()
    expect(Raw).not.toContain(token)
    expect(Raw).not.toContain(Signature)
    expect(Raw).not.toContain('X-Amz-Signature')
    expect(Raw).not.toContain('super-secret-service-token')
    expect(Raw).not.toContain('nested-secret')
    expect(Raw).not.toContain('?')
    expect(Raw).not.toContain(Srv.base)
    const Lines = Log.lines()
    const Handler = Lines.find((Line) => Line.msg === 'handler')
    expect(Handler).toMatchObject({ url: '/kbfile/a/b.txt', access_token: '[redacted]', headers: { authorization: '[redacted]' } })
    expect(Handler?.request_id).toEqual(expect.any(String))
    expect(Lines.find((Line) => Line.msg === 'presign')).toMatchObject({ location: '[redacted]' })
    expect(Lines.find((Line) => Line.event === 'request')).toMatchObject({ path: '/kbfile/a/b.txt', status: 200, identity: 'u1' })
    expect(Lines.find((Line) => Line.event === 'audit')).toMatchObject({ who: 'u1', key: 'a/b.txt', op: 'GET s3', status: 200 })
  })

  it('safePath 剥 query / fragment / origin', () => {
    expect(safePath('/a/b?access_token=x#f')).toBe('/a/b')
    expect(safePath('http://minio:9000/bucket/k?X-Amz-Signature=1')).toBe('/bucket/k')
    expect(safePath('/plain')).toBe('/plain')
  })
})
