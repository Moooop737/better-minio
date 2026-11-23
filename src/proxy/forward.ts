/**
 * 透明转发器（undici）—— 把验过闸的请求原样递给内网 MinIO，签名由 MinIO 验。
 * 保真三件套：原始 request target（调用方传 `c.env.incoming.url`，不经 URL 规范化）/ Host 原样 / query 原样。
 * 只剥 hop-by-hop（及 `Connection` 点名的头、`expect`）；响应另剥 `access-control-*`（CORS 归网关）。
 * body 双向流式（禁 buffer）；signal abort → 销毁上游请求。超时：连接 5s、响应头 30s、body 无时限。
 * 用法：`const F = createForwarder({ endpoint })`；`await F.forward({ rawTarget, method, headers, body, signal })`；关闭 `F.close()`。
 */

export { createForwarder, HOP_BY_HOP_HEADERS, filterRequestHeaders, filterResponseHeaders }
export type { Forwarder, ForwarderOptions, ForwardInput, UpstreamResponse }

import type { IncomingHttpHeaders } from 'node:http'
import type { Readable } from 'node:stream'
import { Agent } from 'undici'
import type { Dispatcher } from 'undici'
import { GatewayError } from '../core/errors'
import { logger } from '../ops/logger'

const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
])

interface ForwarderOptions {
  endpoint: string
  connectTimeoutMs?: number
  headersTimeoutMs?: number
}

interface ForwardInput {
  rawTarget: string
  method: string
  headers: IncomingHttpHeaders
  body: Readable | null
  signal: AbortSignal
}

interface UpstreamResponse {
  status: number
  headers: [string, string][]
  body: Readable
}

interface Forwarder {
  forward(Input: ForwardInput): Promise<UpstreamResponse>
  close(): Promise<void>
}

function createForwarder(Options: ForwarderOptions): Forwarder {
  const Origin = new URL(Options.endpoint).origin
  const Pool = new Agent({
    connect: { timeout: Options.connectTimeoutMs ?? 5_000 },
    headersTimeout: Options.headersTimeoutMs ?? 30_000,
    bodyTimeout: 0,
  })
  return {
    async forward(Input) {
      let Res: Dispatcher.ResponseData
      try {
        Res = await Pool.request({
          origin: Origin,
          path: Input.rawTarget,
          method: Input.method as Dispatcher.HttpMethod,
          headers: filterRequestHeaders(Input.headers),
          body: Input.body,
          signal: Input.signal,
        })
      } catch (err) {
        if (Input.signal.aborted) throw err
        logger.warn({ event: 'upstream_error', cause: upstreamCause(err) }, 'upstream request failed')
        throw new GatewayError('E_UPSTREAM', '上游存储不可用')
      }
      return { status: Res.statusCode, headers: filterResponseHeaders(Res.headers), body: Res.body }
    },
    async close() {
      await Pool.close()
    },
  }
}

/* 请求方向：全透传（含 host），剥 hop-by-hop / Connection 点名 / expect；多值头保持数组 */
function filterRequestHeaders(Headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const Named = connectionTokens(Headers.connection)
  const Out: Record<string, string | string[]> = {}
  for (const [Name, Value] of Object.entries(Headers)) {
    const Lower = Name.toLowerCase()
    if (Value === undefined || HOP_BY_HOP_HEADERS.has(Lower) || Named.has(Lower) || Lower === 'expect') continue
    Out[Lower] = Value
  }
  return Out
}

/* 响应方向：剥 hop-by-hop / Connection 点名 / access-control-*；多值展开为多条 */
function filterResponseHeaders(Headers: Record<string, string | string[] | undefined>): [string, string][] {
  const Named = connectionTokens(Headers.connection)
  const Out: [string, string][] = []
  for (const [Name, Value] of Object.entries(Headers)) {
    const Lower = Name.toLowerCase()
    if (Value === undefined || HOP_BY_HOP_HEADERS.has(Lower) || Named.has(Lower) || Lower.startsWith('access-control-')) continue
    for (const Item of Array.isArray(Value) ? Value : [Value]) Out.push([Lower, Item])
  }
  return Out
}

function connectionTokens(Value: string | string[] | undefined): Set<string> {
  const Joined = Array.isArray(Value) ? Value.join(',') : (Value ?? '')
  return new Set(Joined.split(',').map((Token) => Token.trim().toLowerCase()).filter((Token) => Token !== ''))
}

/* 只留错误类别码（如 ECONNREFUSED / UND_ERR_HEADERS_TIMEOUT）给内部日志；message 含地址，丢弃 */
function upstreamCause(Err: unknown): string {
  const Code = (Err as { code?: unknown } | null)?.code
  return typeof Code === 'string' ? Code : 'UNKNOWN'
}
