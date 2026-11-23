/**
 * OCI Distribution `/v2/*` 路由 —— mountOci(app, deps)；OCI_ENABLED=false 时 index 不调用（路由不挂）。
 * name 可含 `/`，故不用 Hono 路由参数：自行从 path 解析 `/v2/<name>/(manifests|blobs|tags)/…`（取最后一次出现）。
 * 每个端点：ociGate.authorize(c, name, pull|push)（GET /v2/ 与未知端点 name=null、action=null）→ rateLimit → 业务。
 *   GET/HEAD = pull；PUT/PATCH/POST/DELETE = push（上传会话状态 GET 也按 push，与 distribution 实现一致）。
 * 所有响应带 `Docker-Distribution-API-Version: registry/2.0`；错误由 app.onError 交给 renderDistributionError。
 * Location：配置了 publicEndpoint 则回绝对 URL，否则回相对路径（spec 两者均允许）。
 */

export { mountOci, parseOciPath }
export type { OciDeps, OciRoute }

import { Readable } from 'node:stream'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'
import type { S3Client } from '@aws-sdk/client-s3'
import type { Context, Hono } from 'hono'
import { isRepositoryName } from '../auth/scope'
import type { OciGate } from '../auth/gate'
import type { StateStore } from '../core/state'
import type { AppEnv, RateLimit } from '../core/types'
import { openBlob, statBlob, unlinkBlob } from './blob'
import { createOciContext } from './context'
import type { OciContext } from './context'
import { API_VERSION, API_VERSION_HEADER, ociError } from './errors'
import { deleteManifest, getManifest, listTags, putManifest, readManifestBody } from './manifest'
import { appendChunk, cancelUpload, finishUpload, startUpload, uploadStatus } from './upload'

interface OciDeps {
  internalClient: S3Client
  registryBucket: string
  stateStore: StateStore
  ociGate: OciGate
  /* 秒（OCI_UPLOAD_TTL） */
  uploadTtl: number
  rateLimit: RateLimit | null
  publicEndpoint?: string
}

type OciRoute =
  | { kind: 'base' }
  | { kind: 'manifest'; name: string; ref: string }
  | { kind: 'blob'; name: string; digest: string }
  | { kind: 'upload-start'; name: string }
  | { kind: 'upload'; name: string; uuid: string }
  | { kind: 'tags'; name: string }
  | { kind: 'unknown' }

type C = Context<AppEnv>

function mountOci(App: Hono<AppEnv>, Deps: OciDeps): void {
  const Ctx = createOciContext({ client: Deps.internalClient, bucket: Deps.registryBucket, store: Deps.stateStore, uploadTtl: Deps.uploadTtl })
  const Base = Deps.publicEndpoint?.replace(/\/+$/, '') ?? ''
  const location = (Path: string): string => `${Base}${Path}`

  const handler = async (c: C): Promise<Response> => {
    c.header(API_VERSION_HEADER, API_VERSION)
    const Route = parseOciPath(c.req.path)
    const Method = c.req.method
    const Action = Method === 'GET' || Method === 'HEAD' ? 'pull' : 'push'

    if (Route.kind === 'base' || Route.kind === 'unknown') {
      await Deps.ociGate.authorize(c, null, null)
      await Deps.rateLimit?.(c)
      if (Route.kind === 'unknown') throw ociError('UNSUPPORTED', '端点不存在', { status: 404 })
      if (Action !== 'pull') throw methodNotAllowed()
      return c.json({})
    }
    if (!isRepositoryName(Route.name)) {
      await Deps.ociGate.authorize(c, null, null)
      throw ociError('NAME_INVALID', 'repository 名称非法')
    }
    await Deps.ociGate.authorize(c, Route.name, Route.kind === 'upload' ? 'push' : Action)
    await Deps.rateLimit?.(c)

    switch (Route.kind) {
      case 'manifest':
        return manifestRoute(c, Ctx, Route.name, Route.ref, location)
      case 'blob':
        return blobRoute(c, Ctx, Route.name, Route.digest)
      case 'upload-start':
        return uploadStartRoute(c, Ctx, Route.name, location)
      case 'upload':
        return uploadRoute(c, Ctx, Route.name, Route.uuid, location)
      case 'tags':
        return tagsRoute(c, Ctx, Route.name)
    }
  }

  App.all('/v2', handler)
  App.all('/v2/*', handler)
}

async function manifestRoute(c: C, Ctx: OciContext, Name: string, Ref: string, location: (Path: string) => string): Promise<Response> {
  switch (c.req.method) {
    case 'GET':
    case 'HEAD': {
      const Head = c.req.method === 'HEAD'
      const Record_ = await getManifest(Ctx, Name, Ref, !Head)
      const Headers = {
        'Content-Type': Record_.mediaType,
        'Content-Length': String(Record_.size),
        'Docker-Content-Digest': Record_.digest,
      }
      if (Head || Record_.body === null) return c.body(null, 200, Headers)
      c.set('bytesDown', Record_.size)
      return c.body(new Uint8Array(Record_.body), 200, Headers)
    }
    case 'PUT': {
      const Body = await readManifestBody(c.req.raw.body, c.req.header('content-length'))
      c.set('bytesUp', Body.byteLength)
      const { digest } = await putManifest(Ctx, Name, Ref, Body, c.req.header('content-type'))
      return c.body(null, 201, { Location: location(`/v2/${Name}/manifests/${digest}`), 'Docker-Content-Digest': digest })
    }
    case 'DELETE':
      await deleteManifest(Ctx, Name, Ref)
      return c.body(null, 202)
    default:
      throw methodNotAllowed()
  }
}

async function blobRoute(c: C, Ctx: OciContext, Name: string, Digest: string): Promise<Response> {
  switch (c.req.method) {
    case 'HEAD': {
      const Stat = await statBlob(Ctx, Name, Digest)
      return c.body(null, 200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(Stat.size),
        'Docker-Content-Digest': Stat.digest,
        'Accept-Ranges': 'bytes',
      })
    }
    case 'GET': {
      const Blob = await openBlob(Ctx, Name, Digest, c.req.header('range'))
      const Headers: Record<string, string> = {
        'Content-Type': 'application/octet-stream',
        'Docker-Content-Digest': Blob.digest,
        'Accept-Ranges': 'bytes',
      }
      if (Blob.contentLength !== null) {
        Headers['Content-Length'] = String(Blob.contentLength)
        c.set('bytesDown', Blob.contentLength)
      }
      if (Blob.partial && Blob.contentRange !== null) Headers['Content-Range'] = Blob.contentRange
      const Stream = Readable.toWeb(Blob.body) as unknown as ReadableStream<Uint8Array>
      return c.body(Stream, Blob.partial ? 206 : 200, Headers)
    }
    case 'DELETE':
      await unlinkBlob(Ctx, Name, Digest)
      return c.body(null, 202)
    default:
      throw methodNotAllowed()
  }
}

async function uploadStartRoute(c: C, Ctx: OciContext, Name: string, location: (Path: string) => string): Promise<Response> {
  if (c.req.method !== 'POST') throw methodNotAllowed()
  const { uuid } = await startUpload(Ctx, Name)
  const Digest = c.req.query('digest')
  /* 单请求 monolithic：POST ?digest= 带全量 body → 直接收尾 201 */
  if (Digest !== undefined) {
    const Done = await finishUpload(Ctx, Name, uuid, Digest, bodyOf(c))
    c.set('bytesUp', Done.written)
    return c.body(null, 201, { Location: location(`/v2/${Name}/blobs/${Done.digest}`), 'Docker-Content-Digest': Done.digest })
  }
  return c.body(null, 202, {
    Location: location(`/v2/${Name}/blobs/uploads/${uuid}`),
    Range: '0-0',
    'Docker-Upload-UUID': uuid,
  })
}

async function uploadRoute(c: C, Ctx: OciContext, Name: string, Uuid: string, location: (Path: string) => string): Promise<Response> {
  const Progress = (Size: number): Record<string, string> => ({
    Location: location(`/v2/${Name}/blobs/uploads/${Uuid}`),
    Range: `0-${Math.max(Size - 1, 0)}`,
    'Docker-Upload-UUID': Uuid,
  })
  switch (c.req.method) {
    case 'GET': {
      const Session = await uploadStatus(Ctx, Name, Uuid)
      return c.body(null, 204, Progress(Session.size))
    }
    case 'PATCH': {
      const Body = bodyOf(c) ?? emptyBody()
      const { session, written } = await appendChunk(Ctx, Name, Uuid, Body, c.req.header('content-range'))
      c.set('bytesUp', written)
      return c.body(null, 202, Progress(session.size))
    }
    case 'PUT': {
      const Done = await finishUpload(Ctx, Name, Uuid, c.req.query('digest'), bodyOf(c))
      c.set('bytesUp', Done.written)
      return c.body(null, 201, { Location: location(`/v2/${Name}/blobs/${Done.digest}`), 'Docker-Content-Digest': Done.digest })
    }
    case 'DELETE':
      await cancelUpload(Ctx, Name, Uuid)
      return c.body(null, 204)
    default:
      throw methodNotAllowed()
  }
}

async function tagsRoute(c: C, Ctx: OciContext, Name: string): Promise<Response> {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') throw methodNotAllowed()
  const RawN = c.req.query('n')
  const N = RawN === undefined ? null : Number(RawN)
  if (N !== null && (!Number.isSafeInteger(N) || N < 0)) throw ociError('UNSUPPORTED', 'n 参数非法', { status: 400 })
  const Page = await listTags(Ctx, Name, N, c.req.query('last') ?? null)
  if (Page.next !== null) {
    c.header('Link', `</v2/${Name}/tags/list?n=${N}&last=${encodeURIComponent(Page.next)}>; rel="next"`)
  }
  return c.json({ name: Name, tags: Page.tags })
}

/* 从 path 解析路由；name 取到最后一个关键段之前（name 自身可含 /） */
function parseOciPath(Path: string): OciRoute {
  if (Path === '/v2' || Path === '/v2/') return { kind: 'base' }
  if (!Path.startsWith('/v2/')) return { kind: 'unknown' }
  const Tail = Path.slice('/v2/'.length)
  let Match: RegExpExecArray | null
  if ((Match = /^(.+)\/tags\/list$/.exec(Tail)) && Match[1] !== undefined) return { kind: 'tags', name: Match[1] }
  if ((Match = /^(.+)\/manifests\/([^/]+)$/.exec(Tail)) && Match[1] !== undefined && Match[2] !== undefined) {
    return { kind: 'manifest', name: Match[1], ref: decodeSegment(Match[2]) }
  }
  if ((Match = /^(.+)\/blobs\/uploads\/?$/.exec(Tail)) && Match[1] !== undefined) return { kind: 'upload-start', name: Match[1] }
  if ((Match = /^(.+)\/blobs\/uploads\/([^/]+)$/.exec(Tail)) && Match[1] !== undefined && Match[2] !== undefined) {
    return { kind: 'upload', name: Match[1], uuid: decodeSegment(Match[2]) }
  }
  if ((Match = /^(.+)\/blobs\/([^/]+)$/.exec(Tail)) && Match[1] !== undefined && Match[2] !== undefined) {
    return { kind: 'blob', name: Match[1], digest: decodeSegment(Match[2]) }
  }
  return { kind: 'unknown' }
}

function decodeSegment(Raw: string): string {
  try {
    return decodeURIComponent(Raw)
  } catch {
    return Raw
  }
}

/* 请求体 → Node 流式迭代（不缓冲）；无 body 为 null */
function bodyOf(c: C): AsyncIterable<Uint8Array> | null {
  const Body = c.req.raw.body
  return Body === null ? null : Readable.fromWeb(Body as unknown as NodeWebReadableStream<Uint8Array>)
}

async function* emptyBody(): AsyncGenerator<Uint8Array> {}

function methodNotAllowed(): Error {
  return ociError('UNSUPPORTED', '方法不支持', { status: 405 })
}
