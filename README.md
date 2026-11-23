# better-minio

MinIO 薄网关 —— 坐在 MinIO 前的一层通用服务，讲公开标准（OCI Distribution 制品 + S3 文件）：凭证隔离、presign 签发、S3 数据面转发、IP 绑定闸、审计限流。

> 状态：按 [AGENTS.md](AGENTS.md) 全量实现（auth / presign / proxy / multipart / oci / ops / thumbnail）。权威文档 = AGENTS.md；每个模块的设计在 `src/<module>/design/design.md`，文件级契约在 `src/<module>/spec.md`。

## 为什么存在

presigned URL 是 bearer，绑不了 IP；MinIO 只验 S3 签名、不看 IP。要「换网络即拒」、要凭证隔离、要审计，只能有个站在 MinIO 前的闸——就是本项目。

## 拓扑与端口口径

网关自己就是标准 S3 端点（公开 `:9100`），前置内网 MinIO（`127.0.0.1:9000`）；Caddy 只做 TLS 终止（必须保持 Host）。

- `S3_INTERNAL_ENDPOINT`：网关 → MinIO 的真连接（生产 `http://127.0.0.1:9000`）。
- `S3_PUBLIC_ENDPOINT`：presign 签进 URL 的 Host = 网关公开入口（浏览器实际访问的地址）。
- MinIO Console `9001` 只留 tailnet/localhost，绝不公网、不经网关。

## 端点

| 端点 | 方法 | 鉴权 |
|---|---|---|
| `/health` | GET | 无 |
| `/<bucket>/<key>` | GET / HEAD / PUT（其他 405） | presigned URL 内 `access_token`（JWT）+ IP 绑定；S3 签名由 MinIO 验 |
| `/presign/put` `/presign/get` | POST | service token |
| `/objects/stat` `/objects/delete` | POST | service token |
| `/multipart/create` `sign-part` `list-parts` `complete` `abort` | POST | service token（`MULTIPART_ENABLED`） |
| `/thumbnail/generate` | POST | service token（`THUMBNAIL_ENABLED`） |
| `/token` | GET | Basic `name:serviceToken`（`OCI_ENABLED`） |
| `/v2/*` | OCI Distribution | bearer（`OCI_ENABLED`） |

## 配置

镜像配置面 = 环境变量，完整列表与默认值见 [.env.example](.env.example)。功能开关严格 `true`/`false`，非法拒启；启动日志打印生效功能集（不含密钥）。

## 运行

```bash
cp .env.example .env        # 填 S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY / TOKEN_SECRET / SERVICE_TOKENS 等
npm install
npm run dev
curl -s localhost:9100/health   # {"ok":true,"bucket":"kbfile","minio":"up"}
```

docker-compose 片段（`stop_grace_period` 必须大于 `SHUTDOWN_TIMEOUT`，默认 30s）：

```yaml
services:
  better-minio:
    build: .
    network_mode: host
    stop_grace_period: 35s
    environment:
      GATEWAY_HOST: 0.0.0.0
      S3_INTERNAL_ENDPOINT: http://127.0.0.1:9000
      S3_PUBLIC_ENDPOINT: https://files.example.com
      S3_BUCKET: kbfile
      S3_ACCESS_KEY_ID: ${MINIO_ACCESS_KEY}
      S3_SECRET_ACCESS_KEY: ${MINIO_SECRET_KEY}
      TOKEN_SECRET: ${GATEWAY_TOKEN_SECRET}
      SERVICE_TOKENS: backend:${BACKEND_TOKEN},d1:${D1_TOKEN},d2:${D2_TOKEN}
      TRUSTED_PROXIES: 127.0.0.1
      OCI_ENABLED: "true"
      # REDIS_URL: redis://127.0.0.1:6379
```

无 Redis 时 multipart 会话在重启后丢失，MinIO 里未完成的 multipart upload 需由桶 ILM 规则（incomplete multipart upload 过期）兜底。

## 开发

```bash
npm run typecheck
npm test            # 集成用例需要 python3 + moto（pip install 'moto[server]'）作 S3 替身；缺失时自动 skip
```
