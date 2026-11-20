import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { AudioTaskBindings } from './audio-task-bindings.ts';

test('task queries enforce ownership and key validity before reading the pinned account', () => {
  const store = new AudioTaskBindings(':memory:');
  const credential = { token: 'test-session', cookie: 'test-cookie', accountId: 'account-a', managedKey: 'test-key-a' };
  store.remember(['history-a', 'submit-a'], credential);
  let reads = 0;
  const read = id => { reads++; assert.equal(id, 'account-a'); return { sessionId: 'test-session', credential: 'test-cookie' }; };
  assert.throws(() => store.resolve('history-a', [], () => true, read), /Authorization/);
  assert.throws(() => store.resolve('history-a', ['test-key-b'], () => true, read), /无权/);
  assert.throws(() => store.resolve('history-a', ['test-key-a'], () => false, read), /disabled/);
  assert.equal(reads, 0);
  assert.deepEqual(store.resolve('submit-a', ['test-key-a'], () => true, read), credential);
  assert.throws(() => store.resolve('unknown', ['test-key-a'], () => true, read), /不存在/);
  assert.equal(reads, 1);
  assert.throws(() => store.resolve('history-a', ['test-key-a'], () => true, () => { throw new Error('account disabled'); }), /disabled/);
  assert.throws(() => store.resolve('history-a', ['test-key-a'], () => true, () => ({ sessionId: 'other', credential: 'changed-cookie' })), /凭据已变更/);
  assert.throws(() => store.remember(['history-a'], { ...credential, accountId: 'account-b' }), /冲突/);
  store.close();
});

test('bindings survive a fresh process without storing secrets or rotating accounts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-binding-'));
  const file = path.join(dir, 'test.db');
  const store = new AudioTaskBindings(file);
  store.remember(['managed-task'], { token: 'private-session', cookie: 'private-cookie', managedKey: 'private-key', accountId: 'original-account' });
  store.remember(['native-task'], { token: 'private-native-session' });
  store.close();
  const script = `import { AudioTaskBindings } from ${JSON.stringify(new URL('./audio-task-bindings.ts', import.meta.url).href)};
    const store = new AudioTaskBindings(process.argv[1]);
    const result = store.resolve('managed-task', ['private-key'], () => true, id => {
      if (id !== 'original-account') throw new Error('account rotated');
      return {sessionId:'private-session',credential:'private-cookie'};
    });
    if (result.accountId !== 'original-account') throw new Error('binding lost');
    if (store.resolve('native-task', ['wrong', 'private-native-session'], () => false, () => {throw new Error('must not select account');}).token !== 'private-native-session') throw new Error('native identity lost');
    store.close();`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, file], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const bytes = fs.readFileSync(file).toString();
  for (const secret of ['private-session', 'private-cookie', 'private-key', 'private-native-session']) assert.equal(bytes.includes(secret), false);
  fs.rmSync(dir, { recursive: true });
});
