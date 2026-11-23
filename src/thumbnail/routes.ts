/**
 * 显式重生成端点 `POST /thumbnail/generate` `{key}`（service token）—— 同步加工一张 → 200 `{previewKey}`。
 * 原图不存在 404 E_NOT_FOUND；非图片 / 解码失败 / previews/ 派生 key 400 E_VALIDATION；存储失败 502 E_UPSTREAM。
 * 用途：自动钩子失败恢复、参数变更后批量重生成、业务显式刷新。THUMBNAIL_ENABLED=false 时 index 不调用（路由 404）。
 * 用法：`mountThumbnail(app, { internalClient, bucket, serviceGate, rateLimit, width, format, quality })`。
 */

export { mountThumbnail }
export type { ThumbnailRouteDeps }

import type { S3Client } from '@aws-sdk/client-s3'
import type { Hono, MiddlewareHandler } from 'hono'
import { z } from 'zod'
import { ObjectStoreError } from '../api/object-store'
import type { ThumbnailFormat } from '../config'
import { GatewayError } from '../core/errors'
import type { AppEnv, RateLimit } from '../core/types'
import { generateThumbnail, isPreviewKey, ThumbnailDecodeError } from './process'

interface ThumbnailRouteDeps {
  internalClient: S3Client
  bucket: string
  serviceGate: MiddlewareHandler<AppEnv>
  rateLimit: RateLimit | null
  width: number
  format: ThumbnailFormat
  quality: number
}

const GenerateBody = z.object({ key: z.string().min(1).max(1024) })

function mountThumbnail(App: Hono<AppEnv>, Deps: ThumbnailRouteDeps): void {
  App.post('/thumbnail/generate', Deps.serviceGate, async (c) => {
    if (Deps.rateLimit !== null) await Deps.rateLimit(c)
    const Raw: unknown = await c.req.json().catch(() => null)
    const Parsed = GenerateBody.safeParse(Raw)
    if (!Parsed.success) throw new GatewayError('E_VALIDATION', '请求体需为 {key: string}')
    const Key = Parsed.data.key
    c.set('auditKey', Key)
    if (isPreviewKey(Key)) throw new GatewayError('E_VALIDATION', '派生对象不可再生成缩略图')
    let Result
    try {
      Result = await generateThumbnail({
        client: Deps.internalClient,
        bucket: Deps.bucket,
        key: Key,
        width: Deps.width,
        format: Deps.format,
        quality: Deps.quality,
      })
    } catch (err) {
      if (err instanceof ThumbnailDecodeError) throw new GatewayError('E_VALIDATION', '图片无法解码')
      if (err instanceof ObjectStoreError) throw new GatewayError('E_UPSTREAM', '存储服务异常')
      throw err
    }
    if (Result.status === 'missing') throw new GatewayError('E_NOT_FOUND', '原图不存在')
    if (Result.status === 'unsupported') throw new GatewayError('E_VALIDATION', '对象不是可处理的图片类型')
    return c.json({ previewKey: Result.previewKey })
  })
}
