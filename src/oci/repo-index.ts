/**
 * per-repo 索引 —— `repos/<name>/index.json`（持久 registry 状态，落 MinIO，无 Redis 重启不丢；design D1）。
 * 形状 `{ tags: {tag→digest}, manifests: {digest→{mediaType,size}}, blobs: [digest…] }`。
 *   read(name)：无索引 = repo 不存在 → null。
 *   update(name, mutate)：进程内 per-repo 串行 + 条件写（有对象 If-Match: etag；无对象 If-None-Match: *），
 *     条件冲突重读重算，重试 ≤3 次仍冲突 → UNKNOWN（503）。mutate 可抛 OciError 中止（不写）；内容未变不写。
 * 文件名不叫 index.ts：避免目录导入解析成本模块入口（design §七 已同步）。
 */

export { createRepoIndexStore, emptyIndex, MAX_INDEX_RETRIES }
export type { RepoIndex, RepoIndexStore, ManifestEntry }

import type { S3Client } from '@aws-sdk/client-s3'
import { getBytes, putBytes } from '../api/registry'
import { ociError } from './errors'
import { indexKey } from './layout'
import { createKeyedLock } from './lock'

interface ManifestEntry {
  mediaType: string
  size: number
}

interface RepoIndex {
  tags: Record<string, string>
  manifests: Record<string, ManifestEntry>
  blobs: string[]
}

interface RepoIndexStore {
  read(Name: string): Promise<RepoIndex | null>
  update<T>(Name: string, Mutate: (Index: RepoIndex, Existed: boolean) => T): Promise<T>
}

const MAX_INDEX_RETRIES = 3

function emptyIndex(): RepoIndex {
  return { tags: {}, manifests: {}, blobs: [] }
}

function createRepoIndexStore(Client: S3Client, Bucket: string): RepoIndexStore {
  const Lock = createKeyedLock()

  async function load(Name: string): Promise<{ index: RepoIndex; etag: string | null } | null> {
    const Object_ = await getBytes(Client, Bucket, indexKey(Name))
    if (Object_ === null) return null
    return { index: decode(Object_.body), etag: Object_.etag }
  }

  return {
    async read(Name) {
      return (await load(Name))?.index ?? null
    },

    async update(Name, Mutate) {
      return Lock.run(Name, async () => {
        for (let Attempt = 0; Attempt <= MAX_INDEX_RETRIES; Attempt++) {
          const Loaded = await load(Name)
          const Index = Loaded?.index ?? emptyIndex()
          const Before = JSON.stringify(Index)
          const Result = Mutate(Index, Loaded !== null)
          const After = JSON.stringify(Index)
          if (Loaded !== null && Before === After) return Result
          const Condition = Loaded?.etag != null ? { ifMatch: Loaded.etag } : { ifNoneMatch: '*' }
          const Written = await putBytes(Client, Bucket, indexKey(Name), Buffer.from(After), { contentType: 'application/json', ...Condition })
          if (Written.ok) return Result
        }
        throw ociError('UNKNOWN', '索引并发更新冲突，请重试', { status: 503 })
      })
    },
  }
}

/* 容错解码：字段缺失按空补齐；坏 JSON 视为上游损坏 */
function decode(Body: Buffer): RepoIndex {
  let Raw: unknown
  try {
    Raw = JSON.parse(Body.toString('utf8'))
  } catch {
    throw ociError('UNKNOWN', '索引损坏', { status: 500 })
  }
  const Value = (typeof Raw === 'object' && Raw !== null ? Raw : {}) as Partial<RepoIndex>
  return {
    tags: typeof Value.tags === 'object' && Value.tags !== null ? { ...Value.tags } : {},
    manifests: typeof Value.manifests === 'object' && Value.manifests !== null ? { ...Value.manifests } : {},
    blobs: Array.isArray(Value.blobs) ? Value.blobs.filter((Item): Item is string => typeof Item === 'string') : [],
  }
}
