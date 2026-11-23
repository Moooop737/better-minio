import { describe, expect, it } from 'vitest'
import { normalizeIp, resolveClientIp } from '../../src/auth/client-ip'
import { parseCidrList } from '../../src/config'

describe('resolveClientIp', () => {
  const Trusted = parseCidrList('10.0.0.0/8,127.0.0.1,::1')

  it('不可信 peer：直接用 peer，忽略客户端伪造的 XFF', () => {
    expect(resolveClientIp('198.51.100.9', '1.2.3.4', Trusted)).toBe('198.51.100.9')
  })

  it('可信 peer：XFF 从右往左取第一个不可信 IP', () => {
    expect(resolveClientIp('127.0.0.1', '6.6.6.6, 203.0.113.7, 10.1.2.3', Trusted)).toBe('203.0.113.7')
  })

  it('可信 peer 但 XFF 缺失或全可信 → null', () => {
    expect(resolveClientIp('127.0.0.1', undefined, Trusted)).toBeNull()
    expect(resolveClientIp('::1', '10.0.0.1, 127.0.0.1', Trusted)).toBeNull()
  })

  it('XFF 含非法项 → null（不猜）', () => {
    expect(resolveClientIp('127.0.0.1', 'garbage', Trusted)).toBeNull()
  })

  it('默认不信任任何人', () => {
    expect(resolveClientIp('127.0.0.1', '203.0.113.7', [])).toBe('127.0.0.1')
  })

  it('::ffff: 映射规范化为 IPv4；IPv6 规范形', () => {
    expect(normalizeIp('::ffff:203.0.113.7')).toBe('203.0.113.7')
    expect(normalizeIp('2001:DB8:0:0:0:0:0:1')).toBe('2001:db8::1')
    expect(normalizeIp('[2001:db8::1]')).toBe('2001:db8::1')
    expect(normalizeIp('nope')).toBeNull()
    expect(resolveClientIp('::ffff:127.0.0.1', '203.0.113.7', Trusted)).toBe('203.0.113.7')
  })
})
