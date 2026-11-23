/**
 * manifest 面 —— PUT / GET / HEAD / DELETE + tags/list（design §三）。
 *   put：body ≤4 MiB 缓冲 → 结构校验（schemaVersion 2、mediaType ∈ OCI image manifest / Docker v2、config+layers descriptor）
 *        → 引用完整性（config + layers ∈ 本 repo index.blobs，缺 → MANIFEST_BLOB_UNKNOWN）→ sha256 与 digest ref 比对
 *        → 写 blobs/sha256/<hex>（If-None-Match:*，已存在幂等）→ 索引登记（tag 不可变：同 digest 幂等、异 digest 409 TAG_INVALID）。
 *   get/head：tag → index.tags → digest；digest → index.manifests；repo 无索引 NAME_UNKNOWN；回读时校验内容 sha256。
 *   delete：digest → 摘 manifest + 指向它的全部 tag；tag → 只摘 tag；对象不删（归 GC）。
 * 网关不解释 .kcplan 语义：config/layer mediaType 与 annotations 原样存。
 */

export { putManifest, getManifest, deleteManifest, listTags, readManifestBody, MANIFEST_MAX_BYTES, SUPPORTED_MANIFEST_TYPES }
export type { ManifestRecord, TagPage }

import { createHash } from 'node:crypto'
import { getBytes, putBytes } from '../api/registry'
import type { OciContext } from './context'
import { ociError } from './errors'
import { blobKey, isDigestRef, isTag, parseDigest } from './layout'
import type { RepoIndex } from './repo-index'

const MANIFEST_MAX_BYTES = 4 * 1024 * 1024
const OCI_IMAGE_MANIFEST = 'application/vnd.oci.image.manifest.v1+json'
const DOCKER_MANIFEST_V2 = 'application/vnd.docker.distribution.manifest.v2+json'
const SUPPORTED_MANIFEST_TYPES: readonly string[] = [OCI_IMAGE_MANIFEST, DOCKER_MANIFEST_V2]

interface ManifestRecord {
  digest: string
  mediaType: string
  size: number
  body: Buffer | null
}

interface TagPage {
  tags: string[]
  /* 还有下一页时的 last 游标 */
  next: string | null
}

interface Descriptor {
  mediaType: string
  digest: string
  size: number
}

async function putManifest(Ctx: OciContext, Name: string, Ref: string, Body: Buffer, ContentType: string | undefined): Promise<{ digest: string }> {
  const Parsed = validateManifest(Body, ContentType)
  const Digest = `sha256:${createHash('sha256').update(Body).digest('hex')}`
  let Tag: string | null = null
  if (isDigestRef(Ref)) {
    if (parseDigest(Ref).digest !== Digest) throw ociError('DIGEST_INVALID', 'manifest 内容与 digest 不符')
  } else if (isTag(Ref)) {
    Tag = Ref
  } else {
    throw ociError('TAG_INVALID', 'tag 格式非法', { status: 400 })
  }

  /* 预检（快失败，免写无主对象）；登记时在锁内再查一遍 */
  checkAgainstIndex(await Ctx.index.read(Name), Parsed.refs, Tag, Digest)

  const Hex = Digest.slice('sha256:'.length)
  await putBytes(Ctx.client, Ctx.bucket, blobKey(Hex), Body, { contentType: Parsed.mediaType, ifNoneMatch: '*' })

  await Ctx.index.update(Name, (Index) => {
    checkAgainstIndex(Index, Parsed.refs, Tag, Digest)
    Index.manifests[Digest] = { mediaType: Parsed.mediaType, size: Body.byteLength }
    if (Tag !== null) Index.tags[Tag] = Digest
  })
  return { digest: Digest }
}

async function getManifest(Ctx: OciContext, Name: string, Ref: string, WithBody: boolean): Promise<ManifestRecord> {
  const Index = await Ctx.index.read(Name)
  if (Index === null) throw ociError('NAME_UNKNOWN', 'repository 不存在')
  let Digest: string | undefined
  if (isDigestRef(Ref)) Digest = parseDigest(Ref).digest
  else if (isTag(Ref)) Digest = Index.tags[Ref]
  const Entry = Digest === undefined ? undefined : Index.manifests[Digest]
  if (Digest === undefined || Entry === undefined) throw ociError('MANIFEST_UNKNOWN', 'manifest 不存在')
  if (!WithBody) return { digest: Digest, mediaType: Entry.mediaType, size: Entry.size, body: null }

  const Hex = Digest.slice('sha256:'.length)
  const Stored = await getBytes(Ctx.client, Ctx.bucket, blobKey(Hex))
  if (Stored === null) throw ociError('MANIFEST_UNKNOWN', 'manifest 不存在')
  if (createHash('sha256').update(Stored.body).digest('hex') !== Hex) throw ociError('UNKNOWN', '存储内容校验失败', { status: 500 })
  return { digest: Digest, mediaType: Entry.mediaType, size: Stored.body.byteLength, body: Stored.body }
}

async function deleteManifest(Ctx: OciContext, Name: string, Ref: string): Promise<void> {
  const ByDigest = isDigestRef(Ref) ? parseDigest(Ref).digest : null
  if (ByDigest === null && !isTag(Ref)) throw ociError('MANIFEST_UNKNOWN', 'manifest 不存在')
  await Ctx.index.update(Name, (Index, Existed) => {
    if (!Existed) throw ociError('NAME_UNKNOWN', 'repository 不存在')
    if (ByDigest !== null) {
      if (Index.manifests[ByDigest] === undefined) throw ociError('MANIFEST_UNKNOWN', 'manifest 不存在')
      delete Index.manifests[ByDigest]
      for (const [Tag, Target] of Object.entries(Index.tags)) if (Target === ByDigest) delete Index.tags[Tag]
      return
    }
    if (Index.tags[Ref] === undefined) throw ociError('MANIFEST_UNKNOWN', 'tag 不存在')
    delete Index.tags[Ref]
  })
}

/* 字典序分页：last = 上一页最后一个 tag（不含）；n = 页大小（缺省全量） */
async function listTags(Ctx: OciContext, Name: string, N: number | null, Last: string | null): Promise<TagPage> {
  const Index = await Ctx.index.read(Name)
  if (Index === null) throw ociError('NAME_UNKNOWN', 'repository 不存在')
  const All = Object.keys(Index.tags).sort().filter((Tag) => Last === null || Tag > Last)
  if (N === null || All.length <= N) return { tags: All, next: null }
  const Page = All.slice(0, N)
  return { tags: Page, next: Page[Page.length - 1] ?? null }
}

/* 请求体读到上限即拒（不信 Content-Length，按实际字节计） */
async function readManifestBody(Stream: ReadableStream<Uint8Array> | null, DeclaredLength: string | undefined): Promise<Buffer> {
  if (DeclaredLength !== undefined && Number(DeclaredLength) > MANIFEST_MAX_BYTES) {
    throw ociError('MANIFEST_INVALID', 'manifest 超过 4 MiB 上限')
  }
  if (Stream === null) return Buffer.alloc(0)
  const Chunks: Buffer[] = []
  let Total = 0
  const Reader = Stream.getReader()
  for (;;) {
    const Step = await Reader.read()
    if (Step.done) break
    Total += Step.value.byteLength
    if (Total > MANIFEST_MAX_BYTES) {
      await Reader.cancel().catch(() => undefined)
      throw ociError('MANIFEST_INVALID', 'manifest 超过 4 MiB 上限')
    }
    Chunks.push(Buffer.from(Step.value))
  }
  return Buffer.concat(Chunks, Total)
}

function checkAgainstIndex(Index: RepoIndex | null, Refs: string[], Tag: string | null, Digest: string): void {
  const Linked = new Set(Index?.blobs ?? [])
  const Missing = Refs.filter((Ref) => !Linked.has(Ref))
  if (Missing.length > 0) throw ociError('MANIFEST_BLOB_UNKNOWN', 'manifest 引用的 blob 不存在', { detail: { digests: Missing } })
  const Current = Tag === null ? undefined : Index?.tags[Tag]
  if (Current !== undefined && Current !== Digest) {
    throw ociError('TAG_INVALID', 'tag 不可变：已指向其他 manifest', { detail: { tag: Tag } })
  }
}

function validateManifest(Body: Buffer, ContentType: string | undefined): { mediaType: string; refs: string[] } {
  let Raw: unknown
  try {
    Raw = JSON.parse(Body.toString('utf8'))
  } catch {
    throw ociError('MANIFEST_INVALID', 'manifest 不是合法 JSON')
  }
  if (typeof Raw !== 'object' || Raw === null || Array.isArray(Raw)) throw ociError('MANIFEST_INVALID', 'manifest 必须是 JSON 对象')
  const Manifest = Raw as Record<string, unknown>
  if (Manifest.schemaVersion !== 2) throw ociError('MANIFEST_INVALID', 'schemaVersion 必须为 2')

  const HeaderType = ContentType?.split(';')[0]?.trim().toLowerCase() || undefined
  const BodyType = Manifest.mediaType
  if (BodyType !== undefined && typeof BodyType !== 'string') throw ociError('MANIFEST_INVALID', 'mediaType 非法')
  if (BodyType !== undefined && HeaderType !== undefined && BodyType !== HeaderType) {
    throw ociError('MANIFEST_INVALID', 'Content-Type 与 manifest mediaType 不一致')
  }
  const MediaType = BodyType ?? HeaderType
  if (MediaType === undefined) throw ociError('MANIFEST_INVALID', '缺少 mediaType')
  if (!SUPPORTED_MANIFEST_TYPES.includes(MediaType)) throw ociError('UNSUPPORTED', 'manifest mediaType 不支持')

  const Config = toDescriptor(Manifest.config, 'config')
  if (!Array.isArray(Manifest.layers)) throw ociError('MANIFEST_INVALID', 'layers 必须是数组')
  const Layers = Manifest.layers.map((Layer, I) => toDescriptor(Layer, `layers[${I}]`))
  return { mediaType: MediaType, refs: [...new Set([Config.digest, ...Layers.map((Layer) => Layer.digest)])] }
}

function toDescriptor(Value: unknown, Where: string): Descriptor {
  const Item = (typeof Value === 'object' && Value !== null ? Value : null) as Record<string, unknown> | null
  const MediaType = Item?.mediaType
  const Digest = Item?.digest
  const Size = Item?.size
  if (typeof MediaType !== 'string' || MediaType === '') throw ociError('MANIFEST_INVALID', `${Where}.mediaType 缺失`)
  if (typeof Digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(Digest)) throw ociError('MANIFEST_INVALID', `${Where}.digest 非法`)
  if (typeof Size !== 'number' || !Number.isSafeInteger(Size) || Size < 0) throw ociError('MANIFEST_INVALID', `${Where}.size 非法`)
  return { mediaType: MediaType, digest: Digest, size: Size }
}
