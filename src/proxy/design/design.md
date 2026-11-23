# proxy · 设计稿

> 日期：2026-11-23 · 状态：**设计已收口，未落码**
> 上游：[AGENTS.md](../../../AGENTS.md) §4.2；[auth 设计](../../auth/design/design.md)（数据面闸）、[presign 设计](../../presign/design/design.md)（URL 怎么来的）。
> 下游：实现前先读本文件 → 同目录产出 `spec.md` → 按 spec 落码。

---

## 〇 · 职责与边界

文件数据面 = **标准 S3 端点 + 透明代理**。网关不解析 S3 语义、不重签名、不缓冲 body：验完闸就把请求**原样**递给内网 MinIO，MinIO 验 S3 签名、出结果，网关原样递回。

- 做：S3 路径透明转发（GET/HEAD/PUT）、`/objects/stat` `/objects/delete` 服务端控制、数据面 CORS、S3 XML 错误渲染。
- 不做：S3 签名校验（MinIO）、对象级授权（业务）、body 大小限制（业务 ingest 判）、ListBuckets / 桶级操作（单桶网关，不暴露）。
- 调用方：**浏览器与后端都用 presigned URL 打网关**（后端 ObjectStore HTTP 实现 = 调 /presign 拿 URL + fetch；stat/delete 不便 presign 的走控制端点）。

## 一 · 路由分流与挂载顺序

Hono 按注册顺序首匹配，**控制面先挂、S3 catch-all 最后**：

```
/health            ops
/token             auth
/presign/*         presign
/objects/*         proxy（控制）
/v2/*              oci
/multipart/*       multipart（控制端点，形状归该模块设计）
/:bucket/*         proxy（S3 数据面 catch-all，最后挂）
```

- catch-all 只认 `bucket === S3_BUCKET`；其他 bucket → 404 S3 XML `NoSuchBucket`。
- **方法面（D2）**：数据面只开 GET/HEAD/PUT（对应 op get/put）。DELETE/POST 等 → **405 S3 XML `MethodNotAllowed`**：auth 没有 delete op（删除走 `/objects/delete`），multipart 的 create/complete/abort 走控制端点不开 presigned POST。AGENTS.md 端点表的 DELETE 标注同步收窄。
- 未匹配路径 → 404 S3 XML `NoSuchKey`（数据面）/ JSON（控制面），不泄内部路由表。

## 二 · 透明转发器（核心）

### 2.1 保真三件套

| 保真项 | 做法 | 为什么 |
|---|---|---|
| **原始 request target** | 取 `c.env.incoming.url`（Node 原始请求行），**不经 `new URL()` 规范化** | SigV4 签的是精确 percent-encoding；URL 规范化会改编码 → 签名碎 |
| **Host 头原样** | 客户端 Host（= `S3_PUBLIC_ENDPOINT` 的 host）原样转发，不改写成 MinIO 地址 | 签名含 Host；MinIO 按收到的 Host 验签，不要求等于自己的监听地址 |
| **query 原样** | `X-Amz-*` / `access_token` / `partNumber` / `uploadId` / `x-id` 全透传，不增删不重排 | 签名覆盖全部 query |

### 2.2 转发器选型（D1）与实测项

- **推荐 `undici` 的 `request()`**：连接池、流式 body、header 全控。Node 全局 fetch 对 Host 头与 duplex 的控制力不够透明，不选。
- **spike（实现第一步，实测不过退 `node:http`）**：
  1. undici 显式 `headers.host` 是否原样送达（用 presigned GET 经转发打 MinIO，200 即过）；
  2. 请求/响应双向 stream pipe，100MB 上传 + 下载内存平稳（不 OOM）；
  3. key 含空格 / 中文 / `+` 时原始编码保真，签名不碎。
- `node:http` 是兜底（标准库、header 全控），不是自研协议。

### 2.3 header 过滤

- 请求方向：客户端 header 全透传，**剥 hop-by-hop**（`connection / keep-alive / transfer-encoding / te / trailer / upgrade / proxy-*`）；`content-length` 有则保留。
- 响应方向：MinIO status + header 原样回，剥同一组 hop-by-hop；`ETag / Content-Range / Accept-Ranges / x-amz-*` 必须到达浏览器（CORS expose 配合）。
- 上游错误响应（MinIO 的 S3 XML）**原样透传**（D5）：已是标准 S3 错误体，不含 MinIO 地址；RequestId/Resource 是客户端自己请求的信息，不算泄露。

### 2.4 流式与生命周期

- 请求 body：`c.req.raw.body`（ReadableStream）直接作上游 body，**禁 buffer**；响应 body 反向 pipe 回 `new Response(stream, {status, headers})`。
- 客户端断连：`c.req.raw.signal` abort → 销毁上游请求（不留下半截上传耗 MinIO 连接）。
- 超时：连接 5s、响应头 30s；**body 无总时限**（大文件慢链路合法）。优雅关闭 drain 在途归 ops。
- 审计事实：identity（auth 挂的）+ method/key/status + 上下游字节数（流上计数，ops 消费）。

## 三 · 控制端点（service token）

| 端点 | 请求 | 成功 | 不存在 |
|---|---|---|---|
| `POST /objects/stat` | `{key}` | 200 `{size, contentType, etag}` | **404 `E_NOT_FOUND`**（D3） |
| `POST /objects/delete` | `{key}` | 204 | 204（S3 DeleteObject 幂等语义） |

- 走 api 层 `stat` / `delete`（internal client，网关持 MinIO 凭证执行）；key 校验同 presign（非空、≤1024、不以 `/` 开头）。
- 上游失败 → 502 `E_UPSTREAM`，message 通用，不含 MinIO 地址 / 凭证。
- 错误体 JSON `{code,message}`（控制面口径，auth §六）。

## 四 · 数据面 CORS

浏览器直传/预览是跨域 fetch；302 原生下载零 CORS。

- env `CORS_ORIGINS`（逗号白名单，D4；默认空 = 不开 CORS）。命中才回 `Access-Control-Allow-Origin: <该 origin>`（回显不用 `*`），`Vary: Origin`。
- 预检 OPTIONS：**不过闸**（预检不带 token），直接回允许项；非白名单 origin 的预检 → 204 但无 CORS 头（浏览器自己拦）。
- `Allow-Methods: GET, PUT, HEAD, OPTIONS`；`Allow-Headers: content-type, range, if-none-match, x-amz-*`；`Expose-Headers: ETag, Content-Length, Content-Range, Accept-Ranges, x-amz-*`；`Max-Age: 86400`。
- 不带 `Allow-Credentials`（presigned 无 cookie，凭证在 URL）。
- CORS 只挂数据面；控制面无浏览器调用方。

## 五 · 错误渲染（S3 XML）

数据面错误必须是 S3 XML（SDK 才认），控制面 JSON。core 的 `GatewayError` 到渲染的映射：

| 闸错误 | HTTP | S3 Code |
|---|---|---|
| `E_TOKEN_MISSING / E_TOKEN_INVALID` | 401 | `InvalidRequest` |
| `E_OP_MISMATCH / E_PATH_MISMATCH / E_IP_MISMATCH` | 403 | `AccessDenied` |
| bucket 不符 | 404 | `NoSuchBucket` |
| 方法不开 | 405 | `MethodNotAllowed` |

- Message 通用化（不泄 MinIO 地址 / 内部 code 细节）；RequestId 用网关自己的 trace id。
- MinIO 上游错误 XML 原样透传（§2.3），不重包。

## 六 · 模块接口与装配

```
src/proxy/
  forward.ts    forwardToMinio(rawTarget, method, headers, body, signal) → {status, headers, body}
  cors.ts       dataPlaneCors(origins) middleware
  s3-error.ts   renderS3Error(GatewayError) / 上游透传判定
  objects.ts    /objects/stat /objects/delete handlers（api.stat/delete）
  routes.ts     mountProxy(app, deps)：控制端点 + S3 catch-all（最后挂）
```

- deps = `{ internalEndpoint, bucket, dataPlaneGate, serviceGate, corsOrigins }`；转发器目标 = `S3_INTERNAL_ENDPOINT`（真连接），与签名 Host（public）无关。
- 新增依赖：`undici`（spike 不过则零依赖退 node:http）。
- 配置新增：`CORS_ORIGINS`（默认空）。

## 七 · 验收

1. presigned GET 经网关 → 200；Range → 206 + Content-Range；HEAD → 200 带 ETag。
2. presigned PUT 正确类型 → 200；`If-None-Match: *` 命中已存在 → 412（MinIO 出，透传）。
3. 100MB 上传 + 下载：进程 RSS 平稳（spike 2 的正式验收）。
4. key 含空格 / 中文 / `+`：签名不碎（spike 3）。
5. 闸：无 token 401 XML；换 IP 403 XML；get token 打 PUT 403。
6. DELETE/POST 数据面 → 405 XML；其他 bucket → 404 NoSuchBucket。
7. `/objects/stat` 存在 200 / 不存在 404；`/objects/delete` 204 幂等；无 service token 401。
8. CORS：白名单 origin 预检通过、ETag 可 expose；非白名单无 CORS 头；OPTIONS 不带 token 也通。
9. 客户端断连 → 上游请求被销毁（MinIO 侧无残留连接）。
10. 错误体 / 日志不含 MinIO 地址、完整 URL、token。

## 八 · 决策清单

| # | 决策 | 结论 | 状态 |
|---|---|---|---|
| D1 | 转发器 | undici request + 三项 spike，不过退 node:http | **已定**（2026-11-23） |
| D2 | 数据面方法面 | GET/HEAD/PUT；DELETE/POST → 405（delete 走控制端点，multipart 走控制端点） | **已定**（2026-11-23） |
| D3 | stat 不存在 | 404 `E_NOT_FOUND` | **已定**（默认通过） |
| D4 | CORS | env `CORS_ORIGINS` 白名单，默认空；OPTIONS 不过闸 | **已定**（默认通过） |
| D5 | 上游错误 | MinIO S3 XML 原样透传，不重包 | **已定**（默认通过） |

## 九 · 与上游文档的差异（spec 阶段同步回写）

- AGENTS.md §4.2 端点表：S3 路径 DELETE 收窄为 405（无 presigned op，删除走 `/objects/delete`）；验收补 405 / CORS / 断连项。
- handoff 接口稿「后端用 S3 SDK 指网关」口径：后端不持 MinIO 凭证，实际走 presign + fetch（AGENTS.md 新拓扑已定「后端也用 presigned URL」）。