/**
 * better-minio 入口 —— 读 config，建 internal S3 client，启动 ensureBucket、/health 探活。
 * 各 feature 路由（proxy / presign / auth / multipart / oci / ops）按 AGENTS.md 实现后挂到 app；
 * public 签名 client 随 presign 一起加，先不建避免空壳。
 */

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { loadConfig } from './config'
import { createS3Client } from './api/client'
import { ensureBucket, pingBucket } from './api/bucket'

const Config = loadConfig()

const Internal = createS3Client({
  endpoint: Config.s3InternalEndpoint,
  region: Config.s3Region,
  forcePathStyle: Config.s3ForcePathStyle,
  accessKeyId: Config.s3AccessKeyId,
  secretAccessKey: Config.s3SecretAccessKey,
})

const app = new Hono()

app.get('/health', async (c) => {
  try {
    await pingBucket(Internal, Config.s3Bucket)
    return c.json({ ok: true, bucket: Config.s3Bucket })
  } catch {
    return c.json({ ok: false, bucket: Config.s3Bucket }, 503)
  }
})

await ensureBucket(Internal, Config.s3Bucket).catch((err: unknown) => {
  console.warn(`[better-minio] ensureBucket 失败（服务照起）: ${String(err)}`)
})

serve({ fetch: app.fetch, port: Config.port, hostname: Config.host }, (info) => {
  console.log(`[better-minio] listening :${info.port} → MinIO ${Config.s3InternalEndpoint}`)
})