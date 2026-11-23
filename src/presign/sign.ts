/**
 * 签发流水线 —— 铸数据面 JWT（exp = now + expiresIn，与 X-Amz-Expires 同寿）→ extraQuery 注入 access_token
 * → api 原语用 public client 本地签名（Host = S3_PUBLIC_ENDPOINT）。不发网络。
 * applyKeyScheme：KEY_SCHEME=date 时给 base key 加 `YYYY/MM/`（UTC，网关时钟）；put 与 multipart create 共用。
 */

export { signPut, signGet, applyKeyScheme }
export type { SignDeps, SignedPut, SignedGet, SignPutInput, SignGetInput }

import type { S3Client } from '@aws-sdk/client-s3'
import { presignGet, presignPut } from '../api/presign'
import type { ObjectPresignOptions, ObjectPresignPutOptions } from '../api/object-store'
import type { DataPlaneClaims, TokenService } from '../auth/token'
import type { KeyScheme } from '../config'
import { GatewayError } from '../core/errors'

interface SignDeps {
  publicClient: S3Client
  bucket: string
  tokens: TokenService
}

interface SignBase {
  key: string
  expiresIn: number
  client_ip: string
  sub: string
  resource_id?: string | undefined
}

interface SignPutInput extends SignBase {
  contentType?: string | undefined
}

interface SignGetInput extends SignBase {
  responseContentDisposition?: string | undefined
  responseContentType?: string | undefined
  responseCacheControl?: string | undefined
}

interface SignedPut {
  url: string
  method: 'PUT'
  key: string
  contentType?: string
  claims: DataPlaneClaims
}

interface SignedGet {
  url: string
  key: string
  claims: DataPlaneClaims
}

/* Input.key 必须已是实际对象 key（调用方先 applyKeyScheme） */
async function signPut(Deps: SignDeps, Input: SignPutInput): Promise<SignedPut> {
  const { token, claims } = await Deps.tokens.issueDataPlane({
    sub: Input.sub,
    resourceId: Input.resource_id ?? null,
    key: Input.key,
    op: 'put',
    ip: Input.client_ip,
    expiresIn: Input.expiresIn,
  })
  const Options: ObjectPresignPutOptions = { expiresIn: Input.expiresIn, extraQuery: { access_token: token } }
  if (Input.contentType !== undefined) Options.contentType = Input.contentType
  const Url = await signOrThrow(() => presignPut(Deps.publicClient, Deps.bucket, Input.key, Options))
  const Out: SignedPut = { url: Url, method: 'PUT', key: Input.key, claims }
  if (Input.contentType !== undefined) Out.contentType = Input.contentType
  return Out
}

async function signGet(Deps: SignDeps, Input: SignGetInput): Promise<SignedGet> {
  const { token, claims } = await Deps.tokens.issueDataPlane({
    sub: Input.sub,
    resourceId: Input.resource_id ?? null,
    key: Input.key,
    op: 'get',
    ip: Input.client_ip,
    expiresIn: Input.expiresIn,
  })
  const Options: ObjectPresignOptions = { expiresIn: Input.expiresIn, extraQuery: { access_token: token } }
  if (Input.responseContentDisposition !== undefined) Options.responseContentDisposition = Input.responseContentDisposition
  if (Input.responseContentType !== undefined) Options.responseContentType = Input.responseContentType
  if (Input.responseCacheControl !== undefined) Options.responseCacheControl = Input.responseCacheControl
  const Url = await signOrThrow(() => presignGet(Deps.publicClient, Deps.bucket, Input.key, Options))
  return { url: Url, key: Input.key, claims }
}

function applyKeyScheme(Scheme: KeyScheme, Key: string, Now: Date): string {
  if (Scheme === 'flat') return Key
  const Year = String(Now.getUTCFullYear()).padStart(4, '0')
  const Month = String(Now.getUTCMonth() + 1).padStart(2, '0')
  return `${Year}/${Month}/${Key}`
}

/* 原语失败的 detail 可能含 endpoint，对外只给通用文案 */
async function signOrThrow(Fn: () => Promise<string>): Promise<string> {
  try {
    return await Fn()
  } catch {
    throw new GatewayError('E_INTERNAL', '签发失败')
  }
}
