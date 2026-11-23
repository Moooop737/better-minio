/**
 * OCI 清理定时器 —— 上传临时对象回收（design §六 D5）；OCI_ENABLED=false 时不起。
 *   ① 会话扫：StateStore 里 expiresAt ≤ now 的上传会话 → 删 `uploads/<uuid>/` 下全部对象 + 删会话。
 *   ② 孤儿扫：`uploads/` 前缀下不属于任何存活会话、且 lastModified 早于 now − TTL 的对象 → 删
 *      （兜底无 Redis 重启丢会话、收尾中途失败等残留）。
 *   runOnce() 返回本轮删除的对象数；同一时刻只跑一轮（重入复用在途那轮）。定时器 unref，不挡进程退出。
 *
 * 悬挂 blob GC（触发点，先不做 —— 设计草图留档）：
 *   mark  = 遍历 `repos/` 前缀下全部 index.json，取 blobs ∪ manifests 键的并集；
 *   sweep = 列 `blobs/sha256/` 前缀，不在 mark 集且 lastModified 早于宽限期（防与在途 push 竞态）的对象删除；
 *   入口 = 手动触发 `POST /v2/_gc`（service token，backend 身份），低频人工触发，不做定时。
 */

export { startOciCleanup, DEFAULT_CLEANUP_INTERVAL_MS }
export type { OciCleanup, OciCleanupOptions }

import type { S3Client } from '@aws-sdk/client-s3'
import { deleteMany, listByPrefix } from '../api/registry'
import type { StateStore } from '../core/state'
import { logger } from '../ops/logger'
import { SESSION_PREFIX, UPLOADS_PREFIX, uploadPrefix } from './layout'
import { readSession } from './upload'

const DEFAULT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000

interface OciCleanupOptions {
  internalClient: S3Client
  registryBucket: string
  stateStore: StateStore
  /* 秒 */
  uploadTtl: number
  intervalMs?: number
  now?: () => number
}

interface OciCleanup {
  stop(): void
  runOnce(): Promise<number>
}

function startOciCleanup(Options: OciCleanupOptions): OciCleanup {
  const Now = Options.now ?? Date.now
  let InFlight: Promise<number> | null = null

  const sweep = async (): Promise<number> => {
    const At = Now()
    let Deleted = 0
    const Live = new Set<string>()

    for (const Key of await Options.stateStore.scan(SESSION_PREFIX)) {
      const Uuid = Key.slice(SESSION_PREFIX.length)
      const Session = await readSession({ store: Options.stateStore }, Uuid)
      if (Session !== null && Session.expiresAt > At) {
        Live.add(Uuid)
        continue
      }
      const Objects = await listByPrefix(Options.internalClient, Options.registryBucket, uploadPrefix(Uuid))
      Deleted += await deleteMany(Options.internalClient, Options.registryBucket, Objects.map((Item) => Item.key))
      await Options.stateStore.del(Key)
    }

    const Cutoff = At - Options.uploadTtl * 1000
    const Orphans = (await listByPrefix(Options.internalClient, Options.registryBucket, UPLOADS_PREFIX)).filter((Item) => {
      const Uuid = Item.key.slice(UPLOADS_PREFIX.length).split('/')[0] ?? ''
      return !Live.has(Uuid) && Item.lastModified !== null && Item.lastModified.getTime() < Cutoff
    })
    Deleted += await deleteMany(Options.internalClient, Options.registryBucket, Orphans.map((Item) => Item.key))
    return Deleted
  }

  const runOnce = (): Promise<number> => {
    InFlight ??= sweep().finally(() => {
      InFlight = null
    })
    return InFlight
  }

  const Timer = setInterval(() => {
    runOnce()
      .then((Count) => {
        if (Count > 0) logger.info({ deleted: Count }, 'oci 上传临时对象已清理')
      })
      .catch((err: unknown) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'oci 清理失败'))
  }, Options.intervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS)
  Timer.unref()

  return {
    stop() {
      clearInterval(Timer)
    },
    runOnce,
  }
}
