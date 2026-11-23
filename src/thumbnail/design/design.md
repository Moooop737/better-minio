# thumbnail · 可选模块设计稿

> 日期：2026-11-23 · 状态：**设计已收口，未落码**
> 上游：[AGENTS.md](../../../AGENTS.md) §五（可选加工模块，2026-11-23 拍板）；[proxy 设计](../../proxy/design/design.md)、[multipart 设计](../../multipart/design/design.md)（事件源）。
> 下游：实现前先读本文件 → 同目录产出 `spec.md` → 按 spec 落码。
> 已定决策：触发 = **上传后自动钩子**；派生 key = **`previews/<原 key>.webp`**（2026-11-23）。

---

## 〇 · 职责与边界

可选图片缩略图加工：**缺省关闭**（`THUMBNAIL_ENABLED=false`），关闭时路由不挂、事件订阅不接，零开销。开启后网关做有限加工——这是 §五边界的显式例外，判据与元数据仍归业务侧。

- 做：监听对象落定事件 → 异步 sharp 压缩 → 写派生对象；显式重生成端点；删除联动。
- 不做：缩略图元数据落库（派生 key 是确定性约定，业务按约定取，无需第二份索引）、同步阻塞上传、视频/文档预览（只做图片）。
- 派生对象 = **可再生成视图**，不是真相：重生成覆盖、失败可丢、原图删则派生删。

## 一 · 配置（compose 配置面）

| env | 默认 | 含义 |
|---|---|---|
| `THUMBNAIL_ENABLED` | `false` | 总开关；`true`/`false` 严格解析，非法拒启 |
| `THUMBNAIL_WIDTH` | `300` | 目标宽度（像素），正整数；`withoutEnlargement`（小图不放大） |
| `THUMBNAIL_FORMAT` | `webp` | 输出格式（webp/jpeg/png） |
| `THUMBNAIL_QUALITY` | `80` | 输出质量 1–100 |

全部进 `config.ts` 集中解析校验；`.env.example` 与 README compose 示例同步列全（镜像使用者的配置契约）。

## 二 · 触发：上传后自动钩子

### 2.1 事件源（core/events.ts 进程内总线）

| 事件 | 发点 | 载荷 |
|---|---|---|
| `object:put` | proxy 转发**非分片** PUT 成功（2xx，query 无 partNumber） | `{key, contentType, size}` |
| `object:complete` | multipart complete 成功 | `{key, contentType}` |
| `object:delete` | `/objects/delete` 成功 | `{key}` |

- node:events 类型化总线，住 core；proxy/multipart 只 emit，**不知道谁订阅**。关闭时无人订阅，emit 空转。
- 分片中间 PUT 不触发（对象未落定）；complete 才触发。**`MULTIPART_ENABLED=false` 时 complete 事件源不存在**，只剩单 PUT 触发（依赖关系随开关自然降级）。

### 2.2 异步队列 + worker

- 订阅者过滤：contentType ∈ {jpeg, png, webp, gif, bmp}（sharp 支持集；**svg 不做**——策略清单无 svg，且矢量渲染面另议）→ 入队。
- 队列走已定持久化策略：**给了 Redis → Redis list（LPUSH/BRPOP，重启不丢待处理）；不给 → 内存队列（重启丢，显式接受——派生可再生成，丢 job 不等于丢数据）**。
- worker 并发 **1**（2c2g CPU 紧，sharp 吃核）；job = `{key, contentType, attempts}`。
- 处理：`api.get` 流 → sharp（resize width / format / quality）→ `api.put` 写 `previews/<key>.<ext>`（**允许覆盖**，派生非真相，不加 If-None-Match）。gif 取首帧（sharp 默认）。
- 重试：失败 attempts+1 回队，≤3 次后丢弃 + error 日志（派生可再生成，不设死信表）；显式端点是恢复路径。
- 同 key 重复事件（覆盖上传）：新 job 覆盖旧派生，天然幂等；队列里同 key 旧 job 可合并（入队去重，留最新）。

## 三 · 显式重生成端点

`POST /thumbnail/generate` `{key}`（service token）→ 同步加工一张 → 200 `{previewKey}`；原图不存在 → 404 `E_NOT_FOUND`；非图片类型 → 400 `E_VALIDATION`。

用途：失败恢复、参数变更后的批量重生成、业务侧显式刷新（自动钩子之外的大型按钮）。**模块关闭时此路由不挂**（404）。

## 四 · 删除联动

`object:delete` 订阅：删 `previews/<key>.<ext>`（best-effort，失败只日志）+ 移除队列中该 key 的待处理 job。原图软删/恢复归业务侧，网关只跟物理删除。

## 五 · 派生对象取用

不开新读端点：业务按约定算出 `previews/<key>.webp` → 走既有 `/presign/get` 签 URL 下载。**约定即接口**，无第二份索引（单一真相）。

## 六 · 模块接口与装配

```
src/core/events.ts        类型化事件总线（共享底座）
src/thumbnail/
  process.ts              sharp 管线（get 流 → resize → put 派生）
  worker.ts               队列消费 + 重试 + 入队去重（Redis list / 内存）
  subscribe.ts            事件接线（put/complete → 入队；delete → 清理）
  routes.ts               POST /thumbnail/generate（serviceGate）
```

- index.ts 条件装配：`THUMBNAIL_ENABLED` 真 → 挂路由 + 接订阅 + 起 worker；假 → 全不装。
- 新增依赖：`sharp`（图像处理不自研）。**Docker native 注意**：alpine 走 musl prebuilt（sharp ≥0.33 提供 linuxmusl-x64/arm64）；不稳则基础镜像换 `node:24-slim`。
- proxy/multipart 改动：各加一行 emit（事件总线解耦，不反向依赖 thumbnail）。

## 七 · 验收

1. 开启后上传 jpg → `previews/<key>.webp` 自动出现，宽度 300（小图不放大）；分片上传 complete 后同样出现。
2. 非图片上传 → 无 job、无派生。
3. 覆盖上传同 key → 派生跟着更新。
4. 删除原图 → 派生消失、队列 job 清除。
5. 显式端点重生成通；原图不存在 404。
6. 关闭时：路由 404、无订阅、上传链路零额外开销。
7. 有 Redis 重启 → 待处理 job 续跑；无 Redis 重启 → job 丢但显式端点可恢复。
8. 加工失败 ≤3 次重试后丢弃 + 日志；日志不含凭证。

## 八 · 决策清单

| # | 决策 | 结论 | 状态 |
|---|---|---|---|
| D1 | 触发方式 | 上传后自动钩子（事件总线）+ 显式重生成端点兜底 | **已定**（2026-11-23） |
| D2 | 派生 key | `previews/<原 key>.<ext>` 前缀镜像 | **已定**（2026-11-23） |
| D3 | 队列 | Redis list / 内存，跟持久化策略；并发 1；重试 ≤3 | **已定**（默认通过） |
| D4 | 格式/参数 | webp / 宽 300 / 质 80，env 可调；svg 不做 | **已定**（默认通过） |
| D5 | 取用 | 约定即接口，走既有 presignGet，无新读端点 | **已定**（默认通过） |