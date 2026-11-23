/**
 * 按面限流 —— rate-limiter-flexible；窗口固定 60s，配额按面（RATE_LIMIT_CONTROL / DATA / OCI）。
 *   redis 给了 → RateLimiterRedis（重启计数不丢；rejectIfRedisNotReady + insuranceLimiter 内存降级，断连不变单点故障）；否则 RateLimiterMemory。
 *   key = 面前缀 + 身份：service name（svc:）/ 浏览器 token.sub（sub:）/ registry bearer sub（reg:）。
 * 各面在闸之后调用返回的 RateLimit（先认身份，未认证由闸 401，不消耗合法配额）；超额抛 E_RATE_LIMIT（extra.retryAfter 秒）。
 * RATE_LIMIT_ENABLED=false → 三面全 null（middleware 不装）。
 */

export { createRateLimits, RATE_LIMIT_WINDOW_SECONDS }
export type { RateLimitOptions, RateLimits }

import type { Redis } from 'ioredis'
import { RateLimiterMemory, RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible'
import type { RateLimiterAbstract } from 'rate-limiter-flexible'
import type { Context } from 'hono'
import { GatewayError } from '../core/errors'
import type { AppEnv, Identity, RateLimit } from '../core/types'

const RATE_LIMIT_WINDOW_SECONDS = 60

interface RateLimitOptions {
  enabled: boolean
  /* 每 60s 配额 */
  control: number
  data: number
  oci: number
  redis: Redis | null
}

interface RateLimits {
  control: RateLimit | null
  data: RateLimit | null
  oci: RateLimit | null
}

type Face = 'control' | 'data' | 'oci'

function createRateLimits(Options: RateLimitOptions): RateLimits {
  if (!Options.enabled) return { control: null, data: null, oci: null }
  return {
    control: faceLimit('control', Options.control, Options.redis),
    data: faceLimit('data', Options.data, Options.redis),
    oci: faceLimit('oci', Options.oci, Options.redis),
  }
}

function faceLimit(Face: Face, Points: number, Client: Redis | null): RateLimit {
  const Limiter = buildLimiter(Face, Points, Client)
  return async (c: Context<AppEnv>) => {
    try {
      await Limiter.consume(`${Face}:${identityKey(c.get('identity') as Identity | undefined)}`)
    } catch (err) {
      if (err instanceof RateLimiterRes) {
        throw new GatewayError('E_RATE_LIMIT', '请求过于频繁', { retryAfter: Math.max(1, Math.ceil(err.msBeforeNext / 1000)) })
      }
      /* 存储层异常（insurance 兜底后仍失败）→ 放行：限流不成为单点故障 */
    }
  }
}

function buildLimiter(Face: Face, Points: number, Client: Redis | null): RateLimiterAbstract {
  const Base = { points: Points, duration: RATE_LIMIT_WINDOW_SECONDS }
  const Memory = new RateLimiterMemory({ ...Base, keyPrefix: `better-minio:rl:${Face}` })
  if (Client === null) return Memory
  return new RateLimiterRedis({
    ...Base,
    storeClient: Client,
    keyPrefix: `better-minio:rl:${Face}`,
    rejectIfRedisNotReady: true,
    insuranceLimiter: Memory,
  })
}

function identityKey(Who: Identity | undefined): string {
  if (Who === undefined) return 'anon'
  if (Who.kind === 'service') return `svc:${Who.name}`
  if (Who.kind === 'browser') return `sub:${Who.sub}`
  return `reg:${Who.sub}`
}
