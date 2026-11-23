/**
 * S3 XML 错误渲染 —— 映射表（design §五 + spec 补全）、429 Retry-After、未知异常通用 500、RequestId、HEAD 无 body。
 */

import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { GatewayError } from '../../src/core/errors'
import type { GatewayErrorCode } from '../../src/core/errors'
import type { AppEnv } from '../../src/core/types'
import { renderS3Error, s3ErrorResponse } from '../../src/proxy/s3-error'

function appThrowing(Err: unknown, RequestId?: string): Hono<AppEnv> {
  const App = new Hono<AppEnv>()
  App.onError((E, c) => renderS3Error(c, E))
  App.all('*', (c) => {
    if (RequestId !== undefined) c.set('requestId', RequestId)
    throw Err
  })
  return App
}

describe('renderS3Error', () => {
  const Cases: [GatewayErrorCode, number, string][] = [
    ['E_TOKEN_MISSING', 401, 'InvalidRequest'],
    ['E_TOKEN_INVALID', 401, 'InvalidRequest'],
    ['E_OP_MISMATCH', 403, 'AccessDenied'],
    ['E_PATH_MISMATCH', 403, 'AccessDenied'],
    ['E_IP_MISMATCH', 403, 'AccessDenied'],
    ['E_VALIDATION', 400, 'InvalidArgument'],
    ['E_NOT_FOUND', 404, 'NoSuchKey'],
    ['E_UPSTREAM', 502, 'ServiceUnavailable'],
    ['E_INTERNAL', 500, 'InternalError'],
  ]
  it.each(Cases)('%s → %i %s', async (Code, Status, S3Code) => {
    const Res = await appThrowing(new GatewayError(Code, '通用文案'), 'rid-1').request('/kbfile/k')
    expect(Res.status).toBe(Status)
    expect(Res.headers.get('content-type')).toContain('application/xml')
    expect(Res.headers.get('x-amz-request-id')).toBe('rid-1')
    const Body = await Res.text()
    expect(Body).toContain(`<Code>${S3Code}</Code>`)
    expect(Body).toContain('<RequestId>rid-1</RequestId>')
  })

  it('E_RATE_LIMIT → 429 SlowDown + Retry-After', async () => {
    const Res = await appThrowing(new GatewayError('E_RATE_LIMIT', '请求过于频繁', { retryAfter: 12 })).request('/kbfile/k')
    expect(Res.status).toBe(429)
    expect(Res.headers.get('retry-after')).toBe('12')
    expect(await Res.text()).toContain('<Code>SlowDown</Code>')
  })

  it('未知异常 → 500 InternalError，message 通用（不泄内部错误文本）', async () => {
    const Res = await appThrowing(new Error('connect ECONNREFUSED 10.0.0.5:9000')).request('/kbfile/k')
    expect(Res.status).toBe(500)
    const Body = await Res.text()
    expect(Body).toContain('<Code>InternalError</Code>')
    expect(Body).not.toContain('10.0.0.5')
    expect(Body).toContain('<RequestId></RequestId>')
  })

  it('E_INTERNAL 也不透出其 message', async () => {
    const Body = await (await appThrowing(new GatewayError('E_INTERNAL', 'secret detail')).request('/kbfile/k')).text()
    expect(Body).not.toContain('secret detail')
  })

  it('HEAD：只回状态与头，无 body', async () => {
    const Res = await appThrowing(new GatewayError('E_IP_MISMATCH', 'x')).request('/kbfile/k', { method: 'HEAD' })
    expect(Res.status).toBe(403)
    expect(await Res.text()).toBe('')
  })

  it('s3ErrorResponse 对 message 做 XML 转义', async () => {
    const App = new Hono<AppEnv>()
    App.get('*', (c) => s3ErrorResponse(c, 400, 'InvalidArgument', `a<b>&"c'`))
    const Body = await (await App.request('/x')).text()
    expect(Body).toContain('<Message>a&lt;b&gt;&amp;&quot;c&apos;</Message>')
  })
})
