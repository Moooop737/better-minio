/**
 * registry 存储原语 —— oci 模块专用的 S3 操作；SDK 类型不泄出本目录，失败统一 ObjectStoreError。
 *   putStream：流式写对象，内存有界（≤ 一个 8 MiB part）：总量 ≤ 一片 → 单次 PutObject；否则 S3 multipart 逐片上传（失败即 abort）。
 *     源流自身抛的错原样透传（不包装）。
 *   putBytes：小对象条件写（If-Match / If-None-Match），返回 ETag；条件不满足返回 { ok:false }（不抛）。
 *   getBytes：小对象读全量 + ETag（索引 / manifest 用），不存在 null。
 *   getStream：流式读（Range 透传），不存在 null；Range 越界返回 { kind:'range-not-satisfiable' }。
 *   copyObject：同桶 server-side 复制（数据不过网关；S3 单次上限 5 GiB）。
 *   listByPrefix：前缀列举（分页取全）带 size / lastModified。
 *   deleteMany：逐个删除（MinIO 不兼容 SDK 批量删除的强制 CRC32），不存在的 key 视为成功。
 */

export { putStream, putBytes, getBytes, getStream, copyObject, listByPrefix, deleteMany, STREAM_PART_SIZE }
export type { PutStreamResult, PutBytesResult, BytesObject, StreamObject, StreamResult, ListedObject }

import { Buffer } from 'node:buffer'
import type { Readable } from 'node:stream'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import type { CompletedPart, GetObjectCommandInput, PutObjectCommandInput, S3Client } from '@aws-sdk/client-s3'
import { ObjectStoreError } from './object-store'

/* 8 MiB：S3 非末片下限 5 MiB 之上留余量；也是 putStream 的内存上界 */
const STREAM_PART_SIZE = 8 * 1024 * 1024

interface PutStreamResult {
  size: number
  etag: string | null
}

type PutBytesResult = { ok: true; etag: string | null } | { ok: false }

interface BytesObject {
  body: Buffer
  etag: string | null
  contentType: string | null
}

interface StreamObject {
  kind: 'ok'
  body: Readable
  contentLength: number | null
  contentRange: string | null
  contentType: string | null
  partial: boolean
}

type StreamResult = StreamObject | { kind: 'range-not-satisfiable' }

interface ListedObject {
  key: string
  size: number
  lastModified: Date | null
}

async function putStream(
  Client: S3Client,
  Bucket: string,
  Key: string,
  Body: AsyncIterable<Uint8Array>,
  ContentType = 'application/octet-stream',
): Promise<PutStreamResult> {
  const Iterator = Body[Symbol.asyncIterator]()
  let Size = 0
  let Pending: Buffer[] = []
  let PendingBytes = 0
  let Ended = false

  /* 攒满一片（或流结束）才返回；内存 ≤ STREAM_PART_SIZE + 单个上游 chunk */
  const nextPart = async (): Promise<Buffer | null> => {
    while (!Ended && PendingBytes < STREAM_PART_SIZE) {
      let Step: IteratorResult<Uint8Array>
      try {
        Step = await Iterator.next()
      } catch (err) {
        throw new SourceFailure(err)
      }
      if (Step.done === true) {
        Ended = true
        break
      }
      const Chunk = Buffer.from(Step.value.buffer, Step.value.byteOffset, Step.value.byteLength)
      Pending.push(Chunk)
      PendingBytes += Chunk.byteLength
      Size += Chunk.byteLength
    }
    if (PendingBytes === 0 && Ended) return null
    const Part = Buffer.concat(Pending, PendingBytes)
    Pending = []
    PendingBytes = 0
    return Part
  }

  let First: Buffer
  try {
    First = (await nextPart()) ?? Buffer.alloc(0)
  } catch (err) {
    throw err instanceof SourceFailure ? err.source : err
  }
  if (Ended) {
    try {
      const Res = await Client.send(new PutObjectCommand({ Bucket, Key, Body: First, ContentType, ContentLength: First.byteLength }))
      return { size: Size, etag: Res.ETag ?? null }
    } catch (err) {
      throw new ObjectStoreError(`put ${Key} 失败`, err)
    }
  }

  let UploadId: string | undefined
  try {
    const Created = await Client.send(new CreateMultipartUploadCommand({ Bucket, Key, ContentType }))
    UploadId = Created.UploadId
    if (UploadId === undefined) throw new ObjectStoreError(`multipart ${Key} 未返回 uploadId`)
    const Parts: CompletedPart[] = []
    let Part: Buffer | null = First
    while (Part !== null) {
      const PartNumber = Parts.length + 1
      const Res = await Client.send(new UploadPartCommand({ Bucket, Key, UploadId, PartNumber, Body: Part, ContentLength: Part.byteLength }))
      Parts.push({ PartNumber, ETag: Res.ETag })
      Part = await nextPart()
    }
    const Done = await Client.send(new CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts } }))
    return { size: Size, etag: Done.ETag ?? null }
  } catch (err) {
    if (UploadId !== undefined) {
      await Client.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId })).catch(() => undefined)
    }
    if (err instanceof SourceFailure) throw err.source
    if (err instanceof ObjectStoreError) throw err
    throw new ObjectStoreError(`multipart put ${Key} 失败`, err)
  }
}

async function putBytes(
  Client: S3Client,
  Bucket: string,
  Key: string,
  Body: Uint8Array,
  Options: { contentType: string; ifMatch?: string; ifNoneMatch?: string },
): Promise<PutBytesResult> {
  const Input: PutObjectCommandInput = { Bucket, Key, Body, ContentType: Options.contentType, ContentLength: Body.byteLength }
  if (Options.ifMatch !== undefined) Input.IfMatch = Options.ifMatch
  if (Options.ifNoneMatch !== undefined) Input.IfNoneMatch = Options.ifNoneMatch
  try {
    const Res = await Client.send(new PutObjectCommand(Input))
    return { ok: true, etag: Res.ETag ?? null }
  } catch (err) {
    /* 412 条件不满足 / 409 并发条件写冲突 / If-Match 但对象已不在（404）：都按「条件不满足」交给调用方重试 */
    const Status = statusOf(err)
    if (Status === 412 || Status === 409 || (Options.ifMatch !== undefined && Status === 404)) return { ok: false }
    throw new ObjectStoreError(`put ${Key} 失败`, err)
  }
}

async function getBytes(Client: S3Client, Bucket: string, Key: string): Promise<BytesObject | null> {
  try {
    const Res = await Client.send(new GetObjectCommand({ Bucket, Key }))
    if (!Res.Body) throw new ObjectStoreError(`get ${Key} 响应没有 body`)
    const Bytes = await Res.Body.transformToByteArray()
    return { body: Buffer.from(Bytes.buffer, Bytes.byteOffset, Bytes.byteLength), etag: Res.ETag ?? null, contentType: Res.ContentType ?? null }
  } catch (err) {
    if (isNotFound(err)) return null
    if (err instanceof ObjectStoreError) throw err
    throw new ObjectStoreError(`get ${Key} 失败`, err)
  }
}

async function getStream(Client: S3Client, Bucket: string, Key: string, Range?: string): Promise<StreamResult | null> {
  const Input: GetObjectCommandInput = { Bucket, Key }
  if (Range !== undefined) Input.Range = Range
  try {
    const Res = await Client.send(new GetObjectCommand(Input))
    if (!Res.Body) throw new ObjectStoreError(`get ${Key} 响应没有 body`)
    return {
      kind: 'ok',
      body: Res.Body as Readable,
      contentLength: Res.ContentLength ?? null,
      contentRange: Res.ContentRange ?? null,
      contentType: Res.ContentType ?? null,
      partial: Res.ContentRange !== undefined && Range !== undefined,
    }
  } catch (err) {
    if (isNotFound(err)) return null
    if (statusOf(err) === 416 || nameOf(err) === 'InvalidRange') return { kind: 'range-not-satisfiable' }
    if (err instanceof ObjectStoreError) throw err
    throw new ObjectStoreError(`get ${Key} 失败`, err)
  }
}

async function copyObject(Client: S3Client, Bucket: string, SourceKey: string, TargetKey: string): Promise<void> {
  try {
    await Client.send(new CopyObjectCommand({ Bucket, Key: TargetKey, CopySource: `${Bucket}/${encodeCopyKey(SourceKey)}` }))
  } catch (err) {
    throw new ObjectStoreError(`copy ${SourceKey} → ${TargetKey} 失败`, err)
  }
}

async function listByPrefix(Client: S3Client, Bucket: string, Prefix: string): Promise<ListedObject[]> {
  const Out: ListedObject[] = []
  let Token: string | undefined
  try {
    do {
      const Res = await Client.send(new ListObjectsV2Command({ Bucket, Prefix, ...(Token !== undefined ? { ContinuationToken: Token } : {}) }))
      for (const Item of Res.Contents ?? []) {
        if (Item.Key === undefined) continue
        Out.push({ key: Item.Key, size: Item.Size ?? 0, lastModified: Item.LastModified ?? null })
      }
      Token = Res.IsTruncated === true ? Res.NextContinuationToken : undefined
    } while (Token !== undefined)
  } catch (err) {
    throw new ObjectStoreError(`list ${Prefix} 失败`, err)
  }
  return Out
}

async function deleteMany(Client: S3Client, Bucket: string, Keys: string[]): Promise<number> {
  let Deleted = 0
  /* 逐个 DELETE 而非 DeleteObjects：AWS SDK 会为批量删除强制附 CRC32，MinIO 对此返回 InvalidRequest；
     OCI 清理的对象量是个位数（chunk + final），逐条请求的代价可以忽略。 */
  for (const Key of Keys) {
    try {
      await Client.send(new DeleteObjectCommand({ Bucket, Key }))
      Deleted += 1
    } catch (err) {
      if (isNotFound(err)) continue
      throw new ObjectStoreError(`delete ${Key} 失败`, err)
    }
  }
  return Deleted
}

/* 源流（调用方）抛的错原样透传，不包成 ObjectStoreError（如 digest 拼接时的业务错误、客户端断连） */
class SourceFailure {
  constructor(readonly source: unknown) {}
}

/* CopySource = bucket/key，key 需 URI 编码（保留 /） */
function encodeCopyKey(Key: string): string {
  return Key.split('/').map(encodeURIComponent).join('/')
}

function statusOf(err: unknown): number | undefined {
  return (err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode
}

function nameOf(err: unknown): unknown {
  return (err as { name?: unknown } | null)?.name
}

function isNotFound(err: unknown): boolean {
  const Name = nameOf(err)
  return Name === 'NotFound' || Name === 'NoSuchKey' || statusOf(err) === 404
}
