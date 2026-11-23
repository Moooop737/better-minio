/**
 * 结构化日志（pino）+ request_id 上下文（AsyncLocalStorage）。
 * 红线：URL 一律不整条进日志（query 含 access_token / X-Amz 签名）；redact 剥 authorization / token / secret。
 * serializer：顶层 `url` / `path` 只留 pathname；`location`（presign 回的整条 URL）一律 [redacted]。
 * 用法：`logger.info({...}, 'msg')`；请求内日志自动带 request_id（mixin）。
 */

export { logger, createLogger, runWithRequestId, currentRequestId, safePath }
export type { Logger }

import { AsyncLocalStorage } from 'node:async_hooks'
import { pino } from 'pino'
import type { Logger, DestinationStream } from 'pino'

const Storage = new AsyncLocalStorage<{ requestId: string }>()

const REDACT_PATHS = [
  'req.headers.authorization',
  'headers.authorization',
  'authorization',
  'access_token',
  'token',
  '*.access_token',
  '*.token',
  '*.authorization',
  'secret',
  '*.secret',
  'tokenSecret',
  '*.tokenSecret',
  's3SecretAccessKey',
  '*.s3SecretAccessKey',
  'cookie',
  '*.cookie',
  'req.headers.cookie',
  'Authorization',
  '*.Authorization',
]

function createLogger(Level = process.env.LOG_LEVEL?.trim() || 'info', Destination?: DestinationStream): Logger {
  const Options = {
    level: Level,
    base: { service: 'better-minio' },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    serializers: {
      url: (Value: unknown) => (typeof Value === 'string' ? safePath(Value) : '[redacted]'),
      path: (Value: unknown) => (typeof Value === 'string' ? safePath(Value) : Value),
      location: () => '[redacted]',
    },
    mixin() {
      const Store = Storage.getStore()
      return Store === undefined ? {} : { request_id: Store.requestId }
    },
  }
  return Destination === undefined ? pino(Options) : pino(Options, Destination)
}

/* 进程级单例；index 按 config 调整 level */
const logger: Logger = createLogger()

function runWithRequestId<T>(RequestId: string, Fn: () => T): T {
  return Storage.run({ requestId: RequestId }, Fn)
}

function currentRequestId(): string | null {
  return Storage.getStore()?.requestId ?? null
}

/* 只取 pathname，剥 query 与 fragment；任何 URL 进日志前走这里 */
function safePath(RawUrl: string): string {
  const Index = RawUrl.search(/[?#]/)
  const Path = Index === -1 ? RawUrl : RawUrl.slice(0, Index)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(Path)) {
    try {
      return new URL(Path).pathname
    } catch {
      return '/'
    }
  }
  return Path
}
