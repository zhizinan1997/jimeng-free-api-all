import _ from "lodash";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import util from "@/lib/util.ts";
import { getCredit, receiveCredit, request, uploadFile } from "./core.ts";
import logger from "@/lib/logger.ts";

const DEFAULT_ASSISTANT_ID = "513695";
export const DEFAULT_MODEL = "jimeng-video-3.0";
const DRAFT_VERSION = "3.2.8";
const MODEL_MAP = {
  "jimeng-video-3.0-pro": "dreamina_ic_generate_video_model_vgfm_3.0_pro",
  "jimeng-video-3.0": "dreamina_ic_generate_video_model_vgfm_3.0",
  "jimeng-video-2.0": "dreamina_ic_generate_video_model_vgfm_lite",
  "jimeng-video-2.0-pro": "dreamina_ic_generate_video_model_vgfm1.0"
};

export function getModel(model: string) {
  return MODEL_MAP[model] || MODEL_MAP[DEFAULT_MODEL];
}

/**
 * 生成视频
 * 
 * @param _model 模型名称
 * @param prompt 提示词
 * @param options 选项
 * @param refreshToken 刷新令牌
 * @returns 视频URL
 */
export async function generateVideo(
  _model: string,
  prompt: string,
  {
    width = 1024,
    height = 1024,
    resolution = "720p",
    filePaths = [],
  }: {
    width?: number;
    height?: number;
    resolution?: string;
    filePaths?: string[];
  },
  refreshToken: string
) {
  const model = getModel(_model);
  logger.info(`使用模型: ${_model} 映射模型: ${model} ${width}x${height} 分辨率: ${resolution}`);

  // 检查积分
  const { totalCredit } = await getCredit(refreshToken);
  if (totalCredit <= 0)
    await receiveCredit(refreshToken);

  // 处理首帧和尾帧图片
  let first_frame_image = undefined;
  let end_frame_image = undefined;
  
  if (filePaths && filePaths.length > 0) {
    let uploadIDs: string[] = [];
    for (const filePath of filePaths) {
      if (!filePath) continue;
      
      try {
        const uploadResult = await uploadFile(refreshToken, filePath);
        if (uploadResult && uploadResult.image_uri) {
          uploadIDs.push(uploadResult.image_uri);
        }
      } catch (error) {
        logger.error(`上传图片失败: ${error.message}`);
      }
    }
    
    if (uploadIDs[0]) {
      first_frame_image = {
        format: "",
        height: height,
        id: util.uuid(),
        image_uri: uploadIDs[0],
        name: "",
        platform_type: 1,
        source_from: "upload",
        type: "image",
        uri: uploadIDs[0],
        width: width,
      };
    }
    
    if (uploadIDs[1]) {
      end_frame_image = {
        format: "",
        height: height,
        id: util.uuid(),
        image_uri: uploadIDs[1],
        name: "",
        platform_type: 1,
        source_from: "upload",
        type: "image",
        uri: uploadIDs[1],
        width: width,
      };
    }
  }

  const componentId = util.uuid();
  const metricsExtra = JSON.stringify({
    "enterFrom": "click",
    "isDefaultSeed": 1,
    "promptSource": "custom",
    "isRegenerate": false,
    "originSubmitId": util.uuid(),
  });
  
  // 构建请求参数
  const { aigc_data } = await request(
    "post",
    "/mweb/v1/aigc_draft/generate",
    refreshToken,
    {
      params: {
        aigc_features: "app_lip_sync",
        web_version: "6.6.0",
        da_version: DRAFT_VERSION,
      },
      data: {
        "extend": {
          "root_model": end_frame_image ? MODEL_MAP['jimeng-video-3.0'] : model,
          "m_video_commerce_info": {
            benefit_type: "basic_video_operation_vgfm_v_three",
            resource_id: "generate_video",
            resource_id_type: "str",
            resource_sub_type: "aigc"
          },
          "m_video_commerce_info_list": [{
            benefit_type: "basic_video_operation_vgfm_v_three",
            resource_id: "generate_video",
            resource_id_type: "str",
            resource_sub_type: "aigc"
          }]
        },
        "submit_id": util.uuid(),
        "metrics_extra": metricsExtra,
        "draft_content": JSON.stringify({
          "type": "draft",
          "id": util.uuid(),
          "min_version": "3.0.5",
          "is_from_tsn": true,
          "version": DRAFT_VERSION,
          "main_component_id": componentId,
          "component_list": [{
            "type": "video_base_component",
            "id": componentId,
            "min_version": "1.0.0",
            "metadata": {
              "type": "",
              "id": util.uuid(),
              "created_platform": 3,
              "created_platform_version": "",
              "created_time_in_ms": Date.now(),
              "created_did": ""
            },
            "generate_type": "gen_video",
            "aigc_mode": "workbench",
            "abilities": {
              "type": "",
              "id": util.uuid(),
              "gen_video": {
                "id": util.uuid(),
                "type": "",
                "text_to_video_params": {
                  "type": "",
                  "id": util.uuid(),
                  "model_req_key": model,
                  "priority": 0,
                  "seed": Math.floor(Math.random() * 100000000) + 2500000000,
                  "video_aspect_ratio": "1:1",
                  "video_gen_inputs": [{
                    duration_ms: 5000,
                    first_frame_image: first_frame_image,
                    end_frame_image: end_frame_image,
                    fps: 24,
                    id: util.uuid(),
                    min_version: "3.0.5",
                    prompt: prompt,
                    resolution: resolution,
                    type: "",
                    video_mode: 2
                  }]
                },
                "video_task_extra": metricsExtra,
              }
            }
          }],
        }),
        http_common_info: {
          aid: Number(DEFAULT_ASSISTANT_ID),
        },
      },
    }
  );

  const historyId = aigc_data.history_record_id;
  if (!historyId)
    throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录ID不存在");

  // 轮询获取结果
  let status = 20, failCode, item_list = [];
  let retryCount = 0;
  const maxRetries = 60; // 增加重试次数，支持约20分钟的总重试时间
  
  // 首次查询前等待更长时间，让服务器有时间处理请求
  await new Promise((resolve) => setTimeout(resolve, 5000));
  
  logger.info(`开始轮询视频生成结果，历史ID: ${historyId}，最大重试次数: ${maxRetries}`);
  logger.info(`即梦官网API地址: https://jimeng.jianying.com/mweb/v1/get_history_by_ids`);
  logger.info(`视频生成请求已发送，请同时在即梦官网查看: https://jimeng.jianying.com/ai-tool/video/generate`);
  
  while (status === 20 && retryCount < maxRetries) {
    try {
      // 构建请求URL和参数
      const requestUrl = "/mweb/v1/get_history_by_ids";
      const requestData = {
        history_ids: [historyId],
      };
      
      // 尝试两种不同的API请求方式
      let result;
      let useAlternativeApi = retryCount > 10 && retryCount % 2 === 0; // 在重试10次后，每隔一次尝试备用API
      
      if (useAlternativeApi) {
        // 备用API请求方式
        logger.info(`尝试备用API请求方式，URL: ${requestUrl}, 历史ID: ${historyId}, 重试次数: ${retryCount + 1}/${maxRetries}`);
        const alternativeRequestData = {
          history_record_ids: [historyId],
        };
        result = await request("post", "/mweb/v1/get_history_records", refreshToken, {
          data: alternativeRequestData,
        });
        logger.info(`备用API响应: ${JSON.stringify(result)}`);
        
        // 尝试直接从响应中提取视频URL
        const responseStr = JSON.stringify(result);
        const videoUrlMatch = responseStr.match(/https:\/\/v[0-9]+-artist\.vlabvod\.com\/[^"\s]+/);
        if (videoUrlMatch && videoUrlMatch[0]) {
          logger.info(`从备用API响应中直接提取到视频URL: ${videoUrlMatch[0]}`);
          // 提前返回找到的URL
          return videoUrlMatch[0];
        }
      } else {
        // 标准API请求方式
        logger.info(`发送请求获取视频生成结果，URL: ${requestUrl}, 历史ID: ${historyId}, 重试次数: ${retryCount + 1}/${maxRetries}`);
        result = await request("post", requestUrl, refreshToken, {
          data: requestData,
        });
        const responseStr = JSON.stringify(result);
        logger.info(`标准API响应摘要: ${responseStr.substring(0, 300)}...`);
        
        // 尝试直接从响应中提取视频URL
        const videoUrlMatch = responseStr.match(/https:\/\/v[0-9]+-artist\.vlabvod\.com\/[^"\s]+/);
        if (videoUrlMatch && videoUrlMatch[0]) {
          logger.info(`从标准API响应中直接提取到视频URL: ${videoUrlMatch[0]}`);
          // 提前返回找到的URL
          return videoUrlMatch[0];
        }
      }
      

      // 检查结果是否有效
      let historyData;
      
      if (useAlternativeApi && result.history_records && result.history_records.length > 0) {
        // 处理备用API返回的数据格式
        historyData = result.history_records[0];
        logger.info(`从备用API获取到历史记录`);
      } else if (result.history_list && result.history_list.length > 0) {
        // 处理标准API返回的数据格式
        historyData = result.history_list[0];
        logger.info(`从标准API获取到历史记录`);
      } else {
        // 两种API都没有返回有效数据
        logger.warn(`历史记录不存在，重试中 (${retryCount + 1}/${maxRetries})... 历史ID: ${historyId}`);
        logger.info(`请同时在即梦官网检查视频是否已生成: https://jimeng.jianying.com/ai-tool/video/generate`);
        
        retryCount++;
        // 增加重试间隔时间，但设置上限为30秒
        const waitTime = Math.min(2000 * (retryCount + 1), 30000);
        logger.info(`等待 ${waitTime}ms 后进行第 ${retryCount + 1} 次重试`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        continue;
      }
      
      // 记录获取到的结果详情
      logger.info(`获取到历史记录结果: ${JSON.stringify(historyData)}`);
      

      // 从历史数据中提取状态和结果
      status = historyData.status;
      failCode = historyData.fail_code;
      item_list = historyData.item_list || [];
      
      logger.info(`视频生成状态: ${status}, 失败代码: ${failCode || '无'}, 项目列表长度: ${item_list.length}`);
      
      // 如果有视频URL，提前记录
      let tempVideoUrl = item_list?.[0]?.video?.transcoded_video?.origin?.video_url;
      if (!tempVideoUrl) {
        // 尝试从其他可能的路径获取
        tempVideoUrl = item_list?.[0]?.video?.play_url || 
                      item_list?.[0]?.video?.download_url || 
                      item_list?.[0]?.video?.url;
      }
      
      if (tempVideoUrl) {
        logger.info(`检测到视频URL: ${tempVideoUrl}`);
      }

      if (status === 30) {
        const error = failCode === 2038 
          ? new APIException(EX.API_CONTENT_FILTERED, "内容被过滤")
          : new APIException(EX.API_IMAGE_GENERATION_FAILED, `生成失败，错误码: ${failCode}`);
        // 添加历史ID到错误对象，以便在chat.ts中显示
        error.historyId = historyId;
        throw error;
      }
      
      // 如果状态仍在处理中，等待后继续
      if (status === 20) {
        const waitTime = 2000 * (Math.min(retryCount + 1, 5)); // 随着重试次数增加等待时间，但最多10秒
        logger.info(`视频生成中，状态码: ${status}，等待 ${waitTime}ms 后继续查询`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    } catch (error) {
      logger.error(`轮询视频生成结果出错: ${error.message}`);
      retryCount++;
      await new Promise((resolve) => setTimeout(resolve, 2000 * (retryCount + 1)));
    }
  }
  
  // 如果达到最大重试次数仍未成功
  if (retryCount >= maxRetries && status === 20) {
    logger.error(`视频生成超时，已尝试 ${retryCount} 次，总耗时约 ${Math.floor(retryCount * 2000 / 1000 / 60)} 分钟`);
    const error = new APIException(EX.API_IMAGE_GENERATION_FAILED, "获取视频生成结果超时，请稍后在即梦官网查看您的视频");
    // 添加历史ID到错误对象，以便在chat.ts中显示
    error.historyId = historyId;
    throw error;
  }

  // 提取视频URL
  let videoUrl = item_list?.[0]?.video?.transcoded_video?.origin?.video_url;
  
  // 如果通过常规路径无法获取视频URL，尝试其他可能的路径
  if (!videoUrl) {
    // 尝试从item_list中的其他可能位置获取
    if (item_list?.[0]?.video?.play_url) {
      videoUrl = item_list[0].video.play_url;
      logger.info(`从play_url获取到视频URL: ${videoUrl}`);
    } else if (item_list?.[0]?.video?.download_url) {
      videoUrl = item_list[0].video.download_url;
      logger.info(`从download_url获取到视频URL: ${videoUrl}`);
    } else if (item_list?.[0]?.video?.url) {
      videoUrl = item_list[0].video.url;
      logger.info(`从url获取到视频URL: ${videoUrl}`);
    } else {
      // 如果仍然找不到，记录错误并抛出异常
      logger.error(`未能获取视频URL，item_list: ${JSON.stringify(item_list)}`);
      const error = new APIException(EX.API_IMAGE_GENERATION_FAILED, "未能获取视频URL，请稍后在即梦官网查看");
      // 添加历史ID到错误对象，以便在chat.ts中显示
      error.historyId = historyId;
      throw error;
    }
  }

  logger.info(`视频生成成功，URL: ${videoUrl}`);
  return videoUrl;
}