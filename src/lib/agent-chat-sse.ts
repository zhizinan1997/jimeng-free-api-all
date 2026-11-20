import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";

export interface AgentSSEFrame {
  event: string;
  data: unknown;
}

export type AgentStreamErrorCode =
  | "invalid_utf8"
  | "invalid_json"
  | "event_too_large"
  | "upstream_failed"
  | "text_conflict"
  | "text_too_large"
  | "incomplete_stream";

const ERROR_MESSAGES: Record<AgentStreamErrorCode, string> = {
  invalid_utf8: "Agent stream contains invalid UTF-8",
  invalid_json: "Agent stream contains invalid JSON",
  event_too_large: "Agent stream event exceeds the size limit",
  upstream_failed: "Agent stream reported a failure",
  text_conflict: "Agent stream contains conflicting text snapshots",
  text_too_large: "Agent reply exceeds the local text size limit",
  incomplete_stream: "Agent stream ended before conversation completion",
};

/** Deliberately excludes upstream payloads, which can contain credentials. */
export class AgentStreamError extends Error {
  readonly code: AgentStreamErrorCode;

  constructor(code: AgentStreamErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "AgentStreamError";
    this.code = code;
  }
}

export interface AgentSSEOptions {
  /** Maximum UTF-8 bytes per SSE event, including fields and line endings. */
  maxEventBytes?: number;
}

/**
 * Parses JSON SSE without assuming transport chunk or UTF-8 boundaries.
 * A valid final event is flushed at EOF; EOF itself never means success.
 * Heartbeats are ignored. [DONE] yields { event: "done", data: null }.
 */
export async function* parseAgentSSE(
  source: AsyncIterable<Uint8Array | string>,
  options: AgentSSEOptions = {}
): AsyncGenerator<AgentSSEFrame> {
  const maxEventBytes = options.maxEventBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(maxEventBytes) || maxEventBytes < 1) {
    throw new RangeError("maxEventBytes must be a positive safe integer");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let event = "message";
  let dataLines: string[] = [];
  let line = "";
  let eventBytes = 0;
  let pendingCR = false;
  let pendingHighSurrogate = "";
  let stopped = false;

  const count = (text: string) => {
    eventBytes += Buffer.byteLength(text, "utf8");
    if (eventBytes > maxEventBytes) throw new AgentStreamError("event_too_large");
  };

  const dispatch = (): AgentSSEFrame | undefined => {
    const name = event;
    const lines = dataLines;
    event = "message";
    dataLines = [];
    eventBytes = 0;
    if (!lines.length || /^(?:ping|heartbeat|keep[-_]?alive)$/i.test(name)) return;
    const payload = lines.join("\n");
    if (payload.trim() === "[DONE]") {
      stopped = true;
      return { event: "done", data: null };
    }
    try {
      return { event: name, data: JSON.parse(payload) };
    } catch {
      throw new AgentStreamError("invalid_json");
    }
  };

  const finishLine = (): AgentSSEFrame | undefined => {
    const current = line;
    line = "";
    if (!current) return dispatch();
    if (current.startsWith(":")) return;
    const colon = current.indexOf(":");
    const field = colon < 0 ? current : current.slice(0, colon);
    let value = colon < 0 ? "" : current.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value || "message";
    else if (field === "data") dataLines.push(value);
  };

  function* consume(text: string): Generator<AgentSSEFrame> {
    if (!text) return;
    let start = 0;
    if (pendingCR) {
      pendingCR = false;
      if (text.startsWith("\n")) {
        count("\n");
        start = 1;
      }
      const frame = finishLine();
      if (frame) yield frame;
      if (stopped) return;
    }

    const endings = /\r\n|\r|\n/g;
    endings.lastIndex = start;
    let match: RegExpExecArray | null;
    while ((match = endings.exec(text))) {
      const segment = text.slice(start, match.index);
      count(segment);
      line += segment;
      count(match[0]);
      start = endings.lastIndex;
      if (match[0] === "\r" && start === text.length) {
        pendingCR = true;
        return;
      }
      const frame = finishLine();
      if (frame) yield frame;
      if (stopped) return;
    }
    const rest = text.slice(start);
    count(rest);
    line += rest;
  }

  const decode = (chunk?: Uint8Array, stream = false): string => {
    try {
      return decoder.decode(chunk, { stream });
    } catch {
      throw new AgentStreamError("invalid_utf8");
    }
  };

  for await (const chunk of source) {
    // Flush the byte decoder before a string chunk; a partial byte character
    // cannot safely be joined with an already-decoded string.
    let text = pendingHighSurrogate + (typeof chunk === "string"
      ? decode() + chunk
      : decode(chunk, true));
    pendingHighSurrogate = "";
    if (text.length && /[\uD800-\uDBFF]/.test(text[text.length - 1])) {
      pendingHighSurrogate = text.slice(-1);
      text = text.slice(0, -1);
    }
    yield* consume(text);
    if (stopped) return;
  }
  yield* consume(pendingHighSurrogate + decode());
  if (stopped) return;
  if (pendingCR) {
    const frame = finishLine();
    if (frame) yield frame;
  } else if (line) {
    const frame = finishLine();
    if (frame) yield frame;
  }
  if (!stopped) {
    const frame = dispatch();
    if (frame) yield frame;
  }
}

export interface AgentTextUpdate {
  /** Newly appended assistant text only; excludes reasoning and repeats. */
  deltaText: string;
  /** True only after an explicitly matching conversation stream_complete. */
  done: boolean;
}

type JsonObject = Record<string, unknown>;
type MessageText = { parts: Map<number, string> };

// Local resource protection, not an upstream model capability limit.
export const MAX_AGENT_TEXT_BYTES = 1024 * 1024;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function failedStatus(value: unknown): boolean {
  return typeof value === "string" && (
    /(^|_)(?:failed|failure|error|errored|aborted|cancelled|canceled)(_|$)/i.test(value)
    || value === "finished_unsuccessfully"
  );
}

/** Reduces the subscribe stream, never the separate submission handshake. */
export class AgentTextAccumulator {
  private readonly conversationId: string;
  private readonly messages = new Map<string, MessageText>();
  private accumulatedText = "";
  private accumulatedBytes = 0;
  private completed = false;
  private failure?: AgentStreamError;

  constructor(expectedConversationId: string) {
    if (!expectedConversationId?.trim()) throw new TypeError("A conversation ID is required");
    this.conversationId = expectedConversationId;
  }

  get text(): string { return this.accumulatedText; }
  get done(): boolean { return this.completed; }

  private reject(code: AgentStreamErrorCode): never {
    this.failure = new AgentStreamError(code);
    throw this.failure;
  }

  private snapshot(message: MessageText, index: number, next: string): string {
    const previous = message.parts.get(index) ?? "";
    if (previous.startsWith(next)) return ""; // Repeated or stale snapshot.
    if (!next.startsWith(previous)) this.reject("text_conflict");
    const delta = next.slice(previous.length);
    this.reserveText(delta);
    message.parts.set(index, next);
    return delta;
  }

  private reserveText(delta: string): void {
    const nextBytes = this.accumulatedBytes + Buffer.byteLength(delta, "utf8");
    if (nextBytes > MAX_AGENT_TEXT_BYTES) this.reject("text_too_large");
    this.accumulatedBytes = nextBytes;
  }

  accept(frame: AgentSSEFrame): AgentTextUpdate {
    if (this.failure) throw this.failure;
    const unchanged = (): AgentTextUpdate => ({ deltaText: "", done: this.completed });
    if (this.completed) return unchanged();
    const data = object(frame.data);
    if (!data) return unchanged();
    const metadata = object(data.metadata);
    const bindings = [data.conversation_id, metadata?.conversation_id]
      .filter((id) => id !== undefined && id !== null);
    if (bindings.some((id) => id !== this.conversationId)) return unchanged();
    const id = frame.event === "message" ? data.id : data.message_id;
    const messageId = typeof id === "string" && id ? id : undefined;
    const existing = messageId ? this.messages.get(messageId) : undefined;
    // A completion must name its conversation. Other message events can use
    // an ID already bound by a validated assistant message in this stream.
    if (!bindings.length && (!existing || frame.event === "system")) return unchanged();

    if (frame.event === "error" || failedStatus(data.status)
      || data.success === false
      || (data.error_code !== undefined && data.error_code !== null
        && data.error_code !== "" && String(data.error_code) !== "0")
      || (frame.event === "system" && ["error", "stream_error"].includes(String(data.type)))) {
      this.reject("upstream_failed");
    }

    if (frame.event === "system" && data.type === "stream_complete") {
      this.completed = true;
      return unchanged();
    }

    let deltaText = "";
    if (frame.event === "message") {
      const author = object(data.author);
      const content = object(data.content);
      if (!messageId) return unchanged();
      if (author?.role !== "assistant" || content?.content_type !== "text"
        || metadata?.is_visually_hidden_from_conversation === true) {
        this.messages.delete(messageId);
        return unchanged();
      }
      const message = existing ?? { parts: new Map<number, string>() };
      this.messages.set(messageId, message);
      if (content?.content_type === "text" && Array.isArray(content.content_parts)) {
        for (const [index, part] of content.content_parts.entries()) {
          const text = object(part)?.text;
          if (typeof text === "string") deltaText += this.snapshot(message, index, text);
        }
      }
    } else if (frame.event === "delta" && existing) {
      if (data.path === "/message/status" && failedStatus(data.value)) this.reject("upstream_failed");
      if ((data.path === "/message/metadata/is_visually_hidden_from_conversation" && data.value !== false)
        || (data.path === "/message/content/content_type" && data.value !== "text")
        || (data.path === "/message/author/role" && data.value !== "assistant")) {
        this.messages.delete(messageId!);
        return unchanged();
      }
      const match = typeof data.path === "string"
        ? /^\/message\/content\/content_parts\/(0|[1-9]\d*)\/text$/.exec(data.path)
        : null;
      if (!match || typeof data.value !== "string") return unchanged();
      const index = Number(match[1]);
      if (!Number.isSafeInteger(index)) return unchanged();
      if (data.op === "append") {
        this.reserveText(data.value);
        existing.parts.set(index, (existing.parts.get(index) ?? "") + data.value);
        deltaText = data.value;
      } else if (data.op === "replace") {
        deltaText = this.snapshot(existing, index, data.value);
      }
    }
    this.accumulatedText += deltaText;
    return { deltaText, done: this.completed };
  }

  /** Call after the source closes: transport EOF/[DONE] alone is insufficient. */
  finish(): string {
    if (this.failure) throw this.failure;
    if (!this.completed) this.reject("incomplete_stream");
    return this.accumulatedText;
  }
}
