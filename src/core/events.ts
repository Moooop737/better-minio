/**
 * 进程内类型化事件总线 —— proxy/multipart/objects 只 emit，不知道谁订阅（thumbnail 关闭时 emit 空转）。
 * object:put = 非分片 PUT 成功；object:complete = multipart complete 成功；object:delete = /objects/delete 成功。
 */

export { createEventBus }
export type { EventBus, GatewayEvents }

import { EventEmitter } from 'node:events'

interface GatewayEvents {
  'object:put': { key: string; contentType: string | null; size: number | null }
  'object:complete': { key: string; contentType: string | null }
  'object:delete': { key: string }
}

interface EventBus {
  emit<K extends keyof GatewayEvents>(Name: K, Payload: GatewayEvents[K]): void
  on<K extends keyof GatewayEvents>(Name: K, Listener: (Payload: GatewayEvents[K]) => void): () => void
}

function createEventBus(): EventBus {
  const Emitter = new EventEmitter()
  return {
    emit(Name, Payload) {
      Emitter.emit(Name, Payload)
    },
    on(Name, Listener) {
      Emitter.on(Name, Listener)
      return () => Emitter.off(Name, Listener)
    },
  }
}
