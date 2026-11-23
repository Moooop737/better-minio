/**
 * multipart 控制面 —— mountMultipart(app, deps) 挂五个 POST（全部 service token）：
 *   /multipart/create      CreateMultipartUpload → 存会话头 → {uploadId, key, partSize, expiresAt}
 *   /multipart/sign-part   会话绑定铸新 token + presign UploadPart → {url, partNumber, expiresIn}
 *   /multipart/list-parts  ListParts 真源（断点续传入口）
 *   /multipart/complete    对账：尺寸违规 400 / 缺片或 ETag 不符 200 incomplete + 重签 / 全符 complete + 删会话 + emit object:complete
 *   /multipart/abort       AbortMultipartUpload + 删会话，204 幂等
 * 每个端点：serviceGate → rateLimit（可选）→ zod 校验 → 工作。MinIO 失败 → 502 E_UPSTREAM（通用文案）。
 * 时间：会话 createdAt/expiresAt = epoch 秒；now 可注入（测试）。
 */

export { mountMultipart, MIN_PART_SIZE, MAX_PART_SIZE }
export type { MultipartDeps }

import type { S3Client } from '@aws-sdk/client-s3'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import { z } from 'zod'
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  listParts,
} from '../api/multipart'
import type { MultipartPart } from '../api/multipart'
import type { TokenService } from '../auth/token'
import { GatewayError } from '../core/errors'
import type { EventBus } from '../core/events'
import type { StateStore } from '../core/state'
import type { AppEnv, RateLimit } from '../core/types'
import { clientIpSchema, expiresInSchema, formatIssues, keySchema } from '../presign/schema'
import { applyKeyScheme } from '../presign/sign'
import { reconcile } from './reconcile'
import { deleteSession, loadSession, saveSession } from './session'
import type { MultipartSession } from './session'
import { DEFAULT_PART_EXPIRES_IN, signPart } from './sign'

interface MultipartDeps {
  internalClient: S3Client
  publicClient: S3Client
  bucket: string
  stateStore: StateStore
  tokens: TokenService
  serviceGate: MiddlewareHandler<AppEnv>
  /* 会话 TTL（秒），MULTIPART_SESSION_TTL */
  sessionTtl: number
  keyScheme: 'flat' | 'date'
  events: EventBus
  rateLimit: RateLimit | null
  now?: () => number
}

const MIN_PART_SIZE = 5 * 1024 * 1024
const MAX_PART_SIZE = 5 * 1024 * 1024 * 1024
const MAX_PART_NUMBER = 10000

const UploadIdSchema = z.string().min(1).max(1024)
const PartNumberSchema = z.number().int().min(1).max(MAX_PART_NUMBER)

const CreateSchema = z.object({
  key: keySchema,
  sub: z.string().min(1).max(256),
  client_ip: clientIpSchema,
  partSize: z.number().int().min(MIN_PART_SIZE).max(MAX_PART_SIZE),
  resource_id: z.string().max(256).optional(),
  contentType: z.string().min(1).max(256).optional(),
})

const SignPartSchema = z.object({
  uploadId: UploadIdSchema,
  partNumber: PartNumberSchema,
  expiresIn: expiresInSchema.optional(),
})

const UploadIdBodySchema = z.object({ uploadId: UploadIdSchema })

const CompleteSchema = z.object({
  uploadId: UploadIdSchema,
  parts: z
    .array(z.object({ partNumber: PartNumberSchema, etag: z.string().min(1).max(256) }))
    .min(1)
    .max(MAX_PART_NUMBER)
    .refine((Parts) => new Set(Parts.map((Part) => Part.partNumber)).size === Parts.length, 'partNumber 不得重复'),
})

function mountMultipart(app: Hono<AppEnv>, Deps: MultipartDeps): void {
  const Now = Deps.now ?? Date.now
  const Signer = { publicClient: Deps.publicClient, bucket: Deps.bucket, tokens: Deps.tokens }
  const Gate = Deps.serviceGate
  const Limit = Deps.rateLimit
  /* 限流在闸之后（identity 已挂）；RATE_LIMIT_ENABLED=false 时 rateLimit 为 null，直接放行 */
  const Limiter: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (Limit !== null) await Limit(c)
    await next()
  }

  const requireSession = async (c: Context<AppEnv>, UploadId: string): Promise<MultipartSession> => {
    const Session = await loadSession(Deps.stateStore, UploadId, Now())
    if (Session === null) throw new GatewayError('E_SESSION_NOT_FOUND', '分片会话不存在或已过期')
    c.set('auditKey', Session.key)
    return Session
  }

  app.post('/multipart/create', Gate, Limiter, async (c) => {
    const Body = await parseBody(c, CreateSchema)
    const Key = applyKeyScheme(Deps.keyScheme, Body.key, new Date(Now()))
    c.set('auditKey', Key)
    const UploadId = await upstream(() =>
      createMultipartUpload(Deps.internalClient, Deps.bucket, Key, Body.contentType !== undefined ? { contentType: Body.contentType } : {}),
    )
    const CreatedAt = Math.floor(Now() / 1000)
    const Session: MultipartSession = {
      uploadId: UploadId,
      key: Key,
      partSize: Body.partSize,
      contentType: Body.contentType ?? null,
      sub: Body.sub,
      clientIp: Body.client_ip,
      resourceId: Body.resource_id ?? null,
      createdAt: CreatedAt,
      expiresAt: CreatedAt + Deps.sessionTtl,
    }
    await saveSession(Deps.stateStore, Session, Deps.sessionTtl)
    return c.json({ uploadId: UploadId, key: Key, partSize: Session.partSize, expiresAt: Session.expiresAt })
  })

  app.post('/multipart/sign-part', Gate, Limiter, async (c) => {
    const Body = await parseBody(c, SignPartSchema)
    const Session = await requireSession(c, Body.uploadId)
    return c.json(await signPart(Signer, Session, Body.partNumber, Body.expiresIn ?? DEFAULT_PART_EXPIRES_IN))
  })

  app.post('/multipart/list-parts', Gate, Limiter, async (c) => {
    const Body = await parseBody(c, UploadIdBodySchema)
    const Session = await requireSession(c, Body.uploadId)
    const Parts = await fetchParts(Session)
    return c.json({ uploadId: Session.uploadId, key: Session.key, expiresAt: Session.expiresAt, parts: Parts })
  })

  app.post('/multipart/complete', Gate, Limiter, async (c) => {
    const Body = await parseBody(c, CompleteSchema)
    const Session = await requireSession(c, Body.uploadId)
    const Actual = await fetchParts(Session)
    const Result = reconcile(Session, Body.parts, Actual)
    if (Result.kind === 'size_mismatch') {
      throw new GatewayError('E_PART_SIZE_MISMATCH', '分片尺寸与会话分法不符', { partNumbers: Result.partNumbers })
    }
    if (Result.kind === 'incomplete') {
      const Missing = await Promise.all(
        Result.missing.map(async (Item) => {
          const Signed = await signPart(Signer, Session, Item.partNumber, DEFAULT_PART_EXPIRES_IN)
          return { partNumber: Item.partNumber, reason: Item.reason, url: Signed.url, expiresIn: Signed.expiresIn }
        }),
      )
      return c.json({ status: 'incomplete', missing: Missing })
    }
    const Done = await upstream(() =>
      completeMultipartUpload(Deps.internalClient, Deps.bucket, Session.key, Session.uploadId, Result.parts),
    )
    await deleteSession(Deps.stateStore, Session.uploadId)
    if (Done === null) throw new GatewayError('E_SESSION_NOT_FOUND', '分片会话不存在或已过期')
    Deps.events.emit('object:complete', { key: Session.key, contentType: Session.contentType })
    return c.json({ status: 'complete', etag: Done.etag, key: Session.key })
  })

  app.post('/multipart/abort', Gate, Limiter, async (c) => {
    const Body = await parseBody(c, UploadIdBodySchema)
    const Session = await loadSession(Deps.stateStore, Body.uploadId, Now())
    if (Session !== null) {
      c.set('auditKey', Session.key)
      await upstream(() => abortMultipartUpload(Deps.internalClient, Deps.bucket, Session.key, Session.uploadId))
      await deleteSession(Deps.stateStore, Session.uploadId)
    }
    return c.body(null, 204)
  })

  /* ListParts 真源；MinIO 已不认该 upload → 会话作废 404 */
  async function fetchParts(Session: MultipartSession): Promise<MultipartPart[]> {
    const Parts = await upstream(() => listParts(Deps.internalClient, Deps.bucket, Session.key, Session.uploadId))
    if (Parts === null) {
      await deleteSession(Deps.stateStore, Session.uploadId)
      throw new GatewayError('E_SESSION_NOT_FOUND', '分片会话不存在或已过期')
    }
    return Parts
  }
}

async function parseBody<T extends z.ZodType>(c: Context<AppEnv>, Schema: T): Promise<z.output<T>> {
  let Raw: unknown
  try {
    Raw = await c.req.json()
  } catch {
    throw new GatewayError('E_VALIDATION', '请求体不是合法 JSON')
  }
  const Parsed = Schema.safeParse(Raw)
  if (!Parsed.success) throw new GatewayError('E_VALIDATION', '请求参数不合法', { issues: formatIssues(Parsed.error) })
  return Parsed.data
}

/* MinIO 调用失败统一 502，message 通用（不泄地址 / bucket / key） */
async function upstream<T>(Run: () => Promise<T>): Promise<T> {
  try {
    return await Run()
  } catch (err) {
    if (err instanceof GatewayError) throw err
    throw new GatewayError('E_UPSTREAM', '存储后端暂不可用')
  }
}
