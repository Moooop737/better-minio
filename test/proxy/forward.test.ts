/**
 * 透明转发器（design §二 spike 项的正式测试）—— 假上游 = node:http 记录收到的原始请求；
 * 闸用放行桩（闸本身在 auth / routes 测），被测的是转发保真、流式、断连与计数。
 */

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { createServer, request as httpRequest } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createEventBus } from '../../src/core/events'
import type { AppEnv } from '../../src/core/types'
import { filterRequestHeaders, filterResponseHeaders } from '../../src/proxy/forward'
import { mountProxyData } from '../../src/proxy/routes'
import { renderS3Error } from '../../src/proxy/s3-error'

const BUCKET = 'kbfile'
const MB = 1024 * 1024

interface Seen {
  method: string
  url: string
  headers: IncomingMessage['headers']
  bytes: number
  completed: boolean
  closedEarly: boolean
}

type Behavior = (Req: IncomingMessage, Res: ServerResponse, Record: Seen) => void

let Upstream: Server
let UpstreamUrl = ''
let Behave: Behavior
let Requests: Seen[] = []
let Gateway: Server
let GatewayUrl = ''
let GatewayHost = ''
let Close: () => Promise<void>
const Audit: { up: number; down: number }[] = []

beforeAll(async () => {
  Upstream = createServer((Req, Res) => {
    const Record: Seen = { method: Req.method ?? '', url: Req.url ?? '', headers: Req.headers, bytes: 0, completed: false, closedEarly: false }
    Requests.push(Record)
    Req.on('data', (Chunk: Buffer) => (Record.bytes += Chunk.length))
    Req.on('end', () => (Record.completed = true))
    Res.on('close', () => (Record.closedEarly = !Res.writableFinished))
    Behave(Req, Res, Record)
  })
  await new Promise<void>((Resolve) => Upstream.listen(0, '127.0.0.1', () => Resolve()))
  UpstreamUrl = `http://127.0.0.1:${(Upstream.address() as AddressInfo).port}`

  const App = new Hono<AppEnv>()
  App.onError((Err, c) => renderS3Error(c, Err))
  App.use(async (c, next) => {
    c.env.outgoing.once('close', () => Audit.push({ up: c.get('bytesUp') ?? 0, down: c.get('bytesDown') ?? 0 }))
    await next()
  })
  const Handle = mountProxyData(App, {
    internalEndpoint: UpstreamUrl,
    bucket: BUCKET,
    dataPlaneGate: async (c, next) => {
      c.set('identity', { kind: 'browser', sub: 's', resourceId: null, jti: 'j', op: c.req.method === 'PUT' ? 'put' : 'get', key: 'k', ip: '127.0.0.1' })
      await next()
    },
    corsOrigins: [],
    events: createEventBus(),
    rateLimit: null,
  })
  Close = () => Handle.close()
  Gateway = serve({ fetch: App.fetch, port: 0, hostname: '127.0.0.1' }) as Server
  await new Promise<void>((Resolve) => (Gateway.listening ? Resolve() : Gateway.once('listening', () => Resolve())))
  GatewayHost = `127.0.0.1:${(Gateway.address() as AddressInfo).port}`
  GatewayUrl = `http://${GatewayHost}`
})

afterAll(async () => {
  Gateway.closeAllConnections()
  await new Promise<void>((Resolve) => Gateway.close(() => Resolve()))
  await Close()
  Upstream.closeAllConnections()
  await new Promise<void>((Resolve) => Upstream.close(() => Resolve()))
})

beforeEach(() => {
  Requests = []
  Audit.length = 0
  Behave = (Req, Res) => {
    Req.resume()
    Req.on('end', () => {
      Res.setHeader('etag', '"abc"')
      Res.setHeader('access-control-allow-origin', '*')
      Res.setHeader('x-amz-request-id', 'minio-req')
      Res.end('ok')
    })
  }
})

/* 原始 HTTP 请求（不经 fetch 的 URL 规范化），返回 status / headers / body */
function raw(Path: string, Options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: IncomingMessage['headers']; body: string }> {
  return new Promise((Resolve, Reject) => {
    const Req = httpRequest(`${GatewayUrl}`, { method: Options.method ?? 'GET', path: Path, headers: Options.headers ?? {} }, (Res) => {
      let Body = ''
      Res.setEncoding('utf8')
      Res.on('data', (Chunk: string) => (Body += Chunk))
      Res.on('end', () => Resolve({ status: Res.statusCode ?? 0, headers: Res.headers, body: Body }))
    })
    Req.on('error', Reject)
    Req.end(Options.body)
  })
}

async function waitFor(Predicate: () => boolean, TimeoutMs = 5000): Promise<void> {
  const Start = Date.now()
  while (!Predicate()) {
    if (Date.now() - Start > TimeoutMs) throw new Error('waitFor timeout')
    await new Promise((Resolve) => setTimeout(Resolve, 20))
  }
}

describe('保真', () => {
  it('Host 原样送达上游（不改写成 MinIO 地址）', async () => {
    const Res = await raw(`/${BUCKET}/a.txt?X-Amz-Signature=sig`, { headers: { host: 'files.example.com' } })
    expect(Res.status).toBe(200)
    expect(Requests[0]?.headers.host).toBe('files.example.com')
    const ViaFetch = await fetch(`${GatewayUrl}/${BUCKET}/a.txt`)
    expect(ViaFetch.status).toBe(200)
    expect(Requests[1]?.headers.host).toBe(GatewayHost)
  })

  it('原始 request target 逐字节保真：空格 / 中文 / + / %2B / query 顺序', async () => {
    const Targets = [
      `/${BUCKET}/dir/a%20b%2Bc%E4%B8%AD.txt?X-Amz-Date=1&access_token=t.k-n&X-Amz-Signature=ab&x-id=PutObject`,
      `/${BUCKET}/a+b/c%2bd?b=2&a=1&a=0`,
      `/${BUCKET}/%E4%B8%AD%E6%96%87/x%2Fy`,
    ]
    for (const Target of Targets) await raw(Target)
    expect(Requests.map((R) => R.url)).toEqual(Targets)
  })

  it('请求方向剥 hop-by-hop / Connection 点名 / expect，其余透传；响应剥 hop-by-hop 与 access-control-*', async () => {
    const Res = await raw(`/${BUCKET}/a.txt`, {
      headers: { connection: 'keep-alive, x-drop-me', 'x-drop-me': '1', 'keep-alive': 'timeout=5', te: 'trailers', 'proxy-authorization': 'x', range: 'bytes=0-1', 'x-amz-meta-a': 'b' },
    })
    const Got = Requests[0]?.headers ?? {}
    expect(Got['x-drop-me']).toBeUndefined()
    expect(Got['keep-alive']).toBeUndefined()
    expect(Got.te).toBeUndefined()
    expect(Got['proxy-authorization']).toBeUndefined()
    expect(Got.range).toBe('bytes=0-1')
    expect(Got['x-amz-meta-a']).toBe('b')
    expect(Res.headers['access-control-allow-origin']).toBeUndefined()
    expect(Res.headers.etag).toBe('"abc"')
    expect(Res.headers['x-amz-request-id']).toBe('minio-req')
  })

  it('header 过滤函数：多值展开、大小写归一', () => {
    expect(filterRequestHeaders({ host: 'h', connection: 'close', expect: '100-continue', 'content-length': '3' })).toEqual({ host: 'h', 'content-length': '3' })
    expect(filterResponseHeaders({ 'Set-Cookie': ['a', 'b'], 'Transfer-Encoding': 'chunked', 'Access-Control-Allow-Origin': '*', ETag: '"x"' })).toEqual([
      ['set-cookie', 'a'],
      ['set-cookie', 'b'],
      ['etag', '"x"'],
    ])
  })

  it('上游 S3 错误 XML 原样透传（不重包）', async () => {
    const Xml = '<?xml version="1.0" encoding="UTF-8"?><Error><Code>SignatureDoesNotMatch</Code></Error>'
    Behave = (Req, Res) => {
      Req.resume()
      Res.writeHead(403, { 'content-type': 'application/xml' }).end(Xml)
    }
    const Res = await raw(`/${BUCKET}/a.txt`)
    expect(Res.status).toBe(403)
    expect(Res.body).toBe(Xml)
  })

  it('字节计数：bytesUp / bytesDown 随流写入，审计在 close 时读到', async () => {
    Behave = (Req, Res) => {
      Req.resume()
      Req.on('end', () => Res.end('x'.repeat(1234)))
    }
    const Res = await fetch(`${GatewayUrl}/${BUCKET}/a.txt`, { method: 'PUT', body: 'y'.repeat(4321) })
    expect((await Res.text()).length).toBe(1234)
    await waitFor(() => Audit.length === 1)
    expect(Audit[0]).toEqual({ up: 4321, down: 1234 })
  })
})

describe('流式与生命周期', () => {
  it('100MB 上传 + 100MB 下载：不 buffer，RSS 增长 < 60MB', async () => {
    const Chunk = Buffer.alloc(64 * 1024, 7)
    const Total = 100 * MB
    Behave = (Req, Res) => {
      if (Req.method === 'PUT') {
        Req.resume()
        Req.on('end', () => Res.end('done'))
        return
      }
      Res.writeHead(200, { 'content-length': String(Total) })
      let Sent = 0
      const pump = (): void => {
        while (Sent < Total) {
          Sent += Chunk.length
          if (!Res.write(Chunk)) return void Res.once('drain', pump)
        }
        Res.end()
      }
      pump()
    }
    global.gc?.()
    const Base = process.memoryUsage().rss
    let Peak = Base
    const Sampler = setInterval(() => (Peak = Math.max(Peak, process.memoryUsage().rss)), 10)
    try {
      let Produced = 0
      const Upload = new ReadableStream<Uint8Array>({
        pull(Controller) {
          if (Produced >= Total) return Controller.close()
          Produced += Chunk.length
          Controller.enqueue(new Uint8Array(Chunk))
        },
      })
      const Put = await fetch(`${GatewayUrl}/${BUCKET}/big.bin`, { method: 'PUT', body: Upload, duplex: 'half' } as RequestInit)
      expect(Put.status).toBe(200)
      await Put.text()
      expect(Requests[0]?.bytes).toBe(Total)

      const Get = await fetch(`${GatewayUrl}/${BUCKET}/big.bin`)
      expect(Get.headers.get('content-length')).toBe(String(Total))
      let Received = 0
      const Reader = Get.body!.getReader()
      for (;;) {
        const { done, value } = await Reader.read()
        if (done) break
        Received += value.length
      }
      expect(Received).toBe(Total)
    } finally {
      clearInterval(Sampler)
    }
    expect(Peak - Base).toBeLessThan(60 * MB)
  }, 60_000)

  it('下载中客户端断连 → 上游响应被销毁', async () => {
    Behave = (Req, Res) => {
      Req.resume()
      Res.writeHead(200)
      const Timer = setInterval(() => Res.write(Buffer.alloc(16 * 1024)), 5)
      Res.on('close', () => clearInterval(Timer))
    }
    const Abort = new AbortController()
    const Res = await fetch(`${GatewayUrl}/${BUCKET}/slow.bin`, { signal: Abort.signal })
    const Reader = Res.body!.getReader()
    await Reader.read()
    Abort.abort()
    await waitFor(() => Requests[0]?.closedEarly === true)
  })

  it('上传中客户端断连 → 上游请求被中止（不留半截上传）', async () => {
    Behave = (Req) => Req.resume()
    const Req = httpRequest(`${GatewayUrl}/${BUCKET}/up.bin`, { method: 'PUT', headers: { 'content-length': String(10 * MB) } })
    Req.on('error', () => {})
    Req.write(Buffer.alloc(256 * 1024))
    await waitFor(() => (Requests[0]?.bytes ?? 0) > 0)
    Req.destroy()
    await waitFor(() => Requests[0] !== undefined && Requests[0].closedEarly && !Requests[0].completed)
  })

  it('上游不可达 → 502 ServiceUnavailable XML，不含地址', async () => {
    const App = new Hono<AppEnv>()
    App.onError((Err, c) => renderS3Error(c, Err))
    const Handle = mountProxyData(App, {
      internalEndpoint: 'http://127.0.0.1:1',
      bucket: BUCKET,
      dataPlaneGate: async (_c, next) => next(),
      corsOrigins: [],
      events: createEventBus(),
      rateLimit: null,
    })
    const Server = serve({ fetch: App.fetch, port: 0, hostname: '127.0.0.1' }) as Server
    await new Promise<void>((Resolve) => (Server.listening ? Resolve() : Server.once('listening', () => Resolve())))
    try {
      const Res = await fetch(`http://127.0.0.1:${(Server.address() as AddressInfo).port}/${BUCKET}/a`)
      expect(Res.status).toBe(502)
      const Text = await Res.text()
      expect(Text).toContain('<Code>ServiceUnavailable</Code>')
      expect(Text).not.toContain('127.0.0.1:1')
    } finally {
      Server.closeAllConnections()
      await new Promise<void>((Resolve) => Server.close(() => Resolve()))
      await Handle.close()
    }
  })
})
