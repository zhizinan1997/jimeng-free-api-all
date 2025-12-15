FROM node:lts-alpine AS BUILD_IMAGE

# 安装编译 better-sqlite3 所需的工具
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json yarn.lock ./

# 安装依赖用于构建
RUN yarn install --registry https://registry.npmmirror.com/ --ignore-engines

COPY . .

RUN yarn run build

# 最终镜像使用 alpine
FROM node:lts-alpine

WORKDIR /app

# 复制构建产物和配置
COPY --from=BUILD_IMAGE /app/configs /app/configs
COPY --from=BUILD_IMAGE /app/package.json /app/package.json
COPY --from=BUILD_IMAGE /app/yarn.lock /app/yarn.lock
COPY --from=BUILD_IMAGE /app/dist /app/dist
COPY --from=BUILD_IMAGE /app/public /app/public

# 安装编译工具、编译 better-sqlite3、然后删除编译工具（一个 RUN 命令减少层数）
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && yarn install --production --registry https://registry.npmmirror.com/ --ignore-engines \
    && apk del .build-deps \
    && rm -rf /var/cache/apk/* \
    && rm -rf /root/.npm /root/.node-gyp /tmp/*

# 创建数据目录
RUN mkdir -p /app/data

# 数据库路径环境变量
ENV DB_PATH=/app/data/jimeng.db

# 持久化数据卷
VOLUME ["/app/data"]

EXPOSE 8000

CMD ["npm", "start"]