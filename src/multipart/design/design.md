# multipart · 设计稿

> 日期：2026-11-23 · 状态：**设计已收口，未落码**
> 开关：`MULTIPART_ENABLED` 默认 `true`；`false` = 五端点不挂（404）、清理定时器不起（AGENTS.md §一·三）。
> 上游：[AGENTS.md](../../../AGENTS.md) §4.5；[auth 设计](../../auth/design/design.md)（token）、[presign 设计](../../presign/design/design.md)（签名路径）、[proxy 设计](../../proxy/design/design.md)（分片 PUT 走数据面）。
> 实物依据（2026-10-29 实测）：该 MinIO `ListMultipartUploads` **恒空**、`ListParts(uploadId)` **正常** → 会话必须自持久化 uploadId，对账走 ListParts 可行。
> 下游：实现前先读本文件 → 同目录产出 `spec.md` → 按 spec 落码。

---

## 〇 · 职责与边界

大文件分片上传的**会话编排层**：后端调控制端点编排，浏览器拿 presigned URL 直传分片（走 proxy 数据面，网关不另开数据面）。

- 做：create / sign-part / list-parts / complete / abort 五个控制端点；uploadId 会话持久化（Redis/内存）；ETag 对账 + 缺片重签自愈；过期会话清理。
- 不做：去重/秒传判据（业务侧，AGENTS.md 已定）、分片数据面转发（proxy 透明做）、文件元数据、part 内容校验（MinIO 验 ETag）。
- **会话 = 传输状态，可丢可重建**（不是文件元数据，不违反单一真相）；**part 清单不持久化**——MinIO ListParts 是唯一真源，网关只存会话头。

## 一 · 控制端点（全 POST，service token）

### 1.1 `POST /multipart/create`

```jsonc
// 请求
{ "key": "…", "sub": "…", "client_ip": "…",   // * 同 presign 契约
  "partSize": 5242880,                         // * 分法（字节），≥5MiB；会话内不变式（D6）
  "resource_id": "…",                          // 可选，审计
  "contentType": "application/zip" }           // 可选，对象最终类型（CreateMultipartUpload 时定）
// 200
{ "uploadId": "…", "key": "…", "partSize": 5242880, "expiresAt": 1766… }
```

网关调 MinIO `CreateMultipartUpload`（internal client）→ 持久化会话 → 回 uploadId。**uploadId 即会话 id**，不另造 sessionId。

**key 口径随 presign `KEY_SCHEME`**（见 [presign 设计 §二·二](../../presign/design/design.md)）：date 开启时请求传 base key、网关加 `YYYY/MM/` 前缀，**会话存实际 key、响应回实际 key**；后续 sign-part/complete 全用会话里的实际 key。

### 1.2 `POST /multipart/sign-part`

```jsonc
{ "uploadId": "…", "partNumber": 3, "expiresIn": 300 }  // partNumber 1–10000；expiresIn 可选默认 300
// 200
{ "url": "https://…?partNumber=3&uploadId=…&access_token=…&X-Amz-…", "partNumber": 3, "expiresIn": 300 }
```

每次铸**新鲜 JWT**（op put、key/ip/sub 从会话取）→ `UploadPartCommand` presign（public client + `extraQuery` 注入，api 层新原语）。part 不签 content-type（对象类型在 create 时已定）。并发 sign-part 安全（无状态签名）。

### 1.3 `POST /multipart/list-parts`（断点续传入口）

```jsonc
{ "uploadId": "…" }
// 200
{ "uploadId": "…", "key": "…", "expiresAt": …,
  "parts": [ { "partNumber": 1, "etag": "\"…\"", "size": 5242880 }, … ] }
```

网关调 MinIO `ListParts`（api 原语自动翻页，1000/页）→ 原样回。后端据此只重签缺片。**会话不存在/过期 → 404 `E_SESSION_NOT_FOUND`**（后端重新 create）。

### 1.4 `POST /multipart/complete`（对账 + 自愈，D1）

```jsonc
{ "uploadId": "…", "parts": [ { "partNumber": 1, "etag": "\"…\"" }, … ] }
```

流水线：

1. ListParts 取 MinIO 真源；期望集 = 客户端 parts 的 1..max 连续编号。
2. **partSize 精确校验（D6）**：非末片 size **必须精确等于会话 partSize**、末片 1..partSize → 不符 **400 `E_PART_SIZE_MISMATCH`**（附违规 partNumber 列表）。比 S3 原生 5MiB 下限更严：partSize ≥5MiB 已蕴含下限，且能当场拦下「换分法混传」（5MiB 会话混进 3MiB 片）。同尺寸不同边界的混合网关查不出（不看内容），业务侧 SHA-256 兜底。
3. 对账：期望集中**缺片**或 **ETag 不符**（D1：不符视同缺片，重传自愈）→ **200 自愈响应**（不是错误）：
   ```jsonc
   { "status": "incomplete",
     "missing": [ { "partNumber": 4, "reason": "missing", "url": "…重签…", "expiresIn": 300 },
                  { "partNumber": 7, "reason": "etag_mismatch", "url": "…", "expiresIn": 300 } ] }
   ```
   客户端补传这些片后再调 complete。重签 URL 用会话绑定铸新 token，与 sign-part 同路径。
4. 全齐且 ETag 全符 → `CompleteMultipartUpload` → 删会话 → **200 `{status:'complete', etag, key}`**。
5. complete 竞态（单实例）：第二个并发 complete 撞已删会话 → 404，客户端重试 list-parts 判定即可，不加锁。
6. 多/少片语义（S3 协议）：**清单定义对象**——真源有、清单无的片不进合并，MinIO complete 时丢弃；同号片重传以最后一次为准，旧指纹不符走自愈；清单断档按 1..max 补齐期望集，缺口算 missing。
7. **分法不变式（D6）**：partNumber 是位置契约（第 N 片 = 字节区间 [(N-1)×partSize, N×partSize)），partSize 会话内不可变。客户端续传必须复用 `{uploadId, partSize, 文件指纹}`；文件变 / 分法变 → **abort 旧会话 + create 新会话**，不在旧单号里换分法。

### 1.5 `POST /multipart/abort`

`{uploadId}` → `AbortMultipartUpload` + 删会话 → **204 幂等**（会话已不存在也 204）。

## 二 · 会话持久化与清理

### 2.1 存储（已定策略的首个消费者）

- **core/state.ts 共享抽象**（本模块首建，ops 限流复用）：`StateStore { get, set, del, scan }`；`REDIS_URL` 给了 → ioredis 实现（启动连不上拒启），不给 → Map 实现（重启丢，显式接受）。
- key：`better-minio:multipart:<uploadId>`；value = 会话头 JSON：`{uploadId, key, partSize, contentType?, sub, clientIp, resourceId?, createdAt, expiresAt}`。**不存 parts**。
- TTL（D2）：env `MULTIPART_SESSION_TTL` 默认 **86400（24h）**；Redis key EX = TTL + 3600 grace（给清理器留窗口，key 不先于清理消失）。

### 2.2 过期清理

- 定时器每 **5 min**（D2）scan 前缀 → `expiresAt < now` 的会话：`AbortMultipartUpload` + del。abort 失败（MinIO 抖动）留到下轮，不抛。
- 内存模式同逻辑（Map 迭代）。
- **无 Redis 重启的孤儿**：会话丢 → MinIO 里未完成 upload 无人认领，且 `ListMultipartUploads` 恒空、网关枚举不到 ⇒ 兜底 = **MinIO 桶 ILM 规则**（incomplete multipart upload 过期天数，部署侧配置，不是网关代码）。设计显式接受这条缝。

## 三 · 数据面交互（零改动）

分片 PUT = presigned `UploadPart` URL 打 proxy S3 路径（`?partNumber&uploadId`）→ dataPlaneGate：op put、token.key 匹配、query 不参与路径判定（auth 设计已覆盖）→ 透明转发，MinIO 验签 + 收片。**proxy 不知道 multipart 语义**，不加钩子。

## 四 · api 层扩展

`api/multipart.ts` 新原语（S3 知识不泄出 api 层）：

| 原语 | 说明 |
|---|---|
| `createMultipartUpload` | → uploadId |
| `presignUploadPart` | UploadPartCommand + extraQuery；不签 content-type |
| `listParts` | 自动翻页聚合 |
| `completeMultipartUpload` | 收 parts 数组 |
| `abortMultipartUpload` | 幂等语义 |

错误归一 `ObjectStoreError`（同 objects.ts 口径）；checksum `WHEN_REQUIRED` 沿用 client 配置。

## 五 · 错误口径（控制面 JSON）

| code | HTTP | 触发 |
|---|---|---|
| `E_VALIDATION` | 400 | body 坏 / partNumber 越界 / key 规则 |
| `E_SESSION_NOT_FOUND` | 404 | uploadId 未知 / 过期 / 已 complete |
| `E_PART_SIZE_MISMATCH` | 400 | 非末片 ≠ partSize / 末片 > partSize（附 partNumber 列表；蕴含 5MiB 下限） |
| `E_UPSTREAM` | 502 | MinIO 失败（message 通用，不泄地址） |
| `E_SERVICE_TOKEN` | 401 | gate |

缺片/ETag 不符**不是错误**，是 200 incomplete 自愈。

## 六 · 模块接口与装配

```
src/core/state.ts       StateStore 抽象 + Redis/Memory 两实现（共享底座）
src/api/multipart.ts    五个 S3 原语
src/multipart/
  session.ts            会话 CRUD + 过期清理定时器（消费 StateStore）
  sign.ts               signPart / 重签（铸 token + presignUploadPart）
  reconcile.ts          complete 对账 + 5MiB 预检 + 自愈组装
  routes.ts             mountMultipart(app, deps)：五端点，内联 serviceGate
```

- deps = `{ internalClient, publicClient, bucket, stateStore, tokenService, serviceGate }`。
- 新增依赖：`ioredis`（可选连接，库必装）。配置新增：`REDIS_URL`（可选）、`MULTIPART_SESSION_TTL`（默认 86400）、`MULTIPART_ENABLED`（默认 `true`，严格布尔）。

## 七 · 验收

1. 多片（含末片 <5MiB）上传 → complete → get 全对象 **SHA-256 与源一致**。
2. 故意缺一片 / 改一片 ETag → complete 回 200 incomplete + 对应重签 URL；补传后 complete 成功。
3. 非末片 ≠ partSize（含 <5MiB、换分法混传）→ 400 `E_PART_SIZE_MISMATCH` 附编号；末片 > partSize 同拦。
4. 断点续传：list-parts 回已传片；会话过期后 → 404。
5. 过期清理：短 TTL 会话到期后被 abort + 删除（测试用短 TTL，不真等 24h）。
6. abort 幂等；complete 后会话消失。
7. 分片 PUT 换 IP → 403（数据面闸生效）；无 service token 调控制端点 → 401。
8. 无 Redis 模式全链路通（重启丢会话显式接受）；有 Redis 模式重启后会话仍在。

## 八 · 决策清单

| # | 决策 | 结论 | 状态 |
|---|---|---|---|
| D1 | ETag 不符语义 | 视同缺片，200 自愈重签（与缺片同一交互，客户端一套逻辑） | **已定**（2026-11-23） |
| D2 | 会话 TTL / 清理节奏 | 默认 24h（env 可调）/ 5min 扫 / Redis grace 1h | **已定**（2026-11-23） |
| D3 | 尺寸下限 | 被 D6 蕴含（partSize ≥5MiB + 精确校验） | **已定**（并入 D6） |
| D4 | 会话 id | uploadId 即会话 id，不另造 | **已定**（默认通过） |
| D5 | 孤儿兜底 | MinIO 桶 ILM 规则（部署侧），网关不枚举 | **已定**（默认通过） |
| D6 | 分法一致性 | create 必填 partSize（≥5MiB）；complete 非末片精确等于 partSize、末片 ≤ partSize；换分法 = 换会话 | **已定**（2026-11-23） |
| D7 | 功能开关 | `MULTIPART_ENABLED` 默认 true；关 = 路由不挂、定时器不起 | **已定**（2026-11-23） |

## 九 · 与上游文档的差异（spec 阶段同步回写）

- AGENTS.md §4.5：端点形状落为 `/multipart/*` 五 POST；create 补 `partSize` 必填；「非末片 5MiB 下限」升级为 partSize 精确校验（`E_PART_SIZE_MISMATCH`）；「按表扫」落为 StateStore scan（Redis/内存）；补孤儿 ILM 说明。
- 去重/秒传冲突：维持「归业务侧」，网关不判（触发点仍在业务上分片前拍）。