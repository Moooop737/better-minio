/**
 * OCI bearer 端点 `GET /token` —— 标准 Docker/OCI token 流（oras 原生兼容）；OCI_ENABLED=false 时不挂。
 * Basic base64(name:serviceToken) → service 参数须为 better-minio → scope 解析 + 按服务裁剪 → 铸 aud=registry JWT。
 * 响应 `{ token, access_token, expires_in, issued_at }`（access_token 同值，兼容 OAuth2 风格客户端）。
 */

export { mountTokenRoute }

import type { Hono } from 'hono'
import { GatewayError } from '../core/errors'
import type { AppEnv } from '../core/types'
import { OCI_SERVICE_NAME } from './gate'
import { grantScopes, parseScope } from './scope'
import type { ServiceTokenVerifier } from './service-token'
import { REGISTRY_TOKEN_TTL } from './token'
import type { TokenService } from './token'

interface TokenRouteDeps {
  tokens: TokenService
  verifier: ServiceTokenVerifier
  pushServices: string[]
}

function mountTokenRoute(App: Hono<AppEnv>, Deps: TokenRouteDeps): void {
  App.get('/token', async (c) => {
    const Service = c.req.query('service')
    if (Service !== undefined && Service !== OCI_SERVICE_NAME) throw new GatewayError('E_VALIDATION', 'service 参数非法')
    const Name = Deps.verifier.fromBasic(c.req.header('authorization'))
    if (Name === null) throw new GatewayError('E_SERVICE_TOKEN', '认证失败')
    c.set('identity', { kind: 'service', name: Name })
    const Requested = (c.req.queries('scope') ?? []).flatMap((Raw) => Raw.split(' ')).filter((Raw) => Raw !== '').map(parseScope)
    const Grants = grantScopes(Name, Requested, Deps.pushServices)
    const { token } = await Deps.tokens.issueRegistry({ sub: Name, grants: Grants })
    c.header('Cache-Control', 'no-store')
    return c.json({ token, access_token: token, expires_in: REGISTRY_TOKEN_TTL, issued_at: new Date().toISOString() })
  })
}
