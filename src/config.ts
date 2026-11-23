/**
 * 网关配置 —— 环境变量集中一处；密钥只进进程，不打印、不进错误信息。
 * S3_INTERNAL_ENDPOINT：网关 → MinIO 的真连接（生产 127.0.0.1:9000）。
 * S3_PUBLIC_ENDPOINT：presign 签进 URL 的 Host（浏览器可见入口，Caddy 反代保持 Host）。
 * 功能开关（AGENTS.md §一·三）：布尔严格解析 true/false，非法拒启；describeFeatures 给启动日志用（不含密钥）。
 */

export { loadConfig, describeFeatures, parseServiceTokens, parseCidrList }
export type { GatewayConfig, KeyScheme, ThumbnailFormat, ServiceTokenEntry, Cidr }

import { isIP } from 'node:net'

type KeyScheme = 'flat' | 'date'
type ThumbnailFormat = 'webp' | 'jpeg' | 'png'

interface ServiceTokenEntry {
  name: string
  token: string
}

interface Cidr {
  family: 4 | 6
  /* 规范化后的网络地址（bigint），与 prefix 一起做包含判断 */
  network: bigint
  prefix: number
}

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

  tokenSecret: string
  serviceTokens: ServiceTokenEntry[]
  trustedProxies: Cidr[]
  ociPushServices: string[]
  ipGateEnabled: boolean

  redisUrl: string | null
  keyScheme: KeyScheme
  corsOrigins: string[]

  multipartEnabled: boolean
  multipartSessionTtl: number

  ociEnabled: boolean
  s3RegistryBucket: string
  ociUploadTtl: number

  logLevel: string
  rateLimitEnabled: boolean
  rateLimitControl: number
  rateLimitData: number
  rateLimitOci: number
  auditEnabled: boolean
  shutdownTimeout: number

  thumbnailEnabled: boolean
  thumbnailWidth: number
  thumbnailFormat: ThumbnailFormat
  thumbnailQuality: number
}

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']

function loadConfig(Env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const TokenSecret = required(Env, 'TOKEN_SECRET')
  if (TokenSecret.length < 32) throw new Error('TOKEN_SECRET 需 ≥32 字符')
  const LogLevel = Env.LOG_LEVEL?.trim() || 'info'
  if (!LOG_LEVELS.includes(LogLevel)) throw new Error(`LOG_LEVEL 非法，收到: ${LogLevel}`)
  const Quality = intEnv(Env, 'THUMBNAIL_QUALITY', 80)
  if (Quality > 100) throw new Error(`THUMBNAIL_QUALITY 需为 1-100，收到: ${Quality}`)
  return {
    port: intEnv(Env, 'GATEWAY_PORT', 9100),
    host: Env.GATEWAY_HOST?.trim() || '127.0.0.1',
    s3InternalEndpoint: trimSlash(required(Env, 'S3_INTERNAL_ENDPOINT')),
    s3PublicEndpoint: trimSlash(required(Env, 'S3_PUBLIC_ENDPOINT')),
    s3Region: Env.S3_REGION?.trim() || 'us-east-1',
    s3Bucket: required(Env, 'S3_BUCKET'),
    s3AccessKeyId: required(Env, 'S3_ACCESS_KEY_ID'),
    s3SecretAccessKey: required(Env, 'S3_SECRET_ACCESS_KEY'),
    s3ForcePathStyle: boolEnv(Env, 'S3_FORCE_PATH_STYLE', true),

    tokenSecret: TokenSecret,
    serviceTokens: parseServiceTokens(required(Env, 'SERVICE_TOKENS')),
    trustedProxies: parseCidrList(Env.TRUSTED_PROXIES ?? ''),
    ociPushServices: listEnv(Env, 'OCI_PUSH_SERVICES', ['d1']),
    ipGateEnabled: boolEnv(Env, 'IP_GATE_ENABLED', true),

    redisUrl: Env.REDIS_URL?.trim() || null,
    keyScheme: enumEnv(Env, 'KEY_SCHEME', ['flat', 'date'] as const, 'flat'),
    corsOrigins: listEnv(Env, 'CORS_ORIGINS', []),

    multipartEnabled: boolEnv(Env, 'MULTIPART_ENABLED', true),
    multipartSessionTtl: intEnv(Env, 'MULTIPART_SESSION_TTL', 86400),

    ociEnabled: boolEnv(Env, 'OCI_ENABLED', false),
    s3RegistryBucket: Env.S3_REGISTRY_BUCKET?.trim() || 'kcregistry',
    ociUploadTtl: intEnv(Env, 'OCI_UPLOAD_TTL', 3600),

    logLevel: LogLevel,
    rateLimitEnabled: boolEnv(Env, 'RATE_LIMIT_ENABLED', true),
    rateLimitControl: intEnv(Env, 'RATE_LIMIT_CONTROL', 60),
    rateLimitData: intEnv(Env, 'RATE_LIMIT_DATA', 300),
    rateLimitOci: intEnv(Env, 'RATE_LIMIT_OCI', 120),
    auditEnabled: boolEnv(Env, 'AUDIT_ENABLED', true),
    shutdownTimeout: intEnv(Env, 'SHUTDOWN_TIMEOUT', 30),

    thumbnailEnabled: boolEnv(Env, 'THUMBNAIL_ENABLED', false),
    thumbnailWidth: intEnv(Env, 'THUMBNAIL_WIDTH', 300),
    thumbnailFormat: enumEnv(Env, 'THUMBNAIL_FORMAT', ['webp', 'jpeg', 'png'] as const, 'webp'),
    thumbnailQuality: Quality,
  }
}

/* 生效功能集（启动日志）；只含开关与非密钥参数 */
function describeFeatures(Config: GatewayConfig): Record<string, unknown> {
  return {
    multipart: Config.multipartEnabled,
    oci: Config.ociEnabled,
    ipGate: Config.ipGateEnabled,
    rateLimit: Config.rateLimitEnabled,
    audit: Config.auditEnabled,
    thumbnail: Config.thumbnailEnabled,
    keyScheme: Config.keyScheme,
    cors: Config.corsOrigins.length > 0 ? Config.corsOrigins : false,
    state: Config.redisUrl === null ? 'memory' : 'redis',
    bucket: Config.s3Bucket,
    services: Config.serviceTokens.map((Entry) => Entry.name),
  }
}

const SERVICE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/
const SERVICE_TOKEN_RE = /^[A-Za-z0-9_-]{32,}$/

function parseServiceTokens(Raw: string): ServiceTokenEntry[] {
  const Entries: ServiceTokenEntry[] = []
  for (const Part of Raw.split(',')) {
    const Item = Part.trim()
    if (Item === '') continue
    const Index = Item.indexOf(':')
    if (Index <= 0) throw new Error('SERVICE_TOKENS 格式需为 name:token 逗号列表')
    const Name = Item.slice(0, Index)
    const Token = Item.slice(Index + 1)
    if (!SERVICE_NAME_RE.test(Name)) throw new Error(`SERVICE_TOKENS 服务名非法: ${Name}`)
    if (!SERVICE_TOKEN_RE.test(Token)) throw new Error(`SERVICE_TOKENS 中 ${Name} 的 token 需匹配 [A-Za-z0-9_-]{32,}`)
    if (Entries.some((Entry) => Entry.name === Name)) throw new Error(`SERVICE_TOKENS 服务名重复: ${Name}`)
    Entries.push({ name: Name, token: Token })
  }
  if (Entries.length === 0) throw new Error('SERVICE_TOKENS 至少一项')
  return Entries
}

function parseCidrList(Raw: string): Cidr[] {
  const Out: Cidr[] = []
  for (const Part of Raw.split(',')) {
    const Item = Part.trim()
    if (Item === '') continue
    const [Addr = '', PrefixRaw] = Item.split('/')
    const Family = isIP(Addr)
    if (Family === 0) throw new Error(`TRUSTED_PROXIES 地址非法: ${Item}`)
    const Bits = Family === 4 ? 32 : 128
    const Prefix = PrefixRaw === undefined ? Bits : Number(PrefixRaw)
    if (!Number.isInteger(Prefix) || Prefix < 0 || Prefix > Bits) throw new Error(`TRUSTED_PROXIES 前缀非法: ${Item}`)
    Out.push({ family: Family as 4 | 6, network: maskAddress(ipToBigInt(Addr), Bits, Prefix), prefix: Prefix })
  }
  return Out
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

function boolEnv(Env: NodeJS.ProcessEnv, Name: string, Fallback: boolean): boolean {
  const Raw = Env[Name]?.trim()
  if (Raw === undefined || Raw === '') return Fallback
  if (Raw === 'true') return true
  if (Raw === 'false') return false
  throw new Error(`${Name} 需为 true 或 false，收到: ${Raw}`)
}

function enumEnv<T extends string>(Env: NodeJS.ProcessEnv, Name: string, Allowed: readonly T[], Fallback: T): T {
  const Raw = Env[Name]?.trim()
  if (Raw === undefined || Raw === '') return Fallback
  const Hit = Allowed.find((Value) => Value === Raw)
  if (Hit === undefined) throw new Error(`${Name} 需为 ${Allowed.join('|')}，收到: ${Raw}`)
  return Hit
}

function listEnv(Env: NodeJS.ProcessEnv, Name: string, Fallback: string[]): string[] {
  const Raw = Env[Name]
  if (Raw === undefined) return Fallback
  return Raw.split(',').map((Item) => Item.trim()).filter((Item) => Item !== '')
}

function trimSlash(Url: string): string {
  return Url.replace(/\/+$/, '')
}

function ipToBigInt(Addr: string): bigint {
  if (isIP(Addr) === 4) {
    return Addr.split('.').reduce((Acc, Octet) => (Acc << 8n) + BigInt(Number(Octet)), 0n)
  }
  const [Head = '', Tail] = Addr.split('::')
  const HeadParts = Head === '' ? [] : Head.split(':')
  const TailParts = Tail === undefined || Tail === '' ? [] : Tail.split(':')
  const Expand = (Parts: string[]): string[] =>
    Parts.flatMap((Part) => {
      if (Part.includes('.')) {
        const V4 = ipToBigInt(Part)
        return [((V4 >> 16n) & 0xffffn).toString(16), (V4 & 0xffffn).toString(16)]
      }
      return [Part]
    })
  const H = Expand(HeadParts)
  const T = Expand(TailParts)
  const Fill = Tail === undefined ? [] : new Array<string>(8 - H.length - T.length).fill('0')
  return [...H, ...Fill, ...T].reduce((Acc, Group) => (Acc << 16n) + BigInt(parseInt(Group, 16)), 0n)
}

function maskAddress(Value: bigint, Bits: number, Prefix: number): bigint {
  const Host = BigInt(Bits - Prefix)
  return (Value >> Host) << Host
}

export { ipToBigInt, maskAddress }
