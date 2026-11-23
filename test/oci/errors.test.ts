/**
 * 路由解析与错误渲染（无 S3）—— parseOciPath 的 name 含 `/` 解析；renderDistributionError 的
 * GatewayError / OciError / 存储错误 / 未知异常映射（状态、code、challenge、Retry-After、不泄内部信息）。
 */

import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { ObjectStoreError } from '../../src/api/object-store'
import { GatewayError } from '../../src/core/errors'
import { ociError, renderDistributionError } from '../../src/oci/errors'
import { parseOciPath } from '../../src/oci/routes'

describe('parseOciPath', () => {
  it('base / manifests / blobs / uploads / tags，name 可含多段', () => {
    expect(parseOciPath('/v2/')).toEqual({ kind: 'base' })
    expect(parseOciPath('/v2')).toEqual({ kind: 'base' })
    expect(parseOciPath('/v2/kcplan/app/manifests/1.0.0')).toEqual({ kind: 'manifest', name: 'kcplan/app', ref: '1.0.0' })
    expect(parseOciPath('/v2/a/b/c/blobs/sha256%3Aabc')).toEqual({ kind: 'blob', name: 'a/b/c', digest: 'sha256:abc' })
    expect(parseOciPath('/v2/kcplan/app/blobs/uploads/')).toEqual({ kind: 'upload-start', name: 'kcplan/app' })
    expect(parseOciPath('/v2/kcplan/app/blobs/uploads')).toEqual({ kind: 'upload-start', name: 'kcplan/app' })
    expect(parseOciPath('/v2/kcplan/app/blobs/uploads/u-1')).toEqual({ kind: 'upload', name: 'kcplan/app', uuid: 'u-1' })
    expect(parseOciPath('/v2/kcplan/app/tags/list')).toEqual({ kind: 'tags', name: 'kcplan/app' })
  })

  it('name 自身含关键字段名时取最后一次出现', () => {
    expect(parseOciPath('/v2/x/manifests/y/manifests/z')).toEqual({ kind: 'manifest', name: 'x/manifests/y', ref: 'z' })
    expect(parseOciPath('/v2/blobs/blobs/sha256:a')).toEqual({ kind: 'blob', name: 'blobs', digest: 'sha256:a' })
  })

  it('不认识的形状 → unknown', () => {
    expect(parseOciPath('/v2/app')).toEqual({ kind: 'unknown' })
    expect(parseOciPath('/v2/app/manifests/')).toEqual({ kind: 'unknown' })
    expect(parseOciPath('/v2/app/tags')).toEqual({ kind: 'unknown' })
  })
})

describe('renderDistributionError', () => {
  const render = async (Err: unknown): Promise<{ status: number; headers: Headers; body: { errors: { code: string; message: string; detail?: unknown }[] } }> => {
    const App = new Hono()
    App.get('/v2/x', () => {
      throw Err
    })
    App.onError((err, c) => renderDistributionError(c, err))
    const Res = await App.request('/v2/x')
    return { status: Res.status, headers: Res.headers, body: (await Res.json()) as never }
  }

  it('E_TOKEN_* / E_SERVICE_TOKEN → 401 UNAUTHORIZED + WWW-Authenticate', async () => {
    for (const Code of ['E_TOKEN_MISSING', 'E_TOKEN_INVALID', 'E_SERVICE_TOKEN'] as const) {
      const Res = await render(new GatewayError(Code, '需要认证', { challenge: 'Bearer realm="r"' }))
      expect(Res.status).toBe(401)
      expect(Res.body.errors[0]?.code).toBe('UNAUTHORIZED')
      expect(Res.headers.get('www-authenticate')).toBe('Bearer realm="r"')
      expect(Res.headers.get('docker-distribution-api-version')).toBe('registry/2.0')
    }
  })

  it('E_SCOPE → 403 DENIED + challenge；E_RATE_LIMIT → 429 + Retry-After；E_VALIDATION → 400', async () => {
    const Scope = await render(new GatewayError('E_SCOPE', 'scope 不足', { challenge: 'Bearer x,error="insufficient_scope"' }))
    expect([Scope.status, Scope.body.errors[0]?.code]).toEqual([403, 'DENIED'])
    expect(Scope.headers.get('www-authenticate')).toContain('insufficient_scope')
    const Limit = await render(new GatewayError('E_RATE_LIMIT', '请求过于频繁', { retryAfter: 3 }))
    expect([Limit.status, Limit.body.errors[0]?.code, Limit.headers.get('retry-after')]).toEqual([429, 'TOOMANYREQUESTS', '3'])
    const Invalid = await render(new GatewayError('E_VALIDATION', 'scope 格式非法'))
    expect([Invalid.status, Invalid.body.errors[0]?.code]).toEqual([400, 'UNSUPPORTED'])
  })

  it('OciError：状态按表、detail 进体、附加头生效', async () => {
    const Tag = await render(ociError('TAG_INVALID', 'tag 不可变', { detail: { tag: '1.0' } }))
    expect(Tag.status).toBe(409)
    expect(Tag.body.errors[0]).toEqual({ code: 'TAG_INVALID', message: 'tag 不可变', detail: { tag: '1.0' } })
    const Range = await render(ociError('RANGE_INVALID', 'x', { headers: { Range: '0-9' } }))
    expect([Range.status, Range.headers.get('range')]).toEqual([416, '0-9'])
    for (const [Code, Status] of [
      ['NAME_UNKNOWN', 404], ['MANIFEST_UNKNOWN', 404], ['BLOB_UNKNOWN', 404], ['BLOB_UPLOAD_UNKNOWN', 404],
      ['DIGEST_INVALID', 400], ['MANIFEST_INVALID', 400], ['MANIFEST_BLOB_UNKNOWN', 400], ['SIZE_INVALID', 400],
      ['NAME_INVALID', 400], ['UNSUPPORTED', 415], ['UNKNOWN', 502],
    ] as const) {
      expect((await render(ociError(Code, 'm'))).status).toBe(Status)
    }
  })

  it('存储上游失败 → 502 UNKNOWN 通用文案（不泄 key / 地址）；未知异常 → 500', async () => {
    const Store = await render(new ObjectStoreError('put blobs/sha256/abc 失败', new Error('connect ECONNREFUSED 127.0.0.1:9000')))
    expect(Store.status).toBe(502)
    expect(Store.body.errors[0]?.code).toBe('UNKNOWN')
    expect(JSON.stringify(Store.body)).not.toMatch(/blobs|9000|127\.0\.0\.1/)
    const Boom = await render(new Error('secret internal detail'))
    expect(Boom.status).toBe(500)
    expect(JSON.stringify(Boom.body)).not.toContain('secret')
  })
})
