import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import Database from 'better-sqlite3';

const temporary = mkdtempSync(join(tmpdir(), 'jimeng-usage-test-'));
process.env.DB_PATH = join(temporary, 'test.db');
const db = await import('../src/lib/database.ts');
const { createUsageTracker } = await import('../src/lib/usage.ts');
after(() => rmSync(temporary, { recursive: true, force: true }));

function request(key: string, model = 'image-model') {
  return { headers: { authorization: `Bearer ${key}` }, body: { model } };
}
function newKey() { return db.createApiKey('test caller'); }
function stats(id: number): any { return db.getUsage(0, id); }
async function settled(id: number) {
  for (let i = 0; i < 100; i++) {
    if (!stats(id).totals.running) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('request did not settle');
}

test('successes are isolated by caller key, not by shared upstream account', async () => {
  let credit = 100;
  const tracker = createUsageTracker(async () => credit);
  const a = newKey(), b = newKey();
  const run = tracker.wrap(async () => {
    await tracker.attach('same-upstream'); credit -= 4;
    tracker.success(2, 0); return { data: ['a', 'b'] };
  }, '/v1/images/generations', 'default');
  await run(request(a.key)); await run(request(a.key)); await run(request(b.key));
  assert.equal(stats(a.apiKey.id).totals.requests, 2);
  assert.equal(stats(a.apiKey.id).totals.images, 4);
  assert.equal(stats(a.apiKey.id).totals.estimated_credits, 8);
  assert.equal(stats(b.apiKey.id).totals.requests, 1);
  assert.equal(stats(b.apiKey.id).totals.estimated_credits, 4);
  assert.equal(stats(a.apiKey.id).modelStats[0].model, 'image-model');
  const legacy: any = db.getStats().keyStats.find((row: any) => row.key_preview === a.apiKey.key_preview);
  assert.equal(legacy.total_calls, 2);
  assert.equal(legacy.total_credits, 8);
  const serialized = JSON.stringify(stats(a.apiKey.id));
  assert.ok(!serialized.includes(a.key));
  assert.ok(!serialized.includes('same-upstream'));
});

test('failures before upstream selection and invalid input are recorded as unknown, not free', async () => {
  const a = newKey();
  const tracker = createUsageTracker(async () => assert.fail('must not read credit'));
  const run = tracker.wrap(async () => { throw new Error('no account'); }, '/v1/videos/generations', 'video');
  await assert.rejects(run(request(a.key)), /no account/);
  const result = stats(a.apiKey.id);
  assert.equal(result.totals.failed, 1);
  assert.equal(result.totals.estimated_credits, null);
  assert.equal(result.totals.unknown_credits, 1);
});

test('failed generation may still consume credits', async () => {
  const a = newKey(); let credit = 100;
  const tracker = createUsageTracker(async () => credit);
  const run = tracker.wrap(async () => {
    await tracker.attach('upstream'); credit -= 8; throw new Error('polling failed');
  }, '/v1/videos/generations', 'video');
  await assert.rejects(run(request(a.key)), /polling failed/);
  assert.equal(stats(a.apiKey.id).totals.failed, 1);
  assert.equal(stats(a.apiKey.id).totals.estimated_credits, 8);
});

test('balance lookup failure and balance increase stay unknown', async () => {
  for (const mode of ['error', 'increase']) {
    const a = newKey(); let credit = 10;
    const tracker = createUsageTracker(async () => {
      if (mode === 'error') throw new Error('unavailable');
      return credit++;
    });
    await tracker.wrap(async () => {
      await tracker.attach(mode); tracker.success(1); return {};
    }, '/images', 'image')(request(a.key));
    assert.equal(stats(a.apiKey.id).totals.succeeded, 1);
    assert.equal(stats(a.apiKey.id).totals.estimated_credits, null);
  }
});

test('same-account concurrent calls cannot double-charge a shared balance delta', async () => {
  const a = newKey(), b = newKey();
  const tracker = createUsageTracker(async () => 100);
  let release: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let attached = 0;
  const run = tracker.wrap(async () => {
    await tracker.attach('shared');
    if (++attached === 2) release();
    await gate; tracker.success(1); return {};
  }, '/images', 'image');
  await Promise.all([run(request(a.key)), run(request(b.key))]);
  for (const key of [a, b]) {
    assert.equal(stats(key.apiKey.id).recent[0].credit_status, 'concurrent');
    assert.equal(stats(key.apiKey.id).totals.estimated_credits, null);
  }
});

test('streaming stays running until generation completes and records exactly once', async () => {
  const a = newKey(); let credit = 100;
  const tracker = createUsageTracker(async () => credit);
  let finish: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const result = await tracker.wrap(async () => {
    await tracker.attach('stream');
    const body = new PassThrough();
    void gate.then(() => { credit -= 6; tracker.success(0, 1); body.end('data: [DONE]\n\n'); });
    return { body };
  }, '/v1/chat/completions', 'video')(request(a.key, 'video'));
  assert.equal(stats(a.apiKey.id).totals.running, 1);
  result.body.resume(); finish!(); await settled(a.apiKey.id);
  const totals = stats(a.apiKey.id).totals;
  assert.equal(totals.requests, 1); assert.equal(totals.succeeded, 1);
  assert.equal(totals.videos, 1); assert.equal(totals.estimated_credits, 6);
});

test('friendly error messages and streamed errors are not successful generations', async () => {
  for (const streaming of [false, true]) {
    const a = newKey();
    const tracker = createUsageTracker(async () => 100);
    const result = await tracker.wrap(async () => {
      if (!streaming) return { choices: [{ message: { content: 'generation failed' } }] };
      const body = new PassThrough(); body.end('data: generation failed\n\n'); return { body };
    }, '/v1/chat/completions', 'image')(request(a.key));
    result.body?.resume(); await settled(a.apiKey.id);
    assert.equal(stats(a.apiKey.id).totals.failed, 1);
  }
});

test('disconnected streams are interrupted, never successful or charged zero', async () => {
  const a = newKey();
  const tracker = createUsageTracker(async () => 100);
  const result = await tracker.wrap(async () => ({ body: new PassThrough() }), '/chat', 'image')(request(a.key));
  result.body.destroy(); await settled(a.apiKey.id);
  assert.equal(stats(a.apiKey.id).totals.interrupted, 1);
  assert.equal(stats(a.apiKey.id).totals.estimated_credits, null);
});

test('unused keys remain visible; revoked keys retain historical attribution', async () => {
  const a = newKey();
  assert.equal(stats(a.apiKey.id).keyStats[0].requests, 0);
  const tracker = createUsageTracker(async () => 1);
  await tracker.wrap(async () => { tracker.success(1); return {}; }, '/images', 'image')(request(a.key));
  db.deleteApiKey(a.apiKey.id);
  assert.equal(stats(a.apiKey.id).keyStats[0].deleted, true);
  assert.equal(stats(a.apiKey.id).keyStats[0].requests, 1);
});

test('time filters exclude older requests and never merge callers', async () => {
  const a = newKey();
  const tracker = createUsageTracker(async () => 1);
  await tracker.wrap(async () => { tracker.success(1); return {}; }, '/images', 'image')(request(a.key));
  const sql = new Database(process.env.DB_PATH!);
  sql.prepare('UPDATE usage_requests SET started_at = ? WHERE api_key_id = ?')
    .run(new Date(Date.now() - 8 * 86400000).toISOString(), a.apiKey.id);
  sql.close();
  assert.equal((db.getUsage(7, a.apiKey.id).totals as any).requests, 0);
  assert.equal((db.getUsage(30, a.apiKey.id).totals as any).requests, 1);
});

test('invalid and disabled API keys cannot create attributed usage', async () => {
  const a = newKey(); db.setApiKeyEnabled(a.apiKey.id, false);
  const tracker = createUsageTracker(async () => 1);
  const run = tracker.wrap(async () => { throw new Error('unauthorized'); }, '/images', 'image');
  await assert.rejects(run(request(a.key)));
  await assert.rejects(run(request('jm_invalid')));
  assert.equal(stats(a.apiKey.id).totals.requests, 0);
});

test('raw upstream tokens retain the legacy accounting path', async () => {
  const tracker = createUsageTracker(async () => assert.fail('raw token should not be sampled'));
  await tracker.wrap(async () => {
    assert.equal(tracker.tracked(), false);
    db.recordCall('legacy-token-for-test', 'legacy-model', 4, 96);
    return {};
  }, '/images', 'image')(request('legacy-token-for-test'));
  const legacy: any = db.getStats().modelStats.find((row: any) => row.model === 'legacy-model');
  assert.equal(legacy.total_calls, 1);
  assert.equal(legacy.total_credits, 4);
});
