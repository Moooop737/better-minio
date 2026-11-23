import { describe, expect, it } from 'vitest'
import { createTokenService } from '../../src/auth/token'
import { GatewayError } from '../../src/core/errors'

const SECRET = 'x'.repeat(40)

describe('token service', () => {
  it('数据面 token 往返：claims 原样带回', async () => {
    const Tokens = createTokenService(SECRET)
    const { token, claims } = await Tokens.issueDataPlane({ sub: 'u1', resourceId: 'r1', key: 'a/b.pdf', op: 'get', ip: '203.0.113.7', expiresIn: 60 })
    const Verified = await Tokens.verifyDataPlane(token)
    expect(Verified).toEqual(claims)
    expect(Verified.resource_id).toBe('r1')
  })

  it('篡改一个字符 → E_TOKEN_INVALID', async () => {
    const Tokens = createTokenService(SECRET)
    const { token } = await Tokens.issueDataPlane({ sub: 'u1', key: 'k', op: 'put', ip: '1.1.1.1', expiresIn: 60 })
    const Last = token.at(-2) === 'A' ? 'B' : 'A'
    const Tampered = token.slice(0, -2) + Last + token.slice(-1)
    await expect(Tokens.verifyDataPlane(Tampered)).rejects.toMatchObject({ code: 'E_TOKEN_INVALID', httpStatus: 401 })
  })

  it('过期 → 401，无时钟容差', async () => {
    let Now = 1_800_000_000_000
    const Tokens = createTokenService(SECRET, () => Now)
    const { token } = await Tokens.issueDataPlane({ sub: 'u', key: 'k', op: 'get', ip: '1.1.1.1', expiresIn: 10 })
    Now += 9_000
    await expect(Tokens.verifyDataPlane(token)).resolves.toBeTruthy()
    Now += 1_000
    await expect(Tokens.verifyDataPlane(token)).rejects.toBeInstanceOf(GatewayError)
  })

  it('aud 跨用即 401：registry token 打数据面、数据面 token 打 registry', async () => {
    const Tokens = createTokenService(SECRET)
    const Registry = await Tokens.issueRegistry({ sub: 'd1', grants: [{ name: 'kcplan/a', actions: ['pull'] }] })
    const Data = await Tokens.issueDataPlane({ sub: 'u', key: 'k', op: 'get', ip: '1.1.1.1', expiresIn: 60 })
    await expect(Tokens.verifyDataPlane(Registry.token)).rejects.toMatchObject({ code: 'E_TOKEN_INVALID' })
    await expect(Tokens.verifyRegistry(Data.token)).rejects.toMatchObject({ code: 'E_TOKEN_INVALID' })
    await expect(Tokens.verifyRegistry(Registry.token)).resolves.toMatchObject({ sub: 'd1', grants: [{ name: 'kcplan/a', actions: ['pull'] }] })
  })

  it('不同密钥签的 token 不成立', async () => {
    const Other = createTokenService('y'.repeat(40))
    const { token } = await Other.issueDataPlane({ sub: 'u', key: 'k', op: 'get', ip: '1.1.1.1', expiresIn: 60 })
    await expect(createTokenService(SECRET).verifyDataPlane(token)).rejects.toMatchObject({ code: 'E_TOKEN_INVALID' })
  })
})
