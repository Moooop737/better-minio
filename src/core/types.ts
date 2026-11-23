/**
 * 跨模块共享类型 —— Identity（过闸产物，ops 审计从它取 who）与 Hono 环境变量。
 * 各闸 `c.set('identity', …)`；proxy 记字节数 `c.set('bytes', …)`；审计取 auditKey 作为 key。
 */

export type { Identity, BrowserIdentity, ServiceIdentity, RegistryIdentity, AppEnv, AppVariables, NodeBindings, RateLimit }

import type { HttpBindings } from '@hono/node-server'
import type { Context } from 'hono'

interface BrowserIdentity {
  kind: 'browser'
  sub: string
  resourceId: string | null
  jti: string
  op: 'put' | 'get'
  key: string
  ip: string
}

interface ServiceIdentity {
  kind: 'service'
  name: string
}

/* OCI bearer 持有者：sub = 服务名；grants 为 /token 裁剪后的授权 */
interface RegistryIdentity {
  kind: 'registry'
  sub: string
  jti: string
  grants: { name: string; actions: string[] }[]
}

type Identity = BrowserIdentity | ServiceIdentity | RegistryIdentity

interface AppVariables {
  identity: Identity
  /* 审计用的对象 key / repo 名（内部日志可见，对外不泄） */
  auditKey: string
  bytesUp: number
  bytesDown: number
  requestId: string
}

type NodeBindings = HttpBindings

interface AppEnv {
  Bindings: NodeBindings
  Variables: AppVariables
}

/* 按面限流：读 c 里已挂的 identity 消耗配额；超额抛 GatewayError('E_RATE_LIMIT', …, { retryAfter: 秒 })。
 * 限流在闸之后调用（先认身份）；RATE_LIMIT_ENABLED=false 时各面拿到 null、不调用。 */
type RateLimit = (c: Context<AppEnv>) => Promise<void>
