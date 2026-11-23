/**
 * 分片签名 —— sign-part 与 complete 自愈重签共用一条路径：每次铸新 JWT（op put，key/ip/sub/resource_id 取会话）
 * → presignUploadPart（public client，access_token 签名前注入，不签 content-type）。无状态，并发安全。
 * 签名意外失败 → E_INTERNAL 通用文案（不泄地址/凭证）。
 */

export { signPart, DEFAULT_PART_EXPIRES_IN }
export type { SignPartDeps, SignedPart }

import type { S3Client } from '@aws-sdk/client-s3'
import { presignUploadPart } from '../api/multipart'
import type { TokenService } from '../auth/token'
import { GatewayError } from '../core/errors'
import type { MultipartSession } from './session'

interface SignPartDeps {
  publicClient: S3Client
  bucket: string
  tokens: TokenService
}

interface SignedPart {
  url: string
  partNumber: number
  expiresIn: number
}

const DEFAULT_PART_EXPIRES_IN = 300

async function signPart(Deps: SignPartDeps, Session: MultipartSession, PartNumber: number, ExpiresIn: number): Promise<SignedPart> {
  const { token } = await Deps.tokens.issueDataPlane({
    sub: Session.sub,
    resourceId: Session.resourceId,
    key: Session.key,
    op: 'put',
    ip: Session.clientIp,
    expiresIn: ExpiresIn,
  })
  let Url: string
  try {
    Url = await presignUploadPart(Deps.publicClient, Deps.bucket, Session.key, Session.uploadId, PartNumber, {
      expiresIn: ExpiresIn,
      extraQuery: { access_token: token },
    })
  } catch {
    throw new GatewayError('E_INTERNAL', '分片签名失败')
  }
  return { url: Url, partNumber: PartNumber, expiresIn: ExpiresIn }
}
