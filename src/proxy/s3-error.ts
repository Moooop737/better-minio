/**
 * S3 数据面错误渲染 —— S3 XML（SDK 才认），映射见 spec 表；控制面 JSON 归 core/render.ts。
 * `renderS3Error(c, err)`：GatewayError → 对应 HTTP + S3 Code；未知异常 → 500 InternalError 通用文案。
 * `s3ErrorResponse(c, status, code, message)`：非 GatewayError 的 S3 错误（405 / NoSuchBucket / NoSuchKey）。
 * RequestId = 网关 trace id（c.get('requestId')）；HEAD 不带 body。MinIO 上游错误 XML 由转发器原样透传，不经这里。
 */

export { renderS3Error, s3ErrorResponse, S3_ERROR_MAP }

import type { Context } from 'hono'
import { GatewayError } from '../core/errors'
import type { GatewayErrorCode } from '../core/errors'

const S3_ERROR_MAP: Record<GatewayErrorCode, { status: number; code: string }> = {
  E_TOKEN_MISSING: { status: 401, code: 'InvalidRequest' },
  E_TOKEN_INVALID: { status: 401, code: 'InvalidRequest' },
  E_SERVICE_TOKEN: { status: 401, code: 'InvalidRequest' },
  E_OP_MISMATCH: { status: 403, code: 'AccessDenied' },
  E_PATH_MISMATCH: { status: 403, code: 'AccessDenied' },
  E_IP_MISMATCH: { status: 403, code: 'AccessDenied' },
  E_SCOPE: { status: 403, code: 'AccessDenied' },
  E_VALIDATION: { status: 400, code: 'InvalidArgument' },
  E_PART_SIZE_MISMATCH: { status: 400, code: 'InvalidArgument' },
  E_NOT_FOUND: { status: 404, code: 'NoSuchKey' },
  E_SESSION_NOT_FOUND: { status: 404, code: 'NoSuchKey' },
  E_RATE_LIMIT: { status: 429, code: 'SlowDown' },
  E_UPSTREAM: { status: 502, code: 'ServiceUnavailable' },
  E_INTERNAL: { status: 500, code: 'InternalError' },
}

const INTERNAL_MESSAGE = 'We encountered an internal error. Please try again.'

function renderS3Error(c: Context, Err: unknown): Response {
  if (!(Err instanceof GatewayError)) return s3ErrorResponse(c, 500, 'InternalError', INTERNAL_MESSAGE)
  const Mapped = S3_ERROR_MAP[Err.code]
  if (Err.code === 'E_RATE_LIMIT' && typeof Err.extra?.retryAfter === 'number') {
    c.header('Retry-After', String(Err.extra.retryAfter))
  }
  const Message = Err.code === 'E_INTERNAL' ? INTERNAL_MESSAGE : Err.message
  return s3ErrorResponse(c, Mapped.status, Mapped.code, Message)
}

function s3ErrorResponse(c: Context, Status: number, Code: string, Message: string): Response {
  const RequestId = (c.get('requestId') as string | undefined) ?? ''
  if (RequestId !== '') c.header('x-amz-request-id', RequestId)
  if (c.req.method === 'HEAD') return c.body(null, Status as 401)
  const Xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<Error><Code>${escapeXml(Code)}</Code><Message>${escapeXml(Message)}</Message><RequestId>${escapeXml(RequestId)}</RequestId></Error>`
  c.header('Content-Type', 'application/xml')
  return c.body(Xml, Status as 401)
}

function escapeXml(Value: string): string {
  return Value.replace(/[<>&'"]/g, (Char) =>
    Char === '<' ? '&lt;' : Char === '>' ? '&gt;' : Char === '&' ? '&amp;' : Char === "'" ? '&apos;' : '&quot;',
  )
}
