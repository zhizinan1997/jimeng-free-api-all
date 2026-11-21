import { textChatIdentityInstructions } from "./text-chat-identity.ts";

export const TEXT_MODEL_ID = "glm-5.3-flash";
export const TEXT_MODEL_REQ_KEY = "glm_5_3_flash";

/** 已从官网模型配置和实际提交结构核实的文字模型；别名只接受明确登记值。 */
export const TEXT_MODELS = [
  { id: "glm-5.3", name: "GLM 5.3", modelReqKey: "glm_5_3" },
  { id: "deepseek-v4-pro", name: "Deepseek V4 Pro", modelReqKey: "ali_deepseek_v4_pro" },
  { id: "qwen-3.8-max", name: "Qwen 3.8 Max", modelReqKey: "qwen_3_8_max" },
  { id: "doubao-2.1-lite", name: "Doubao 2.1 Lite", modelReqKey: "default_matrix" },
  { id: "doubao-2.1-pro", name: "Doubao 2.1 Pro", modelReqKey: "doubao_v21_turbo_pro" },
  { id: TEXT_MODEL_ID, name: "GLM 5.3 Flash", modelReqKey: TEXT_MODEL_REQ_KEY },
] as const;

export type TextModelId = typeof TEXT_MODELS[number]["id"];

export function resolveTextChatModel(value: unknown) {
  return TEXT_MODELS.find(model => value === model.id || value === model.modelReqKey || value === model.name);
}

export interface TextChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface TextChatRequest {
  model: TextModelId;
  messages: TextChatMessage[];
  stream: boolean;
  ignoredParameters?: string[];
}

export class TextChatRequestError extends Error {
  readonly code = "invalid_text_chat_request";
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "TextChatRequestError";
  }
}

export function isTextModel(value: unknown): boolean {
  return Boolean(resolveTextChatModel(value));
}

/** Route known text-model families to strict validation, never media fallback. */
export function isAgentTextModel(value: unknown): boolean {
  return isTextModel(value) || (typeof value === "string"
    && /^(?:jimeng-)?(?:glm|doubao|(?:ali[_-])?deepseek|qwen|default_matrix)/i.test(value.trim()));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeContent(content: unknown): string {
  if (typeof content === "string") {
    if (!content.trim()) throw new TextChatRequestError("文字消息内容不能为空");
    return content;
  }
  if (!Array.isArray(content) || content.length === 0) {
    throw new TextChatRequestError("消息内容必须是纯文字或非空 text 内容数组");
  }
  const parts = Array.from(content, (part) => {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string"
      || Object.keys(part).some((key) => key !== "type" && key !== "text")) {
      throw new TextChatRequestError("内容数组仅支持 type 为 text 的纯文字，不支持图片、音视频或其他字段");
    }
    return part.text;
  });
  const text = parts.join("\n");
  if (!text.trim()) throw new TextChatRequestError("文字消息内容不能为空");
  return text;
}

/** 校验文字消息历史及客户端默认参数。 */
export function normalizeTextChatRequest(body: unknown): TextChatRequest {
  if (!isRecord(body)) throw new TextChatRequestError("文字对话请求必须是 JSON 对象");
  const allowedFields = new Set(["model", "messages", "stream", "max_tokens", "stream_options", "thinking"]);
  if (Object.keys(body).some(key => !allowedFields.has(key))) {
    throw new TextChatRequestError("文字对话包含不支持的参数，请查阅文字接口兼容说明");
  }
  const ignoredParameters: string[] = [];
  if (Object.prototype.hasOwnProperty.call(body, "max_tokens")) {
    if (!Number.isSafeInteger(body.max_tokens) || (body.max_tokens as number) <= 0) {
      throw new TextChatRequestError("max_tokens 必须为正安全整数；上游不提供该参数控制");
    }
    ignoredParameters.push("max_tokens");
  }
  if (Object.prototype.hasOwnProperty.call(body, "thinking")) {
    const thinking = body.thinking;
    if (!isRecord(thinking) || Object.keys(thinking).length !== 1
      || (thinking.type !== "enabled" && thinking.type !== "disabled")) {
      throw new TextChatRequestError("thinking 仅兼容 type 为 enabled 或 disabled；上游使用自身推理策略");
    }
    ignoredParameters.push("thinking");
  }
  if (Object.prototype.hasOwnProperty.call(body, "stream_options")) {
    const options = body.stream_options;
    if (!isRecord(options) || Object.keys(options).some(key => key !== "include_usage")
      || (Object.prototype.hasOwnProperty.call(options, "include_usage") && typeof options.include_usage !== "boolean")) {
      throw new TextChatRequestError("stream_options 仅兼容布尔值 include_usage");
    }
    if (options.include_usage === true) ignoredParameters.push("stream_options.include_usage");
  }
  const model = resolveTextChatModel(body.model);
  if (!model) {
    throw new TextChatRequestError("不支持的文字模型，请使用 /v1/models?type=text 返回的模型");
  }
  if (Object.prototype.hasOwnProperty.call(body, "stream") && typeof body.stream !== "boolean") {
    throw new TextChatRequestError("stream 必须是布尔值");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 128) {
    throw new TextChatRequestError("文字对话要求 1～128 条纯文字消息");
  }
  const messages: TextChatMessage[] = Array.from(body.messages, (message) => {
    if (!isRecord(message)) throw new TextChatRequestError("每条消息必须是 JSON 对象");
    if (Object.keys(message).some((key) => key !== "role" && key !== "content")) {
      throw new TextChatRequestError("文字消息仅支持 role、content，不支持工具、附件或其他字段");
    }
    const role = message.role;
    if (role !== "user" && role !== "assistant") {
      throw new TextChatRequestError("文字历史仅支持 user、assistant；暂不支持 system、developer 或工具消息");
    }
    return { role, content: normalizeContent(message.content) };
  });
  if (messages[0].role !== "user" || messages[messages.length - 1].role !== "user") {
    throw new TextChatRequestError("文字历史必须以 user 开始并以本轮 user 消息结束");
  }
  if (messages.reduce((length, message) => length + message.content.length, 0) > 256_000) {
    throw new TextChatRequestError("文字历史总长度不能超过 256000 个 UTF-16 代码单元；不会静默截断历史");
  }
  return { model: model.id, messages, stream: body.stream === true,
    ...(ignoredParameters.length ? { ignoredParameters } : {}) };
}

/** 每次请求都附带当前模型身份与能力约束，历史完整编码，不伪造原生会话续接。 */
export function buildAgentTextPrompt(messages: TextChatMessage[], modelId: TextModelId): string {
  const model = resolveTextChatModel(modelId);
  if (!model) throw new TextChatRequestError("不支持的文字模型，请使用 /v1/models?type=text 返回的模型");
  return textChatIdentityInstructions(model) + "\n" + JSON.stringify(messages);
}

export function textChatCompatibilityHeaders(input: TextChatRequest): Record<string, string> {
  return {
    ...(input.messages.length > 1 ? { "X-Jimeng-Context-Mode": "role-labelled-history" } : {}),
    ...(input.ignoredParameters?.length ? { "X-Jimeng-Ignored-Parameters": input.ignoredParameters.join(", ") } : {}),
  };
}
