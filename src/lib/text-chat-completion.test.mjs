import assert from 'node:assert/strict';
import test from 'node:test';
import { createTextChatCompletion, publicTextChatError, TextChatUpstreamError } from './text-chat-completion.ts';
import { AgentSessionError } from './agent-chat-session.ts';
import { TEXT_MODELS, normalizeTextChatRequest } from './text-chat-request.ts';

const input = { model: 'glm-5.3-flash', messages: [{ role: 'user', content: '测试' }], stream: false };
const events = async source => {
  let raw = '';
  for await (const chunk of source) raw += chunk;
  return raw.trim().split('\n\n').map(value => value.slice(6)).map(value => value === '[DONE]' ? value : JSON.parse(value));
};

test('nonstream success returns actual text without invented token counts', async () => {
  let successes = 0;
  const result = await createTextChatCompletion(input, async () => '接口验证成功', { onSuccess: () => successes++ });
  assert.equal(result.object, 'chat.completion');
  assert.equal(result.model, input.model);
  assert.deepEqual(result.choices, [{ index: 0, message: { role: 'assistant', content: '接口验证成功' }, finish_reason: 'stop' }]);
  assert.equal('usage' in result, false);
  assert.equal(successes, 1);
});

test('stream forwards deltas and emits stop only after the session succeeds', async () => {
  let successes = 0;
  const stream = await createTextChatCompletion({ ...input, stream: true }, async ({ onText }) => {
    onText('接口'); onText('验证成功'); return '接口验证成功';
  }, { onSuccess: () => successes++ });
  const output = await events(stream);
  assert.equal(output[0].choices[0].delta.role, 'assistant');
  assert.equal(output.slice(1, 3).map(e => e.choices[0].delta.content).join(''), '接口验证成功');
  assert.equal(output.at(-2).choices[0].finish_reason, 'stop');
  assert.equal(output.at(-1), '[DONE]');
  assert.equal(new Set(output.slice(0, -1).map(e => e.id)).size, 1);
  assert.equal(successes, 1);
});

test('partial text followed by upstream error cannot masquerade as a successful reply', async () => {
  let successes = 0, failures = 0;
  const stream = await createTextChatCompletion({ ...input, stream: true }, async ({ onText }) => {
    onText('一部分'); throw new Error('Cookie: sensitive-credential');
  }, { onSuccess: () => successes++, onFailure: () => failures++ });
  const output = await events(stream);
  assert.equal(output.some(e => e.choices?.[0]?.finish_reason === 'stop'), false);
  assert.equal(output.at(-2).error.code, 'transport_network_error');
  assert.equal(JSON.stringify(output).includes('sensitive-credential'), false);
  assert.equal(successes, 0); assert.equal(failures, 1);
});

test('client disconnect cancels upstream and is not counted as account failure', async () => {
  let failures = 0, aborted = false;
  const stream = await createTextChatCompletion({ ...input, stream: true }, ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new AgentSessionError('cancelled')); });
  }), { onFailure: () => failures++ });
  stream.destroy();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(aborted, true); assert.equal(failures, 0);
});

test('pre-aborted requests and empty responses cannot succeed', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createTextChatCompletion(input, async () => assert.fail('must not call upstream'), { signal: controller.signal }), { code: 'cancelled' });
  await assert.rejects(createTextChatCompletion(input, async () => '  '), { code: 'empty_reply' });
});

test('public transport errors expose only validated status/code, never raw upstream text', () => {
  assert.equal(publicTextChatError(new AgentSessionError('timeout')).status, 504);
  assert.equal(publicTextChatError(new TextChatUpstreamError('submission', 'ret_1015')).error.code, 'submission_ret_1015');
  assert.equal(publicTextChatError(new TextChatUpstreamError('submission', 'secret-password')).error.code, 'submission_invalid_response');
});


test('各模型的 JSON 和 SSE 始终返回各自的规范模型名', async () => {
  for (const model of TEXT_MODELS) {
    const normalized = normalizeTextChatRequest({ ...input, model: model.modelReqKey });
    const result = await createTextChatCompletion(normalized, async () => '模型验证成功');
    assert.equal(result.model, model.id);
    const stream = await createTextChatCompletion({ ...normalized, stream: true }, async ({ onText }) => {
      onText('模型'); onText('验证成功'); return '模型验证成功';
    });
    const frames = await events(stream);
    for (const frame of frames.slice(0, -1)) assert.equal(frame.model, model.id);
    assert.equal(frames.at(-2).choices[0].finish_reason, 'stop');
    assert.equal(frames.at(-1), '[DONE]');
  }
});
