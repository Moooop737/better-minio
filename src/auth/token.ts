/**
 * 通用 token 服务 —— 标准 JWT（jose HS256），aud 分 profile：'data-plane'（浏览器数据面）/ 'registry'（OCI bearer）。
 * 跨 aud 使用即 E_TOKEN_INVALID（401）。签发与校验同进程同密钥，不做时钟容差。jti 只作审计关联（无吊销）。
 */

export { createTokenService, DATA_PLANE_AUD, REGISTRY_AUD, REGISTRY_TOKEN_TTL }
export type { TokenService, DataPlaneClaims, RegistryClaims, Grant }

import { randomUUID } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import { GatewayError } from '../core/errors'

const DATA_PLANE_AUD = 'data-plane'
const REGISTRY_AUD = 'registry'
const REGISTRY_TOKEN_TTL = 300
const ISSUER = 'better-minio'

interface Grant {
  name: string
  actions: string[]
}

interface DataPlaneClaims {
  sub: string
  resource_id: string | null
  key: string
  op: 'put' | 'get'
  ip: string
  jti: string
  exp: number
}

interface RegistryClaims {
  sub: string
  grants: Grant[]
  jti: string
  exp: number
}

interface TokenService {
  issueDataPlane(Input: { sub: string; resourceId?: string | null; key: string; op: 'put' | 'get'; ip: string; expiresIn: number }): Promise<{ token: string; claims: DataPlaneClaims }>
  verifyDataPlane(Token: string): Promise<DataPlaneClaims>
  issueRegistry(Input: { sub: string; grants: Grant[] }): Promise<{ token: string; claims: RegistryClaims }>
  verifyRegistry(Token: string): Promise<RegistryClaims>
}

function createTokenService(Secret: string, Now: () => number = Date.now): TokenService {
  const Key = new TextEncoder().encode(Secret)
  const nowSeconds = (): number => Math.floor(Now() / 1000)

  async function sign(Payload: Record<string, unknown>, Sub: string, Aud: string, Jti: string, Exp: number): Promise<string> {
    return new SignJWT(Payload)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(Sub)
      .setAudience(Aud)
      .setIssuer(ISSUER)
      .setJti(Jti)
      .setIssuedAt(nowSeconds())
      .setExpirationTime(Exp)
      .sign(Key)
  }

  async function verify(Token: string, Aud: string): Promise<Record<string, unknown>> {
    try {
      const { payload } = await jwtVerify(Token, Key, {
        algorithms: ['HS256'],
        audience: Aud,
        issuer: ISSUER,
        clockTolerance: 0,
        currentDate: new Date(Now()),
      })
      return payload as Record<string, unknown>
    } catch {
      throw new GatewayError('E_TOKEN_INVALID', 'token 无效或已过期')
    }
  }

  return {
    async issueDataPlane(Input) {
      const Jti = randomUUID()
      const Exp = nowSeconds() + Input.expiresIn
      const Claims: DataPlaneClaims = {
        sub: Input.sub,
        resource_id: Input.resourceId ?? null,
        key: Input.key,
        op: Input.op,
        ip: Input.ip,
        jti: Jti,
        exp: Exp,
      }
      const Payload: Record<string, unknown> = { key: Input.key, op: Input.op, ip: Input.ip }
      if (Claims.resource_id !== null) Payload.resource_id = Claims.resource_id
      return { token: await sign(Payload, Input.sub, DATA_PLANE_AUD, Jti, Exp), claims: Claims }
    },

    async verifyDataPlane(Token) {
      const Payload = await verify(Token, DATA_PLANE_AUD)
      const { sub, key, op, ip, jti, exp, resource_id } = Payload
      if (
        typeof sub !== 'string' || typeof key !== 'string' || typeof ip !== 'string' ||
        typeof jti !== 'string' || typeof exp !== 'number' || (op !== 'put' && op !== 'get') ||
        (resource_id !== undefined && typeof resource_id !== 'string')
      ) {
        throw new GatewayError('E_TOKEN_INVALID', 'token 无效或已过期')
      }
      return { sub, key, op, ip, jti, exp, resource_id: resource_id ?? null }
    },

    async issueRegistry(Input) {
      const Jti = randomUUID()
      const Exp = nowSeconds() + REGISTRY_TOKEN_TTL
      const Claims: RegistryClaims = { sub: Input.sub, grants: Input.grants, jti: Jti, exp: Exp }
      return { token: await sign({ grants: Input.grants }, Input.sub, REGISTRY_AUD, Jti, Exp), claims: Claims }
    },

    async verifyRegistry(Token) {
      const Payload = await verify(Token, REGISTRY_AUD)
      const { sub, grants, jti, exp } = Payload
      if (typeof sub !== 'string' || typeof jti !== 'string' || typeof exp !== 'number' || !isGrantList(grants)) {
        throw new GatewayError('E_TOKEN_INVALID', 'token 无效或已过期')
      }
      return { sub, grants, jti, exp }
    },
  }
}

function isGrantList(Value: unknown): Value is Grant[] {
  return (
    Array.isArray(Value) &&
    Value.every(
      (Item) =>
        typeof Item === 'object' && Item !== null &&
        typeof (Item as Grant).name === 'string' &&
        Array.isArray((Item as Grant).actions) &&
        (Item as Grant).actions.every((Action) => typeof Action === 'string'),
    )
  )
}
