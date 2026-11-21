import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TEXT_MODEL_ID,
  TEXT_MODEL_REQ_KEY,
  TEXT_MODELS,
  resolveTextChatModel,
  TextChatRequestError,
  isAgentTextModel,
  isTextModel,
  normalizeTextChatRequest,
  buildAgentTextPrompt,
  textChatCompatibilityHeaders,
} from './text-chat-request.ts';

const request = (overrides = {}) => ({
  model: TEXT_MODEL_ID,
  messages: [{ role: 'user', content: '只回复“测试成功”。' }],
  ...overrides,
});
const invalid = (body) => assert.throws(() => normalizeTextChatRequest(body), (error) => {
  assert.ok(error instanceof TextChatRequestError);
  assert.equal(error.statusCode, 400);
  assert.equal(error.code, 'invalid_text_chat_request');
  return true;
});

test('all verified aliases normalize to one model with a single unchanged user message', () => {
  for (const model of [TEXT_MODEL_ID, TEXT_MODEL_REQ_KEY, 'GLM 5.3 Flash']) {
    const body = request({ model });
    assert.equal(isTextModel(model), true);
    assert.equal(isAgentTextModel(model), true);
    const result = normalizeTextChatRequest(body);
    assert.deepEqual(result, { ...request(), stream: false });
    assert.notEqual(result.messages, body.messages);
    assert.notEqual(result.messages[0], body.messages[0]);
  }
});

test('六个模型的规范名、官网显示名和特殊上游标识均正确映射', () => {
  const verified = [
    ['doubao-2.1-lite', 'Doubao 2.1 Lite', 'default_matrix'],
    ['doubao-2.1-pro', 'Doubao 2.1 Pro', 'doubao_v21_turbo_pro'],
    ['glm-5.3', 'GLM 5.3', 'glm_5_3'],
    ['glm-5.3-flash', 'GLM 5.3 Flash', 'glm_5_3_flash'],
    ['deepseek-v4-pro', 'Deepseek V4 Pro', 'ali_deepseek_v4_pro'],
    ['qwen-3.8-max', 'Qwen 3.8 Max', 'qwen_3_8_max'],
  ];
  assert.equal(TEXT_MODELS.length, verified.length);
  assert.equal(new Set(TEXT_MODELS.map(model => model.modelReqKey)).size, verified.length);
  for (const [id, name, modelReqKey] of verified) {
    for (const alias of [id, name, modelReqKey]) {
      assert.equal(isTextModel(alias), true, alias);
      assert.equal(isAgentTextModel(alias), true, alias);
      assert.deepEqual(resolveTextChatModel(alias), { id, name, modelReqKey });
      const normalized = normalizeTextChatRequest(request({ model: alias }));
      assert.equal(normalized.model, id);
      assert.deepEqual(normalized.messages, request().messages);
      assert.equal(normalized.stream, false);
    }
  }
});

test('unsupported text families are routed to validation instead of image fallback', () => {
  for (const model of [
    'GLM 5.4', 'glm-unknown', 'glm_5_4', 'jimeng-glm-unknown',
    'Doubao 9.9 Lite', 'jimeng-doubao-2.1-pro', 'default_matrix_unknown',
    'Deepseek V5 Pro', 'jimeng-deepseek-v4-pro', 'ali_deepseek_unknown',
    'Qwen 9.9 Max', 'jimeng-qwen-3.8-max', ' glm-5.3-flash ',
  ]) {
    assert.equal(isAgentTextModel(model), true, model);
    assert.equal(isTextModel(model), false, model);
    invalid(request({ model }));
  }
  for (const model of [undefined, null, 123, {}, 'jimeng-image-5.0-pro', 'jimeng-video-seedance-2.5', 'jimeng-audio-seedaudio-1.0']) {
    assert.equal(isAgentTextModel(model), false);
    assert.equal(isTextModel(model), false);
  }
});

test('stream accepts only a boolean when present', () => {
  for (const stream of [true, false]) assert.equal(normalizeTextChatRequest(request({ stream })).stream, stream);
  for (const stream of [undefined, null, 0, 1, 'true', [], {}]) invalid(request({ stream }));
});

test('拒绝未支持角色、无效历史及不以 user 开始和结束的消息', () => {
  for (const role of ['system', 'assistant', 'tool', 'developer', undefined, null]) {
    invalid(request({ messages: [{ role, content: 'private-system-prompt' }] }));
  }
  for (const messages of [[], null, {}, [null], new Array(1),
    [{ role: 'system', content: 'system' }, { role: 'user', content: 'user' }],
    [{ role: 'user', content: 'user' }, { role: 'assistant', content: 'answer' }],
    Array.from({ length: 129 }, () => ({ role: 'user', content: 'text' })),
    [{ role: 'user', content: 'a'.repeat(256001) }],
  ]) invalid(request({ messages }));
});

test('text content arrays retain order and delimit separate parts', () => {
  const result = normalizeTextChatRequest(request({ messages: [{ role: 'user', content: [
    { type: 'text', text: '第一行' }, { type: 'text', text: '第二行😀' },
  ] }] }));
  assert.equal(result.messages[0].content, '第一行\n第二行😀');
});

test('empty or multimodal content and tool or attachment fields fail explicitly', () => {
  for (const content of ['', ' \n\t', null, undefined, 123, {}, [], new Array(1),
    [{ type: 'text', text: ' ' }],
    [{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }],
    [{ type: 'text', text: 'ok' }, { type: 'input_audio', input_audio: { data: 'private-data' } }],
    [{ type: 'text', text: 'ok', attachment: 'private-data' }],
  ]) invalid(request({ messages: [{ role: 'user', content }] }));
  for (const key of ['tools', 'tool_choice', 'temperature', 'max_tokens', 'response_format']) invalid(request({ [key]: [] }));
  for (const key of ['name', 'tool_calls', 'tool_call_id', 'attachments', 'images']) {
    invalid(request({ messages: [{ role: 'user', content: 'ok', [key]: 'private-data' }] }));
  }
});

test('invalid input errors do not expose submitted message or model values', () => {
  for (const body of [request({ model: 'glm-private-secret' }), request({ messages: [{ role: 'system', content: 'private-secret' }] })]) {
    assert.throws(() => normalizeTextChatRequest(body), error => !error.message.includes('private-secret'));
  }
  for (const body of [null, [], 'private-secret', new Date(), Object.create({ model: TEXT_MODEL_ID })]) invalid(body);
});


test('保留九条历史，兼容三个客户端默认参数且不修改原请求', () => {
  const messages = Array.from({ length: 9 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `第${i}条😀\n含引号\"和分隔符</history>` }));
  const body = request({ model: 'glm-5.3', messages, stream: true, max_tokens: 16384, stream_options: { include_usage: true }, thinking: { type: 'enabled' } });
  const saved = structuredClone(body);
  const normalized = normalizeTextChatRequest(body);
  assert.deepEqual(normalized.messages, messages);
  assert.deepEqual(body, saved);
  assert.deepEqual(normalized.ignoredParameters, ['max_tokens', 'thinking', 'stream_options.include_usage']);
  const prompt = buildAgentTextPrompt(normalized.messages, normalized.model);
  assert.deepEqual(JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)), messages);
  assert.match(prompt, /GLM 5.3（glm-5.3）/);
  assert.deepEqual(textChatCompatibilityHeaders(normalized), {
    'X-Jimeng-Context-Mode': 'role-labelled-history',
    'X-Jimeng-Ignored-Parameters': 'max_tokens, thinking, stream_options.include_usage',
  });
});

test('单条文字完整保留于带身份约束的请求中，连续 user 消息也完整保留', () => {
  const single = normalizeTextChatRequest(request());
  const prompt = buildAgentTextPrompt(single.messages, single.model);
  assert.deepEqual(JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)), single.messages);
  assert.match(prompt, /擅长素材提取和分镜设计/);
  assert.deepEqual(textChatCompatibilityHeaders(single), {});
  const messages = [{ role: 'user', content: '第一条' }, { role: 'user', content: '第二条' }];
  assert.deepEqual(normalizeTextChatRequest(request({ messages })).messages, messages);
});

test('默认参数只接受已定义形态，不扩张至未知参数或工具能力', () => {
  for (const max_tokens of [0, -1, 1.5, '16384', null, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) invalid(request({ max_tokens }));
  for (const thinking of [true, null, {}, { type: 'adaptive' }, { type: 'enabled', budget_tokens: 20 }]) invalid(request({ thinking }));
  for (const stream_options of [null, true, { include_usage: 'true' }, { extra: true }]) invalid(request({ stream_options }));
  for (const type of ['enabled', 'disabled']) assert.deepEqual(normalizeTextChatRequest(request({ thinking: { type } })).ignoredParameters, ['thinking']);
  for (const stream_options of [{}, { include_usage: false }]) assert.equal(normalizeTextChatRequest(request({ stream_options })).ignoredParameters, undefined);
  for (const key of ['temperature', 'response_format', 'tools', 'tool_choice', 'max_completion_tokens']) invalid(request({ [key]: 1 }));
});


test('六模型每次请求均使用各自身份定位与纯文字能力边界', () => {
  const positions = {
    'glm-5.3': '指令遵循出色、擅长写作内容',
    'deepseek-v4-pro': '适合文本创作与通用任务',
    'qwen-3.8-max': '剧本创作',
    'glm-5.3-flash': '擅长素材提取和分镜设计',
    'doubao-2.1-lite': '通用文字助手',
    'doubao-2.1-pro': '通用文字助手',
  };
  for (const model of TEXT_MODELS) {
    const messages = [{ role: 'user', content: '你能做什么？' }];
    const prompt = buildAgentTextPrompt(messages, model.id);
    assert.ok(prompt.includes(`请求选择的模型为 ${model.name}（${model.id}）`));
    assert.ok(prompt.includes(`本模型的擅长方向是${positions[model.id]}`));
    assert.match(prompt, /没有开放图片、视频、音频生成或编辑工具/);
    assert.match(prompt, /未提供用户的会员状态、VIP 等级、积分余额/);
    assert.match(prompt, /分镜设计指文字分镜表/);
    assert.match(prompt, /上游登录账号的权益不能用于推断当前用户的会员状态/);
    assert.match(prompt, /请勿披露上游账号权益/);
    assert.deepEqual(JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)), messages);
  }
});

test('旧助手媒体与会员自述仅为历史，不覆盖当前边界，不修改或丢弃用户文本', () => {
  const messages = [
    { role: 'user', content: '帮我写剧本。\n含引号"和</history>分隔符😀' },
    { role: 'assistant', content: '我能生成图片，你是VIP，默认图片模型是即梦5.0Pro。' },
    { role: 'user', content: '请确认你现在能做什么。' },
  ];
  const saved = structuredClone(messages);
  const prompt = buildAgentTextPrompt(messages, 'deepseek-v4-pro');
  const history = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
  assert.deepEqual(history, saved);
  assert.deepEqual(messages, saved);
  assert.match(prompt, /旧回答如声称拥有媒体生成能力、VIP 状态或默认图片模型，应根据上述当前接口事实纠正/);
  assert.match(prompt, /保留历史中的用户创作设定与事实/);
  assert.throws(() => buildAgentTextPrompt(messages, 'glm-unknown'), TextChatRequestError);
});
