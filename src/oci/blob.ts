/**
 * blob 读面 —— HEAD / GET / DELETE（design §四）。
 *   repo 级访问判据：digest ∈ 本 repo index.blobs（blob 全局共享、按 repo 链接）；repo 无索引 → NAME_UNKNOWN；未链 → BLOB_UNKNOWN。
 *   GET 流式 pipe（不缓冲），Range 透传 MinIO（206 + Content-Range；越界 416）。
 *   DELETE 只摘本 repo 链接（202）；对象不删（跨 repo 共享，删除归 GC mark-sweep）。
 */

export { statBlob, openBlob, unlinkBlob }
export type { BlobStat, BlobStream }

import type { Readable } from 'node:stream'
import { getStream } from '../api/registry'
import { statObject } from '../api/objects'
import type { OciContext } from './context'
import { ociError } from './errors'
import { blobKey, parseDigest } from './layout'

interface BlobStat {
  digest: string
  size: number
}

interface BlobStream {
  digest: string
  body: Readable
  contentLength: number | null
  contentRange: string | null
  partial: boolean
}

async function statBlob(Ctx: OciContext, Name: string, RawDigest: string): Promise<BlobStat> {
  const { digest, hex } = await requireLinked(Ctx, Name, RawDigest)
  const Stat = await statObject(Ctx.client, Ctx.bucket, blobKey(hex))
  if (Stat === null) throw ociError('BLOB_UNKNOWN', 'blob 不存在')
  return { digest, size: Stat.size }
}

async function openBlob(Ctx: OciContext, Name: string, RawDigest: string, Range: string | undefined): Promise<BlobStream> {
  const { digest, hex } = await requireLinked(Ctx, Name, RawDigest)
  const Res = await getStream(Ctx.client, Ctx.bucket, blobKey(hex), Range)
  if (Res === null) throw ociError('BLOB_UNKNOWN', 'blob 不存在')
  if (Res.kind === 'range-not-satisfiable') throw ociError('RANGE_INVALID', 'Range 不可满足')
  return { digest, body: Res.body, contentLength: Res.contentLength, contentRange: Res.contentRange, partial: Res.partial }
}

async function unlinkBlob(Ctx: OciContext, Name: string, RawDigest: string): Promise<void> {
  const { digest } = parseDigest(RawDigest)
  await Ctx.index.update(Name, (Index, Existed) => {
    if (!Existed) throw ociError('NAME_UNKNOWN', 'repository 不存在')
    const At = Index.blobs.indexOf(digest)
    if (At === -1) throw ociError('BLOB_UNKNOWN', 'blob 不存在')
    Index.blobs.splice(At, 1)
  })
}

async function requireLinked(Ctx: OciContext, Name: string, RawDigest: string): Promise<{ digest: string; hex: string }> {
  const Parsed = parseDigest(RawDigest)
  const Index = await Ctx.index.read(Name)
  if (Index === null) throw ociError('NAME_UNKNOWN', 'repository 不存在')
  if (!Index.blobs.includes(Parsed.digest)) throw ociError('BLOB_UNKNOWN', 'blob 不存在')
  return Parsed
}
