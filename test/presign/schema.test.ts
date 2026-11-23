/**
 * presign 边界校验 —— key / TTL / client_ip / sub 规则（design §四）。
 */

import { describe, expect, it } from 'vitest'
import { clientIpSchema, expiresInSchema, keySchema, presignGetSchema, presignPutSchema } from '../../src/presign/schema'

const OK = { key: 'a/b.pdf', expiresIn: 300, client_ip: '203.0.113.7', sub: 'u1' }

describe('keySchema', () => {
  it('合法：普通 / 空格 / 中文 / + / 恰 1024 字节', () => {
    for (const Key of ['a', 'dir/a b+c.txt', '资料/报告.pdf', 'x'.repeat(1024), '中'.repeat(341) + 'a']) {
      expect(keySchema.safeParse(Key).success, Key.slice(0, 20)).toBe(true)
    }
  })
  it('非法：空 / 以 / 开头 / 控制字符 / 超 1024 字节（按 UTF-8 计）', () => {
    for (const Key of ['', '/abs', 'a\nb', 'a\u0000', 'a\u007f', 'x'.repeat(1025), '中'.repeat(342)]) {
      expect(keySchema.safeParse(Key).success).toBe(false)
    }
  })
})

describe('expiresInSchema', () => {
  it('1 与 604800 通过；0 / 604801 / 小数 / 字符串拒绝', () => {
    expect(expiresInSchema.safeParse(1).success).toBe(true)
    expect(expiresInSchema.safeParse(604800).success).toBe(true)
    for (const Value of [0, 604801, 1.5, -1, '300']) expect(expiresInSchema.safeParse(Value).success).toBe(false)
  })
})

describe('clientIpSchema', () => {
  it('规范化：::ffff: 映射 → IPv4；IPv6 规范形', () => {
    expect(clientIpSchema.parse('::ffff:203.0.113.7')).toBe('203.0.113.7')
    expect(clientIpSchema.parse('2001:DB8:0:0:0:0:0:1')).toBe('2001:db8::1')
    expect(clientIpSchema.parse(' 10.0.0.1 ')).toBe('10.0.0.1')
  })
  it('非法 IP 拒绝', () => {
    for (const Value of ['', 'localhost', '999.1.1.1', '10.0.0.1/24', 1]) expect(clientIpSchema.safeParse(Value).success).toBe(false)
  })
})

describe('请求体 schema', () => {
  it('put：合法体通过，client_ip 已规范化，未知字段剥离', () => {
    const Parsed = presignPutSchema.parse({ ...OK, client_ip: '::ffff:1.2.3.4', contentType: 'application/pdf', extra: 1 })
    expect(Parsed).toEqual({ ...OK, client_ip: '1.2.3.4', contentType: 'application/pdf' })
  })
  it('缺 client_ip / 缺 sub / 空 sub / sub 超 256 拒绝', () => {
    const { client_ip: _Ip, ...NoIp } = OK
    const { sub: _Sub, ...NoSub } = OK
    for (const Body of [NoIp, NoSub, { ...OK, sub: '' }, { ...OK, sub: 'x'.repeat(257) }]) {
      expect(presignPutSchema.safeParse(Body).success).toBe(false)
      expect(presignGetSchema.safeParse(Body).success).toBe(false)
    }
  })
  it('get：response* 可选透传，不解析 disposition', () => {
    const Disposition = "attachment; filename*=UTF-8''%E6%8A%A5.pdf"
    expect(presignGetSchema.parse({ ...OK, responseContentDisposition: Disposition }).responseContentDisposition).toBe(Disposition)
  })
})
