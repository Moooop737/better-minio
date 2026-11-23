/**
 * 进程内按 key 串行锁 —— repo 索引读改写、同一上传会话的 PATCH/PUT 各自串行。
 * 用法：`const Lock = createKeyedLock(); await Lock.run(key, async () => …)`；队列空即回收 key。
 */

export { createKeyedLock }
export type { KeyedLock }

interface KeyedLock {
  run<T>(Key: string, Task: () => Promise<T>): Promise<T>
}

function createKeyedLock(): KeyedLock {
  const Tails = new Map<string, Promise<unknown>>()
  return {
    async run(Key, Task) {
      const Previous = Tails.get(Key) ?? Promise.resolve()
      const Current = Previous.catch(() => undefined).then(Task)
      const Tail = Current.catch(() => undefined)
      Tails.set(Key, Tail)
      try {
        return await Current
      } finally {
        if (Tails.get(Key) === Tail) Tails.delete(Key)
      }
    },
  }
}
