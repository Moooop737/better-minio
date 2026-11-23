import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CreateBucketCommand } from '@aws-sdk/client-s3'
import { createMultipartUpload, listParts } from '../../src/api/multipart'
import { createMemoryStateStore } from '../../src/core/state'
import type { StateStore } from '../../src/core/state'
import {
  SESSION_GRACE_SECONDS,
  SESSION_PREFIX,
  deleteSession,
  loadSession,
  saveSession,
  sessionKey,
  startMultipartCleanup,
} from '../../src/multipart/session'
import type { MultipartSession } from '../../src/multipart/session'
import { startS3, s3Available } from '../helpers/s3'
import type { TestS3 } from '../helpers/s3'

const T0 = 1_800_000_000_000

function session(UploadId: string, Key: string, ExpiresAt: number): MultipartSession {
  return {
    uploadId: UploadId,
    key: Key,
    partSize: 5 * 1024 * 1024,
    contentType: null,
    sub: 'u1',
    clientIp: '203.0.113.7',
    resourceId: null,
    createdAt: ExpiresAt - 100,
    expiresAt: ExpiresAt,
  }
}

describe('会话存取', () => {
  it('save / load / delete 往返；key 前缀固定', async () => {
    const Store = createMemoryStateStore()
    const S = session('up-1', 'a/b.bin', T0 / 1000 + 100)
    await saveSession(Store, S, 100)
    expect(sessionKey('up-1')).toBe('better-minio:multipart:up-1')
    expect(await Store.scan(SESSION_PREFIX)).toEqual(['better-minio:multipart:up-1'])
    expect(await loadSession(Store, 'up-1', T0)).toEqual(S)
    await deleteSession(Store, 'up-1')
    expect(await loadSession(Store, 'up-1', T0)).toBeNull()
  })

  it('expiresAt <= now → 视为不存在（存储层 grace 期内也一样）', async () => {
    const Store = createMemoryStateStore()
    await saveSession(Store, session('up-2', 'k', T0 / 1000 + 10), 10)
    expect(await loadSession(Store, 'up-2', T0 + 9_999)).not.toBeNull()
    expect(await loadSession(Store, 'up-2', T0 + 10_000)).toBeNull()
  })

  it('存储 TTL = 会话 TTL + 3600 grace（Redis EX 口径；无 Redis server，用记录型 store 断言参数）', async () => {
    const Calls: (number | undefined)[] = []
    const Base = createMemoryStateStore()
    const Store: StateStore = { ...Base, set: async (K, V, Ttl) => { Calls.push(Ttl); await Base.set(K, V, Ttl) } }
    await saveSession(Store, session('up-3', 'k', T0 / 1000 + 86400), 86400)
    expect(Calls).toEqual([86400 + SESSION_GRACE_SECONDS])
  })

  it('坏 JSON → null', async () => {
    const Store = createMemoryStateStore()
    await Store.set(sessionKey('bad'), '{not json')
    expect(await loadSession(Store, 'bad', T0)).toBeNull()
  })
})

describe.skipIf(!s3Available)('过期清理（moto）', () => {
  const BUCKET = 'mp-cleanup'
  let S3: TestS3

  beforeAll(async () => {
    S3 = await startS3()
    await S3.client.send(new CreateBucketCommand({ Bucket: BUCKET }))
  }, 30000)

  afterAll(async () => {
    await S3?.stop()
  })

  it('runOnce：过期会话 abort + 删除并计数，未过期保留', async () => {
    const Store = createMemoryStateStore()
    let Now = T0
    const Old = await createMultipartUpload(S3.client, BUCKET, 'c/old.bin')
    const Fresh = await createMultipartUpload(S3.client, BUCKET, 'c/fresh.bin')
    await saveSession(Store, session(Old, 'c/old.bin', T0 / 1000 + 60), 60)
    await saveSession(Store, session(Fresh, 'c/fresh.bin', T0 / 1000 + 3600), 3600)
    const Cleanup = startMultipartCleanup({ internalClient: S3.client, bucket: BUCKET, stateStore: Store, now: () => Now })
    try {
      expect(await Cleanup.runOnce()).toBe(0)
      Now = T0 + 61_000
      expect(await Cleanup.runOnce()).toBe(1)
      expect(await Store.get(sessionKey(Old))).toBeNull()
      expect(await Store.get(sessionKey(Fresh))).not.toBeNull()
      // MinIO 侧 upload 已 abort
      expect(await listParts(S3.client, BUCKET, 'c/old.bin', Old)).toBeNull()
      expect(await listParts(S3.client, BUCKET, 'c/fresh.bin', Fresh)).toEqual([])
      // 已在 MinIO 消失的 upload（NoSuchUpload）也算清理成功（abort 幂等）
      await saveSession(Store, session('ghost-upload', 'c/ghost.bin', T0 / 1000 + 1), 1)
      expect(await Cleanup.runOnce()).toBe(1)
    } finally {
      Cleanup.stop()
    }
  })

  it('abort 失败（后端不可达）不抛，会话留到下轮', async () => {
    const { createS3Client } = await import('../../src/api/client')
    const Dead = createS3Client({ endpoint: 'http://127.0.0.1:1', region: 'us-east-1', forcePathStyle: true, accessKeyId: 'a', secretAccessKey: 'b' })
    const Store = createMemoryStateStore()
    await saveSession(Store, session('dead-1', 'k', T0 / 1000 - 1), 1)
    const Cleanup = startMultipartCleanup({ internalClient: Dead, bucket: BUCKET, stateStore: Store, now: () => T0 })
    try {
      expect(await Cleanup.runOnce()).toBe(0)
      expect(await Store.get(sessionKey('dead-1'))).not.toBeNull()
    } finally {
      Cleanup.stop()
      Dead.destroy()
    }
  }, 30000)

  it('定时器按 intervalMs 触发', async () => {
    const Store = createMemoryStateStore()
    const Id = await createMultipartUpload(S3.client, BUCKET, 'c/timer.bin')
    await saveSession(Store, session(Id, 'c/timer.bin', T0 / 1000 - 1), 1)
    const Cleanup = startMultipartCleanup({ internalClient: S3.client, bucket: BUCKET, stateStore: Store, intervalMs: 20, now: () => T0 })
    try {
      for (let I = 0; I < 100 && (await Store.get(sessionKey(Id))) !== null; I++) await new Promise((R) => setTimeout(R, 20))
      expect(await Store.get(sessionKey(Id))).toBeNull()
    } finally {
      Cleanup.stop()
    }
  })
})
