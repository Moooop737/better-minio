import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Writable } from 'node:stream'
import { buildApp, errorFace, startBackground } from '../src/app'
import { loadConfig } from '../src/config'
import type { GatewayConfig } from '../src/config'
import { ensureBucket } from '../src/api/bucket'
import { createEventBus } from '../src/core/events'
import { createMemoryStateStore } from '../src/core/state'
import { createLogger } from '../src/ops/logger'
import { s3Available, startS3, TEST_ACCESS_KEY, TEST_SECRET_KEY } from './helpers/s3'
import type { TestS3 } from './helpers/s3'

const BACKEND = 'b'.repeat(32)

function configFor(Endpoint: string, Extra: Record<string, string> = {}): GatewayConfig {
  return loadConfig({
    S3_INTERNAL_ENDPOINT: Endpoint,
    S3_PUBLIC_ENDPOINT: 'http://gw.example.com',
    S3_BUCKET: 'kbfile',
    S3_ACCESS_KEY_ID: TEST_ACCESS_KEY,
    S3_SECRET_ACCESS_KEY: TEST_SECRET_KEY,
    TOKEN_SECRET: 't'.repeat(40),
    SERVICE_TOKENS: `backend:${BACKEND}`,
    ...Extra,
  })
}

function depsFor(S3: { client: TestS3['client'] }, Lines: string[]) {
  const Sink = new Writable({
    write(Chunk, _Enc, Done) {
      Lines.push(String(Chunk))
      Done()
    },
  })
  return { internal: S3.client, publicClient: S3.client, stateStore: createMemoryStateStore(), events: createEventBus(), logger: createLogger('info', Sink) }
}

describe('errorFace', () => {
  it('按路径分派渲染面', () => {
    expect(errorFace('/v2/')).toBe('oci')
    expect(errorFace('/v2/kcplan/a/tags/list')).toBe('oci')
    expect(errorFace('/presign/put')).toBe('json')
    expect(errorFace('/multipart/create')).toBe('json')
    expect(errorFace('/token')).toBe('json')
    expect(errorFace('/kbfile/a.txt')).toBe('s3')
    expect(errorFace('/v2x/a')).toBe('s3')
  })
})

describe.skipIf(!s3Available)('buildApp 装配', () => {
  let S3: TestS3
  beforeAll(async () => {
    S3 = await startS3()
    await ensureBucket(S3.client, 'kbfile')
  })
  afterAll(async () => {
    await S3.stop()
  })

  it('默认功能集：OCI / thumbnail 不挂，multipart 挂', async () => {
    const Lines: string[] = []
    const App = buildApp(configFor(S3.endpoint), depsFor(S3, Lines))
    expect((await App.request('/v2/')).status).toBe(404)
    expect((await App.request('/token')).status).toBe(404)
    expect((await App.request('/thumbnail/generate', { method: 'POST' })).status).toBe(404)
    expect((await App.request('/multipart/create', { method: 'POST' })).status).toBe(401)
    expect((await App.request('/presign/put', { method: 'POST' })).status).toBe(401)
    const Health = await App.request('/health')
    expect(Health.status).toBe(200)
    expect(JSON.stringify(await Health.json())).not.toContain(S3.endpoint)
  })

  it('开关全反：OCI / thumbnail 挂，multipart 不挂', async () => {
    const Lines: string[] = []
    const App = buildApp(
      configFor(S3.endpoint, { OCI_ENABLED: 'true', THUMBNAIL_ENABLED: 'true', MULTIPART_ENABLED: 'false' }),
      depsFor(S3, Lines),
    )
    const V2 = await App.request('/v2/')
    expect(V2.status).toBe(401)
    expect(V2.headers.get('www-authenticate')).toContain('realm="http://gw.example.com/token"')
    expect((await App.request('/thumbnail/generate', { method: 'POST' })).status).toBe(401)
    expect((await App.request('/multipart/create', { method: 'POST' })).status).not.toBe(401)
  })

  it('后台任务按开关起停', async () => {
    const Lines: string[] = []
    const Off = startBackground(configFor(S3.endpoint, { MULTIPART_ENABLED: 'false' }), depsFor(S3, Lines))
    expect(Off).toEqual([])
    const On = startBackground(configFor(S3.endpoint, { OCI_ENABLED: 'true', THUMBNAIL_ENABLED: 'true' }), depsFor(S3, Lines))
    expect(On.map((Task) => Task.name).sort()).toEqual(['multipart-cleanup', 'oci-cleanup', 'thumbnail-worker'])
    for (const Task of On) await Task.stop()
  })

  it('控制面 401 渲染 JSON；数据面 401 渲染 S3 XML；日志不含 token / MinIO 地址', async () => {
    const Lines: string[] = []
    const App = buildApp(configFor(S3.endpoint), depsFor(S3, Lines))
    const Json = await App.request('/objects/stat', { method: 'POST', body: '{}' })
    expect(await Json.json()).toMatchObject({ code: 'E_SERVICE_TOKEN' })
    const Xml = await App.request('/kbfile/a.txt?access_token=abc.def.ghi&X-Amz-Signature=deadbeef')
    expect(Xml.status).toBe(401)
    expect(await Xml.text()).toContain('<Code>')
    const Joined = Lines.join('')
    expect(Joined).not.toContain('abc.def.ghi')
    expect(Joined).not.toContain('deadbeef')
    expect(Joined).not.toContain(S3.endpoint)
  })
})
