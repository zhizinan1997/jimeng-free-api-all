# Jimeng AI Free API 使用文档

> 即梦（Jimeng）AI 图像/视频生成与 Doubao、GLM、Deepseek、Qwen 文字对话服务，支持 OpenAI 格式响应、多账号轮询与账号池托管。

---

## 音频任务查询的账号绑定

音频任务创建后，任务 ID 与提交 ID 的调用方身份和原账号编号保存在
`DB_PATH` 指定的 SQLite 数据库中，有效期为 24 小时。部署时必须持久化该数据库。
新增绑定表只保存凭据哈希，不保存明文 API Key、sessionid 或 Cookie；账号 Cookie
继续由原账号池加密保存，需保持现有账号池加密密钥稳定。

`GET /v1/audios/generations/:taskId` 和 `GET /v1/audio/tasks/:taskId`
均要求创建任务时的调用凭据。托管 API Key 每次查询都会重新校验有效性；停用或删除的
Key 不可查询。重启后仍使用创建任务的原账号，不参与轮询选择；原账号停用、删除、
凭据变更，或任务绑定缺失/过期时明确失败，不切换其他账号。升级前仅保存在内存中的
旧音频任务无法自动恢复绑定，请在切换版本前等待其结束。

此变更为新增表，不改动原账号池和历史任务数据；回滚旧版本不会删除新增绑定记录。

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
Authorization: Bearer <YOUR_API_KEY>
```

> 注意：`jm_...` Key 必须先在管理端创建并关联账号，未注册的 Key 会返回 `API key is invalid or disabled`。

### 2.3 环境变量

账号池凭据使用 AES-256-GCM 加密存储，启动服务前必须配置密钥，且保持稳定（更换后无法解密旧账号）：

```
JIMENG_ACCOUNT_POOL_KEY=你的密钥
# 或
ACCOUNT_POOL_ENCRYPTION_KEY=你的密钥
```

便携版请将其中一个密钥直接写入 `portable/config/portable.env`，例如
`JIMENG_ACCOUNT_POOL_KEY=long-random-secret`。密钥可以是任意非空字符串，但必须在重启间保持不变。

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
| POST | `/v1/chat/completions` | 六种纯文字模型或图像/视频生成，支持 JSON 与 SSE | 必填 |
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
| `filePath` | string / string[] | 否 | 空 | 参考图：本地路径、http(s) URL 或 `data:image/...;base64,...` |
| `filePaths` | string[] | 否 | 空 | `filePath` 的数组别名，可与 `filePath` 合用 |

也支持 `multipart/form-data` 上传参考图：文件字段名任意，服务会按上传顺序读取所有文件。所有来源合计最多 10 张参考图。

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
  "filePaths": [
    "D:\\images\\subject.png",
    "D:\\images\\style.png"
  ]
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
| `model` | string | 否 | `jimeng-video-seedance-2.0` | 视频模型 ID |
| `prompt` | string | 是 | - | 提示词 |
| `ratio` | string | 否 | 模型默认 | `16:9` `9:16` `1:1` `4:3` `3:4` `21:9` |
| `resolution` | string | 否 | `720p` | `720p` `1080p` `4k`（按模型支持） |
| `duration` | integer | 否 | 模型默认 | 时长秒数；Seedance 2.0 系列默认 5 秒，支持 4~15 秒；其他模型通常支持 5 或 10 秒 |
| `file_paths` | string[] | 否 | `[]` | 首尾帧参考图：本地路径 / URL / base64 |
| `response_format` | string | 否 | `url` | `url` 或 `b64_json` |

同样支持 `multipart/form-data` 上传首尾帧图片。

#### 请求示例

```bash
curl -X POST http://localhost:8000/v1/videos/generations \
  -H "Authorization: Bearer jm_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "jimeng-video-seedance-2.0",
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

按模型分别路由到纯文字对话、图像或视频生成。已核实的六种文字模型使用独立文字链路；媒体模型继续支持原有带图消息格式。

#### 请求体

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | string | 文字必填 | 文字使用下表六种模型之一；媒体使用图像模型或 `jimeng-video-*`，省略时仍默认图像模型 |
| `messages` | array | 是 | 文字支持单条 `user` 或完整 `user/assistant` 纯文字历史；媒体链路取最后一条文本作为提示词 |
| `stream` | boolean | 否 | `true` 返回 SSE；文字模型默认 `false`，字符串 `"true"` 等非布尔值会被拒绝 |

模型名可附加尺寸：`jimeng-image-4.5:1024x1024`。


#### Doubao / GLM / Deepseek / Qwen 纯文字对话

支持的六种模型及真实上游标识见[文字模型表](#文字模型)。`model` 接受表中的规范模型 ID、官网显示名或上游标识，响应统一返回对应的规范 ID。GLM 5.3 Flash 的原有三个名称继续兼容。

Doubao 2.1 Lite 的真实上游标识是 `default_matrix`，Doubao 2.1 Pro 是 `doubao_v21_turbo_pro`，Deepseek V4 Pro 是 `ali_deepseek_v4_pro`，不要按显示名自行拼接上游标识。未登记的文字模型和这些标识的未知变体返回 400，不会回退到图片生成。

#### 请求格式与限制

- 请求体接受 `model`、`messages`、`stream`，并兼容客户端可能附带的 `max_tokens`、`stream_options`、`thinking`，其处理方式见下表。
- `messages` 包含 1～128 条 `user/assistant` 消息，以 `user` 开始、以本轮 `user` 结束；总文字长度不超过 256000 个 UTF-16 代码单元，超过上限明确拒绝，不静默裁剪历史。
- 每条 `content` 为非空字符串，或仅包含 `{ "type": "text", "text": "..." }` 的数组；多个文字片段以换行连接。
- 单条和多轮请求都会附带所选模型的用途说明和纯文字能力约束，再将原始文字消息完整编码为带角色和时间顺序的 JSON 上下文，提交至上游新会话。多轮响应头 `X-Jimeng-Context-Mode: role-labelled-history` 表明这种上下文适配；它不表示复用了官网会话或提供原生消息角色权限。
- `system` / `developer` / 工具消息、图片、音视频、附件，以及 `tools`、`temperature`、`response_format` 等未实现能力仍返回 400。
- 每次调用在所选账号下创建新工作区；对应对话可能出现在官网会话列表中。
- 请求约束与模型描述共用定位：GLM 5.3 为“指令遵循出色、擅长写作内容”，Deepseek V4 Pro 为“适合文本创作与通用任务”，Qwen 3.8 Max 为“剧本创作”，GLM Flash 为“擅长素材提取和分镜设计”，两个 Doubao 为通用文字助手。
- 当前入口只输出文字；分镜设计指文字分镜表。提示词要求模型不承诺媒体生成、不声称已调用工具，不根据上游账号推断调用方的会员状态或客户端的默认图片模型。旧助手回答中的相关错误自述不视为当前能力事实。
- 这些是应用侧提示词约束，不是原生 system 消息，不会移除上游服务端规则、清空账号记忆或保证每次回答都遵循。正常文字创作任务不要求反复声明身份；服务来源应如实说明。

| 兼容字段 | 接受的形态 | 实际行为 |
|---|---|---|
| `max_tokens` | 正安全整数，例如 `16384` | 接受客户端默认值，但上游没有已验证的长度控制参数，不保证此上限生效；响应头明确列为忽略项 |
| `thinking` | `{ "type": "enabled" }` 或 `{ "type": "disabled" }` | 上游使用自身推理策略，不保证按此开关切换；响应头明确列为忽略项，输出仍仅含可见正文 |
| `stream_options` | 仅允许布尔 `include_usage` 字段 | `include_usage: true` 可被接受，但无可靠 Token 统计，仍不返回编造的 `usage`；响应头明确列为忽略项 |

例如，同时传入有效的 `max_tokens`、`thinking` 以及 `stream_options.include_usage: true` 时返回 `X-Jimeng-Ignored-Parameters: max_tokens, thinking, stream_options.include_usage`。这表示请求兼容，并非这些控制项已被上游执行。

**运行条件**：服务端需要 `playwright-core` 和可用的 Chrome / Chromium / Edge。文字链路使用独立浏览器上下文完成签名、订阅与提交；浏览器传输模式须为 `auto` 或 `always`，控制台设置优先于环境变量。设为 `off` 时文字链路不可用。

| 环境变量 | 说明 |
|---|---|
| `JIMENG_BROWSER_EXECUTABLE` | 指定浏览器可执行文件；未指定时默认使用 `chrome` 通道 |
| `JIMENG_BROWSER_CHANNEL` | 选择已安装的浏览器通道，例如 `chrome`、`msedge` |
| `JIMENG_BROWSER_HEADLESS` | 默认 `true`。在图形环境中可设为 `false` 以显示浏览器 |
| `JIMENG_BROWSER_ARGS` | 浏览器启动参数，以逗号分隔；系统代理失效且网络允许直连时，可设置为 `--no-proxy-server` |
| `JIMENG_AGENT_TIMEOUT_MS` | 单次文字调用总超时，包含浏览器初始化，默认 `120000`；有效范围为 1～600000 毫秒 |

请求使用 Bearer 鉴权。使用托管调用 Key（`jm_` 前缀）时，服务从账号池选择上游账号。以下示例调用 GLM Flash，可将 `model` 改为其他已登记的模型 ID。

**普通 JSON 调用**（先将调用 Key 放入 `JIMENG_API_KEY` 环境变量）：

```bash
curl -sS http://localhost:8000/v1/chat/completions \
  -H "Authorization: Bearer ${JIMENG_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-5.3-flash",
    "messages": [{"role": "user", "content": "请只回复接口验证成功，不使用工具。"}],
    "stream": false
  }'
```

成功响应的正文结构如下，示例省略请求标识和创建时间。上游未提供可核实的 Token 统计，因此文字链路不编造 `usage`：

```json
{
  "object": "chat.completion",
  "model": "glm-5.3-flash",
  "choices": [{
    "index": 0,
    "message": {"role": "assistant", "content": "接口验证成功"},
    "finish_reason": "stop"
  }]
}
```

**SSE 流式调用**：

```bash
curl -N http://localhost:8000/v1/chat/completions \
  -H "Authorization: Bearer ${JIMENG_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-5.3-flash",
    "messages": [{"role": "user", "content": "请只回复接口验证成功，不使用工具。"}],
    "stream": true
  }'
```

流中先返回助手角色，再通过 `choices[0].delta.content` 输出文字。只有订阅收到对应对话的完整结束事件、提交回执也确认成功后，才输出 `finish_reason: "stop"` 和 `data: [DONE]`。

如果中途失败，流返回 `data: {"error": {...}}` 后关闭，不输出成功的 `stop`。客户端应同时检查错误对象和结束原因，不能仅凭 HTTP 200 或 `[DONE]` 判定成功。超时及客户端断开会取消本地双通道连接，服务不会自动重新提交生成；取消连接不等同于保证上游已提交任务被撤销。

纯文字响应仅提取可见助手正文，不包含推理或工具内容。官网配置将 Deepseek V4 Pro 标为“中等消耗”，其余五个标为“普通消耗”；这不是固定价格或免费保证，实际计费以账号和上游规则为准。

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
  "model": "jimeng-video-seedance-2.0",
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

不带鉴权时返回内置模型；带 `Authorization` 时可实时拉取媒体模型配置并缓存。`type=text` 始终返回已逐一核实的六种内置文字模型，不自动启用未验证的新增模型。

| 查询参数 | 说明 |
|---|---|
| `refresh=true` | 强制刷新官网模型缓存 |
| `type=text` / `type=image` / `type=video` / `type=audio` | 按类型过滤；`type=text` 返回下表六种已验证文字模型 |

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
  -d '{"token": "<YOUR_SESSION_TOKEN>"}'
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


### 文字模型

文字模型按以下优先顺序返回：GLM 5.3、Deepseek V4 Pro、Qwen 3.8 Max、Doubao 2.1 Lite、Doubao 2.1 Pro、GLM 5.3 Flash。

| 模型 ID | 显示名 | 上游标识 |
|---|---|---|
| `glm-5.3` | GLM 5.3 | `glm_5_3` |
| `deepseek-v4-pro` | Deepseek V4 Pro | `ali_deepseek_v4_pro` |
| `qwen-3.8-max` | Qwen 3.8 Max | `qwen_3_8_max` |
| `doubao-2.1-lite` | Doubao 2.1 Lite | `default_matrix` |
| `doubao-2.1-pro` | Doubao 2.1 Pro | `doubao_v21_turbo_pro` |
| `glm-5.3-flash` | GLM 5.3 Flash | `glm_5_3_flash` |

六个模型共用 `/v1/chat/completions` 的文字请求格式，支持普通 JSON 和 SSE 流式响应。继续对话时，请在 `messages` 中提供所需历史。

模型列表的 `description` 字段采用以下用途说明：

| 模型 | 用途说明 |
|---|---|
| GLM 5.3 | 指令遵循出色、擅长写作内容 |
| GLM 5.3 Flash | 擅长素材提取和分镜设计 |
| Deepseek V4 Pro | 适合文本创作与通用任务 |
| Qwen 3.8 Max | 剧本创作 |

```bash
curl -sS "http://localhost:8000/v1/models?type=text"
```

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
| `jimeng-video-seedance-2.0` | Seedance 2.0（默认） | 720p | 4s ~ 15s（默认 5s） |
| `jimeng-video-seedance-2.0-pro` | `jimeng-video-seedance-2.0` 的兼容别名 | 720p | 4s ~ 15s（默认 5s） |
| `jimeng-video-seedance-2.0-fast` | Seedance 2.0 Fast | 720p | 4s ~ 15s（默认 5s） |
| `jimeng-video-seedance-2.0-mini` | Seedance 2.0 Mini | 720p | 4s ~ 15s（默认 5s） |
| `jimeng-video-seedance-2.0-fast-vip` | Seedance 2.0 Fast VIP Vision（会员通道） | 720p | 4s ~ 15s（默认 5s） |
| `jimeng-video-seedance-2.0-vip` | Seedance 2.0 VIP Vision（会员通道） | 720p / 1080p / 4K | 4s ~ 15s（默认 5s） |
| `jimeng-video-seedance-1.5-pro` | Seedance 1.5 Pro | 720p | 5s / 10s |
| `jimeng-video-3.0-pro` | 3.0 Pro | 720p | 5s / 10s |
| `jimeng-video-3.0` | 3.0 标准 | 720p | 5s / 10s |
| `jimeng-video-3.0-fast` | 3.0 快速 | 720p | 5s / 10s |
| `jimeng-video-s2.0` | S2.0 轻量 | 720p | 5s |
| `jimeng-video-2.0-pro` | 2.0 Pro | 720p | 5s |

> 未传 `duration` 时，提示词中的 `5秒` / `10秒` 关键词会控制支持该时长的模型；Seedance 2.0 可直接传 4~15 的整数秒。提示词含 `横屏` / `竖屏` / `方形` 或比例数字可自动识别尺寸。

---

## 7. 积分消耗说明

每次图像调用返回的图片数量由 `n` 控制（默认 1 张，最多 8 张），按模型、分辨率和张数消耗积分（实际以即梦账户余额为准）：

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


六种文字模型使用相同的 OpenAI 风格错误对象：`{ "error": { "message": "...", "type": "jimeng_text_chat_error", "code": "..." } }`。参数错误为 HTTP 400，缺少或不可用凭据为 401，上游失败通常为 502，浏览器启动不可用为 503，总超时为 504。已经开始输出的 SSE 通过流内 `error` 对象报告错误；HTTP 状态不会在响应开始后改写。

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


### 文字对话（OpenAI Python SDK，六模型通用）

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8000/v1",
    api_key=os.environ["JIMENG_API_KEY"],
    max_retries=0,
    timeout=150.0,
)
response = client.chat.completions.create(
    model="glm-5.3-flash",
    messages=[{"role": "user", "content": "请用文字解释什么是反向代理。"}],
    stream=False,
)
print(response.choices[0].message.content)
```

SDK 示例关闭客户端自动重试，避免上游已接收任务但本地连接中断时再次提交。若切换为 `stream=True`，应处理流内错误并确认最终 `finish_reason` 为 `stop`。

---

## 注意事项

1. 服务基于即梦逆向接口，不保证永久可用，建议保留即梦官方渠道；
2. 生成图片/视频会自动记录到管理端媒体库，可在 `/dashboard` 查看历史与统计；
3. 参考图本地路径是**服务端文件系统路径**，远程调用请使用 URL 或 base64/multipart 上传；
4. 账号池密钥 `JIMENG_ACCOUNT_POOL_KEY` 更换后无法解密旧账号凭据，请妥善保存。

## 账号池优先调度与任务追踪

管理员可调整接单门槛和账号顺序，并通过任务记录查看实际使用的账号。

管理端沿用管理员 session 登录。`GET /account-pool/dashboard` 返回设置、账号资格、下一任务预计账号、最近任务与事件；此预览不分配任务。
`PATCH /account-pool/settings` 接受 `mode`（`auto` 或 `fixed`）、`fixedAccountId`、`threshold`、`balanceMaxAgeSeconds` 与当前 `revision`。
`PATCH /account-pool/order` 接受包含全部账号且无重复的 `accountIds` 和当前 `revision`。并发配置冲突返回 HTTP 409，刷新后再修改。
`GET /account-pool/tasks` 与 `GET /account-pool/events` 支持 `limit` / `offset`。管理响应不包含原始凭据或完整生成结果。

管理 Key 的新生成请求按优先级选取账号；默认准入门槛为 200 积分，默认余额有效期为 60 秒。这是本服务调度策略，不是上游计费标准。
费用未知的真实生成按账号独占，完成后校准余额；固定账号不可用时明确拒绝，不换号。原生上游 session/Cookie 直传继续兼容，不参与号池排序。

调用方可为一次生成提供 `Idempotency-Key` 请求头（或 `X-Request-Id`）。同一管理 Key 重试同一操作应复用该标识和完全相同的请求内容；内容不同返回冲突。
重复请求不会重新生成，而会返回原 `pool_task_id`、状态及 `reused: true`。没有幂等标识且首次响应丢失的全新请求，服务无法证明它是重试，不能保证自动去重。
JSON 响应提供 `pool_task_id` / `request_id`，流式响应通过 `X-Pool-Task-Id` / `X-Request-Id` 返回；结算未完成可能附带 `settlement_pending` 或 `X-Pool-Settlement-Pending`。

使用原管理 Key 和本地 `pool_task_id` 查询：

- `GET /v1/images/tasks/:taskId`
- `GET /v1/videos/tasks/:taskId`
- `GET /v1/audios/tasks/:taskId`
- `GET /v1/chat/tasks/:taskId`

图片任务会保存本次请求的张数（图片生成未传 `n` 时为 1）。即时返回、按任务 ID 查询、幂等重放均按此上限返回有效图片，顺序一致。旧版未记录张数的任务保留原结果；原调用方用同一个幂等键重放完全相同的请求后，系统补记张数，后续查询也使用该上限。

查询沿用原账号，不重新生成。已知媒体 history ID 使用原历史接口恢复。提交后尚无上游 ID 时，前 120 秒等待回执，之后由下一次维护扫描标为待确认，保留原账号绑定。迟到的原回执仍可接续任务。

文字任务收到并验证完整答案后，先保存结果，再清理浏览器连接。只有会话 ID、尚未保存答案的任务，查询会返回 `recoverable: false` 和 `recovery_code: text_answer_not_saved`，目前无法从即梦历史自动取回答案。
已完成且已保存的结果由所属调用方查询读取。终态但余额校准失败时保留结算占位，不代表生成需要重做。
长视频响应保留 JSON 空白心跳，最终仍是一个 JSON 文档；HTTP 200 或收到心跳不代表生成完成，必须解析最终文档中的成功或错误状态。

独立音频上传 `POST /v1/audios/uploads` 使用相同 Authorization，接收 JSON `source`（音频 data URI 或 HTTPS URL）或一个 multipart 文件，返回 `data.vid`、`data.duration_ms` 与任务标识。
后续生成使用该 vid 时验证调用方及原账号归属；多个不同账号的素材不可混用。没有上传归属证明的裸 vid 不会被当作已授权素材。
