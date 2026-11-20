import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentStreamError, AgentTextAccumulator, parseAgentSSE } from './agent-chat-sse.ts';

async function* chunks(values) { yield* values; }
async function parse(values, options) { return Array.fromAsync(parseAgentSSE(chunks(values), options)); }
const frame = (event, data) => ({ event, data });
const wire = ({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const message = (id = 'executor-a', text = '', conversationId = 'conversation-a', extra = {}) => frame('message', {
  id, author: { role: 'assistant', name: 'executor' },
  content: { content_type: 'text', content_parts: [{ text }], reasoning_content: 'private reasoning' },
  metadata: { conversation_id: conversationId }, status: 'in_progress', ...extra,
});
const delta = (value, extra = {}) => frame('delta', {
  path: '/message/content/content_parts/0/text', op: 'append', value,
  conversation_id: 'conversation-a', message_id: 'executor-a', ...extra,
});
const complete = (conversationId = 'conversation-a', extra = {}) => frame('system', {
  type: 'stream_complete', conversation_id: conversationId, ...extra,
});
const hasCode = code => error => error instanceof AgentStreamError && error.code === code;

test('SSE preserves UTF-8 at every byte split and CRLF at every text split', async () => {
  const expected = [message('executor-a', '接口成功🌟'), delta('继续')];
  const text = '\uFEFF: heartbeat\r\n\r\n' + expected.map(wire).join('').replaceAll('\n', '\r\n');
  const bytes = Buffer.from(text);
  assert.deepEqual(await parse([...bytes].map(byte => Uint8Array.of(byte))), expected);
  for (let index = 0; index <= bytes.length; index++) {
    assert.deepEqual(await parse([bytes.subarray(0, index), bytes.subarray(index)]), expected);
  }
  const noBom = text.slice(1);
  for (let index = 0; index <= noBom.length; index++) {
    assert.deepEqual(await parse([noBom.slice(0, index), noBom.slice(index)]), expected);
  }
});

test('SSE handles multiline data, comments, default events, CR endings and EOF', async () => {
  assert.deepEqual(await parse([
    ': ignored\rid: 123\rretry: 5\rdata: {\rdata: "answer": "yes"\rdata: }\r\r',
    'event: delta\ndata: {"value":"last"}',
  ]), [frame('message', { answer: 'yes' }), frame('delta', { value: 'last' })]);
  assert.deepEqual(await parse(['event: message\rdata: {"ok":true}\r']), [frame('message', { ok: true })]);
  assert.deepEqual(await parse([': comment only']), []);
});

test('heartbeats are skipped and DONE stops the source without implying completion', async () => {
  let sourceClosed = false;
  async function* source() {
    try {
      yield 'event: heartbeat\ndata: not-json\n\nevent: ping\ndata: pong\n\n';
      yield 'data: [DONE]\n\ndata: malformed but never consumed\n\n';
      assert.fail('must not read after DONE');
    } finally { sourceClosed = true; }
  }
  assert.deepEqual(await Array.fromAsync(parseAgentSSE(source())), [frame('done', null)]);
  assert.equal(sourceClosed, true);
  const reducer = new AgentTextAccumulator('conversation-a');
  reducer.accept(frame('done', null));
  assert.equal(reducer.done, false);
  assert.throws(() => reducer.finish(), hasCode('incomplete_stream'));
});

test('malformed JSON, truncated UTF-8 and oversized events fail without exposing data', async () => {
  for (const input of ['data: secret-sessionid\n\n', 'data: {"token":"private-secret"', 'data:\n\n']) {
    await assert.rejects(parse([input]), error => {
      assert.match(error.message, /invalid JSON/);
      assert.equal(error.message.includes('secret'), false);
      return hasCode('invalid_json')(error);
    });
  }
  await assert.rejects(parse([Uint8Array.of(0xf0, 0x9f)]), hasCode('invalid_utf8'));
  await assert.rejects(parse([Uint8Array.of(0xff)]), hasCode('invalid_utf8'));
  await assert.rejects(parse(['data: "', '界'.repeat(40)] , { maxEventBytes: 32 }), hasCode('event_too_large'));
  await assert.rejects(parse([':' + 'x'.repeat(33)], { maxEventBytes: 32 }), hasCode('event_too_large'));
  await assert.rejects(parse(['event: ' + 'x'.repeat(33)], { maxEventBytes: 32 }), hasCode('event_too_large'));
  for (const maxEventBytes of [0, -1, 1.5, Infinity, NaN]) {
    await assert.rejects(parse([], { maxEventBytes }), /positive safe integer/);
  }
});

test('event limits reset between events and count split CRLF consistently', async () => {
  const input = 'data: 1\r\n\r\n';
  const size = Buffer.byteLength(input);
  for (let index = 0; index <= input.length; index++) {
    assert.deepEqual(await parse([input.slice(0, index), input.slice(index), input], { maxEventBytes: size }), [frame('message', 1), frame('message', 1)]);
    await assert.rejects(parse([input.slice(0, index), input.slice(index)], { maxEventBytes: size - 1 }), hasCode('event_too_large'));
  }
});

test('observed executor delta survives an empty finished host message', async () => {
  const events = [
    message(),
    delta('do not expose', { path: '/message/content/reasoning_content' }),
    delta('接口'), delta('验证成功'),
    delta('finished', { path: '/message/status', op: 'replace' }),
    message('host-a', '', 'conversation-a', {
      author: { role: 'assistant', name: 'host' }, status: 'finished_successfully', end_turn: true,
    }),
    complete(),
  ];
  const reducer = new AgentTextAccumulator('conversation-a');
  let emitted = '';
  let index = 0;
  for await (const event of parseAgentSSE(chunks([Buffer.from(events.map(wire).join(''))]))) {
    const update = reducer.accept(event);
    emitted += update.deltaText;
    assert.equal(update.done, index === events.length - 1);
    index++;
  }
  assert.equal(emitted, '接口验证成功');
  assert.equal(reducer.text, emitted);
  assert.equal(reducer.finish(), emitted);
});

test('other conversations and unbound message IDs cannot inject text or completion', () => {
  const reducer = new AgentTextAccumulator('conversation-a');
  const ignored = [
    message('foreign', 'foreign secret', 'conversation-b'),
    message('unknown', 'unbound secret', undefined, { metadata: {} }),
    delta('unbound secret'),
    complete('conversation-b'),
    frame('system', { type: 'stream_complete', success: true, error_code: '0', scene: 'creation_agent_v33' }),
  ];
  for (const event of ignored) assert.deepEqual(reducer.accept(event), { deltaText: '', done: false });
  reducer.accept(message());
  reducer.accept(delta('safe'));
  reducer.accept(delta('foreign secret', { conversation_id: 'conversation-b' }));
  reducer.accept(delta('foreign secret', { metadata: { conversation_id: 'conversation-b' } }));
  reducer.accept(delta('foreign secret', { message_id: 'foreign', conversation_id: undefined }));
  assert.deepEqual(reducer.accept(delta(' bound', { conversation_id: undefined })), { deltaText: ' bound', done: false });
  reducer.accept(frame('system', { type: 'stream_complete', message_id: 'executor-a' }));
  assert.equal(reducer.done, false);
  reducer.accept(complete());
  assert.equal(reducer.finish(), 'safe bound');
});

test('user messages, reasoning and tool content never become assistant text', () => {
  const reducer = new AgentTextAccumulator('conversation-a');
  reducer.accept(message('user-a', 'user secret', 'conversation-a', { author: { role: 'user' } }));
  reducer.accept(delta('user secret', { message_id: 'user-a' }));
  reducer.accept(message('tool-a', 'tool secret', 'conversation-a', { author: { role: 'tool' } }));
  reducer.accept(delta('tool secret', { message_id: 'tool-a' }));
  reducer.accept(message());
  reducer.accept(delta('reasoning secret', { path: '/message/content/reasoning_content' }));
  reducer.accept(delta('ignored', { path: '/message/content/content_parts/0/image' }));
  reducer.accept(complete());
  assert.equal(reducer.finish(), '');
});

test('hidden assistant and non-text messages cannot register text delta sources', () => {
  const reducer = new AgentTextAccumulator('conversation-a');
  reducer.accept(message('hidden', 'private hidden text', 'conversation-a', {
    metadata: { conversation_id: 'conversation-a', is_visually_hidden_from_conversation: true },
  }));
  reducer.accept(delta('hidden delta', { message_id: 'hidden' }));
  reducer.accept(message('non-text', '', 'conversation-a', {
    content: { content_type: 'tool_call', content_parts: [{ text: 'tool arguments' }] },
  }));
  reducer.accept(delta('tool arguments delta', { message_id: 'non-text' }));
  reducer.accept(message('visible', 'visible text'));
  reducer.accept(complete());
  assert.equal(reducer.finish(), 'visible text');
});

test('cumulative snapshots are deduplicated by message and stale snapshots do not erase text', () => {
  const reducer = new AgentTextAccumulator('conversation-a');
  const updates = [
    message('executor-a', '接口'),
    message('executor-a', '接口'),
    delta('验证'),
    message('executor-a', '接口验证'),
    message('executor-a', ''),
    message('executor-a', '接口验证成功'),
    delta('接口验证成功', { op: 'replace' }),
    message('host-a', ''),
  ].map(event => reducer.accept(event).deltaText);
  assert.deepEqual(updates, ['接口', '', '验证', '', '', '成功', '', '']);
  reducer.accept(complete());
  assert.equal(reducer.finish(), '接口验证成功');
});

test('EOF and per-message terminal statuses never stand in for stream completion', async () => {
  for (const status of ['finished', 'finished_successfully']) {
    const reducer = new AgentTextAccumulator('conversation-a');
    for await (const event of parseAgentSSE(chunks([wire(message('executor-a', 'partial', 'conversation-a', { status, end_turn: true }))]))) {
      reducer.accept(event);
    }
    assert.equal(reducer.text, 'partial');
    assert.equal(reducer.done, false);
    assert.throws(() => reducer.finish(), hasCode('incomplete_stream'));
  }
});

test('matching upstream failures are sticky and do not echo raw server errors', () => {
  const failures = [
    message('executor-a', 'private-secret', 'conversation-a', { status: 'failed' }),
    delta('failed', { path: '/message/status', op: 'replace', error_message: 'private-secret' }),
    frame('error', { conversation_id: 'conversation-a', message: 'private-secret' }),
    frame('system', { type: 'stream_error', conversation_id: 'conversation-a', message: 'private-secret' }),
    complete('conversation-a', { success: false, error_message: 'private-secret' }),
    complete('conversation-a', { error_code: '42', error_message: 'private-secret' }),
  ];
  for (const failure of failures) {
    const reducer = new AgentTextAccumulator('conversation-a');
    reducer.accept(message());
    assert.throws(() => reducer.accept(failure), error => {
      assert.equal(error.message.includes('private-secret'), false);
      return hasCode('upstream_failed')(error);
    });
    assert.equal(reducer.done, false);
    assert.throws(() => reducer.accept(complete()), hasCode('upstream_failed'));
    assert.throws(() => reducer.finish(), hasCode('upstream_failed'));
  }
});

test('conflicting text snapshots fail without including either text value', () => {
  const reducer = new AgentTextAccumulator('conversation-a');
  reducer.accept(message('executor-a', 'private original'));
  assert.throws(() => reducer.accept(message('executor-a', 'private replacement')), error => {
    assert.equal(error.message.includes('private'), false);
    return hasCode('text_conflict')(error);
  });
});
