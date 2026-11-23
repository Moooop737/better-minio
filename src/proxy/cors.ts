/**
 * 数据面 CORS —— 浏览器直传 / 预览是跨域 fetch；CORS_ORIGINS 白名单（空 = 不开，不出任何 CORS 头）。
 * OPTIONS 预检不过闸、恒 204；origin 命中才回显 Allow-Origin（不用 `*`），无 Allow-Credentials（凭证在 URL）。
 * 非预检响应（含错误响应）命中白名单时补 Allow-Origin + Expose-Headers，让 ETag / Content-Range 到达前端。
 * 必须挂在数据面链最前（闸与 405/404 预检查之前）。
 */

export { dataPlaneCors, CORS_ALLOW_METHODS, CORS_ALLOW_HEADERS, CORS_EXPOSE_HEADERS }

import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../core/types'

const CORS_ALLOW_METHODS = 'GET, PUT, HEAD, OPTIONS'
const CORS_ALLOW_HEADERS = ['content-type', 'range', 'if-none-match', 'x-amz-*']
const CORS_EXPOSE_HEADERS = 'ETag, Content-Length, Content-Range, Accept-Ranges, x-amz-request-id, x-amz-version-id, x-amz-*'
const CORS_MAX_AGE = '86400'

function dataPlaneCors(Origins: string[]): MiddlewareHandler<AppEnv> {
  const Allowed = new Set(Origins.map((Origin) => Origin.trim()).filter((Origin) => Origin !== ''))
  return async (c, next) => {
    const Origin = c.req.header('origin')
    const Hit = Origin !== undefined && Allowed.has(Origin)
    if (c.req.method === 'OPTIONS') {
      const Out = new Headers()
      if (Allowed.size > 0) Out.set('Vary', 'Origin')
      if (Hit) {
        Out.set('Access-Control-Allow-Origin', Origin)
        Out.set('Access-Control-Allow-Methods', CORS_ALLOW_METHODS)
        Out.set('Access-Control-Allow-Headers', allowHeaders(c.req.header('access-control-request-headers')))
        Out.set('Access-Control-Max-Age', CORS_MAX_AGE)
      }
      return new Response(null, { status: 204, headers: Out })
    }
    await next()
    if (Allowed.size === 0) return
    c.res.headers.append('Vary', 'Origin')
    if (Hit) {
      c.res.headers.set('Access-Control-Allow-Origin', Origin)
      c.res.headers.set('Access-Control-Expose-Headers', CORS_EXPOSE_HEADERS)
    }
  }
}

/* `x-amz-*` 通配不是 CORS 标准语法：把预检点名的 x-amz-* 具体头名一并回显 */
function allowHeaders(Requested: string | undefined): string {
  const Names = new Set(CORS_ALLOW_HEADERS)
  for (const Raw of (Requested ?? '').split(',')) {
    const Name = Raw.trim().toLowerCase()
    if (/^x-amz-[a-z0-9-]+$/.test(Name)) Names.add(Name)
  }
  return [...Names].join(', ')
}
