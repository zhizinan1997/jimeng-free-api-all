import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import type { Browser, Page } from "playwright-core";
import { AgentSessionError } from "./agent-chat-session.ts";
import { TextChatUpstreamError } from "./text-chat-completion.ts";

const ORIGIN = "https://jimeng.jianying.com";
export const AGENT_WORKSPACE_PATH = "/mweb/v1/workspace/create";
export const AGENT_SUBSCRIBE_PATH = "/mweb/v1/creation_agent/v2/subscribe_session";
export const AGENT_CONVERSATION_PATH = "/mweb/v1/creation_agent/v2/conversation";
type Stage = "workspace" | "subscription" | "submission";
type Channel = {
  stream: PassThrough;
  stage: Stage;
  kind: "json" | "sse";
  resolve: (stream: PassThrough) => void;
  reject: (error: Error) => void;
};

function cancellation(signal: AbortSignal): Error {
  return signal.reason instanceof AgentSessionError ? signal.reason : new AgentSessionError("cancelled");
}

/** Preserve the numeric workspace ID observed on the real endpoint; do not coerce it to a string. */
export function parseAgentWorkspaceResponse(value: unknown): string | number {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TextChatUpstreamError("workspace");
  const result = value as Record<string, any>;
  if (String(result.ret) !== "0") throw new TextChatUpstreamError("workspace", `ret_${result.ret}`);
  const workspaceId = result.data?.workspace_id;
  const validId = (typeof workspaceId === "string" && workspaceId.trim().length > 0)
    || (Number.isSafeInteger(workspaceId) && workspaceId > 0);
  if (!validId) throw new TextChatUpstreamError("workspace");
  return workspaceId;
}


/** Each call owns a fresh browser context and cookie jar. No account switching or request retries. */
export async function openAgentBrowserTransport(cookiePairs: Array<[string, string]>, signal: AbortSignal) {
  const env = process.env;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let closed = false;
  const channels = new Map<string, Channel>();
  const binding = `jimengAgent_${randomUUID().replaceAll("-", "")}`;
  const abortKey = `${binding}_controllers`;
  const fail = (channel: Channel, error: Error) => {
    channel.reject(error);
    channel.stream.destroy(error);
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", onAbort);
    for (const channel of channels.values()) fail(channel, signal.aborted ? cancellation(signal) : new AgentSessionError("cancelled"));
    channels.clear();
    await browser?.close().catch(() => {});
  };
  const onAbort = () => { void close(); };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    if (signal.aborted) throw cancellation(signal);
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({
      headless: String(env.JIMENG_BROWSER_HEADLESS || "true").toLowerCase() !== "false",
      executablePath: env.JIMENG_BROWSER_EXECUTABLE || undefined,
      channel: env.JIMENG_BROWSER_CHANNEL || (!env.JIMENG_BROWSER_EXECUTABLE ? "chrome" : undefined),
      args: String(env.JIMENG_BROWSER_ARGS || "").split(",").map(value => value.trim()).filter(Boolean),
      timeout: 30_000,
    });
    if (closed || signal.aborted) {
      await browser.close();
      throw cancellation(signal);
    }
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai",
      userAgent: env.JIMENG_BROWSER_USER_AGENT || undefined,
    });
    await context.addCookies(cookiePairs.map(([name, value]) => ({ name, value, domain: ".jianying.com", path: "/", secure: true })));
    page = await context.newPage();
    const ownedPage = page;
    await page.exposeBinding(binding, async ({ frame }, id: string, event: Record<string, any>) => {
      const channel = channels.get(id);
      if (frame !== ownedPage.mainFrame() || !channel || closed) return false;
      if (event.type === "headers") {
        if (event.status !== 200) {
          fail(channel, new TextChatUpstreamError(channel.stage, `http_${event.status}`));
          return false;
        }
        const contentType = String(event.contentType || "").toLowerCase();
        const validType = channel.kind === "sse" ? contentType.includes("text/event-stream") : contentType.includes("application/json");
        if (!validType) {
          fail(channel, new TextChatUpstreamError(channel.stage, "invalid_content_type"));
          return false;
        }
        channel.resolve(channel.stream);
      } else if (event.type === "data") {
        if (channel.stream.destroyed) return false;
        if (!channel.stream.write(Buffer.from(event.bytes, "base64"))) {
          try { await once(channel.stream, "drain", { signal }); } catch { return false; }
        }
      } else if (event.type === "end") {
        channel.stream.end();
        channels.delete(id);
      } else if (event.type === "error") {
        fail(channel, signal.aborted ? cancellation(signal) : new TextChatUpstreamError(channel.stage, "network_error"));
      }
      return !channel.stream.destroyed;
    });
    const navigationTimeout = Number(env.JIMENG_BROWSER_NAVIGATION_TIMEOUT || 60_000);
    await page.goto(`${ORIGIN}/ai-tool/home`, { waitUntil: "domcontentloaded", timeout: Number.isFinite(navigationTimeout) && navigationTimeout > 0 ? navigationTimeout : 60_000 });
    // The page's own security SDK installs its fetch wrapper during startup.
    await page.waitForTimeout(1500);
    if (signal.aborted) throw cancellation(signal);
  } catch (error) {
    await close();
    if (signal.aborted) throw cancellation(signal);
    if (error instanceof AgentSessionError) throw error;
    throw new TextChatUpstreamError("transport", "network_error", 503);
  }

  const requestStream = async (requestPath: string, body: object, stage: Stage, kind: "json" | "sse") => {
    if (closed || signal.aborted) throw cancellation(signal);
    if (![AGENT_WORKSPACE_PATH, AGENT_SUBSCRIBE_PATH, AGENT_CONVERSATION_PATH].includes(requestPath)) {
      throw new TextChatUpstreamError(stage);
    }
    const target = new URL(requestPath, ORIGIN);
    if (requestPath !== AGENT_SUBSCRIBE_PATH) {
      target.searchParams.set("aid", "513695");
      target.searchParams.set("web_version", "7.5.0");
      target.searchParams.set("da_version", requestPath === AGENT_WORKSPACE_PATH ? "3.3.39" : "3.1.3");
      if (requestPath === AGENT_WORKSPACE_PATH) target.searchParams.set("aigc_features", "app_lip_sync");
    }
    const id = randomUUID();
    const stream = new PassThrough({ highWaterMark: 64 * 1024 });
    // A failure may arrive before the caller receives the readable.
    stream.on("error", () => {});
    const ready = new Promise<PassThrough>((resolve, reject) => channels.set(id, { stream, resolve, reject, stage, kind }));
    stream.once("close", () => {
      channels.delete(id);
      if (!closed) void page!.evaluate(({ key, id }) => { (globalThis as any)[key]?.[id]?.abort(); }, { key: abortKey, id }).catch(() => {});
    });
    void page!.evaluate(async (payload) => {
      const root = globalThis as any;
      const controllers = root[payload.abortKey] ||= {};
      const controller = controllers[payload.id] = new AbortController();
      const send = (event: object) => root[payload.binding](payload.id, event);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const response = await fetch(payload.url, {
          method: "POST", credentials: "include", redirect: "error", signal: controller.signal,
          headers: { "content-type": "application/json", accept: payload.accept, pf: "7" },
          body: payload.body,
        });
        if (!await send({ type: "headers", status: response.status, contentType: response.headers.get("content-type") })) return;
        if (!response.body) { await send({ type: "error" }); return; }
        reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // Preserve UTF-8 byte boundaries; decoding belongs to the SSE parser.
          for (let offset = 0; offset < value.length; offset += 16 * 1024) {
            const bytes = btoa(String.fromCharCode(...value.subarray(offset, offset + 16 * 1024)));
            if (!await send({ type: "data", bytes })) return;
          }
        }
        await send({ type: "end" });
      } catch {
        await send({ type: "error" }).catch(() => {});
      } finally {
        controller.abort();
        await reader?.cancel().catch(() => {});
        delete controllers[payload.id];
      }
    }, { id, binding, abortKey, url: target.toString(), body: JSON.stringify(body), accept: kind === "sse" ? "text/event-stream" : "application/json" }).catch(() => {
      const channel = channels.get(id);
      if (channel) fail(channel, signal.aborted ? cancellation(signal) : new TextChatUpstreamError(stage, "network_error"));
    });
    return ready;
  };

  return {
    async createWorkspace(name = "文字对话"): Promise<string | number> {
      const source = await requestStream(AGENT_WORKSPACE_PATH, { name, scene: "generate" }, "workspace", "json");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of source) {
        size += chunk.length;
        if (size > 128 * 1024) throw new TextChatUpstreamError("workspace", "response_too_large");
        chunks.push(chunk);
      }
      let result: unknown;
      try { result = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new TextChatUpstreamError("workspace"); }
      return parseAgentWorkspaceResponse(result);
    },
    subscribe(body: object) { return requestStream(AGENT_SUBSCRIBE_PATH, body, "subscription", "sse"); },
    submit(body: object) { return requestStream(AGENT_CONVERSATION_PATH, body, "submission", "sse"); },
    close,
  };
}
