/**
 * presign 原语 —— 本地签名、不发网络（getSignedUrl 只签）。
 * 用 public 实例签，Host = 网关公开地址；Host 必须与浏览器实际访问的 Host 完全一致，否则 403。
 * PUT body 不在签名里（UNSIGNED-PAYLOAD）；contentType 需 signableHeaders 才生效。
 * extraQuery 通过 build 中间件在签名前写进 request.query（签后追加会 403，已实测）。
 */

export { presignGet, presignPut, injectQuery }

import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import type { GetObjectCommandInput, PutObjectCommandInput, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { ObjectStoreError, ensureExpiresIn } from './object-store'
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
  const Command = new GetObjectCommand(input)
  if (Options.extraQuery !== undefined) injectQuery(Command, Options.extraQuery)
  try {
    return await getSignedUrl(Client, Command, { expiresIn: Options.expiresIn })
  } catch (err) {
    throw new ObjectStoreError(`presignGet 失败`, err)
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
  const Command = new PutObjectCommand(input)
  if (Options.extraQuery !== undefined) injectQuery(Command, Options.extraQuery)
  try {
    return await getSignedUrl(Client, Command, {
      expiresIn: Options.expiresIn,
      ...(Options.contentType !== undefined ? { signableHeaders: new Set(['content-type']) } : {}),
    })
  } catch (err) {
    throw new ObjectStoreError(`presignPut 失败`, err)
  }
}

/* 任意 S3 command 挂 build 中间件注入 query；multipart presignUploadPart 复用 */
function injectQuery(Command: { middlewareStack: { add: (...args: never[]) => unknown } }, Query: Record<string, string>): void {
  const Stack = Command.middlewareStack as unknown as {
    add(
      Mw: (Next: (Args: { request: unknown }) => Promise<unknown>) => (Args: { request: unknown }) => Promise<unknown>,
      Options: { step: 'build'; name: string },
    ): void
  }
  Stack.add(
    (Next) => async (Args) => {
      const Request = Args.request as { query?: Record<string, string | string[] | null> }
      Request.query = { ...(Request.query ?? {}), ...Query }
      return Next(Args)
    },
    { step: 'build', name: 'betterMinioInjectQuery' },
  )
}
