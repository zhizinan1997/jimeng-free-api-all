import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCookieHeader, parseCookiePairs } from './jimeng-cookie.ts';

test('a bare account-pool session uses the generated authenticated cookie header', () => {
  const generated = 'sessionid=test-session; sessionid_ss=test-session; sid_tt=test-session';
  for (const value of [undefined, '', 'test-session', ' test-session ', 'Cookie: test-session']) {
    assert.equal(normalizeCookieHeader(value, generated), generated);
  }
  assert.deepEqual(parseCookiePairs(normalizeCookieHeader('test-session', generated)), [
    ['sessionid', 'test-session'], ['sessionid_ss', 'test-session'], ['sid_tt', 'test-session'],
  ]);
});

test('full cookies preserve values and normalize browser and HTTP transports identically', () => {
  const supplied = 'Cookie: sessionid = test-session;sessionid_ss=test-session\r\nsid_guard=test-session%7C123; signature=a=b==; empty=;';
  const normalized = normalizeCookieHeader(supplied, 'unused=fallback');
  assert.equal(normalized, 'sessionid=test-session; sessionid_ss=test-session; sid_guard=test-session%7C123; signature=a=b==; empty=');
  assert.deepEqual(parseCookiePairs(normalized), parseCookiePairs(supplied));
});

test('malformed structured cookies are rejected rather than sent or silently replaced', () => {
  for (const value of ['sessionid=valid; broken', '=value', 'bad name=value', ';']) {
    assert.throws(() => normalizeCookieHeader(value, 'sessionid=fallback'), /Cookie 格式无效/);
  }
});
