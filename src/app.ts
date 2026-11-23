/**
 * 应用组装 —— 按 config 开关挂各 feature 路由（关 = 路由不挂、定时器不起、订阅不接），错误按面分派渲染。
 * 挂载顺序（Hono 首匹配）：request-id → 请求日志 → audit → /health → /token → /presign → /objects → /multipart
 * → /thumbnail → /v2 → S3 catch-all（最后）。index.ts 负责建依赖、启动 server、后台任务与优雅关闭。
 */

export { buildApp, startBackground, errorFace }
export type { AppDeps, Background }

import { Hono } from 'hono'
import type { Context } from 'hono'
import type { S3Client } from '@aws-sdk/client-s3'
import type { Logger } from 'pino'
import type { GatewayConfig } from './config'
import { GatewayError } from './core/errors'
import { renderJsonError } from './core/render'
import type { EventBus } from './core/events'
import type { StateStore } from './core/state'
import type { AppEnv } from './core/types'
import { createDataPlaneGate, createOciGate, createServiceGate } from './auth/gate'
import { mountTokenRoute } from './auth/routes'
import { createServiceTokenVerifier } from './auth/service-token'
import { createTokenService } from './auth/token'
import { mountPresign } from './presign/routes'
import { mountProxyControl, mountProxyData } from './proxy/routes'
import { renderS3Error } from './proxy/s3-error'
import { mountMultipart } from './multipart/routes'
import { startMultipartCleanup } from './multipart/session'
import { mountOci } from './oci/routes'
import { renderDistributionError } from './oci/errors'
import { startOciCleanup } from './oci/gc'
import { mountHealth } from './ops/health'
import { auditMiddleware } from './ops/audit'
import { createRateLimits } from './ops/rate-limit'
import { requestIdMiddleware, requestLogMiddleware } from './ops/request-id'
import { mountThumbnail } from './thumbnail/routes'
import { startThumbnails } from './thumbnail/worker'

interface AppDeps {
  internal: S3Client
  publicClient: S3Client
  stateStore: StateStore
  events: EventBus
  logger: Logger
}

interface Background {
  name: string
  stop(): Promise<void> | void
}

const CONTROL_PREFIXES = ['/health', '/token', '/presign', '/objects', '/multipart', '/thumbnail']

function errorFace(Path: string): 'oci' | 'json' | 's3' {
  if (Path === '/v2' || Path.startsWith('/v2/')) return 'oci'
  if (CONTROL_PREFIXES.some((Prefix) => Path === Prefix || Path.startsWith(`${Prefix}/`))) return 'json'
  return 's3'
}

/* 返回 app 与 close（关闭到 MinIO 的转发连接池，优雅关闭最后调用） */
function buildApp(Config: GatewayConfig, Deps: AppDeps): { app: Hono<AppEnv>; close(): Promise<void> } {
  const App = new Hono<AppEnv>()
  const Tokens = createTokenService(Config.tokenSecret)
  const Verifier = createServiceTokenVerifier(Config.serviceTokens)
  const ServiceGate = createServiceGate(Verifier)
  const Limits = createRateLimits({
    enabled: Config.rateLimitEnabled,
    control: Config.rateLimitControl,
    data: Config.rateLimitData,
    oci: Config.rateLimitOci,
    redis: Deps.stateStore.redis,
  })

  App.onError((Err, c) => renderByFace(c, Err, Deps.logger))
  App.notFound((c) => renderByFace(c, new GatewayError('E_NOT_FOUND', '资源不存在'), Deps.logger))

  App.use('*', requestIdMiddleware())
  App.use('*', requestLogMiddleware(Deps.logger))
  if (Config.auditEnabled) App.use('*', auditMiddleware(Deps.logger, { trustedProxies: Config.trustedProxies }))

  mountHealth(App, { internalClient: Deps.internal, bucket: Config.s3Bucket, stateStore: Deps.stateStore })
  if (Config.ociEnabled) mountTokenRoute(App, { tokens: Tokens, verifier: Verifier, pushServices: Config.ociPushServices })
  mountPresign(App, {
    publicClient: Deps.publicClient,
    bucket: Config.s3Bucket,
    tokens: Tokens,
    serviceGate: ServiceGate,
    keyScheme: Config.keyScheme,
    rateLimit: Limits.control,
  })
  mountProxyControl(App, {
    internal: Deps.internal,
    bucket: Config.s3Bucket,
    serviceGate: ServiceGate,
    events: Deps.events,
    rateLimit: Limits.control,
  })
  if (Config.multipartEnabled) {
    mountMultipart(App, {
      internalClient: Deps.internal,
      publicClient: Deps.publicClient,
      bucket: Config.s3Bucket,
      stateStore: Deps.stateStore,
      tokens: Tokens,
      serviceGate: ServiceGate,
      sessionTtl: Config.multipartSessionTtl,
      keyScheme: Config.keyScheme,
      events: Deps.events,
      rateLimit: Limits.control,
    })
  }
  if (Config.thumbnailEnabled) {
    mountThumbnail(App, {
      internalClient: Deps.internal,
      bucket: Config.s3Bucket,
      serviceGate: ServiceGate,
      rateLimit: Limits.control,
      width: Config.thumbnailWidth,
      format: Config.thumbnailFormat,
      quality: Config.thumbnailQuality,
    })
  }
  if (Config.ociEnabled) {
    mountOci(App, {
      internalClient: Deps.internal,
      registryBucket: Config.s3RegistryBucket,
      stateStore: Deps.stateStore,
      ociGate: createOciGate(Tokens, Config.s3PublicEndpoint),
      uploadTtl: Config.ociUploadTtl,
      rateLimit: Limits.oci,
      publicEndpoint: Config.s3PublicEndpoint,
    })
  }
  const Data = mountProxyData(App, {
    internalEndpoint: Config.s3InternalEndpoint,
    bucket: Config.s3Bucket,
    dataPlaneGate: createDataPlaneGate({
      tokens: Tokens,
      bucket: Config.s3Bucket,
      trustedProxies: Config.trustedProxies,
      ipGateEnabled: Config.ipGateEnabled,
    }),
    corsOrigins: Config.corsOrigins,
    events: Deps.events,
    rateLimit: Limits.data,
  })
  return { app: App, close: () => Data.close() }
}

/* 后台任务：multipart 清理 / oci chunk 清理 / thumbnail worker；开关关闭即不起 */
function startBackground(Config: GatewayConfig, Deps: AppDeps): Background[] {
  const Started: Background[] = []
  if (Config.multipartEnabled) {
    const Cleanup = startMultipartCleanup({ internalClient: Deps.internal, bucket: Config.s3Bucket, stateStore: Deps.stateStore })
    Started.push({ name: 'multipart-cleanup', stop: () => Cleanup.stop() })
  }
  if (Config.ociEnabled) {
    const Cleanup = startOciCleanup({
      internalClient: Deps.internal,
      registryBucket: Config.s3RegistryBucket,
      stateStore: Deps.stateStore,
      uploadTtl: Config.ociUploadTtl,
    })
    Started.push({ name: 'oci-cleanup', stop: () => Cleanup.stop() })
  }
  if (Config.thumbnailEnabled) {
    const Worker = startThumbnails({
      internalClient: Deps.internal,
      bucket: Config.s3Bucket,
      stateStore: Deps.stateStore,
      events: Deps.events,
      width: Config.thumbnailWidth,
      format: Config.thumbnailFormat,
      quality: Config.thumbnailQuality,
      logger: Deps.logger,
    })
    Started.push({ name: 'thumbnail-worker', stop: () => Worker.stop() })
  }
  return Started
}

function renderByFace(c: Context<AppEnv>, Err: unknown, Log: Logger): Response {
  if (!(Err instanceof GatewayError)) Log.error({ err: describeError(Err) }, 'unhandled error')
  const Face = errorFace(c.req.path)
  if (Face === 'oci') return renderDistributionError(c, Err)
  if (Face === 'json') return renderJsonError(c, Err)
  return renderS3Error(c, Err)
}

/* 内部诊断：只记类型与 message，不记 stack 里可能的 URL */
function describeError(Err: unknown): Record<string, unknown> {
  if (Err instanceof Error) return { name: Err.name, message: Err.message }
  return { message: String(Err) }
}
