import { currentPoolTask, failPoolTask } from "../../lib/pool-task-context.ts";
import _ from "lodash";
import { PassThrough } from "stream";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";
import db from "@/lib/database.ts";
import { generateImagesWithRetry, DEFAULT_MODEL } from "./images.ts";
import { generateVideo, DEFAULT_MODEL as DEFAULT_VIDEO_MODEL } from "./videos.ts";
import { getCredit } from "./core.ts";


/**
 * 解析模型
 *
 * @param model 模型名称
 * @returns 模型信息
 */
function parseModel(model: string) {
  const [_model, size] = model.split(":");
  const [_, width, height] = /(\d+)[\W\w](\d+)/.exec(size) ?? [];
  return {
    model: _model,
    width: size ? Math.ceil(parseInt(width) / 2) * 2 : 1024,
    height: size ? Math.ceil(parseInt(height) / 2) * 2 : 1024,
  };
}

/**
 * 检测是否为视频生成请求
 * 
 * @param model 模型名称
 * @returns 是否为视频生成请求
 */
function isVideoModel(model: string) {
  return model.startsWith("jimeng-video");
}

/**
 * 从消息中提取图片URL列表
 * 支持 OpenAI 格式的多模态消息
 * 
 * @param messages 消息数组
 * @returns 图片URL或Base64数据数组
 */
function extractImagesFromMessages(messages: any[]): string[] {
  const images: string[] = [];
  const seen = new Set<string>();

  const addImage = (value: unknown, mediaType = "image/png") => {
    if (typeof value !== "string" || !value) return;
    const normalized = value.startsWith("data:") || value.startsWith("http://") || value.startsWith("https://")
      ? value
      : `data:${mediaType};base64,${value}`;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      images.push(normalized);
    }
  };

  const collectImage = (value: any, mediaType = "image/png") => {
    if (!value) return;
    if (typeof value === "string") {
      addImage(value, mediaType);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(item => collectImage(item, mediaType));
      return;
    }
    if (typeof value !== "object") return;

    if (typeof value.url === "string") addImage(value.url, mediaType);
    if (typeof value.image_url === "string") addImage(value.image_url, mediaType);
    else if (value.image_url) collectImage(value.image_url, mediaType);

    if (value.source?.data) {
      addImage(value.source.data, value.source.media_type || mediaType);
    }
    if (value.data && (value.type === "image" || value.type === "input_image")) {
      addImage(value.data, value.media_type || mediaType);
    }
  };

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (Array.isArray(message.content) || typeof message.content === "object") {
      collectImage(message.content);
    } else if (typeof message.content === "string" && /^(data:|https?:\/\/)/i.test(message.content)) {
      collectImage(message.content);
    }
    collectImage(message.images);
    collectImage(message.attachments);
    collectImage(message.image_url);
    collectImage(message.image);
  }

  logger.info(`从消息中提取到 ${images.length} 张图片`);
  return images;
}

/**
 * 从消息中提取文本提示词
 * 
 * @param message 消息对象
 * @returns 提示词文本
 */
function extractTextFromMessage(message: any): string {
  if (!message.content) return "";

  // 如果是字符串，直接返回
  if (typeof message.content === 'string') {
    return message.content;
  }

  // 如果是数组，提取所有文本部分
  if (Array.isArray(message.content)) {
    return message.content
      .filter((item: any) => item.type === 'text')
      .map((item: any) => item.text)
      .join('\n');
  }

  return "";
}

/**
 * 同步对话补全
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param refreshToken 用于刷新access_token的refresh_token
 * @param assistantId 智能体ID，默认使用jimeng原版
 * @param retryCount 重试次数
 */
export async function createCompletion(
  messages: any[],
  refreshToken: string,
  _model = DEFAULT_MODEL,
  retryCount = 0
) {
  return (async () => {
    if (messages.length === 0)
      throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "消息不能为空");

    const { model, width, height } = parseModel(_model);
    // 只打印消息数量，不打印完整内容（可能包含大量base64图片数据）
    logger.info(`收到 ${messages.length} 条消息`);

    // 提取消息中的图片
    const imageUrls = extractImagesFromMessages(messages);
    // 提取最后一条消息的文本
    const lastMessage = messages[messages.length - 1];
    const promptText = extractTextFromMessage(lastMessage);

    // 检查是否为视频生成请求
    if (isVideoModel(_model)) {
      try {
        // 视频生成
        logger.info(`开始生成视频，模型: ${_model}，图片数量: ${imageUrls.length}`);

        // 查询生成前的积分
        let creditsBefore = 0;
        try {
          const beforeCredit = await getCredit(refreshToken);
          creditsBefore = beforeCredit.totalCredit;
        } catch (e) { /* 忽略积分查询错误 */ }

        const videoUrl = await generateVideo(
          _model,
          promptText || lastMessage.content,
          {
            width,
            height,
            resolution: "720p", // 默认分辨率
            filePaths: imageUrls, // 传递提取的图片作为首尾帧
          },
          refreshToken
        );
        if (typeof videoUrl !== "string" || !videoUrl.trim()) {
          throw new APIException(EX.API_VIDEO_GENERATION_FAILED, "视频生成未返回有效结果");
        }

        logger.info("视频生成成功");

        // 查询生成后的积分并计算消耗
        let creditsUsed = 0;
        let remainingCredits = 0;
        try {
          const afterCredit = await getCredit(refreshToken);
          remainingCredits = afterCredit.totalCredit;
          creditsUsed = Math.max(0, creditsBefore - remainingCredits);
          logger.info(`积分消耗: ${creditsUsed}, 剩余: ${remainingCredits}`);
        } catch (e) { /* 忽略积分查询错误 */ }

        // 记录统计和媒体
        try {
          db.recordCall(refreshToken, _model, creditsUsed, remainingCredits);
          if (videoUrl) db.saveMedia('video', videoUrl, _model, promptText || lastMessage.content, refreshToken);
        } catch (e) { /* 忽略数据库错误 */ }

        return {
          id: util.uuid(),
          model: _model,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: `![video](${videoUrl})\n`,
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created: util.unixTimestamp(),
        };
      } catch (error) {
        logger.error("视频生成失败");
        // 如果是积分不足等特定错误，直接抛出
        if (error instanceof APIException) {
          throw error;
        }

        throw error;
      }
    } else {
      // 图像生成
      // 查询生成前的积分
      let creditsBefore = 0;
      try {
        const beforeCredit = await getCredit(refreshToken);
        creditsBefore = beforeCredit.totalCredit;
      } catch (e) { /* 忽略积分查询错误 */ }

      const generatedImageUrls = (await generateImagesWithRetry(
        model,
        promptText || lastMessage.content,
        {
          ratio: "1:1",  // 默认比例
          resolution: "2k",  // 初始尝试 2K，会自动降级
          filePath: imageUrls.length > 0 ? imageUrls[0] : "", // 第一张图片作为参考图
        },
        refreshToken
      )).filter((url): url is string => typeof url === "string" && url.trim().length > 0);
      if (generatedImageUrls.length === 0) {
        throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "图像生成未返回有效结果");
      }

      // 查询生成后的积分并计算消耗
      let creditsUsed = 0;
      let remainingCredits = 0;
      try {
        const afterCredit = await getCredit(refreshToken);
        remainingCredits = afterCredit.totalCredit;
        creditsUsed = Math.max(0, creditsBefore - remainingCredits);
        logger.info(`积分消耗: ${creditsUsed}, 剩余: ${remainingCredits}`);
      } catch (e) { /* 忽略积分查询错误 */ }

      // 记录统计和媒体
      try {
        db.recordCall(refreshToken, _model || model, creditsUsed, remainingCredits);
        generatedImageUrls.forEach(url => {
          if (url) db.saveMedia('image', url, _model || model, promptText || lastMessage.content, refreshToken);
        });
      } catch (e) { /* 忽略数据库错误 */ }

      return {
        id: util.uuid(),
        model: _model || model,
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: generatedImageUrls.reduce(
                (acc, url, i) => acc + `![image_${i}](${url})\n`,
                ""
              ),
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        created: util.unixTimestamp(),
      };
    }
  })().catch(async (err) => {
    await failPoolTask();
    throw err;
  });
}

/**
 * 流式对话补全
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param refreshToken 用于刷新access_token的refresh_token
 * @param assistantId 智能体ID，默认使用jimeng原版
 * @param retryCount 重试次数
 */
export async function createCompletionStream(
  messages: any[],
  refreshToken: string,
  _model = DEFAULT_MODEL,
  retryCount = 0
) {
  return (async () => {
    const { model, width, height } = parseModel(_model);
    // 只打印消息数量，不打印完整内容（可能包含大量base64图片数据）
    logger.info(`收到 ${messages.length} 条消息`);

    // 提取消息中的图片
    const imageUrls = extractImagesFromMessages(messages);
    // 提取最后一条消息的文本
    const lastMessage = messages[messages.length - 1];
    const promptText = extractTextFromMessage(lastMessage);

    const stream = new PassThrough();

    if (messages.length === 0) {
      logger.warn("消息为空，返回空流");
      stream.end("data: [DONE]\n\n");
      return stream;
    }

    // 检查是否为视频生成请求
    if (isVideoModel(_model)) {
      // 视频生成
      stream.write(
        "data: " +
        JSON.stringify({
          id: util.uuid(),
          model: _model,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "🎬 视频生成中，请稍候...\n这可能需要1-2分钟，请耐心等待" },
              finish_reason: null,
            },
          ],
        }) +
        "\n\n"
      );

      // 视频生成
      logger.info("开始生成视频");

      // 进度更新定时器
      const progressInterval = setInterval(() => {
        if (!stream.destroyed) stream.write(
          "data: " +
          JSON.stringify({
            id: util.uuid(),
            model: _model,
            object: "chat.completion.chunk",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "." },
                finish_reason: null,
              },
            ],
          }) +
          "\n\n"
        );
      }, 5000);

      // 设置超时，防止无限等待
      const timeoutId = setTimeout(() => {
        clearInterval(progressInterval);
        logger.warn(`视频生成超时（2分钟），提示用户前往即梦官网查看`);
        if (!stream.destroyed) stream.write(
          "data: " +
          JSON.stringify({
            id: util.uuid(),
            model: _model,
            object: "chat.completion.chunk",
            choices: [
              {
                index: 1,
                delta: {
                  role: "assistant",
                  content: "\n\n视频生成时间较长（已等待2分钟），但视频可能仍在生成中。\n\n请前往即梦官网查看您的视频：\n1. 访问 https://jimeng.jianying.com/ai-tool/video/generate\n2. 登录后查看您的创作历史\n3. 如果视频已生成，您可以直接在官网下载或分享\n\n您也可以继续等待，系统将在后台继续尝试获取视频（最长约20分钟）。",
                },
                finish_reason: null,
              },
            ],
          }) +
          "\n\n"
        );
        // 注意：这里不结束流，让后台继续尝试获取视频
        // stream.end("data: [DONE]\n\n");
      }, 2 * 60 * 1000);

      logger.info(`开始生成视频，模型: ${_model}`);

      // 先给用户一个初始提示
      stream.write(
        "data: " +
        JSON.stringify({
          id: util.uuid(),
          model: _model,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: "\n\n🎬 视频生成已开始，这可能需要几分钟时间...",
              },
              finish_reason: null,
            },
          ],
        }) +
        "\n\n"
      );

      generateVideo(
        _model,
        promptText || lastMessage.content,
        { width, height, resolution: "720p", filePaths: imageUrls },
        refreshToken
      )
        .then((videoUrl) => {
          if (typeof videoUrl !== "string" || !videoUrl.trim()) {
            throw new APIException(EX.API_VIDEO_GENERATION_FAILED, "视频生成未返回有效结果");
          }
          clearInterval(progressInterval);
          clearTimeout(timeoutId);

          logger.info("视频生成成功");

          // 记录统计和媒体
          try {
            db.recordCall(refreshToken, _model, 0);
            if (videoUrl) db.saveMedia('video', videoUrl, _model, promptText || lastMessage.content, refreshToken);
          } catch (e) { /* 忽略数据库错误 */ }

          stream.write(
            "data: " +
            JSON.stringify({
              id: util.uuid(),
              model: _model,
              object: "chat.completion.chunk",
              choices: [
                {
                  index: 1,
                  delta: {
                    role: "assistant",
                    content: `\n\n✅ 视频生成完成！\n\n![video](${videoUrl})\n\n您可以：\n1. 直接查看上方视频\n2. 使用以下链接下载或分享：${videoUrl}`,
                  },
                  finish_reason: null,
                },
              ],
            }) +
            "\n\n"
          );

          stream.write(
            "data: " +
            JSON.stringify({
              id: util.uuid(),
              model: _model,
              object: "chat.completion.chunk",
              choices: [
                {
                  index: 2,
                  delta: {
                    role: "assistant",
                    content: "",
                  },
                  finish_reason: "stop",
                },
              ],
            }) +
            "\n\n"
          );
          stream.end("data: [DONE]\n\n");
        })
        .catch(async () => {
          clearInterval(progressInterval);
          clearTimeout(timeoutId);
          await failPoolTask();
          writeMediaStreamFailure(stream);
        });
    } else {
      // 图像生成
      stream.write(
        "data: " +
        JSON.stringify({
          id: util.uuid(),
          model: _model || model,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "🎨 图像生成中，请稍候..." },
              finish_reason: null,
            },
          ],
        }) +
        "\n\n"
      );

      generateImagesWithRetry(
        model,
        promptText || lastMessage.content,
        { ratio: "1:1", resolution: "2k", filePath: imageUrls.length > 0 ? imageUrls[0] : "" },
        refreshToken
      )
        .then((generatedUrls) => {
          const validUrls = Array.isArray(generatedUrls)
            ? generatedUrls.filter((url): url is string => typeof url === "string" && url.trim().length > 0)
            : [];
          if (validUrls.length === 0) {
            throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "图像生成未返回有效结果");
          }
          // 记录统计和媒体
          try {
            db.recordCall(refreshToken, _model || model, 0);
            validUrls.forEach(url => {
              if (url) db.saveMedia('image', url, _model || model, promptText || lastMessage.content, refreshToken);
            });
          } catch (e) { /* 忽略数据库错误 */ }

          for (let i = 0; i < validUrls.length; i++) {
            const url = validUrls[i];
            stream.write(
              "data: " +
              JSON.stringify({
                id: util.uuid(),
                model: _model || model,
                object: "chat.completion.chunk",
                choices: [
                  {
                    index: i + 1,
                    delta: {
                      role: "assistant",
                      content: `![image_${i}](${url})\n`,
                    },
                    finish_reason: null,
                  },
                ],
              }) +
              "\n\n"
            );
          }
          stream.write(
            "data: " +
            JSON.stringify({
              id: util.uuid(),
              model: _model || model,
              object: "chat.completion.chunk",
              choices: [
                {
                  index: validUrls.length + 1,
                  delta: {
                    role: "assistant",
                    content: "图像生成完成！",
                  },
                  finish_reason: "stop",
                },
              ],
            }) +
            "\n\n"
          );
          stream.end("data: [DONE]\n\n");
        })
        .catch(async () => {
          await failPoolTask();
          writeMediaStreamFailure(stream);
        });
    }
    return stream;
  })().catch(async (err) => {
    await failPoolTask();
    throw err;
  });
}

/** An incomplete media stream must not emit a successful finish_reason. */
function writeMediaStreamFailure(stream: PassThrough) {
  if (stream.destroyed) return;
  const task = currentPoolTask();
  stream.write(`data: ${JSON.stringify({ error: { code: 'media_generation_incomplete',
    message: '生成未完成，未重新提交；请通过原任务查询状态' },
    ...(task?.taskId ? { pool_task_id: task.taskId, state: task.state, upstream_task_id: task.upstreamTaskId || null } : {}) })}\n\n`);
  stream.end('data: [DONE]\n\n');
}
