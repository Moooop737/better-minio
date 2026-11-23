/**
 * 缩略图 worker —— 队列在状态存储 list `better-minio:thumbnail:queue`（Redis 重启不丢待处理；内存重启丢，显式接受：派生可再生成）。
 * 并发 1（2c2g，sharp 吃核）；入队去重（同 key 留最新）；失败 attempts+1 回队尾，总尝试 3 次后丢弃 + error 日志（不设死信，显式端点是恢复路径）。
 * 删除联动：移除同 key 待处理 job + best-effort 删派生；若该 key 正在加工，加工完再删一次（防删后复活）。
 * 用法：`const W = startThumbnails({ internalClient, bucket, stateStore, events, width, format, quality, logger })`；关闭时 `await W.stop()`。
 */

export { startThumbnails, THUMBNAIL_QUEUE_KEY, THUMBNAIL_MAX_ATTEMPTS }
export type { ThumbnailWorkerDeps, ThumbnailWorker }

import type { S3Client } from '@aws-sdk/client-s3'
import { deleteObject } from '../api/objects'
import type { ThumbnailFormat } from '../config'
import type { EventBus } from '../core/events'
import type { StateStore } from '../core/state'
import type { Logger } from '../ops/logger'
import { generateThumbnail, previewKeyFor } from './process'
import { subscribeThumbnails } from './subscribe'
import type { ThumbnailJob } from './subscribe'

const THUMBNAIL_QUEUE_KEY = 'better-minio:thumbnail:queue'
const THUMBNAIL_MAX_ATTEMPTS = 3
const DEFAULT_POLL_MS = 1000

interface ThumbnailWorkerDeps {
  internalClient: S3Client
  bucket: string
  stateStore: StateStore
  events: EventBus
  width: number
  format: ThumbnailFormat
  quality: number
  logger: Logger
  pollMs?: number
}

interface ThumbnailWorker {
  stop(): Promise<void>
  drain(): Promise<void>
}

function startThumbnails(Deps: ThumbnailWorkerDeps): ThumbnailWorker {
  const Store = Deps.stateStore
  const Log = Deps.logger
  const PollMs = Deps.pollMs ?? DEFAULT_POLL_MS
  const Pending = new Set<Promise<void>>()
  const IdleWaiters: (() => void)[] = []
  const DeletedWhileBusy = new Set<string>()
  let Busy: string | null = null
  let Stopped = false
  let Wake: (() => void) | null = null

  const wake = (): void => {
    Wake?.()
  }

  const track = (Work: Promise<void>): Promise<void> => {
    Pending.add(Work)
    const Done = (): void => {
      Pending.delete(Work)
      wake()
    }
    Work.then(Done, Done)
    return Work
  }

  async function enqueue(Job: ThumbnailJob): Promise<void> {
    await Store.listRemove(THUMBNAIL_QUEUE_KEY, (Raw) => parseJob(Raw)?.key === Job.key)
    await Store.listPush(THUMBNAIL_QUEUE_KEY, JSON.stringify(Job))
    Log.debug({ event: 'thumbnail', key: Job.key }, '缩略图入队')
  }

  async function cancel(Key: string): Promise<void> {
    if (Busy === Key) DeletedWhileBusy.add(Key)
    await Store.listRemove(THUMBNAIL_QUEUE_KEY, (Raw) => parseJob(Raw)?.key === Key)
    await removePreview(Key)
  }

  async function removePreview(Key: string): Promise<void> {
    try {
      await deleteObject(Deps.internalClient, Deps.bucket, previewKeyFor(Key, Deps.format))
    } catch (err) {
      Log.warn({ event: 'thumbnail', key: Key, err: String(err) }, '派生删除失败（best-effort）')
    }
  }

  /* 回队前确认队列里没有同 key 的新 job（新的覆盖旧的失败重试） */
  async function requeue(Job: ThumbnailJob): Promise<void> {
    let Newer = false
    await Store.listRemove(THUMBNAIL_QUEUE_KEY, (Raw) => {
      if (parseJob(Raw)?.key === Job.key) Newer = true
      return false
    })
    if (!Newer) await Store.listPush(THUMBNAIL_QUEUE_KEY, JSON.stringify(Job))
  }

  async function handle(Job: ThumbnailJob): Promise<void> {
    Busy = Job.key
    try {
      const Result = await generateThumbnail({
        client: Deps.internalClient,
        bucket: Deps.bucket,
        key: Job.key,
        width: Deps.width,
        format: Deps.format,
        quality: Deps.quality,
      })
      if (Result.status === 'ok') {
        Log.info({ event: 'thumbnail', key: Job.key, preview: Result.previewKey, width: Result.width }, '缩略图已生成')
        if (DeletedWhileBusy.has(Job.key)) await removePreview(Job.key)
      } else {
        Log.debug({ event: 'thumbnail', key: Job.key, status: Result.status }, '缩略图跳过')
      }
    } catch (err) {
      const Attempts = Job.attempts + 1
      if (Attempts >= THUMBNAIL_MAX_ATTEMPTS || DeletedWhileBusy.has(Job.key)) {
        Log.error({ event: 'thumbnail', key: Job.key, attempts: Attempts, err: String(err) }, '缩略图加工失败，丢弃')
      } else {
        Log.warn({ event: 'thumbnail', key: Job.key, attempts: Attempts, err: String(err) }, '缩略图加工失败，回队重试')
        await requeue({ ...Job, attempts: Attempts })
      }
    } finally {
      Busy = null
      DeletedWhileBusy.delete(Job.key)
    }
  }

  async function loop(): Promise<void> {
    while (!Stopped) {
      let Raw: string | null
      try {
        Raw = await Store.listPop(THUMBNAIL_QUEUE_KEY)
      } catch (err) {
        Log.warn({ event: 'thumbnail', err: String(err) }, '缩略图队列读取失败')
        await sleep()
        continue
      }
      if (Raw === null) {
        if (Pending.size === 0) for (const Resolve of IdleWaiters.splice(0)) Resolve()
        await sleep()
        continue
      }
      const Job = parseJob(Raw)
      if (Job === null) {
        Log.warn({ event: 'thumbnail' }, '缩略图队列项格式非法，丢弃')
        continue
      }
      try {
        await handle(Job)
      } catch (err) {
        Log.error({ event: 'thumbnail', key: Job.key, err: String(err) }, '缩略图 worker 异常')
      }
    }
    for (const Resolve of IdleWaiters.splice(0)) Resolve()
  }

  /* 空队列等待：pollMs 超时或本进程入队唤醒 */
  function sleep(): Promise<void> {
    return new Promise((Resolve) => {
      const Timer = setTimeout(done, PollMs)
      function done(): void {
        clearTimeout(Timer)
        Wake = null
        Resolve()
      }
      Wake = done
    })
  }

  const Off = subscribeThumbnails({
    events: Deps.events,
    enqueue: (Job) => track(enqueue(Job)),
    cancel: (Key) => track(cancel(Key)),
    logger: Log,
  })
  const Running = loop()

  return {
    async stop() {
      if (Stopped) return Running
      Stopped = true
      Off()
      wake()
      await Running
    },
    async drain() {
      while (Pending.size > 0) await Promise.allSettled([...Pending])
      if (Stopped) return
      await new Promise<void>((Resolve) => {
        IdleWaiters.push(Resolve)
        wake()
      })
    },
  }
}

function parseJob(Raw: string): ThumbnailJob | null {
  try {
    const Value = JSON.parse(Raw) as Partial<ThumbnailJob> | null
    if (typeof Value?.key !== 'string' || typeof Value.contentType !== 'string' || typeof Value.attempts !== 'number') return null
    return { key: Value.key, contentType: Value.contentType, attempts: Value.attempts }
  } catch {
    return null
  }
}
