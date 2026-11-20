import { beginPoolSubmission, acceptPoolSubmission, finishPoolTask, failPoolTask } from "../../lib/pool-task-context.ts";
import { randomUUID } from "node:crypto";
import { generateCookie } from "./core.ts";
import type { ResolvedCredential } from "./auth.ts";
import { markCredentialFailure, markCredentialSuccess } from "./auth.ts";
import browserTransport from "../../lib/browser-transport.ts";
import { normalizeCookieHeader, parseCookiePairs } from "../../lib/jimeng-cookie.ts";
import { openAgentBrowserTransport } from "../../lib/agent-browser-transport.ts";
import { AgentSessionError, runAgentTextSession } from "../../lib/agent-chat-session.ts";
import { createTextChatCompletion, TextChatUpstreamError } from "../../lib/text-chat-completion.ts";
import { buildAgentTextPrompt, resolveTextChatModel, TextChatRequestError, type TextChatRequest } from "../../lib/text-chat-request.ts";

/** A new workspace per request keeps all subscription traffic within one selected account and turn. */
export function createAgentTextCompletion(input: TextChatRequest, credential: ResolvedCredential, signal: AbortSignal) {
  const model = resolveTextChatModel(input.model);
  if (!model) throw new TextChatRequestError("不支持的文字模型，请使用 /v1/models?type=text 返回的模型");
  return createTextChatCompletion(input, async ({ signal: clientSignal, onText }) => {
    if (!browserTransport.enabled) throw new TextChatUpstreamError("transport", "invalid_response", 503);
    const timeout = Number(process.env.JIMENG_AGENT_TIMEOUT_MS || 120_000);
    const timeoutMs = Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 600_000 ? timeout : 120_000;
    const controller = new AbortController();
    const onAbort = () => controller.abort(new AgentSessionError("cancelled"));
    clientSignal.addEventListener("abort", onAbort, { once: true });
    if (clientSignal.aborted) onAbort();
    const timer = setTimeout(() => controller.abort(new AgentSessionError("timeout")), timeoutMs);
    let transport: Awaited<ReturnType<typeof openAgentBrowserTransport>> | undefined;
    let settlement: Promise<void> | undefined;
    try {
      const cookie = normalizeCookieHeader(credential.cookie, generateCookie(credential.token));
      transport = await openAgentBrowserTransport(parseCookiePairs(cookie), controller.signal);
      const workspaceId = await transport.createWorkspace(`${model.name} 文字对话`);
      const conversationId = randomUUID();
      const messageId = randomUUID();
      const body = {
        conversation_id: conversationId,
        workspace_id: workspaceId,
        version: "3.0.0",
        extra_info: JSON.stringify({ dreamina_agent_opt_mode: true, cloud_agent_experiment: true }),
        inference_selection: { model_id: model.modelReqKey },
        creation_mode: "standard",
        messages: [{
          id: messageId,
          author: { role: "user" },
          metadata: { conversation_id: conversationId, parent_message_id: "", is_visually_hidden_from_conversation: false },
          content: { content_type: "", content_parts: [{ text: buildAgentTextPrompt(input.messages, input.model), is_referenced: false }] },
          create_time: Date.now(),
          tools: [],
        }],
      };
      const text = await runAgentTextSession({
        subscribe: async () => transport!.subscribe({ workspace_id: workspaceId }),
        submit: async () => {
          beginPoolSubmission(conversationId);
          return transport!.submit(body);
        },
      }, { conversationId, signal: controller.signal, timeoutMs, onText, onSubmitted: () => acceptPoolSubmission(conversationId) });
      // finishPoolTask commits the verified answer synchronously, then reconciles the account balance.
      settlement = finishPoolTask("succeeded", undefined, { kind: "text", model: model.id, text })
        .then(() => markCredentialSuccess(credential));
      return text;
    } finally {
      clearTimeout(timer);
      clientSignal.removeEventListener("abort", onAbort);
      await Promise.all([settlement, transport?.close()]);
    }
  }, {
    signal,
    onFailure: async () => { await failPoolTask(); markCredentialFailure(credential); },
    onCancelled: () => failPoolTask(),
  });
}
