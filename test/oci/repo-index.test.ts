/**
 * repo 索引读改写 —— 两个独立 store 实例（模拟两进程，无共享进程锁）并发更新同一 repo：If-Match 条件写冲突后重读重算，两边改动都保留；
 * 同实例并发靠进程内锁串行；mutate 抛错不写；内容未变不写。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ensureBucket } from '../../src/api/bucket'
import { getBytes } from '../../src/api/registry'
import { ociError } from '../../src/oci/errors'
import { createRepoIndexStore } from '../../src/oci/repo-index'
import { startS3, s3Available } from '../helpers/s3'
import type { TestS3 } from '../helpers/s3'

const BUCKET = 'index-test'

describe.skipIf(!s3Available)('repo-index', () => {
  let S3: TestS3

  beforeAll(async () => {
    S3 = await startS3()
    await ensureBucket(S3.client, BUCKET)
  }, 30_000)

  afterAll(async () => {
    await S3?.stop()
  })

  it('无索引 → null；首次 update 创建', async () => {
    const Store = createRepoIndexStore(S3.client, BUCKET)
    expect(await Store.read('a/b')).toBeNull()
    await Store.update('a/b', (Index, Existed) => {
      expect(Existed).toBe(false)
      Index.tags['1.0'] = 'sha256:x'
    })
    expect(await Store.read('a/b')).toEqual({ tags: { '1.0': 'sha256:x' }, manifests: {}, blobs: [] })
  })

  it('同实例并发 update 全部生效（进程内锁串行）', async () => {
    const Store = createRepoIndexStore(S3.client, BUCKET)
    await Promise.all(Array.from({ length: 10 }, (_, I) => Store.update('serial', (Index) => void Index.blobs.push(`d${I}`))))
    expect((await Store.read('serial'))?.blobs.sort()).toEqual(Array.from({ length: 10 }, (_, I) => `d${I}`).sort())
  })

  it('两实例并发（无共享锁）：条件写冲突重试后两边改动都在', async () => {
    const A = createRepoIndexStore(S3.client, BUCKET)
    const B = createRepoIndexStore(S3.client, BUCKET)
    await A.update('shared', () => undefined)
    await Promise.all([A.update('shared', (Index) => void Index.blobs.push('from-a')), B.update('shared', (Index) => void Index.blobs.push('from-b'))])
    expect((await A.read('shared'))?.blobs.sort()).toEqual(['from-a', 'from-b'])
  })

  it('mutate 抛错 → 不写、错误透传；内容未变 → 不写（ETag 不变）', async () => {
    const Store = createRepoIndexStore(S3.client, BUCKET)
    await Store.update('stable', (Index) => void Index.blobs.push('x'))
    const Before = await getBytes(S3.client, BUCKET, 'repos/stable/index.json')
    await expect(Store.update('stable', (Index) => {
      Index.blobs.push('y')
      throw ociError('TAG_INVALID', 'no')
    })).rejects.toMatchObject({ code: 'TAG_INVALID' })
    await Store.update('stable', () => 'noop')
    const After = await getBytes(S3.client, BUCKET, 'repos/stable/index.json')
    expect(After?.etag).toBe(Before?.etag)
    expect((await Store.read('stable'))?.blobs).toEqual(['x'])
  })
})
