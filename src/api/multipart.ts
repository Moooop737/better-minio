/**
 * 分片上传原语 —— create / presignUploadPart / listParts / complete / abort；SDK 类型不泄出 api 层。
 * 该 MinIO 的 ListMultipartUploads 恒空 → uploadId 由 multipart 会话自持久化，这里只按 uploadId 操作。
 * presignUploadPart 用 public client 签（Host = 网关公开地址），extraQuery（access_token）签名前注入；不签 content-type。
 * listParts 自动翻页（1000/页）；listParts / complete 遇 NoSuchUpload 返回 null；abort 幂等（NoSuchUpload 视为成功）。
 * 其余失败统一 ObjectStoreError。
 */

export { createMultipartUpload, presignUploadPart, listParts, completeMultipartUpload, abortMultipartUpload }
export type { MultipartPart, CompletedPart, UploadPartPresignOptions }

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  ListPartsCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import type { CreateMultipartUploadCommandInput, ListPartsCommandOutput, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { ObjectStoreError, ensureExpiresIn } from './object-store'
import { injectQuery } from './presign'

interface MultipartPart {
  partNumber: number
  etag: string
  size: number
}

interface CompletedPart {
  partNumber: number
  etag: string
}

interface UploadPartPresignOptions {
  expiresIn: number
  extraQuery?: Record<string, string>
}

const LIST_PAGE_SIZE = 1000

async function createMultipartUpload(
  Client: S3Client,
  Bucket: string,
  Key: string,
  Options?: { contentType?: string },
): Promise<string> {
  const input: CreateMultipartUploadCommandInput = { Bucket, Key }
  if (Options?.contentType !== undefined) input.ContentType = Options.contentType
  let UploadId: string | undefined
  try {
    UploadId = (await Client.send(new CreateMultipartUploadCommand(input))).UploadId
  } catch (err) {
    throw new ObjectStoreError(`createMultipartUpload ${Key} 失败`, err)
  }
  if (UploadId === undefined || UploadId === '') throw new ObjectStoreError(`createMultipartUpload ${Key} 未返回 uploadId`)
  return UploadId
}

async function presignUploadPart(
  Client: S3Client,
  Bucket: string,
  Key: string,
  UploadId: string,
  PartNumber: number,
  Options: UploadPartPresignOptions,
): Promise<string> {
  ensureExpiresIn(Options.expiresIn)
  const Command = new UploadPartCommand({ Bucket, Key, UploadId, PartNumber })
  if (Options.extraQuery !== undefined) injectQuery(Command, Options.extraQuery)
  try {
    return await getSignedUrl(Client, Command, { expiresIn: Options.expiresIn })
  } catch (err) {
    throw new ObjectStoreError(`presignUploadPart 失败`, err)
  }
}

async function listParts(Client: S3Client, Bucket: string, Key: string, UploadId: string): Promise<MultipartPart[] | null> {
  const Parts: MultipartPart[] = []
  let Marker: string | undefined
  for (;;) {
    let Page: ListPartsCommandOutput
    try {
      Page = await Client.send(
        new ListPartsCommand({
          Bucket,
          Key,
          UploadId,
          MaxParts: LIST_PAGE_SIZE,
          ...(Marker !== undefined ? { PartNumberMarker: Marker } : {}),
        }),
      )
    } catch (err) {
      if (isNoSuchUpload(err)) return null
      throw new ObjectStoreError(`listParts ${Key} 失败`, err)
    }
    for (const Part of Page.Parts ?? []) {
      if (Part.PartNumber === undefined || Part.ETag === undefined) continue
      Parts.push({ partNumber: Part.PartNumber, etag: Part.ETag, size: Part.Size ?? 0 })
    }
    const Next = Page.NextPartNumberMarker
    if (Page.IsTruncated !== true || Next === undefined || Next === '' || Next === Marker) break
    Marker = Next
  }
  Parts.sort((A, B) => A.partNumber - B.partNumber)
  return Parts
}

async function completeMultipartUpload(
  Client: S3Client,
  Bucket: string,
  Key: string,
  UploadId: string,
  Parts: CompletedPart[],
): Promise<{ etag: string | null } | null> {
  try {
    const Res = await Client.send(
      new CompleteMultipartUploadCommand({
        Bucket,
        Key,
        UploadId,
        MultipartUpload: { Parts: Parts.map((Part) => ({ PartNumber: Part.partNumber, ETag: Part.etag })) },
      }),
    )
    return { etag: Res.ETag ?? null }
  } catch (err) {
    if (isNoSuchUpload(err)) return null
    throw new ObjectStoreError(`completeMultipartUpload ${Key} 失败`, err)
  }
}

async function abortMultipartUpload(Client: S3Client, Bucket: string, Key: string, UploadId: string): Promise<void> {
  try {
    await Client.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }))
  } catch (err) {
    if (isNoSuchUpload(err)) return
    throw new ObjectStoreError(`abortMultipartUpload ${Key} 失败`, err)
  }
}

function isNoSuchUpload(err: unknown): boolean {
  const Name = (err as { name?: unknown } | null)?.name
  const Code = (err as { Code?: unknown } | null)?.Code
  return Name === 'NoSuchUpload' || Code === 'NoSuchUpload'
}
