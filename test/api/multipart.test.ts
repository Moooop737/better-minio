import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CreateBucketCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  listParts,
  presignUploadPart,
} from '../../src/api/multipart'
import { ObjectStoreError } from '../../src/api/object-store'
import { startS3, s3Available } from '../helpers/s3'
import type { TestS3 } from '../helpers/s3'

const BUCKET = 'mp-api'
const MiB = 1024 * 1024

describe.skipIf(!s3Available)('api/multipart（moto）', () => {
  let S3: TestS3

  beforeAll(async () => {
    S3 = await startS3()
    await S3.client.send(new CreateBucketCommand({ Bucket: BUCKET }))
  }, 30000)

  afterAll(async () => {
    await S3?.stop()
  })

  async function putPart(Key: string, UploadId: string, PartNumber: number, Body: Uint8Array): Promise<string> {
    const Url = await presignUploadPart(S3.client, BUCKET, Key, UploadId, PartNumber, { expiresIn: 60 })
    const Res = await fetch(Url, { method: 'PUT', body: Body })
    expect(Res.status).toBe(200)
    return Res.headers.get('etag') ?? ''
  }

  it('create → presign part → PUT → listParts → complete：对象内容一致', async () => {
    const Key = 'api/roundtrip.bin'
    const UploadId = await createMultipartUpload(S3.client, BUCKET, Key, { contentType: 'application/zip' })
    expect(UploadId).not.toBe('')
    const A = new Uint8Array(5 * MiB).fill(1)
    const B = new Uint8Array(1234).fill(2)
    const EtagB = await putPart(Key, UploadId, 2, B)
    const EtagA = await putPart(Key, UploadId, 1, A)
    const Parts = await listParts(S3.client, BUCKET, Key, UploadId)
    expect(Parts?.map((P) => [P.partNumber, P.size, P.etag])).toEqual([
      [1, 5 * MiB, EtagA],
      [2, 1234, EtagB],
    ])
    const Done = await completeMultipartUpload(S3.client, BUCKET, Key, UploadId, [
      { partNumber: 1, etag: EtagA },
      { partNumber: 2, etag: EtagB },
    ])
    expect(Done?.etag).toBeTruthy()
    const Obj = await S3.client.send(new GetObjectCommand({ Bucket: BUCKET, Key }))
    const Bytes = new Uint8Array(await Obj.Body!.transformToByteArray())
    expect(Bytes.length).toBe(5 * MiB + 1234)
    expect(Bytes[0]).toBe(1)
    expect(Bytes[5 * MiB]).toBe(2)
    expect(Obj.ContentType).toBe('application/zip')
  }, 30000)

  it('listParts 自动翻页聚合（>1000 片）并升序', async () => {
    const Key = 'api/many.bin'
    const UploadId = await createMultipartUpload(S3.client, BUCKET, Key)
    const Numbers = Array.from({ length: 1003 }, (_, I) => I + 1)
    // 小片直传（moto 只在 complete 时查 5MiB 下限），并发分批
    for (let I = 0; I < Numbers.length; I += 100) {
      await Promise.all(Numbers.slice(I, I + 100).map((N) => putPart(Key, UploadId, N, new Uint8Array([N % 256]))))
    }
    const Parts = await listParts(S3.client, BUCKET, Key, UploadId)
    expect(Parts?.length).toBe(1003)
    expect(Parts?.map((P) => P.partNumber)).toEqual(Numbers)
    await abortMultipartUpload(S3.client, BUCKET, Key, UploadId)
  }, 60000)

  // complete 遇 NoSuchUpload → null 的分支 moto 测不了（moto 对未知 uploadId 的 complete 回 500 HTML），只测 listParts / abort
  it('未知 uploadId：listParts → null；abort 幂等不抛', async () => {
    const Key = 'api/gone.bin'
    const UploadId = await createMultipartUpload(S3.client, BUCKET, Key)
    await abortMultipartUpload(S3.client, BUCKET, Key, UploadId)
    await abortMultipartUpload(S3.client, BUCKET, Key, UploadId)
    expect(await listParts(S3.client, BUCKET, Key, UploadId)).toBeNull()
  })

  it('presignUploadPart：URL 含 partNumber / uploadId / extraQuery，不签 content-type', async () => {
    const Url = new URL(
      await presignUploadPart(S3.client, BUCKET, 'api/sig.bin', 'upload-123', 7, {
        expiresIn: 120,
        extraQuery: { access_token: 'tok' },
      }),
    )
    expect(Url.pathname).toBe(`/${BUCKET}/api/sig.bin`)
    expect(Url.searchParams.get('partNumber')).toBe('7')
    expect(Url.searchParams.get('uploadId')).toBe('upload-123')
    expect(Url.searchParams.get('access_token')).toBe('tok')
    expect(Url.searchParams.get('X-Amz-Expires')).toBe('120')
    expect(Url.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
  })

  it('presignUploadPart：expiresIn 越界抛 ObjectStoreError', async () => {
    await expect(presignUploadPart(S3.client, BUCKET, 'k', 'u', 1, { expiresIn: 0 })).rejects.toBeInstanceOf(ObjectStoreError)
    await expect(presignUploadPart(S3.client, BUCKET, 'k', 'u', 1, { expiresIn: 604801 })).rejects.toBeInstanceOf(ObjectStoreError)
  })
})
