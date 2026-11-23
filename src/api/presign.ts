/**
 * presign 原语 —— 本地签名、不发网络（getSignedUrl 只签）。
 * 用 public 实例签，Host = 网关公开地址；Host 必须与浏览器实际访问的 Host 完全一致，否则 403。
 * PUT body 不在签名里（UNSIGNED-PAYLOAD）；contentType 需 signableHeaders 才生效。
 */

export { presignGet, presignPut }

import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import type { GetObjectCommandInput, PutObjectCommandInput, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { ensureExpiresIn } from './object-store'
import type { ObjectPresignOptions, ObjectPresignPutOptions } from './object-store'

async function presignGet(
  Client: S3Client,
  Bucket: string,
  Key: string,
  Options: ObjectPresignOptions,
): Promise<string> {
  ensureExpiresIn(Options.expiresIn)
  const input: GetObjectCommandInput = { Bucket, Key }
  if (Options.responseContentDisposition !== undefined) {
    input.ResponseContentDisposition = Options.responseContentDisposition
  }
  if (Options.responseContentType !== undefined) {
    input.ResponseContentType = Options.responseContentType
  }
  if (Options.responseCacheControl !== undefined) {
    input.ResponseCacheControl = Options.responseCacheControl
  }
  try {
    return await getSignedUrl(Client, new GetObjectCommand(input), { expiresIn: Options.expiresIn })
  } catch (err) {
    throw new Error(`presignGet ${Key} 失败: ${String(err)}`)
  }
}

async function presignPut(
  Client: S3Client,
  Bucket: string,
  Key: string,
  Options: ObjectPresignPutOptions,
): Promise<string> {
  ensureExpiresIn(Options.expiresIn)
  const input: PutObjectCommandInput = { Bucket, Key }
  if (Options.contentType !== undefined) input.ContentType = Options.contentType
  try {
    return await getSignedUrl(Client, new PutObjectCommand(input), {
      expiresIn: Options.expiresIn,
      ...(Options.contentType !== undefined ? { signableHeaders: new Set(['content-type']) } : {}),
    })
  } catch (err) {
    throw new Error(`presignPut ${Key} 失败: ${String(err)}`)
  }
}