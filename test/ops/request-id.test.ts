import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '../../src/core/types'
import { currentRequestId } from '../../src/ops/logger'
import { requestIdMiddleware, requestLogMiddleware } from '../../src/ops/request-id'
import { captureLogger } from './harness'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function build() {
  const Log = captureLogger()
  const App = new Hono<AppEnv>()
  App.use('*', requestIdMiddleware())
  App.use('*', requestLogMiddleware(Log.logger))
  App.get('/x', (c) => {
    Log.logger.info('inside')
    return c.json({ fromContext: c.get('requestId'), fromAls: currentRequestId() })
  })
  /* 上游透传 Response 头不可变 → 仍能回写 x-request-id */
  App.get('/frozen', async () => {
    const Upstream = await fetch('data:text/plain,hi')
    return Upstream
  })
  return { App, Log }
}

describe('request id', () => {
  it('合法 incoming x-request-id 透传：响应头 / ALS / 日志 mixin', async () => {
    const { App, Log } = build()
    const Res = await App.request('/x', { headers: { 'x-request-id': 'abc-123.DEF_4' } })
    expect(Res.headers.get('x-request-id')).toBe('abc-123.DEF_4')
    expect(await Res.json()).toEqual({ fromContext: 'abc-123.DEF_4', fromAls: 'abc-123.DEF_4' })
    const Lines = Log.lines()
    expect(Lines.find((Line) => Line.msg === 'inside')?.request_id).toBe('abc-123.DEF_4')
    expect(Lines.find((Line) => Line.event === 'request')).toMatchObject({ request_id: 'abc-123.DEF_4', method: 'GET', path: '/x', status: 200, identity: 'anonymous' })
  })

  it('缺失或非法（超长 / 非法字符）→ 铸 uuid', async () => {
    const { App } = build()
    for (const Headers of [{}, { 'x-request-id': 'a'.repeat(129) }, { 'x-request-id': 'bad id\n' }, { 'x-request-id': 'x/y' }]) {
      const Res = await App.request('/x', { headers: Headers })
      expect(Res.headers.get('x-request-id')).toMatch(UUID_RE)
    }
  })

  it('不可变响应头也能回写', async () => {
    const { App } = build()
    const Res = await App.request('/frozen', { headers: { 'x-request-id': 'r1' } })
    expect(Res.headers.get('x-request-id')).toBe('r1')
    expect(await Res.text()).toBe('hi')
  })
})
