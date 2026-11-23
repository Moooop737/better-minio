# auth · spec

> 依据：[design.md](design.md)（全部决策已定）。本文件是文件级契约；实现与测试按此对齐。

## 文件与签名

| 文件 | 导出 | 契约 |
|---|---|---|
| `token.ts` | `createTokenService(secret, now?) → TokenService` | HS256，`iss=better-minio`，`aud` 分 `data-plane` / `registry`，不做时钟容差；任何校验失败统一 `GatewayError('E_TOKEN_INVALID')` |
| | `TokenService.issueDataPlane({sub, resourceId?, key, op, ip, expiresIn})` | `exp = now + expiresIn`（与 X-Amz-Expires 同寿），`jti = uuid` |
| | `TokenService.verifyDataPlane(token) → DataPlaneClaims` | claims 形状不符也算 invalid |
| | `TokenService.issueRegistry({sub, grants})` / `verifyRegistry(token)` | `exp = now + 300` |
| `service-token.ts` | `createServiceTokenVerifier(entries)` → `match / fromBearer / fromBasic` | `timingSafeEqual` 遍历全表；Basic 的 name 必须与 token 对应条目一致 |
| `client-ip.ts` | `resolveClientIp(remoteAddress, xff, trusted) → string \| null`；`normalizeIp(raw)`；`ipInCidrs(ip, cidrs)` | peer 不可信直接用 peer；可信则 XFF 右往左取第一个不可信；取不到 → `null` |
| `scope.ts` | `parseScope(raw)`；`grantScopes(service, requested, pushServices)`；`hasScope(grants, name, action)`；`isRepositoryName` | distribution 名字正则；actions ⊆ {pull, push}（`*` 展开为允许集）；push 仅白名单 |
| `gate.ts` | `createDataPlaneGate({tokens, bucket, trustedProxies, ipGateEnabled})` | middleware；顺序：缺 token 401 → 验签 401 → op 403 → bucket+key 精确 403 → IP 403；`c.set('identity'/'auditKey')` |
| | `createServiceGate(verifier)` | `Authorization: Bearer`；失败 401 `E_SERVICE_TOKEN` |
| | `createOciGate(tokens, publicEndpoint).authorize(c, name, action)` | 失败抛错带 `extra.challenge`（`Bearer realm="<public>/token",service="better-minio",scope=…,error=…`）；scope 不足 403 `E_SCOPE` |
| | `parseDataPlanePath(rawUrl)` | 原始请求行 → `{bucket, key}`（percent-decoding，`+` 为字面量） |
| `routes.ts` | `mountTokenRoute(app, {tokens, verifier, pushServices})` | `GET /token`；`service` 参数给了必须是 `better-minio`（400）；Basic 缺失/坏 401；返回 `{token, access_token, expires_in:300, issued_at}`，`Cache-Control: no-store` |

## 配置（config.ts）

`TOKEN_SECRET`（必填 ≥32）、`SERVICE_TOKENS`（必填，`name:token`，token `[A-Za-z0-9_-]{32,}`，name `[a-z0-9][a-z0-9_-]*`，重名拒启）、`TRUSTED_PROXIES`（IP/CIDR 列表，默认空）、`OCI_PUSH_SERVICES`（默认 `d1`）、`IP_GATE_ENABLED`（默认 true，false 时启动告警）。

## 错误码

`E_TOKEN_MISSING` 401 · `E_TOKEN_INVALID` 401 · `E_SERVICE_TOKEN` 401 · `E_OP_MISMATCH` 403 · `E_PATH_MISMATCH` 403 · `E_IP_MISMATCH` 403 · `E_SCOPE` 403 · `E_VALIDATION` 400（scope / service 参数）。渲染归各面（S3 XML / JSON / distribution）。

## 测试清单（test/auth/）

- token：往返、篡改、过期边界（无容差）、aud 跨用、异密钥。
- client-ip：不可信 peer 忽略 XFF、可信链右往左、全可信 → null、非法 XFF、默认不信任、`::ffff:` 规范化。
- service-token：Bearer/Basic 命中与拒绝、SERVICE_TOKENS 解析拒启。
- scope：解析、非法、push 白名单裁剪、hasScope。
- gate（真 node server）：放行 + identity、401 两类、换 IP 403、op/路径/桶 403、分片 query 不影响、IP 闸关闭、/token 流程（challenge、d2 push 被裁 403、Basic 错 401、service 错 400）、数据面 token 打 /v2 401。
