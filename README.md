# better-minio

MinIO 薄网关 —— 坐在 MinIO 前的一层通用服务，讲公开标准（OCI Distribution 制品 + S3 文件）：凭证隔离、presign 签发、S3 数据面转发、IP 绑定闸、审计限流。

> 状态：**架构 + 文档就绪，按 [AGENTS.md](AGENTS.md) 全量实现。** 当前已通「连上 MinIO」骨架（config + S3 client + `/health`）。

## 为什么存在

presigned URL 是 bearer，绑不了 IP；MinIO 只验 S3 签名、不看 IP。要「换网络即拒」、要凭证隔离、要审计，只能有个站在 MinIO 前的闸——就是本项目。

## 端口口径（两套 endpoint）

- `S3_INTERNAL_ENDPOINT`：网关 → MinIO 的真连接（生产 `127.0.0.1:9000`）。
- `S3_PUBLIC_ENDPOINT`：presign 签进 URL 的 Host（浏览器可见入口，Caddy 反代保持 Host）。

## 目录

见 [AGENTS.md · 目录](AGENTS.md#目录按功能点分)；设计见 [docs/design.md](docs/design.md)；每个功能点的规格在 `src/<feature>/README.md`。

## 运行

```bash
cp .env.example .env        # 填 S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY 等
npm install
npm run dev
curl -s localhost:9100/health   # {"ok":true,"bucket":"kbfile"}
```