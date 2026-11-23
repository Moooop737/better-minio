# ops · spec

> 依据 [design.md](design.md)（已收口）。本文是文件级契约；实现与测试按此落地。

## 文件与导出

### `logger.ts`
- `logger: Logger`（进程单例）、`createLogger(level?, dest?) → Logger`、`runWithRequestId(id, fn)`、`currentRequestId() → string | null`、`safePath(rawUrl) → string`。
- redact：`authorization` / `access_token` / `token` / `secret` / `tokenSecret` / `s3SecretAccessKey` / `cookie`（顶层、一层嵌套、`req.headers.*`、`headers.*`），censor `[redacted]`。
- serializers：`url` / `path` → `safePath`（只留 pathname）；`location` → `[redacted]`（presign Location 整条不进日志）。
- mixin：ALS 内自动带 `request_id`。

### `request-id.ts`
- `requestIdMiddleware() → MiddlewareHandler<AppEnv>`：取 `x-request-id`，合法（`^[A-Za-z0-9._-]{1,128}$`）透传，否则 `randomUUID()`；`c.set('requestId')`、回写响应头 `x-request-id`；下游在 `runWithRequestId` 内执行。
- `requestLogMiddleware(logger) → MiddlewareHandler<AppEnv>`：响应结束记 `{event:'request', method, path, status, duration_ms, identity, request_id}`；`path` = `safePath`，`identity` = `whoOf(identity)`（只 who，不含 token）。
- `whoOf(identity | undefined) → string`：browser→sub / service→name / registry→sub / 缺失→`anonymous`。
- `afterResponse(c, fn)`：有 `c.env.outgoing` 且未关闭 → 等 `'close'`（流式响应以真正写完为准）；否则立即执行。

### `audit.ts`
- `auditMiddleware(logger, options?: { trustedProxies?: Cidr[] }) → MiddlewareHandler<AppEnv>`
- 每请求一条 `{event:'audit', request_id, who, op, key, ip, status, duration_ms, bytes_up, bytes_down}`，在 `afterResponse` 时记。
- `op` = `<METHOD> <class>`，class ∈ `s3 | presign | objects | multipart | oci | token | thumbnail`（`routeClass(path)` 按前缀判，其余归 `s3`）。
- `key` = `c.get('auditKey') ?? null`；`ip` = browser identity 的 ip，否则 `resolveClientIp(peer, XFF, trustedProxies)`，无则 `null`；`bytes_*` 缺省 0。
- 豁免：`/health`、`OPTIONS`。闸拒绝经 onError 渲染后回到本 middleware，同样记（status 401/403，who=`anonymous` 或已认出的身份）。
- `AUDIT_ENABLED=false` 由 index 不装本 middleware。

### `rate-limit.ts`
- `createRateLimits({ enabled, control, data, oci, redis: Redis | null }) → { control, data, oci: RateLimit | null }`
- `enabled=false` → 三面全 `null`。
- 每面一个 limiter，窗口 60s，points = 面配额；`redis` 给了 → `RateLimiterRedis`（`keyPrefix better-minio:rl:<face>`、`rejectIfRedisNotReady: true`、`insuranceLimiter: RateLimiterMemory` 同配额）；否则 `RateLimiterMemory`。
- key：`svc:<name>` / `sub:<sub>` / `reg:<sub>`；无身份（理论上闸在前不会发生）→ `anon`。
- 超额 → `GatewayError('E_RATE_LIMIT', '请求过于频繁', { retryAfter: ceil(msBeforeNext/1000) ≥ 1 })`。
- 存储层异常（insurance 已兜底仍失败）→ **放行**（限流不成为单点故障）。

### `health.ts`
- `mountHealth(app, { internalClient, bucket, stateStore })`：`GET /health`，无鉴权。
- `pingBucket`（2s）+ `stateStore.kind==='redis'` 时 `ping()`（2s 上限）。
- 200 `{ok:true, bucket, minio:'up', redis?:'up'}`；任一 down → 503 `{ok:false, bucket, minio, redis?}`。不含地址/凭证。

### `shutdown.ts`
- `createShutdown({ server, timeoutMs, logger, exit? }) → { register(name, fn), install(), run() }`
- `run()` 幂等（重复信号复用同一 promise）：
  1. `server.close()` + `closeIdleConnections()`（之后每 250ms 再关一次新变空闲的 keep-alive 连接）；
  2. 等 close 回调（= 在途请求含流式全部结束）；
  3. 按注册顺序执行钩子（定时器 / worker / redis），单个钩子失败只记日志；
  4. `logger.flush()`；`exit(0)`。
  - 超 `timeoutMs` → 记 error、`closeAllConnections()`、flush、`exit(1)`。`run()` 在调用 exit 后 resolve。
- `install()`：`process.once('SIGTERM'|'SIGINT', run)`。`exit` 缺省 `process.exit`。

## 错误码
- `E_RATE_LIMIT`（429，extra.retryAfter → 各面渲染 `Retry-After`）。其余 ops 不抛业务错误。

## 测试清单（test/ops/）
- `logger.test.ts`：请求日志 + audit + 显式记录含 token 对象 → 输出不含 access_token 值 / X-Amz-Signature / Authorization 值 / 完整 URL；`safePath` 剥 query。
- `request-id.test.ts`：合法 x-request-id 透传（响应头 + 日志）；非法/缺失 → uuid。
- `audit.test.ts`：成功请求字段齐全（who/op/key/ip/status/bytes）；闸拒绝 401 也记且 who=anonymous；/health 与 OPTIONS 不记；流式响应等 close。
- `rate-limit.test.ts`：控制面超额 429 JSON E_RATE_LIMIT + Retry-After；按身份隔离；disabled → null；Redis 指向关闭端口 → insurance memory 仍限流不 500（无 Redis 服务器，只测断连降级路径）。
- `health.test.ts`（moto）：200 up；endpoint 死 → 503。
- `shutdown.test.ts`：慢请求在途 → 完成 200、新连接拒、exit(0)；超时 → exit(1)；钩子按序执行。
