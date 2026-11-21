import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough, Readable } from 'node:stream';
import { runAgentTextSession } from './agent-chat-session.ts';

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const conversationId = 'test-conversation';
const handshake = sse('system', { type: 'subscribe_handshake', session_id: 'test-subscription' });
const reply = sse('message', { id: 'answer', author: { role: 'assistant' }, metadata: { conversation_id: conversationId }, content: { content_type: 'text', content_parts: [{ text: '验证成功' }] } });
const complete = sse('system', { type: 'stream_complete', conversation_id: conversationId });
const acknowledgement = () => Readable.from([
  sse('handshake', { conversation_id: conversationId }),
  sse('stream_complete', { success: true, error_code: '0' }),
]);

test('waits for subscription handshake and both independent completion signals', async () => {
  const subscription = new PassThrough();
  const phases = [];
  const signals = [];
  let text = '';
  const result = runAgentTextSession({
    async subscribe(signal) {
      signals.push(signal); phases.push('subscribe');
      queueMicrotask(() => { phases.push('handshake'); subscription.write(handshake); });
      return subscription;
    },
    async submit(signal) {
      signals.push(signal); phases.push('submit');
      assert.deepEqual(phases, ['subscribe', 'handshake', 'submit']);
      setTimeout(() => subscription.end(reply + complete), 10);
      return acknowledgement();
    },
  }, { conversationId, onText: value => { text += value; } });
  assert.equal(await result, '验证成功');
  assert.equal(text, '验证成功');
  assert.equal(signals[0], signals[1]);
  assert.equal(signals[0].aborted, true);
});

test('subscription failure does not submit; raw errors are not propagated by protocol parser', async () => {
  let submissions = 0;
  await assert.rejects(runAgentTextSession({
    async subscribe() { return Readable.from([sse('error', { message: 'private-cookie' })]); },
    async submit() { submissions++; return acknowledgement(); },
  }, { conversationId }), { code: 'subscription_failed' });
  assert.equal(submissions, 0);
});

test('successful submission with reply EOF is a failure, not an empty successful completion', async () => {
  const subscription = new PassThrough();
  await assert.rejects(runAgentTextSession({
    async subscribe() { subscription.write(handshake); return subscription; },
    async submit() { subscription.end(reply); return acknowledgement(); },
  }, { conversationId }), { code: 'incomplete_stream' });
});

test('submission rejection aborts the subscription and never retries', async () => {
  const subscription = new PassThrough();
  let submissions = 0;
  let aborted = false;
  await assert.rejects(runAgentTextSession({
    async subscribe(signal) {
      signal.addEventListener('abort', () => { aborted = true; subscription.destroy(); });
      subscription.write(handshake); return subscription;
    },
    async submit() { submissions++; return Readable.from([sse('stream_complete', { success: false, error_message: 'secret' })]); },
  }, { conversationId }), { code: 'submission_failed' });
  assert.equal(aborted, true);
  assert.equal(submissions, 1);
});

test('timeout cancels both streams; other conversation completion cannot finish request', async () => {
  const subscription = new PassThrough();
  let aborted = false;
  await assert.rejects(runAgentTextSession({
    async subscribe(signal) {
      signal.addEventListener('abort', () => { aborted = true; subscription.destroy(); });
      subscription.write(handshake + sse('system', { type: 'stream_complete', conversation_id: 'another-user' }));
      return subscription;
    },
    async submit() { return acknowledgement(); },
  }, { conversationId, timeoutMs: 25 }), { code: 'timeout' });
  assert.equal(aborted, true);
});

test('already cancelled request never reaches transport', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runAgentTextSession({
    async subscribe() { assert.fail('must not subscribe'); },
    async submit() { assert.fail('must not submit'); },
  }, { conversationId, signal: controller.signal }), { code: 'cancelled' });
});

test('mismatched submit handshake and missing final acknowledgement fail closed', async () => {
  for (const ack of [sse('handshake', { conversation_id: 'another-user' }), sse('handshake', { conversation_id: conversationId })]) {
    const subscription = new PassThrough();
    await assert.rejects(runAgentTextSession({
      async subscribe(signal) {
        signal.addEventListener('abort', () => subscription.destroy());
        subscription.write(handshake); return subscription;
      },
      async submit() { subscription.end(reply + complete); return Readable.from([ack]); },
    }, { conversationId }), { code: 'submission_failed' });
  }
});

test('empty finished reply is reported as unsupported rather than successful text', async () => {
  const subscription = new PassThrough();
  await assert.rejects(runAgentTextSession({
    async subscribe() { subscription.write(handshake); return subscription; },
    async submit() { subscription.end(complete); return acknowledgement(); },
  }, { conversationId }), { code: 'empty_reply' });
});
