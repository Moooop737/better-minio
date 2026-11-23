/**
 * 对象操作 —— put / stat / get / delete，错误统一成 ObjectStoreError；SDK 类型不泄出。
 * get/stat 在对象不存在时返回 null；get 返回 Readable body + Range 支持；put 支持 If-None-Match 条件写。
 */

export { putObject, statObject, getObject, deleteObject }

import { PutObjectCommand, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import type { GetObjectCommandInput, PutObjectCommandInput, S3Client } from '@aws-sdk/client-s3'
import { ObjectStoreError } from './object-store'
import type { ObjectStat, ObjectBody, ObjectGetOptions, ObjectPutOptions } from './object-store'

async function putObject(
  Client: S3Client,
  Bucket: string,
  Key: string,
  Body: Uint8Array,
  ContentType: string,
  Options?: ObjectPutOptions,
): Promise<void> {
  const input: PutObjectCommandInput = { Bucket, Key, Body, ContentType }
  if (Options?.ifNoneMatch !== undefined) input.IfNoneMatch = Options.ifNoneMatch
  try {
    await Client.send(new PutObjectCommand(input))
  } catch (err) {
    throw new ObjectStoreError(`put ${Key} 失败`, err)
  }
}

async function statObject(Client: S3Client, Bucket: string, Key: string): Promise<ObjectStat | null> {
  try {
    const res = await Client.send(new HeadObjectCommand({ Bucket, Key }))
    return {
      size: res.ContentLength ?? 0,
      contentType: res.ContentType ?? null,
      etag: res.ETag ?? null,
    }
  } catch (err) {
    if (isNotFound(err)) return null
    throw new ObjectStoreError(`stat ${Key} 失败`, err)
  }
}

async function getObject(
  Client: S3Client,
  Bucket: string,
  Key: string,
  Options?: ObjectGetOptions,
): Promise<ObjectBody | null> {
  const input: GetObjectCommandInput = { Bucket, Key }
  if (Options?.range !== undefined) input.Range = Options.range
  try {
    const res = await Client.send(new GetObjectCommand(input))
    if (!res.Body) throw new ObjectStoreError(`get ${Key} 响应没有 body`)
    return {
      body: res.Body as ObjectBody['body'],
      contentType: res.ContentType ?? null,
      contentLength: res.ContentLength ?? null,
      etag: res.ETag ?? null,
    }
  } catch (err) {
    if (isNotFound(err)) return null
    if (err instanceof ObjectStoreError) throw err
    throw new ObjectStoreError(`get ${Key} 失败`, err)
  }
}

async function deleteObject(Client: S3Client, Bucket: string, Key: string): Promise<void> {
  try {
    await Client.send(new DeleteObjectCommand({ Bucket, Key }))
  } catch (err) {
    throw new ObjectStoreError(`delete ${Key} 失败`, err)
  }
}

function isNotFound(err: unknown): boolean {
  const Name = (err as { name?: unknown } | null)?.name
  const Status = (err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode
  return Name === 'NotFound' || Name === 'NoSuchKey' || Status === 404
}