/**
 * 签发流水线 —— 本地签名不发网络，可直接断言 URL 结构与 JWT claims；applyKeyScheme 的 UTC 月份边界。
 */

import { describe, expect, it } from 'vitest'
import { createS3Client } from '../../src/api/client'
import { createTokenService } from '../../src/auth/token'
import { applyKeyScheme, signGet, signPut } from '../../src/presign/sign'

const PUBLIC = 'https://files.example.com'
const Deps = {
  publicClient: createS3Client({ endpoint: PUBLIC, region: 'us-east-1', forcePathStyle: true, accessKeyId: 'ak', secretAccessKey: 'sk' }),
  bucket: 'kbfile',
  tokens: createTokenService('test-secret-test-secret-test-secret'),
}
const Base = { expiresIn: 300, client_ip: '203.0.113.7', sub: 'u1' }

describe('applyKeyScheme', () => {
  it('flat 原样', () => {
    expect(applyKeyScheme('flat', 'a/b.pdf', new Date('2026-11-23T00:00:00Z'))).toBe('a/b.pdf')
  })
  it('date 加 YYYY/MM/（UTC，非本地时区）', () => {
    expect(applyKeyScheme('date', 'a/b.pdf', new Date('2026-03-05T10:00:00Z'))).toBe('2026/03/a/b.pdf')
    expect(applyKeyScheme('date', 'k', new Date('2026-11-30T23:59:59Z'))).toBe('2026/11/k')
    expect(applyKeyScheme('date', 'k', new Date('2026-12-01T00:00:00Z'))).toBe('2026/12/k')
    expect(applyKeyScheme('date', 'k', new Date('2026-12-31T23:30:00-05:00'))).toBe('2027/01/k')
  })
})

describe('signPut / signGet', () => {
  it('PUT URL：Host = public endpoint、路径 = bucket/key、含 access_token 与签名、X-Amz-Expires = expiresIn、content-type 进 SignedHeaders', async () => {
    const Signed = await signPut(Deps, { ...Base, key: 'dir/a b.pdf', contentType: 'application/pdf', resource_id: 'res_1' })
    const Url = new URL(Signed.url)
    expect(Url.origin).toBe(PUBLIC)
    expect(Url.pathname).toBe('/kbfile/dir/a%20b.pdf')
    expect(Url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    expect(Url.searchParams.get('X-Amz-Expires')).toBe('300')
    expect(Url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type')
    expect(Signed).toMatchObject({ method: 'PUT', key: 'dir/a b.pdf', contentType: 'application/pdf' })
    const Claims = await Deps.tokens.verifyDataPlane(Url.searchParams.get('access_token') ?? '')
    expect(Claims).toMatchObject({ sub: 'u1', key: 'dir/a b.pdf', op: 'put', ip: '203.0.113.7', resource_id: 'res_1' })
    expect(Claims.exp - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(299)
    expect(Claims.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(300)
  })

  it('PUT 无 contentType：只签 host，响应不带 contentType', async () => {
    const Signed = await signPut(Deps, { ...Base, key: 'k' })
    expect(new URL(Signed.url).searchParams.get('X-Amz-SignedHeaders')).toBe('host')
    expect('contentType' in Signed).toBe(false)
  })

  it('GET URL：op=get、response-* 进签名 query', async () => {
    const Signed = await signGet(Deps, { ...Base, expiresIn: 3600, key: 'k', responseContentDisposition: 'attachment', responseCacheControl: 'no-store' })
    const Url = new URL(Signed.url)
    expect(Url.searchParams.get('X-Amz-Expires')).toBe('3600')
    expect(Url.searchParams.get('response-content-disposition')).toBe('attachment')
    expect(Url.searchParams.get('response-cache-control')).toBe('no-store')
    const Claims = await Deps.tokens.verifyDataPlane(Url.searchParams.get('access_token') ?? '')
    expect(Claims.op).toBe('get')
    expect(Claims.resource_id).toBeNull()
  })
})
