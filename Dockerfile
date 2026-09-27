# 构建阶段
FROM node:22-alpine AS builder

# 安装编译 better-sqlite3 所需的工具（alpine 无预编译 musl 二进制）
RUN apk add --no-cache python3 make g++

WORKDIR /app

# 只复制依赖文件，利用 Docker 缓存（package-lock.json 与本地 npm 安装保持一致）
COPY package.json package-lock.json ./

# 安装全部依赖（含 devDependencies 用于构建）
RUN npm ci --registry https://registry.npmmirror.com/

# 复制源代码并构建
COPY . .
RUN npm run build

# 清理开发依赖，只保留生产依赖
RUN rm -rf node_modules && npm ci --omit=dev --registry https://registry.npmmirror.com/

# 最终运行镜像 - 更小的基础镜像
FROM node:22-alpine

# 安装运行时必需的库（better-sqlite3 需要）
RUN apk add --no-cache libstdc++

WORKDIR /app

# 只复制必要的文件
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/configs ./configs
COPY --from=builder /app/public ./public

# 创建数据目录
RUN mkdir -p /app/data

# 环境变量
ENV NODE_ENV=production
ENV DB_PATH=/app/data/jimeng.db
# 账号池凭据加密密钥（务必设置并保持稳定，更换后无法解密旧账号）
# ENV JIMENG_ACCOUNT_POOL_KEY=replace-with-a-long-random-secret

# 浏览器传输层：上游风控拦截时改用浏览器页面签名（见 README「上游风控与浏览器传输」）。
# 默认预装 Chromium（约 805MB 镜像层）并配好路径，服务默认即按 auto 模式工作，无需额外配置；
# 不需要该能力时用 --build-arg INSTALL_BROWSER=false 构建精简镜像，并设置 JIMENG_BROWSER_TRANSPORT=off。
# 工作模式也可在控制台「系统设置」页切换，该设置优先于环境变量。
ARG INSTALL_BROWSER=true
RUN if [ "$INSTALL_BROWSER" = "true" ]; then \
        apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont; \
    fi
ENV JIMENG_BROWSER_EXECUTABLE=/usr/bin/chromium-browser
ENV JIMENG_BROWSER_ARGS=--no-sandbox,--disable-dev-shm-usage

# 持久化数据卷
VOLUME ["/app/data"]

EXPOSE 8000

CMD ["npm", "start"]
