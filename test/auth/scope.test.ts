import { describe, expect, it } from 'vitest'
import { grantScopes, hasScope, parseScope } from '../../src/auth/scope'

describe('scope', () => {
  it('解析 repository:<name>:<actions>', () => {
    expect(parseScope('repository:kcplan/app-1:pull,push')).toEqual({ name: 'kcplan/app-1', actions: ['pull', 'push'] })
  })

  it('非法 name / type / action → E_VALIDATION', () => {
    expect(() => parseScope('repository:Bad/Name:pull')).toThrow()
    expect(() => parseScope('registry:catalog:*')).toThrow()
    expect(() => parseScope('repository:a:delete')).toThrow()
  })

  it('push 只给白名单；其余服务裁成 pull', () => {
    const Requested = [parseScope('repository:kcplan/a:pull,push')]
    expect(grantScopes('d1', Requested, ['d1'])).toEqual([{ name: 'kcplan/a', actions: ['pull', 'push'] }])
    expect(grantScopes('d2', Requested, ['d1'])).toEqual([{ name: 'kcplan/a', actions: ['pull'] }])
  })

  it('hasScope：请求所需 ⊆ grants', () => {
    const Grants = [{ name: 'kcplan/a', actions: ['pull'] }]
    expect(hasScope(Grants, 'kcplan/a', 'pull')).toBe(true)
    expect(hasScope(Grants, 'kcplan/a', 'push')).toBe(false)
    expect(hasScope(Grants, 'kcplan/b', 'pull')).toBe(false)
  })
})
