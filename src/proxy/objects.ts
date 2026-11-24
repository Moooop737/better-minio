/**
 * 服务端控制端点 handler —— `POST /objects/{stat,delete,get,put}`（service token 已由路由链校验）。
 * 网关持 MinIO 凭证经 api 层执行；key 校验与 presign 同口径（keySchema）。
 * stat 不存在 → 404 E_NOT_FOUND；delete 幂等恒 204，成功 emit object:delete。
 * get 流式回 body（Range → 206 + content-range）；put 的 key 走 query（可含中文/空格，header 装不了非 ASCII），body 为原始流；
 * 条件写冲突 → 412 E_PRECONDITION_FAILED。api 失败（非 412）→ 502 E_UPSTREAM（通用文案）。
 */

export { createObjectHandlers, objectKeyBodySchema, objectGetBodySchema }
export type { ObjectHandlerDeps }

import type { S3Client } from '@aws-sdk/client-s3'
import type { Handler } from 'hono'
import { Readable } from 'node:stream'
import { z } from 'zod'
import { deleteObject, getObject, putObject, statObject } from '../api/objects'
import type { ObjectBody, ObjectPutOptions, ObjectStat } from '../api/object-store'
import { ObjectStoreError } from '../api/object-store'
import { GatewayError } from '../core/errors'
import type { EventBus } from '../core/events'
import type { AppEnv } from '../core/types'
import { logger } from '../ops/logger'
import { formatIssues, keySchema, parseJsonBody } from '../presign/schema'

const OBJECT_KEY_PARAM = 'key'
const DEFAULT_CONTENT_TYPE = 'application/octet-stream'

interface ObjectHandlerDeps {
  internal: S3Client
  bucket: string
  events: EventBus
}

const objectKeyBodySchema = z.object({ key: keySchema })
const objectGetBodySchema = z.object({ key: keySchema, range: z.string().min(1).max(128).optional() })

function createObjectHandlers(Deps: ObjectHandlerDeps): {
  stat: Handler<AppEnv>
  remove: Handler<AppEnv>
  get: Handler<AppEnv>
  put: Handler<AppEnv>
} {
  return {
    async stat(c) {
      const { key } = await parseJsonBody(c, objectKeyBodySchema)
      c.set('auditKey', key)
      const Stat = await upstream<ObjectStat | null>('stat', () => statObject(Deps.internal, Deps.bucket, key))
      if (Stat === null) throw new GatewayError('E_NOT_FOUND', '对象不存在')
      return c.json({ size: Stat.size, contentType: Stat.contentType, etag: Stat.etag })
    },
    async remove(c) {
      const { key } = await parseJsonBody(c, objectKeyBodySchema)
      c.set('auditKey', key)
      await upstream('delete', () => deleteObject(Deps.internal, Deps.bucket, key))
      Deps.events.emit('object:delete', { key })
      return c.body(null, 204)
    },
    async get(c) {
      const { key, range } = await parseJsonBody(c, objectGetBodySchema)
      c.set('auditKey', key)
      const Found = await upstream<ObjectBody | null>('get', () =>
        getObject(Deps.internal, Deps.bucket, key, range === undefined ? undefined : { range }),
      )
      if (Found === null) throw new GatewayError('E_NOT_FOUND', '对象不存在')
      const Headers = new globalThis.Headers()
      if (Found.contentType !== null) Headers.set('content-type', Found.contentType)
      if (Found.contentLength !== null) Headers.set('content-length', String(Found.contentLength))
      if (Found.etag !== null) Headers.set('etag', Found.etag)
      if (Found.contentRange !== null) Headers.set('content-range', Found.contentRange)
      const Status = Found.contentRange === null ? 200 : 206
      return new Response(Readable.toWeb(Found.body) as ReadableStream<Uint8Array>, { status: Status, headers: Headers })
    },
    async put(c) {
      const Key = parseObjectKey(c.req.query(OBJECT_KEY_PARAM))
      c.set('auditKey', Key)
      const Incoming = c.env?.incoming
      if (Incoming === undefined) throw new GatewayError('E_INTERNAL', '控制端点需要 Node 运行时')
      const Options: ObjectPutOptions = {}
      const IfNoneMatch = c.req.header('if-none-match')
      if (IfNoneMatch !== undefined) Options.ifNoneMatch = IfNoneMatch
      const ContentLength = parseContentLength(c.req.header('content-length'))
      if (ContentLength !== null) Options.contentLength = ContentLength
      const ContentType = c.req.header('content-type') ?? DEFAULT_CONTENT_TYPE
      await upstream('put', () => putObject(Deps.internal, Deps.bucket, Key, Incoming, ContentType, Options))
      return c.body(null, 204)
    },
  }
}

/* 控制端点 put 的 key 走 query（percent-encoded 能承载中文/空格；HTTP header 值只收 ASCII）：
   缺失 / 非法都按 400 处理，issues 只给规则文案 */
function parseObjectKey(Raw: string | undefined): string {
  if (Raw === undefined) throw new GatewayError('E_VALIDATION', '请求参数不合法', { issues: [{ path: OBJECT_KEY_PARAM, message: '缺少 key 查询参数' }] })
  const Parsed = keySchema.safeParse(Raw)
  if (!Parsed.success) throw new GatewayError('E_VALIDATION', '请求参数不合法', { issues: formatIssues(Parsed.error) })
  return Parsed.data
}

function parseContentLength(Raw: string | undefined): number | null {
  if (Raw === undefined) return null
  if (!/^\d+$/.test(Raw)) throw new GatewayError('E_VALIDATION', 'content-length 不合法')
  const Value = Number(Raw)
  if (!Number.isSafeInteger(Value)) throw new GatewayError('E_VALIDATION', 'content-length 不合法')
  return Value
}

/* ObjectStoreError 的 detail 可能含 endpoint：对外只给通用 502，日志只记操作名；412 单独呈现为条件写失败 */
async function upstream<T>(Op: string, Fn: () => Promise<T>): Promise<T> {
  try {
    return await Fn()
  } catch (Err) {
    logger.warn({ event: 'upstream_error', op: Op }, 'object store operation failed')
    if (Err instanceof ObjectStoreError && Err.status === 412) {
      throw new GatewayError('E_PRECONDITION_FAILED', '对象已存在')
    }
    throw new GatewayError('E_UPSTREAM', '上游存储不可用')
  }
}