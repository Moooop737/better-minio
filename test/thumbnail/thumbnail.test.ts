import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import sharp from 'sharp'
import { CreateBucketCommand } from '@aws-sdk/client-s3'
import { getObject, putObject, statObject } from '../../src/api/objects'
import { createServiceGate } from '../../src/auth/gate'
import { createServiceTokenVerifier } from '../../src/auth/service-token'
import { parseServiceTokens } from '../../src/config'
import { createEventBus } from '../../src/core/events'
import type { EventBus } from '../../src/core/events'
import { renderJsonError } from '../../src/core/render'
import { createMemoryStateStore } from '../../src/core/state'
import type { StateStore } from '../../src/core/state'
import type { AppEnv } from '../../src/core/types'
import { isThumbnailSource, previewKeyFor } from '../../src/thumbnail/process'
import { mountThumbnail } from '../../src/thumbnail/routes'
import { startThumbnails, THUMBNAIL_QUEUE_KEY } from '../../src/thumbnail/worker'
import type { ThumbnailWorker } from '../../src/thumbnail/worker'
import { captureLogger } from '../ops/harness'
import { s3Available, startS3 } from '../helpers/s3'
import type { TestS3 } from '../helpers/s3'

const BUCKET = 'kbfile'
const BACKEND = 'b'.repeat(32)

async function jpeg(Width: number, Height: number): Promise<Buffer> {
  return sharp({ create: { width: Width, height: Height, channels: 3, background: { r: 200, g: 30, b: 60 } } }).jpeg().toBuffer()
}

describe('previewKeyFor / isThumbnailSource', () => {
  it('派生 key 约定 + 类型过滤（svg 不做，参数忽略）', () => {
    expect(previewKeyFor('a/b.jpg', 'webp')).toBe('previews/a/b.jpg.webp')
    expect(previewKeyFor('x.png', 'jpeg')).toBe('previews/x.png.jpeg')
    expect(isThumbnailSource('image/jpeg')).toBe(true)
    expect(isThumbnailSource('IMAGE/PNG; charset=binary')).toBe(true)
    expect(isThumbnailSource('image/webp')).toBe(true)
    expect(isThumbnailSource('image/gif')).toBe(true)
    expect(isThumbnailSource('image/svg+xml')).toBe(false)
    expect(isThumbnailSource('application/pdf')).toBe(false)
    expect(isThumbnailSource(null)).toBe(false)
  })
})

describe.skipIf(!s3Available)('thumbnail（moto）', () => {
  let S3: TestS3
  let Events: EventBus
  let Store: StateStore
  let Worker: ThumbnailWorker
  let Log: ReturnType<typeof captureLogger>

  beforeAll(async () => {
    S3 = await startS3()
    await S3.client.send(new CreateBucketCommand({ Bucket: BUCKET }))
  })
  afterAll(() => S3.stop())

  const start = () => {
    Events = createEventBus()
    Store = createMemoryStateStore()
    Log = captureLogger()
    Worker = startThumbnails({ internalClient: S3.client, bucket: BUCKET, stateStore: Store, events: Events, width: 300, format: 'webp', quality: 80, logger: Log.logger, pollMs: 50 })
  }
  afterEach(async () => {
    await Worker?.stop()
  })

  async function previewMeta(Key: string) {
    const Got = await getObject(S3.client, BUCKET, previewKeyFor(Key, 'webp'))
    if (Got === null) return null
    const Chunks: Buffer[] = []
    for await (const Chunk of Got.body) Chunks.push(Chunk as Buffer)
    return { contentType: Got.contentType, ...(await sharp(Buffer.concat(Chunks)).metadata()) }
  }

  it('上传 jpeg → object:put → previews/<key>.webp 宽 300', async () => {
    start()
    await putObject(S3.client, BUCKET, 'img/big.jpg', await jpeg(1200, 800), 'image/jpeg')
    Events.emit('object:put', { key: 'img/big.jpg', contentType: 'image/jpeg', size: null })
    await Worker.drain()
    const Meta = await previewMeta('img/big.jpg')
    expect(Meta).toMatchObject({ contentType: 'image/webp', format: 'webp', width: 300, height: 200 })
  })

  it('小图不放大；object:complete 同样触发', async () => {
    start()
    await putObject(S3.client, BUCKET, 'img/small.jpg', await jpeg(120, 80), 'image/jpeg')
    Events.emit('object:complete', { key: 'img/small.jpg', contentType: 'image/jpeg' })
    await Worker.drain()
    expect(await previewMeta('img/small.jpg')).toMatchObject({ width: 120, height: 80 })
  })

  it('非图片 / svg / previews/ 前缀 → 不入队、无派生', async () => {
    start()
    await putObject(S3.client, BUCKET, 'doc/a.pdf', Buffer.from('%PDF-1.4'), 'application/pdf')
    await putObject(S3.client, BUCKET, 'img/v.svg', Buffer.from('<svg/>'), 'image/svg+xml')
    await putObject(S3.client, BUCKET, 'previews/x.jpg', await jpeg(600, 600), 'image/jpeg')
    Events.emit('object:put', { key: 'doc/a.pdf', contentType: 'application/pdf', size: 8 })
    Events.emit('object:put', { key: 'img/v.svg', contentType: 'image/svg+xml', size: 6 })
    Events.emit('object:put', { key: 'previews/x.jpg', contentType: 'image/jpeg', size: null })
    Events.emit('object:put', { key: 'img/unknown', contentType: null, size: null })
    await Worker.drain()
    expect(await statObject(S3.client, BUCKET, previewKeyFor('doc/a.pdf', 'webp'))).toBeNull()
    expect(await statObject(S3.client, BUCKET, previewKeyFor('img/v.svg', 'webp'))).toBeNull()
    expect(await statObject(S3.client, BUCKET, previewKeyFor('previews/x.jpg', 'webp'))).toBeNull()
    expect(Log.lines().some((Line) => Line.msg === '缩略图入队')).toBe(false)
  })

  it('delete → 派生消失、队列中该 key 的 job 清除', async () => {
    start()
    await putObject(S3.client, BUCKET, 'img/del.jpg', await jpeg(800, 400), 'image/jpeg')
    Events.emit('object:put', { key: 'img/del.jpg', contentType: 'image/jpeg', size: null })
    await Worker.drain()
    expect(await previewMeta('img/del.jpg')).not.toBeNull()
    Events.emit('object:delete', { key: 'img/del.jpg' })
    await Worker.drain()
    expect(await statObject(S3.client, BUCKET, previewKeyFor('img/del.jpg', 'webp'))).toBeNull()

    /* 队列清除：不起消费者，直接看状态存储 */
    await Worker.stop()
    const Bus = createEventBus()
    const Queue = createMemoryStateStore()
    const Idle = startThumbnails({ internalClient: S3.client, bucket: BUCKET, stateStore: Queue, events: Bus, width: 300, format: 'webp', quality: 80, logger: captureLogger().logger, pollMs: 50 })
    await Idle.stop()
    Bus.emit('object:put', { key: 'img/del.jpg', contentType: 'image/jpeg', size: null })
    expect(await Queue.listPop(THUMBNAIL_QUEUE_KEY)).toBeNull()
  })

  it('同 key 重复入队 → 去重留最新；删除联动移除待处理 job', async () => {
    Events = createEventBus()
    Store = createMemoryStateStore()
    Log = captureLogger()
    /* stateStore 包一层：消费者 pop 永远拿不到，便于观察队列内容 */
    const Paused: StateStore = { ...Store, listPop: async () => null }
    Worker = startThumbnails({ internalClient: S3.client, bucket: BUCKET, stateStore: Paused, events: Events, width: 300, format: 'webp', quality: 80, logger: Log.logger, pollMs: 50 })
    Events.emit('object:put', { key: 'k1.jpg', contentType: 'image/jpeg', size: 1 })
    Events.emit('object:put', { key: 'k2.png', contentType: 'image/png', size: 1 })
    await Worker.drain()
    Events.emit('object:put', { key: 'k1.jpg', contentType: 'image/webp', size: 2 })
    await Worker.drain()
    const Jobs: unknown[] = []
    for (let Raw = await Store.listPop(THUMBNAIL_QUEUE_KEY); Raw !== null; Raw = await Store.listPop(THUMBNAIL_QUEUE_KEY)) Jobs.push(JSON.parse(Raw))
    expect(Jobs).toEqual([
      { key: 'k2.png', contentType: 'image/png', attempts: 0 },
      { key: 'k1.jpg', contentType: 'image/webp', attempts: 0 },
    ])
    for (const Job of Jobs) await Store.listPush(THUMBNAIL_QUEUE_KEY, JSON.stringify(Job))
    Events.emit('object:delete', { key: 'k1.jpg' })
    await Worker.drain()
    expect(JSON.parse((await Store.listPop(THUMBNAIL_QUEUE_KEY))!)).toMatchObject({ key: 'k2.png' })
    expect(await Store.listPop(THUMBNAIL_QUEUE_KEY)).toBeNull()
  })

  it('加工失败 → 总共尝试 3 次后丢弃 + error 日志，无派生', async () => {
    start()
    await putObject(S3.client, BUCKET, 'img/broken.jpg', Buffer.from('not an image at all'), 'image/jpeg')
    Events.emit('object:put', { key: 'img/broken.jpg', contentType: 'image/jpeg', size: null })
    await Worker.drain()
    const Lines = Log.lines().filter((Line) => Line.key === 'img/broken.jpg' && typeof Line.attempts === 'number')
    expect(Lines.map((Line) => [Line.level, Line.attempts])).toEqual([
      [40, 1],
      [40, 2],
      [50, 3],
    ])
    expect(await Store.listPop(THUMBNAIL_QUEUE_KEY)).toBeNull()
    expect(await statObject(S3.client, BUCKET, previewKeyFor('img/broken.jpg', 'webp'))).toBeNull()
  })

  it('覆盖上传同 key → 派生跟着更新', async () => {
    start()
    await putObject(S3.client, BUCKET, 'img/over.jpg', await jpeg(900, 900), 'image/jpeg')
    Events.emit('object:put', { key: 'img/over.jpg', contentType: 'image/jpeg', size: null })
    await Worker.drain()
    expect(await previewMeta('img/over.jpg')).toMatchObject({ width: 300, height: 300 })
    await putObject(S3.client, BUCKET, 'img/over.jpg', await jpeg(600, 150), 'image/jpeg')
    Events.emit('object:put', { key: 'img/over.jpg', contentType: 'image/jpeg', size: null })
    await Worker.drain()
    expect(await previewMeta('img/over.jpg')).toMatchObject({ width: 300, height: 75 })
  })

  describe('POST /thumbnail/generate', () => {
    const app = () => {
      const App = new Hono<AppEnv>()
      App.onError((Err, c) => renderJsonError(c, Err))
      const Gate = createServiceGate(createServiceTokenVerifier(parseServiceTokens(`backend:${BACKEND}`)))
      mountThumbnail(App, { internalClient: S3.client, bucket: BUCKET, serviceGate: Gate, rateLimit: null, width: 300, format: 'webp', quality: 80 })
      return App
    }
    const post = (App: Hono<AppEnv>, Body: unknown, Token = BACKEND) =>
      App.request('/thumbnail/generate', { method: 'POST', headers: { authorization: `Bearer ${Token}`, 'content-type': 'application/json' }, body: JSON.stringify(Body) })

    it('200 {previewKey}，派生宽 300', async () => {
      await putObject(S3.client, BUCKET, 'gen/a.png', await sharp({ create: { width: 1000, height: 500, channels: 4, background: '#00ff00' } }).png().toBuffer(), 'image/png')
      const Res = await post(app(), { key: 'gen/a.png' })
      expect(Res.status).toBe(200)
      expect(await Res.json()).toEqual({ previewKey: 'previews/gen/a.png.webp' })
      expect(await previewMeta('gen/a.png')).toMatchObject({ width: 300, height: 150 })
    })

    it('原图不存在 404 E_NOT_FOUND（文案不泄 key）', async () => {
      const Res = await post(app(), { key: 'gen/missing-secret-name.png' })
      expect(Res.status).toBe(404)
      const Text = await Res.text()
      expect(JSON.parse(Text)).toMatchObject({ code: 'E_NOT_FOUND' })
      expect(Text).not.toContain('missing-secret-name')
    })

    it('非图片 / 坏 body / previews 前缀 → 400 E_VALIDATION', async () => {
      await putObject(S3.client, BUCKET, 'gen/a.txt', Buffer.from('hi'), 'text/plain')
      await putObject(S3.client, BUCKET, 'gen/bad.jpg', Buffer.from('garbage'), 'image/jpeg')
      for (const Body of [{ key: 'gen/a.txt' }, { key: 'gen/bad.jpg' }, { key: 'previews/gen/a.png.webp' }, { nope: 1 }, { key: '' }]) {
        const Res = await post(app(), Body)
        expect(Res.status).toBe(400)
        expect(await Res.json()).toMatchObject({ code: 'E_VALIDATION' })
      }
    })

    it('无 / 错 service token → 401', async () => {
      expect((await post(app(), { key: 'gen/a.png' }, 'wrong')).status).toBe(401)
    })
  })
})
