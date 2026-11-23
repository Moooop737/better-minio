/**
 * api/registry 原语 —— moto 真 S3 API：putStream 单片 / 多片（>8 MiB）往返一致、源流错误原样透传；
 * putBytes 条件写语义；getStream Range / 越界；copyObject；listByPrefix；deleteMany。
 */

import { createHash, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ensureBucket } from '../../src/api/bucket'
import { copyObject, deleteMany, getBytes, getStream, listByPrefix, putBytes, putStream, STREAM_PART_SIZE } from '../../src/api/registry'
import { startS3, s3Available } from '../helpers/s3'
import type { TestS3 } from '../helpers/s3'

const BUCKET = 'registry-api'

describe.skipIf(!s3Available)('api/registry', () => {
  let S3: TestS3

  beforeAll(async () => {
    S3 = await startS3()
    await ensureBucket(S3.client, BUCKET)
  }, 30_000)

  afterAll(async () => {
    await S3?.stop()
  })

  it('putStream 单片：小对象一次 PutObject，内容一致', async () => {
    const Data = Buffer.from('hello registry')
    const Res = await putStream(S3.client, BUCKET, 'small', chunked(Data, 3))
    expect(Res.size).toBe(Data.byteLength)
    expect((await getBytes(S3.client, BUCKET, 'small'))?.body.equals(Data)).toBe(true)
  })

  it('putStream 空流写 0 字节对象', async () => {
    const Res = await putStream(S3.client, BUCKET, 'empty', chunked(Buffer.alloc(0), 1))
    expect(Res.size).toBe(0)
    expect((await getBytes(S3.client, BUCKET, 'empty'))?.body.byteLength).toBe(0)
  })

  it('putStream 多片：>8 MiB 走 multipart，SHA-256 一致', async () => {
    const Data = randomBytes(STREAM_PART_SIZE * 2 + 12345)
    const Res = await putStream(S3.client, BUCKET, 'large', chunked(Data, 64 * 1024))
    expect(Res.size).toBe(Data.byteLength)
    const Back = await getStream(S3.client, BUCKET, 'large')
    if (Back === null || Back.kind !== 'ok') throw new Error('missing')
    const Hash = createHash('sha256')
    for await (const Piece of Back.body) Hash.update(Piece as Buffer)
    expect(Hash.digest('hex')).toBe(sha(Data))
  }, 60_000)

  it('putStream 源流抛错原样透传，multipart 被 abort 不留对象', async () => {
    const Boom = new Error('source failed')
    async function* failing(): AsyncGenerator<Uint8Array> {
      yield randomBytes(STREAM_PART_SIZE + 10)
      throw Boom
    }
    await expect(putStream(S3.client, BUCKET, 'aborted', failing())).rejects.toBe(Boom)
    expect(await getBytes(S3.client, BUCKET, 'aborted')).toBeNull()
  })

  it('putBytes If-None-Match:* 已存在 → ok:false；If-Match 错 etag → ok:false、对 etag → 写入', async () => {
    const First = await putBytes(S3.client, BUCKET, 'cond', Buffer.from('a'), { contentType: 'text/plain', ifNoneMatch: '*' })
    expect(First.ok).toBe(true)
    expect((await putBytes(S3.client, BUCKET, 'cond', Buffer.from('b'), { contentType: 'text/plain', ifNoneMatch: '*' })).ok).toBe(false)
    expect((await putBytes(S3.client, BUCKET, 'cond', Buffer.from('c'), { contentType: 'text/plain', ifMatch: '"nope"' })).ok).toBe(false)
    const Current = await getBytes(S3.client, BUCKET, 'cond')
    expect(Current?.body.toString()).toBe('a')
    const Next = await putBytes(S3.client, BUCKET, 'cond', Buffer.from('d'), { contentType: 'text/plain', ifMatch: Current?.etag ?? '' })
    expect(Next.ok).toBe(true)
    expect((await getBytes(S3.client, BUCKET, 'cond'))?.body.toString()).toBe('d')
  })

  it('getStream Range → partial + Content-Range；越界 → range-not-satisfiable；不存在 → null', async () => {
    await putBytes(S3.client, BUCKET, 'ranged', Buffer.from('0123456789'), { contentType: 'text/plain' })
    const Part = await getStream(S3.client, BUCKET, 'ranged', 'bytes=2-4')
    if (Part === null || Part.kind !== 'ok') throw new Error('missing')
    expect(Part.partial).toBe(true)
    expect(Part.contentRange).toBe('bytes 2-4/10')
    expect(Buffer.concat(await collect(Part.body)).toString()).toBe('234')
    expect((await getStream(S3.client, BUCKET, 'ranged', 'bytes=100-200'))?.kind).toBe('range-not-satisfiable')
    expect(await getStream(S3.client, BUCKET, 'nope')).toBeNull()
  })

  it('copyObject / listByPrefix / deleteMany', async () => {
    await putBytes(S3.client, BUCKET, 'dir/a', Buffer.from('x'), { contentType: 'text/plain' })
    await copyObject(S3.client, BUCKET, 'dir/a', 'dir/b')
    expect((await getBytes(S3.client, BUCKET, 'dir/b'))?.body.toString()).toBe('x')
    const Listed = await listByPrefix(S3.client, BUCKET, 'dir/')
    expect(Listed.map((Item) => Item.key).sort()).toEqual(['dir/a', 'dir/b'])
    expect(Listed.every((Item) => Item.lastModified instanceof Date)).toBe(true)
    expect(await deleteMany(S3.client, BUCKET, ['dir/a', 'dir/b', 'dir/missing'])).toBe(3)
    expect(await listByPrefix(S3.client, BUCKET, 'dir/')).toEqual([])
  })
})

async function* chunked(Data: Buffer, Size: number): AsyncGenerator<Uint8Array> {
  for (let At = 0; At < Data.byteLength; At += Size) yield Data.subarray(At, At + Size)
}

async function collect(Stream: AsyncIterable<unknown>): Promise<Buffer[]> {
  const Out: Buffer[] = []
  for await (const Piece of Stream) Out.push(Piece as Buffer)
  return Out
}

function sha(Data: Buffer): string {
  return createHash('sha256').update(Data).digest('hex')
}
