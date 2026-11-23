import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { createServer } from 'node:http'
import { createEventBus } from '../../src/core/events'
import { mountProxyData } from '../../src/proxy/routes'
const MB = 1024*1024, Total = 100*MB, Chunk = Buffer.alloc(64*1024, 7)
const mode = process.argv[2]
const up = createServer((Req, Res) => {
  if (Req.method === 'PUT') { Req.resume(); Req.on('end', () => Res.end('done')); return }
  Res.writeHead(200, { 'content-length': String(Total) }); let Sent = 0
  const pump = () => { while (Sent < Total) { Sent += Chunk.length; if (!Res.write(Chunk)) return void Res.once('drain', pump) } Res.end() }; pump()
})
await new Promise<void>(r => up.listen(0, '127.0.0.1', () => r()))
const app = new Hono<any>()
mountProxyData(app, { internalEndpoint: `http://127.0.0.1:${(up.address() as any).port}`, bucket: 'kb', dataPlaneGate: async (c: any, n: any) => { c.set('identity', {kind:'x'}); await n() }, corsOrigins: [], events: createEventBus(), rateLimit: null })
const direct = process.argv[3] === 'direct'
const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }) as any
await new Promise(r => setTimeout(r, 100))
const url = direct ? `http://127.0.0.1:${(up.address() as any).port}/kb/x` : `http://127.0.0.1:${s.address().port}/kb/x`
const Base = process.memoryUsage().rss; let Peak = Base
const t = setInterval(() => Peak = Math.max(Peak, process.memoryUsage().rss), 10)
if (mode === 'up') {
  let P = 0
  const body = new ReadableStream({ pull(c) { if (P >= Total) return c.close(); P += Chunk.length; c.enqueue(new Uint8Array(Chunk)) } })
  const r = await fetch(url, { method: 'PUT', body, duplex: 'half' } as any); await r.text()
} else {
  const r = await fetch(url); const rd = r.body!.getReader(); for (;;) { const { done } = await rd.read(); if (done) break }
}
clearInterval(t); console.log(mode, direct ? 'direct' : 'gw', ((Peak - Base)/MB).toFixed(1), 'MB'); process.exit(0)
