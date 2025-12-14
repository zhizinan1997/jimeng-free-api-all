FROM node:lts AS BUILD_IMAGE

WORKDIR /app

COPY . /app

RUN yarn install --registry https://registry.npmmirror.com/ --ignore-engines && yarn run build

FROM node:lts-alpine

# 安装 better-sqlite3 所需的依赖
RUN apk add --no-cache python3 make g++ sqlite

COPY --from=BUILD_IMAGE /app/configs /app/configs
COPY --from=BUILD_IMAGE /app/package.json /app/package.json
COPY --from=BUILD_IMAGE /app/dist /app/dist
COPY --from=BUILD_IMAGE /app/public /app/public
COPY --from=BUILD_IMAGE /app/node_modules /app/node_modules

WORKDIR /app

# 创建数据目录
RUN mkdir -p /app/data

# 数据库路径环境变量
ENV DB_PATH=/app/data/jimeng.db

# 持久化数据卷
VOLUME ["/app/data"]

EXPOSE 8000

CMD ["npm", "start"]