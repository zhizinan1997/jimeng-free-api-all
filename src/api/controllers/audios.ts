import { currentPoolTask } from "../../lib/pool-task-context.ts";
import { resolvePoolTaskCredential } from "./auth.ts";
import fs from "fs-extra";
import path from "path";
import axios from "axios";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import util from "@/lib/util.ts";
import { getCredit, receiveCredit, request, tokenSplit } from "./core.ts";
import { uploadVideoReference } from "./video-reference-upload.ts";
import { ResolvedCredential } from "./auth.ts";
import db from "@/lib/database.ts";
import { readTaskAccount } from "@/lib/account-pool.ts";
import { AudioTaskBindings } from "@/lib/audio-task-bindings.ts";
import { videoHistoryRecord } from "./video-history.ts";
import logger from "@/lib/logger.ts";

const DEFAULT_ASSISTANT_ID = 513695;
const DRAFT_VERSION = "3.3.27";
const WEB_VERSION = "7.5.0";

const AUDIO_PROCESSING_STATES = [20, 42, 45];
const AUDIO_SUCCESS_STATES = [21, 50];
const AUDIO_FAIL_STATE = 30;

// SeedAudio 模型配置
const AUDIO_MODEL_MAP: Record<string, string> = {
  "jimeng-audio-seedaudio-1.0": "seed_audio",
  "seedaudio": "seed_audio",
  "seedaudio-1.0": "seed_audio",
  "seed-audio-1.0": "seed_audio",
  "seed_audio": "seed_audio",
};

export function getAudioModel(model: string): string {
  return AUDIO_MODEL_MAP[model] || "seed_audio";
}

// 即梦官方 dmop 音色完整映射表 (item_platform = 4)
export const OFFICIAL_VOICE_ID_MAP: Record<string, string> = {
  "阳光少年": "7382845921647661595",
  "Daniel": "7570355992521609737",
  "Chris": "7592673429489193498",
  "Callum": "7592674585963663923",
  "Lily": "7592674700728209929",
  "George": "7592674770097803814",
  "Liam": "7592674852876587529",
  "Sarah": "7592674945717506610",
  "Bill": "7592675040269701678",
  "生动解说": "7592679314714268186",
  "精品有声书": "7592679474223649318",
  "清晰语录": "7592679757255283250",
  "桃花庵主": "7595496872207192627",
  "猪猪侠": "7595864865109971499",
  "灵动女声": "7595874585833116170",
  "苏感低音": "7595864590013960747",
  "乌萨七": "7595864815097090566",
  "唐僧": "7595864466315547142",
  "厚实男声": "7595864918235025961",
  "阳光美眉": "7595864529204941348",
  "和蔼奶奶": "7595874438051009050",
  "派星星": "7595861679376699931",
  "佩奇猪": "7595861557599277618",
  "萌娃百科": "7595860804197421594",
  "磁性男主播": "7595862660667675178",
  "清醒语录": "7595863083214443014",
  "甜美软妹": "7595864041617101353",
  "小八酱": "7595864734746808895",
  "如来": "7595860952910664219",
  "天津小哥": "7595861929160086062",
  "沉稳解说Pro": "7595864320450236969",
  "文静学姐": "7595864392411910710",
  "做作夹子音": "7595860655865860658",
  "暖心学姐": "7595863981525307945",
  "雄厚配音": "7595863434084749830",
  "猴哥": "7595861617552658970",
  "端庄女声": "7595863846460330550",
  "开朗学长": "7595864247540650539",
  "熊爸爸讲故事": "7595862889072693802",
  "皇上": "7595861870636962350",
  "奶萌男宝": "7595863496596656659",
  "调皮公主": "7595864107316679222",
  "温柔女声": "7595874500562915867",
  "流畅女声": "7595863207604916772",
  "活泼女孩": "7595874379712434715",
  "春日部姐姐": "7595860875005661747",
  "台湾腔甜妹": "7595862579407229467",
  "知性熟女": "7595863924013011498",
  "超萌小奶音": "7595863683868135999",
  "华妃": "7595859597395497523",
  "正义勇士": "7595859507083743771",
  "真人播客男": "7595863320662381099",
  "儿童绘本": "7595862828058153514",
  "活泼女声": "7595863379848204806",
  "搞怪鸭子嗓": "7595864981745177142",
  "少女心事": "7595864679474270774",
  "软萌童声": "7595863749165060649",
  "真人播客女": "7595863017200292406",
  "慵懒男声": "7595865041291711018",
  "黛玉": "7595861737924989478",
  "神厨老佛爷": "7595859998249325102",
  "蜡笔小妮": "7595860372582568486",
  "九小月": "7595861420424565257",
  "懒小羊": "7595861498145018394",
  "Vlog配音": "7595863622144758278",
  "情感语录": "7595860717295637001",
  "台湾男生": "7595861814085161523",
  "娇弱女": "7596773300513018395",
  "温柔软妹": "7597330727050416666",
  "含蓄女声": "7597330555054592521",
  "TVB女声Pro": "7597329815800123954",
  "低沉大叔": "7597329680416379419",
  "憨萌福娃": "7597330126698713609",
  "聪慧胖仔": "7597330240997691950",
  "爽快小哥": "7597329730446037550",
  "飒爽少侠": "7597329616751039026",
  "明媚女声": "7597330622431892014",
  "孤傲公子": "7597005810589241865",
  "冷酷女生": "7597006330401919515",
  "温婉女生": "7597005988335456818",
  "狐媚姐姐": "7597329385917518345",
  "优雅女声": "7597329485985223214",
  "纯净女声": "7597329938055696906",
  "成熟御姐": "7597329155633451558",
  "老实小哥": "7597005874686595594",
  "暖心哥哥": "7597005607765283378",
  "阳光小男孩": "7597330049687097866",
  "将门女将": "7597329213435154971",
  "邻居阿姨": "7597004797014708745",
  "成熟总裁": "7597006244389327411",
  "稳重男声": "7597005026761904690",
  "开朗男大": "7597005676115661321",
  "八戒Pro": "7597330350674547251",
  "清润女声": "7597004927570809390",
  "低音炮": "7597329882745410057",
  "甜软萌妹": "7597005101122720306",
  "正气女声": "7597009953852756490",
  "气质阿姨": "7597006172771586569",
  "清甜女声": "7597004609592234522",
  "深夜博客": "7597328904042320394",
  "蜡笔小新": "7597330401786335790",
  "严厉大叔": "7597004543045407241",
  "紫薇": "7597330495910711854",
  "豪放男子": "7597004865990038067",
  "傲娇霸总": "7597005746466722330",
  "英气飒姐": "7597328708042494473",
  "随性男声": "7597003746723238426",
  "糯音女孩": "7597330191790117427",
  "清冷女主": "7597006397452063270",
  "冷酷哥哥": "7597004070573838875",
  "妩媚熟女": "7597328596478202419",
  "权威精英男": "7597329550942409254",
  "严肃大叔": "7597004144729133614",
  "呆萌小男孩": "7597329321715307035",
  "威严老爷子": "7597328986699469338",
  "软糯少女音": "7597005358120309275",
  "妩媚女声": "7597005254638440987",
  "磁性嗓音": "7597004217466753545",
  "温和女声": "7597004476456636938",
  "硬朗大爷": "7597003695544341019",
  "霸气帝王": "7597003643388170762",
  "慈祥奶奶": "7597328834844693001",
  "清亮男声Pro": "7597005173025673755",
  "乖巧男孩": "7597004393837236774",
  "乖巧萌妹": "7597003375837712942",
  "爽朗学长": "7597004281639604774",
  "亲切伯伯": "7597004714751824422",
  "正直哥哥": "7597002981493445170",
  "动漫海绵": "7597330306718241290",
  "沉稳大叔": "7597003587289354761",
  "直爽女大": "7597003459665072686",
  "逗趣男声": "7597002881593512458",
  "慈祥爷爷": "7597005479771902515",
  "温柔叔叔": "7597005419134849587",
  "优柔公子": "7597003296930271790",
  "自信男声": "7597003523200389670",
  "灵动甜妹": "7597329046812234250",
  "奶萌少女": "7597004340745736750",
  "天真妹妹": "7597003244434362926",
};

// OpenAI / 豆包常用音色别名到即梦官方音色名称的兼容映射
const VOICE_ALIAS_MAP: Record<string, string> = {
  alloy: "苏感低音",
  ash: "沉稳大叔",
  ballad: "精品有声书",
  coral: "温柔女声",
  echo: "生动解说",
  fable: "精品有声书",
  nova: "灵动女声",
  onyx: "严肃大叔",
  sage: "知性熟女",
  shimmer: "清甜女声",
  verse: "磁性男主播",
  marin: "端庄女声",
  cedar: "稳重男声",
  zh_female_meilinvyou_saturn_bigtts: "精品有声书",
  zh_male_ruyayichen_saturn_bigtts: "生动解说",
  zh_female_santongyongns_saturn_bigtts: "流畅女声",
  zh_male_shaonianzixin_moon_bigtts: "阳光少年",
  zh_female_shuangkuaisisi_moon_bigtts: "灵动女声",
  zh_male_qingcang_mars_bigtts: "苏感低音",
  zh_female_yueyunv_mars_bigtts: "TVB女声Pro",
};

const TTS_CONFIG = {
  maxDuration: 300,
  minDuration: 1,
  defaultDuration: 5,
  defaultVoice: "苏感低音",
};

const UNIFIED_EDIT_CONFIG = {
  maxAudio: 3,
  maxDuration: 300,
  minDuration: 1,
};

interface ResolvedVoice {
  id: string;
  name: string;
  itemPlatform: number; // 4 = Dmop 官方音色, 2 = Local 用户克隆音色
}

// Persist account identity, never raw cookies or API keys.
const taskBindings = new AudioTaskBindings(process.env.DB_PATH || './data/jimeng.db');

export function rememberAudioTaskCredential(
  ids: Array<string | undefined | null>,
  credential: ResolvedCredential
) {
  taskBindings.remember(ids, credential);
}

export async function resolveAudioTaskCredential(
  taskId: string,
  authorization?: string
): Promise<ResolvedCredential> {
  const credential = taskBindings.resolve(taskId, tokenSplit(authorization || ''),
    key => db.validateApiKey(key).valid, readTaskAccount);
  return credential.poolTaskId ? resolvePoolTaskCredential(credential.poolTaskId, authorization || '') : credential;
}

/**
 * 解析音色名称或音色 ID 为即梦 TTS 所需的 { id, name, itemPlatform }
 */
export async function resolveVoiceInfo(
  voiceInput: string | undefined,
  refreshToken: string,
  cookie?: string
): Promise<ResolvedVoice> {
  const raw = String(voiceInput || "").trim() || TTS_CONFIG.defaultVoice;
  const mappedName = VOICE_ALIAS_MAP[raw] || VOICE_ALIAS_MAP[raw.toLowerCase()] || raw;

  // 1. 直接匹配内置官方音色名
  if (OFFICIAL_VOICE_ID_MAP[mappedName]) {
    return {
      id: OFFICIAL_VOICE_ID_MAP[mappedName],
      name: mappedName,
      itemPlatform: 4,
    };
  }

  // 2. 直接传了内置官方音色数字 ID
  for (const [title, id] of Object.entries(OFFICIAL_VOICE_ID_MAP)) {
    if (id === mappedName) {
      return {
        id,
        name: title,
        itemPlatform: 4,
      };
    }
  }

  // 3. 兼容豆包 zh_female_* / zh_male_* 前缀音色
  if (/^zh_(female|male)_/i.test(raw)) {
    const isFemale = /^zh_female_/i.test(raw);
    const fallbackTitle = isFemale ? "精品有声书" : "苏感低音";
    return {
      id: OFFICIAL_VOICE_ID_MAP[fallbackTitle],
      name: fallbackTitle,
      itemPlatform: 4,
    };
  }

  // 4. 尝试从用户本地克隆音色列表查询 (item_platform = 2)
  try {
    const localRes = await request(
      "POST",
      "/mweb/v1/get_user_local_item_list",
      refreshToken,
      {
        cookie,
        data: {
          offset: 0,
          count: 50,
          effect_type: 218,
          filter_opt: { clone_voice_status: [1, 2] },
          pack_local_item_opt: { need_favorite_info: true },
        },
      }
    );
    const localItems: any[] = localRes?.item_list || [];
    const matchedLocal = localItems.find(
      (item) =>
        item?.common_attr?.title === raw ||
        String(item?.common_attr?.id) === raw ||
        String(item?.common_attr?.effect_id) === raw
    );
    if (matchedLocal?.common_attr?.id) {
      return {
        id: String(matchedLocal.common_attr.id),
        name: matchedLocal.common_attr.title || raw,
        itemPlatform: 2,
      };
    }
  } catch (err: any) {
    logger.warn("查询用户自定义音色失败");
  }

  throw new APIException(
    EX.API_REQUEST_PARAMS_INVALID,
    `不支持的音色：${raw}，常用音色：苏感低音、精品有声书、严肃大叔、生动解说、温柔女声`
  );
}

/**
 * 将本地文件路径、内网/本地 URL、base64 或公网 HTTPS URL 统一上传为即梦参考音频素材 vid
 */
async function uploadAudioMaterial(
  source: string,
  refreshToken: string,
  cookie?: string
): Promise<{ vid: string; durationMs: number }> {
  const trimmed = String(source || "").trim();
  if (!trimmed) {
    throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "参考音频地址不能为空");
  }

  // 已经是即梦 vid (例如 v0d870g10004...)
  if (/^v0[0-9a-z]{20,}$/i.test(trimmed)) {
    const context = currentPoolTask();
    const proof = context?.assets?.get(trimmed);
    if (context?.taskId && !proof) throw new Error("参考素材缺少当前调用方及账号的上传归属证明");
    return { vid: trimmed, durationMs: proof?.durationMs || 5000 };
  }

  let normalizedSource = trimmed;

  if (trimmed.startsWith("data:audio/") || trimmed.startsWith("data:video/")) {
    normalizedSource = trimmed;
  } else if (/^https?:\/\//i.test(trimmed)) {
    const parsedUrl = new URL(trimmed);
    const isLocalOrHttp =
      parsedUrl.protocol !== "https:" ||
      parsedUrl.hostname === "localhost" ||
      parsedUrl.hostname === "127.0.0.1" ||
      parsedUrl.hostname.endsWith(".local") ||
      Boolean(parsedUrl.port);
    if (isLocalOrHttp) {
      const resp = await axios.get(trimmed, {
        responseType: "arraybuffer",
        timeout: 60000,
        proxy: false,
      });
      const base64 = Buffer.from(resp.data).toString("base64");
      normalizedSource = `data:audio/mpeg;base64,${base64}`;
    }
  } else if (await fs.pathExists(path.resolve(trimmed))) {
    const bytes = await fs.readFile(path.resolve(trimmed));
    normalizedSource = `data:audio/mpeg;base64,${bytes.toString("base64")}`;
  } else if (/^[A-Za-z0-9+/=]{64,}$/.test(trimmed)) {
    normalizedSource = `data:audio/mpeg;base64,${trimmed}`;
  }

  const uploaded = await uploadVideoReference(
    normalizedSource,
    refreshToken,
    "audio",
    cookie
  );
  return {
    vid: uploaded.vid,
    durationMs: uploaded.durationMs || 5000,
  };
}

/**
 * 构建全能配音 (unified_edit) 的 meta_list
 * 支持显式 @音频1 / @Audio1 槽位标记，或按行/顺序自动交错文本与参考音频
 */
export function buildUnifiedEditMetaList(
  prompt: string,
  audioCount: number
): any[] {
  const metaList: any[] = [];
  if (audioCount <= 0) {
    metaList.push({
      type: "",
      id: util.uuid(),
      meta_type: "text",
      text: prompt.trim(),
    });
    return metaList;
  }

  const markerRegex = /@(?:音频|audio|Audio)\s*(\d+)|音频\s*(\d+)/g;
  const usedIndices = new Set<number>();
  let lastIndex = 0;
  let hasExplicitMarker = false;
  let match: RegExpExecArray | null;

  while ((match = markerRegex.exec(prompt)) !== null) {
    const rawNum = Number(match[1] || match[2]);
    if (!Number.isInteger(rawNum) || rawNum < 1 || rawNum > audioCount) {
      continue;
    }
    hasExplicitMarker = true;
    const beforeText = prompt.slice(lastIndex, match.index);
    if (beforeText) {
      metaList.push({
        type: "",
        id: util.uuid(),
        meta_type: "text",
        text: beforeText,
      });
    }
    const materialIdx = rawNum - 1;
    usedIndices.add(materialIdx);
    metaList.push({
      type: "",
      id: util.uuid(),
      meta_type: "audio",
      text: "",
      material_ref: {
        type: "",
        id: util.uuid(),
        material_idx: materialIdx,
      },
    });
    lastIndex = match.index + match[0].length;
  }

  if (hasExplicitMarker) {
    const tailText = prompt.slice(lastIndex);
    if (tailText) {
      metaList.push({
        type: "",
        id: util.uuid(),
        meta_type: "text",
        text: tailText,
      });
    }
    // 补齐未显式提及但已上传的参考音频
    for (let idx = 0; idx < audioCount; idx++) {
      if (!usedIndices.has(idx)) {
        metaList.push({
          type: "",
          id: util.uuid(),
          meta_type: "audio",
          text: "",
          material_ref: {
            type: "",
            id: util.uuid(),
            material_idx: idx,
          },
        });
      }
    }
    return metaList;
  }

  // 无显式 @音频N 标记时，按段落与参考音频交错编排
  const promptParts = prompt
    .split(/[\n\r]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const audioPerPart = Math.max(
    1,
    Math.floor(audioCount / (promptParts.length || 1))
  );
  let audioIdx = 0;

  for (let i = 0; i < promptParts.length; i++) {
    metaList.push({
      type: "",
      id: util.uuid(),
      meta_type: "text",
      text: promptParts[i],
    });
    if (
      audioIdx < audioCount &&
      (i % audioPerPart === 0 || i === promptParts.length - 1)
    ) {
      metaList.push({
        type: "",
        id: util.uuid(),
        meta_type: "audio",
        text: "",
        material_ref: {
          type: "",
          id: util.uuid(),
          material_idx: audioIdx,
        },
      });
      audioIdx++;
    }
  }

  while (audioIdx < audioCount) {
    metaList.push({
      type: "",
      id: util.uuid(),
      meta_type: "audio",
      text: "",
      material_ref: {
        type: "",
        id: util.uuid(),
        material_idx: audioIdx,
      },
    });
    audioIdx++;
  }

  return metaList;
}

export function extractAudioUrlFromItemList(itemList: any[] = []): string | null {
  for (const item of itemList) {
    const url =
      item?.audio?.origin_audio?.audio_url ||
      item?.audio?.origin_audio?.url ||
      item?.common_attr?.file?.file_url ||
      item?.common_attr?.item_urls?.find((u: any) => typeof u === "string" && u.trim()) ||
      item?.audio?.audio_url ||
      item?.audio?.url;
    if (typeof url === "string" && url.trim()) {
      return url.trim();
    }
  }
  return null;
}

export async function generateAudio(
  {
    prompt,
    model = "jimeng-audio-seedaudio-1.0",
    mode,
    voice_name = TTS_CONFIG.defaultVoice,
    duration = TTS_CONFIG.defaultDuration,
    speech_rate = 0,
    pitch_rate = 0,
    format = "mp3",
    sample_rate = 24000,
    audioPaths = [],
  }: {
    prompt: string;
    model?: string;
    mode?: "tts" | "unified_edit";
    voice_name?: string;
    duration?: number;
    speech_rate?: number;
    pitch_rate?: number;
    format?: string;
    sample_rate?: number;
    audioPaths?: string[];
  },
  refreshToken: string,
  cookie?: string
): Promise<any> {
  if (!prompt || !prompt.trim()) {
    throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "提示词不能为空");
  }

  const effectiveMode: "tts" | "unified_edit" =
    mode || (audioPaths.length > 0 ? "unified_edit" : "tts");

  if (effectiveMode === "unified_edit" && audioPaths.length === 0) {
    throw new APIException(
      EX.API_REQUEST_PARAMS_INVALID,
      "全能配音需要连接参考音频；请检查音频是否已连接，或切换为文本朗读"
    );
  }

  if (
    effectiveMode === "unified_edit" &&
    audioPaths.length > UNIFIED_EDIT_CONFIG.maxAudio
  ) {
    throw new APIException(
      EX.API_REQUEST_PARAMS_INVALID,
      `全能配音最多上传 ${UNIFIED_EDIT_CONFIG.maxAudio} 个音频素材`
    );
  }

  const normalizedDuration = Number(duration ?? TTS_CONFIG.defaultDuration);
  if (
    !Number.isFinite(normalizedDuration) ||
    normalizedDuration < TTS_CONFIG.minDuration ||
    normalizedDuration > TTS_CONFIG.maxDuration
  ) {
    throw new APIException(
      EX.API_REQUEST_PARAMS_INVALID,
      `时长必须在 ${TTS_CONFIG.minDuration}~${TTS_CONFIG.maxDuration} 秒之间`
    );
  }

  let resolvedVoice: ResolvedVoice | undefined;
  if (effectiveMode === "tts") {
    resolvedVoice = await resolveVoiceInfo(voice_name, refreshToken, cookie);
  }

  // 检查积分，不足时尝试领取每日免费积分
  const { totalCredit } = await getCredit(refreshToken, cookie);
  if (totalCredit <= 0) {
    await receiveCredit(refreshToken, cookie);
  }

  const modelReqKey = getAudioModel(model);
  logger.info(
    `🎙️ 开始生成音频：模型=${model}(${modelReqKey})，模式=${effectiveMode}，音色=${resolvedVoice?.name || "unified_edit"}，参考音频=${audioPaths.length}个`
  );

  const materialList: any[] = [];
  if (effectiveMode === "unified_edit") {
    for (const audioSource of audioPaths) {
      const uploaded = await uploadAudioMaterial(
        audioSource,
        refreshToken,
        cookie
      );
      materialList.push({
        type: "",
        id: util.uuid(),
        material_type: "audio",
        audio_info: {
          type: "audio",
          id: util.uuid(),
          source_from: "upload",
          name: "",
          vid: uploaded.vid,
          duration: uploaded.durationMs,
        },
      });
    }
  }

  const textToSpeech: Record<string, any> = {
    type: "",
    id: util.uuid(),
    min_version: DRAFT_VERSION,
    text: effectiveMode === "tts" ? prompt.trim() : "",
    voice_name: effectiveMode === "tts" ? resolvedVoice!.name : "",
    mode: effectiveMode,
    model_req_key: modelReqKey,
  };

  if (effectiveMode === "tts" && resolvedVoice) {
    textToSpeech.id_info = {
      id: resolvedVoice.id,
      item_platform: resolvedVoice.itemPlatform,
    };
    textToSpeech.audio_config = {
      type: "",
      id: util.uuid(),
      format: format || "mp3",
      sample_rate: Number(sample_rate) || 24000,
      speech_rate: Number(speech_rate) || 0,
      pitch_rate: Number(pitch_rate) || 0,
    };
  } else if (effectiveMode === "unified_edit") {
    const metaList = buildUnifiedEditMetaList(prompt, materialList.length);
    textToSpeech.unified_edit_input = {
      type: "",
      id: util.uuid(),
      material_list: materialList,
      meta_list: metaList,
    };
  }

  const componentId = util.uuid();
  const submitId = util.uuid();

  const draftContent = {
    type: "draft",
    id: util.uuid(),
    min_version: DRAFT_VERSION,
    min_features: [],
    is_from_tsn: true,
    version: DRAFT_VERSION,
    main_component_id: componentId,
    component_list: [
      {
        type: "audio_base_component",
        id: componentId,
        min_version: "3.2.3",
        min_features: [],
        aigc_mode: "workbench",
        gen_type: 44,
        metadata: {
          type: "",
          id: util.uuid(),
          created_platform: 3,
          created_platform_version: "",
          created_time_in_ms: new Date().toISOString(),
          created_did: "",
        },
        generate_type: "generate_tts",
        abilities: {
          type: "",
          id: util.uuid(),
          text_to_speech: textToSpeech,
        },
      },
    ],
  };

  const requestBody = {
    extend: {
      m_video_commerce_info_list: [
        {
          amount: 1,
          benefit_type: "dreamina_seed_audio",
          resource_id: "generate_audio",
          resource_id_type: "str",
          resource_sub_type: "aigc",
        },
      ],
      root_model: modelReqKey,
    },
    submit_id: submitId,
    metrics_extra: JSON.stringify({
      isAiLyric: false,
      lyricCnt: 0,
      isRandomInspiration: false,
      promptSource: "custom",
      enterFrom: "click",
      position: "page_bottom_box",
      sceneOptions: JSON.stringify([
        {
          type: "audio",
          scene: "AudioTTSGenerate",
          audioDuration: normalizedDuration,
          modelReqKey,
          benefitAmount: 1,
          reportParams: {
            cashierBusinessExtra: {},
          },
        },
      ]),
      isRegenerate: false,
    }),
    draft_content: JSON.stringify(draftContent),
    http_common_info: {
      aid: DEFAULT_ASSISTANT_ID,
    },
  };

  const response = await request(
    "POST",
    "/mweb/v1/aigc_draft/generate",
    refreshToken,
    {
      cookie,
      data: requestBody,
      params: {
        aid: DEFAULT_ASSISTANT_ID,
        device_platform: "web",
        region: "cn",
        da_version: DRAFT_VERSION,
        web_version: WEB_VERSION,
        aigc_features: "app_lip_sync",
        web_component_open_flag: 1,
      },
    }
  );

  const aigcData = response?.aigc_data;
  if (aigcData) {
    const taskId = aigcData.history_record_id || aigcData.task?.task_id;
    logger.info(
      `🎙️ 音频生成任务已创建：taskId=${taskId}, submitId=${aigcData.submit_id || submitId}`
    );
    return aigcData;
  }

  throw new APIException(
    EX.API_REQUEST_FAILED,
    `音频生成请求失败：${response?.errmsg || response?.fail_starling_message || "未知错误"}`
  );
}

/**
 * 查询音频生成任务状态（通过真实确认的 /mweb/v1/get_history_by_ids 接口）
 */
export async function queryAudioStatus(
  taskId: string,
  refreshToken: string,
  cookie?: string
): Promise<{
  task_id: string;
  submit_id?: string;
  status: number;
  state: "processing" | "succeeded" | "failed" | "unknown";
  complete: boolean;
  audio_url: string | null;
  duration?: number;
  fail_code?: string;
  fail_message?: string;
  raw?: any;
}> {
  const cleanId = String(taskId || "").trim();
  if (!cleanId) {
    throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "taskId 不能为空");
  }

  const isSubmitUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(cleanId);
  const result = await request(
    "POST",
    "/mweb/v1/get_history_by_ids",
    refreshToken,
    {
      cookie,
      data: isSubmitUuid
        ? { submit_ids: [cleanId] }
        : { history_ids: [cleanId] },
      params: {
        aid: DEFAULT_ASSISTANT_ID,
        device_platform: "web",
        region: "cn",
        da_version: DRAFT_VERSION,
        web_version: WEB_VERSION,
      },
      timeout: 15000,
      maxRetries: 1,
    }
  );

  const record =
    videoHistoryRecord(result, cleanId) ||
    Object.values(result || {}).find(
      (item: any) => item && typeof item === "object" && "status" in item
    );
  if (!record || typeof record !== "object") {
    throw new APIException(
      EX.API_REQUEST_FAILED,
      `未找到音频任务记录：${cleanId}`
    );
  }

  const rawStatus = record.status;
  const status = rawStatus === undefined || rawStatus === null ? NaN : Number(rawStatus);
  const itemList = Array.isArray(record.item_list) ? record.item_list : [];
  const isProcessing = AUDIO_PROCESSING_STATES.includes(status);
  const isFailed = status === AUDIO_FAIL_STATE;
  const isVerifiedSuccess = AUDIO_SUCCESS_STATES.includes(status);
  const audioUrl = isVerifiedSuccess ? extractAudioUrlFromItemList(itemList) : null;
  const isComplete = isVerifiedSuccess && Boolean(audioUrl);
  const state: "processing" | "succeeded" | "failed" | "unknown" =
    isFailed ? "failed"
    : isComplete ? "succeeded"
    : isProcessing ? "processing"
    : "unknown";

  const failCode = record.fail_code || "";
  const failMessage =
    record.fail_starling_message ||
    record.fail_msg ||
    record.failed_item_list?.[0]?.gen_result_data?.result_msg ||
    "";

  const durationSec =
    itemList?.[0]?.audio?.origin_audio?.duration ??
    (itemList?.[0]?.audio?.origin_audio?.duration_ms
      ? Math.round(itemList[0].audio.origin_audio.duration_ms / 1000)
      : undefined);

  return {
    task_id: String(record.history_record_id || record.task?.task_id || cleanId),
    submit_id: record.submit_id || record.task?.submit_id,
    status,
    state,
    complete: isComplete,
    audio_url: audioUrl,
    duration: durationSec,
    fail_code: failCode || undefined,
    fail_message: failMessage || undefined,
    raw: record,
  };
}

/**
 * 轮询等待音频任务完成并返回最终状态
 */
export async function waitForAudioCompletion(
  taskId: string,
  refreshToken: string,
  cookie?: string,
  options: { maxRetries?: number; intervalMs?: number; deadlineMs?: number } = {}
) {
  const maxRetries = options.maxRetries ?? 60;
  const intervalMs = options.intervalMs ?? 2500;
  const deadlineMs = options.deadlineMs ?? Number(process.env.JIMENG_AUDIO_WAIT_TIMEOUT_MS || 180000);
  const startedAt = Date.now();

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (Date.now() - startedAt >= deadlineMs) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (Date.now() - startedAt >= deadlineMs) break;
    const statusInfo = await queryAudioStatus(taskId, refreshToken, cookie);
    if (statusInfo.state === "failed") {
      throw new APIException(
        EX.API_REQUEST_FAILED,
        `音频生成失败: ${statusInfo.fail_message || statusInfo.fail_code || "上游生成失败"}`
      );
    }
    if (statusInfo.state === "unknown") {
      throw new APIException(
        EX.API_REQUEST_FAILED,
        `音频生成状态未确认（status=${Number.isFinite(statusInfo.status) ? statusInfo.status : "unknown"}），未提取结果`
      );
    }
    if (statusInfo.complete && statusInfo.audio_url) {
      return statusInfo;
    }
  }

  throw new APIException(
    EX.API_REQUEST_FAILED,
    `音频生成等待超时（task_id=${taskId}），可稍后在即梦历史中确认结果`
  );
}
