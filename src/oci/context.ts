/**
 * oci 内部依赖包 —— routes 组装一次，manifest / blob / upload 共用；不对外导出给其他模块。
 */

export { createOciContext }
export type { OciContext }

import type { S3Client } from '@aws-sdk/client-s3'
import type { StateStore } from '../core/state'
import { createKeyedLock } from './lock'
import type { KeyedLock } from './lock'
import { createRepoIndexStore } from './repo-index'
import type { RepoIndexStore } from './repo-index'

interface OciContext {
  client: S3Client
  bucket: string
  store: StateStore
  index: RepoIndexStore
  /* 上传会话 TTL（秒，OCI_UPLOAD_TTL） */
  uploadTtl: number
  /* 同一上传会话串行（PATCH / PUT / DELETE） */
  uploadLock: KeyedLock
  now: () => number
}

function createOciContext(Input: { client: S3Client; bucket: string; store: StateStore; uploadTtl: number; now?: () => number }): OciContext {
  return {
    client: Input.client,
    bucket: Input.bucket,
    store: Input.store,
    index: createRepoIndexStore(Input.client, Input.bucket),
    uploadTtl: Input.uploadTtl,
    uploadLock: createKeyedLock(),
    now: Input.now ?? Date.now,
  }
}
