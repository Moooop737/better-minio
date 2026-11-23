/**
 * 闸 —— 工厂返回 Hono middleware / 授权函数，各面挂路由时内联使用；auth 不拥有数据面路由。
 *   dataPlaneGate：S3 数据请求，query access_token（JWT）→ 验签/exp/aud → op ↔ method → bucket+key 精确 → IP。
 *   serviceGate：控制面，Authorization: Bearer <service token>。
 *   ociGate.authorize(c, name, action)：/v2/*，bearer（aud registry）+ scope；失败错误带 challenge（extra.challenge）。
 * 错误语义：401 = 凭证不成立（缺失/坏/过期/aud 错）；403 = 凭证成立但越权（op/路径/IP/scope）。
 * 只抛 GatewayError，不碰响应格式（渲染归各面）。成功后 c.set('identity') 与 c.set('auditKey')。
 */

export { createDataPlaneGate, createServiceGate, createOciGate, parseDataPlanePath, OCI_SERVICE_NAME }
export type { DataPlaneGateOptions, OciGate }

import type { Context, MiddlewareHandler } from 'hono'
import { GatewayError } from '../core/errors'
import type { AppEnv, RegistryIdentity } from '../core/types'
import type { Cidr } from '../config'
import { resolveClientIp } from './client-ip'
import { hasScope } from './scope'
import type { ServiceTokenVerifier } from './service-token'
import type { TokenService } from './token'

const OCI_SERVICE_NAME = 'better-minio'

interface DataPlaneGateOptions {
  tokens: TokenService
  bucket: string
  trustedProxies: Cidr[]
  ipGateEnabled: boolean
}

interface OciGate {
  authorize(c: Context<AppEnv>, Name: string | null, Action: 'pull' | 'push' | null): Promise<RegistryIdentity>
}

function createDataPlaneGate(Options: DataPlaneGateOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const RawUrl = c.env?.incoming?.url ?? new URL(c.req.url).pathname + new URL(c.req.url).search
    const Target = parseDataPlanePath(RawUrl)
    if (Target !== null) c.set('auditKey', Target.key)
    const Token = new URL(c.req.url).searchParams.get('access_token')
    if (Token === null || Token === '') throw new GatewayError('E_TOKEN_MISSING', '缺少 access_token')
    const Claims = await Options.tokens.verifyDataPlane(Token)
    const Method = c.req.method
    const Expected = Claims.op === 'put' ? ['PUT'] : ['GET', 'HEAD']
    if (!Expected.includes(Method)) throw new GatewayError('E_OP_MISMATCH', 'token 不允许该操作')
    if (Target === null || Target.bucket !== Options.bucket || Target.key !== Claims.key) {
      throw new GatewayError('E_PATH_MISMATCH', 'token 不允许访问该路径')
    }
    const ClientIp = resolveClientIp(c.env?.incoming?.socket?.remoteAddress, c.req.header('x-forwarded-for'), Options.trustedProxies)
    c.set('identity', {
      kind: 'browser',
      sub: Claims.sub,
      resourceId: Claims.resource_id,
      jti: Claims.jti,
      op: Claims.op,
      key: Claims.key,
      ip: ClientIp ?? 'unknown',
    })
    if (Options.ipGateEnabled && (ClientIp === null || ClientIp !== Claims.ip)) {
      throw new GatewayError('E_IP_MISMATCH', '客户端网络与签发时不一致')
    }
    await next()
  }
}

function createServiceGate(Verifier: ServiceTokenVerifier): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const Name = Verifier.fromBearer(c.req.header('authorization'))
    if (Name === null) throw new GatewayError('E_SERVICE_TOKEN', 'service token 无效')
    c.set('identity', { kind: 'service', name: Name })
    await next()
  }
}

/* realm = 公开入口 + /token；scope 按当前请求补 */
function createOciGate(Tokens: TokenService, PublicEndpoint: string): OciGate {
  const Realm = `${PublicEndpoint}/token`
  const challenge = (Name: string | null, Action: string | null, Error?: string): string => {
    let Value = `Bearer realm="${Realm}",service="${OCI_SERVICE_NAME}"`
    if (Name !== null && Action !== null) Value += `,scope="repository:${Name}:${Action === 'push' ? 'pull,push' : 'pull'}"`
    if (Error !== undefined) Value += `,error="${Error}"`
    return Value
  }
  return {
    async authorize(c, Name, Action) {
      const Header = c.req.header('authorization')
      const Match = Header === undefined ? null : /^bearer\s+(\S+)$/i.exec(Header.trim())
      if (Match?.[1] === undefined) {
        throw new GatewayError('E_TOKEN_MISSING', '需要认证', { challenge: challenge(Name, Action) })
      }
      let Claims
      try {
        Claims = await Tokens.verifyRegistry(Match[1])
      } catch (err) {
        if (err instanceof GatewayError) throw new GatewayError(err.code, err.message, { challenge: challenge(Name, Action, 'invalid_token') })
        throw err
      }
      const Identity: RegistryIdentity = { kind: 'registry', sub: Claims.sub, jti: Claims.jti, grants: Claims.grants }
      c.set('identity', Identity)
      if (Name !== null) c.set('auditKey', Name)
      if (Name !== null && Action !== null && !hasScope(Claims.grants, Name, Action)) {
        throw new GatewayError('E_SCOPE', 'scope 不足', { challenge: challenge(Name, Action, 'insufficient_scope') })
      }
      return Identity
    },
  }
}

/* 原始请求行 → { bucket, key }（解码 percent-encoding；`+` 在 path 里是字面量） */
function parseDataPlanePath(RawUrl: string): { bucket: string; key: string } | null {
  const Query = RawUrl.indexOf('?')
  const Path = Query === -1 ? RawUrl : RawUrl.slice(0, Query)
  const Match = /^\/([^/]+)\/(.+)$/.exec(Path)
  if (Match?.[1] === undefined || Match[2] === undefined) return null
  try {
    return { bucket: decodeURIComponent(Match[1]), key: decodeURIComponent(Match[2]) }
  } catch {
    return null
  }
}
