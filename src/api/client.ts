/**
 * S3 兼容客户端工厂 —— 同一工厂按 endpoint 建两个实例：
 *   internal：网关 → MinIO 真连接（S3_INTERNAL_ENDPOINT），数据面转发用。
 *   public：presign 签进 URL 的 Host（S3_PUBLIC_ENDPOINT），只用于签名。
 * MinIO 不保证支持 SDK 默认附加的 CRC 校验和，故 checksum 一律 WHEN_REQUIRED。
 */

export { createS3Client }
export type { S3ClientOptions }

import { S3Client } from '@aws-sdk/client-s3'

interface S3ClientOptions {
  endpoint: string
  region: string
  forcePathStyle: boolean
  accessKeyId: string
  secretAccessKey: string
}

function createS3Client(Options: S3ClientOptions): S3Client {
  return new S3Client({
    endpoint: Options.endpoint,
    region: Options.region,
    forcePathStyle: Options.forcePathStyle,
    credentials: {
      accessKeyId: Options.accessKeyId,
      secretAccessKey: Options.secretAccessKey,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
}