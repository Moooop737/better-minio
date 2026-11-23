/**
 * ops 测试夹具 —— 捕获 pino 输出（destination stream）+ 起真实 node server（需要 c.env.incoming/outgoing）。
 */

export { captureLogger, startServer }
export type { Captured, Running }

import { serve } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'
import type { Hono } from 'hono'
import type { AddressInfo } from 'node:net'
import { createLogger } from '../../src/ops/logger'
import type { Logger } from '../../src/ops/logger'
import type { AppEnv } from '../../src/core/types'

interface Captured {
  logger: Logger
  raw(): string
  lines(): Record<string, unknown>[]
}

interface Running {
  server: ServerType
  base: string
  close(): Promise<void>
}

function captureLogger(Level = 'debug'): Captured {
  const Chunks: string[] = []
  const Logger = createLogger(Level, { write: (Chunk: string) => void Chunks.push(Chunk) })
  return {
    logger: Logger,
    raw: () => Chunks.join(''),
    lines: () =>
      Chunks.join('')
        .split('\n')
        .filter((Line) => Line.trim() !== '')
        .map((Line) => JSON.parse(Line) as Record<string, unknown>),
  }
}

async function startServer(App: Hono<AppEnv>): Promise<Running> {
  let Server!: ServerType
  await new Promise<void>((Resolve) => {
    Server = serve({ fetch: App.fetch, port: 0, hostname: '127.0.0.1' }, () => Resolve())
  })
  return {
    server: Server,
    base: `http://127.0.0.1:${(Server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((Resolve) => {
        ;(Server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
        Server.close(() => Resolve())
      }),
  }
}
