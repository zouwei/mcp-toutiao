# syntax=docker/dockerfile:1.6
#
# 基础镜像用 Playwright 官方版：Chromium 与它的一堆系统依赖已经装好，
# 自己从 ubuntu 装的话要维护三十来个 lib 包，而且版本一错就是白屏。
#
# ⚠ 版本必须与 package.json 里的 playwright 对齐（scripts/check-image-tag.mjs 在 CI 里校验）。
#   不对齐的话运行时会尝试下载浏览器 —— 容器里没网就失败得莫名其妙。
ARG PLAYWRIGHT_VERSION=1.62.1

# ---- build ----
FROM node:22-slim AS builder
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN pnpm build && pnpm prune --prod

# ---- run ----
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble

ENV TZ=Asia/Shanghai \
    NODE_ENV=production \
    TOUTIAO_DATA_DIR=/app/data \
    HOST=0.0.0.0 \
    PORT=18070

# 中文字体：没有它，页面上的中文全是方块 —— 截图给人看时完全没法用，
# 而且有些按钮的文案定位会因为字形宽度异常而错位。
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-wqy-zenhei fonts-noto-color-emoji tini \
 && rm -rf /var/lib/apt/lists/* \
 && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime

WORKDIR /app
COPY --from=builder /src/node_modules ./node_modules
COPY --from=builder /src/dist ./dist
COPY package.json ./

# data = 浏览器 profile（登录态，丢了要重新扫码）；images = 与调用方交换配图的挂载点
RUN mkdir -p /app/data /app/images && chmod -R 777 /app/data /app/images

EXPOSE 18070

# tini 回收浏览器退出后被过继过来的子进程，否则僵尸进程会一直堆积
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
CMD ["node", "dist/cli.js", "serve"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||18070)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
