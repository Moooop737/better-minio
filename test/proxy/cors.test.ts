/**
 * 数据面 CORS 中间件 —— 白名单回显 / 非白名单无头 / 空白名单零 CORS 头 / 预检不进下游 / 实际响应 expose。
 */

import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { GatewayError } from '../../src/core/errors'
import type { AppEnv } from '../../src/core/types'
import { CORS_EXPOSE_HEADERS, dataPlaneCors } from '../../src/proxy/cors'
import { renderS3Error } from '../../src/proxy/s3-error'

function app(Origins: string[]): { App: Hono<AppEnv>; hits: () => number } {
  let Hits = 0
  const App = new Hono<AppEnv>()
  App.onError((E, c) => renderS3Error(c, E))
  App.all('/kbfile/*', dataPlaneCors(Origins), (c) => {
    Hits++
    if (c.req.query('deny') !== undefined) throw new GatewayError('E_TOKEN_MISSING', '缺少 access_token')
    return c.text('ok', 200, { etag: '"e"' })
  })
  return { App, hits: () => Hits }
}

describe('dataPlaneCors', () => {
  it('预检：白名单 origin 回显、方法/头/max-age 齐全，不进入下游（不过闸）', async () => {
    const { App, hits } = app(['https://a.example', 'https://b.example'])
    const Res = await App.request('/kbfile/k', {
      method: 'OPTIONS',
      headers: { origin: 'https://b.example', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'Content-Type, X-Amz-Meta-Name, x-evil' },
    })
    expect(Res.status).toBe(204)
    expect(Res.headers.get('access-control-allow-origin')).toBe('https://b.example')
    expect(Res.headers.get('access-control-allow-methods')).toBe('GET, PUT, HEAD, OPTIONS')
    const Allow = Res.headers.get('access-control-allow-headers') ?? ''
    expect(Allow).toContain('content-type')
    expect(Allow).toContain('range')
    expect(Allow).toContain('if-none-match')
    expect(Allow).toContain('x-amz-meta-name')
    expect(Allow).not.toContain('x-evil')
    expect(Res.headers.get('access-control-max-age')).toBe('86400')
    expect(Res.headers.get('access-control-allow-credentials')).toBeNull()
    expect(Res.headers.get('vary')).toBe('Origin')
    expect(hits()).toBe(0)
  })

  it('预检：非白名单 origin → 204 无 CORS 头', async () => {
    const Res = await app(['https://a.example']).App.request('/kbfile/k', { method: 'OPTIONS', headers: { origin: 'https://x.example' } })
    expect(Res.status).toBe(204)
    expect(Res.headers.get('access-control-allow-origin')).toBeNull()
    expect(Res.headers.get('access-control-allow-methods')).toBeNull()
  })

  it('实际响应：白名单回显 + Expose（含 ETag / Content-Range）；错误响应同样带', async () => {
    const { App } = app(['https://a.example'])
    const Ok = await App.request('/kbfile/k', { headers: { origin: 'https://a.example' } })
    expect(Ok.headers.get('access-control-allow-origin')).toBe('https://a.example')
    expect(Ok.headers.get('access-control-expose-headers')).toBe(CORS_EXPOSE_HEADERS)
    expect(CORS_EXPOSE_HEADERS).toContain('ETag')
    expect(CORS_EXPOSE_HEADERS).toContain('Content-Range')
    expect(Ok.headers.get('vary')).toContain('Origin')
    const Denied = await App.request('/kbfile/k?deny=1', { headers: { origin: 'https://a.example' } })
    expect(Denied.status).toBe(401)
    expect(Denied.headers.get('access-control-allow-origin')).toBe('https://a.example')
  })

  it('白名单为空：不出任何 CORS 头（也不加 Vary）', async () => {
    const { App } = app([])
    for (const Method of ['OPTIONS', 'GET']) {
      const Res = await App.request('/kbfile/k', { method: Method, headers: { origin: 'https://a.example' } })
      expect([...Res.headers.keys()].filter((Name) => Name.startsWith('access-control-') || Name === 'vary')).toEqual([])
    }
  })
})
