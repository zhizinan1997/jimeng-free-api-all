import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);

async function loadRecoveryModule(t) {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const dir = mkdtempSync(path.join(tmpdir(), 'pool-recovery-unit-'));
  const oldEnv = { ...process.env };
  process.env.DB_PATH = path.join(dir, 'isolated.db');
  process.env.JIMENG_ACCOUNT_POOL_KEY = 'pool-test-only-key-not-real-secret';
  process.env.JIMENG_BROWSER_TRANSPORT = 'off';
  process.env.VERCEL = '1';
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'pool-recovery-unit', version: '0.0.0' }));
  symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  const outfile = path.join(dir, 'recovery.cjs');
  const entry = `export { recoverStoredPoolTask, recoverPoolTask } from ${JSON.stringify(path.join(root, 'src/lib/pool-task-recovery.ts'))};
    export { currentPoolTask, runWithPoolTask } from ${JSON.stringify(path.join(root, 'src/lib/pool-task-context.ts'))};`;
  await build({
    stdin: { contents: entry, resolveDir: root, loader: 'ts' },
    outfile, bundle: true, platform: 'node', format: 'cjs', packages: 'external',
    logLevel: 'silent', tsconfig: path.join(root, 'tsconfig.json'),
  });
  return require(outfile);
}

function makeRecoveryPool(initial) {
  const task = { ...initial };
  let storedResult = initial.result ?? null;
  const transitions = [];
  const settles = [];
  const pool = {
    readTaskForRecovery: (id) => {
      assert.equal(id, task.id);
      return {
        task: { ...task },
        ownerHash: 'owner-hash-1',
        selection: {
          account: { id: task.accountId || 'acc-1' },
          credential: 'sessionid=orig-sess; webid=orig-webid',
          sessionId: 'orig-sess',
        },
      };
    },
    readTask: () => ({ ...task }),
    readTaskResult: () => storedResult,
    transitionTask: (_id, change) => {
      const allowed = {
        reserved: ['submitting', 'failed'],
        submitting: ['submitted', 'running', 'succeeded', 'failed', 'unknown'],
        submitted: ['running', 'succeeded', 'failed', 'unknown'],
        running: ['succeeded', 'failed', 'unknown'],
        unknown: ['submitted', 'running', 'succeeded', 'failed'],
        succeeded: [],
        failed: [],
      };
      if (change.state !== task.state && !allowed[task.state].includes(change.state)) {
        throw Object.assign(new Error('不允许的任务状态转换'), { statusCode: 409 });
      }
      task.state = change.state;
      if (change.upstreamTaskId) task.upstreamTaskId = change.upstreamTaskId;
      if (change.result !== undefined) storedResult = change.result;
      transitions.push(change);
    },
    settleTask: async (id) => { settles.push(id); task.settling = false; },
  };
  return { pool, task, transitions, settles, getResult: () => storedResult };
}

test('recoverStoredPoolTask runs in original account TaskContext, persists URLs, and settles', async (t) => {
  const { recoverStoredPoolTask, currentPoolTask } = await loadRecoveryModule(t);
  const store = makeRecoveryPool({
    id: 'task-img-1', kind: 'image', model: 'jimeng-image-5.0-lite',
    state: 'submitted', upstreamTaskId: 'hist-1', settling: true,
  });
  let observedContext;
  const res = await recoverStoredPoolTask('task-img-1', {
    pool: store.pool,
    queryHistory: async (hid, token, cookie) => {
      observedContext = { ...currentPoolTask() };
      assert.equal(hid, 'hist-1');
      assert.equal(token, 'orig-sess');
      assert.equal(cookie, 'sessionid=orig-sess; webid=orig-webid');
      return { 'hist-1': { status: 50, item_list: [{ image: { large_images: [{ image_url: 'https://fixture.invalid/recovered.png' }] } }] } };
    },
  });
  assert.equal(observedContext.accountId, 'acc-1');
  assert.equal(res.recoverable, true);
  assert.deepEqual(res.data, [{ url: 'https://fixture.invalid/recovered.png' }]);
  assert.equal(store.task.state, 'succeeded');
  assert.deepEqual(store.getResult().urls, ['https://fixture.invalid/recovered.png']);
  assert.deepEqual(store.settles, ['task-img-1']);
});

test('recoverStoredPoolTask skips upstream for terminal, no-ID, and text tasks', async (t) => {
  const { recoverStoredPoolTask } = await loadRecoveryModule(t);
  let queried = 0;
  const queryHistory = async () => { queried++; return {}; };

  const terminal = makeRecoveryPool({
    id: 'task-done', kind: 'video', model: 'm', state: 'succeeded',
    upstreamTaskId: 'hist-done', settling: true,
    result: { kind: 'video', urls: ['https://fixture.invalid/done.mp4'] },
  });
  const r1 = await recoverStoredPoolTask('task-done', { pool: terminal.pool, queryHistory });
  assert.equal(queried, 0);
  assert.deepEqual(terminal.settles, ['task-done']);
  assert.equal(r1.recoverable, true);
  assert.equal(r1.data[0].url, 'https://fixture.invalid/done.mp4');

  const noId = makeRecoveryPool({
    id: 'task-noid', kind: 'video', model: 'm', state: 'unknown', upstreamTaskId: null,
  });
  const r2 = await recoverStoredPoolTask('task-noid', { pool: noId.pool, queryHistory });
  assert.equal(queried, 0);
  assert.equal(r2.recoverable, false);
  assert.equal(noId.task.state, 'unknown');

  const textTask = makeRecoveryPool({
    id: 'task-text', kind: 'text', model: 'glm-5.3-flash', state: 'unknown', upstreamTaskId: 'conv-1',
  });
  const r3 = await recoverStoredPoolTask('task-text', { pool: textTask.pool, queryHistory });
  assert.equal(queried, 0);
  assert.equal(r3.recoverable, false);
  assert.equal(r3.recovery_code, 'text_answer_not_saved');
  assert.match(r3.message, /尚未保存完整答案/);
  assert.deepEqual(r3.data, []);
  assert.equal('answer' in r3, false);
  assert.deepEqual(textTask.transitions, []);
  assert.deepEqual(textTask.settles, []);
  assert.equal(textTask.task.state, 'unknown');
});

test('recoverStoredPoolTask never marks empty/status=99 complete and never regresses concurrent terminal state', async (t) => {
  const { recoverStoredPoolTask } = await loadRecoveryModule(t);
  const bad = makeRecoveryPool({
    id: 'task-99', kind: 'video', model: 'm', state: 'submitted', upstreamTaskId: 'hist-99',
  });
  const r1 = await recoverStoredPoolTask('task-99', {
    pool: bad.pool,
    queryHistory: async () => ({ 'hist-99': { status: 99, item_list: [{ video: { play_url: 'https://fixture.invalid/ref.mp4' } }] } }),
  });
  assert.equal(r1.recoverable, false);
  assert.deepEqual(r1.data, []);
  assert.equal(bad.task.state, 'submitted');

  const r2 = await recoverStoredPoolTask('task-99', {
    pool: bad.pool,
    queryHistory: async () => ({}),
  });
  assert.equal(r2.recoverable, false);
  assert.equal(bad.task.state, 'submitted');

  // Simulate foreground completing the task right while background history call is in flight.
  const raced = makeRecoveryPool({
    id: 'task-race', kind: 'audio', model: 'm', state: 'submitted', upstreamTaskId: 'hist-race',
  });
  const r3 = await recoverStoredPoolTask('task-race', {
    pool: raced.pool,
    queryHistory: async () => {
      raced.task.state = 'succeeded';
      raced.pool.transitionTask = () => { throw new Error('already terminal'); };
      return { 'hist-race': { status: 20 } };
    },
  });
  assert.equal(raced.task.state, 'succeeded');
  assert.equal(r3.task.state, 'succeeded');
});

test('recoverStoredPoolTask prefers committed terminal state over late in-flight history', async (t) => {
  const { recoverStoredPoolTask } = await loadRecoveryModule(t);
  const raceWin = makeRecoveryPool({
    id: 'task-win', kind: 'image', model: 'm', state: 'submitted', upstreamTaskId: 'hist-win', settling: true,
  });
  const w = await recoverStoredPoolTask('task-win', {
    pool: raceWin.pool,
    queryHistory: async () => {
      raceWin.pool.transitionTask('task-win', {
        state: 'succeeded',
        result: { kind: 'image', urls: ['https://fixture.invalid/winner.webp'] },
      });
      return { 'hist-win': { status: 20 } };
    },
  });
  assert.equal(w.task.state, 'succeeded');
  assert.equal(w.recoverable, true);
  assert.deepEqual(w.data, [{ url: 'https://fixture.invalid/winner.webp' }]);
  assert.deepEqual(raceWin.settles, ['task-win']);

  const raceFail = makeRecoveryPool({
    id: 'task-fail', kind: 'image', model: 'm', state: 'submitted', upstreamTaskId: 'hist-fail', settling: true,
  });
  const f = await recoverStoredPoolTask('task-fail', {
    pool: raceFail.pool,
    queryHistory: async () => {
      raceFail.pool.transitionTask('task-fail', { state: 'failed' });
      return {
        'hist-fail': {
          status: 50,
          item_list: [{ image: { large_images: [{ image_url: 'https://fixture.invalid/stale.webp' }] } }],
        },
      };
    },
  });
  assert.equal(f.task.state, 'failed');
  assert.equal(f.recoverable, false);
  assert.deepEqual(f.data, []);
});
