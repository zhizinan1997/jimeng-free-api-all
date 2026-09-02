# Jimeng AI Free API 使用文档

> 即梦（Jimeng）AI 图像/视频生成服务，OpenAI 兼容，支持多账号轮询与账号池托管。

---

## 目录

- [1. 服务地址](#1-服务地址)
- [2. 鉴权方式](#2-鉴权方式)
- [3. 快速开始](#3-快速开始)
- [4. 接口总览](#4-接口总览)
- [5. 接口详解](#5-接口详解)
  - [5.1 健康检查 `GET /ping`](#51-健康检查-get-ping)
  - [5.2 图像生成 `POST /v1/images/generations`](#52-图像生成-post-v1imagesgenerations)
  - [5.3 视频生成 `POST /v1/videos/generations`](#53-视频生成-post-v1videosgenerations)
  - [5.4 对话补全 `POST /v1/chat/completions`](#54-对话补全-post-v1chatcompletions)
  - [5.5 模型列表 `GET /v1/models`](#55-模型列表-get-v1models)
  - [5.6 账号状态 `GET /v1/account/status`](#56-账号状态-get-v1accountstatus)
  - [5.7 Token 校验 `POST /token/check`](#57-token-校验-post-tokencheck)
  - [5.8 积分查询 `POST /token/points`](#58-积分查询-post-tokenpoints)
- [6. 模型列表](#6-模型列表)
- [7. 积分消耗说明](#7-积分消耗说明)
- [8. 错误码](#8-错误码)
- [9. 调用示例](#9-调用示例)

---

## 1. 服务地址

默认端口由 `configs/dev/service.yml` 控制（默认 `8000`），部署后可访问：

| 内容 | 地址 |
|---|---|
| API 服务 | `http://localhost:8000` |
| 管理控制台 | `http://localhost:8000/dashboard` |

---

## 2. 鉴权方式

所有业务接口均通过请求头 `Authorization` 鉴权，使用 Bearer 格式：

```http
Authorization: Bearer <凭证>
```

支持两种凭证：

### 2.1 直接使用即梦 Session ID（免配置，向后兼容）

1. 登录 [即梦官网](https://jimeng.jianying.com/)；
2. 按 `F12` 打开开发者工具 → `Application` → `Cookies`；
3. 复制 `sessionid` 的值，作为 Bearer Token。

多个账号用**英文逗号分隔**，服务自动随机轮询：

```http
Authorization: Bearer sessionid_1,sessionid_2,sessionid_3
```

### 2.2 使用账号池 API Key（推荐，`jm_` 前缀）

管理控制台创建 `jm_...` 格式的调用 Key，Key 与账号池账号绑定。调用时服务自动选择一个启用的账号：

```http
Authorization: Bearer jm_HmvKHn58jRdsq2Po-weIRZeZPnTfIFL_nU9DUWN-XPc
```

> 注意：`jm_...` Key 必须先在管理端创建并关联账号，未注册的 Key 会返回 `API key is invalid or disabled`。

### 2.3 环境变量

账号池凭据使用 AES-256-GCM 加密存储，启动服务前必须配置密钥，且保持稳定（更换后无法解密旧账号）：

```
JIMENG_ACCOUNT_POOL_KEY=你的密钥
# 或
ACCOUNT_POOL_ENCRYPTION_KEY=你的密钥
```

---

## 3. 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 构建
npm run build

# 3. 启动（先设置账号池密钥）
$env:JIMENG_ACCOUNT_POOL_KEY="my-secret-key"
npm start

# 4. 验证
curl http://localhost:8000/ping
# => "pong"
```

---

## 4. 接口总览

| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| GET | `/ping` | 健康检查 | 无 |
| POST | `/v1/images/generations` | 图像生成（支持参考图） | 必填 |
| POST | `/v1/videos/generations` | 视频生成（支持首尾帧） | 必填 |
| POST | `/v1/chat/completions` | OpenAI 兼容对话补全 | 必填 |
| GET | `/v1/models` | 模型列表 | 可选（有则实时拉取官网） |
| GET | `/v1/account/status` | 账号积分/会员状态 | 必填 |
| POST | `/token/check` | 校验 token 是否有效 | 无 |
| POST | `/token/points` | 查询 token 积分 | 必填 |
| GET | `/account-pool/*` | 账号池管理（管理端） | 登录 |
| GET | `/dashboard` | 管理控制台 | 登录 |

---

## 5. 接口详解

### 5.1 健康检查 `GET /ping`

```bash
curl http://localhost:8000/ping
```

**响应**：`"pong"`

---

### 5.2 图像生成 `POST /v1/images/generations`

OpenAI Images API 兼容。支持文本生图与参考图（图生图）两种模式。

#### 请求体（JSON）

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `model` | string | 否 | `jimeng-image-5.0-lite` | 图像模型 ID，见[模型列表](#6-模型列表) |
| `prompt` | string | 是 | - | 提示词 |
| `negative_prompt` | string | 否 | 空 | 反向提示词（仅无参考图时生效） |
| `ratio` | string | 否 | `1:1` | 比例：`21:9` `16:9` `3:2` `4:3` `1:1` `3:4` `2:3` `9:16` |
| `resolution` | string | 否 | 模型默认 | `4k` `2k` `1.5k` `1k`（按模型支持档位自动降级） |
| `sample_strength` | number | 否 | `0.5` | 生成精细度（0~1） |
| `n` | number | 否 | `1` | 生成张数（1~8），透传即梦 `gen_option.gen_count` |
| `response_format` | string | 否 | `url` | `url` 或 `b64_json` |
| `filePath` | string | 否 | 空 | 参考图：本地路径、http(s) URL 或 `data:image/...;base64,...` |

也支持 `multipart/form-data` 上传参考图：文件字段名任意，服务取第一个文件。

#### 请求示例

```bash
curl -X POST http://localhost:8000/v1/images/generations \
  -H "Authorization: Bearer jm_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "jimeng-image-5.0-lite",
    "prompt": "一只在太空飞行的柴犬，赛博朋克风格",
    "ratio": "1:1",
    "resolution": "2k"
  }'
```

参考图模式（本地文件）：

```json
{
  "model": "jimeng-image-4.7",
  "prompt": "把参考图变成梵高风格",
  "filePath": "D:\\images\\input.png"
}
```

#### 响应

```json
{
  "created": 1787794197,
  "data": [
    { "url": "https://p26-dreamina-sign.byteimg.com/..." },
    { "url": "https://p11-dreamina-sign.byteimg.com/..." }
  ]
}
```

`response_format=b64_json` 时 `data[]` 返回 `{ "b64_json": "..." }`。生成张数由 `n` 控制（1~8，默认 1 张；即梦按张数消耗积分）。

---

### 5.3 视频生成 `POST /v1/videos/generations`

#### 请求体（JSON）

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `model` | string | 否 | `jimeng-video-seedance-2.0-mini` | 视频模型 ID |
| `prompt` | string | 是 | - | 提示词 |
| `ratio` | string | 否 | 模型默认 | `16:9` `9:16` `1:1` `4:3` `3:4` `21:9` |
| `resolution` | string | 否 | `720p` | `720p` `1080p` `4k`（按模型支持） |
| `duration` | number | 否 | `10` | 时长秒数：`5` 或 `10` |
| `file_paths` | string[] | 否 | `[]` | 首尾帧参考图：本地路径 / URL / base64 |
| `response_format` | string | 否 | `url` | `url` 或 `b64_json` |

同样支持 `multipart/form-data` 上传首尾帧图片。

#### 请求示例

```bash
curl -X POST http://localhost:8000/v1/videos/generations \
  -H "Authorization: Bearer jm_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "jimeng-video-seedance-2.0-pro",
    "prompt": "女孩在沙滩奔跑，夕阳逆光",
    "duration": 10
  }'
```

#### 响应

```json
{
  "created": 1787794197,
  "data": [
    {
      "url": "https://v3-web.douyinvod.com/...",
      "revised_prompt": "女孩在沙滩奔跑，夕阳逆光"
    }
  ]
}
```

---

### 5.4 对话补全 `POST /v1/chat/completions`

OpenAI Chat Completions 兼容。根据模型自动路由到图像或视频生成，支持多模态（带图）。

#### 请求体

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | string | 否 | 图像模型（默认 `jimeng-image-5.0-lite`）或 `jimeng-video-*` 模型 |
| `messages` | array | 是 | OpenAI 消息格式，最后一条的文本作为 prompt |
| `stream` | bool | 否 | 是否流式返回（SSE） |

模型名可附加尺寸：`jimeng-image-4.5:1024x1024`。

#### 图像示例

```json
{
  "model": "jimeng-image-5.0-lite",
  "messages": [
    { "role": "user", "content": "一只在太空中飞行的柴犬，赛博朋克风格" }
  ]
}
```

#### 多模态示例（带参考图）

```json
{
  "model": "jimeng-image-5.0-lite",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "把这张图变成梵高风格" },
        { "type": "image_url", "image_url": { "url": "https://example.com/img.jpg" } }
      ]
    }
  ]
}
```

#### 视频示例

```json
{
  "model": "jimeng-video-seedance-2.0-pro",
  "messages": [
    { "role": "user", "content": "一只奔跑的柴犬，5秒" }
  ]
}
```

#### 响应

```json
{
  "id": "a1b2c3",
  "object": "chat.completion",
  "created": 1787794197,
  "model": "jimeng-image-5.0-lite",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "![image_0](https://p26-dreamina-sign.byteimg.com/...)\n"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2 }
}
```

---

### 5.5 模型列表 `GET /v1/models`

不带鉴权时返回内置兜底模型；带 `Authorization` 时实时拉取即梦官网模型配置并缓存。

| 查询参数 | 说明 |
|---|---|
| `refresh=true` | 强制刷新官网模型缓存 |
| `type=image` / `type=video` | 按类型过滤 |

```bash
curl "http://localhost:8000/v1/models?type=image" \
  -H "Authorization: Bearer jm_xxx"
```

**响应**：`{ "data": [ { "id": "...", "object": "model", ... } ] }`

---

### 5.6 账号状态 `GET /v1/account/status`

查询当前凭证对应的账号积分与会员状态（不暴露 Cookie/凭据）。

```bash
curl http://localhost:8000/v1/account/status \
  -H "Authorization: Bearer jm_xxx"
```

**响应**：

```json
{
  "account": {
    "id": "85a961e9-...",
    "name": "gxs",
    "enabled": true,
    "status": {
      "giftCredit": 20,
      "purchaseCredit": 0,
      "vipCredit": 0,
      "totalCredit": 20,
      "membership": { "isVip": null, "vipExpireAt": null, "membershipType": null }
    }
  }
}
```

使用 sessionid 直接调用时返回 `{ "account": { "status": { ...积分, "membership": "unknown" } } }`。

---

### 5.7 Token 校验 `POST /token/check`

校验 sessionid 是否有效（`jm_` Key 不适用）。

```bash
curl -X POST http://localhost:8000/token/check \
  -H "Content-Type: application/json" \
  -d '{"token": "d13ac892188308a7a8c0cb518f8b9a63"}'
```

**响应**：`{ "live": true }`

---

### 5.8 积分查询 `POST /token/points`

查询一个或多个 sessionid 的积分（逗号分隔）。`jm_` Key 不适用。

```bash
curl -X POST http://localhost:8000/token/points \
  -H "Authorization: Bearer sessionid_1,sessionid_2"
```

**响应**：

```json
[
  {
    "token": "sessionid_1",
    "points": { "giftCredit": 20, "purchaseCredit": 0, "vipCredit": 0, "totalCredit": 20 }
  }
]
```

---

## 6. 模型列表

### 图像模型

| 模型 ID | 说明 | 分辨率 |
|---|---|---|
| `jimeng-image-5.0-pro` | Seedream 5.0 Pro（最新） | 4K / 2K / 1.5K |
| `jimeng-image-5.0-lite` | Seedream 5.0 Lite（默认） | 4K / 2K |
| `jimeng-image-4.7` | Seedream 4.7 | 4K / 2K |
| `jimeng-image-4.6` | Seedream 4.6 | 4K / 2K |
| `jimeng-image-4.5` | Seedream 4.5 | 4K / 2K |
| `jimeng-image-4.1` | Seedream 4.1 | 4K / 2K |
| `jimeng-image-4.0` | Seedream 4.0 | 4K / 2K |
| `jimeng-image-3.1` | Seedream 3.1 | 1K |
| `jimeng-image-3.0` | Seedream 3.0 | 1K |
| `jimeng-image-2.0-pro` | Seedream 2.0 Pro | 仅 1K |

### 视频模型

| 模型 ID | 说明 | 分辨率 | 时长 |
|---|---|---|---|
| `jimeng-video-seedance-2.5` | Seedance 2.5 | 720p | 5s / 10s |
| `jimeng-video-seedance-2.0-pro` | Seedance 2.0 Pro | 720p / 1080p / 4K | 5s / 10s |
| `jimeng-video-seedance-2.0-fast` | Seedance 2.0 Fast | 720p | 5s / 10s |
| `jimeng-video-seedance-2.0-mini` | Seedance 2.0 Mini（默认） | 720p | 5s / 10s |
| `jimeng-video-seedance-1.5-pro` | Seedance 1.5 Pro | 720p | 5s / 10s |
| `jimeng-video-3.0-pro` | 3.0 Pro | 720p | 5s / 10s |
| `jimeng-video-3.0` | 3.0 标准 | 720p | 5s / 10s |
| `jimeng-video-3.0-fast` | 3.0 快速 | 720p | 5s / 10s |
| `jimeng-video-s2.0` | S2.0 轻量 | 720p | 5s |
| `jimeng-video-2.0-pro` | 2.0 Pro | 720p | 5s |

> 提示词含 `5秒` / `10秒` 关键词可自动控制视频时长；含 `横屏` / `竖屏` / `方形` 或比例数字可自动识别尺寸。

---

## 7. 积分消耗说明

每次图像调用返回 **4 张图**，按模型与分辨率消耗积分（实际以即梦账户余额为准）：

| 模型 | 分辨率 | 单张积分 |
|---|---|---|
| `jimeng-image-3.1` / `3.0` | 1K | 1 |
| `jimeng-image-5.0-lite` | 2K | 3 |
| `jimeng-image-4.7` / `4.6` / `4.5` / `4.1` / `4.0` | 2K | 4 |
| `jimeng-image-5.0-pro` | 2K | 8 |

- 积分不足时服务会自动从高分辨率向低分辨率**逐级降级重试**；
- 余额为 0 时自动尝试领取当日赠送积分（`credit_receive`）；
- 若最低档仍不足，返回错误码 `-2009`。

---

## 8. 错误码

| 错误码 | 说明 |
|---|---|
| `-2000` | 请求参数非法 |
| `-2001` | 请求失败（登录失效/网关错误等） |
| `-2002` | Token 已失效 |
| `-2003` | 远程文件 URL 非法 |
| `-2004` | 远程文件超出大小限制 |
| `-2005` | 已有对话流正在输出 |
| `-2006` | 内容因合规问题被阻止生成 |
| `-2007` | 图像生成失败 |
| `-2008` | 视频生成失败 |
| `-2009` | 即梦积分不足 |
| `-9999` | 未知异常 |

错误响应格式：`{ "code": -2009, "message": "...", "data": null }`

---

## 9. 调用示例

### Node.js

```js
const res = await fetch("http://localhost:8000/v1/images/generations", {
  method: "POST",
  headers: {
    "Authorization": "Bearer jm_xxx",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "jimeng-image-5.0-lite",
    prompt: "一只在太空飞行的柴犬，赛博朋克风格",
  }),
});
const { data } = await res.json();
console.log(data.map((d) => d.url));
```

### Python

```python
import requests

resp = requests.post(
    "http://localhost:8000/v1/images/generations",
    headers={"Authorization": "Bearer jm_xxx", "Content-Type": "application/json"},
    json={
        "model": "jimeng-image-5.0-lite",
        "prompt": "一只在太空飞行的柴犬，赛博朋克风格",
    },
)
for item in resp.json()["data"]:
    print(item["url"])
```

### OpenAI SDK（`/v1/chat/completions` 兼容）

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8000/v1", api_key="jm_xxx")
resp = client.chat.completions.create(
    model="jimeng-image-5.0-lite",
    messages=[{"role": "user", "content": "一只在太空飞行的柴犬"}],
)
print(resp.choices[0].message.content)
```

---

## 注意事项

1. 服务基于即梦逆向接口，不保证永久可用，建议保留即梦官方渠道；
2. 生成图片/视频会自动记录到管理端媒体库，可在 `/dashboard` 查看历史与统计；
3. 参考图本地路径是**服务端文件系统路径**，远程调用请使用 URL 或 base64/multipart 上传；
4. 账号池密钥 `JIMENG_ACCOUNT_POOL_KEY` 更换后无法解密旧账号凭据，请妥善保存。
