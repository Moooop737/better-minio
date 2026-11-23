# presign · spec

> 依据：[design.md](design.md)（已收口）· AGENTS.md §4.3。

## 文件与导出

### `schema.ts` — 边界校验（zod v4）

```ts
export { keySchema, clientIpSchema, expiresInSchema, presignPutSchema, presignGetSchema, formatIssues, parseJsonBody }
export type { PresignPutInput, PresignGetInput }
```

| 字段 | 规则 |
|---|---|
| `keySchema` | string，非空、UTF-8 ≤1024 字节、不以 `/` 开头、无控制字符（U+0000–U+001F、U+007F） |
| `expiresInSchema` | 整数 1–604800 |
| `clientIpSchema` | string → `normalizeIp`（auth）；非法 IP 校验失败；`::ffff:a.b.c.d` → IPv4 |
| `sub` | 非空 ≤256 |
| `resource_id` | 可选 ≤256 |
| `contentType` / `responseContentDisposition` / `responseContentType` / `responseCacheControl` | 可选，非空 ≤1024，不解析 |

未知字段剥离（zod 默认）。multipart / proxy 复用 `keySchema` / `clientIpSchema` / `expiresInSchema`。

`parseJsonBody(c, schema)`：`c.req.json()` + `safeParse`；坏 JSON / 校验失败 → `GatewayError('E_VALIDATION', …, { issues })`，issues = `[{path, message}]`（不回显值）。

### `sign.ts` — 签发

```ts
export { signPut, signGet, applyKeyScheme }
export type { SignDeps, SignedPut, SignedGet }
interface SignDeps { publicClient: S3Client; bucket: string; tokens: TokenService }
function applyKeyScheme(Scheme: KeyScheme, Key: string, Now: Date): string   // date → `YYYY/MM/<key>`（UTC）；flat → 原样
function signPut(Deps, Input: PresignPutInput & { key: 实际 key }): Promise<SignedPut>  // { url, method: 'PUT', key, contentType?, claims }
function signGet(Deps, Input: PresignGetInput): Promise<SignedGet>                      // { url, key, claims }
```

- 铸 `issueDataPlane({sub, resourceId, key, op, ip: client_ip, expiresIn})` → JWT `exp` = now + expiresIn（与 `X-Amz-Expires` 同值）。
- `presignPut/presignGet(publicClient, bucket, key, { expiresIn, extraQuery: { access_token }, … })`（api 原语签名前注入）。
- 原语失败 → `GatewayError('E_INTERNAL')`（通用 message）。

### `routes.ts` — 挂载

```ts
export { mountPresign }
export type { PresignDeps }
function mountPresign(App: Hono<AppEnv>, Deps: { publicClient: S3Client; bucket: string; tokens: TokenService; serviceGate: MiddlewareHandler<AppEnv>; keyScheme: KeyScheme; rateLimit: RateLimit | null; now?: () => Date }): void
```

- `POST /presign/put`：serviceGate → rateLimit → 解析 → `applyKeyScheme`（只 put）→ signPut → 200 `{url, method:'PUT', key, contentType?}`。
- `POST /presign/get`：同链，key 不变换 → 200 `{url, key}`。
- 坏 JSON / zod 失败 → 400 `E_VALIDATION`（message 通用 + `issues: [{path, message}]` 只含字段路径，不回显值）。
- `auditKey = 实际 key`；签发事实 `logger.info({event:'presign', service, sub, op, key, ip, jti, exp})`（不记 URL / token）。

## 错误码

400 `E_VALIDATION` · 401 `E_SERVICE_TOKEN`（gate）· 429 `E_RATE_LIMIT` · 500 `E_INTERNAL`。

## 测试清单（test/presign/）

- `schema.test.ts`：key 边界（空、`/` 开头、控制字符、1024/1025 字节、多字节）、TTL 0/1/604800/604801/小数、client_ip 规范化/非法、sub 必填。
- `sign.test.ts`：`applyKeyScheme` flat/date（UTC 月边界）；签出 URL host = public endpoint、含 `access_token` 与 `X-Amz-Signature`、`X-Amz-Expires` = expiresIn、JWT 可被 verifyDataPlane 验且 exp = now+expiresIn、key/op/ip 正确；PUT contentType → `X-Amz-SignedHeaders` 含 content-type。
- `routes.test.ts`：无/错 service token 401；400 边界（缺 client_ip / sub、TTL 0 / 604801、key `/` 开头、坏 JSON）；合法 200 形状；`KEY_SCHEME=date` put 回带前缀 key 且 URL 路径 / token.key 一致；get 不变换；flat 回显；rateLimit 在闸后调用（429）；响应与日志不含 token 以外泄露（错误体无 URL）。
- 端到端联调（网关 + moto）在 `test/proxy/routes.test.ts`。
