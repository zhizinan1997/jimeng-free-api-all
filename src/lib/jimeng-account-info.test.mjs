import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJimengAccountInfo } from './jimeng-account-info.ts';

test('passport success envelope uses the exact string UID and exposes only pool identity fields', () => {
  // Same envelope and field types observed on the live read-only passport endpoint.
  const result = parseJimengAccountInfo({ message: 'success', data: {
    user_id: 9007199254740992, user_id_str: '9007199254740993', screen_name: '上游昵称',
    user_verified: false, email: 'private@example.invalid', mobile: 'private-mobile',
    session_key: 'private-session', connects: [{ access_token: 'private-token' }]
  } });
  assert.deepEqual(result, {
    membership: 'unknown',
    upstreamIdentity: { verified: true, userId: '9007199254740993', displayName: '上游昵称', source: '/passport/account/info/v2' }
  });
  assert.equal(JSON.stringify(result).includes('private-'), false);
});

test('already unwrapped profiles remain compatible and explicit non-VIP is retained', () => {
  const profile = { user_id: 123, nickname: '上游昵称', is_vip: false };
  for (const value of [profile, { user_info: profile }, { user: profile }, { account: profile }]) {
    const result = parseJimengAccountInfo(value);
    assert.equal(result.upstreamIdentity.userId, '123');
    assert.equal(result.upstreamIdentity.verified, true);
    assert.equal(result.membership.isVip, false);
  }
});

test('an unsuccessful passport envelope cannot verify even if it contains an ID', () => {
  for (const message of ['error', '', null]) {
    assert.throws(() => parseJimengAccountInfo({ message, data: { user_id_str: '123' } }), /身份接口返回失败/);
  }
});

test('missing, malformed and unsafe numeric IDs remain unverified', () => {
  for (const id of [undefined, null, '', '  ', '0', 0, -1, 1.5, false, {}, [], 9007199254740992]) {
    const result = parseJimengAccountInfo({ message: 'success', data: { user_id: id, screen_name: '不能用昵称核验' } });
    assert.equal(result.upstreamIdentity.verified, false);
    assert.equal(result.upstreamIdentity.userId, null);
  }
  for (const value of [null, [], {}, { message: 'success' }, { message: 'success', data: [] }]) {
    assert.equal(parseJimengAccountInfo(value).upstreamIdentity.verified, false);
  }
});
