# oci · spec

> 依据：[design.md](design.md)（D1–D7 已定）· AGENTS.md §4.6 · auth 设计 §四。日期 2026-11-23。
> 本文 = 文件级契约 / 签名 / 错误码 / 测试清单；实现与之一致。实现期补的缺口已回写 design §十一。

## 一 · 文件与导出

| 文件 | 导出 | 职责 |
|---|---|---|
| `routes.ts` | `mountOci(app, deps: OciDeps)`、`parseOciPath(path) → OciRoute` | `/v2`、`/v2/*` 全端点；自行解析 name（可含 `/`）；闸 → 限流 → 分派 |
| `errors.ts` | `OciError`、`ociError()`、`renderDistributionError(c, err)`、`OCI_ERROR_STATUS`、`API_VERSION_HEADER/API_VERSION` | distribution 错误体 + GatewayError 映射 |
| `manifest.ts` | `putManifest` / `getManifest` / `deleteManifest` / `listTags` / `readManifestBody`、`MANIFEST_MAX_BYTES`、`SUPPORTED_MANIFEST_TYPES` | design §三 |
| `blob.ts` | `statBlob` / `openBlob` / `unlinkBlob` | repo 链判据 + 流式读 + 解链 |
| `upload.ts` | `startUpload` / `uploadStatus` / `appendChunk` / `finishUpload` / `cancelUpload` / `readSession` | design §四 会话 + 流式 hash + CopyObject 收尾 |
| `repo-index.ts` | `createRepoIndexStore(client, bucket) → { read, update }`、`emptyIndex`、`MAX_INDEX_RETRIES=3` | 索引读改写（进程锁 + If-Match / If-None-Match:*，冲突重试 ≤3） |
| `gc.ts` | `startOciCleanup(opts) → { stop(), runOnce(): Promise<number> }`、`DEFAULT_CLEANUP_INTERVAL_MS` | 过期会话 chunk + `uploads/` 孤儿清理；悬挂 blob GC 仅草图注释 |
| `layout.ts` | `parseDigest`、`isTag`、`isDigestRef`、`blobKey/indexKey/uploadPrefix/chunkKey/finalKey/sessionKey`、`UPLOADS_PREFIX`、`SESSION_PREFIX`、`UPLOAD_ID_RE` | 桶布局 + 语法 |
| `lock.ts` | `createKeyedLock()` | 进程内按 key 串行 |
| `context.ts` | `createOciContext()`、`OciContext` | 内部依赖包 |
| `../api/registry.ts` | `putStream`、`putBytes`、`getBytes`、`getStream`、`copyObject`、`listByPrefix`、`deleteMany`、`STREAM_PART_SIZE` | oci 专用 S3 原语（SDK 类型不出 api/） |

```ts
interface OciDeps {
  internalClient: S3Client; registryBucket: string; stateStore: StateStore
  ociGate: OciGate; uploadTtl: number /* 秒 */; rateLimit: RateLimit | null; publicEndpoint?: string
}
startOciCleanup({ internalClient, registryBucket, stateStore, uploadTtl, intervalMs? = 300000, now? = Date.now })
```

api 原语契约：
- `putStream(client, bucket, key, AsyncIterable<Uint8Array>, contentType?) → {size, etag}`：攒满 8 MiB 才发；流在第一片内结束 → 单次 PutObject，否则 S3 multipart（失败 abort）。内存上界 = 一片。源流抛错原样透传。
- `putBytes(..., {contentType, ifMatch?, ifNoneMatch?}) → {ok:true, etag} | {ok:false}`：412 / 409 / If-Match 时 404 → `ok:false`。
- `getStream(..., range?) → {kind:'ok', body, contentLength, contentRange, partial} | {kind:'range-not-satisfiable'} | null`。
- 其余失败一律 `ObjectStoreError`。

## 二 · 端点（全部先 `ociGate.authorize` 再 `rateLimit?.(c)`）

| 端点 | 方法 | action | 成功 |
|---|---|---|---|
| `/v2/` | GET/HEAD | null | 200 `{}` |
| `/v2/<name>/manifests/<ref>` | GET/HEAD | pull | 200 + Content-Type(存的 mediaType) + Content-Length + Docker-Content-Digest |
| 同上 | PUT | push | 201 + Location + Docker-Content-Digest |
| 同上 | DELETE | push | 202 |
| `/v2/<name>/blobs/<digest>` | HEAD/GET | pull | 200（Range → 206 + Content-Range）+ Docker-Content-Digest |
| 同上 | DELETE | push | 202（只解链） |
| `/v2/<name>/blobs/uploads/` | POST | push | 202 + Location + Range `0-0` + Docker-Upload-UUID；`?digest=` 带 body → 201 |
| `/v2/<name>/blobs/uploads/<uuid>` | GET | push | 204 + Range + Location |
| 同上 | PATCH | push | 202 + Range `0-<size-1>` |
| 同上 | PUT `?digest=` | push | 201 + Location + Docker-Content-Digest |
| 同上 | DELETE | push | 204 |
| `/v2/<name>/tags/list` | GET | pull | 200 `{name, tags}`；`?n=&last=` 分页 + `Link: <…>; rel="next"` |

- 所有响应 `Docker-Distribution-API-Version: registry/2.0`。
- name 不合 distribution 正则 → 先验 bearer（name=null）再 400 `NAME_INVALID`。未知路径 → 验 bearer 后 404 `UNSUPPORTED`；方法不对 → 405 `UNSUPPORTED`。
- Location：`publicEndpoint` 给了回绝对 URL，否则相对路径。
- `?mount=&from=` 跨 repo mount 不支持（D6）：忽略参数、按普通 POST 开会话（202，spec 合规降级）。

## 三 · 错误码

| 来源 | HTTP | code |
|---|---|---|
| E_TOKEN_MISSING / E_TOKEN_INVALID / E_SERVICE_TOKEN | 401 | UNAUTHORIZED + `WWW-Authenticate`（extra.challenge） |
| E_SCOPE / E_OP/PATH/IP_MISMATCH | 403 | DENIED（+ challenge） |
| E_RATE_LIMIT | 429 | TOOMANYREQUESTS + `Retry-After`（extra.retryAfter） |
| E_VALIDATION | 400 | UNSUPPORTED（spec：invalid set of parameters） |
| E_NOT_FOUND / E_SESSION_NOT_FOUND | 404 | NAME_UNKNOWN / BLOB_UPLOAD_UNKNOWN |
| E_UPSTREAM / E_INTERNAL | 502 / 500 | UNKNOWN（通用文案） |
| ObjectStoreError | 502 | UNKNOWN「存储上游不可用」（不泄地址 / key） |
| 其他异常 | 500 | UNKNOWN「内部错误」 |
| OciError | 表内 | NAME_UNKNOWN 404 · NAME_INVALID 400 · MANIFEST_UNKNOWN 404 · MANIFEST_INVALID 400 · MANIFEST_BLOB_UNKNOWN 400（detail `{digests}`）· BLOB_UNKNOWN 404 · BLOB_UPLOAD_UNKNOWN 404 · BLOB_UPLOAD_INVALID 400 · DIGEST_INVALID 400 · TAG_INVALID 409（语法非法时 400）· SIZE_INVALID 400 · RANGE_INVALID 416（带当前 Range/Location/UUID 头）· UNSUPPORTED 415（405/404/400 覆盖）· UNKNOWN 502（索引冲突重试耗尽 503、存储内容校验失败 500） |

## 四 · 关键规则

- digest 只支持 `sha256:<64 hex>`；其他 → DIGEST_INVALID。tag 语法 `[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}`。
- manifest：≤4 MiB（Content-Length 预检 + 实读计数）；`schemaVersion:2`；mediaType = body.mediaType ?? Content-Type，两者都在且不同 → MANIFEST_INVALID；∉ {OCI image manifest v1, Docker manifest v2} → 415；config/layers descriptor（mediaType 非空、sha256 digest、非负整数 size）。引用 ∉ index.blobs → MANIFEST_BLOB_UNKNOWN。预检一次 + 锁内登记时再检一次。对象 `If-None-Match:*` 写入（已存在幂等）。GET 回读时重算 sha256，不符 500。
- 索引：`repos/<name>/index.json` = `{tags, manifests, blobs}`；无对象 = repo 不存在（NAME_UNKNOWN）。blob 收尾成功即链入（repo 首次 push 由此创建索引）。
- 上传会话：StateStore `better-minio:oci:upload:<uuid>` = `{name,size,chunks,createdAt,expiresAt}`，存储层 TTL = 2×uploadTtl；expiresAt = 最近活动 + uploadTtl，过期即 BLOB_UPLOAD_UNKNOWN。uuid 非 v4 形状直接 BLOB_UPLOAD_UNKNOWN；会话 name ≠ 请求 name 同。
- PATCH：Content-Range（`a-b` 或 `bytes a-b/*`）起点 ≠ size → 416；声明长度 ≠ 实写 → 删该 chunk、SIZE_INVALID。
- 收尾：chunk-0..n-1 + 末段 body 过 sha256 → putStream 到 `final`；不符 → 删 final+chunks+会话、DIGEST_INVALID；chunk 缺失 → 同样清理、BLOB_UPLOAD_INVALID；相符 → blob 不存在才 CopyObject → 删临时 + 会话 → 链入索引。上游失败保留会话（gc 兜底）。
- 同 uuid 操作进程内串行；同 repo 索引写进程内串行。
- gc.runOnce：① 会话扫（expiresAt ≤ now 或坏 JSON）→ 列 `uploads/<uuid>/` 删除 + 删会话；② `uploads/` 前缀中 uuid 不属于存活会话且 lastModified < now − TTL → 删。返回删除对象数；重入复用在途轮。

## 五 · 测试清单

- `test/api/registry.test.ts`：putStream 单片 / 空流 / >8 MiB 多片 SHA-256 一致 / 源流错误透传且 multipart abort；putBytes If-None-Match / If-Match；getStream Range 206 / 越界 / 不存在；copyObject / listByPrefix / deleteMany。
- `test/oci/errors.test.ts`：parseOciPath（多段 name、关键字重名、unknown）；renderDistributionError 映射全表 + challenge + Retry-After + 不泄内部信息。
- `test/oci/repo-index.test.ts`：创建 / 同实例并发串行 / 两实例并发 If-Match 重试两边都在 / mutate 抛错不写 / 未变不写。
- `test/oci/registry.test.ts`（moto + 真实 node server，fetch 模拟 OCI client）：
  - 鉴权：无 bearer 401 + challenge（含 scope）；d2 要 push 被裁 → 403 DENIED insufficient_scope；篡改 401；NAME_INVALID；未知端点 404。
  - 全链路：config monolithic → layer 3 次 PATCH（Content-Range）+ GET 状态 + PUT 带末段 → HEAD blob → manifest PUT（.kcplan mediaType + annotations，tag）→ tags/list → 按 tag / digest GET manifest、HEAD → 拉 layer SHA-256 一致、Range 206。
  - tag 不可变 201 / 409；manifest digest ref 不符 400；跨 repo 未链 404 BLOB_UNKNOWN、不存在 repo NAME_UNKNOWN、重传后可拉；重启（新 mountOci + 新内存 StateStore）tag/manifest/blob 仍在；DELETE tag / digest / blob 语义。
  - 异常：POST ?digest 单请求；digest 篡改 400 + 临时对象与会话清空 + 内容寻址区无对象；416；MANIFEST_BLOB_UNKNOWN（detail）；MANIFEST_INVALID / 415；>4 MiB；NAME_UNKNOWN。
  - gc：未过期不动；过期会话 chunk + 孤儿对象被删、会话清空。
  - 限流：闸后调用、未认证不消耗；429 TOOMANYREQUESTS + Retry-After。
- 未覆盖（环境）：`oras` CLI 未安装，oras push/pull 验收由上面按协议手写的 fetch 客户端代替；≥100 MB 内存平稳靠 putStream 有界缓冲（8 MiB/片）的构造保证 + >8 MiB 多片用例，未做 RSS 压测；moto 不验 SigV4、MinIO CopyObject 真机 spike 待部署环境验证。
