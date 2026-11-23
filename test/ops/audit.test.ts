import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { Readable } from 'node:stream'
import { createServiceGate } from '../../src/auth/gate'
import { createServiceTokenVerifier } from '../../src/auth/service-token'
import { parseServiceTokens } from '../../src/config'
import { renderJsonError } from '../../src/core/render'
import type { AppEnv } from '../../src/core/types'
import { auditMiddleware, routeClass } from '../../src/ops/audit'
import { requestIdMiddleware } from '../../src/ops/request-id'
import { captureLogger, startServer } from './harness'
import type { Running } from './harness'

const BACKEND = 'b'.repeat(32)
const Gate = createServiceGate(createServiceTokenVerifier(parseServiceTokens(`backend:${BACKEND}`)))
const Log = captureLogger()
let Srv: Running

beforeAll(async () => {
  const App = new Hono<AppEnv>()
  App.onError((Err, c) => renderJsonError(c, Err))
  App.use('*', requestIdMiddleware())
  App.use('*', auditMiddleware(Log.logger))
  App.get('/health', (c) => c.json({ ok: true }))
  App.post('/objects/stat', Gate, async (c) => {
    c.set('auditKey', 'docs/a.pdf')
    return c.json({ ok: true })
  })
  App.options('/objects/stat', (c) => c.body(null, 204))
  /* 流式下载：bytesDown 在流结束时才累计完，audit 需等 outgoing close */
  App.get('/kbfile/*', (c) => {
    c.set('auditKey', 'big.bin')
    let Sent = 0
    const Chunks = Array.from({ length: 5 }, () => Buffer.alloc(1024, 1))
    const Body = Readable.from(
      (async function* () {
        for (const Chunk of Chunks) {
          await new Promise((Resolve) => setTimeout(Resolve, 20))
          Sent += Chunk.length
          c.set('bytesDown', Sent)
          yield Chunk
        }
      })(),
    )
    return new Response(Readable.toWeb(Body) as ReadableStream, { headers: { 'content-type': 'application/octet-stream' } })
  })
  Srv = await startServer(App)
})

afterAll(() => Srv.close())

const settle = () => new Promise((Resolve) => setTimeout(Resolve, 50))
const audits = () => Log.lines().filter((Line) => Line.event === 'audit')

describe('audit', () => {
  it('成功请求：who / op / key / ip / status / duration / bytes / request_id', async () => {
    const Res = await fetch(`${Srv.base}/objects/stat`, { method: 'POST', headers: { authorization: `Bearer ${BACKEND}`, 'x-request-id': 'rid-1' } })
    expect(Res.status).toBe(200)
    await settle()
    expect(audits().find((Line) => Line.request_id === 'rid-1')).toMatchObject({
      who: 'backend',
      op: 'POST objects',
      key: 'docs/a.pdf',
      ip: '127.0.0.1',
      status: 200,
      duration_ms: expect.any(Number),
      bytes_up: 0,
      bytes_down: 0,
    })
  })

  it('闸拒绝 401 也记一条，who=anonymous', async () => {
    const Res = await fetch(`${Srv.base}/objects/stat`, { method: 'POST', headers: { authorization: 'Bearer wrong', 'x-request-id': 'rid-401' } })
    expect(Res.status).toBe(401)
    await settle()
    expect(audits().find((Line) => Line.request_id === 'rid-401')).toMatchObject({ who: 'anonymous', op: 'POST objects', status: 401, key: null })
  })

  it('/health 与 OPTIONS 不记', async () => {
    await fetch(`${Srv.base}/health`, { headers: { 'x-request-id': 'rid-health' } })
    await fetch(`${Srv.base}/objects/stat`, { method: 'OPTIONS', headers: { 'x-request-id': 'rid-options' } })
    await settle()
    expect(audits().some((Line) => Line.request_id === 'rid-health' || Line.request_id === 'rid-options')).toBe(false)
  })

  it('流式响应：等写完再记（bytes_down 为全量）', async () => {
    const Res = await fetch(`${Srv.base}/kbfile/big.bin`, { headers: { 'x-request-id': 'rid-stream' } })
    expect((await Res.arrayBuffer()).byteLength).toBe(5120)
    await settle()
    expect(audits().find((Line) => Line.request_id === 'rid-stream')).toMatchObject({ op: 'GET s3', key: 'big.bin', bytes_down: 5120, status: 200 })
  })

  it('routeClass 按段前缀判类，其余归 s3', () => {
    expect(routeClass('/presign/put')).toBe('presign')
    expect(routeClass('/multipart/create')).toBe('multipart')
    expect(routeClass('/v2/')).toBe('oci')
    expect(routeClass('/token')).toBe('token')
    expect(routeClass('/thumbnail/generate')).toBe('thumbnail')
    expect(routeClass('/tokenish/key')).toBe('s3')
    expect(routeClass('/kbfile/a')).toBe('s3')
  })
})
