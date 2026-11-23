# multipart · spec

> 依据：[design.md](design.md)（全部决策已定）· AGENTS.md §4.5。本文是文件级契约，代码按此落。

## 文件与导出

### `src/api/multipart.ts`（五个 S3 原语；SDK 类型不泄出）

```ts
interface MultipartPart { partNumber: number; etag: string; size: number }
interface CompletedPart { partNumber: number; etag: string }
interface UploadPartPresignOptions { expiresIn: number; extraQuery?: Record<string, string> }

createMultipartUpload(Client, Bucket, Key, Options?: { contentType?: string }): Promise<string>   // → uploadId
presignUploadPart(Client, Bucket, Key, UploadId, PartNumber, Options: UploadPartPresignOptions): Promise<string>
listParts(Client, Bucket, Key, UploadId): Promise<MultipartPart[] | null>        // 自动翻页（1000/页）；NoSuchUpload → null
completeMultipartUpload(Client, Bucket, Key, UploadId, Parts: CompletedPart[]): Promise<{ etag: string | null } | null>  // NoSuchUpload → null
abortMultipartUpload(Client, Bucket, Key, UploadId): Promise<void>               // 幂等：NoSuchUpload / 404 视为成功
```

- presignUploadPart：用 **public client** 签；`UploadPartCommand` + `injectQuery`（签名前注入 access_token）；**不签 content-type**；`ensureExpiresIn` 1–604800。
- 其余失败一律 `ObjectStoreError`（message 不含凭证）。
- listParts 结果按 partNumber 升序。

### `src/multipart/session.ts`

```ts
interface MultipartSession { uploadId; key; partSize; contentType: string|null; sub; clientIp; resourceId: string|null; createdAt; expiresAt }  // 时间 = epoch 秒
SESSION_PREFIX = 'better-minio:multipart:'
SESSION_GRACE_SECONDS = 3600
CLEANUP_INTERVAL_MS = 300000
sessionKey(uploadId): string
saveSession(store, session, ttlSeconds): Promise<void>        // EX = ttl + 3600
loadSession(store, uploadId, nowMs): Promise<MultipartSession | null>   // 不存在 / 坏 JSON / expiresAt <= now → null
deleteSession(store, uploadId): Promise<void>
startMultipartCleanup({ internalClient, bucket, stateStore, intervalMs?, now? }): { stop(): void; runOnce(): Promise<number> }
```

- runOnce：scan 前缀 → `expiresAt <= now` 的会话 `abortMultipartUpload` + del；返回本轮清理数。abort 失败留到下轮（warn 日志，不抛）。坏 JSON 会话直接 del（无法 abort，ILM 兜底）。同一时刻只跑一轮（重入返回 0）。定时器 `unref()`。

### `src/multipart/sign.ts`

```ts
DEFAULT_PART_EXPIRES_IN = 300
signPart(deps: { publicClient, bucket, tokens }, session, partNumber, expiresIn): Promise<{ url; partNumber; expiresIn }>
```

每次铸新 JWT：`op:'put'`，`key/ip/sub/resource_id` 取会话，`exp = now + expiresIn`。签名失败 → `E_INTERNAL`（通用文案）。

### `src/multipart/reconcile.ts`（纯函数，不碰网络）

```ts
reconcile(session, clientParts: CompletedPart[], actual: MultipartPart[]):
  | { kind: 'size_mismatch'; partNumbers: number[] }
  | { kind: 'incomplete'; missing: { partNumber; reason: 'missing' | 'etag_mismatch' }[] }
  | { kind: 'ready'; parts: CompletedPart[] }
```

1. 期望集 = 1..max(clientParts.partNumber)。
2. 尺寸：期望集内真源存在的片，`N < max` 须 `size === partSize`、`N === max` 须 `1 <= size <= partSize`；违规编号升序 → size_mismatch（先于缺片判定）。
3. 对账：期望集内 —— 真源没有 **或清单没给**（断档）→ `missing`；ETag（去引号、不分大小写）不符 → `etag_mismatch`。非空 → incomplete。
4. 全符 → ready（parts 按 partNumber 升序，用清单 ETag）。真源有、清单外（> max）的片忽略（MinIO complete 丢弃）。

### `src/multipart/routes.ts`

```ts
mountMultipart(app: Hono<AppEnv>, deps: {
  internalClient: S3Client; publicClient: S3Client; bucket: string; stateStore: StateStore;
  tokens: TokenService; serviceGate: MiddlewareHandler<AppEnv>; sessionTtl: number;
  keyScheme: 'flat' | 'date'; events: EventBus; rateLimit: RateLimit | null; now?: () => number
}): void
```

每个端点：`serviceGate` → `rateLimit`（若有）→ 解析 body（zod，坏 JSON 也算 E_VALIDATION）→ 工作。会话命中后 `c.set('auditKey', session.key)`。

| 端点 | body | 成功 |
|---|---|---|
| `POST /multipart/create` | `{key, sub, client_ip, partSize, resource_id?, contentType?}` | 200 `{uploadId, key, partSize, expiresAt}` |
| `POST /multipart/sign-part` | `{uploadId, partNumber, expiresIn?}` | 200 `{url, partNumber, expiresIn}` |
| `POST /multipart/list-parts` | `{uploadId}` | 200 `{uploadId, key, expiresAt, parts:[{partNumber, etag, size}]}` |
| `POST /multipart/complete` | `{uploadId, parts:[{partNumber, etag}]}` | 200 `{status:'complete', etag, key}` / 200 `{status:'incomplete', missing:[{partNumber, reason, url, expiresIn}]}` |
| `POST /multipart/abort` | `{uploadId}` | 204（幂等） |

校验规则：
- `key` / `client_ip` 同 presign（复用 `src/presign/schema.ts` 的 `keySchema` / `clientIpSchema`）；`sub` 非空 ≤256；`resource_id` ≤256；`contentType` 非空 ≤256。
- `partSize`：整数，`5 MiB ≤ partSize ≤ 5 GiB`（S3 单片上限）。
- `partNumber`：整数 1–10000；`expiresIn`：整数 1–604800（复用 presign `expiresInSchema`），默认 300。
- `uploadId`：非空 ≤1024。
- 校验失败 400 `E_VALIDATION`，extra `issues`（presign `formatIssues`：字段路径 + 文案，不回显值）。
- complete `parts`：1–10000 项，partNumber 不得重复，etag 非空 ≤256。
- `KEY_SCHEME=date`：create 用 `applyKeyScheme(scheme, key, new Date(now()))` 加 `YYYY/MM/` 前缀，会话与响应存/回实际 key。

complete 成功：`CompleteMultipartUpload` → 删会话 → emit `object:complete {key, contentType}`。
ListParts / Complete 遇 NoSuchUpload（MinIO 已不认该 upload）→ 删会话 + 404 `E_SESSION_NOT_FOUND`。
abort：会话不存在 → 204；存在 → abort（幂等）+ 删会话 → 204。

## 错误码

| code | HTTP | 触发 |
|---|---|---|
| `E_VALIDATION` | 400 | body 坏 / 越界 / key 规则 |
| `E_SESSION_NOT_FOUND` | 404 | uploadId 未知 / 过期（`expiresAt <= now`）/ 已 complete / MinIO NoSuchUpload |
| `E_PART_SIZE_MISMATCH` | 400 | extra `partNumbers: number[]` |
| `E_UPSTREAM` | 502 | MinIO 调用失败（通用 message） |
| `E_INTERNAL` | 500 | 签名意外失败 |
| `E_SERVICE_TOKEN` | 401 | gate |

## 测试清单

`test/api/multipart.test.ts`（moto）：create→presign part→PUT→listParts（翻页聚合、升序）→complete→对象内容一致；未知 uploadId listParts/complete → null；abort 两次不抛；presign URL 含 partNumber/uploadId/extraQuery 且无 content-type 签名头；expiresIn 越界抛。

`test/multipart/reconcile.test.ts`（纯）：全齐 → ready；缺片 / 断档 → missing；ETag 不符 → etag_mismatch；引号/大小写容忍；非末片 ≠ partSize → size_mismatch；末片 > partSize → size_mismatch；清单外片忽略。

`test/multipart/session.test.ts`：save/load/delete；过期 → null；Redis EX = ttl+3600（记录型 StateStore 断言 ttl 参数，无 Redis server）；cleanup runOnce abort 过期会话（moto）并返回计数、未过期保留；stop 后不再跑。

`test/multipart/routes.test.ts`（moto + 真 server）：3×5MiB + 小末片全链路 SHA-256 一致；缺片 → incomplete + 重签 URL 补传后 complete；错 ETag → etag_mismatch；非末片尺寸不符 400 附编号；末片 > partSize 400；list-parts；过期 → 404（注入 now）；abort 幂等 204；complete 两次第二次 404；无 service token 401；KEY_SCHEME=date 前缀；分片 URL 含 partNumber/uploadId/access_token 且 token 验出 op put + 会话 key + ip；complete 成功 emit object:complete；校验 400（partSize < 5MiB、partNumber 越界）。
