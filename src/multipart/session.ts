/**
 * 分片会话 —— uploadId 即会话 id；会话头存 StateStore（`better-minio:multipart:<uploadId>`），不存 parts（ListParts 是真源）。
 * 时间一律 epoch 秒；存储 TTL = 会话 TTL + 3600 grace（key 不先于清理器消失）。loadSession 对 expiresAt <= now 视为不存在。
 * startMultipartCleanup：每 5 min 扫前缀，过期会话 abort + del；abort 失败留到下轮，不抛。返回 { stop, runOnce }。
 * 无 Redis 重启丢会话 → MinIO 孤儿 upload 由桶 ILM 规则兜底（部署侧）。
 */

export {
  SESSION_PREFIX,
  SESSION_GRACE_SECONDS,
  CLEANUP_INTERVAL_MS,
  sessionKey,
  saveSession,
  loadSession,
  deleteSession,
  startMultipartCleanup,
}
export type { MultipartSession, MultipartCleanup, MultipartCleanupOptions }

import type { S3Client } from '@aws-sdk/client-s3'
import { abortMultipartUpload } from '../api/multipart'
import type { StateStore } from '../core/state'
import { logger } from '../ops/logger'

interface MultipartSession {
  uploadId: string
  /* 实际对象 key（date 模式已加前缀） */
  key: string
  partSize: number
  contentType: string | null
  sub: string
  clientIp: string
  resourceId: string | null
  createdAt: number
  expiresAt: number
}

interface MultipartCleanupOptions {
  internalClient: S3Client
  bucket: string
  stateStore: StateStore
  intervalMs?: number
  now?: () => number
}

interface MultipartCleanup {
  stop(): void
  /* 跑一轮，返回清理掉的会话数 */
  runOnce(): Promise<number>
}

const SESSION_PREFIX = 'better-minio:multipart:'
const SESSION_GRACE_SECONDS = 3600
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000

function sessionKey(UploadId: string): string {
  return `${SESSION_PREFIX}${UploadId}`
}

async function saveSession(Store: StateStore, Session: MultipartSession, TtlSeconds: number): Promise<void> {
  await Store.set(sessionKey(Session.uploadId), JSON.stringify(Session), TtlSeconds + SESSION_GRACE_SECONDS)
}

async function loadSession(Store: StateStore, UploadId: string, NowMs: number): Promise<MultipartSession | null> {
  const Raw = await Store.get(sessionKey(UploadId))
  if (Raw === null) return null
  const Session = parseSession(Raw)
  if (Session === null || Session.uploadId !== UploadId) return null
  return Session.expiresAt <= Math.floor(NowMs / 1000) ? null : Session
}

async function deleteSession(Store: StateStore, UploadId: string): Promise<void> {
  await Store.del(sessionKey(UploadId))
}

function startMultipartCleanup(Options: MultipartCleanupOptions): MultipartCleanup {
  const Now = Options.now ?? Date.now
  let Running = false

  async function runOnce(): Promise<number> {
    if (Running) return 0
    Running = true
    let Cleaned = 0
    try {
      const Keys = await Options.stateStore.scan(SESSION_PREFIX)
      const NowSeconds = Math.floor(Now() / 1000)
      for (const Key of Keys) {
        const Raw = await Options.stateStore.get(Key)
        if (Raw === null) continue
        const Session = parseSession(Raw)
        if (Session === null) {
          // 坏会话无法 abort（无 key/uploadId），直接删；MinIO 侧由 ILM 兜底
          await Options.stateStore.del(Key)
          Cleaned++
          continue
        }
        if (Session.expiresAt > NowSeconds) continue
        try {
          await abortMultipartUpload(Options.internalClient, Options.bucket, Session.key, Session.uploadId)
        } catch {
          logger.warn({ uploadId: Session.uploadId }, 'multipart 过期会话 abort 失败，留到下轮')
          continue
        }
        await Options.stateStore.del(Key)
        Cleaned++
      }
    } catch {
      logger.warn('multipart 会话清理扫描失败，留到下轮')
    } finally {
      Running = false
    }
    if (Cleaned > 0) logger.info({ cleaned: Cleaned }, 'multipart 过期会话已清理')
    return Cleaned
  }

  const Timer = setInterval(() => {
    void runOnce()
  }, Options.intervalMs ?? CLEANUP_INTERVAL_MS)
  Timer.unref()

  return {
    stop() {
      clearInterval(Timer)
    },
    runOnce,
  }
}

function parseSession(Raw: string): MultipartSession | null {
  let Value: unknown
  try {
    Value = JSON.parse(Raw)
  } catch {
    return null
  }
  if (typeof Value !== 'object' || Value === null) return null
  const S = Value as Record<string, unknown>
  const isNullableString = (V: unknown): V is string | null => V === null || typeof V === 'string'
  if (
    typeof S.uploadId !== 'string' || typeof S.key !== 'string' || typeof S.partSize !== 'number' ||
    !isNullableString(S.contentType) || typeof S.sub !== 'string' || typeof S.clientIp !== 'string' ||
    !isNullableString(S.resourceId) || typeof S.createdAt !== 'number' || typeof S.expiresAt !== 'number'
  ) {
    return null
  }
  return {
    uploadId: S.uploadId,
    key: S.key,
    partSize: S.partSize,
    contentType: S.contentType,
    sub: S.sub,
    clientIp: S.clientIp,
    resourceId: S.resourceId,
    createdAt: S.createdAt,
    expiresAt: S.expiresAt,
  }
}
