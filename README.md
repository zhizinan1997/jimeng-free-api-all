# Jimeng AI Free 服务

[![](https://img.shields.io/github/license/zhizinan1997/jimeng-free-api-all.svg)](LICENSE)
![](https://img.shields.io/github/stars/zhizinan1997/jimeng-free-api-all.svg)
![](https://img.shields.io/github/forks/zhizinan1997/jimeng-free-api-all.svg)

> **本项目基于 [LLM-Red-Team/jimeng-free-api](https://github.com/LLM-Red-Team/jimeng-free-api) 二次开发，感谢原作者的贡献！**

支持即梦超强图像生成能力，最新图像 4.5/4.1 模型，视频生成模型（目前官方每日赠送 66 积分，可生成 66 次），零配置部署，多路 token 支持。

**新功能**：

- ✅ 图像参考图/混合生成（通过 `filePath` 参数）
- ✅ 视频首尾帧定制（通过 `file_paths` 参数）
- ✅ 支持 OpenAI 多模态消息格式（Chat API 自动提取图片）
- ✅ 即梦官网的最新视频和图像模型
- ✅ **智能比例检测**：提示词中包含比例关键词会自动调整图片尺寸
  - 支持：`21:9`、`16:9`、`3:2`、`4:3`、`1:1`、`3:4`、`2:3`、`9:16`
  - 中文关键词：`横屏`、`竖屏`、`方形` 等

与 OpenAI 接口完全兼容。

## 支持的模型

### 图像生成模型

| 模型名称     | 说明          |
| ------------ | ------------- |
| `jimeng-4.5` | 即梦 4.5 版本 |
| `jimeng-4.1` | 即梦 4.1 版本 |
| `jimeng-4.0` | 即梦 4.0 版本 |
| `jimeng-3.1` | 即梦 3.1 版本 |
| `jimeng-3.0` | 即梦 3.0 版本 |

### 视频生成模型

| 模型名称               | 说明                 |
| ---------------------- | -------------------- |
| `jimeng-video-3.0-pro` | 即梦视频 3.0 Pro     |
| `jimeng-video-3.0`     | 即梦视频 3.0         |
| `jimeng-video-s2.0`    | 即梦视频 S2.0 轻量版 |
| `jimeng-video-2.0-pro` | 即梦视频 2.0 Pro     |

## 免责声明

**逆向 API 是不稳定的，建议前往即梦 AI 官方 https://jimeng.jianying.com/ 体验功能，避免封禁的风险。**

**本组织和个人不接受任何资金捐助和交易，此项目是纯粹研究交流学习性质！**

**仅限自用，禁止对外提供服务或商用，避免对官方造成服务压力，否则风险自担！**

## 接入准备

从 [即梦](https://jimeng.jianying.com/) 获取 sessionid

进入即梦登录账号，然后 F12 打开开发者工具，从 Application > Cookies 中找到`sessionid`的值，这将作为 Authorization 的 Bearer Token 值：`Authorization: Bearer sessionid`

### 多账号接入

你可以通过提供多个账号的 sessionid 并使用`,`拼接提供：

`Authorization: Bearer sessionid1,sessionid2,sessionid3`

每次请求服务会从中挑选一个。

## Docker 部署

使用预构建的 Docker 镜像一键部署：

```bash
docker run -it -d --init --name jimeng-free-api \
  -p 8001:8000 \
  -e TZ=Asia/Shanghai \
  ghcr.io/zhizinan1997/jimeng-free-api-all:latest
```

> **参数说明**：
>
> - `-p 8001:8000`：将宿主机的 8001 端口映射到容器的 8000 端口，可根据需要修改
> - `-e TZ=Asia/Shanghai`：设置时区为上海

## 接口列表

所有接口都需要在 Header 中设置 Authorization：

```
Authorization: Bearer [sessionid]
```

### 对话补全接口（推荐）

**POST /v1/chat/completions**

这是最主要的接口，与 OpenAI Chat Completions API 完全兼容。根据选择的模型自动生成图像或视频。

#### 生成图像

使用图像模型（如 `jimeng-4.5`、`jimeng` 等）：

```json
{
  "model": "jimeng-4.5",
  "messages": [
    {
      "role": "user",
      "content": "一只可爱的柴犬在草地上奔跑"
    }
  ]
}
```

#### 生成视频

使用视频模型（如 `jimeng-video-3.0` 等）：

```json
{
  "model": "jimeng-video-3.0",
  "messages": [
    {
      "role": "user",
      "content": "一只小猫在阳光下打盹"
    }
  ]
}
```

#### 带参考图生成图像（多模态）

在消息中附带图片，第一张图片将作为参考图：

```json
{
  "model": "jimeng-4.5",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "将这张图片转换为水彩画风格" },
        { "type": "image_url", "image_url": { "url": "图片URL或base64" } }
      ]
    }
  ]
}
```

#### 带首尾帧生成视频（多模态）

在消息中附带图片，系统会自动提取作为首尾帧：

```json
{
  "model": "jimeng-video-3.0",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "生成一个从日出到日落的延时摄影" },
        { "type": "image_url", "image_url": { "url": "首帧图片" } },
        { "type": "image_url", "image_url": { "url": "尾帧图片" } }
      ]
    }
  ]
}
```

> **支持的图片格式**：网络 URL、本地文件路径、Base64 编码

### 获取模型列表

**GET /v1/models**

返回所有可用的图像和视频生成模型。
