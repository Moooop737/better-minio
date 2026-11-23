/**
 * 控制面错误渲染 —— JSON `{code, message, ...extra}`；未知异常一律 500 E_INTERNAL 通用文案（不泄内部细节）。
 * S3 数据面（proxy/s3-error.ts）与 OCI（oci/errors.ts）各有自己的渲染；index 的 onError 按路径分派。
 */

export { renderJsonError, toGatewayError }

import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { GatewayError } from './errors'

function toGatewayError(Err: unknown): GatewayError {
  return Err instanceof GatewayError ? Err : new GatewayError('E_INTERNAL', '内部错误')
}

function renderJsonError(c: Context, Err: unknown): Response {
  const Gateway = toGatewayError(Err)
  if (Gateway.code === 'E_RATE_LIMIT' && typeof Gateway.extra?.retryAfter === 'number') {
    c.header('Retry-After', String(Gateway.extra.retryAfter))
  }
  const Extra = { ...(Gateway.extra ?? {}) }
  delete Extra.retryAfter
  delete Extra.challenge
  return c.json({ code: Gateway.code, message: Gateway.message, ...Extra }, Gateway.httpStatus as ContentfulStatusCode)
}
