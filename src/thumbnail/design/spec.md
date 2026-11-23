# thumbnail · spec

> 依据 [design.md](design.md)（已收口）。`THUMBNAIL_ENABLED=false` 时 index 不调用本模块任何入口（路由不挂、订阅不接、worker 不起）。

## 文件与导出

### `process.ts`
- `previewKeyFor(key, format) → string` = `previews/<key>.<format>`（ext 直接取格式名：`webp` / `jpeg` / `png`）。
- `isPreviewKey(key) → boolean`：`previews/` 前缀（派生对象不再派生，防环）。
- `isThumbnailSource(contentType | null) → boolean`：归一（小写、去参数）后 ∈ 可解码集合。
- `THUMBNAIL_SOURCE_TYPES`：设计集合 `image/jpeg`(+`image/jpg`) / `image/png` / `image/webp` / `image/gif` / `image/bmp`(+`image/x-ms-bmp`) **与当前 sharp 构建的输入能力取交集**（运行时查 `sharp.format[*].input`）。**缺口决策**：sharp 官方 prebuilt libvips 不含 BMP loader，bmp 在这类构建上被排除（不入队、端点 400），而不是入队后注定失败 3 次；自建带 magick 的 libvips 时自动启用。svg 永不做。
- `generateThumbnail({ client, bucket, key, width, format, quality }) → Promise<ThumbnailResult>`
  - `{status:'missing'}`：原图不存在；`{status:'unsupported'}`：对象 content-type 不在可解码集合；`{status:'ok', previewKey, width, height}`。
  - 管线：`getObject` 流 → `sharp({ failOn:'error' }).rotate().resize({ width, withoutEnlargement:true }).toFormat(format, { quality })` → `putObject(previews/…)`（**不加** If-None-Match，派生允许覆盖）。gif 取首帧（sharp 默认 pages=1）。
  - 解码失败抛 `ThumbnailDecodeError`；存储失败透出 `ObjectStoreError`。

### `subscribe.ts`
- `subscribeThumbnails({ events, enqueue(job), cancel(key), logger }) → () => void`（返回取消订阅）。
- `object:put` / `object:complete`：`isPreviewKey` 跳过；`isThumbnailSource(contentType)` 否 → 跳过（contentType 为 null 也跳过）；是 → `enqueue({key, contentType, attempts:0})`。
- `object:delete`：`cancel(key)`（移除待处理 job + best-effort 删派生）。
- 回调里的异步错误只记日志，不冒泡到 emit 方。

### `worker.ts`
- `THUMBNAIL_QUEUE_KEY = 'better-minio:thumbnail:queue'`、`THUMBNAIL_MAX_ATTEMPTS = 3`（总尝试次数上限：首次 + 2 次重试；第 3 次失败即丢弃 + error 日志）。
- `startThumbnails({ internalClient, bucket, stateStore, events, width, format, quality, logger, pollMs? }) → { stop(): Promise<void>, drain(): Promise<void> }`
  - 队列：`stateStore.listPush/listPop`（Redis list 重启不丢；内存重启丢，显式接受）。
  - 入队去重：先 `listRemove` 同 key 旧 job 再 push（留最新）。
  - 消费：并发 1；空队列时等 `pollMs`（默认 1000ms）或被本进程入队唤醒。
  - 结果：ok → info；missing / unsupported → 丢弃（debug/warn）；异常 → attempts+1，未达上限且队列里无同 key 新 job 时回队尾，否则丢弃。
  - 删除联动：移除队列中同 key job；`deleteObject(previewKeyFor(key))` best-effort（失败 warn）；若该 key 正在加工，加工完成后再删一次派生（防删后复活）。
  - `stop()`：取消订阅、停止循环、等当前 job 结束（不 abort）。`drain()`：等在途入队完成且队列清空、worker 空闲（测试 / 运维用）。

### `routes.ts`
- `mountThumbnail(app, { internalClient, bucket, serviceGate, rateLimit, width, format, quality })`：`POST /thumbnail/generate`。
- 顺序：serviceGate → rateLimit → body 校验（`{key: string 1..1024}`，`previews/` 前缀拒绝）→ `c.set('auditKey', key)` → 同步加工。
- 200 `{previewKey}`；原图不存在 404 `E_NOT_FOUND`；非图片 / 解码失败 / 校验失败 400 `E_VALIDATION`；存储失败 502 `E_UPSTREAM`。错误文案不含 key / bucket。

## 错误码
`E_SERVICE_TOKEN`(401，闸) / `E_RATE_LIMIT`(429) / `E_VALIDATION`(400) / `E_NOT_FOUND`(404) / `E_UPSTREAM`(502)。

## 测试清单（test/thumbnail/，moto）
- 上传 sharp 生成的 1200×800 jpeg → emit `object:put` → `previews/<key>.webp` 出现且宽 300；
- 小图（120 宽）不放大；`object:complete` 同样触发；
- 非图片 / svg / `previews/` key 不入队、无派生；
- delete → 派生消失、队列 job 清除；
- 坏图（content-type jpeg、body 非图片）→ 尝试 3 次后丢弃 + error 日志、无派生；
- 同 key 入队去重；
- `/thumbnail/generate`：200 + previewKey、404 缺失、400 非图片、401 无 service token；
- `previewKeyFor` / `isThumbnailSource` 定义。
