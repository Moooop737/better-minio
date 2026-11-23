/**
 * 请求入口 middleware —— request_id 关联 + 基础请求日志（恒开，不受 AUDIT_ENABLED 影响）。
 *   requestIdMiddleware()：取 incoming `x-request-id`（关联标签，非安全凭据；仅 ≤128 位 [A-Za-z0-9._-] 透传，否则铸 uuid），
 *     `c.set('requestId')` + 回写响应头 + 下游跑在 ALS 里（pino mixin 自动带 request_id）。
 *   requestLogMiddleware(logger)：响应结束记 method / path（safePath，绝不含 query）/ status / duration_ms / identity（只 who）/ request_id。
 *   afterResponse(c, fn)：流式响应以 node outgoing 'close' 为准；无 node 绑定（app.request）则立即执行。
 * 装配：request_id 最外层 → 请求日志 → audit → 各面路由。
 */

export { requestIdMiddleware, requestLogMiddleware, afterResponse, whoOf, REQUEST_ID_HEADER }

import { randomUUID } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'
import type { AppEnv, Identity } from '../core/types'
import type { Logger } from './logger'
import { runWithRequestId, safePath } from './logger'

const REQUEST_ID_HEADER = 'x-request-id'
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,128}$/

function requestIdMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const Incoming = c.req.header(REQUEST_ID_HEADER)
    const RequestId = Incoming !== undefined && REQUEST_ID_RE.test(Incoming) ? Incoming : randomUUID()
    c.set('requestId', RequestId)
    await runWithRequestId(RequestId, () => next())
    setResponseHeader(c, REQUEST_ID_HEADER, RequestId)
  }
}

function requestLogMiddleware(Log: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const Started = performance.now()
    await next()
    afterResponse(c, () => {
      Log.info({
        event: 'request',
        method: c.req.method,
        path: safePath(c.req.path),
        status: c.res.status,
        duration_ms: Math.round(performance.now() - Started),
        identity: whoOf(c.get('identity') as Identity | undefined),
        request_id: (c.get('requestId') as string | undefined) ?? null,
      })
    })
  }
}

/* 响应真正写完（含流式 body）后执行；监听器跑在 http 上下文，request_id 需调用方显式带 */
function afterResponse(c: Context<AppEnv>, Fn: () => void): void {
  const Outgoing = c.env?.outgoing
  if (Outgoing === undefined || Outgoing.destroyed || Outgoing.writableFinished) {
    Fn()
    return
  }
  Outgoing.once('close', Fn)
}

/* 透传的上游 Response 头可能不可变 → 复制一份再写 */
function setResponseHeader(c: Context<AppEnv>, Name: string, Value: string): void {
  try {
    c.res.headers.set(Name, Value)
  } catch {
    c.res = new Response(c.res.body, c.res)
    c.res.headers.set(Name, Value)
  }
}

function whoOf(Who: Identity | undefined): string {
  if (Who === undefined) return 'anonymous'
  return Who.kind === 'service' ? Who.name : Who.sub
}
