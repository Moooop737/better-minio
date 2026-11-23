/**
 * 事件接线 —— object:put / object:complete → 过滤（非 previews/、可解码图片类型）→ enqueue；object:delete → cancel。
 * proxy / multipart / objects 只 emit，不知道本模块存在；THUMBNAIL_ENABLED=false 时不调用本函数（emit 空转）。
 * 回调内异步失败只记日志，不冒泡到 emit 方（上传链路不受加工影响）。
 * 用法：`const Off = subscribeThumbnails({ events, enqueue, cancel, logger })`；`Off()` 取消订阅。
 */

export { subscribeThumbnails }
export type { ThumbnailJob, SubscribeDeps }

import type { EventBus } from '../core/events'
import type { Logger } from '../ops/logger'
import { isPreviewKey, isThumbnailSource } from './process'

interface ThumbnailJob {
  key: string
  contentType: string
  attempts: number
}

interface SubscribeDeps {
  events: EventBus
  enqueue(Job: ThumbnailJob): Promise<void>
  cancel(Key: string): Promise<void>
  logger: Logger
}

function subscribeThumbnails(Deps: SubscribeDeps): () => void {
  const onStored = (Payload: { key: string; contentType: string | null }): void => {
    if (isPreviewKey(Payload.key) || Payload.contentType === null || !isThumbnailSource(Payload.contentType)) return
    Deps.enqueue({ key: Payload.key, contentType: Payload.contentType, attempts: 0 }).catch((err: unknown) => {
      Deps.logger.error({ event: 'thumbnail', key: Payload.key, err: String(err) }, '缩略图入队失败')
    })
  }
  const Offs = [
    Deps.events.on('object:put', onStored),
    Deps.events.on('object:complete', onStored),
    Deps.events.on('object:delete', (Payload) => {
      if (isPreviewKey(Payload.key)) return
      Deps.cancel(Payload.key).catch((err: unknown) => {
        Deps.logger.warn({ event: 'thumbnail', key: Payload.key, err: String(err) }, '缩略图删除联动失败')
      })
    }),
  ]
  return () => {
    for (const Off of Offs) Off()
  }
}
