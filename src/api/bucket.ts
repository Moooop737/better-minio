/**
 * 桶探针 —— ping（HeadBucket，2s）/ ensureBucket（HeadBucket→404 则 CreateBucket，各 3s 上限）。
 * 启动连不上只告警、服务照起；真正用到时再报错（同 server 口径）。
 */

export { pingBucket, ensureBucket }

import { HeadBucketCommand, CreateBucketCommand } from '@aws-sdk/client-s3'
import type { S3Client } from '@aws-sdk/client-s3'

async function pingBucket(Client: S3Client, Bucket: string): Promise<void> {
  await Client.send(new HeadBucketCommand({ Bucket }), { abortSignal: AbortSignal.timeout(2000) })
}

async function ensureBucket(Client: S3Client, Bucket: string): Promise<void> {
  try {
    await Client.send(new HeadBucketCommand({ Bucket }), { abortSignal: AbortSignal.timeout(3000) })
    return
  } catch (err) {
    if (!isNotFound(err)) throw err
  }
  try {
    await Client.send(new CreateBucketCommand({ Bucket }), { abortSignal: AbortSignal.timeout(3000) })
  } catch (err) {
    if (isAlreadyExists(err)) return
    throw err
  }
}

function isNotFound(err: unknown): boolean {
  const Name = (err as { name?: unknown } | null)?.name
  const Status = (err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode
  return Name === 'NotFound' || Name === 'NoSuchKey' || Status === 404
}

function isAlreadyExists(err: unknown): boolean {
  const Name = (err as { name?: unknown } | null)?.name
  return Name === 'BucketAlreadyOwnedByYou' || Name === 'BucketAlreadyExists'
}