import { describe, expect, it } from 'vitest'
import { describeFeatures, loadConfig, parseCidrList } from '../src/config'

const BASE = {
  S3_INTERNAL_ENDPOINT: 'http://127.0.0.1:9000/',
  S3_PUBLIC_ENDPOINT: 'https://files.example.com',
  S3_BUCKET: 'kbfile',
  S3_ACCESS_KEY_ID: 'ak',
  S3_SECRET_ACCESS_KEY: 'sk-secret-value',
  TOKEN_SECRET: 't'.repeat(32),
  SERVICE_TOKENS: `backend:${'b'.repeat(32)}`,
}

describe('loadConfig', () => {
  it('默认值：功能开关按 AGENTS.md §一·三', () => {
    const Config = loadConfig(BASE)
    expect(Config.s3InternalEndpoint).toBe('http://127.0.0.1:9000')
    expect(Config).toMatchObject({
      multipartEnabled: true,
      ociEnabled: false,
      ipGateEnabled: true,
      rateLimitEnabled: true,
      auditEnabled: true,
      thumbnailEnabled: false,
      keyScheme: 'flat',
      corsOrigins: [],
      redisUrl: null,
      ociPushServices: ['d1'],
      s3RegistryBucket: 'kcregistry',
    })
  })

  it('布尔严格解析：非 true/false 拒启', () => {
    expect(() => loadConfig({ ...BASE, OCI_ENABLED: 'yes' })).toThrow(/OCI_ENABLED/)
    expect(() => loadConfig({ ...BASE, IP_GATE_ENABLED: '1' })).toThrow()
    expect(loadConfig({ ...BASE, OCI_ENABLED: 'true' }).ociEnabled).toBe(true)
  })

  it('KEY_SCHEME 枚举；TOKEN_SECRET ≥32；SERVICE_TOKENS 必填', () => {
    expect(() => loadConfig({ ...BASE, KEY_SCHEME: 'monthly' })).toThrow(/KEY_SCHEME/)
    expect(loadConfig({ ...BASE, KEY_SCHEME: 'date' }).keyScheme).toBe('date')
    expect(() => loadConfig({ ...BASE, TOKEN_SECRET: 'short' })).toThrow(/TOKEN_SECRET/)
    const { SERVICE_TOKENS: _Unused, ...NoTokens } = BASE
    expect(() => loadConfig(NoTokens)).toThrow(/SERVICE_TOKENS/)
  })

  it('错误信息与功能集描述不含密钥', () => {
    const Features = JSON.stringify(describeFeatures(loadConfig({ ...BASE, CORS_ORIGINS: 'https://app.example.com' })))
    expect(Features).not.toContain('sk-secret-value')
    expect(Features).not.toContain('b'.repeat(32))
    expect(Features).not.toContain('t'.repeat(32))
    expect(Features).toContain('backend')
    try {
      loadConfig({ ...BASE, SERVICE_TOKENS: 'backend:tooshort' })
    } catch (Err) {
      expect(String(Err)).not.toContain('tooshort')
    }
  })

  it('TRUSTED_PROXIES：CIDR 解析，非法拒启', () => {
    expect(parseCidrList('10.0.0.0/8, ::1')).toHaveLength(2)
    expect(() => parseCidrList('10.0.0.0/33')).toThrow()
    expect(() => parseCidrList('nope')).toThrow()
  })
})
