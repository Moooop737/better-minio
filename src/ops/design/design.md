# ops · 设计稿

> 日期：2026-11-23 · 状态：**设计已收口，未落码**
> 上游：[AGENTS.md](../../../AGENTS.md) §4.7；auth §六（Identity / 脱敏红线 / core 错误口径）；proxy §2.4（字节计数）。
> 下游：实现前先读本文件 → 同目录产出 `spec.md` → 按 spec 落码。
> 现状：`/health` 骨架已在 index.ts（pingBucket），本模块收编并扩展；index.ts 的 console.* 实现时迁 logger。

---

## 〇 · 职责与边界

安全运维横切层：health / 结构化日志 / audit / rate-limit / 优雅关闭。全部是 middleware + 装配钩子，**不拥有业务路由**（health 除外）。

- 做：探活、请求级日志与审计事实、按身份限流、脱敏、drain 关闭。
- 不做：日志聚合/查询（stdout 交 docker logs，Loki 等是触发点）、指标导出（Prometheus 触发点）、告警通知。

## 一 · `/health`

- 无鉴权（探针）；GET → MinIO `pingBucket` +（配了 Redis 时）PING。
- 200 `{ok:true, bucket, minio:'up', redis?:'up'}`；任一关键依赖 down → 503 `{ok:false, …}`。**ok = MinIO up 且（Redis 若配置则 up）**——Redis 配了却 down 时状态写入会失败，health 如实反映。
- 响应不含 MinIO 地址 / 凭证；bucket 名可回（本就在客户端 URL 里）。
- 启动 ensureBucket 沿用现状（缺则建、失败告警不阻塞）。

## 二 · 结构化日志（pino）

- **pino**（与主项目同库同口径）；`LOG_LEVEL` env 默认 `info`。
- **request_id**：ALS（node:async_hooks）贯穿请求；入口 middleware 取 incoming `x-request-id`（关联标签，非安全凭据）或铸 uuid；pino mixin 自动带 `request_id`。
- **请求日志字段**：`method / path（仅路径，绝不含 query）/ status / duration_ms / identity / request_id`。
- **redact 路径**：`req.headers.authorization`、`*.access_token`、`*.token`、`*Secret*`、`*secret*`；**URL 一律不整条进日志**（query 里有 access_token 与 X-Amz 签名）——serializer 只取 pathname。
- 错误日志：GatewayError 的 code + 通用 message；上游错误记内部诊断（可含 MinIO 状态码），**对外响应**仍按各面脱敏渲染（auth §六）。

## 三 · audit（D1）

- **sink = 结构化日志行**（`event:'audit'`），不落独立存储：网关无 DB，stdout 由 docker logs 收；查询/聚合是触发点（Loki）。
- 字段：`request_id, who（identity.sub 或 service name）, op（method + 路由类）, key, ip, status, duration_ms, bytes_up/down（proxy 计数）`。
- 时机：响应结束（含流式 close）记一条；闸拒绝也记（status 401/403，who 可能缺失 → `anonymous`）。
- **key 进审计日志**（内部可观测需要，AGENTS.md audit 口径 who/key/op/result）；**对外错误不泄 key**（两条口径不冲突：日志内部、响应外部）。
- 豁免：/health、OPTIONS 预检不记 audit（噪音）。

## 四 · rate-limit（D2）

- 库：**rate-limiter-flexible**（成熟，Redis/memory 双实现 + insurance 降级）。
- 维度与默认（env 可调，窗口固定 60s，先宽后紧）：

| 面 | key | 默认 | env |
|---|---|---|---|
| 控制面（presign/objects/multipart/thumbnail） | service name | 60/min | `RATE_LIMIT_CONTROL` |
| 数据面（S3 路径） | token.sub | 300/min | `RATE_LIMIT_DATA` |
| OCI `/v2/*` | bearer sub（service name） | 120/min | `RATE_LIMIT_OCI` |

- 存储：配 Redis → RateLimiterRedis（重启计数不丢）；否则 memory。Redis 运行期断连 → insurance limiter 降级 memory（限流不变成单点故障）。
- 豁免：/health、OPTIONS。
- **开关（已定）**：`RATE_LIMIT_ENABLED` 默认 `true`；`false` = 限流 middleware 不装。`AUDIT_ENABLED` 默认 `true`；`false` = 不记 audit 行（基础请求日志仍在）。均严格布尔，非法拒启。
- **429 按面渲染（D3）**：控制面 JSON `{code:'E_RATE_LIMIT'}`；数据面 S3 XML `SlowDown`；OCI distribution `TOOMANYREQUESTS`。均带 `Retry-After`。
- 限流在闸**之后**（先认身份再按身份限；未认证请求由闸 401，不消耗合法用户配额）。

## 五 · 优雅关闭（D4）

SIGTERM/SIGINT → 编排：

1. 停接受新连接（`server.close()` + `closeIdleConnections()`）。
2. drain 在途（含流式上传/下载）；**不主动 abort 在途分片**——会话在 Redis 活着，客户端可续。
3. 停定时器（multipart 清理 / oci chunk 清理 / thumbnail worker 消费）。
4. 关 Redis、flush pino。
5. exit 0；**超 `SHUTDOWN_TIMEOUT`（默认 30s）强制 exit 1**。
- compose 配套：`stop_grace_period: 35s`（大于 SHUTDOWN_TIMEOUT，README 写明）。
- @hono/node-server 的 serve 返回 node server，close 语义可用；流式响应 drain 以 outgoing 'close' 为准。

## 六 · 模块接口与装配

```
src/ops/
  logger.ts     pino 实例 + redact + ALS request_id + mixin
  audit.ts      audit middleware（响应结束记事实）
  rate-limit.ts limiter 工厂（Redis/memory + insurance）+ 按面 middleware
  health.ts     /health 路由（MinIO + 可选 Redis 探针）
  shutdown.ts   drain 编排（注册定时器/redis/server 钩子）
```

- 装配顺序（index.ts）：request_id → 日志 → 各面路由（内联闸 + 限流）→ audit 包裹 → health；shutdown 注册 server/redis/定时器。
- 新增依赖：`pino`、`rate-limiter-flexible`。
- 配置新增：`LOG_LEVEL`（info）、`RATE_LIMIT_CONTROL`（60）、`RATE_LIMIT_DATA`（300）、`RATE_LIMIT_OCI`（120）、`RATE_LIMIT_ENABLED`（true）、`AUDIT_ENABLED`（true）、`SHUTDOWN_TIMEOUT`（30）。`.env.example` / README 同步。
- 启动日志打印生效功能集（读 config 开关，不含密钥）——装配状态的唯一可观测入口。

## 七 · 验收

1. 走一遍 presign + 上传 + 下载：捕获日志输出，**断言不含 access_token 值 / X-Amz-Signature / Authorization / 完整 URL**；audit 行含 who/key/op/status。
2. 超配额 → 429：控制面 JSON / 数据面 SlowDown XML / OCI TOOMANYREQUESTS，带 Retry-After；/health 与 OPTIONS 不限。
3. 闸拒绝（401/403）也留 audit；未认证不消耗合法配额。
4. MinIO down → /health 503；配 Redis 且 down → 503；恢复 → 200。
5. 慢上传在途时 SIGTERM → 该请求完成、新连接拒收、exit 0；超 timeout → exit 1。
6. request_id：incoming x-request-id 透传进日志；无则铸 uuid。
7. Redis 断连 → 限流降级 memory 仍生效（不 500）。

## 八 · 决策清单

| # | 决策 | 结论 | 状态 |
|---|---|---|---|
| D1 | audit sink | 结构化日志行（stdout），独立存储/查询是触发点 | **已定**（2026-11-23） |
| D2 | 限流维度/默认 | 控制 per-service 60/min、数据 per-sub 300/min、OCI 120/min；rate-limiter-flexible + insurance | **已定**（2026-11-23） |
| D3 | 429 渲染 | 按面：E_RATE_LIMIT / SlowDown / TOOMANYREQUESTS + Retry-After | **已定**（默认通过） |
| D4 | 关闭 | drain 30s 超时强退；compose stop_grace_period 35s | **已定**（默认通过） |
| D5 | 功能开关 | `RATE_LIMIT_ENABLED` / `AUDIT_ENABLED` 默认 true；关 = middleware 不装 / 不记 audit 行 | **已定**（2026-11-23） |

## 九 · 与上游文档的差异（spec 阶段同步回写）

- AGENTS.md §4.7：health 补 Redis 探针口径；audit 落 stdout 日志行；限流默认值与按面 429；关闭 timeout 与 compose 配套。
- index.ts 现有 /health 与 console.* 收编进 ops（实现时迁移，行为兼容）。