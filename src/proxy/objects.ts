/**
 * 服务端控制端点 handler —— `POST /objects/stat` `POST /objects/delete`（service token 已由路由链校验）。
 * 网关持 MinIO 凭证经 api 层执行；key 校验与 presign 同口径（keySchema）。
 * stat 不存在 → 404 E_NOT_FOUND；delete 幂等恒 204，成功 emit object:delete；api 失败 → 502 E_UPSTREAM（通用文案）。
 */

export { createObjectHandlers, objectKeyBodySchema }
export type { ObjectHandlerDeps }

import type { S3Client } from '@aws-sdk/client-s3'
import type { Handler } from 'hono'
import { z } from 'zod'
import { deleteObject, statObject } from '../api/objects'
import type { ObjectStat } from '../api/object-store'
import { GatewayError } from '../core/errors'
import type { EventBus } from '../core/events'
import type { AppEnv } from '../core/types'
import { logger } from '../ops/logger'
import { keySchema, parseJsonBody } from '../presign/schema'

interface ObjectHandlerDeps {
  internal: S3Client
  bucket: string
  events: EventBus
}

const objectKeyBodySchema = z.object({ key: keySchema })

function createObjectHandlers(Deps: ObjectHandlerDeps): { stat: Handler<AppEnv>; remove: Handler<AppEnv> } {
  return {
    async stat(c) {
      const { key } = await parseJsonBody(c, objectKeyBodySchema)
      c.set('auditKey', key)
      const Stat = await upstream<ObjectStat | null>('stat', () => statObject(Deps.internal, Deps.bucket, key))
      if (Stat === null) throw new GatewayError('E_NOT_FOUND', '对象不存在')
      return c.json({ size: Stat.size, contentType: Stat.contentType, etag: Stat.etag })
    },
    async remove(c) {
      const { key } = await parseJsonBody(c, objectKeyBodySchema)
      c.set('auditKey', key)
      await upstream('delete', () => deleteObject(Deps.internal, Deps.bucket, key))
      Deps.events.emit('object:delete', { key })
      return c.body(null, 204)
    },
  }
}

/* ObjectStoreError 的 detail 可能含 endpoint：对外只给通用 502，日志只记操作名 */
async function upstream<T>(Op: string, Fn: () => Promise<T>): Promise<T> {
  try {
    return await Fn()
  } catch {
    logger.warn({ event: 'upstream_error', op: Op }, 'object store operation failed')
    throw new GatewayError('E_UPSTREAM', '上游存储不可用')
  }
}
