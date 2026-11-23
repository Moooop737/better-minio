# proxy · spec

> 依据：[design.md](design/design.md)（已收口）· AGENTS.md §4.2。本文是文件级契约；与设计冲突以设计为准，设计缺口先回写设计。

## 文件与导出

### `forward.ts` — 透明转发器（undici）

```ts
export { createForwarder, HOP_BY_HOP_HEADERS, filterRequestHeaders, filterResponseHeaders }
export type { Forwarder, ForwarderOptions, ForwardInput, UpstreamResponse }

interface ForwarderOptions { endpoint: string; connectTimeoutMs?: number /*5000*/; headersTimeoutMs?: number /*30000*/ }
interface ForwardInput { rawTarget: string; method: string; headers: IncomingHttpHeaders; body: Readable | null; signal: AbortSignal }
interface UpstreamResponse { status: number; headers: [string, string][]; body: Readable }
interface Forwarder { forward(Input: ForwardInput): Promise<UpstreamResponse>; close(): Promise<void> }
function createForwarder(Options: ForwarderOptions): Forwarder
```

- 目标 origin = `new URL(endpoint).origin`；path = **原始 request target**（`c.env.incoming.url`），不经 URL 规范化。
- undici `Agent({ connect.timeout 5s, headersTimeout 30s, bodyTimeout 0 })`，`agent.request({origin, path, method, headers, body, signal})`。
- 请求 header：全透传（含客户端 `host`），剥 hop-by-hop：`connection / keep-alive / transfer-encoding / te / trailer / upgrade / proxy-*`，以及 `Connection` 头点名的字段；另剥 `expect`（Node 已在入口应答 100-continue，undici 不接受 expect；presigned 签名头只含 host/content-type，剥它不碎签名）。
- 响应 header：同组 hop-by-hop 剥离；另剥 `access-control-*`（CORS 策略归网关 §四，MinIO 默认 `*` 会与白名单冲突）。多值 header 展开为多条。
- 上游连接失败 / 响应头超时 → `GatewayError('E_UPSTREAM')`（message 通用，不含地址）；客户端 abort 引起的错误原样上抛（响应已无人接收）。

### `cors.ts` — 数据面 CORS

```ts
export { dataPlaneCors, CORS_ALLOW_METHODS, CORS_ALLOW_HEADERS, CORS_EXPOSE_HEADERS }
function dataPlaneCors(Origins: string[]): MiddlewareHandler<AppEnv>
```

- `OPTIONS` 一律 204，不过闸；Origin 命中白名单才带 `Access-Control-Allow-Origin: <origin>`、`Allow-Methods: GET, PUT, HEAD, OPTIONS`、`Allow-Headers: content-type, range, if-none-match, x-amz-*`（另回显预检请求的 `Access-Control-Request-Headers` 中属于 `x-amz-*` 的具体名，因 `x-amz-*` 通配非标准）、`Max-Age: 86400`。
- 非 OPTIONS：命中白名单 → 响应（含错误响应）加 `Allow-Origin` + `Expose-Headers: ETag, Content-Length, Content-Range, Accept-Ranges, x-amz-request-id, x-amz-version-id, x-amz-*`。
- 白名单非空时所有响应加 `Vary: Origin`；无 `Allow-Credentials`；白名单空 = 不出任何 CORS 头。

### `s3-error.ts` — S3 XML 错误

```ts
export { renderS3Error, s3ErrorResponse, S3_ERROR_MAP }
function renderS3Error(c: Context, Err: unknown): Response
function s3ErrorResponse(c: Context, Status: number, Code: string, Message: string): Response
```

| GatewayError | HTTP | S3 Code |
|---|---|---|
| E_TOKEN_MISSING / E_TOKEN_INVALID / E_SERVICE_TOKEN | 401 | InvalidRequest |
| E_OP_MISMATCH / E_PATH_MISMATCH / E_IP_MISMATCH / E_SCOPE | 403 | AccessDenied |
| E_VALIDATION / E_PART_SIZE_MISMATCH | 400 | InvalidArgument |
| E_NOT_FOUND / E_SESSION_NOT_FOUND | 404 | NoSuchKey |
| E_RATE_LIMIT | 429 | SlowDown（+ `Retry-After` ← extra.retryAfter） |
| E_UPSTREAM | 502 | ServiceUnavailable |
| E_INTERNAL / 未知异常 | 500 | InternalError（通用 message） |

- 体：`<?xml…?><Error><Code/><Message/><RequestId/></Error>`，`Content-Type: application/xml`；RequestId = `c.get('requestId')`（未设则空），同时回 `x-amz-request-id`。
- Message：GatewayError 用其（已是对外安全文案）；未知异常固定 `We encountered an internal error. Please try again.`。XML 转义。
- `HEAD` 请求：只回状态码 + 头，无 body。
- 405 / NoSuchBucket / bucket 级路径不是 GatewayError，由 `s3ErrorResponse` 直接出。

### `objects.ts` — 控制端点 handler

```ts
export { createObjectHandlers, objectKeyBodySchema }
function createObjectHandlers(Deps: { internal: S3Client; bucket: string; events: EventBus }): { stat: Handler<AppEnv>; remove: Handler<AppEnv> }
```

- body `{key}`，key 用 presign 的 `keySchema`（同校验）。坏 JSON / 校验失败 → 400 `E_VALIDATION`。
- stat：200 `{size, contentType, etag}`；不存在 → 404 `E_NOT_FOUND`。
- delete：204（不存在也 204）；成功 emit `object:delete {key}`。
- api 层失败（ObjectStoreError）→ 502 `E_UPSTREAM`（message 通用）。`auditKey = key`。

### `routes.ts` — 挂载

```ts
export { mountProxyControl, mountProxyData }
export type { ProxyControlDeps, ProxyDataDeps, ProxyDataHandle }
function mountProxyControl(App: Hono<AppEnv>, Deps: { internal: S3Client; bucket: string; serviceGate: MiddlewareHandler<AppEnv>; events: EventBus; rateLimit: RateLimit | null }): void
function mountProxyData(App: Hono<AppEnv>, Deps: { internalEndpoint: string; bucket: string; dataPlaneGate: MiddlewareHandler<AppEnv>; corsOrigins: string[]; events: EventBus; rateLimit: RateLimit | null }): ProxyDataHandle
interface ProxyDataHandle { close(): Promise<void> }   // 关闭上游连接池（优雅关闭最后一步）
```

- 控制：`POST /objects/stat`、`POST /objects/delete`，链 = serviceGate → rateLimit → handler。
- 数据：`App.all('/:bucket/*')`（Hono 该模式也匹配 `/:bucket`），链 = cors → precheck → dataPlaneGate → rateLimit → forward。
  - precheck（闸前）：方法 ∉ {GET, HEAD, PUT} → 405 `MethodNotAllowed`（`Allow: GET, HEAD, PUT, OPTIONS`）；首段 bucket ≠ 配置 → 404 `NoSuchBucket`；bucket 对但无 key（桶级操作，不暴露）→ 404 `NoSuchKey`。
  - forward：body = `c.env.incoming` 经计数 Transform（GET/HEAD 不带 body）；客户端断连（outgoing `close` 且未写完）→ abort 上游；响应体 pull 式 ReadableStream（背压），cancel → 销毁上游 body。
  - 字节计数：随流实时 `c.set('bytesUp' | 'bytesDown')`（ops 审计在 outgoing `close` 时读）。
  - 事件：PUT 且上游 2xx 且 query 无 `partNumber` / `uploadId` → emit `object:put {key: identity.key, contentType: 请求 content-type ?? null, size: bytesUp}`。
  - 无 node bindings（非 @hono/node-server 运行）→ 500 `E_INTERNAL`。

## 测试清单（test/proxy/）

- `s3-error.test.ts`：映射表、429 Retry-After、未知 500 通用、RequestId、HEAD 无 body、XML 转义。
- `cors.test.ts`：白名单预检头、非白名单 204 无头、白名单空无头、Vary、Expose。
- `forward.test.ts`（假上游 node:http，测转发器本身）：Host 原样、原始 target 保真（空格/中文/`+`/`%2B`）、hop-by-hop 剥离、上游 `access-control-*` 剥离、上游不可达 502 XML 且不含地址、100MB 上传+下载 RSS 增长 < 60MB、客户端断连 → 上游请求被销毁（下载与上传两向）、bytesUp/bytesDown 计数。
- `routes.test.ts`（moto 端到端：mountPresign → 网关 → moto）：GET 200 / Range 206 / HEAD ETag；PUT 200 + object:put 事件；分片 PUT 不发事件；If-None-Match `*` 412；特殊字符 key 往返；无 token / 篡改 token 401 XML；换 IP 403；get token 打 PUT 403；DELETE/POST 405；他桶 404；桶级 404；`/objects/stat` 200/404；`/objects/delete` 204×2 + 事件；无 service token 401；CORS 预检 + 实际响应 expose ETag；错误体与日志无 MinIO 地址 / token。
