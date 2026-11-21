import { PassThrough, Readable } from 'node:stream';

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

// Only the browser transport is replaced. Text controller/session/completion stay real.
export async function openAgentBrowserTransport(pairs: Array<[string, string]>) {
  const fixture = (globalThis as any).__Bfixture;
  const session = pairs.find(([name]) => name === 'sessionid')?.[1];
  fixture.validateCookiePairs(pairs);
  const sub = new PassThrough();
  const workspace = fixture.nextWorkspace++;
  fixture.record('text-open', session, { workspace });
  return {
    createWorkspace: async () => {
      fixture.record('text-workspace', session, { workspace });
      return workspace;
    },
    subscribe: async () => {
      fixture.record('text-subscribe', session, { workspace });
      sub.write(sse('system', { type: 'subscribe_handshake', session_id: 'synthetic-subscription' }));
      return sub;
    },
    submit: async (body: any) => {
      const id = body.conversation_id;
      fixture.record('submit', session, { kind: 'text', upstreamId: fixture.mode === 'timeout' ? null : id,
        submittedConversationFingerprint: fixture.digest(id), acknowledgementExpected: fixture.mode !== 'timeout', workspace });
      if (fixture.mode === 'timeout') throw Object.assign(new Error('synthetic lost submission response'), { code: 'ETIMEDOUT' });
      const complete = () => {
        fixture.record('text-result', session, { upstreamId: id, workspace });
        sub.end(sse('message', {
          id: `answer-${id}`, author: { role: 'assistant' }, metadata: { conversation_id: id },
          content: { content_type: 'text', content_parts: [{ text: 'B synthetic answer' }] },
        }) + sse('system', { type: 'stream_complete', conversation_id: id }));
      };
      if (fixture.mode === 'restart-known') setTimeout(() => fixture.crashAfterSubmission(id), 10);
      else if (fixture.holdSession === session) {
        fixture.release = complete;
        fixture.started({ upstreamId: id, session });
      } else setTimeout(complete, 1);
      return Readable.from([
        sse('handshake', { conversation_id: id }),
        sse('stream_complete', { success: true, error_code: '0' }),
      ]);
    },
    close: async () => sub.destroy(),
  };
}
