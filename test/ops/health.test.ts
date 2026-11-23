import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { CreateBucketCommand } from '@aws-sdk/client-s3'
import { createS3Client } from '../../src/api/client'
import { createMemoryStateStore } from '../../src/core/state'
import type { StateStore } from '../../src/core/state'
import type { AppEnv } from '../../src/core/types'
import { mountHealth } from '../../src/ops/health'
import { s3Available, startS3 } from '../helpers/s3'
import type { TestS3 } from '../helpers/s3'

/* 模拟「配了 Redis」的状态存储：ping 结果可控（无 Redis 服务器） */
function fakeRedisStore(Up: () => boolean): StateStore {
  return { ...createMemoryStateStore(), kind: 'redis', async ping() { if (!Up()) throw new Error('down') } }
}

describe.skipIf(!s3Available)('/health', () => {
  let S3: TestS3
  beforeAll(async () => {
    S3 = await startS3()
    await S3.client.send(new CreateBucketCommand({ Bucket: 'kbfile' }))
  })
  afterAll(() => S3.stop())

  const app = (Client = S3.client, Store: StateStore = createMemoryStateStore()) => {
    const App = new Hono<AppEnv>()
    mountHealth(App, { internalClient: Client, bucket: 'kbfile', stateStore: Store })
    return App
  }

  it('MinIO up（内存状态）→ 200，无 redis 字段，不含地址', async () => {
    const Res = await app().request('/health')
    expect(Res.status).toBe(200)
    const Body = await Res.json()
    expect(Body).toEqual({ ok: true, bucket: 'kbfile', minio: 'up' })
    expect(JSON.stringify(Body)).not.toContain('127.0.0.1')
  })

  it('MinIO endpoint 死 → 503', async () => {
    const Dead = createS3Client({ endpoint: 'http://127.0.0.1:1', region: 'us-east-1', forcePathStyle: true, accessKeyId: 'a', secretAccessKey: 'b' })
    const Res = await app(Dead).request('/health')
    expect(Res.status).toBe(503)
    expect(await Res.json()).toEqual({ ok: false, bucket: 'kbfile', minio: 'down' })
    Dead.destroy()
  })

  it('桶不存在 → 503', async () => {
    const App = new Hono<AppEnv>()
    mountHealth(App, { internalClient: S3.client, bucket: 'nobucket', stateStore: createMemoryStateStore() })
    expect((await App.request('/health')).status).toBe(503)
  })

  it('配了 Redis 且 down → 503；恢复 → 200', async () => {
    let Up = false
    const App = app(S3.client, fakeRedisStore(() => Up))
    const Down = await App.request('/health')
    expect(Down.status).toBe(503)
    expect(await Down.json()).toEqual({ ok: false, bucket: 'kbfile', minio: 'up', redis: 'down' })
    Up = true
    const Back = await App.request('/health')
    expect(Back.status).toBe(200)
    expect(await Back.json()).toEqual({ ok: true, bucket: 'kbfile', minio: 'up', redis: 'up' })
  })
})
