import { afterAll, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { Redis } from 'ioredis'
import { createServer } from 'node:net'
import type { Context } from 'hono'
import { renderJsonError } from '../../src/core/render'
import type { AppEnv, Identity, RateLimit } from '../../src/core/types'
import { createRateLimits } from '../../src/ops/rate-limit'

/* 极简控制面：x-who 头模拟闸已认出的身份，随后调用限流 */
function controlApp(Limit: RateLimit): Hono<AppEnv> {
  const App = new Hono<AppEnv>()
  App.onError((Err, c) => renderJsonError(c, Err))
  App.post('/presign/put', async (c: Context<AppEnv>) => {
    const Who: Identity = { kind: 'service', name: c.req.header('x-who') ?? 'backend' }
    c.set('identity', Who)
    await Limit(c)
    return c.json({ ok: true })
  })
  return App
}

const hit = (App: Hono<AppEnv>, Who = 'backend') => App.request('/presign/put', { method: 'POST', headers: { 'x-who': Who } })

const Clients: Redis[] = []
afterAll(() => {
  for (const Client of Clients) Client.disconnect()
})

describe('rate limit', () => {
  it('控制面超额 → 429 JSON E_RATE_LIMIT + Retry-After；按身份隔离', async () => {
    const Limits = createRateLimits({ enabled: true, control: 3, data: 300, oci: 120, redis: null })
    const App = controlApp(Limits.control!)
    for (let Index = 0; Index < 3; Index++) expect((await hit(App)).status).toBe(200)
    const Res = await hit(App)
    expect(Res.status).toBe(429)
    expect(await Res.json()).toMatchObject({ code: 'E_RATE_LIMIT' })
    const RetryAfter = Number(Res.headers.get('retry-after'))
    expect(RetryAfter).toBeGreaterThanOrEqual(1)
    expect(RetryAfter).toBeLessThanOrEqual(60)
    expect((await hit(App, 'd1')).status).toBe(200)
  })

  it('各面配额与计数独立', async () => {
    const Limits = createRateLimits({ enabled: true, control: 1, data: 2, oci: 1, redis: null })
    const Control = controlApp(Limits.control!)
    const Data = controlApp(Limits.data!)
    expect((await hit(Control)).status).toBe(200)
    expect((await hit(Control)).status).toBe(429)
    expect((await hit(Data)).status).toBe(200)
    expect((await hit(Data)).status).toBe(200)
    expect((await hit(Data)).status).toBe(429)
  })

  it('enabled=false → 三面全 null', () => {
    expect(createRateLimits({ enabled: false, control: 1, data: 1, oci: 1, redis: null })).toEqual({ control: null, data: null, oci: null })
  })

  it('Redis 断连 → insurance 内存降级仍限流，不 500（无 Redis 服务器：指向已关闭端口）', async () => {
    const Port = await closedPort()
    const Client = new Redis({ host: '127.0.0.1', port: Port, lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0 })
    Client.on('error', () => {})
    Clients.push(Client)
    const Limits = createRateLimits({ enabled: true, control: 2, data: 300, oci: 120, redis: Client })
    const App = controlApp(Limits.control!)
    expect((await hit(App)).status).toBe(200)
    expect((await hit(App)).status).toBe(200)
    const Res = await hit(App)
    expect(Res.status).toBe(429)
    expect(Res.headers.get('retry-after')).not.toBeNull()
  })
})

async function closedPort(): Promise<number> {
  return new Promise((Resolve) => {
    const Server = createServer()
    Server.listen(0, '127.0.0.1', () => {
      const Address = Server.address()
      Server.close(() => Resolve(typeof Address === 'object' && Address !== null ? Address.port : 1))
    })
  })
}
