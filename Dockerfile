FROM node:lts AS BUILD_IMAGE

WORKDIR /app

COPY package*.json yarn.lock ./

# 只安装生产依赖和开发依赖用于构建
RUN yarn install --registry https://registry.npmmirror.com/ --ignore-engines

COPY . .

RUN yarn run build

# 使用 debian-based 镜像，避免 alpine 的兼容性问题
FROM node:lts-slim

# 安装 better-sqlite3 编译所需的依赖
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 复制构建产物和配置
COPY --from=BUILD_IMAGE /app/configs /app/configs
COPY --from=BUILD_IMAGE /app/package.json /app/package.json
COPY --from=BUILD_IMAGE /app/yarn.lock /app/yarn.lock
COPY --from=BUILD_IMAGE /app/dist /app/dist
COPY --from=BUILD_IMAGE /app/public /app/public

# 在目标架构上重新安装依赖（确保 native 模块正确编译）
RUN yarn install --production --registry https://registry.npmmirror.com/ --ignore-engines

# 创建数据目录
RUN mkdir -p /app/data

# 数据库路径环境变量
ENV DB_PATH=/app/data/jimeng.db

# 持久化数据卷
VOLUME ["/app/data"]

EXPOSE 8000

CMD ["npm", "start"]