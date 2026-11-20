import _ from "lodash";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import util from "@/lib/util.ts";
import { getCredit, receiveCredit, request, uploadFile } from "./core.ts";
import { uploadVideoReference } from "./video-reference-upload.ts";
import { videoHistoryRecord } from "./video-history.ts";
import logger from "@/lib/logger.ts";
import { JimengModelConfig, resolveVideoModelConfig } from "./models.ts";
import { validateSeedance25Options } from "./seedance25-policy.ts";

const DEFAULT_ASSISTANT_ID = 513695;
export const DEFAULT_MODEL = "jimeng-video-seedance-2.0";
const DRAFT_VERSION = "3.3.20";
const WEB_VERSION = "7.5.0";
const DEFAULT_VIDEO_DURATIONS = [5, 10];
const SEEDANCE_2_DURATIONS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const MODEL_MAP = {
  "jimeng-video-seedance-2.5": "dreamina_seedance_45_pro",
  "jimeng-video-seedance-2.0-mini": "dreamina_seedance_40_mini",
  "jimeng-video-seedance-2.0": "dreamina_seedance_40_pro",
  "seedance-2.0": "dreamina_seedance_40_pro",
  "seedance-2.0-pro": "dreamina_seedance_40_pro",
  "jimeng-video-seedance-2.0-pro": "dreamina_seedance_40_pro",
  "jimeng-video-seedance-2.0-fast": "dreamina_seedance_40",
  "seedance-2.0-fast": "dreamina_seedance_40",
  "jimeng-video-seedance-2.0-fast-vip": "dreamina_seedance_40_vision",
  "seedance-2.0-fast-vip": "dreamina_seedance_40_vision",
  "jimeng-video-seedance-2.0-vip": "dreamina_seedance_40_pro_vision",
  "seedance-2.0-vip": "dreamina_seedance_40_pro_vision",
  "jimeng-video-seedance-1.5-pro": "dreamina_ic_generate_video_model_vgfm_3.5_pro",
  "jimeng-video-3.0-pro": "dreamina_ic_generate_video_model_vgfm_3.0_pro",
  "jimeng-video-3.0": "dreamina_ic_generate_video_model_vgfm_3.0",
  "jimeng-video-3.0-fast": "dreamina_ic_generate_video_model_vgfm_3.0_fast",
  "jimeng-video-s2.0": "dreamina_ic_generate_video_model_vgfm_lite",
  "jimeng-video-2.0-pro": "dreamina_ic_generate_video_model_vgfm1.0",
};

export function getModel(model: string) {
  return MODEL_MAP[model] || MODEL_MAP[DEFAULT_MODEL];
}

const VIDEO_MODEL_CONFIG: Record<
  string,
  {
    defaultResolution: string;
    supportedResolutions: string[];
    benefits: Record<string, string>;
    defaultBenefit: string;
    supportsLongDuration: boolean;
    defaultDuration?: number;
    supportedDurations?: number[];
  }
> = {
  "jimeng-video-seedance-2.5": {
    defaultResolution: "720p",
    supportedResolutions: ["720p"],
    defaultBenefit: "",
    benefits: {},
    supportsLongDuration: true,
    supportedDurations: Array.from({ length: 26 }, (_, i) => i + 5),
  },
  "jimeng-video-seedance-2.0-mini": {
    defaultResolution: "720p",
    supportedResolutions: ["720p"],
    defaultBenefit: "seedance_20_mini_720p_output",
    benefits: {
      "720p": "seedance_20_mini_720p_output",
    },
    supportsLongDuration: true,
    defaultDuration: 5,
    supportedDurations: SEEDANCE_2_DURATIONS,
  },
  "jimeng-video-seedance-2.0-fast": {
    defaultResolution: "720p",
    supportedResolutions: ["720p"],
    defaultBenefit: "dreamina_seedance_20_fast",
    benefits: {
      "720p": "dreamina_seedance_20_fast",
    },
    supportsLongDuration: true,
    defaultDuration: 5,
    supportedDurations: SEEDANCE_2_DURATIONS,
  },
  "jimeng-video-seedance-2.0": {
    defaultResolution: "720p",
    supportedResolutions: ["720p"],
    defaultBenefit: "dreamina_video_seedance_20_pro",
    benefits: {
      "720p": "dreamina_video_seedance_20_pro",
    },
    supportsLongDuration: true,
    defaultDuration: 5,
    supportedDurations: SEEDANCE_2_DURATIONS,
  },
  "jimeng-video-seedance-2.0-fast-vip": {
    defaultResolution: "720p",
    supportedResolutions: ["720p"],
    defaultBenefit: "seedance_20_fast_720p_output",
    benefits: {
      "720p": "seedance_20_fast_720p_output",
    },
    supportsLongDuration: true,
    defaultDuration: 5,
    supportedDurations: SEEDANCE_2_DURATIONS,
  },
  "jimeng-video-seedance-2.0-vip": {
    defaultResolution: "720p",
    supportedResolutions: ["720p", "1080p", "4k"],
    defaultBenefit: "seedance_20_pro_720p_output",
    benefits: {
      "720p": "seedance_20_pro_720p_output",
      "1080p": "seedance_20_pro_1080p_output",
      "4k": "seedance_20_pro_4k_output",
    },
    supportsLongDuration: true,
    defaultDuration: 5,
    supportedDurations: SEEDANCE_2_DURATIONS,
  },
  "jimeng-video-seedance-1.5-pro": {
    defaultResolution: "720p",
    supportedResolutions: ["720p"],
    defaultBenefit: "dreamina_video_seedance_15_pro",
    benefits: {
      "720p": "dreamina_video_seedance_15_pro",
    },
    supportsLongDuration: true,
  },
  "jimeng-video-3.0-pro": {
    defaultResolution: "1080p",
    supportedResolutions: ["1080p"],
    defaultBenefit: "basic_video_operation_vgfm_v_three_pro",
    benefits: {
      "1080p": "basic_video_operation_vgfm_v_three_pro",
    },
    supportsLongDuration: true,
  },
  "jimeng-video-3.0-fast": {
    defaultResolution: "720p",
    supportedResolutions: ["720p", "1080p"],
    defaultBenefit: "basic_video_operation_vgfm_v_three",
    benefits: {
      "720p": "basic_video_operation_vgfm_v_three",
      "1080p": "basic_video_operation_vgfm_v_three_1080",
    },
    supportsLongDuration: true,
  },
};

function getVideoModelConfig(model: string): JimengModelConfig {
  const knownConfig = VIDEO_MODEL_CONFIG[model];
  if (knownConfig) {
    return {
      id: model,
      type: "video",
      name: model,
      description: `Jimeng video model ${model}`,
      modelReqKey: getModel(model),
      ...knownConfig,
    };
  }
  return {
    id: model,
    type: "video",
    name: model,
    description: `Jimeng video model ${model}`,
    modelReqKey: getModel(model),
    defaultResolution: "720p",
    supportedResolutions: ["720p"],
    defaultBenefit: "basic_video_operation_vgfm_v_three",
    benefits: {
      "720p": "basic_video_operation_vgfm_v_three",
    },
    supportsLongDuration: model.includes("3.0"),
  };
}

function getVideoCommerceInfoFromConfig(modelConfig: JimengModelConfig, resolution: string) {
  const benefitType =
    modelConfig.benefits?.[resolution] ||
    modelConfig.defaultBenefit ||
    "basic_video_operation_vgfm_v_three";
  return {
    benefit_type: benefitType,
    resource_id: "generate_video",
    resource_id_type: "str",
    resource_sub_type: "aigc",
  };
}

function getSupportedVideoDurations(modelConfig: JimengModelConfig) {
  const configuredDurations = (modelConfig.supportedDurations || []).filter(
    (duration) => Number.isInteger(duration) && duration > 0
  );
  if (configuredDurations.length > 0) {
    return [...new Set(configuredDurations)].sort((a, b) => a - b);
  }
  return modelConfig.supportsLongDuration ? DEFAULT_VIDEO_DURATIONS : [5];
}

function getDefaultVideoDuration(modelConfig: JimengModelConfig) {
  const supportedDurations = getSupportedVideoDurations(modelConfig);
  if (modelConfig.defaultDuration && supportedDurations.includes(modelConfig.defaultDuration)) {
    return modelConfig.defaultDuration;
  }
  return supportedDurations.includes(10) ? 10 : supportedDurations[0];
}

function normalizeVideoDuration(duration: number | undefined, modelConfig: JimengModelConfig) {
  const supportedDurations = getSupportedVideoDurations(modelConfig);
  if (Number.isInteger(duration) && supportedDurations.includes(duration!)) {
    return duration!;
  }
  return getDefaultVideoDuration(modelConfig);
}

const VIDEO_PROCESSING_STATES = [20, 42, 45];

function extractVideoUrlFromItemList(itemList: any[] = []) {
  for (const item of itemList) {
    const url =
      item?.video?.transcoded_video?.origin?.video_url ||
      item?.video?.play_url ||
      item?.video?.download_url ||
      item?.video?.url;
    if (typeof url === "string" && url.trim()) return url.trim();
  }
}

// 视频支持的比例列表
const VIDEO_ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];

/**
 * 从提示词中检测视频比例
 * 支持格式: 16:9, 16：9, 比例16:9, 横屏, 竖屏 等
 */
function detectVideoAspectRatio(prompt: string): string {
  // 正则匹配比例格式 (支持中英文冒号)
  const ratioRegex = /(\d+)\s*[:：]\s*(\d+)/g;
  const matches = [...prompt.matchAll(ratioRegex)];

  for (const match of matches) {
    const key = `${match[1]}:${match[2]}`;
    if (VIDEO_ASPECT_RATIOS.includes(key)) {
      logger.info(`从提示词中检测到视频比例: ${key}`);
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

  return "16:9"; // 默认 16:9 (User preference or standard default)
}

/**
 * 从提示词中检测视频时长
 * 支持格式: 5秒, 10秒, 5s, 10s
 * @returns 5 或 10，未检测到返回 null
 */
function detectVideoDuration(prompt: string): number | null {
  // 匹配中文秒数
  if (/10\s*[秒sS]/.test(prompt)) {
    logger.info(`从提示词中检测到时长: 10秒`);
    return 10;
  }
  if (/5\s*[秒sS]/.test(prompt)) {
    logger.info(`从提示词中检测到时长: 5秒`);
    return 5;
  }
  return null; // 未检测到
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
    ratio = "16:9",
    resolution = "720p",
    duration,
    filePaths = [],
    videoPaths = [],
    audioPaths = [],
    functionMode,
  }: {
    ratio?: string;
    resolution?: string;
    duration?: number;
    filePaths?: string[];
    videoPaths?: string[];
    audioPaths?: string[];
    functionMode?: "omni_reference";
    width?: number;
    height?: number;
  },
  refreshToken: string,
  cookie?: string
) {
  const modelConfig = await resolveVideoModelConfig(_model, refreshToken, cookie);
  validateSeedance25Options(modelConfig, { duration, resolution, functionMode, filePaths, videoPaths, audioPaths });
  const model = modelConfig.modelReqKey || getModel(_model);
  let finalResolution = resolution;
  if (!modelConfig.supportedResolutions.includes(finalResolution)) {
    throw new APIException(EX.API_REQUEST_PARAMS_INVALID, `模型不支持请求的分辨率 ${resolution}`);
  }

  // 比例逻辑：优先使用 ratio 参数，如果 ratio 是默认且 detecting logic kicks in, use detected.
  // 简化：如果 ratio 是 "custom" 或者在列表中，优先使用。
  // 实际上，为了保持和 images.ts 一致，我们优先信任参数。
  // 但为了保留 prompt feature：
  // 如果 ratio 没传 (undefined) -> default "16:9"。
  // 我们这里 assume caller handles default logic or we do.
  // 这里我们信任 ratio 参数 (caller passed it).
  let videoAspectRatio = ratio;
  if (!VIDEO_ASPECT_RATIOS.includes(videoAspectRatio)) {
    const detected = detectVideoAspectRatio(prompt);
    // 如果 parameters 指定了无效值，或者 caller didn't specify (using default), we might fallback to detected
    // 但这里 defaults "16:9" defined in destructuring.
    // So checking if it matches default is tricky.
    // 简单起见：如果 prompt 显式包含比例，覆盖默认值 "16:9"？
    // 不，参数 > prompt。Prompt detection is useful when params are NOT supported/provided by client.
    // API clients passing params explicitly expect them to work.
    // If client sends 16:9 (default) but prompt says 9:16, ambiguity.
    // 策略: 仅当 ratio 为默认值时尝试 detection?
    // 鉴于这是 API，我们应该严格遵守参数。如果用户没传参数 (default "16:9")，但 prompt 写了 "9:16"，理想情况下 Client 应该解析 prompt 并传参。
    // 但为了兼容旧习惯，如果用户没传显式参数（依赖默认），且 prompt 有明确指示，用 prompt。
    // 这里无法区分 "user passed 16:9" vs "default 16:9".
    // 我们保留 detective logic but verify usage.
    // 实际上原代码仅靠 detection，现在有了 parameter。
    // 建议：如果 detection 发现了 ratio，使用 detection。否则使用 parameter/default。
    // Wait, that overrides parameter? No.
    // 正确做法：Caller (Route) extracts params. If caller didn't extract, it uses default.
    // 我们就优先使用 parameter。

    // 但是如果参数是 "16:9" (默认) 而 prompt 是 "9:16"，是否用 prompt?
    // Risk: User wants 16:9 but prompt has "9:16" text for other reasons.
    // Decision: Use parameter 'ratio' as truth.
    videoAspectRatio = "16:9";
  }
  // 实际上，如果参数不在 VIDEO_ASPECT_RATIOS 中 (e.g. invalid), fallback to detected or default.
  if (!VIDEO_ASPECT_RATIOS.includes(ratio)) {
    const detected = detectVideoAspectRatio(prompt);
    if (VIDEO_ASPECT_RATIOS.includes(detected)) videoAspectRatio = detected;
    else videoAspectRatio = "16:9";
  } else {
    videoAspectRatio = ratio;
  }

  const requestedDuration = duration;
  let finalDuration = normalizeVideoDuration(requestedDuration, modelConfig);
  if (requestedDuration !== undefined && requestedDuration !== finalDuration) {
    throw new APIException(EX.API_REQUEST_PARAMS_INVALID, `模型不支持请求的时长 ${requestedDuration} 秒`);
  } else if (requestedDuration === undefined && finalDuration === 10) {
    const detectedDuration = detectVideoDuration(prompt);
    if (detectedDuration !== null) {
      finalDuration = normalizeVideoDuration(detectedDuration, modelConfig);
    }
  }

  const durationMs = finalDuration * 1000;

  logger.info(
    `使用模型: ${_model} 映射模型: ${model} 分辨率: ${finalResolution} 比例: ${videoAspectRatio} 时长: ${durationMs}ms (${finalDuration}秒)`
  );

  // 检查积分
  const { totalCredit } = await getCredit(refreshToken);
  if (totalCredit <= 0) await receiveCredit(refreshToken);

  // 处理首帧和尾帧图片
  let first_frame_image = undefined;
  let end_frame_image = undefined;

  if (functionMode !== "omni_reference" && filePaths && filePaths.length > 0) {
    // 统计图片类型而不是显示完整内容
    const imageTypes = filePaths.map((p) =>
      p.startsWith("data:") ? "base64" : p.startsWith("http") ? "url" : "file"
    );
    logger.info(
      `接收到 ${filePaths.length} 张图片用于首尾帧，类型: ${JSON.stringify(
        imageTypes
      )}`
    );
    let uploadIDs: string[] = [];

    for (let i = 0; i < filePaths.length; i++) {
      // ... (Upload Logic similar to previous) ...
      const filePath = filePaths[i];
      try {
        if (!filePath) throw new Error("参考图片路径为空");
        const uploadResult = await uploadFile(refreshToken, filePath, true);
        if (!uploadResult?.image_uri) throw new Error("参考图片上传未返回图片标识");
        uploadIDs.push(uploadResult.image_uri);
      } catch (e) {
        logger.error("上传失败");
        throw new APIException(EX.API_REQUEST_FAILED, i === 0 ? "首帧上传失败" : "尾帧上传失败");
      }
    }

    // ... Assign frames ...
    if (uploadIDs[0]) {
      first_frame_image = {
        format: "",
        height: 0,
        id: util.uuid(),
        image_uri: uploadIDs[0],
        name: "",
        platform_type: 1,
        source_from: "upload",
        type: "image",
        uri: uploadIDs[0],
        width: 0,
      };
    }
    if (uploadIDs[1]) {
      end_frame_image = {
        format: "", // ... Same structure
        height: 0,
        id: util.uuid(),
        image_uri: uploadIDs[1],
        name: "",
        platform_type: 1,
        source_from: "upload",
        type: "image",
        uri: uploadIDs[1],
        width: 0,
      };
    }
  }

  const componentId = util.uuid();
  const metricsExtra = JSON.stringify({
    enterFrom: "click",
    isDefaultSeed: 1,
    promptSource: "custom",
    isRegenerate: false,
    originSubmitId: util.uuid(),
  });
  const videoCommerceInfo = getVideoCommerceInfoFromConfig(modelConfig, finalResolution);
  logger.info(
    `视频模型配置: source=${modelConfig.source || "static"}, benefit_type=${videoCommerceInfo.benefit_type}, 可用时长=${getSupportedVideoDurations(modelConfig).join(",")}秒`
  );
  const hasReferenceFrame = Boolean(first_frame_image || end_frame_image);
  logger.info(
    `视频请求参考图${hasReferenceFrame ? "已写入首/尾帧字段" : "未写入首/尾帧字段"}`
  );

  let omniRequestData: Record<string, unknown> | undefined;
  if (functionMode === "omni_reference") {
    const imageUris: string[] = [];
    for (const path of filePaths) {
      const uploaded = await uploadFile(refreshToken, path, true);
      if (!uploaded?.image_uri) throw new APIException(EX.API_REQUEST_FAILED, "全能参考图片上传失败");
      imageUris.push(uploaded.image_uri);
    }
    const materialList: any[] = imageUris.map((uri) => ({
      type: "", id: util.uuid(), material_type: "image",
      image_info: {
        type: "image", id: util.uuid(), source_from: "upload", platform_type: 1,
        name: "", image_uri: uri, uri, width: 0, height: 0, format: "",
      },
    }));
    const materialTypes = imageUris.map(() => 1);
    let totalVideoDurationMs = 0;
    for (const path of videoPaths) {
      const uploaded = await uploadVideoReference(path, refreshToken, "video", cookie);
      totalVideoDurationMs += uploaded.durationMs;
      if (totalVideoDurationMs > 15000) throw new APIException(EX.API_REQUEST_FAILED, "参考视频总时长不能超过 15 秒");
      materialList.push({ type: "", id: util.uuid(), material_type: "video", video_info: {
        type: "video", id: util.uuid(), source_from: "upload", name: "", vid: uploaded.vid,
        fps: 0, width: uploaded.width, height: uploaded.height, duration: uploaded.durationMs,
      } });
      materialTypes.push(2);
    }
    for (const path of audioPaths) {
      const uploaded = await uploadVideoReference(path, refreshToken, "audio", cookie);
      materialList.push({ type: "", id: util.uuid(), material_type: "audio", audio_info: {
        type: "audio", id: util.uuid(), source_from: "upload", name: "", vid: uploaded.vid,
        duration: uploaded.durationMs,
      } });
      materialTypes.push(3);
    }
    const materialNames = { 1: "image", 2: "video", 3: "audio" } as const;
    const isSeedance25 = model === "dreamina_seedance_45_pro";
    const metaList = isSeedance25 ? [{ type: "", id: util.uuid(), meta_type: "text", text: prompt }] : materialTypes.flatMap((type, index) => [
      { meta_type: materialNames[type as keyof typeof materialNames], text: "", material_ref: { material_idx: index } },
      { meta_type: "text", text: index === materialTypes.length - 1 ? ` ${prompt}` : " " },
    ]);
    const omniMetrics = JSON.stringify({
      enterFrom: "click", isDefaultSeed: 1, isRegenerate: false,
      originSubmitId: util.uuid(), functionMode: "omni_reference",
      ...(isSeedance25 ? { generatorFeature: "omniReference" } : {}),
      sceneOptions: JSON.stringify([{
        type: "video", scene: "BasicVideoGenerateButton", modelReqKey: model,
        videoDuration: finalDuration, materialTypes,
        ...(isSeedance25 ? { resolution: finalResolution, batchNumber: 1, inputVideoDuration: 0, chargeInputVideoDuration: true, isLongVideo: false, hasInputVideo: false, useSeedanceFast5sFreeTrial: false } : {}),
      }]),
    });
    // Observed only for the confirmed 4-second Fast VIP web request.
    const observedFastVip4s = model === "dreamina_seedance_40_vision" && finalDuration === 4 && finalResolution === "720p";
    const omniCommerceInfo = isSeedance25 && finalResolution === "720p" && videoPaths.length === 0
      ? { ...videoCommerceInfo, benefit_type: "seedance_25_720p_no_input_video_output", amount: finalDuration }
      : observedFastVip4s
      ? { ...videoCommerceInfo, benefit_type: "dreamina_seedance_20_fast_5s", amount: 4 }
      : videoCommerceInfo;
    const omniComponentId = util.uuid();
    omniRequestData = {
      extend: {
        root_model: model,
        m_video_commerce_info: omniCommerceInfo,
        m_video_commerce_info_list: [omniCommerceInfo],
      },
      submit_id: util.uuid(),
      metrics_extra: omniMetrics,
      draft_content: JSON.stringify({
        type: "draft", id: util.uuid(), min_version: isSeedance25 ? "3.3.9" : DRAFT_VERSION,
        min_features: isSeedance25 ? ["AIGC_Video_UnifiedEdit", "AIGC_Video_Seedance25ResultAction"] : ["AIGC_Video_UnifiedEdit"], is_from_tsn: true,
        version: DRAFT_VERSION, main_component_id: omniComponentId,
        component_list: [{
          type: "video_base_component", id: omniComponentId, min_version: "1.0.0",
          aigc_mode: "workbench", generate_type: "gen_video", process_type: 1,
          metadata: {
            type: "", id: util.uuid(), created_platform: 3,
            created_platform_version: "", created_time_in_ms: String(Date.now()), created_did: "",
          },
          abilities: {
            type: "", id: util.uuid(), gen_video: {
              id: util.uuid(), type: "",
              text_to_video_params: {
                type: "", id: util.uuid(), model_req_key: model,
                priority: 0, seed: Math.floor(Math.random() * 1000000000),
                video_aspect_ratio: videoAspectRatio,
                video_gen_inputs: [{
                  type: "", id: util.uuid(), min_version: isSeedance25 ? "3.3.9" : DRAFT_VERSION,
                  prompt: "", video_mode: 2, fps: 24, duration_ms: durationMs,
                  ...(observedFastVip4s || isSeedance25 ? { resolution: finalResolution } : {}),
                  unified_edit_input: { type: "", id: util.uuid(), material_list: materialList, meta_list: metaList },
                  idip_meta_list: [],
                }],
              },
              video_task_extra: omniMetrics,
            },
          },
        }],
      }),
      http_common_info: { aid: Number(DEFAULT_ASSISTANT_ID) },
    };
    logger.info(`全能参考已上传图片 ${imageUris.length}、视频 ${videoPaths.length}、音频 ${audioPaths.length}`);
  }

  // 构建请求参数
  const { aigc_data } = await request(
    "post",
    "/mweb/v1/aigc_draft/generate",
    refreshToken,
    {
      cookie,
      // Submission may already have reached Jimeng on a timeout/HTTP error.
      // Do not create another paid task when its outcome is unknown.
      maxRetries: 0,
      params: {
        aigc_features: "app_lip_sync",
        web_version: WEB_VERSION,
        da_version: DRAFT_VERSION,
        web_component_open_flag: 1, // Added
      },
      data: omniRequestData || {
        extend: {
          root_model: model,
          m_video_commerce_info: videoCommerceInfo,
          m_video_commerce_info_list: [videoCommerceInfo],
        },
        submit_id: util.uuid(),
        metrics_extra: metricsExtra,
        draft_content: JSON.stringify({
          type: "draft",
          id: util.uuid(),
          min_version: "3.0.5",
          is_from_tsn: true,
          version: DRAFT_VERSION,
          main_component_id: componentId,
          component_list: [
            {
              type: "video_base_component",
              id: componentId,
              min_version: "1.0.0",
              metadata: {
                type: "",
                id: util.uuid(),
                created_platform: 3,
                created_platform_version: "",
                created_time_in_ms: Date.now(),
                created_did: "",
              },
              generate_type: "gen_video",
              aigc_mode: "workbench",
              abilities: {
                type: "",
                id: util.uuid(),
                gen_video: {
                  id: util.uuid(),
                  type: "",
                  text_to_video_params: {
                    type: "",
                    id: util.uuid(),
                    model_req_key: model,
                    priority: 0,
                    seed: Math.floor(Math.random() * 100000000) + 2500000000,
                    video_aspect_ratio: videoAspectRatio,
                    video_gen_inputs: [
                      {
                        duration_ms: durationMs,
                        first_frame_image: first_frame_image,
                        end_frame_image: end_frame_image,
                        fps: 24,
                        id: util.uuid(),
                        min_version: "3.0.5",
                        prompt: prompt,
                        resolution: finalResolution,
                        type: "",
                        // 即梦网页端：0 是带首/尾帧的 V1 图生视频，2 是默认文生视频。
                        video_mode: hasReferenceFrame ? 0 : 2,
                      },
                    ],
                  },
                  video_task_extra: metricsExtra,
                },
              },
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
    throw new APIException(EX.API_VIDEO_GENERATION_FAILED, "记录ID不存在");

  // 轮询获取结果
  let status = 20,
    failCode,
    item_list = [];
  const VIDEO_SUCCESS_STATES = [21, 50];
  let retryCount = 0;
  const maxRetries = 60; // 20 mins

  await new Promise((resolve) => setTimeout(resolve, 5000));

  logger.info(`开始轮询视频生成结果，历史ID: ${historyId}`);

  while (VIDEO_PROCESSING_STATES.includes(status) && retryCount < maxRetries) {
    try {
      const result = await request("post", "/mweb/v1/get_history_by_ids", refreshToken, {
        cookie,
        data: { history_ids: [historyId] },
      });
      const historyData = videoHistoryRecord(result, historyId);

      if (!historyData) {
        retryCount++;
        await new Promise((r) =>
          setTimeout(r, Math.min(2000 * retryCount, 30000))
        );
        continue;
      }

      status = Number(historyData.status);
      failCode = historyData.fail_code;
      item_list = historyData.item_list || [];

      if (status === 30) {
        throw new APIException(
          EX.API_VIDEO_GENERATION_FAILED,
          `生成失败: ${failCode}`
        );
      }

      // Pending history may contain uploaded reference videos. Only return
      // an item URL after the generation has reached a terminal state.
      if (VIDEO_SUCCESS_STATES.includes(status)) {
        const generatedVideoUrl = extractVideoUrlFromItemList(item_list);
        if (generatedVideoUrl) return generatedVideoUrl;
      }

      if (VIDEO_PROCESSING_STATES.includes(status)) {
        retryCount++;
        await new Promise((r) =>
          setTimeout(r, 2000 * Math.min(retryCount + 1, 5))
        );
      }
    } catch (e) {
      if (e instanceof APIException) throw e;
      logger.error("轮询出错");
      retryCount++;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  // Timeout
  if (retryCount >= maxRetries) {
    throw new APIException(EX.API_VIDEO_GENERATION_FAILED, "超时");
  }

  // Final Extraction (only from verified terminal success states)
  if (VIDEO_SUCCESS_STATES.includes(Number(status))) {
    const finalUrl = extractVideoUrlFromItemList(item_list);
    if (finalUrl) return finalUrl;
  }

  throw new APIException(
    EX.API_VIDEO_GENERATION_FAILED,
    `视频生成未到达已核验完成状态，状态码: ${Number.isFinite(Number(status)) ? status : "unknown"}${failCode ? `，失败码: ${failCode}` : ""}`
  );
}

/**
 * 兼容旧函数名；保持请求参数，只提交一次
 */
export async function generateVideoWithRetry(
  _model: string,
  prompt: string,
  options: {
    ratio?: string;
    resolution?: string;
    duration?: number;
    filePaths?: string[];
    videoPaths?: string[];
    audioPaths?: string[];
    functionMode?: "omni_reference";
  },
  refreshToken: string,
  cookie?: string
): Promise<string> {
  return generateVideo(_model, prompt, options, refreshToken, cookie);
}
