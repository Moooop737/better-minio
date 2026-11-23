/**
 * `GET /health` —— 无鉴权探针：MinIO pingBucket（2s）+ 配了 Redis 时 PING（2s）。
 * ok = MinIO up 且（Redis 若配置则 up）；否则 503。响应不含 MinIO 地址 / 凭证（bucket 名本就在客户端 URL 里，可回）。
 * 用法：`mountHealth(app, { internalClient, bucket, stateStore })`。
 */

export { mountHealth, HEALTH_PROBE_TIMEOUT_MS }
export type { HealthDeps }

import type { S3Client } from '@aws-sdk/client-s3'
import type { Hono } from 'hono'
import { pingBucket } from '../api/bucket'
import type { StateStore } from '../core/state'
import type { AppEnv } from '../core/types'

const HEALTH_PROBE_TIMEOUT_MS = 2000

interface HealthDeps {
  internalClient: S3Client
  bucket: string
  stateStore: StateStore
}

function mountHealth(App: Hono<AppEnv>, Deps: HealthDeps): void {
  App.get('/health', async (c) => {
    const [Minio, Redis] = await Promise.all([
      probe(() => pingBucket(Deps.internalClient, Deps.bucket)),
      Deps.stateStore.kind === 'redis' ? probe(() => Deps.stateStore.ping()) : Promise.resolve(null),
    ])
    const Ok = Minio === 'up' && (Redis === null || Redis === 'up')
    const Body = { ok: Ok, bucket: Deps.bucket, minio: Minio, ...(Redis === null ? {} : { redis: Redis }) }
    c.header('Cache-Control', 'no-store')
    return c.json(Body, Ok ? 200 : 503)
  })
}

async function probe(Fn: () => Promise<void>): Promise<'up' | 'down'> {
  let Timer: NodeJS.Timeout | undefined
  const Timeout = new Promise<never>((_, Reject) => {
    Timer = setTimeout(() => Reject(new Error('timeout')), HEALTH_PROBE_TIMEOUT_MS)
  })
  try {
    await Promise.race([Fn(), Timeout])
    return 'up'
  } catch {
    return 'down'
  } finally {
    clearTimeout(Timer)
  }
}
