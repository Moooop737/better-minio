/**
 * 瞬态状态存储 —— multipart 会话 / oci 上传会话 / thumbnail 队列共用。
 * REDIS_URL 给了 → ioredis 实现（启动连不上拒启，运行期自动重连）；不给 → 内存 Map（重启丢，显式接受）。
 * key 一律 `better-minio:<module>:…`；value 为 JSON 字符串由调用方序列化。
 * 队列原语 push/pop 给 thumbnail（Redis list LPUSH/RPOP；内存数组）。
 */

export { createStateStore, createMemoryStateStore, createRedisStateStore }
export type { StateStore }

import { Redis } from 'ioredis'

interface StateStore {
  readonly kind: 'memory' | 'redis'
  get(Key: string): Promise<string | null>
  /* TtlSeconds 省略 = 不过期 */
  set(Key: string, Value: string, TtlSeconds?: number): Promise<void>
  del(Key: string): Promise<void>
  /* 列出前缀下全部 key */
  scan(Prefix: string): Promise<string[]>
  listPush(Key: string, Value: string): Promise<void>
  listPop(Key: string): Promise<string | null>
  listRemove(Key: string, Predicate: (Value: string) => boolean): Promise<number>
  ping(): Promise<void>
  close(): Promise<void>
  /* Redis 原生客户端（rate-limit 复用）；内存模式为 null */
  readonly redis: Redis | null
}

async function createStateStore(RedisUrl: string | null): Promise<StateStore> {
  return RedisUrl === null ? createMemoryStateStore() : createRedisStateStore(RedisUrl)
}

function createMemoryStateStore(Now: () => number = Date.now): StateStore {
  const Values = new Map<string, { value: string; expiresAt: number | null }>()
  const Lists = new Map<string, string[]>()
  const live = (Key: string): string | null => {
    const Entry = Values.get(Key)
    if (Entry === undefined) return null
    if (Entry.expiresAt !== null && Entry.expiresAt <= Now()) {
      Values.delete(Key)
      return null
    }
    return Entry.value
  }
  return {
    kind: 'memory',
    redis: null,
    async get(Key) {
      return live(Key)
    },
    async set(Key, Value, TtlSeconds) {
      Values.set(Key, { value: Value, expiresAt: TtlSeconds === undefined ? null : Now() + TtlSeconds * 1000 })
    },
    async del(Key) {
      Values.delete(Key)
      Lists.delete(Key)
    },
    async scan(Prefix) {
      return [...Values.keys()].filter((Key) => Key.startsWith(Prefix) && live(Key) !== null)
    },
    async listPush(Key, Value) {
      const List = Lists.get(Key) ?? []
      List.push(Value)
      Lists.set(Key, List)
    },
    async listPop(Key) {
      return Lists.get(Key)?.shift() ?? null
    },
    async listRemove(Key, Predicate) {
      const List = Lists.get(Key)
      if (List === undefined) return 0
      const Kept = List.filter((Value) => !Predicate(Value))
      Lists.set(Key, Kept)
      return List.length - Kept.length
    },
    async ping() {},
    async close() {
      Values.clear()
      Lists.clear()
    },
  }
}

async function createRedisStateStore(Url: string): Promise<StateStore> {
  const Client = new Redis(Url, { lazyConnect: true, maxRetriesPerRequest: 3, enableOfflineQueue: true })
  try {
    await Client.connect()
    await Client.ping()
  } catch {
    Client.disconnect()
    throw new Error('REDIS_URL 已配置但连接失败（拒启）')
  }
  return {
    kind: 'redis',
    redis: Client,
    async get(Key) {
      return Client.get(Key)
    },
    async set(Key, Value, TtlSeconds) {
      if (TtlSeconds === undefined) await Client.set(Key, Value)
      else await Client.set(Key, Value, 'EX', TtlSeconds)
    },
    async del(Key) {
      await Client.del(Key)
    },
    async scan(Prefix) {
      const Keys: string[] = []
      let Cursor = '0'
      do {
        const [Next, Batch] = await Client.scan(Cursor, 'MATCH', `${escapeGlob(Prefix)}*`, 'COUNT', 500)
        Cursor = Next
        Keys.push(...Batch)
      } while (Cursor !== '0')
      return [...new Set(Keys)]
    },
    async listPush(Key, Value) {
      await Client.rpush(Key, Value)
    },
    async listPop(Key) {
      return Client.lpop(Key)
    },
    async listRemove(Key, Predicate) {
      const All = await Client.lrange(Key, 0, -1)
      let Removed = 0
      for (const Value of new Set(All.filter(Predicate))) Removed += await Client.lrem(Key, 0, Value)
      return Removed
    },
    async ping() {
      await Client.ping()
    },
    async close() {
      await Client.quit().catch(() => Client.disconnect())
    },
  }
}

function escapeGlob(Value: string): string {
  return Value.replace(/[*?[\]\\]/g, (Char) => `\\${Char}`)
}
