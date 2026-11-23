# better-minio 镜像：配置面 = 环境变量（见 .env.example）；sharp 走 glibc prebuilt，故用 slim 而非 alpine。
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
ENV NODE_ENV=production \
    GATEWAY_HOST=0.0.0.0
EXPOSE 9100
USER node
CMD ["npx", "tsx", "src/index.ts"]
