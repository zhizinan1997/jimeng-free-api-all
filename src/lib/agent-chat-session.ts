import { AgentTextAccumulator, parseAgentSSE, type AgentSSEFrame } from "./agent-chat-sse.ts";

export type AgentStreamSource = AsyncIterable<Uint8Array | string>;
export interface AgentTransport {
  /** Both methods must use the same selected account and workspace. No retries. */
  subscribe(signal: AbortSignal): Promise<AgentStreamSource>;
  submit(signal: AbortSignal): Promise<AgentStreamSource>;
}

type AgentSessionErrorCode = "timeout" | "cancelled" | "subscription_failed" | "submission_failed" | "empty_reply";
export class AgentSessionError extends Error {
  readonly code: AgentSessionErrorCode;
  constructor(code: AgentSessionErrorCode) {
    super({
      timeout: "即梦文字对话等待超时，未自动重提任务",
      cancelled: "即梦文字对话已取消",
      subscription_failed: "即梦文字回复订阅失败",
      submission_failed: "即梦文字对话提交失败",
      empty_reply: "即梦任务结束但未返回文字回答",
    }[code]);
    this.code = code;
    this.name = "AgentSessionError";
  }
}

type SessionOptions = {
  conversationId: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onText?: (text: string) => void;
  onSubmitted?: () => void;
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function subscriptionFailed(frame: AgentSSEFrame): boolean {
  const data = object(frame.data);
  const metadata = object(data?.metadata);
  // Named conversation failures belong to the accumulator. Unbound errors
  // describe this subscription, not another conversation in the workspace.
  if (data?.conversation_id != null || metadata?.conversation_id != null) return false;
  return frame.event === "error" || (frame.event === "system" && (
    data?.type === "error" || data?.type === "stream_error" || data?.success === false
    || (data?.error_code != null && data.error_code !== "" && String(data.error_code) !== "0")
  ));
}

/**
 * The conversation endpoint only acknowledges submission. The answer is on a
 * separate workspace subscription. Neither HTTP 200 nor submission EOF is a
 * completed answer. Closing/timeout aborts both requests without resubmitting.
 */
export async function runAgentTextSession(transport: AgentTransport, options: SessionOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("Invalid Agent timeout");
  const accumulator = new AgentTextAccumulator(options.conversationId);
  const controller = new AbortController();
  const closeSources = new Set<() => void>();
  const trackSource = (source: AgentStreamSource): AgentStreamSource => {
    const iterator = source[Symbol.asyncIterator]();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      closeSources.delete(close);
      const stream = source as AgentStreamSource & { destroy?: () => unknown };
      if (typeof stream.destroy === "function") stream.destroy();
      else if (iterator.return) {
        // A generic iterator may wait for pending next(). Do not let cleanup
        // delay a timeout, or turn a secondary close failure into an unhandled rejection.
        void Promise.resolve(iterator.return()).catch(() => {});
      }
    };
    closeSources.add(close);
    // A transport can resolve after the session timeout; close that late source too.
    if (controller.signal.aborted) close();
    controller.signal.throwIfAborted();
    return { [Symbol.asyncIterator]: () => iterator };
  };
  let readyResolve!: () => void;
  let readyReject!: (reason: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // Attach immediately: subscription can fail before submit is started.
  void ready.catch(() => {});
  let cancelReject!: (reason: unknown) => void;
  const cancelled = new Promise<never>((_, reject) => { cancelReject = reject; });
  void cancelled.catch(() => {});
  const abort = (code: "timeout" | "cancelled") => {
    const error = new AgentSessionError(code);
    controller.abort(error);
    readyReject(error);
    cancelReject(error);
  };
  const onAbort = () => abort(options.signal?.reason instanceof AgentSessionError && options.signal.reason.code === "timeout" ? "timeout" : "cancelled");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timer = setTimeout(() => abort("timeout"), timeoutMs);

  const receive = async () => {
    let subscribed = false;
    try {
      controller.signal.throwIfAborted();
      const source = trackSource(await transport.subscribe(controller.signal));
      for await (const frame of parseAgentSSE(source)) {
        controller.signal.throwIfAborted();
        const data = object(frame.data);
        if (subscriptionFailed(frame)) throw new AgentSessionError("subscription_failed");
        if (!subscribed) {
          if (frame.event === "system" && data?.type === "subscribe_handshake") {
            if (typeof data.session_id !== "string" || !data.session_id) throw new AgentSessionError("subscription_failed");
            subscribed = true;
            readyResolve();
          } else if (frame.event === "error" || data?.success === false) {
            throw new AgentSessionError("subscription_failed");
          }
          continue;
        }
        const update = accumulator.accept(frame);
        if (update.deltaText) options.onText?.(update.deltaText);
        controller.signal.throwIfAborted();
        if (update.done) return accumulator.finish();
      }
      controller.signal.throwIfAborted();
      if (!subscribed) throw new AgentSessionError("subscription_failed");
      return accumulator.finish();
    } catch (error) {
      readyReject(error);
      throw error;
    }
  };
  const submit = async () => {
    await ready;
    controller.signal.throwIfAborted();
    let handshake = false;
    const source = trackSource(await transport.submit(controller.signal));
    for await (const frame of parseAgentSSE(source)) {
      controller.signal.throwIfAborted();
      const data = object(frame.data);
      if (frame.event === "error" || data?.success === false
        || (data?.error_code !== undefined && String(data.error_code) !== "0")) {
        throw new AgentSessionError("submission_failed");
      }
      if (frame.event === "handshake") {
        if (data?.conversation_id !== options.conversationId) throw new AgentSessionError("submission_failed");
        if (!handshake) options.onSubmitted?.();
        handshake = true;
      }
      if (frame.event === "stream_complete") {
        if (!handshake || data?.success !== true) throw new AgentSessionError("submission_failed");
        return;
      }
    }
    controller.signal.throwIfAborted();
    throw new AgentSessionError("submission_failed");
  };

  try {
    const [text] = await Promise.race([Promise.all([receive(), submit()]), cancelled]);
    if (!text.trim()) throw new AgentSessionError("empty_reply");
    return text;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    controller.abort();
    for (const close of closeSources) close();
  }
}
