import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runWithPoolTask, currentPoolTask, requestIdentity, beginPoolSubmission, acceptPoolSubmission,
  failPoolTask, finishPoolTask, observePoolHistory, poolCookie } from './pool-task-context.ts';

function fixture(id = 'task-a') {
  const changes = [], settled = [];
  const context = { taskId: id, requestId: 'request', requestFingerprint: 'hash', kind: 'image', model: 'model', state: 'reserved',
    sessionId: id, credential: `cookie-${id}`, pool: { transitionTask: (id, change) => changes.push({id, ...change}), settleTask: async id => settled.push(id) } };
  return { context, changes, settled };
}
test('submission persisted before acceptance; unknown submission never releases or resubmits', async () => {
  const f = fixture();
  await runWithPoolTask(f.context, async () => {
    beginPoolSubmission('local-submit');
    assert.equal(f.changes[0].state, 'submitting');
    assert.equal(f.changes[0].upstreamTaskId, undefined);
    await failPoolTask();
    assert.equal(f.context.state, 'unknown');
    assert.deepEqual(f.settled, []);
    assert.throws(() => beginPoolSubmission('again'), /禁止/);
  });
});
test('pre-submit failure releases through A; accepted history supports terminal settlement', async () => {
  const before = fixture();
  await runWithPoolTask(before.context, () => failPoolTask());
  assert.equal(before.context.state, 'failed');
  assert.equal(before.settled.length, 1);
  const f = fixture();
  await runWithPoolTask(f.context, async () => {
    beginPoolSubmission('submit'); acceptPoolSubmission('history');
    await observePoolHistory({wrong: {status:50}}, ['wrong']);
    assert.equal(f.context.state, 'submitted');
    await observePoolHistory({history: {status:42}}, ['history']);
    assert.equal(f.context.state, 'running');
    await observePoolHistory({history: {status:50, item_list: [{ image: { large_images: [{ image_url: 'https://fixture.invalid/ok.png' }] } }]}}, ['history']);
    await finishPoolTask('succeeded');
    assert.deepEqual(f.settled, ['task-a', 'task-a']);
  });
});
test('concurrent callbacks preserve account/cookie identity and never inherit another task', async () => {
  await Promise.all(['one','two'].map(id => runWithPoolTask(fixture(id).context, async () => {
    await new Promise(resolve => setTimeout(resolve, id === 'one' ? 10 : 1));
    assert.equal(currentPoolTask().taskId, id);
    assert.equal(poolCookie(id), `cookie-${id}`);
    assert.equal(poolCookie('unrelated'), undefined);
  })));
  assert.equal(currentPoolTask(), undefined);
});
test('same id fingerprints body fields and actual multipart bytes; absent keys remain distinct', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pool-identity-'));
  try {
    const a=path.join(dir,'a'), b=path.join(dir,'b'); writeFileSync(a, 'asset'); writeFileSync(b, 'asset');
    const request = {path:'/generation',headers:{'idempotency-key':'id'},body:{prompt:'private',n:1},files:{file:{filepath:a}}};
    const first = await requestIdentity(request, 'image','model');
    const same = await requestIdentity({...request,body:{n:1,prompt:'private'},files:{file:{filepath:b}}}, 'image','model');
    assert.equal(first.requestFingerprint,same.requestFingerprint);
    writeFileSync(b,'changed');
    assert.notEqual(first.requestFingerprint,(await requestIdentity({...request,files:{file:{filepath:b}}},'image','model')).requestFingerprint);
    assert.equal(JSON.stringify(first).includes('private'),false);
    assert.notEqual((await requestIdentity({...request,headers:{}},'image','model')).requestId,(await requestIdentity({...request,headers:{}},'image','model')).requestId);
  } finally { rmSync(dir,{recursive:true}); }
});

 test('settlement failure preserves terminal outcome and is retried on the next observation', async () => {
  const f = fixture(); let attempts = 0;
  f.context.pool.settleTask = async () => { if (++attempts === 1) throw new Error('balance unavailable'); };
  await runWithPoolTask(f.context, async () => {
    beginPoolSubmission(); acceptPoolSubmission('known');
    const validHistory = { known: { status: 50, item_list: [{ image: { large_images: [{ image_url: 'https://fixture.invalid/ok.png' }] } }] } };
    await observePoolHistory(validHistory, ['known']);
    assert.equal(f.context.state,'succeeded'); assert.equal(f.context.settlementPending,true);
    await observePoolHistory(validHistory, ['known']);
    assert.equal(f.context.settlementPending,false); assert.equal(attempts,2);
  });
});

test('empty record, unknown status, missing/empty item_list never mark succeeded; late processing never regresses terminal state', async () => {
  const f = fixture();
  const stored = { state: 'reserved', upstreamTaskId: null, result: null };
  f.context.ownerHash = 'owner-1';
  f.context.pool = {
    readTask: () => ({ ...stored }),
    readTaskResult: () => stored.result,
    transitionTask: (_id, change) => {
      const allowed = { reserved: ['submitting', 'failed'], submitting: ['submitted', 'running', 'succeeded', 'failed', 'unknown'], submitted: ['running', 'succeeded', 'failed', 'unknown'], running: ['succeeded', 'failed', 'unknown'], unknown: ['submitted', 'running', 'succeeded', 'failed'], succeeded: [], failed: [] };
      if (change.state !== stored.state && !allowed[stored.state].includes(change.state)) {
        throw Object.assign(new Error('不允许的任务状态转换'), { statusCode: 409 });
      }
      stored.state = change.state;
      if (change.upstreamTaskId) stored.upstreamTaskId = change.upstreamTaskId;
      if (change.result !== undefined) stored.result = change.result;
      f.changes.push(change);
    },
    settleTask: async id => { f.settled.push(id); },
  };
  await runWithPoolTask(f.context, async () => {
    beginPoolSubmission(); acceptPoolSubmission('known');
    await observePoolHistory({}, ['known']);
    await observePoolHistory({ known: {} }, ['known']);
    await observePoolHistory({ known: { status: 99, item_list: [{ image: { large_images: [{ image_url: 'https://fixture.invalid/ref.png' }] } }] } }, ['known']);
    await observePoolHistory({ known: { status: 50 } }, ['known']);
    await observePoolHistory({ known: { status: 50, item_list: [] } }, ['known']);
    await observePoolHistory({ known: { status: 50, item_list: [{ image: {} }] } }, ['known']);
    assert.equal(stored.state, 'submitted');
    assert.equal(f.settled.length, 0);
    await assert.rejects(() => finishPoolTask('succeeded', undefined, { submitId: 'only-submit' }), /已验证结果/);
    assert.equal(stored.state, 'submitted');

    // Concurrently transitioned to succeeded by another worker while this context still held 'submitted'.
    stored.state = 'succeeded';
    await observePoolHistory({ known: { status: 20 } }, ['known']);
    await observePoolHistory({ known: { status: 30 } }, ['known']);
    await failPoolTask();
    assert.equal(stored.state, 'succeeded');

    await observePoolHistory({ known: { status: 50, item_list: [{ image: { large_images: [{ image_url: 'https://fixture.invalid/final.png' }] } }] } }, ['known']);
    assert.deepEqual(stored.result?.urls, ['https://fixture.invalid/final.png']);
  });
});
