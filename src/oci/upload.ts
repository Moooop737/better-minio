/**
 * blob 上传会话 —— POST / PATCH / PUT ?digest= / DELETE / GET 状态（design §四，D3）。
 *   会话头存 StateStore（`better-minio:oci:upload:<uuid>` = {name,size,chunks,createdAt,expiresAt}）；chunk 清单不另存，
 *   真源是 MinIO 对象 `uploads/<uuid>/chunk-<n>`（n = 0..chunks-1）。expiresAt = 最近活动 + OCI_UPLOAD_TTL；
 *   存储层 TTL 取 2×TTL，让过期会话还留得住给 gc 扫到并清 chunk。
 *   PATCH：请求体流式写一个 chunk 对象（putStream，内存 ≤8 MiB）；Content-Range 起点必须 = 当前 size，否则 416。
 *   PUT 收尾：chunk-0..n GET 流 + 末段请求体 → sha256 hasher → 流式写 uploads/<uuid>/final；
 *     不符 → 删 final+chunks+会话，400 DIGEST_INVALID；相符 → blob 不存在才 CopyObject 进 blobs/sha256/<hex>
 *     → 删临时 → digest 链入本 repo index.blobs。未校验内容永不进内容寻址区。
 *   同一 uuid 的操作进程内串行。跨 repo mount（?mount=&from=）不支持：按 spec 降级为开新会话（202）。
 */

export { startUpload, uploadStatus, appendChunk, finishUpload, cancelUpload, readSession }
export type { UploadSession }

import { createHash, randomUUID } from 'node:crypto'
import { copyObject, deleteMany, getStream, putStream } from '../api/registry'
import { statObject } from '../api/objects'
import type { OciContext } from './context'
import { OciError, ociError } from './errors'
import { blobKey, chunkKey, finalKey, parseDigest, sessionKey, UPLOAD_ID_RE } from './layout'

interface UploadSession {
  name: string
  size: number
  chunks: number
  createdAt: number
  expiresAt: number
}

async function startUpload(Ctx: OciContext, Name: string): Promise<{ uuid: string; session: UploadSession }> {
  const Uuid = randomUUID()
  const Now = Ctx.now()
  const Session: UploadSession = { name: Name, size: 0, chunks: 0, createdAt: Now, expiresAt: Now + Ctx.uploadTtl * 1000 }
  await saveSession(Ctx, Uuid, Session)
  return { uuid: Uuid, session: Session }
}

async function uploadStatus(Ctx: OciContext, Name: string, Uuid: string): Promise<UploadSession> {
  return requireSession(Ctx, Name, Uuid)
}

async function appendChunk(
  Ctx: OciContext,
  Name: string,
  Uuid: string,
  Body: AsyncIterable<Uint8Array>,
  ContentRange: string | undefined,
): Promise<{ session: UploadSession; written: number }> {
  return Ctx.uploadLock.run(Uuid, async () => {
    const Session = await requireSession(Ctx, Name, Uuid)
    const Declared = ContentRange === undefined ? null : parseContentRange(ContentRange)
    if (Declared !== null && Declared.start !== Session.size) {
      throw ociError('RANGE_INVALID', 'chunk 起点与已接收大小不符', { headers: progressHeaders(Name, Uuid, Session.size) })
    }
    const Key = chunkKey(Uuid, Session.chunks)
    const Written = await putStream(Ctx.client, Ctx.bucket, Key, Body)
    if (Declared !== null && Declared.end !== null && Declared.end - Declared.start + 1 !== Written.size) {
      await deleteMany(Ctx.client, Ctx.bucket, [Key])
      throw ociError('SIZE_INVALID', 'chunk 实际大小与 Content-Range 不符')
    }
    const Next: UploadSession = {
      ...Session,
      size: Session.size + Written.size,
      chunks: Session.chunks + 1,
      expiresAt: Ctx.now() + Ctx.uploadTtl * 1000,
    }
    await saveSession(Ctx, Uuid, Next)
    return { session: Next, written: Written.size }
  })
}

async function finishUpload(
  Ctx: OciContext,
  Name: string,
  Uuid: string,
  RawDigest: string | undefined,
  Body: AsyncIterable<Uint8Array> | null,
): Promise<{ digest: string; size: number; written: number }> {
  return Ctx.uploadLock.run(Uuid, async () => {
    const Session = await requireSession(Ctx, Name, Uuid)
    const { digest, hex } = parseDigest(RawDigest)
    const Temps = [...chunkKeys(Uuid, Session.chunks), finalKey(Uuid)]

    const Hash = createHash('sha256')
    let Tail = 0
    async function* concat(): AsyncGenerator<Uint8Array> {
      for (let N = 0; N < Session.chunks; N++) {
        const Chunk = await getStream(Ctx.client, Ctx.bucket, chunkKey(Uuid, N))
        if (Chunk === null || Chunk.kind !== 'ok') throw ociError('BLOB_UPLOAD_INVALID', '上传会话数据缺失，请重新上传')
        for await (const Piece of Chunk.body as AsyncIterable<Uint8Array>) {
          Hash.update(Piece)
          yield Piece
        }
      }
      if (Body === null) return
      for await (const Piece of Body) {
        Hash.update(Piece)
        Tail += Piece.byteLength
        yield Piece
      }
    }

    let Assembled
    try {
      Assembled = await putStream(Ctx.client, Ctx.bucket, finalKey(Uuid), concat())
    } catch (err) {
      /* 会话数据已缺失：会话作废并清理；其他失败（上游 / 断连）保留会话，过期由 gc 兜底 */
      if (err instanceof OciError && err.code === 'BLOB_UPLOAD_INVALID') await discard(Ctx, Uuid, Temps)
      throw err
    }

    if (Hash.digest('hex') !== hex) {
      await discard(Ctx, Uuid, Temps)
      throw ociError('DIGEST_INVALID', '上传内容与 digest 不符')
    }

    if ((await statObject(Ctx.client, Ctx.bucket, blobKey(hex))) === null) {
      await copyObject(Ctx.client, Ctx.bucket, finalKey(Uuid), blobKey(hex))
    }
    await discard(Ctx, Uuid, Temps)
    await Ctx.index.update(Name, (Index) => {
      if (!Index.blobs.includes(digest)) Index.blobs.push(digest)
    })
    return { digest, size: Assembled.size, written: Tail }
  })
}

async function cancelUpload(Ctx: OciContext, Name: string, Uuid: string): Promise<void> {
  await Ctx.uploadLock.run(Uuid, async () => {
    const Session = await requireSession(Ctx, Name, Uuid)
    await discard(Ctx, Uuid, [...chunkKeys(Uuid, Session.chunks), finalKey(Uuid)])
  })
}

/* gc 用：读会话头（不校验 repo / 过期） */
async function readSession(Ctx: Pick<OciContext, 'store'>, Uuid: string): Promise<UploadSession | null> {
  const Raw = await Ctx.store.get(sessionKey(Uuid))
  if (Raw === null) return null
  try {
    return JSON.parse(Raw) as UploadSession
  } catch {
    return null
  }
}

async function requireSession(Ctx: OciContext, Name: string, Uuid: string): Promise<UploadSession> {
  const Session = UPLOAD_ID_RE.test(Uuid) ? await readSession(Ctx, Uuid) : null
  if (Session === null || Session.name !== Name || Session.expiresAt <= Ctx.now()) {
    throw ociError('BLOB_UPLOAD_UNKNOWN', '上传会话不存在或已过期')
  }
  return Session
}

async function saveSession(Ctx: OciContext, Uuid: string, Session: UploadSession): Promise<void> {
  await Ctx.store.set(sessionKey(Uuid), JSON.stringify(Session), Ctx.uploadTtl * 2)
}

async function discard(Ctx: OciContext, Uuid: string, Keys: string[]): Promise<void> {
  await deleteMany(Ctx.client, Ctx.bucket, Keys)
  await Ctx.store.del(sessionKey(Uuid))
}

function chunkKeys(Uuid: string, Count: number): string[] {
  return Array.from({ length: Count }, (_, N) => chunkKey(Uuid, N))
}

/* Content-Range: `<start>-<end>`（distribution 口径）或 `bytes <start>-<end>/<total|*>` */
function parseContentRange(Raw: string): { start: number; end: number | null } {
  const Match = /^(?:bytes[ =])?(\d+)-(\d+)?(?:\/(?:\d+|\*))?$/.exec(Raw.trim())
  if (Match?.[1] === undefined) throw ociError('RANGE_INVALID', 'Content-Range 格式非法')
  const Start = Number(Match[1])
  const End = Match[2] === undefined ? null : Number(Match[2])
  if (End !== null && End < Start) throw ociError('RANGE_INVALID', 'Content-Range 格式非法')
  return { start: Start, end: End }
}

function progressHeaders(Name: string, Uuid: string, Size: number): Record<string, string> {
  return {
    Location: `/v2/${Name}/blobs/uploads/${Uuid}`,
    Range: `0-${Math.max(Size - 1, 0)}`,
    'Docker-Upload-UUID': Uuid,
  }
}
