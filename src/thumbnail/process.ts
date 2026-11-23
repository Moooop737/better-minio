/**
 * 缩略图管线 —— getObject 流 → sharp（rotate / resize width withoutEnlargement / format+quality）→ putObject 派生对象。
 * 派生 key 约定即接口：`previews/<原 key>.<format>`；派生是可再生成视图（允许覆盖，不加 If-None-Match）。
 * 可解码集合 = 设计集合（jpeg/png/webp/gif/bmp）∩ 当前 sharp 构建的输入能力（prebuilt 无 BMP loader 时 bmp 自动排除）；svg 永不做。
 * 用法：`await generateThumbnail({ client, bucket, key, width, format, quality })` → ok / missing / unsupported；解码失败抛 ThumbnailDecodeError。
 */

export { generateThumbnail, previewKeyFor, isPreviewKey, isThumbnailSource, ThumbnailDecodeError, THUMBNAIL_SOURCE_TYPES, PREVIEW_PREFIX }
export type { ThumbnailParams, ThumbnailResult }

import type { S3Client } from '@aws-sdk/client-s3'
import sharp from 'sharp'
import type { OutputInfo } from 'sharp'
import { getObject, putObject } from '../api/objects'
import type { ThumbnailFormat } from '../config'

interface ThumbnailParams {
  client: S3Client
  bucket: string
  key: string
  width: number
  format: ThumbnailFormat
  quality: number
}

type ThumbnailResult =
  | { status: 'ok'; previewKey: string; width: number; height: number }
  | { status: 'missing' }
  | { status: 'unsupported' }

const PREVIEW_PREFIX = 'previews/'

/* content-type → sharp 输入格式名 */
const DESIGN_SOURCES: Record<string, string> = {
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/x-ms-bmp': 'bmp',
}

const THUMBNAIL_SOURCE_TYPES: ReadonlySet<string> = new Set(
  Object.entries(DESIGN_SOURCES)
    .filter(([, Format]) => canDecode(Format))
    .map(([Type]) => Type),
)

const OUTPUT_TYPES: Record<ThumbnailFormat, string> = {
  webp: 'image/webp',
  jpeg: 'image/jpeg',
  png: 'image/png',
}

class ThumbnailDecodeError extends Error {
  constructor(Cause: unknown) {
    super(`图片解码失败: ${String(Cause)}`)
    this.name = 'ThumbnailDecodeError'
  }
}

async function generateThumbnail(Params: ThumbnailParams): Promise<ThumbnailResult> {
  const Source = await getObject(Params.client, Params.bucket, Params.key)
  if (Source === null) return { status: 'missing' }
  if (!isThumbnailSource(Source.contentType)) {
    Source.body.destroy()
    return { status: 'unsupported' }
  }
  const Transformer = sharp({ failOn: 'error' })
    .rotate()
    .resize({ width: Params.width, withoutEnlargement: true })
    .toFormat(Params.format, { quality: Params.quality })
  Source.body.on('error', (err) => Transformer.destroy(err))
  Source.body.pipe(Transformer)
  let Output: { data: Buffer; info: OutputInfo }
  try {
    Output = await Transformer.toBuffer({ resolveWithObject: true })
  } catch (err) {
    Source.body.destroy()
    throw new ThumbnailDecodeError(err)
  }
  const PreviewKey = previewKeyFor(Params.key, Params.format)
  await putObject(Params.client, Params.bucket, PreviewKey, Output.data, OUTPUT_TYPES[Params.format])
  return { status: 'ok', previewKey: PreviewKey, width: Output.info.width, height: Output.info.height }
}

function previewKeyFor(Key: string, Format: ThumbnailFormat): string {
  return `${PREVIEW_PREFIX}${Key}.${Format}`
}

function isPreviewKey(Key: string): boolean {
  return Key.startsWith(PREVIEW_PREFIX)
}

function isThumbnailSource(ContentType: string | null): boolean {
  if (ContentType === null) return false
  const Base = ContentType.split(';')[0]?.trim().toLowerCase() ?? ''
  return THUMBNAIL_SOURCE_TYPES.has(Base)
}

function canDecode(Format: string): boolean {
  const Info = (sharp.format as unknown as Record<string, { input?: { buffer?: boolean; stream?: boolean } } | undefined>)[Format]
  return Info?.input?.stream === true || Info?.input?.buffer === true
}
