/**
 * 优雅关闭编排 —— SIGTERM/SIGINT：停接新连接 → drain 在途（含流式；不主动 abort 在途分片，会话活在状态存储里可续）
 * → 按注册顺序跑钩子（multipart/oci 清理定时器、thumbnail worker、Redis）→ flush pino → exit 0；超 timeoutMs 强制 exit 1。
 * compose 配套 `stop_grace_period` 需大于 SHUTDOWN_TIMEOUT（默认 30s → 35s）。
 * 用法：`const Shutdown = createShutdown({ server, timeoutMs, logger })`；`Shutdown.register('redis', () => store.close())`；`Shutdown.install()`。
 */

export { createShutdown, IDLE_SWEEP_MS }
export type { Shutdown, ShutdownOptions }

import type { ServerType } from '@hono/node-server'
import type { Logger } from './logger'

/* close() 之后 keep-alive 连接在在途请求结束时才变空闲，周期性再关一遍 */
const IDLE_SWEEP_MS = 250

interface ShutdownOptions {
  server: ServerType
  timeoutMs: number
  logger: Logger
  exit?: (Code: number) => void
}

interface Shutdown {
  register(Name: string, Fn: () => Promise<void> | void): void
  install(): void
  run(): Promise<void>
}

interface ConnectionControl {
  closeIdleConnections?: () => void
  closeAllConnections?: () => void
}

function createShutdown(Options: ShutdownOptions): Shutdown {
  const Hooks: { name: string; fn: () => Promise<void> | void }[] = []
  const Exit = Options.exit ?? ((Code: number) => process.exit(Code))
  const Log = Options.logger
  let Running: Promise<void> | null = null

  async function orchestrate(): Promise<void> {
    Log.info({ event: 'shutdown', timeout_ms: Options.timeoutMs }, '开始优雅关闭')
    const Server = Options.server
    const Control = Server as unknown as ConnectionControl
    let Done = false
    let Timer: NodeJS.Timeout | undefined
    let Sweep: NodeJS.Timeout | undefined

    const TimedOut = new Promise<'timeout'>((Resolve) => {
      Timer = setTimeout(() => Resolve('timeout'), Options.timeoutMs)
    })
    const Closed = new Promise<'closed'>((Resolve) => {
      Server.close(() => Resolve('closed'))
      Control.closeIdleConnections?.()
      Sweep = setInterval(() => Control.closeIdleConnections?.(), IDLE_SWEEP_MS)
    })
    const Drained = Closed.then(async () => {
      clearInterval(Sweep)
      for (const Hook of Hooks) {
        if (Done) return 'closed' as const
        try {
          await Hook.fn()
        } catch (err) {
          Log.error({ event: 'shutdown', hook: Hook.name, err: String(err) }, '关闭钩子失败')
        }
      }
      return 'closed' as const
    })

    const Outcome = await Promise.race([Drained, TimedOut])
    Done = true
    clearTimeout(Timer)
    clearInterval(Sweep)
    if (Outcome === 'timeout') {
      Log.error({ event: 'shutdown', timeout_ms: Options.timeoutMs }, '优雅关闭超时，强制退出')
      Control.closeAllConnections?.()
      await flush(Log)
      Exit(1)
      return
    }
    Log.info({ event: 'shutdown' }, '优雅关闭完成')
    await flush(Log)
    Exit(0)
  }

  function run(): Promise<void> {
    Running ??= orchestrate()
    return Running
  }

  return {
    register(Name, Fn) {
      Hooks.push({ name: Name, fn: Fn })
    },
    install() {
      const Handler = (Signal: NodeJS.Signals): void => {
        Log.info({ event: 'shutdown', signal: Signal }, '收到退出信号')
        void run()
      }
      process.once('SIGTERM', Handler)
      process.once('SIGINT', Handler)
    },
    run,
  }
}

function flush(Log: Logger): Promise<void> {
  return new Promise((Resolve) => {
    try {
      Log.flush(() => Resolve())
    } catch {
      Resolve()
    }
  })
}
