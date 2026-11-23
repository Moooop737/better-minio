/**
 * 测试用网关装配 —— 按 lead 的装配契约拼一个最小 app：requestId 中间件 + 按路径分派 onError
 * （/presign /objects → JSON，其余 → S3 XML）+ mountPresign + mountProxyControl + mountProxyData（最后挂）。
 * 真实 node server（127.0.0.1:随机端口），public client 的 endpoint = 网关自身地址（presigned URL 直打网关）。
 */

export { startGateway, SERVICE_TOKEN, SERVICE_NAME, TEST_SECRET }
export type { Gateway, GatewayOptions }

import { serve } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import type { AddressInfo } from 'node:net'
import { createS3Client } from '../../src/api/client'
import { createDataPlaneGate, createServiceGate } from '../../src/auth/gate'
import { createServiceTokenVerifier } from '../../src/auth/service-token'
import { createTokenService } from '../../src/auth/token'
import type { TokenService } from '../../src/auth/token'
import { parseCidrList } from '../../src/config'
import type { KeyScheme } from '../../src/config'
import { createEventBus } from '../../src/core/events'
import type { EventBus } from '../../src/core/events'
import { renderJsonError } from '../../src/core/render'
import type { AppEnv, RateLimit } from '../../src/core/types'
import { mountPresign } from '../../src/presign/routes'
import { mountProxyControl, mountProxyData } from '../../src/proxy/routes'
import { renderS3Error } from '../../src/proxy/s3-error'
import { TEST_ACCESS_KEY, TEST_SECRET_KEY } from '../helpers/s3'

const SERVICE_NAME = 'backend'
const SERVICE_TOKEN = 'svc_token_abcdefghijklmnopqrstuvwxyz012345'
const TEST_SECRET = 'jwt-secret-for-tests-0123456789abcdef'

interface GatewayOptions {
  s3Endpoint: string
  bucket: string
  trustedProxies?: string
  corsOrigins?: string[]
  keyScheme?: KeyScheme
  ipGateEnabled?: boolean
  rateLimit?: RateLimit | null
  now?: () => Date
}

interface Gateway {
  url: string
  events: EventBus
  tokens: TokenService
  presign(Op: 'put' | 'get', Body: Record<string, unknown>): Promise<Response>
  control(Path: string, Body: unknown, Token?: string | null): Promise<Response>
  close(): Promise<void>
}

async function startGateway(Options: GatewayOptions): Promise<Gateway> {
  const App = new Hono<AppEnv>()
  let Seq = 0
  App.use(async (c, next) => {
    c.set('requestId', `req-${++Seq}`)
    await next()
  })
  App.onError((Err, c) => {
    const Path = new URL(c.req.url).pathname
    return /^\/(presign|objects)(\/|$)/.test(Path) ? renderJsonError(c, Err) : renderS3Error(c, Err)
  })
  const Server: ServerType = serve({ fetch: App.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise<void>((Resolve) => (Server.listening ? Resolve() : Server.once('listening', () => Resolve())))
  const Url = `http://127.0.0.1:${(Server.address() as AddressInfo).port}`

  const Events = createEventBus()
  const Tokens = createTokenService(TEST_SECRET)
  const ServiceGate = createServiceGate(createServiceTokenVerifier([{ name: SERVICE_NAME, token: SERVICE_TOKEN }]))
  const ClientOptions = { region: 'us-east-1', forcePathStyle: true, accessKeyId: TEST_ACCESS_KEY, secretAccessKey: TEST_SECRET_KEY }
  const Public = createS3Client({ ...ClientOptions, endpoint: Url })
  const Internal = createS3Client({ ...ClientOptions, endpoint: Options.s3Endpoint })
  const RateLimit = Options.rateLimit ?? null

  mountPresign(App, {
    publicClient: Public,
    bucket: Options.bucket,
    tokens: Tokens,
    serviceGate: ServiceGate,
    keyScheme: Options.keyScheme ?? 'flat',
    rateLimit: RateLimit,
    ...(Options.now !== undefined ? { now: Options.now } : {}),
  })
  mountProxyControl(App, { internal: Internal, bucket: Options.bucket, serviceGate: ServiceGate, events: Events, rateLimit: RateLimit })
  const Data = mountProxyData(App, {
    internalEndpoint: Options.s3Endpoint,
    bucket: Options.bucket,
    dataPlaneGate: createDataPlaneGate({
      tokens: Tokens,
      bucket: Options.bucket,
      trustedProxies: parseCidrList(Options.trustedProxies ?? ''),
      ipGateEnabled: Options.ipGateEnabled ?? true,
    }),
    corsOrigins: Options.corsOrigins ?? [],
    events: Events,
    rateLimit: RateLimit,
  })

  const post = (Path: string, Body: unknown, Token: string | null): Promise<Response> =>
    fetch(`${Url}${Path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(Token !== null ? { authorization: `Bearer ${Token}` } : {}) },
      body: typeof Body === 'string' ? Body : JSON.stringify(Body),
    })

  return {
    url: Url,
    events: Events,
    tokens: Tokens,
    presign: (Op, Body) => post(`/presign/${Op}`, Body, SERVICE_TOKEN),
    control: (Path, Body, Token = SERVICE_TOKEN) => post(Path, Body, Token),
    async close() {
      ;(Server as import('node:http').Server).closeAllConnections()
      await new Promise<void>((Resolve) => Server.close(() => Resolve()))
      await Data.close()
      Public.destroy()
      Internal.destroy()
    },
  }
}
