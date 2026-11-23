/**
 * distribution 错误渲染 —— `/v2*` 的 onError 用 renderDistributionError(c, err)，体统一 `{"errors":[{code,message,detail?}]}`。
 *   OciError：oci 模块自有错误（code 取自 distribution spec，HTTP 状态按 design §五，可逐个覆盖如 405/416）。
 *   GatewayError：auth / 限流等跨模块错误映射成 distribution code；401/403 带 extra.challenge → WWW-Authenticate。
 *   ObjectStoreError（MinIO 失败）→ 502 UNKNOWN；其他未知异常 → 500 UNKNOWN。message 一律通用文案，不泄地址 / bucket / key。
 * 每个响应都带 `Docker-Distribution-API-Version: registry/2.0`。
 */

export { OciError, renderDistributionError, ociError, OCI_ERROR_STATUS, API_VERSION_HEADER, API_VERSION }
export type { OciErrorCode, DistributionErrorBody }

import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { ObjectStoreError } from '../api/object-store'
import { GatewayError } from '../core/errors'
import type { GatewayErrorCode } from '../core/errors'
import { logger } from '../ops/logger'

type OciErrorCode =
  | 'NAME_UNKNOWN'
  | 'NAME_INVALID'
  | 'MANIFEST_UNKNOWN'
  | 'MANIFEST_INVALID'
  | 'MANIFEST_BLOB_UNKNOWN'
  | 'BLOB_UNKNOWN'
  | 'BLOB_UPLOAD_UNKNOWN'
  | 'BLOB_UPLOAD_INVALID'
  | 'DIGEST_INVALID'
  | 'TAG_INVALID'
  | 'SIZE_INVALID'
  | 'RANGE_INVALID'
  | 'UNSUPPORTED'
  | 'UNAUTHORIZED'
  | 'DENIED'
  | 'TOOMANYREQUESTS'
  | 'UNKNOWN'

interface DistributionErrorBody {
  errors: { code: string; message: string; detail?: unknown }[]
}

const API_VERSION_HEADER = 'Docker-Distribution-API-Version'
const API_VERSION = 'registry/2.0'

const OCI_ERROR_STATUS: Record<OciErrorCode, number> = {
  NAME_UNKNOWN: 404,
  NAME_INVALID: 400,
  MANIFEST_UNKNOWN: 404,
  MANIFEST_INVALID: 400,
  MANIFEST_BLOB_UNKNOWN: 400,
  BLOB_UNKNOWN: 404,
  BLOB_UPLOAD_UNKNOWN: 404,
  BLOB_UPLOAD_INVALID: 400,
  DIGEST_INVALID: 400,
  TAG_INVALID: 409,
  SIZE_INVALID: 400,
  RANGE_INVALID: 416,
  UNSUPPORTED: 415,
  UNAUTHORIZED: 401,
  DENIED: 403,
  TOOMANYREQUESTS: 429,
  UNKNOWN: 502,
}

/* GatewayError → distribution code（HTTP 状态沿用 GatewayError.httpStatus） */
const GATEWAY_TO_OCI: Record<GatewayErrorCode, OciErrorCode> = {
  E_TOKEN_MISSING: 'UNAUTHORIZED',
  E_TOKEN_INVALID: 'UNAUTHORIZED',
  E_SERVICE_TOKEN: 'UNAUTHORIZED',
  E_OP_MISMATCH: 'DENIED',
  E_PATH_MISMATCH: 'DENIED',
  E_IP_MISMATCH: 'DENIED',
  E_SCOPE: 'DENIED',
  E_VALIDATION: 'UNSUPPORTED',
  E_NOT_FOUND: 'NAME_UNKNOWN',
  E_SESSION_NOT_FOUND: 'BLOB_UPLOAD_UNKNOWN',
  E_PART_SIZE_MISMATCH: 'SIZE_INVALID',
  E_RATE_LIMIT: 'TOOMANYREQUESTS',
  E_UPSTREAM: 'UNKNOWN',
  E_INTERNAL: 'UNKNOWN',
}

class OciError extends Error {
  readonly code: OciErrorCode
  readonly httpStatus: number
  /* 对外安全的附加信息（进 errors[].detail） */
  readonly detail: unknown
  /* 额外响应头（如 416 时回当前 Range） */
  readonly headers: Record<string, string>

  constructor(Code: OciErrorCode, Message: string, Options?: { status?: number; detail?: unknown; headers?: Record<string, string> }) {
    super(Message)
    this.name = 'OciError'
    this.code = Code
    this.httpStatus = Options?.status ?? OCI_ERROR_STATUS[Code]
    this.detail = Options?.detail
    this.headers = Options?.headers ?? {}
  }
}

function ociError(Code: OciErrorCode, Message: string, Options?: { status?: number; detail?: unknown; headers?: Record<string, string> }): OciError {
  return new OciError(Code, Message, Options)
}

function renderDistributionError(c: Context, Err: unknown): Response {
  c.header(API_VERSION_HEADER, API_VERSION)
  const { status, code, message, detail } = classify(c, Err)
  const Entry: DistributionErrorBody['errors'][number] = { code, message }
  if (detail !== undefined) Entry.detail = detail
  const Body: DistributionErrorBody = { errors: [Entry] }
  return c.json(Body, status as ContentfulStatusCode)
}

function classify(c: Context, Err: unknown): { status: number; code: string; message: string; detail?: unknown } {
  if (Err instanceof OciError) {
    for (const [Name, Value] of Object.entries(Err.headers)) c.header(Name, Value)
    return { status: Err.httpStatus, code: Err.code, message: Err.message, detail: Err.detail }
  }
  if (Err instanceof GatewayError) {
    const Code = GATEWAY_TO_OCI[Err.code]
    const Challenge = Err.extra?.challenge
    if (typeof Challenge === 'string' && (Err.httpStatus === 401 || Err.httpStatus === 403)) c.header('WWW-Authenticate', Challenge)
    if (Err.code === 'E_RATE_LIMIT' && typeof Err.extra?.retryAfter === 'number') c.header('Retry-After', String(Err.extra.retryAfter))
    /* E_INTERNAL 文案可能来自内部；统一通用 */
    const Message = Err.code === 'E_INTERNAL' ? '内部错误' : Err.message
    return { status: Err.httpStatus, code: Code, message: Message }
  }
  if (Err instanceof ObjectStoreError) {
    logger.error({ err: Err.message }, 'oci 存储上游失败')
    return { status: 502, code: 'UNKNOWN', message: '存储上游不可用' }
  }
  logger.error({ err: Err instanceof Error ? Err.message : String(Err) }, 'oci 未知错误')
  return { status: 500, code: 'UNKNOWN', message: '内部错误' }
}
