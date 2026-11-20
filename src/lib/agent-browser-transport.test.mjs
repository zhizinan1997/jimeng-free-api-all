import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentWorkspaceResponse } from './agent-browser-transport.ts';
import { TextChatUpstreamError } from './text-chat-completion.ts';

test('保留真实接口返回的数字工作区标识，也接受字符串标识', () => {
  const id = 24545620000000;
  assert.equal(parseAgentWorkspaceResponse({ ret: '0', data: { workspace_id: id, scene: 'generate' } }), id);
  assert.equal(typeof parseAgentWorkspaceResponse({ ret: '0', data: { workspace_id: id } }), 'number');
  assert.equal(parseAgentWorkspaceResponse({ ret: 0, data: { workspace_id: String(id) } }), String(id));
});

test('工作区未成功创建或标识不完整时不得继续订阅与提交', () => {
  for (const value of [null, [], {}, { ret: '0' }, { ret: '0', data: null }]) {
    assert.throws(() => parseAgentWorkspaceResponse(value), TextChatUpstreamError);
  }
  for (const id of ['', '  ', 0, -1, 1.25, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, {}, []]) {
    assert.throws(() => parseAgentWorkspaceResponse({ ret: '0', data: { workspace_id: id } }), TextChatUpstreamError);
  }
});

test('工作区错误仅保留安全错误码，不包含上游凭据或原始错误文本', () => {
  assert.throws(() => parseAgentWorkspaceResponse({ ret: '4013', errmsg: 'sessionid=private', data: { token: 'private' } }), error => {
    assert.equal(error.code, 'workspace_ret_4013');
    assert.equal(error.statusCode, 502);
    assert.doesNotMatch(error.message, /private|sessionid|token/);
    return true;
  });
});
