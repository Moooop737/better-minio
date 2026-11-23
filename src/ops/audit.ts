/**
 * 审计 middleware —— 每请求一条 `event:'audit'` 结构化日志行（sink = stdout，docker logs 收；查询/聚合是触发点）。
 * 字段：request_id / who / op（METHOD + 路由类）/ key（auditKey，内部可见、对外不泄）/ ip / status / duration_ms / bytes_up / bytes_down。
 * 时机：响应真正写完（流式等 outgoing 'close'）；闸拒绝经 onError 渲染后同样回到这里 → 401/403 也留痕（who 缺失记 anonymous）。
 * 豁免 /health 与 OPTIONS。AUDIT_ENABLED=false 时 index 不装。
 * 用法：`app.use('*', auditMiddleware(logger, { trustedProxies }))`（装在 request_id 之内、各面路由之外）。
 */

export { auditMiddleware, routeClass }
export type { AuditOptions, RouteClass }

import type { MiddlewareHandler } from 'hono'
import type { Cidr } from '../config'
import type { AppEnv, Identity } from '../core/types'
import { resolveClientIp } from '../auth/client-ip'
import type { Logger } from './logger'
import { afterResponse, whoOf } from './request-id'

type RouteClass = 's3' | 'presign' | 'objects' | 'multipart' | 'oci' | 'token' | 'thumbnail'

interface AuditOptions {
  trustedProxies?: Cidr[]
}

const PREFIX_CLASSES: [string, RouteClass][] = [
  ['/presign', 'presign'],
  ['/objects', 'objects'],
  ['/multipart', 'multipart'],
  ['/v2', 'oci'],
  ['/token', 'token'],
  ['/thumbnail', 'thumbnail'],
]

function auditMiddleware(Log: Logger, Options: AuditOptions = {}): MiddlewareHandler<AppEnv> {
  const Trusted = Options.trustedProxies ?? []
  return async (c, next) => {
    if (c.req.method === 'OPTIONS' || c.req.path === '/health') {
      await next()
      return
    }
    const Started = performance.now()
    await next()
    afterResponse(c, () => {
      const Who = c.get('identity') as Identity | undefined
      const Ip =
        Who?.kind === 'browser' && Who.ip !== 'unknown'
          ? Who.ip
          : resolveClientIp(c.env?.incoming?.socket?.remoteAddress, c.req.header('x-forwarded-for'), Trusted)
      Log.info({
        event: 'audit',
        request_id: (c.get('requestId') as string | undefined) ?? null,
        who: whoOf(Who),
        op: `${c.req.method} ${routeClass(c.req.path)}`,
        key: (c.get('auditKey') as string | undefined) ?? null,
        ip: Ip,
        status: c.res.status,
        duration_ms: Math.round(performance.now() - Started),
        bytes_up: (c.get('bytesUp') as number | undefined) ?? 0,
        bytes_down: (c.get('bytesDown') as number | undefined) ?? 0,
      })
    })
  }
}

/* 路径前缀 → 路由类；控制面前缀精确到段边界，其余一律视作 S3 数据面 */
function routeClass(Path: string): RouteClass {
  for (const [Prefix, Class] of PREFIX_CLASSES) {
    if (Path === Prefix || Path.startsWith(`${Prefix}/`)) return Class
  }
  return 's3'
}
