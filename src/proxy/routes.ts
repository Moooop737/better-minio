/**
 * proxy 挂载 —— 控制端点与 S3 数据面分两次挂（数据面 catch-all 必须最后挂）。
 *   mountProxyControl：POST /objects/stat、/objects/delete；链 serviceGate → rateLimit → handler。
 *   mountProxyData：`/:bucket/*`（含 `/:bucket`）；链 CORS → 预检查（方法 405 / 桶 404，闸前）→ dataPlaneGate → rateLimit → 透明转发。
 * 字节数随流实时 c.set('bytesUp' / 'bytesDown')，ops 审计在 outgoing 'close' 读取；非分片 PUT 成功 emit object:put。
 * 用法：`mountProxyControl(app, deps)`；`const Data = mountProxyData(app, deps)`，优雅关闭最后 `await Data.close()`。
 */

export { mountProxyControl, mountProxyData, DATA_PLANE_METHODS }
export type { ProxyControlDeps, ProxyDataDeps, ProxyDataHandle }

import type { S3Client } from '@aws-sdk/client-s3'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import { Transform } from 'node:stream'
import type { Readable } from 'node:stream'
import { GatewayError } from '../core/errors'
import type { EventBus } from '../core/events'
import type { AppEnv, RateLimit } from '../core/types'
import { dataPlaneCors } from './cors'
import { createForwarder } from './forward'
import type { Forwarder } from './forward'
import { createObjectHandlers } from './objects'
import { s3ErrorResponse } from './s3-error'

const DATA_PLANE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'PUT'])
const ALLOW_HEADER = 'GET, HEAD, PUT, OPTIONS'

interface ProxyControlDeps {
  internal: S3Client
  bucket: string
  serviceGate: MiddlewareHandler<AppEnv>
  events: EventBus
  rateLimit: RateLimit | null
}

interface ProxyDataDeps {
  internalEndpoint: string
  bucket: string
  dataPlaneGate: MiddlewareHandler<AppEnv>
  corsOrigins: string[]
  events: EventBus
  rateLimit: RateLimit | null
}

interface ProxyDataHandle {
  /* 关闭上游连接池（优雅关闭 drain 完在途请求之后调用） */
  close(): Promise<void>
}

function mountProxyControl(App: Hono<AppEnv>, Deps: ProxyControlDeps): void {
  const Handlers = createObjectHandlers({ internal: Deps.internal, bucket: Deps.bucket, events: Deps.events })
  const Limit = rateLimitMiddleware(Deps.rateLimit)
  App.post('/objects/stat', Deps.serviceGate, Limit, Handlers.stat)
  App.post('/objects/delete', Deps.serviceGate, Limit, Handlers.remove)
}

function mountProxyData(App: Hono<AppEnv>, Deps: ProxyDataDeps): ProxyDataHandle {
  const Upstream = createForwarder({ endpoint: Deps.internalEndpoint })
  const Precheck: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (!DATA_PLANE_METHODS.has(c.req.method)) {
      c.header('Allow', ALLOW_HEADER)
      return s3ErrorResponse(c, 405, 'MethodNotAllowed', 'The specified method is not allowed against this resource.')
    }
    const Target = splitTarget(rawTarget(c))
    if (Target.bucket !== Deps.bucket) {
      return s3ErrorResponse(c, 404, 'NoSuchBucket', 'The specified bucket does not exist.')
    }
    if (!Target.hasKey) return s3ErrorResponse(c, 404, 'NoSuchKey', 'The specified key does not exist.')
    await next()
  }
  App.all(
    '/:bucket/*',
    dataPlaneCors(Deps.corsOrigins),
    Precheck,
    Deps.dataPlaneGate,
    rateLimitMiddleware(Deps.rateLimit),
    (c) => forward(c, Upstream, Deps.events),
  )
  return {
    async close() {
      await Upstream.close()
    },
  }
}

/* 透明转发主体：上行计数 Transform → undici → 下行 pull 式 ReadableStream（背压、cancel 销毁上游） */
async function forward(c: Context<AppEnv>, Upstream: Forwarder, Events: EventBus): Promise<Response> {
  const Incoming = c.env?.incoming
  const Outgoing = c.env?.outgoing
  if (Incoming === undefined || Outgoing === undefined) throw new GatewayError('E_INTERNAL', '数据面需要 Node 运行时')
  const Method = c.req.method
  const Abort = new AbortController()
  const onClose = (): void => {
    if (!Outgoing.writableFinished) Abort.abort()
  }
  Outgoing.once('close', onClose)

  let Up = 0
  let Down = 0
  c.set('bytesUp', 0)
  c.set('bytesDown', 0)
  let Body: Readable | null = null
  if (Method === 'PUT') {
    const Counter = new Transform({
      transform(Chunk: Buffer, _Encoding, Done) {
        Up += Chunk.length
        c.set('bytesUp', Up)
        Done(null, Chunk)
      },
    })
    Incoming.once('error', (Err) => Counter.destroy(Err))
    Incoming.once('close', () => {
      if (!Incoming.complete) Counter.destroy(new Error('client aborted'))
    })
    Body = Incoming.pipe(Counter)
  }

  let Res
  try {
    Res = await Upstream.forward({ rawTarget: rawTarget(c), method: Method, headers: Incoming.headers, body: Body, signal: Abort.signal })
  } catch (err) {
    Outgoing.off('close', onClose)
    Body?.destroy()
    throw err
  }

  if (Method === 'PUT' && Res.status >= 200 && Res.status < 300 && !isPartUpload(rawTarget(c))) {
    const Identity = c.get('identity')
    if (Identity.kind === 'browser') {
      Events.emit('object:put', { key: Identity.key, contentType: c.req.header('content-type') ?? null, size: Up })
    }
  }

  const Headers = new globalThis.Headers()
  for (const [Name, Value] of Res.headers) Headers.append(Name, Value)
  if (Method === 'HEAD' || Res.status === 204 || Res.status === 304) {
    Res.body.resume()
    return new Response(null, { status: Res.status, headers: Headers })
  }
  const Source = Res.body
  const Iterator = Source[Symbol.asyncIterator]() as AsyncIterator<Buffer>
  const Stream = new ReadableStream<Uint8Array>(
    {
      async pull(Controller) {
        try {
          const Next = await Iterator.next()
          if (Next.done === true) {
            Controller.close()
            return
          }
          Down += Next.value.length
          c.set('bytesDown', Down)
          Controller.enqueue(Next.value)
        } catch (err) {
          Controller.error(err)
        }
      },
      cancel() {
        Source.destroy()
      },
    },
    { highWaterMark: 0 },
  )
  return new Response(Stream, { status: Res.status, headers: Headers })
}

function rateLimitMiddleware(Limit: RateLimit | null): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (Limit !== null) await Limit(c)
    await next()
  }
}

/* 原始请求行（Node bindings）；非 Node 运行时退回 URL（只用于桶判定，转发处另有守卫） */
function rawTarget(c: Context<AppEnv>): string {
  const Raw = c.env?.incoming?.url
  if (Raw !== undefined) return Raw
  const Url = new URL(c.req.url)
  return Url.pathname + Url.search
}

function splitTarget(Raw: string): { bucket: string | null; hasKey: boolean } {
  const Query = Raw.indexOf('?')
  const Path = Query === -1 ? Raw : Raw.slice(0, Query)
  const Match = /^\/([^/]+)(?:\/(.*))?$/.exec(Path)
  if (Match?.[1] === undefined) return { bucket: null, hasKey: false }
  let Bucket: string
  try {
    Bucket = decodeURIComponent(Match[1])
  } catch {
    return { bucket: null, hasKey: false }
  }
  return { bucket: Bucket, hasKey: Match[2] !== undefined && Match[2] !== '' }
}

/* 分片 PUT（UploadPart）不是对象落成，不发 object:put */
function isPartUpload(Raw: string): boolean {
  const Query = Raw.indexOf('?')
  if (Query === -1) return false
  const Params = new URLSearchParams(Raw.slice(Query + 1))
  return Params.has('partNumber') || Params.has('uploadId')
}
