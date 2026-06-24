import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";
import { request } from "./core.ts";

export type JimengModelType = "image" | "video";

export interface JimengModelConfig {
  id: string;
  type: JimengModelType;
  name: string;
  description: string;
  modelReqKey: string;
  defaultResolution: string;
  supportedResolutions: string[];
  benefits?: Record<string, string>;
  defaultBenefit?: string;
  benefitCountByResolution?: Record<string, number>;
  supportsLongDuration?: boolean;
  source?: "static" | "dynamic";
  raw?: any;
}

const DRAFT_VERSION = "3.3.20";
const WEB_VERSION = "7.5.0";
const MODEL_CACHE_TTL_MS = Number(process.env.JIMENG_MODEL_CACHE_TTL_MS || 5 * 60 * 1000);

const IMAGE_REQ_KEY_IDS: Record<string, string> = {
  high_aes_general_v50: "jimeng-image-5.0-lite",
  high_aes_general_v43: "jimeng-image-4.7",
  high_aes_general_v42: "jimeng-image-4.6",
  high_aes_general_v40l: "jimeng-image-4.5",
  high_aes_general_v41: "jimeng-image-4.1",
  high_aes_general_v40: "jimeng-image-4.0",
  "high_aes_general_v30l_art_fangzhou:general_v3.0_18b": "jimeng-image-3.1",
  "high_aes_general_v30l:general_v3.0_18b": "jimeng-image-3.0",
  "high_aes_general_v20_L:general_v2.0_L": "jimeng-image-2.0-pro",
};

const VIDEO_REQ_KEY_IDS: Record<string, string> = {
  dreamina_seedance_40_mini: "jimeng-video-seedance-2.0-mini",
  dreamina_seedance_40_vision: "jimeng-video-seedance-2.0-fast",
  dreamina_seedance_40_pro_vision: "jimeng-video-seedance-2.0-pro",
  "dreamina_ic_generate_video_model_vgfm_3.5_pro": "jimeng-video-seedance-1.5-pro",
  "dreamina_ic_generate_video_model_vgfm_3.0_pro": "jimeng-video-3.0-pro",
  "dreamina_ic_generate_video_model_vgfm_3.0": "jimeng-video-3.0",
  "dreamina_ic_generate_video_model_vgfm_3.0_fast": "jimeng-video-3.0-fast",
  dreamina_ic_generate_video_model_vgfm_lite: "jimeng-video-s2.0",
  "dreamina_ic_generate_video_model_vgfm1.0": "jimeng-video-2.0-pro",
};

const STATIC_IMAGE_MODELS: JimengModelConfig[] = [
  {
    id: "jimeng-image-5.0-lite",
    type: "image",
    name: "Seedream 5.0 Lite",
    description: "Jimeng image generation model 5.0 Lite",
    modelReqKey: "high_aes_general_v50",
    defaultResolution: "2k",
    supportedResolutions: ["4k", "2k"],
    benefitCountByResolution: { "2k": 3, "4k": 1 },
    source: "static",
  },
  {
    id: "jimeng-image-4.7",
    type: "image",
    name: "Seedream 4.7",
    description: "Jimeng image generation model 4.7",
    modelReqKey: "high_aes_general_v43",
    defaultResolution: "2k",
    supportedResolutions: ["4k", "2k"],
    benefitCountByResolution: { "2k": 4, "4k": 1 },
    source: "static",
  },
  {
    id: "jimeng-image-4.6",
    type: "image",
    name: "Seedream 4.6",
    description: "Jimeng image generation model 4.6",
    modelReqKey: "high_aes_general_v42",
    defaultResolution: "2k",
    supportedResolutions: ["4k", "2k"],
    benefitCountByResolution: { "2k": 4, "4k": 1 },
    source: "static",
  },
  {
    id: "jimeng-image-4.5",
    type: "image",
    name: "Seedream 4.5",
    description: "Jimeng image generation model 4.5",
    modelReqKey: "high_aes_general_v40l",
    defaultResolution: "2k",
    supportedResolutions: ["4k", "2k"],
    benefitCountByResolution: { "2k": 4, "4k": 1 },
    source: "static",
  },
  {
    id: "jimeng-image-4.1",
    type: "image",
    name: "Seedream 4.1",
    description: "Jimeng image generation model 4.1",
    modelReqKey: "high_aes_general_v41",
    defaultResolution: "2k",
    supportedResolutions: ["4k", "2k"],
    benefitCountByResolution: { "2k": 4, "4k": 1 },
    source: "static",
  },
  {
    id: "jimeng-image-4.0",
    type: "image",
    name: "Seedream 4.0",
    description: "Jimeng image generation model 4.0",
    modelReqKey: "high_aes_general_v40",
    defaultResolution: "2k",
    supportedResolutions: ["4k", "2k"],
    benefitCountByResolution: { "2k": 4, "4k": 1 },
    source: "static",
  },
  {
    id: "jimeng-image-3.1",
    type: "image",
    name: "Seedream 3.1",
    description: "Jimeng image generation model 3.1",
    modelReqKey: "high_aes_general_v30l_art_fangzhou:general_v3.0_18b",
    defaultResolution: "1k",
    supportedResolutions: ["1k"],
    benefitCountByResolution: { "1k": 1 },
    source: "static",
  },
  {
    id: "jimeng-image-3.0",
    type: "image",
    name: "Seedream 3.0",
    description: "Jimeng image generation model 3.0",
    modelReqKey: "high_aes_general_v30l:general_v3.0_18b",
    defaultResolution: "1k",
    supportedResolutions: ["1k"],
    benefitCountByResolution: { "1k": 1 },
    source: "static",
  },
  {
    id: "jimeng-image-2.0-pro",
    type: "image",
    name: "Seedream 2.0 Pro",
    description: "Jimeng image generation model 2.0 Pro",
    modelReqKey: "high_aes_general_v20_L:general_v2.0_L",
    defaultResolution: "1k",
    supportedResolutions: ["1k"],
    benefitCountByResolution: { "1k": 1 },
    source: "static",
  },
];

const STATIC_VIDEO_MODELS: JimengModelConfig[] = [
  {
    id: "jimeng-video-seedance-2.0-mini",
    type: "video",
    name: "Seedance 2.0 Mini",
    description: "Jimeng Seedance 2.0 Mini video generation model",
    modelReqKey: "dreamina_seedance_40_mini",
    defaultResolution: "720p",
    supportedResolutions: ["720p"],
    benefits: { "720p": "seedance_20_mini_720p_output" },
    defaultBenefit: "seedance_20_mini_720p_output",
    supportsLongDuration: true,
    source: "static",
  },
  {
    id: "jimeng-video-seedance-2.0-fast",
    type: "video",
    name: "Seedance 2.0 Fast VIP",
    description: "Jimeng Seedance 2.0 Fast VIP video generation model",
    modelReqKey: "dreamina_seedance_40_vision",
    defaultResolution: "720p",
    supportedResolutions: ["720p"],
    benefits: { "720p": "seedance_20_fast_720p_output" },
    defaultBenefit: "seedance_20_fast_720p_output",
    supportsLongDuration: true,
    source: "static",
  },
  {
    id: "jimeng-video-seedance-2.0-pro",
    type: "video",
    name: "Seedance 2.0 VIP",
    description: "Jimeng Seedance 2.0 VIP video generation model",
    modelReqKey: "dreamina_seedance_40_pro_vision",
    defaultResolution: "720p",
    supportedResolutions: ["720p", "1080p", "4k"],
    benefits: {
      "720p": "seedance_20_pro_720p_output",
      "1080p": "seedance_20_pro_1080p_output",
      "4k": "seedance_20_pro_4k_output",
    },
    defaultBenefit: "seedance_20_pro_720p_output",
    supportsLongDuration: true,
    source: "static",
  },
  {
    id: "jimeng-video-seedance-1.5-pro",
    type: "video",
    name: "Seedance 1.5 Pro",
    description: "Jimeng Seedance 1.5 Pro video generation model",
    modelReqKey: "dreamina_ic_generate_video_model_vgfm_3.5_pro",
    defaultResolution: "720p",
    supportedResolutions: ["720p"],
    benefits: { "720p": "dreamina_video_seedance_15_pro" },
    defaultBenefit: "dreamina_video_seedance_15_pro",
    supportsLongDuration: true,
    source: "static",
  },
  {
    id: "jimeng-video-3.0-pro",
    type: "video",
    name: "Jimeng Video 3.0 Pro",
    description: "Jimeng video generation model 3.0 Pro",
    modelReqKey: "dreamina_ic_generate_video_model_vgfm_3.0_pro",
    defaultResolution: "1080p",
    supportedResolutions: ["1080p"],
    benefits: { "1080p": "basic_video_operation_vgfm_v_three_pro" },
    defaultBenefit: "basic_video_operation_vgfm_v_three_pro",
    supportsLongDuration: true,
    source: "static",
  },
  {
    id: "jimeng-video-3.0",
    type: "video",
    name: "Jimeng Video 3.0",
    description: "Jimeng video generation model 3.0",
    modelReqKey: "dreamina_ic_generate_video_model_vgfm_3.0",
    defaultResolution: "720p",
    supportedResolutions: ["720p"],
    benefits: { "720p": "basic_video_operation_vgfm_v_three" },
    defaultBenefit: "basic_video_operation_vgfm_v_three",
    supportsLongDuration: true,
    source: "static",
  },
  {
    id: "jimeng-video-3.0-fast",
    type: "video",
    name: "Jimeng Video 3.0 Fast",
    description: "Jimeng video generation model 3.0 Fast",
    modelReqKey: "dreamina_ic_generate_video_model_vgfm_3.0_fast",
    defaultResolution: "720p",
    supportedResolutions: ["720p", "1080p"],
    benefits: {
      "720p": "basic_video_operation_vgfm_v_three",
      "1080p": "basic_video_operation_vgfm_v_three_1080",
    },
    defaultBenefit: "basic_video_operation_vgfm_v_three",
    supportsLongDuration: true,
    source: "static",
  },
  {
    id: "jimeng-video-s2.0",
    type: "video",
    name: "Jimeng Video S2.0",
    description: "Jimeng video generation model S2.0",
    modelReqKey: "dreamina_ic_generate_video_model_vgfm_lite",
    defaultResolution: "720p",
    supportedResolutions: ["720p"],
    benefits: { "720p": "basic_video_operation_vgfm_v_three" },
    defaultBenefit: "basic_video_operation_vgfm_v_three",
    supportsLongDuration: false,
    source: "static",
  },
  {
    id: "jimeng-video-2.0-pro",
    type: "video",
    name: "Jimeng Video 2.0 Pro",
    description: "Jimeng video generation model 2.0 Pro",
    modelReqKey: "dreamina_ic_generate_video_model_vgfm1.0",
    defaultResolution: "720p",
    supportedResolutions: ["720p"],
    benefits: { "720p": "basic_video_operation_vgfm_v_three" },
    defaultBenefit: "basic_video_operation_vgfm_v_three",
    supportsLongDuration: false,
    source: "static",
  },
];

const dynamicCache = new Map<
  string,
  {
    expiresAt: number;
    models: JimengModelConfig[];
  }
>();

function cloneModelConfig(model: JimengModelConfig): JimengModelConfig {
  return {
    ...model,
    supportedResolutions: [...model.supportedResolutions],
    benefits: model.benefits ? { ...model.benefits } : undefined,
    benefitCountByResolution: model.benefitCountByResolution
      ? { ...model.benefitCountByResolution }
      : undefined,
  };
}

export function getStaticModelConfigs(type?: JimengModelType) {
  const models = [...STATIC_IMAGE_MODELS, ...STATIC_VIDEO_MODELS];
  return models
    .filter((model) => !type || model.type === type)
    .map(cloneModelConfig);
}

function getStaticModelConfig(modelIdOrReqKey: string, type?: JimengModelType) {
  return getStaticModelConfigs(type).find(
    (model) => model.id === modelIdOrReqKey || model.modelReqKey === modelIdOrReqKey
  );
}

function compactText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function getStringField(obj: any, keys: string[]) {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === "string" && value.trim()) return compactText(value);
  }
}

function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "model";
}

function makeDynamicId(type: JimengModelType, modelReqKey: string, name?: string) {
  const known = type === "image" ? IMAGE_REQ_KEY_IDS[modelReqKey] : VIDEO_REQ_KEY_IDS[modelReqKey];
  if (known) return known;

  const base = name && /[a-z0-9]/i.test(name) ? name : modelReqKey;
  return `jimeng-${type}-${slugify(base)}`;
}

function findObjectsWithModelReqKey(value: any, out: any[] = [], seen = new Set<any>()) {
  if (!value || typeof value !== "object" || seen.has(value)) return out;
  seen.add(value);

  if (typeof value.model_req_key === "string" || typeof value.modelReqKey === "string") {
    out.push(value);
  }

  if (Array.isArray(value)) {
    value.forEach((item) => findObjectsWithModelReqKey(item, out, seen));
  } else {
    Object.values(value).forEach((item) => findObjectsWithModelReqKey(item, out, seen));
  }
  return out;
}

function collectResolutionStrings(value: any, out: string[] = [], seen = new Set<any>()) {
  if (!value) return out;
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (/^(480p|720p|1080p|1k|2k|4k)$/.test(normalized) && !out.includes(normalized)) {
      out.push(normalized);
    }
    return out;
  }
  if (typeof value !== "object" || seen.has(value)) return out;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item) => collectResolutionStrings(item, out, seen));
  } else {
    Object.values(value).forEach((item) => collectResolutionStrings(item, out, seen));
  }
  return out;
}

function collectPreferredResolutions(value: any, path: string[] = [], out: string[] = []) {
  if (!value || typeof value !== "object") return out;

  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...path, key.toLowerCase()];
    const pathText = nextPath.join(".");
    const isResolutionField = /resolution|definition|quality/.test(key.toLowerCase());
    const isPriceOnlyField = /price|benefit|commerce|cost/.test(pathText);

    if (isResolutionField && !isPriceOnlyField) {
      collectResolutionStrings(child, out);
    }

    if (child && typeof child === "object") {
      collectPreferredResolutions(child, nextPath, out);
    }
  }

  return [...new Set(out)];
}

function sortImageResolutions(resolutions: string[]) {
  const priority = ["4k", "2k", "1k"];
  return priority.filter((resolution) => resolutions.includes(resolution));
}

function sortVideoResolutions(resolutions: string[]) {
  const priority = ["4k", "1080p", "720p", "480p"];
  return priority.filter((resolution) => resolutions.includes(resolution));
}

function inferImageResolutions(modelReqKey: string, staticConfig?: JimengModelConfig) {
  if (staticConfig) return staticConfig.supportedResolutions;
  if (/v5|v4|general_v4|general_v5/.test(modelReqKey)) return ["4k", "2k"];
  return ["1k"];
}

function inferVideoResolutions(staticConfig?: JimengModelConfig, candidate?: any) {
  const preferred = collectPreferredResolutions(candidate);
  const sorted = sortVideoResolutions(preferred);
  if (sorted.length > 0) return sorted;
  if (staticConfig) return staticConfig.supportedResolutions;
  return ["720p"];
}

function collectBenefitTypes(value: any, out: string[] = [], seen = new Set<any>()) {
  if (!value || typeof value !== "object" || seen.has(value)) return out;
  seen.add(value);

  if (typeof value.benefit_type === "string" && !out.includes(value.benefit_type)) {
    out.push(value.benefit_type);
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectBenefitTypes(item, out, seen));
  } else {
    Object.values(value).forEach((item) => collectBenefitTypes(item, out, seen));
  }
  return out;
}

function collectVideoBenefits(candidate: any, resolutions: string[], staticConfig?: JimengModelConfig) {
  const benefits: Record<string, string> = { ...(staticConfig?.benefits || {}) };
  const benefitTypes = collectBenefitTypes(candidate);

  for (const benefitType of benefitTypes) {
    for (const resolution of resolutions) {
      if (benefitType.toLowerCase().includes(resolution.toLowerCase())) {
        benefits[resolution] = benefitType;
      }
    }
  }

  if (Object.keys(benefits).length === 0 && benefitTypes[0]) {
    benefits[resolutions[0] || "720p"] = benefitTypes[0];
  }

  return benefits;
}

function parseImageModel(candidate: any): JimengModelConfig | null {
  const modelReqKey = candidate.model_req_key || candidate.modelReqKey;
  if (typeof modelReqKey !== "string" || !modelReqKey.trim()) return null;

  const staticConfig = getStaticModelConfig(modelReqKey, "image");
  const name =
    getStringField(candidate, [
      "name",
      "model_name",
      "display_name",
      "displayName",
      "title",
      "label",
      "text",
    ]) ||
    staticConfig?.name ||
    modelReqKey;
  const preferredResolutions = sortImageResolutions(collectPreferredResolutions(candidate));
  const supportedResolutions =
    preferredResolutions.length > 0
      ? preferredResolutions
      : inferImageResolutions(modelReqKey, staticConfig);

  return {
    ...(staticConfig || {}),
    id: makeDynamicId("image", modelReqKey, name),
    type: "image",
    name,
    description:
      getStringField(candidate, ["description", "desc", "sub_title", "subtitle"]) ||
      staticConfig?.description ||
      `Jimeng image model ${name}`,
    modelReqKey,
    defaultResolution:
      staticConfig?.defaultResolution ||
      (supportedResolutions.includes("2k") ? "2k" : supportedResolutions[0] || "1k"),
    supportedResolutions,
    benefitCountByResolution: staticConfig?.benefitCountByResolution,
    source: "dynamic",
    raw: candidate,
  };
}

function parseVideoModel(candidate: any): JimengModelConfig | null {
  const modelReqKey = candidate.model_req_key || candidate.modelReqKey;
  if (typeof modelReqKey !== "string" || !modelReqKey.trim()) return null;

  const staticConfig = getStaticModelConfig(modelReqKey, "video");
  const name =
    getStringField(candidate, [
      "name",
      "model_name",
      "display_name",
      "displayName",
      "title",
      "label",
      "text",
    ]) ||
    staticConfig?.name ||
    modelReqKey;
  const supportedResolutions = inferVideoResolutions(staticConfig, candidate);
  const benefits = collectVideoBenefits(candidate, supportedResolutions, staticConfig);

  return {
    ...(staticConfig || {}),
    id: makeDynamicId("video", modelReqKey, name),
    type: "video",
    name,
    description:
      getStringField(candidate, ["description", "desc", "sub_title", "subtitle"]) ||
      staticConfig?.description ||
      `Jimeng video model ${name}`,
    modelReqKey,
    defaultResolution:
      staticConfig?.defaultResolution ||
      (supportedResolutions.includes("720p") ? "720p" : supportedResolutions[0] || "720p"),
    supportedResolutions,
    benefits,
    defaultBenefit:
      staticConfig?.defaultBenefit ||
      benefits[supportedResolutions[0]] ||
      Object.values(benefits)[0] ||
      "basic_video_operation_vgfm_v_three",
    supportsLongDuration: staticConfig?.supportsLongDuration ?? true,
    source: "dynamic",
    raw: candidate,
  };
}

function uniqueModels(models: JimengModelConfig[]) {
  const byKey = new Map<string, JimengModelConfig>();
  for (const model of models) {
    const key = `${model.type}:${model.modelReqKey}`;
    if (!byKey.has(key)) byKey.set(key, model);
  }
  return [...byKey.values()];
}

async function fetchImageModelConfigs(refreshToken: string) {
  const result = await request("post", "/mweb/v1/get_common_config", refreshToken, {
    params: {
      web_version: WEB_VERSION,
      da_version: DRAFT_VERSION,
      aigc_features: "app_lip_sync",
      needCache: true,
      needRefresh: false,
    },
    data: {
      is_client_filter: false,
      need_beta_model: true,
    },
  });

  return uniqueModels(
    findObjectsWithModelReqKey(result)
      .map(parseImageModel)
      .filter(Boolean) as JimengModelConfig[]
  );
}

async function fetchVideoModelConfigs(refreshToken: string) {
  const result = await request("post", "/mweb/v1/video_generate/get_common_config", refreshToken, {
    params: {
      web_version: WEB_VERSION,
      da_version: DRAFT_VERSION,
      aigc_features: "app_lip_sync",
    },
    data: {
      scene: "generate_video",
      params: {
        needCache: true,
      },
    },
  });

  return uniqueModels(
    findObjectsWithModelReqKey(result)
      .map(parseVideoModel)
      .filter(Boolean) as JimengModelConfig[]
  );
}

async function fetchDynamicModelConfigs(refreshToken: string, refresh = false) {
  const now = Date.now();
  const cacheKey = util.md5(refreshToken).slice(0, 12);
  const cached = dynamicCache.get(cacheKey);
  if (!refresh && cached && cached.expiresAt > now) {
    return cached.models.map(cloneModelConfig);
  }

  const results = await Promise.allSettled([
    fetchImageModelConfigs(refreshToken),
    fetchVideoModelConfigs(refreshToken),
  ]);
  const models = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : []
  );

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      logger.warn(
        `Failed to fetch ${index === 0 ? "image" : "video"} model config: ${result.reason?.message || result.reason}`
      );
    }
  });

  if (models.length === 0) {
    if (cached?.models?.length) return cached.models.map(cloneModelConfig);
    throw new Error("No dynamic Jimeng model config returned");
  }

  dynamicCache.set(cacheKey, {
    expiresAt: now + MODEL_CACHE_TTL_MS,
    models,
  });
  return models.map(cloneModelConfig);
}

function mergeModelConfigs(staticModels: JimengModelConfig[], dynamicModels: JimengModelConfig[]) {
  const byId = new Map<string, JimengModelConfig>();
  const byReqKey = new Map<string, JimengModelConfig>();

  for (const model of staticModels) {
    const cloned = cloneModelConfig(model);
    byId.set(cloned.id, cloned);
    byReqKey.set(`${cloned.type}:${cloned.modelReqKey}`, cloned);
  }

  for (const model of dynamicModels) {
    const staticMatch = byReqKey.get(`${model.type}:${model.modelReqKey}`);
    const merged = cloneModelConfig({
      ...(staticMatch || {}),
      ...model,
      id: staticMatch?.id || model.id,
      supportedResolutions:
        model.supportedResolutions?.length
          ? model.supportedResolutions
          : staticMatch?.supportedResolutions || [],
      benefits: {
        ...(staticMatch?.benefits || {}),
        ...(model.benefits || {}),
      },
      benefitCountByResolution:
        model.benefitCountByResolution || staticMatch?.benefitCountByResolution,
      source: "dynamic",
    });
    byId.set(merged.id, merged);
  }

  return [...byId.values()];
}

export async function listModelConfigs(
  refreshToken?: string,
  options: { refresh?: boolean; type?: JimengModelType } = {}
) {
  const staticModels = getStaticModelConfigs(options.type);
  let dynamicModels: JimengModelConfig[] = [];

  if (refreshToken) {
    try {
      dynamicModels = await fetchDynamicModelConfigs(refreshToken, options.refresh);
    } catch (error) {
      logger.warn(`Using static Jimeng model config: ${error.message}`);
    }
  }

  return mergeModelConfigs(staticModels, dynamicModels).filter(
    (model) => !options.type || model.type === options.type
  );
}

export async function resolveModelConfig(
  modelIdOrReqKey: string,
  type: JimengModelType,
  refreshToken?: string
) {
  const models = await listModelConfigs(refreshToken, { type });
  return (
    models.find(
      (model) => model.id === modelIdOrReqKey || model.modelReqKey === modelIdOrReqKey
    ) ||
    getStaticModelConfig(type === "image" ? "jimeng-image-5.0-lite" : "jimeng-video-seedance-2.0-mini", type)!
  );
}

export function getStaticModelReqKey(
  modelIdOrReqKey: string,
  type: JimengModelType
) {
  return getStaticModelConfig(modelIdOrReqKey, type)?.modelReqKey;
}

export function toOpenAIModel(model: JimengModelConfig) {
  return {
    id: model.id,
    object: "model",
    owned_by: `jimeng-${model.type}`,
    description: model.description,
    name: model.name,
    model_req_key: model.modelReqKey,
    supported_resolutions: model.supportedResolutions,
    default_resolution: model.defaultResolution,
    source: model.source || "static",
  };
}

export const resolveImageModelConfig = (modelIdOrReqKey: string, refreshToken?: string) =>
  resolveModelConfig(modelIdOrReqKey, "image", refreshToken);

export const resolveVideoModelConfig = (modelIdOrReqKey: string, refreshToken?: string) =>
  resolveModelConfig(modelIdOrReqKey, "video", refreshToken);
