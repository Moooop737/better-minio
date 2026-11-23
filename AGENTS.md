# better-minio · AGENTS.md

> MinIO 薄网关。**这是唯一权威文档**：设计 + 目录架构 + 每个功能点的规格与验收 + 全量实现指令都在这里。任何 agent 动手前先通读本文件。

## 〇 · 是什么 / 为什么存在

坐在 MinIO 前的通用网关：**凭证隔离 / presign 签发 / S3 数据面转发 / IP 绑定闸 / 审计限流 / OCI 制品（.kcplan）**。讲公开标准（OCI Distribution + S3），不造私有协议。

立项理由：**presigned URL 绑不了 IP**，MinIO 只验 S3 签名、不看 IP。要「换网络即拒」、要凭证隔离、要审计，只能有一层闸站在 MinIO 前——就是它。

**拓扑（已定）：网关自己就是标准 S3 端点**（公开 `:9100`），前置内网 MinIO（`127.0.0.1:9000`）。presigned URL 由网关用 MinIO 凭证签（Host=网关公开地址），浏览器 / 后端都打网关；网关校验 `x-kc-token` / IP 后**透明代理**到 MinIO（method/path/query/headers/Host 全保持，签名不变由 MinIO 验）。Caddy 只做 TLS 终止，不做数据面反代、不需要 forward_auth。

## 一 · 全量实现指令（关键）

- **不留余力、不留桩**：每个功能点按本文 §四 的规格 + 验收全量落地。**禁止 TODO 空壳、禁止「以后再说」、禁止假适配 / 字段映射糊弄、禁止只搭框架**。
- **缺 spec 先补**：实现中发现没写清的点，先把决定补回本文对应小节，再写代码。
- **一次做完一个 feature（含测试）**：`npm run typecheck` + 该 feature 测试绿，再进下一个。
- **测试**：写 `test/`，镜像 `src/` 结构；测「定义与取舍」，不凑覆盖率、不 mock 被测逻辑。

## 一·二 · 设计 → spec → 实现（每模块）

- 每个大模块的设计稿住 `src/<module>/design/design.md`；**先设计、后落码**。
- 实现某模块前：先读该模块 `design/design.md` → 在同目录产出 `spec.md`（文件级契约 / 函数签名 / 错误码 / 测试清单，与设计一致）→ 按 spec 落码。
- 设计稿里的决策标「已定 / 待拍」；**待拍项收口后才进实现**。
- 实现中发现设计缺口：先改 design.md（涉及全局口径的同步改本文），再改 spec.md，再改代码。

## 一·三 · 功能开关（env，2026-11-23 拍板）

**恒开（无开关）**：proxy 传输 / presign 签发 / JWT 验签 / service token / health / 日志 / 优雅关闭——本体，不是功能。

| env | 默认 | 关闭效果 |
|---|---|---|
| `MULTIPART_ENABLED` | `true` | `/multipart/*` 不挂、清理定时器不起 |
| `OCI_ENABLED` | `false` | `/v2/*` 与 `/token` 不挂、chunk 清理不起、registry 桶不建 |
| `IP_GATE_ENABLED` | `true` | 跳过 IP 比对（**启动告警**）；client_ip 契约不变 |
| `RATE_LIMIT_ENABLED` | `true` | 不限流 |
| `AUDIT_ENABLED` | `true` | 不记 audit 行（基础请求日志仍在） |
| `THUMBNAIL_ENABLED` | `false` | 路由不挂、订阅不接、worker 不起 |
| `KEY_SCHEME` | `flat` | `date` = YYYY/MM 前缀（枚举，非布尔） |
| `CORS_ORIGINS` | 空 | 空 = 不开 CORS |
| `REDIS_URL` | 未设 | 未设 = 瞬态全内存 |

装配规则：**关 = 路由不挂、定时器不起、订阅不接**（不是「挂着但拒绝」）；布尔严格解析（`true`/`false`），非法拒启；启动日志打印生效功能集（不含密钥）。使用者在 docker-compose `environment:` 里配置（镜像配置面 = env，见各 design 与 `.env.example`）。

## 二 · 技术栈

Node + TypeScript + Hono + `@hono/node-server` + `@aws-sdk/client-s3` v3 + `jose`（标准 JWT）。同 `app/server` 口径：`strict`、`exactOptionalPropertyTypes`、`verbatimModuleSyntax`、`noUncheckedIndexedAccess`。

**状态持久化**：可选 Redis（`REDIS_URL`，ioredis）——给了就落 Redis，不给全存内存（重启丢，显式接受）；给了但启动连不上 → 拒启。适用域 = 瞬态（分片/上传会话、限流计数）；持久 registry 状态（OCI tag 索引）落 MinIO 对象。

## 三 · 目录架构（按功能点分）

```
src/
  index.ts        组装：读 config + 挂各 feature 路由 + 启动
  config.ts       配置（环境变量集中；密钥不进日志）
  core/           跨功能共享：错误码 / 类型 / 路由组装
  api/            连 MinIO 的唯一层（S3 client + 对象操作 + presign 原语）
  proxy/          文件数据面：S3 转发 + 浏览器直连支撑
  presign/        /presign/* 控制面
  auth/           通用 JWT token 服务 + IP 绑定闸 + service token + OCI bearer
  multipart/      分片上传会话 + 对账 + 断点续传 + 清理
  oci/            OCI Distribution /v2/* + .kcplan 映射 + registry 索引
  ops/            health + audit + rate-limit + 日志 + 优雅关闭
test/             镜像 src/ 结构
```

端口口径（两套 endpoint）：
- `S3_INTERNAL_ENDPOINT`：网关 → MinIO 的真连接（生产 `127.0.0.1:9000`）。
- `S3_PUBLIC_ENDPOINT`：presign 签进 URL 的 Host（浏览器可见入口，Caddy 反代必须保持 Host）。

端口分配（同机 2c2g，别撞）：
- **MinIO S3 API `9000`**：数据面，网关连它。
- **MinIO Console `9001`**：**非 S3**，Web 管理 UI，只留 tailnet/localhost，**绝不公网、不经网关**。
- **网关 `9100`**（`GATEWAY_PORT`）：**公开标准 S3 端点 + 控制面**，对外入口；Caddy 只做 TLS 终止。

扁平端点（全在根路径，不嵌套）：

| 端点 | 方法 | 归属 |
|---|---|---|
| `/health` | GET | ops |
| `/<bucket>/<key>`（标准 S3 路径） | GET/PUT/HEAD/DELETE | proxy（透明代理 MinIO） |
| `/objects/stat` `/objects/delete` | POST | proxy（服务端控制，服务 token） |
| `/presign/put` `/presign/get` | POST | presign |
| `/token` | GET | auth（OCI bearer） |
| `/v2/*` | * | oci |

鉴权网关即闸、内联在每个请求（无 `/auth` forward_auth 子请求）。

## 四 · 功能规格 + 验收

### 4.1 `api/` · 连 MinIO（唯一碰 S3/MinIO 的层）

- `client.ts`：一个 `createS3Client(opts)` 工厂，按 endpoint 建两个实例——**internal**（转发，`S3_INTERNAL_ENDPOINT`）/ **public**（签名，`S3_PUBLIC_ENDPOINT`）。均 `requestChecksumCalculation/responseChecksumValidation: 'WHEN_REQUIRED'`、`forcePathStyle`。
- `bucket.ts`：`pingBucket` / `ensureBucket`（HeadBucket→404 则 CreateBucket；3s 上限）。
- `objects.ts`：`put`（`If-None-Match` 条件写）/ `stat`（HEAD，404→null）/ `get`（Range，body 为 Readable）/ `delete`。错误归一，SDK 类型不泄出。
- `presign.ts`：`presignGet`（TTL、response-disposition/type/cache）/ `presignPut`（TTL、`signableHeaders: content-type`）。
- **验收**：`/health` 探测通；put→stat→get→delete 往返一致；presignGet `200`、Range `206`、presignPut 对类型 `200`/错类型 `403`。

### 4.2 `proxy/` · 数据面 = 标准 S3 端点

网关自己就是标准 S3 端点，**透明代理**到内网 MinIO（`127.0.0.1:9000`）：
- 浏览器 / 后端都用 presigned URL 打网关（标准 S3 路径 `GET/PUT/HEAD/DELETE /<bucket>/<key>`）；网关校验 token/IP 后**原样转发**给 MinIO（method/path/query/headers/Host 全保持，body stream pipe 禁 buffer），MinIO 验 S3 签名。
- 后端少数服务端动作（stat/delete 等 presigned 不便）走控制端点 `/objects/stat` `/objects/delete`（服务 token），网关用 MinIO 凭证执行。
- 路由分流：`/v2`（oci）· 标准 S3 路径（proxy）· `/presign` `/token` `/health`（控制）。
- **验收**：100MB 流式不 OOM；Range `206`；`If-None-Match` 命中 `412`；Host 透传签名通过；presigned 直连网关 `200/206`。

### 4.3 `presign/` · 签发控制面

- `POST /presign/put` `{key, expiresIn, contentType?, client_ip, sub, resource_id?}` → `{url, method:'PUT', contentType?, key}`
- `POST /presign/get` `{key, expiresIn, client_ip, sub, resource_id?, responseContentDisposition?, responseContentType?, responseCacheControl?}` → `{url, key}`
- 可选 `KEY_SCHEME=date`（默认 flat）：put / multipart create 加 `YYYY/MM/` 前缀，**响应恒回实际 key**（token 绑实际 key）；撞名裁决归后端。
- 注入 `access_token`（**标准 JWT**，jose HS256，网关自验；query 参数签进 URL；claims：`sub/resource_id/key/op/exp/ip/jti/aud`）。
- key 由业务后端生成；PUT body 不签；checksum `WHEN_REQUIRED`。
- **验收**：token 篡改/过期 → 401；TTL 边界 1–604800 拒绝越界；类型不符 PUT 403。

### 4.4 `auth/` · 鉴权（网关即闸，每个请求上跑）

网关自己就是数据面入口，鉴权在网关对每个 S3 / 控制请求**内联执行**（不再依赖 Caddy forward_auth）：
- S3 数据请求：`access_token`（JWT）校验（签名/exp/aud/op/路径归属）+ **IP 绑定**（`token.ip` vs 客户端 IP，不一致 403；只信可信反代 `X-Forwarded-For` / 直连 TCP peer）；S3 签名本身由 MinIO 验。
- 服务间：`service token`（后端 / D1 / D2）。
- OCI：`GET /token`（bearer，scope `repository:<name>:pull/push`）。
- 吊销**不做**（JWT 到 exp 自然失效，短 TTL 缓解）；一次性 nonce（触发点 P5，先不做）。
- **验收**：换 IP 403；过期/篡改 401；service token 校验；OCI scope 校验。

### 4.5 `multipart/` · 分片（大文件触发点，但规格全量实现）

- `upload_session` 状态：`create / signPart / listParts / complete / abort`（该 MinIO `ListMultipartUploads` 恒空 → **自持久化 uploadId**）。
- `complete`：逐片 ETag 对账；**缺片返回重签 URL 自愈**（不报错）。
- 断点续传：按 `uploadId` + `listParts` 恢复。
- 过期 `upload_session` 清理（按表扫，定时 abort）。
- checksum `WHEN_REQUIRED`；非末片 5 MiB 下限。与秒传/去重冲突 → 归业务侧，网关不判。
- **验收**：多片合并 SHA-256 一致；缺片重签；过期清理；非末片 <5MiB 报 `EntityTooSmall`。

### 4.6 `oci/` · 制品（.kcplan）

- `/v2/` API：`GET /v2/`；`HEAD/GET/PUT/DELETE /v2/<name>/manifests/<ref>`；`HEAD/GET /v2/<name>/blobs/<digest>`；`POST/PATCH/PUT/DELETE /v2/<name>/blobs/uploads/...`；`GET /v2/<name>/tags/list`。
- `.kcplan` → OCI artifact：config=`application/vnd.kc.plan.config.v1+json`、layer=`.kcplan` zip（`application/vnd.kc.plan.layer.v1.tar+gzip`）、manifest annotations=`name/version/plan_id/protocol_version/source/required_capabilities`、tag=version、digest=sha256。
- 存储：blob/manifest → MinIO object（key=digest）；`tag→digest` 索引 → 每 repo 一个 MinIO 对象（registry 状态，非文件元数据）。
- D1 push / D2 pull；悬挂 blob GC（触发点）。
- **验收**：`oras push` / `oras pull` 通；digest 校验；tag 解析正确；错误码符合 distribution spec。

### 4.7 `ops/` · 安全运维

- `/health`：MinIO 探测 + 桶健康。
- audit：`who / key / op / 结果`；**脱敏**（不记完整 presign URL / Location / 凭证）。
- rate-limit：按用户 / 服务 / 路径。
- 结构化日志；优雅关闭。
- **验收**：日志不含 secret / 完整 URL；限流 `429`；优雅关闭不丢在途。

## 五 · 边界（不做）

文件元数据（`resources` 在业务 PG）、去重 / 秒传判据、ingest、分类型分桶 / 多租户、对象级授权（判据留业务侧）。网关主体只做传输层。

**可选加工模块（2026-11-23 拍板，缺省关闭、config 开启）**：缩略图（`thumbnail/`）、日期路径方案（presign 扩展 `KEY_SCHEME=date`）。开启时网关做有限加工，设计见各模块 design；判据与元数据仍归业务侧。

## 六 · 约定

- 代码风格同 `app/server`：文件头 `/** … */` 使用说明（写过就不逐函数注释）、`export` 值/类型置顶、类型就近、私有工具紧跟主函数。
- **密钥不打印、不进错误信息**；**对外错误不泄露** MinIO 地址 / bucket / object key。
- 路径 ASCII、英文 kebab。

## 七 · 权威外部设计

- `_Agents/handoff/design-2026-11-23-minio-gateway-interface.md`（五面接口 / 传输约束 / 部署）
- `_Agents/handoff/design-2026-11-23-two-domain-kcplan.md`（.kcplan 制品边界）