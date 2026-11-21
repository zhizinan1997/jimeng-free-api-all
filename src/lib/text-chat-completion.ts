import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { AgentSessionError } from "./agent-chat-session.ts";
import { AgentStreamError } from "./agent-chat-sse.ts";
import { TextChatRequestError, type TextChatRequest } from "./text-chat-request.ts";

export class TextChatUpstreamError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(stage: "workspace" | "subscription" | "submission" | "transport", detail = "invalid_response", statusCode = 502) {
    // Never accept upstream error text, signed URLs, or response bodies here.
    const safeDetail = /^(?:http_\d{3}|ret_-?\d{1,8}|invalid_response|invalid_content_type|response_too_large|network_error)$/.test(detail)
      ? detail : "invalid_response";
    super(`即梦文字对话 ${stage} 失败（${safeDetail}），未自动重提任务`);
    this.name = "TextChatUpstreamError";
    this.code = `${stage}_${safeDetail}`;
    this.statusCode = statusCode;
  }
}

export function publicTextChatError(error: unknown) {
  if (error instanceof TextChatRequestError || error instanceof TextChatUpstreamError) {
    return { status: error.statusCode, error: { message: error.message, type: "jimeng_text_chat_error", code: error.code } };
  }
  if (error instanceof AgentSessionError || error instanceof AgentStreamError) {
    return { status: error.code === "timeout" ? 504 : error.code === "cancelled" ? 499 : 502,
      error: { message: error.message, type: "jimeng_text_chat_error", code: error.code } };
  }
  return publicTextChatError(new TextChatUpstreamError("transport", "network_error"));
}

export type TextChatRunner = (options: { signal: AbortSignal; onText?: (text: string) => void }) => Promise<string>;
type Hooks = { signal?: AbortSignal; onSuccess?: (text: string) => void | Promise<void>; onFailure?: (error: unknown) => void | Promise<void>; onCancelled?: () => void | Promise<void> };

/** Translate the verified text session into OpenAI response envelopes, without invented token usage. */
export async function createTextChatCompletion(input: TextChatRequest, run: TextChatRunner, hooks: Hooks = {}) {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const controller = new AbortController();
  const abort = () => controller.abort();
  hooks.signal?.addEventListener("abort", abort, { once: true });
  if (hooks.signal?.aborted) abort();
  const cleanUp = () => { hooks.signal?.removeEventListener("abort", abort); controller.abort(); };
  const execute = async (onText?: (text: string) => void) => {
    try {
      if (controller.signal.aborted) throw new AgentSessionError("cancelled");
      const text = await run({ signal: controller.signal, onText });
      if (controller.signal.aborted) throw new AgentSessionError("cancelled");
      if (!text.trim()) throw new AgentSessionError("empty_reply");
      await hooks.onSuccess?.(text);
      return text;
    } catch (error) {
      if (controller.signal.aborted) await hooks.onCancelled?.();
      else await hooks.onFailure?.(error);
      throw error;
    } finally { cleanUp(); }
  };

  if (!input.stream) {
    const text = await execute();
    return { id, object: "chat.completion", created, model: input.model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] };
  }

  const output = new PassThrough();
  output.once("close", abort);
  const write = (value: unknown) => {
    if (!output.destroyed) output.write(`data: ${JSON.stringify(value)}\n\n`);
  };
  const chunk = (delta: object, finish_reason: string | null = null) => ({
    id, object: "chat.completion.chunk", created, model: input.model,
    choices: [{ index: 0, delta, finish_reason }],
  });
  write(chunk({ role: "assistant", content: "" }));
  void execute(text => write(chunk({ content: text }))).then(() => {
    write(chunk({}, "stop"));
    if (!output.destroyed) output.end("data: [DONE]\n\n");
  }).catch(error => {
    // A partial reply is not a successful completion. Do not emit finish_reason=stop.
    write({ error: publicTextChatError(error).error });
    if (!output.destroyed) output.end("data: [DONE]\n\n");
  }).finally(() => output.removeListener("close", abort));
  return output;
}
