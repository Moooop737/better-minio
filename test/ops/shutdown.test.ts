import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '../../src/core/types'
import { createShutdown } from '../../src/ops/shutdown'
import { captureLogger, startServer } from './harness'

function slowApp(DelayMs: number): Hono<AppEnv> {
  const App = new Hono<AppEnv>()
  App.get('/slow', async (c) => {
    await new Promise((Resolve) => setTimeout(Resolve, DelayMs))
    return c.text('done')
  })
  App.get('/fast', (c) => c.text('fast'))
  return App
}

describe('shutdown', () => {
  it('在途慢请求完成 → 新连接拒收 → 钩子按序 → exit(0)', async () => {
    const Srv = await startServer(slowApp(400))
    const Log = captureLogger()
    const Exits: number[] = []
    const Order: string[] = []
    const Shutdown = createShutdown({ server: Srv.server, timeoutMs: 5000, logger: Log.logger, exit: (Code) => void Exits.push(Code) })
    Shutdown.register('timers', () => void Order.push('timers'))
    Shutdown.register('broken', () => {
      throw new Error('boom')
    })
    Shutdown.register('redis', async () => void Order.push('redis'))

    /* 先建一条 keep-alive 空闲连接，确认它不会拖住关闭 */
    expect(await (await fetch(`${Srv.base}/fast`)).text()).toBe('fast')
    const InFlight = fetch(`${Srv.base}/slow`)
    await new Promise((Resolve) => setTimeout(Resolve, 50))
    const Running = Shutdown.run()
    expect(Shutdown.run()).toBe(Running)
    await new Promise((Resolve) => setTimeout(Resolve, 50))
    await expect(fetch(`${Srv.base}/fast`, { headers: { connection: 'close' } })).rejects.toThrow()

    const Res = await InFlight
    expect(Res.status).toBe(200)
    expect(await Res.text()).toBe('done')
    await Running
    expect(Exits).toEqual([0])
    expect(Order).toEqual(['timers', 'redis'])
    expect(Log.lines().some((Line) => Line.hook === 'broken')).toBe(true)
  })

  it('超 timeout → exit(1)', async () => {
    const Srv = await startServer(slowApp(5000))
    const Log = captureLogger()
    const Exits: number[] = []
    const Shutdown = createShutdown({ server: Srv.server, timeoutMs: 200, logger: Log.logger, exit: (Code) => void Exits.push(Code) })
    const Hung = fetch(`${Srv.base}/slow`).catch(() => null)
    await new Promise((Resolve) => setTimeout(Resolve, 50))
    const Started = Date.now()
    await Shutdown.run()
    expect(Exits).toEqual([1])
    expect(Date.now() - Started).toBeLessThan(2000)
    await Hung
  })
})
