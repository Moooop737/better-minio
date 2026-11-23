/**
 * presign 控制面路由 —— `POST /presign/put` `POST /presign/get`，只有业务后端（service token）能调。
 * 链：serviceGate → rateLimit → zod 校验 → （put 且 KEY_SCHEME=date 加前缀）→ 签发。
 * 响应恒回实际 key；签发事实进日志（服务名 / sub / key / op / ip / jti / exp），绝不记 URL 与 token。
 * 用法：`mountPresign(app, { publicClient, bucket, tokens, serviceGate, keyScheme, rateLimit })`。
 */

export { mountPresign }
export type { PresignDeps }

import type { S3Client } from '@aws-sdk/client-s3'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import type { DataPlaneClaims, TokenService } from '../auth/token'
import type { KeyScheme } from '../config'
import type { AppEnv, RateLimit } from '../core/types'
import { logger } from '../ops/logger'
import { parseJsonBody, presignGetSchema, presignPutSchema } from './schema'
import { applyKeyScheme, signGet, signPut } from './sign'

interface PresignDeps {
  publicClient: S3Client
  bucket: string
  tokens: TokenService
  serviceGate: MiddlewareHandler<AppEnv>
  keyScheme: KeyScheme
  rateLimit: RateLimit | null
  now?: () => Date
}

function mountPresign(App: Hono<AppEnv>, Deps: PresignDeps): void {
  const SignDeps = { publicClient: Deps.publicClient, bucket: Deps.bucket, tokens: Deps.tokens }
  const now = Deps.now ?? (() => new Date())
  const Limit: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (Deps.rateLimit !== null) await Deps.rateLimit(c)
    await next()
  }

  App.post('/presign/put', Deps.serviceGate, Limit, async (c) => {
    const Input = await parseJsonBody(c, presignPutSchema)
    const Key = applyKeyScheme(Deps.keyScheme, Input.key, now())
    c.set('auditKey', Key)
    const Signed = await signPut(SignDeps, { ...Input, key: Key })
    logIssued(c, Signed.claims)
    return c.json({
      url: Signed.url,
      method: Signed.method,
      ...(Signed.contentType !== undefined ? { contentType: Signed.contentType } : {}),
      key: Signed.key,
    })
  })

  App.post('/presign/get', Deps.serviceGate, Limit, async (c) => {
    const Input = await parseJsonBody(c, presignGetSchema)
    c.set('auditKey', Input.key)
    const Signed = await signGet(SignDeps, Input)
    logIssued(c, Signed.claims)
    return c.json({ url: Signed.url, key: Signed.key })
  })
}

function logIssued(c: Context<AppEnv>, Claims: DataPlaneClaims): void {
  const Identity = c.get('identity')
  logger.info(
    {
      event: 'presign',
      service: Identity.kind === 'service' ? Identity.name : Identity.kind,
      sub: Claims.sub,
      op: Claims.op,
      key: Claims.key,
      ip: Claims.ip,
      jti: Claims.jti,
      exp: Claims.exp,
    },
    'presign issued',
  )
}
