import { describe, expect, it } from 'vitest'
import { createServiceTokenVerifier } from '../../src/auth/service-token'
import { parseServiceTokens } from '../../src/config'

const BACKEND = 'b'.repeat(32)
const D1 = 'd1_' + 'x'.repeat(32)

describe('service token', () => {
  const Verifier = createServiceTokenVerifier(parseServiceTokens(`backend:${BACKEND},d1:${D1}`))

  it('Bearer 命中 → 服务名；错的/缺失/格式坏 → null', () => {
    expect(Verifier.fromBearer(`Bearer ${BACKEND}`)).toBe('backend')
    expect(Verifier.fromBearer(`bearer ${D1}`)).toBe('d1')
    expect(Verifier.fromBearer(`Bearer ${BACKEND}x`)).toBeNull()
    expect(Verifier.fromBearer(undefined)).toBeNull()
    expect(Verifier.fromBearer(BACKEND)).toBeNull()
  })

  it('Basic name:token：name 必须与 token 对应', () => {
    const basic = (Value: string): string => `Basic ${Buffer.from(Value).toString('base64')}`
    expect(Verifier.fromBasic(basic(`d1:${D1}`))).toBe('d1')
    expect(Verifier.fromBasic(basic(`backend:${D1}`))).toBeNull()
    expect(Verifier.fromBasic(basic(`d1:wrong`))).toBeNull()
  })

  it('SERVICE_TOKENS 解析：短 token / 非法字符 / 重名 / 空 → 拒启', () => {
    expect(() => parseServiceTokens('a:short')).toThrow()
    expect(() => parseServiceTokens(`a:${'x'.repeat(31)}:`)).toThrow()
    expect(() => parseServiceTokens(`a:${BACKEND},a:${D1}`)).toThrow()
    expect(() => parseServiceTokens(' , ')).toThrow()
  })
})
