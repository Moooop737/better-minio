/**
 * OCI 测试装配 —— 按 lead 装配契约拼最小 app：mountTokenRoute + mountOci，onError 按路径分派
 * （/v2* → renderDistributionError，其余 → renderJsonError）；真实 node server（127.0.0.1:随机端口）。
 * 客户端侧 helper 模拟 OCI client（oras）行为：Basic 换 bearer → 带 Authorization 打 /v2/*。
 */

export { startRegistry, D1_TOKEN, D2_TOKEN, REGISTRY_BUCKET }
export type { Registry, RegistryOptions }

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import type { AddressInfo } from 'node:net'
import type { S3Client } from '@aws-sdk/client-s3'
import { createOciGate } from '../../src/auth/gate'
import { mountTokenRoute } from '../../src/auth/routes'
import { createServiceTokenVerifier } from '../../src/auth/service-token'
import { createTokenService } from '../../src/auth/token'
import { renderJsonError } from '../../src/core/render'
import { createMemoryStateStore } from '../../src/core/state'
import type { StateStore } from '../../src/core/state'
import type { AppEnv, RateLimit } from '../../src/core/types'
import { renderDistributionError } from '../../src/oci/errors'
import { mountOci } from '../../src/oci/routes'

const D1_TOKEN = 'd1_token_abcdefghijklmnopqrstuvwxyz0123456'
const D2_TOKEN = 'd2_token_abcdefghijklmnopqrstuvwxyz0123456'
const TEST_SECRET = 'jwt-secret-for-oci-tests-0123456789abcdef'
const REGISTRY_BUCKET = 'kcregistry'

interface RegistryOptions {
  client: S3Client
  stateStore?: StateStore
  uploadTtl?: number
  rateLimit?: RateLimit | null
}

/* body 允许 Buffer（测试数据），发送前转成独立 Uint8Array */
type CallInit = Omit<RequestInit, 'body'> & { body?: Uint8Array | string }

interface Registry {
  url: string
  stateStore: StateStore
  /* Basic 换 bearer（scope 例：repository:kcplan/demo:pull,push） */
  token(Service: 'd1' | 'd2', Scope: string): Promise<string>
  /* 带 bearer 打 /v2/*（Path 以 / 开头） */
  call(Path: string, Bearer: string | null, Init?: CallInit): Promise<Response>
  close(): Promise<void>
}

async function startRegistry(Options: RegistryOptions): Promise<Registry> {
  const App = new Hono<AppEnv>()
  App.onError((err, c) => (c.req.path.startsWith('/v2') ? renderDistributionError(c, err) : renderJsonError(c, err)))
  const Tokens = createTokenService(TEST_SECRET)
  const Verifier = createServiceTokenVerifier([
    { name: 'd1', token: D1_TOKEN },
    { name: 'd2', token: D2_TOKEN },
  ])
  const StateStore_ = Options.stateStore ?? createMemoryStateStore()

  let Url = ''
  mountTokenRoute(App, { tokens: Tokens, verifier: Verifier, pushServices: ['d1'] })
  mountOci(App, {
    internalClient: Options.client,
    registryBucket: REGISTRY_BUCKET,
    stateStore: StateStore_,
    ociGate: { authorize: (c, Name, Action) => createOciGate(Tokens, Url).authorize(c, Name, Action) },
    uploadTtl: Options.uploadTtl ?? 3600,
    rateLimit: Options.rateLimit ?? null,
  })

  const Server = serve({ fetch: App.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise<void>((Resolve) => Server.once('listening', () => Resolve()))
  Url = `http://127.0.0.1:${(Server.address() as AddressInfo).port}`

  return {
    url: Url,
    stateStore: StateStore_,
    async token(Service, Scope) {
      const Basic = Buffer.from(`${Service}:${Service === 'd1' ? D1_TOKEN : D2_TOKEN}`).toString('base64')
      const Res = await fetch(`${Url}/token?service=better-minio&scope=${encodeURIComponent(Scope)}`, {
        headers: { Authorization: `Basic ${Basic}` },
      })
      if (Res.status !== 200) throw new Error(`token ${Res.status}`)
      return ((await Res.json()) as { token: string }).token
    },
    async call(Path, Bearer, Init) {
      const Headers_ = new Headers(Init?.headers)
      if (Bearer !== null) Headers_.set('Authorization', `Bearer ${Bearer}`)
      const { body: Raw, ...Rest } = Init ?? {}
      const Body = Raw === undefined ? undefined : typeof Raw === 'string' ? Raw : new Uint8Array(Raw)
      return fetch(`${Url}${Path}`, { ...Rest, headers: Headers_, ...(Body !== undefined ? { body: Body } : {}) })
    },
    async close() {
      await new Promise((Resolve) => Server.close(Resolve))
    },
  }
}
