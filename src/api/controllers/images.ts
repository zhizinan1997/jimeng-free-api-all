import _ from "lodash";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import util from "@/lib/util.ts";
import { getCredit, receiveCredit, request, uploadFile } from "./core.ts";
import logger from "@/lib/logger.ts";

const DEFAULT_ASSISTANT_ID = "513695";
export const DEFAULT_MODEL = "jimeng-4.5";
const DEFAULT_BLEND_MODEL = "jimeng-3.0"; // 混合模式使用的模型
const DRAFT_VERSION = "3.0.2";
const MODEL_MAP = {
  "jimeng-4.5": "high_aes_general_v40l",
  "jimeng-4.1": "high_aes_general_v41",
  "jimeng-4.0": "high_aes_general_v40",
  "jimeng-3.1": "high_aes_general_v30l_art_fangzhou:general_v3.0_18b",
  "jimeng-3.0": "high_aes_general_v30l:general_v3.0_18b",
};

// 即梦支持的图片比例映射
// image_ratio 值: 0=21:9, 1=16:9, 2=3:2, 3=4:3, 8=1:1, 4=3:4, 5=2:3, 6=9:16
const ASPECT_RATIO_MAP: Record<string, { ratio: number; width: number; height: number }> = {
  "21:9": { ratio: 0, width: 1512, height: 648 },
  "16:9": { ratio: 1, width: 1360, height: 765 },
  "3:2": { ratio: 2, width: 1360, height: 907 },
  "4:3": { ratio: 3, width: 1360, height: 1020 },
  "1:1": { ratio: 8, width: 1024, height: 1024 },
  "3:4": { ratio: 4, width: 1020, height: 1360 },
  "2:3": { ratio: 5, width: 907, height: 1360 },
  "9:16": { ratio: 6, width: 765, height: 1360 },
};

/**
 * 从提示词中检测图片比例
 * 支持格式: 16:9, 16：9, 比例16:9, 横屏, 竖屏 等
 */
function detectAspectRatio(prompt: string): { ratio: number; width: number; height: number } | null {
  // 正则匹配比例格式 (支持中英文冒号)
  const ratioRegex = /(\d+)\s*[:：]\s*(\d+)/g;
  const matches = [...prompt.matchAll(ratioRegex)];
  
  for (const match of matches) {
    const key = `${match[1]}:${match[2]}`;
    if (ASPECT_RATIO_MAP[key]) {
      logger.info(`从提示词中检测到比例: ${key}`);
      return ASPECT_RATIO_MAP[key];
    }
  }
  
  // 支持中文关键词
  if (/横屏|横版|宽屏/.test(prompt)) {
    logger.info(`从提示词中检测到横屏关键词，使用 16:9`);
    return ASPECT_RATIO_MAP["16:9"];
  }
  if (/竖屏|竖版|手机/.test(prompt)) {
    logger.info(`从提示词中检测到竖屏关键词，使用 9:16`);
    return ASPECT_RATIO_MAP["9:16"];
  }
  if (/方形|正方/.test(prompt)) {
    logger.info(`从提示词中检测到方形关键词，使用 1:1`);
    return ASPECT_RATIO_MAP["1:1"];
  }
  
  return null;
}

export function getModel(model: string) {
  return MODEL_MAP[model] || MODEL_MAP[DEFAULT_MODEL];
}

export async function generateImages(
  _model: string,
  prompt: string,
  {
    width = 1024,
    height = 1024,
    sampleStrength = 0.5,
    negativePrompt = "",
    filePath = "",
  }: {
    width?: number;
    height?: number;
    sampleStrength?: number;
    negativePrompt?: string;
    filePath?: string;  // 参考图路径，支持本地/网络
  },
  refreshToken: string
) {
  // 检查是否有参考图
  const hasFilePath = !!filePath;
  let uploadID: string | null = null;
  
  // 如果有参考图，先上传
  if (hasFilePath) {
    // 只显示类型信息，不显示完整的base64内容
    const fileDesc = filePath.startsWith('data:') 
      ? `base64图片(${filePath.length}字符)` 
      : filePath.substring(0, 80);
    logger.info(`检测到参考图: ${fileDesc}，切换到混合模式`);
    try {
      const uploadResult = await uploadFile(refreshToken, filePath);
      uploadID = uploadResult.image_uri;
      logger.info(`参考图上传成功，URI: ${uploadID}`);
    } catch (error) {
      logger.error(`参考图上传失败: ${error.message}`);
      throw new APIException(EX.API_REQUEST_FAILED, `参考图上传失败: ${error.message}`);
    }
  }
  
  // 从提示词中检测比例
  const detectedRatio = detectAspectRatio(prompt);
  let imageRatio = 8; // 默认 1:1
  let finalWidth = width;
  let finalHeight = height;
  
  if (detectedRatio) {
    imageRatio = detectedRatio.ratio;
    finalWidth = detectedRatio.width;
    finalHeight = detectedRatio.height;
    logger.info(`使用检测到的比例，image_ratio: ${imageRatio}, ${finalWidth}x${finalHeight}`);
  }
  
  // 有参考图时使用混合模型
  const modelName = hasFilePath ? DEFAULT_BLEND_MODEL : _model;
  const model = getModel(modelName);
  logger.info(`使用模型: ${modelName} 映射模型: ${model} ${finalWidth}x${finalHeight} 精细度: ${sampleStrength} 模式: ${hasFilePath ? '混合' : '生成'}`);

  const { totalCredit } = await getCredit(refreshToken);
  if (totalCredit <= 0)
    await receiveCredit(refreshToken);

  const componentId = util.uuid();
  
  // 构建 abilities 对象
  let abilities: Record<string, any>;
  
  if (hasFilePath && uploadID) {
    // 混合模式 abilities
    abilities = {
      type: "",
      id: util.uuid(),
      blend: {
        type: "",
        id: util.uuid(),
        min_features: [],
        core_param: {
          type: "",
          id: util.uuid(),
          model,
          prompt: prompt + '##',
          sample_strength: sampleStrength,
          image_ratio: imageRatio,
          large_image_info: {
            type: "",
            id: util.uuid(),
            height: finalHeight,
            width: finalWidth,
            resolution_type: '1k'
          }
        },
        ability_list: [
          {
            type: "",
            id: util.uuid(),
            name: "byte_edit",
            image_uri_list: [uploadID],
            image_list: [
              {
                type: "image",
                id: util.uuid(),
                source_from: "upload",
                platform_type: 1,
                name: "",
                image_uri: uploadID,
                width: 0,
                height: 0,
                format: "",
                uri: uploadID
              }
            ],
            strength: 0.5
          }
        ],
        history_option: {
          type: "",
          id: util.uuid(),
        },
        prompt_placeholder_info_list: [
          {
            type: "",
            id: util.uuid(),
            ability_index: 0
          }
        ],
        postedit_param: {
          type: "",
          id: util.uuid(),
          generate_type: 0
        }
      }
    };
  } else {
    // 普通生成模式 abilities
    abilities = {
      type: "",
      id: util.uuid(),
      generate: {
        type: "",
        id: util.uuid(),
        core_param: {
          type: "",
          id: util.uuid(),
          model,
          prompt,
          negative_prompt: negativePrompt,
          seed: Math.floor(Math.random() * 100000000) + 2500000000,
          sample_strength: sampleStrength,
          image_ratio: imageRatio,
          large_image_info: {
            type: "",
            id: util.uuid(),
            height: finalHeight,
            width: finalWidth,
          },
        },
        history_option: {
          type: "",
          id: util.uuid(),
        },
      },
    };
  }
  
  // 构建请求参数
  const babiParam = hasFilePath ? {
    scenario: "image_video_generation",
    feature_key: "to_image_referenceimage_generate",
    feature_entrance: "to_image",
    feature_entrance_detail: "to_image-referenceimage-byte_edit",
  } : {
    scenario: "image_video_generation",
    feature_key: "aigc_to_image",
    feature_entrance: "to_image",
    feature_entrance_detail: "to_image-" + model,
  };
  
  const { aigc_data } = await request(
    "post",
    "/mweb/v1/aigc_draft/generate",
    refreshToken,
    {
      params: {
        babi_param: encodeURIComponent(JSON.stringify(babiParam)),
      },
      data: {
        extend: {
          root_model: model,
          template_id: "",
        },
        submit_id: util.uuid(),
        metrics_extra: hasFilePath ? undefined : JSON.stringify({
          templateId: "",
          generateCount: 1,
          promptSource: "custom",
          templateSource: "",
          lastRequestId: "",
          originRequestId: "",
        }),
        draft_content: JSON.stringify({
          type: "draft",
          id: util.uuid(),
          min_version: DRAFT_VERSION,
          is_from_tsn: true,
          version: "3.2.2",
          main_component_id: componentId,
          component_list: [
            {
              type: "image_base_component",
              id: componentId,
              min_version: DRAFT_VERSION,
              metadata: {
                type: "",
                id: util.uuid(),
                created_platform: 3,
                created_platform_version: "",
                created_time_in_ms: Date.now(),
                created_did: ""
              },
              generate_type: hasFilePath ? "blend" : "generate",
              aigc_mode: "workbench",
              abilities,
            },
          ],
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
  
  // 状态码说明：
  // 20 = 初始提交/队列中
  // 42 = 处理中（jimeng-4.5 新状态）
  // 45 = 处理中（jimeng-4.5 中间状态）
  // 50 = 完成/有结果（jimeng-4.5）
  // 21 = 生成成功（旧版本）
  // 30 = 生成失败
  const PROCESSING_STATES = [20, 42, 45];
  const FAIL_STATE = 30;
  
  let status = 20, failCode, item_list = [];
  let retryCount = 0;
  const MAX_POLL_RETRIES = 120; // 最多轮询120次（约2分钟，jimeng-4.5需要更长时间）
  
  // 轮询条件：状态在处理中 且 没有图片 且 未超时
  while (PROCESSING_STATES.includes(status) && (!item_list || item_list.length === 0) && retryCount < MAX_POLL_RETRIES) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    retryCount++;
    const result = await request("post", "/mweb/v1/get_history_by_ids", refreshToken, {
      data: {
        history_ids: [historyId],
        image_info: {
          width: 2048,
          height: 2048,
          format: "webp",
          image_scene_list: [
            {
              scene: "smart_crop",
              width: 360,
              height: 360,
              uniq_key: "smart_crop-w:360-h:360",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 480,
              height: 480,
              uniq_key: "smart_crop-w:480-h:480",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 720,
              height: 720,
              uniq_key: "smart_crop-w:720-h:720",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 720,
              height: 480,
              uniq_key: "smart_crop-w:720-h:480",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 360,
              height: 240,
              uniq_key: "smart_crop-w:360-h:240",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 240,
              height: 320,
              uniq_key: "smart_crop-w:240-h:320",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 480,
              height: 640,
              uniq_key: "smart_crop-w:480-h:640",
              format: "webp",
            },
            {
              scene: "normal",
              width: 2400,
              height: 2400,
              uniq_key: "2400",
              format: "webp",
            },
            {
              scene: "normal",
              width: 1080,
              height: 1080,
              uniq_key: "1080",
              format: "webp",
            },
            {
              scene: "normal",
              width: 720,
              height: 720,
              uniq_key: "720",
              format: "webp",
            },
            {
              scene: "normal",
              width: 480,
              height: 480,
              uniq_key: "480",
              format: "webp",
            },
            {
              scene: "normal",
              width: 360,
              height: 360,
              uniq_key: "360",
              format: "webp",
            },
          ],
        },
        http_common_info: {
          aid: Number(DEFAULT_ASSISTANT_ID),
        },
      },
    });
    if (!result[historyId])
      throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录不存在");
    status = result[historyId].status;
    failCode = result[historyId].fail_code;
    item_list = result[historyId].item_list;
    logger.info(`轮询状态: status=${status}, item_list长度=${item_list?.length || 0}, 第${retryCount}次`);
  }
  
  if (retryCount >= MAX_POLL_RETRIES) {
    throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "图像生成超时");
  }
  
  if (status === FAIL_STATE) {
    if (failCode === '2038')
      throw new APIException(EX.API_CONTENT_FILTERED);
    else
      throw new APIException(EX.API_IMAGE_GENERATION_FAILED);
  }
  return item_list.map((item) => {
    if(!item?.image?.large_images?.[0]?.image_url)
      return item?.common_attr?.cover_url || null;
    return item.image.large_images[0].image_url;
  });
}

export default {
  generateImages,
};
