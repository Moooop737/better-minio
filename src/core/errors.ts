/**
 * 网关错误口径 —— 全模块抛 GatewayError { code, httpStatus, message }；渲染归各面
 * （S3 数据面 XML / 控制面 JSON / OCI distribution 错误体）。message 必须是可对外的通用文案：
 * 不含 MinIO 地址、bucket 内部信息、object key、凭证。
 */

export { GatewayError, ERROR_STATUS, gatewayError, isGatewayError }
export type { GatewayErrorCode }

type GatewayErrorCode =
  | 'E_TOKEN_MISSING'
  | 'E_TOKEN_INVALID'
  | 'E_OP_MISMATCH'
  | 'E_PATH_MISMATCH'
  | 'E_IP_MISMATCH'
  | 'E_SERVICE_TOKEN'
  | 'E_SCOPE'
  | 'E_VALIDATION'
  | 'E_NOT_FOUND'
  | 'E_SESSION_NOT_FOUND'
  | 'E_PART_SIZE_MISMATCH'
  | 'E_RATE_LIMIT'
  | 'E_UPSTREAM'
  | 'E_INTERNAL'

const ERROR_STATUS: Record<GatewayErrorCode, number> = {
  E_TOKEN_MISSING: 401,
  E_TOKEN_INVALID: 401,
  E_OP_MISMATCH: 403,
  E_PATH_MISMATCH: 403,
  E_IP_MISMATCH: 403,
  E_SERVICE_TOKEN: 401,
  E_SCOPE: 403,
  E_VALIDATION: 400,
  E_NOT_FOUND: 404,
  E_SESSION_NOT_FOUND: 404,
  E_PART_SIZE_MISMATCH: 400,
  E_RATE_LIMIT: 429,
  E_UPSTREAM: 502,
  E_INTERNAL: 500,
}

class GatewayError extends Error {
  readonly code: GatewayErrorCode
  readonly httpStatus: number
  /* 附加的对外安全数据（如违规 partNumber 列表）；渲染时并入 JSON 体 */
  readonly extra: Record<string, unknown> | null

  constructor(Code: GatewayErrorCode, Message: string, Extra?: Record<string, unknown>) {
    super(Message)
    this.name = 'GatewayError'
    this.code = Code
    this.httpStatus = ERROR_STATUS[Code]
    this.extra = Extra ?? null
  }
}

function gatewayError(Code: GatewayErrorCode, Message: string, Extra?: Record<string, unknown>): GatewayError {
  return new GatewayError(Code, Message, Extra)
}

function isGatewayError(Err: unknown): Err is GatewayError {
  return Err instanceof GatewayError
}
