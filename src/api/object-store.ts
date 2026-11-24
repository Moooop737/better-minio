/**
 * 对象存储类型与错误语义 —— api 层内部共享；SDK 类型不泄出本目录。
 * get/stat 只在对象不存在时返回 null；其余失败抛 ObjectStoreError（code=E_OBJECT_STORE）。
 */

export { ObjectStoreError, OBJECT_STORE_ERROR_CODE, PRESIGN_MIN_SECONDS, PRESIGN_MAX_SECONDS, ensureExpiresIn }
export type { ObjectStat, ObjectBody, ObjectGetOptions, ObjectPutOptions, ObjectPresignOptions, ObjectPresignPutOptions }

import type { Readable } from 'node:stream'

interface ObjectStat {
  size: number
  contentType: string | null
  etag: string | null
}

interface ObjectBody {
  body: Readable
  contentType: string | null
  contentLength: number | null
  etag: string | null
  /* Range 命中时为 `bytes a-b/total`；非空即表示上游回了 206 */
  contentRange: string | null
}

interface ObjectGetOptions {
  range?: string
}

/* ifNoneMatch: '*' = 条件写：对象已存在即失败（412），关掉并发上传同名 key 的 check-then-use 竞态 */
interface ObjectPutOptions {
  ifNoneMatch?: string
  /* 有值则显式下发 ContentLength，避免 SDK 对未知长度的流走 chunked 编码 */
  contentLength?: number
}

/* extraQuery：签名前注入的自定义 query（如 access_token），SigV4 覆盖它，篡改即破签名 */
interface ObjectPresignOptions {
  expiresIn: number
  extraQuery?: Record<string, string>
  responseContentDisposition?: string
  responseContentType?: string
  responseCacheControl?: string
}

interface ObjectPresignPutOptions {
  expiresIn: number
  extraQuery?: Record<string, string>
  contentType?: string
}

const OBJECT_STORE_ERROR_CODE = 'E_OBJECT_STORE'
const PRESIGN_MIN_SECONDS = 1
const PRESIGN_MAX_SECONDS = 604800

class ObjectStoreError extends Error {
  readonly code = OBJECT_STORE_ERROR_CODE
  readonly detail: string | null
  /* 上游 HTTP 状态（SDK 错误的 $metadata 里取），供控制端点区分 404 / 412；非 HTTP 失败为 null */
  readonly status: number | null

  constructor(Message: string, Cause?: unknown, Status?: number) {
    super(Message)
    this.name = 'ObjectStoreError'
    this.detail = Cause === undefined ? null : String(Cause)
    this.status = Status ?? null
  }

  override toString(): string {
    return this.detail === null
      ? `${this.name}: ${this.message}`
      : `${this.name}: ${this.message} (${this.detail})`
  }
}

function ensureExpiresIn(Seconds: number): void {
  if (!Number.isInteger(Seconds) || Seconds < PRESIGN_MIN_SECONDS || Seconds > PRESIGN_MAX_SECONDS) {
    throw new ObjectStoreError(`expiresIn 需为 ${PRESIGN_MIN_SECONDS}-${PRESIGN_MAX_SECONDS} 的整数，收到: ${Seconds}`)
  }
}