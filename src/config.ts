/**
 * 网关配置 —— 环境变量集中一处；密钥只进进程，不打印、不进错误信息。
 * S3_INTERNAL_ENDPOINT：网关 → MinIO 的真连接（生产 127.0.0.1:9000）。
 * S3_PUBLIC_ENDPOINT：presign 签进 URL 的 Host（浏览器可见入口，Caddy 反代保持 Host）。
 */

export { loadConfig }
export type { GatewayConfig }

interface GatewayConfig {
  port: number
  host: string
  s3InternalEndpoint: string
  s3PublicEndpoint: string
  s3Region: string
  s3Bucket: string
  s3AccessKeyId: string
  s3SecretAccessKey: string
  s3ForcePathStyle: boolean
}

function loadConfig(Env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  return {
    port: intEnv(Env, 'GATEWAY_PORT', 9100),
    host: Env.GATEWAY_HOST?.trim() || '127.0.0.1',
    s3InternalEndpoint: trimSlash(required(Env, 'S3_INTERNAL_ENDPOINT')),
    s3PublicEndpoint: trimSlash(required(Env, 'S3_PUBLIC_ENDPOINT')),
    s3Region: Env.S3_REGION?.trim() || 'us-east-1',
    s3Bucket: required(Env, 'S3_BUCKET'),
    s3AccessKeyId: required(Env, 'S3_ACCESS_KEY_ID'),
    s3SecretAccessKey: required(Env, 'S3_SECRET_ACCESS_KEY'),
    s3ForcePathStyle: (Env.S3_FORCE_PATH_STYLE?.trim() ?? 'true') !== 'false',
  }
}

function required(Env: NodeJS.ProcessEnv, Name: string): string {
  const Value = Env[Name]?.trim()
  if (Value === undefined || Value === '') throw new Error(`缺少环境变量: ${Name}`)
  return Value
}

function intEnv(Env: NodeJS.ProcessEnv, Name: string, Fallback: number): number {
  const Raw = Env[Name]?.trim()
  if (Raw === undefined || Raw === '') return Fallback
  const Value = Number(Raw)
  if (!Number.isInteger(Value) || Value <= 0) throw new Error(`${Name} 需为正整数，收到: ${Raw}`)
  return Value
}

function trimSlash(Url: string): string {
  return Url.replace(/\/+$/, '')
}