import _ from "lodash";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import util from "@/lib/util.ts";
import { getCredit, receiveCredit, request, uploadFile } from "./core.ts";
import logger from "@/lib/logger.ts";

const DEFAULT_ASSISTANT_ID = 513695;
export const DEFAULT_MODEL = "jimeng-image-4.5";
const DEFAULT_BLEND_MODEL = "jimeng-image-3.0"; // 混合模式使用的模型
const DRAFT_VERSION = "3.2.2";

const MODEL_MAP = {
  "jimeng-image-4.5": "high_aes_general_v40l",
  "jimeng-image-4.1": "high_aes_general_v41",
  "jimeng-image-4.0": "high_aes_general_v40",
  "jimeng-image-3.1": "high_aes_general_v30l_art_fangzhou:general_v3.0_18b",
  "jimeng-image-3.0": "high_aes_general_v30l:general_v3.0_18b",
};

// 即梦支持的图片比例映射
// image_ratio 值: 0=21:9, 1=16:9, 2=3:2, 3=4:3, 8=1:1, 4=3:4, 5=2:3, 6=9:16
const ASPECT_RATIOS = ["21:9", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16"];

// 比例对应的 image_ratio 值
const RATIO_VALUES: Record<string, number> = {
  "21:9": 0, "16:9": 1, "3:2": 2, "4:3": 3, "1:1": 8, "3:4": 4, "2:3": 5, "9:16": 6
};

// 1K 分辨率尺寸 (3.x 模型)
const DIMENSIONS_1K: Record<string, { width: number; height: number }> = {
  "21:9": { width: 2016, height: 846 },
  "16:9": { width: 1664, height: 936 },
  "3:2": { width: 1584, height: 1056 },
  "4:3": { width: 1472, height: 1104 },
  "1:1": { width: 1328, height: 1328 },
  "3:4": { width: 1104, height: 1472 },
  "2:3": { width: 1056, height: 1584 },
  "9:16": { width: 936, height: 1664 },
};

// 2K 分辨率尺寸 (4.x 模型)
const DIMENSIONS_2K: Record<string, { width: number; height: number }> = {
  "21:9": { width: 3024, height: 1296 },
  "16:9": { width: 2560, height: 1440 },
  "3:2": { width: 2496, height: 1664 },
  "4:3": { width: 2304, height: 1728 },
  "1:1": { width: 2048, height: 2048 },
  "3:4": { width: 1728, height: 2304 },
  "2:3": { width: 1664, height: 2496 },
  "9:16": { width: 1440, height: 2560 },
};

/**
 * 从提示词中检测图片比例
 * 支持格式: 16:9, 16：9, 比例16:9, 横屏, 竖屏 等
 * 返回比例字符串，如 "16:9"
 */
function detectAspectRatioKey(prompt: string): string | null {
  // 正则匹配比例格式 (支持中英文冒号)
  const ratioRegex = /(\d+)\s*[:：]\s*(\d+)/g;
  const matches = [...prompt.matchAll(ratioRegex)];
  
  for (const match of matches) {
    const key = `${match[1]}:${match[2]}`;
    if (ASPECT_RATIOS.includes(key)) {
      logger.info(`从提示词中检测到比例: ${key}`);
      return key;
    }
  }
  
  // 支持中文关键词
  if (/横屏|横版|宽屏/.test(prompt)) {
    logger.info(`从提示词中检测到横屏关键词，使用 16:9`);
    return "16:9";
  }
  if (/竖屏|竖版|手机/.test(prompt)) {
    logger.info(`从提示词中检测到竖屏关键词，使用 9:16`);
    return "9:16";
  }
  if (/方形|正方/.test(prompt)) {
    logger.info(`从提示词中检测到方形关键词，使用 1:1`);
    return "1:1";
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
    ratio = "1:1",
    resolution = "2k",
    sampleStrength = 0.5,
    negativePrompt = "",
    filePath = "",
  }: {
    ratio?: string;
    resolution?: string;
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
  
  // 有参考图时使用混合模型
  const modelName = hasFilePath ? DEFAULT_BLEND_MODEL : _model;
  const model = getModel(modelName);
  
  // 解析分辨率和比例
  const is4xModel = modelName.includes('image-4.') || modelName === 'jimeng-image-4.5' || modelName === 'jimeng-image-4.1' || modelName === 'jimeng-image-4.0';
  let resolutionType = resolution; // 用户指定优先
  
  // 如果未指定或不明确，根据模型默认
  if (!['1k', '2k'].includes(resolutionType)) {
    resolutionType = is4xModel ? '2k' : '1k';
  }

  const dimensionMap = resolutionType === '2k' ? DIMENSIONS_2K : DIMENSIONS_1K;
  
  // 从提示词中检测比例
  const detectedRatioKey = detectAspectRatioKey(prompt);
  // 如果用户传了 valid ratio (in map) 则使用，否则使用 detector 或默认 1:1
  // 这里逻辑：如果 ratio 是默认 "1:1" 且 detectedRatioKey 存在，则使用 detected。否则优先使用 ratio 参数。
  // 注意：如果用户显式传了 "1:1" 我们可能无法区分是默认还是显式。
  // 但通常 API 调用者会传 ratio。如果 prompt 里有，我们假设 prompt 优先级较高？不，参数优先级通常更高。
  // 但是 detectAspectRatioKey 用意是方便用户只通过 prompt 控制。
  // 假设：如果 ratio 是 "custom" (API gateways sometimes send "custom"), treat as unset.
  // 这里简化：如果 ratio 参数在 RATIO_VALUES 中且不是 detect 出来的（这里无法区分），直接用。
  // 妥协：优先使用 ratio 参数，除非 ratio 是 "custom" 或者空。
  
  let validRatio = ratio;
  if (!RATIO_VALUES.hasOwnProperty(validRatio)) {
      validRatio = "1:1";
  }
  
  // 如果 prompt 里检测到且 ratio 是默认 "1:1" (可能是未传)，则覆盖。
  // 这里的风险是用户真的想 1:1 但 prompt 里有 "16:9"。
  // 鉴于这是一个 "Chat" driven API often，prompt detection is feature.
  if (detectedRatioKey && validRatio === "1:1") {
      validRatio = detectedRatioKey;
  }
  
  const imageRatio = RATIO_VALUES[validRatio];
  const dimensions = dimensionMap[validRatio];
  const finalWidth = dimensions.width;
  const finalHeight = dimensions.height;
  
  logger.info(`使用模型: ${modelName} 映射模型: ${model} ${finalWidth}x${finalHeight} (${validRatio}) 精细度: ${sampleStrength} 分辨率: ${resolutionType} 模式: ${hasFilePath ? '混合' : '生成'}`);

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
            resolution_type: resolutionType
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
            resolution_type: resolutionType
          },
        },
        history_option: {
          type: "",
          id: util.uuid(),
        },
      },
    };
  }
  
  const { aigc_data } = await request(
    "post",
    "/mweb/v1/aigc_draft/generate",
    refreshToken,
    {
      params: {
        da_version: "3.2.2",
        web_component_open_flag: 1,
        web_version: "3.2.2"
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
  const MAX_POLL_RETRIES = 120; // 最多轮询120次
  
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

/**
 * 带自动降级重试的图像生成
 * 如果积分不足，自动降低分辨率重试
 */
export async function generateImagesWithRetry(
  _model: string,
  prompt: string,
  options: {
    ratio?: string;
    resolution?: string;
    sampleStrength?: number;
    negativePrompt?: string;
    filePath?: string;
  },
  refreshToken: string
): Promise<string[]> {
  const resolutionLevels = ['2k', '1k']; // 分辨率降级顺序
  let currentResIndex = Math.max(0, resolutionLevels.indexOf(options.resolution || '2k'));
  
  while (currentResIndex < resolutionLevels.length) {
    try {
      const currentOptions = {
        ...options,
        resolution: resolutionLevels[currentResIndex]
      };
      logger.info(`尝试生成图像，分辨率: ${currentOptions.resolution}`);
      return await generateImages(_model, prompt, currentOptions, refreshToken);
    } catch (error) {
      // 检查是否为积分不足错误 (fail_code 2039 或包含积分不足关键词)
      const isInsufficientCredits = 
        error.code === EX.API_IMAGE_GENERATION_INSUFFICIENT_POINTS[0] ||
        (error.message && (error.message.includes('积分不足') || error.message.includes('2039')));
      
      if (isInsufficientCredits && currentResIndex < resolutionLevels.length - 1) {
        currentResIndex++;
        logger.warn(`积分不足，自动降级到 ${resolutionLevels[currentResIndex]} 分辨率重试...`);
        continue;
      }
      
      // 已是最低分辨率仍然失败
      if (isInsufficientCredits) {
        throw new APIException(
          EX.API_IMAGE_GENERATION_INSUFFICIENT_POINTS,
          '积分不足，已自动降至最低画质仍然不足，请前往即梦官网 https://jimeng.jianying.com 充值积分'
        );
      }
      
      // 其他错误直接抛出
      throw error;
    }
  }
  
  throw new APIException(EX.API_IMAGE_GENERATION_FAILED, '图像生成失败');
}

export default {
  generateImages,
  generateImagesWithRetry,
};
