/**
 * better-minio 入口 —— 读 config → 建 internal/public S3 client、StateStore（Redis/内存）、事件总线
 * → ensureBucket（业务桶；OCI 开启时 registry 桶）→ buildApp 挂路由 → serve → 后台任务 → 优雅关闭。
 * 启动日志打印生效功能集（不含密钥）；IP 闸关闭时告警；REDIS_URL 给了却连不上 → 拒启（exit 1）。
 */

import { serve } from '@hono/node-server'
import { describeFeatures, loadConfig } from './config'
import { createS3Client } from './api/client'
import { ensureBucket } from './api/bucket'
import { createEventBus } from './core/events'
import { createStateStore } from './core/state'
import { buildApp, startBackground } from './app'
import { logger } from './ops/logger'
import { createShutdown } from './ops/shutdown'

const Config = (() => {
  try {
    return loadConfig()
  } catch (err) {
    logger.fatal({ err: { message: (err as Error).message } }, '配置非法，拒启')
    process.exit(1)
  }
})()
logger.level = Config.logLevel

const ClientBase = {
  region: Config.s3Region,
  forcePathStyle: Config.s3ForcePathStyle,
  accessKeyId: Config.s3AccessKeyId,
  secretAccessKey: Config.s3SecretAccessKey,
}
const Internal = createS3Client({ ...ClientBase, endpoint: Config.s3InternalEndpoint })
const Public = createS3Client({ ...ClientBase, endpoint: Config.s3PublicEndpoint })

const StateStore = await createStateStore(Config.redisUrl).catch((err: unknown) => {
  logger.fatal({ err: { message: (err as Error).message } }, 'StateStore 初始化失败，拒启')
  process.exit(1)
})
const Events = createEventBus()
const Deps = { internal: Internal, publicClient: Public, stateStore: StateStore, events: Events, logger }

const Buckets = Config.ociEnabled ? [Config.s3Bucket, Config.s3RegistryBucket] : [Config.s3Bucket]
for (const Bucket of Buckets) {
  await ensureBucket(Internal, Bucket).catch((err: unknown) => {
    logger.warn({ bucket: Bucket, err: { name: (err as Error).name } }, 'ensureBucket 失败（服务照起）')
  })
}

const App = buildApp(Config, Deps)
const Background = startBackground(Config, Deps)

logger.info({ features: describeFeatures(Config) }, '生效功能集')
if (!Config.ipGateEnabled) logger.warn('IP 闸已禁用（IP_GATE_ENABLED=false）：数据面不再比对客户端 IP')

const Server = serve({ fetch: App.fetch, port: Config.port, hostname: Config.host }, (Info) => {
  logger.info({ port: Info.port }, 'better-minio listening')
})

const Shutdown = createShutdown({ server: Server, timeoutMs: Config.shutdownTimeout * 1000, logger })
for (const Task of Background) Shutdown.register(Task.name, () => Task.stop())
Shutdown.register('state-store', () => StateStore.close())
Shutdown.register('s3-clients', () => {
  Internal.destroy()
  Public.destroy()
})
Shutdown.install()
