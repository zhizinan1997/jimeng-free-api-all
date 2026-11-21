import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPoolScheduler } from './account-pool-scheduler.ts';

function fixture(file = ':memory:') {
  const db = new Database(file);
  db.exec(`CREATE TABLE IF NOT EXISTS jimeng_accounts (id TEXT PRIMARY KEY, name TEXT, enabled INTEGER, total_credit REAL, status_checked_at TEXT, status_error TEXT, cooldown_until TEXT, membership_json TEXT, last_used_at TEXT, updated_at TEXT, created_at TEXT)`);
  let balance = 250, fail = false, calls = 0;
  const scheduler = createPoolScheduler({ db,
    publicAccount: r => ({ id: r.id, name: r.name, enabled: !!r.enabled, lastUsedAt: r.last_used_at }),
    selection: id => ({ account: { id }, credential: 'virtual-cookie', sessionId: 'virtual-session' }),
    encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString(),
    refresh: async (id, token) => { calls++; if (fail) throw new Error('virtual upstream unavailable'); db.prepare('UPDATE jimeng_accounts SET total_credit=?,status_checked_at=?,status_error=NULL WHERE id=? AND calibration_token=?').run(balance, new Date().toISOString(), id, token); return { id }; }
  });
  function add(id, credit = 250) { db.prepare('INSERT INTO jimeng_accounts (id,name,enabled,total_credit,status_checked_at,created_at,priority) VALUES (?,?,1,?,?,?,?)').run(id, id, credit, new Date().toISOString(), new Date().toISOString(), db.prepare('SELECT COUNT(*) AS n FROM jimeng_accounts').get().n); }
  return { db, scheduler, add, setBalance: value => balance = value, failRefresh: value => fail = value, calls: () => calls };
}
const input = (id, estimate = 80, extra = {}) => ({ requestId: id, ownerHash: 'caller-a-hash', requestFingerprint: `fingerprint-${id}`, kind: 'image', model: 'standard', estimatedCredits: estimate, ...extra });
function finish(s, lease) { s.transitionTask(lease.taskId, { state: 'submitting' }); s.transitionTask(lease.taskId, { state: 'succeeded', result: { url: 'private-result' } }); }
function resolution(s, id, confirmation = 'upstream_not_created_or_failed') {
  const t = s.readTask(id, 'caller-a-hash');
  return { expectedState: t.state, expectedUpdatedAt: t.updatedAt, expectedAccountId: t.accountId, confirmation };
}

test('only overdue unacknowledged sends become unknown and a late receipt settles the same lease', async () => {
  const f = fixture();
  try {
    f.add('original', 500);
    const lease = await f.scheduler.acquireTask(input('late-receipt'));
    const other = await f.scheduler.acquireTask(input('other-send'));
    f.scheduler.transitionTask(other.taskId, { state: 'submitting' });
    f.scheduler.transitionTask(other.taskId, { state: 'submitted', upstreamTaskId: 'accepted' });
    f.scheduler.transitionTask(lease.taskId, { state: 'submitting' });
    const read = () => f.scheduler.readTask(lease.taskId, 'caller-a-hash');
    const sentAt = Date.parse(read().updatedAt);
    f.scheduler.scanTasksForMaintenance(sentAt + 119_999);
    assert.equal(read().state, 'submitting');
    f.scheduler.scanTasksForMaintenance(sentAt + 120_000);
    assert.equal(read().state, 'unknown');
    const events = f.scheduler.listEvents().total;
    f.scheduler.scanTasksForMaintenance(sentAt + 180_000);
    assert.equal(f.scheduler.listEvents().total, events);
    assert.equal(f.scheduler.readTask(other.taskId, 'caller-a-hash').state, 'submitted');
    const replay = await f.scheduler.acquireTask(input('late-receipt'));
    assert.equal(replay.taskId, lease.taskId);
    assert.equal(replay.state, 'unknown');
    assert.equal(f.scheduler.listTasks().total, 2);
    assert.equal(f.scheduler.getDashboard().summary.activeTaskCount, 2);
    f.scheduler.transitionTask(lease.taskId, { state: 'submitted', upstreamTaskId: 'original-late-id' });
    assert.equal(read().accountId, 'original');
    assert.equal(read().upstreamTaskId, 'original-late-id');
    assert.equal(read().error, null);
    f.scheduler.transitionTask(other.taskId, { state: 'succeeded' });
    f.scheduler.transitionTask(lease.taskId, { state: 'succeeded' });
    await f.scheduler.settleTask(lease.taskId);
    assert.equal(f.scheduler.getDashboard().summary.activeTaskCount, 0);
  } finally {
    f.db.close();
  }
});

test('200 is admission threshold, priority wins, preview never dispatches', async () => {
  const f = fixture(); f.add('a', 199); f.add('b', 200); f.add('c', 250);
  const before = JSON.stringify(f.db.prepare('SELECT * FROM jimeng_accounts').all());
  for (let i = 0; i < 3; i++) { assert.equal(f.scheduler.getDashboard().summary.nextAccountId, 'b'); f.scheduler.preview(); }
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM jimeng_accounts').all()), before);
  assert.equal(f.scheduler.listTasks().total, 0);
  const b = await f.scheduler.acquireTask(input('b', 200)); assert.equal(b.account.id, 'b');
  const c = await f.scheduler.acquireTask(input('c', 80)); assert.equal(c.account.id, 'c');
  assert.equal(f.scheduler.getDashboard().accounts.find(a => a.id === 'c').scheduling.availableCredits, 170);
  await assert.rejects(f.scheduler.acquireTask(input('none')), /没有符合/);
  f.db.close();
});

test('settings and full ordering use optimistic revision; fixed mode fails closed', async () => {
  const f = fixture(); f.add('a', 199); f.add('b', 500);
  let settings = f.scheduler.getSettings();
  assert.throws(() => f.scheduler.reorderAccounts({ accountIds: ['b','b'], revision: settings.revision }), /全部账号/);
  f.scheduler.reorderAccounts({ accountIds: ['b','a'], revision: settings.revision });
  assert.equal(f.scheduler.preview().account.id, 'b');
  assert.throws(() => f.scheduler.updateSettings(settings), e => e.statusCode === 409);
  settings = f.scheduler.updateSettings({ ...f.scheduler.getSettings(), mode: 'fixed', fixedAccountId: 'a' });
  await assert.rejects(f.scheduler.acquireTask(input('fixed')), /指定账号不合格/);
  assert.throws(() => f.scheduler.updateSettings({ ...settings, threshold: '200' }), /无效/);
  f.db.close();
});

test('concurrent acquisitions are atomic and unknown-cost tasks are exclusive', async () => {
  const f = fixture(); f.add('a', 250);
  const outcomes = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => f.scheduler.acquireTask(input(`race-${i}`))));
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(f.scheduler.listRecoverableTasks().length, 1);
  f.add('b', 1000);
  const unknown = await f.scheduler.acquireTask(input('unknown', null)); assert.equal(unknown.account.id, 'b');
  await assert.rejects(f.scheduler.acquireTask(input('blocked', 0)), /没有符合/);
  assert.equal(f.scheduler.getDashboard().accounts.find(a => a.id === 'b').scheduling.unknownCostBusy, true);
  f.db.close();
});

test('idempotency is caller-scoped; uncertain submission and ownership survive lifecycle', async () => {
  const f = fixture(); f.add('a', 1000);
  const lease = await f.scheduler.acquireTask(input('same'));
  f.scheduler.transitionTask(lease.taskId, { state: 'submitting' });
  f.scheduler.transitionTask(lease.taskId, { state: 'unknown', error: 'secret-cookie prompt secret' });
  const again = await f.scheduler.acquireTask(input('same')); assert.equal(again.taskId, lease.taskId); assert.equal(again.reused, true); assert.equal(again.state, 'unknown');
  await assert.rejects(f.scheduler.acquireTask(input('same', 80, { requestFingerprint: 'changed' })), e => e.statusCode === 409);
  assert.throws(() => f.scheduler.readTask(lease.taskId, 'other-owner'), e => e.statusCode === 403);
  await assert.rejects(f.scheduler.settleTask(lease.taskId), /不能释放/);
  assert.throws(() => f.scheduler.assertMutable('a'), /禁止删除/);
  f.db.prepare('UPDATE jimeng_accounts SET enabled=0 WHERE id=?').run('a');
  assert.equal(f.scheduler.readTaskCredential(lease.taskId, 'caller-a-hash').sessionId, 'virtual-session');
  f.scheduler.transitionTask(lease.taskId, { state: 'submitted', upstreamTaskId: 'upstream-1' });
  assert.throws(() => f.scheduler.transitionTask(lease.taskId, { state: 'running', upstreamTaskId: 'wrong' }), /不能替换/);
  assert.equal(JSON.stringify(f.scheduler.getDashboard()).includes('secret-cookie'), false);
  f.db.close();
});

test('settlement calibrates once after all tasks finish, preserves occupancy on failure', async () => {
  const f = fixture(); f.add('a', 1000);
  const a = await f.scheduler.acquireTask(input('first', 100)), b = await f.scheduler.acquireTask(input('second', 100));
  finish(f.scheduler, a);
  await assert.rejects(f.scheduler.settleTask(a.taskId), /未结算/);
  assert.equal(f.calls(), 0);
  finish(f.scheduler, b); f.failRefresh(true);
  await assert.rejects(f.scheduler.settleTask(b.taskId));
  assert.equal(f.scheduler.getDashboard().summary.activeTaskCount, 2);
  f.failRefresh(false); f.setBalance(800);
  await f.scheduler.settleTask(b.taskId);
  assert.equal(f.scheduler.getDashboard().accounts[0].scheduling.availableCredits, 800);
  assert.equal(f.scheduler.getDashboard().summary.activeTaskCount, 0);
  const calls = f.calls(); await f.scheduler.settleTask(a.taskId); assert.equal(f.calls(), calls);
  assert.deepEqual(f.scheduler.readTaskResult(a.taskId, 'caller-a-hash'), { url: 'private-result' });
  assert.equal(JSON.stringify(f.scheduler.getDashboard()).includes('private-result'), false);
  f.db.close();
});

test('stale balance refresh failure does not silently become zero or eligible', async () => {
  const f = fixture(); f.add('a', 400);
  f.db.prepare("UPDATE jimeng_accounts SET status_checked_at='2000-01-01T00:00:00.000Z'").run();
  f.failRefresh(true);
  assert.equal(f.scheduler.getDashboard().accounts[0].scheduling.availableCredits, null);
  await assert.rejects(f.scheduler.acquireTask(input('stale')), /没有符合/);
  assert.equal(f.db.prepare('SELECT total_credit FROM jimeng_accounts').get().total_credit, 400);
  f.failRefresh(false); await f.scheduler.acquireTask(input('fresh')); assert.equal(f.calls(), 2);
  f.db.close();
});

test('fresh process recovers policy, upstream binding, occupancy and encrypted result; migration preserves rows', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jimeng-A-scheduler-')), file = path.join(dir, 'pool.db');
  const f = fixture(file); f.add('a', 500);
  const lease = await f.scheduler.acquireTask(input('restart', null));
  f.scheduler.transitionTask(lease.taskId, { state: 'submitting' }); f.scheduler.transitionTask(lease.taskId, { state: 'submitted', upstreamTaskId: 'history-1' });
  f.scheduler.updateSettings({ ...f.scheduler.getSettings(), mode: 'fixed', fixedAccountId: 'a', threshold: 210 }); f.db.close();
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import Database from 'better-sqlite3'; import {createPoolScheduler} from ${JSON.stringify(new URL('./account-pool-scheduler.ts', import.meta.url).href)};
    const db = new Database(process.argv[1]); const s = createPoolScheduler({db,publicAccount:r=>({id:r.id}),selection:id=>({account:{id},credential:'virtual',sessionId:'virtual'}),refresh:async()=>{throw Error('must not refresh')},encrypt:v=>v,decrypt:v=>v});
    if (s.getSettings().threshold!==210 || s.listRecoverableTasks()[0].upstreamTaskId!=='history-1' || !s.getDashboard().accounts[0].scheduling.unknownCostBusy) throw Error('recovery failed');
    db.close();`, file], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  fs.rmSync(dir, { recursive: true });
});

test('accounts preserve manual ordering and input balances in scheduling view', () => {
  const f = fixture(); f.add('a', 345); f.add('b', 678);
  assert.deepEqual(f.scheduler.getDashboard().accounts.map(a => a.id), ['a','b']);
  assert.equal(f.db.prepare('SELECT total_credit FROM jimeng_accounts WHERE id=?').get('b').total_credit, 678);
  f.db.close();
});

test('an 80-credit quote skips a 50-credit account and reserves the 100-credit backup', async t => {
  const f = fixture(); t.after(() => f.db.close());
  f.add('primary',50); f.add('backup',100);
  f.scheduler.updateSettings({...f.scheduler.getSettings(),threshold:40});
  const lease = await f.scheduler.acquireTask(input('known-cost',80));
  assert.equal(lease.account.id,'backup');
  assert.equal(f.scheduler.getDashboard().accounts.find(account => account.id === 'backup').scheduling.availableCredits,20);
  assert.equal(f.scheduler.readTask(lease.taskId,'caller-a-hash').estimatedCredits,80);
});

test('credit rejection reassigns the same task once per subject and persists exhausted decisions', async t => {
  const f = fixture(); t.after(() => f.db.close());
  f.add('a',50); f.add('a-peer',50); f.add('b',100);
  const identity = JSON.stringify({verified:true,userId:'same-a'});
  f.db.prepare('UPDATE jimeng_accounts SET identity_json=? WHERE id IN (?,?)').run(identity,'a','a-peer');
  f.scheduler.updateSettings({...f.scheduler.getSettings(),threshold:40});
  const lease = await f.scheduler.acquireTask(input('relay',null));
  f.scheduler.transitionTask(lease.taskId,{state:'submitting'});
  assert.throws(() => f.scheduler.rejectTaskForCredits(lease.taskId,'foreign','a'), /无权/);
  f.scheduler.rejectTaskForCredits(lease.taskId,'caller-a-hash','a');
  assert.equal(f.scheduler.getDashboard().summary.activeTaskCount,0);
  const next = await f.scheduler.retryTaskAfterCreditRejection(lease.taskId,'caller-a-hash','a');
  assert.equal(next.lease.taskId,lease.taskId); assert.equal(next.lease.account.id,'b');
  assert.equal(f.scheduler.listTasks().total,1);
  await assert.rejects(() => f.scheduler.retryTaskAfterCreditRejection(lease.taskId,'caller-a-hash','a'), /明确积分拒单记录/);
  f.scheduler.transitionTask(lease.taskId,{state:'submitting'});
  f.scheduler.rejectTaskForCredits(lease.taskId,'caller-a-hash','b');
  const exhausted = await f.scheduler.retryTaskAfterCreditRejection(lease.taskId,'caller-a-hash','b');
  assert.equal(exhausted.lease,null); assert.equal(exhausted.code,'insufficient_credits_exhausted');
  const replay = await f.scheduler.acquireTask(input('relay',null));
  assert.equal(replay.reused,true); assert.equal(replay.state,'failed');
  assert.equal(f.scheduler.getDashboard().summary.activeTaskCount,0);
});

test('fixed policy, asset affinity, and acknowledged or unknown submissions prevent reassignment', async t => {
  for (const policy of ['fixed','asset','accepted','unknown']) await t.test(policy, async () => {
    const f = fixture();
    try {
      f.add('a',500); f.add('b',500);
      f.scheduler.updateSettings({...f.scheduler.getSettings(),mode:policy === 'fixed' ? 'fixed':'auto',fixedAccountId:policy === 'fixed' ? 'a':null});
      const lease = await f.scheduler.acquireTask(input(policy,null,policy === 'asset' ? {preferredAccountId:'a'}:{}));
      f.scheduler.transitionTask(lease.taskId,{state:'submitting'});
      if (policy === 'accepted' || policy === 'unknown') {
        f.scheduler.transitionTask(lease.taskId,{state:policy === 'accepted' ? 'submitted':'unknown',...(policy === 'accepted' ? {upstreamTaskId:'accepted-id'}:{})});
        assert.throws(() => f.scheduler.rejectTaskForCredits(lease.taskId,'caller-a-hash','a'), /无法按积分拒单/);
        assert.equal(f.scheduler.readTask(lease.taskId,'caller-a-hash').accountId,'a');
      } else {
        f.scheduler.rejectTaskForCredits(lease.taskId,'caller-a-hash','a');
        const stopped = await f.scheduler.retryTaskAfterCreditRejection(lease.taskId,'caller-a-hash','a');
        assert.equal(stopped.lease,null);
        assert.equal(stopped.code,policy === 'fixed' ? 'fixed_account_insufficient':'reference_account_bound');
      }
    } finally { f.db.close(); }
  });
});

test('reassignment respects the original candidate bound and concurrent account occupancy', async t => {
  const f = fixture(); t.after(() => f.db.close());
  f.add('a',500); f.add('b',500);
  const rejected = await f.scheduler.acquireTask(input('rejected',null));
  const busy = await f.scheduler.acquireTask(input('busy',null));
  f.add('later-account',1000);
  f.scheduler.transitionTask(rejected.taskId,{state:'submitting'});
  f.scheduler.rejectTaskForCredits(rejected.taskId,'caller-a-hash','a');
  const decision = await f.scheduler.retryTaskAfterCreditRejection(rejected.taskId,'caller-a-hash','a');
  assert.equal(decision.lease,null); assert.equal(decision.code,'no_executable_account');
  assert.equal(f.scheduler.readTask(busy.taskId,'caller-a-hash').accountId,'b');
  assert.equal(f.scheduler.getDashboard().summary.activeTaskCount,1);
});

test('readTaskForRecovery returns task, ownerHash and selection across disabled account and checks credential version', async () => {
  const f = fixture(); f.add('a', 500);
  const lease = await f.scheduler.acquireTask(input('rec', 80));
  f.scheduler.transitionTask(lease.taskId, { state: 'submitting' });
  f.scheduler.transitionTask(lease.taskId, { state: 'submitted', upstreamTaskId: 'up-rec-1' });
  f.db.prepare('UPDATE jimeng_accounts SET enabled=0 WHERE id=?').run('a');
  const rec = f.scheduler.readTaskForRecovery(lease.taskId);
  assert.equal(rec.task.id, lease.taskId);
  assert.equal(rec.task.upstreamTaskId, 'up-rec-1');
  assert.equal(rec.ownerHash, 'caller-a-hash');
  assert.equal(rec.selection.account.id, 'a');
  assert.equal(rec.selection.sessionId, 'virtual-session');
  assert.throws(() => f.scheduler.readTaskForRecovery('missing-id'), e => e.statusCode === 404);
  f.db.prepare('UPDATE jimeng_accounts SET credential_version=credential_version+1 WHERE id=?').run('a');
  assert.throws(() => f.scheduler.readTaskForRecovery(lease.taskId), e => e.statusCode === 409 && /版本已变更/.test(e.message));
  f.db.close();
});

test('duplicate session_hash or verified upstream userId share occupancy and reject duplicate scheduling', async () => {
  const f = fixture(); f.add('a', 250); f.add('b', 250);
  const identity = JSON.stringify({ verified: true, userId: 'shared-uid', displayName: 'Shared', checkedAt: new Date().toISOString() });
  f.db.prepare('UPDATE jimeng_accounts SET identity_json=? WHERE id IN (?,?)').run(identity, 'a', 'b');
  const snap = f.scheduler.getDashboard();
  assert.equal(snap.accounts.length, 2);
  assert.equal(snap.accounts[0].scheduling.eligible, true);
  assert.equal(snap.accounts[1].scheduling.eligible, false);
  assert.match(snap.accounts[1].scheduling.reason, /同一上游身份/);
  const lease = await f.scheduler.acquireTask(input('uniq-1', null));
  assert.equal(lease.account.id, 'a');
  await assert.rejects(f.scheduler.acquireTask(input('uniq-2', null)), e => e.statusCode === 409);
  await assert.rejects(f.scheduler.acquireTask(input('uniq-pref', null, { preferredAccountId: 'b' })), e => e.statusCode === 409);
  f.db.prepare('UPDATE jimeng_accounts SET enabled=0 WHERE id=?').run('a');
  const afterDisable = f.scheduler.getDashboard();
  assert.equal(afterDisable.accounts[1].scheduling.eligible, false);
  assert.equal(afterDisable.accounts[1].scheduling.unknownCostBusy, true);
  await assert.rejects(f.scheduler.acquireTask(input('uniq-after-disable', null)), e => e.statusCode === 409);
  assert.equal(f.scheduler.readTaskForRecovery(lease.taskId).selection.account.id, 'a');
  f.db.close();
});

test('settle atomically syncs same-subject peer balance and enforces 200 threshold after disabling primary', async () => {
  const f = fixture(); f.add('a', 250); f.add('b', 250); f.add('c', 250);
  const identity = JSON.stringify({ verified: true, userId: 'shared-uid', displayName: 'Shared', checkedAt: new Date().toISOString() });
  f.db.prepare('UPDATE jimeng_accounts SET identity_json=? WHERE id IN (?,?,?)').run(identity, 'a', 'b', 'c');
  // c has no checked timestamp yet: settling a must not fabricate credential freshness for c.
  f.db.prepare('UPDATE jimeng_accounts SET status_checked_at=NULL, total_credit=NULL WHERE id=?').run('c');
  f.db.prepare('UPDATE jimeng_accounts SET session_hash=? WHERE id=?').run('hash-a', 'a');
  f.db.prepare('UPDATE jimeng_accounts SET session_hash=? WHERE id=?').run('hash-b', 'b');
  f.db.prepare('UPDATE jimeng_accounts SET session_hash=? WHERE id=?').run('hash-c', 'c');

  const lease = await f.scheduler.acquireTask(input('sync-1', 80));
  assert.equal(lease.account.id, 'a');
  finish(f.scheduler, lease);
  f.setBalance(170);
  await f.scheduler.settleTask(lease.taskId);

  assert.equal(f.db.prepare('SELECT total_credit FROM jimeng_accounts WHERE id=?').get('b').total_credit, 170);
  assert.equal(f.db.prepare('SELECT total_credit, status_checked_at FROM jimeng_accounts WHERE id=?').get('c').status_checked_at, null);
  f.db.prepare('UPDATE jimeng_accounts SET enabled=0 WHERE id=?').run('a');

  const snap = f.scheduler.getDashboard();
  const peerB = snap.accounts.find(x => x.id === 'b');
  const peerC = snap.accounts.find(x => x.id === 'c');
  assert.equal(peerB.scheduling.availableCredits, 170);
  assert.equal(peerB.scheduling.eligible, false);
  assert.match(peerB.scheduling.reason, /接单门槛/);
  assert.equal(peerC.scheduling.eligible, false);
  assert.equal(peerC.scheduling.availableCredits, null);
  assert.match(peerC.scheduling.reason, /同一上游身份/);
  assert.equal(snap.summary.nextAccountId, null);

  const callsBefore = f.calls();
  // Even if b's status_checked_at is still fresh (no refresh called), b has 170 and cannot bypass 200 threshold.
  await assert.rejects(f.scheduler.acquireTask(input('sync-2', 50)), e => e.statusCode === 409);
  assert.equal(f.calls(), callsBefore);

  // After disabling b too, c still has no fabricated status_checked_at and remains ineligible.
  f.db.prepare('UPDATE jimeng_accounts SET enabled=0 WHERE id=?').run('b');
  const snapAfterBDisabled = f.scheduler.getDashboard();
  const peerCAlone = snapAfterBDisabled.accounts.find(x => x.id === 'c');
  assert.equal(peerCAlone.scheduling.eligible, false);
  assert.match(peerCAlone.scheduling.reason, /余额未知或已过期/);
  f.db.close();
});

test('unknown membership allows -vip models while explicit non-vip rejects', async () => {
  const f = fixture(); f.add('unk', 500); f.add('nonvip', 500);
  f.db.prepare('UPDATE jimeng_accounts SET membership_json=? WHERE id=?').run(JSON.stringify('unknown'), 'unk');
  f.db.prepare('UPDATE jimeng_accounts SET membership_json=? WHERE id=?').run(JSON.stringify({ isVip: false }), 'nonvip');
  const vipLease = await f.scheduler.acquireTask(input('vip-unk', 50, { kind: 'video', model: 'jimeng-video-seedance-2.0-vip' }));
  assert.equal(vipLease.account.id, 'unk');
  finish(f.scheduler, vipLease); await f.scheduler.settleTask(vipLease.taskId);
  f.db.prepare('UPDATE jimeng_accounts SET enabled=0 WHERE id=?').run('unk');
  await assert.rejects(
    f.scheduler.acquireTask(input('vip-nonvip', 50, { kind: 'video', model: 'jimeng-video-seedance-2.0-fast-vip' })),
    err => err.statusCode === 409 && /没有符合条件的即梦账号（.*nonvip：该模型所需会员权益未核验/.test(err.message)
  );
  f.db.close();
});

test('free text tasks are not blocked by unknown-cost media occupancy and stale held cache', async () => {
  const f = fixture(); f.add('a', 500); f.add('b', 100);
  f.db.prepare('UPDATE jimeng_accounts SET enabled=0 WHERE id=?').run('b');
  const mediaLease = await f.scheduler.acquireTask(input('media-1', null, { kind: 'video', model: 'jimeng-video-seedance-2.0' }));
  assert.equal(mediaLease.account.id, 'a');
  f.db.prepare("UPDATE jimeng_accounts SET status_checked_at='2000-01-01T00:00:00.000Z' WHERE id='a'").run();
  // Paid/media requests still fail closed with per-account reason summary.
  await assert.rejects(
    f.scheduler.acquireTask(input('media-2', 0, { kind: 'image', model: 'jimeng-image-5.0-lite' })),
    err => err.statusCode === 409 && /没有符合条件的即梦账号（a：余额未知或已过期；b：账号已停用）/.test(err.message)
  );
  // Free text chat can still use the account while media holds it.
  const textLease = await f.scheduler.acquireTask(input('text-1', 0, { kind: 'text', model: 'doubao-2.1-lite' }));
  assert.equal(textLease.account.id, 'a');
  f.db.close();
});

test('stale reserved tasks auto-fail in maintenance and resolveStuckTask frees unknown occupancy', async () => {
  const f = fixture(); f.add('a', 500);
  const staleReserved = await f.scheduler.acquireTask(input('stale-res', null, { kind: 'video' }));
  const oldStamp = new Date(Date.now() - 180_000).toISOString();
  f.db.prepare('UPDATE pool_tasks SET updated_at=? WHERE id=?').run(oldStamp, staleReserved.taskId);
  const recoverable = f.scheduler.scanTasksForMaintenance(Date.now());
  assert.equal(recoverable.find(t => t.id === staleReserved.taskId)?.state, 'failed');
  assert.throws(() => f.scheduler.transitionTask(staleReserved.taskId, { state: 'submitting' }), /不允许/);
  await f.scheduler.settleTask(staleReserved.taskId);

  const stuckUnknown = await f.scheduler.acquireTask(input('stuck-unk', null, { kind: 'video' }));
  f.scheduler.transitionTask(stuckUnknown.taskId, { state: 'submitting' });
  f.scheduler.transitionTask(stuckUnknown.taskId, { state: 'unknown' });
  assert.equal(f.scheduler.getDashboard().accounts[0].scheduling.unknownCostBusy, true);
  const resolved = await f.scheduler.resolveStuckTask(stuckUnknown.taskId, resolution(f.scheduler, stuckUnknown.taskId), 'admin:tester');
  assert.equal(resolved.state, 'failed');
  assert.equal(resolved.settling, false);
  assert.equal(f.scheduler.getDashboard().accounts[0].scheduling.unknownCostBusy, false);
  assert.ok(f.scheduler.listEvents().items.some(e => e.type === 'task_resolved' && e.actor === 'admin:tester'));
  f.db.close();
});

test('zero-cost text and uploads do not block media in either admission order or settlement', async () => {
  const f = fixture(); f.add('a', 500);
  try {
    const text = await f.scheduler.acquireTask(input('text-first', 0, { kind: 'text' }));
    const upload = await f.scheduler.acquireTask(input('upload-first', 0, { kind: 'upload' }));
    const media = await f.scheduler.acquireTask(input('media-second', null, { kind: 'video' }));
    const upload2 = await f.scheduler.acquireTask(input('upload-during-media', 0, { kind: 'upload' }));
    const text2 = await f.scheduler.acquireTask(input('text-during-media', 0, { kind: 'text' }));
    assert.equal(new Set([text, upload, media, upload2, text2].map(t => t.account.id)).size, 1);
    // Media remains exclusive against other media, never against zero-cost work.
    await assert.rejects(f.scheduler.acquireTask(input('other-media', null)), /未知费用/);
    const calls = f.calls();
    finish(f.scheduler, text); await f.scheduler.settleTask(text.taskId);
    assert.equal(f.calls(), calls);
    assert.equal(f.scheduler.getDashboard().summary.activeTaskCount, 4);
    assert.throws(() => f.scheduler.assertMutable('a'), /禁止删除/);
    finish(f.scheduler, media); await f.scheduler.settleTask(media.taskId);
    assert.equal(f.calls(), calls + 1);
    assert.equal(f.scheduler.getDashboard().summary.activeTaskCount, 3);
    // Stale balance can be refreshed with only live zero-cost operations.
    f.db.prepare("UPDATE jimeng_accounts SET status_checked_at='2000-01-01T00:00:00.000Z' WHERE id='a'").run();
    const nextMedia = await f.scheduler.acquireTask(input('media-after-settle', null));
    assert.equal(nextMedia.account.id, 'a');
    assert.equal(f.calls(), calls + 2);
  } finally { f.db.close(); }
});

test('zero-cost work preserves legacy unknown costs and explicit provider concurrency limits', async () => {
  const f = fixture(); f.add('a', 500);
  try {
    const legacy = await f.scheduler.acquireTask(input('legacy-text-unknown', null, { kind: 'text' }));
    await assert.rejects(f.scheduler.acquireTask(input('media-blocked-by-legacy', null)), /未知费用/);
    f.db.prepare('UPDATE jimeng_accounts SET membership_json=? WHERE id=?').run(JSON.stringify({ maxConcurrentTasks: 1 }), 'a');
    await assert.rejects(f.scheduler.acquireTask(input('free-but-provider-limited', 0, { kind: 'upload' })), /已达账号并发限制/);
    assert.equal(f.scheduler.readTask(legacy.taskId, 'caller-a-hash').estimatedCredits, null);
  } finally { f.db.close(); }
});

test('manual release requires confirmation and rejects all active or provider-bound states', async () => {
  const f = fixture(); f.add('a', 500);
  try {
    const lease = await f.scheduler.acquireTask(input('active-release-denied', null));
    await assert.rejects(f.scheduler.resolveStuckTask(lease.taskId, undefined), /核对确认/);
    for (const state of ['reserved','submitting','submitted','running','unknown']) {
      if (state !== 'reserved') f.scheduler.transitionTask(lease.taskId, {
        state, ...(state === 'submitted' ? { upstreamTaskId: 'already-accepted' } : {})
      });
      await assert.rejects(f.scheduler.resolveStuckTask(lease.taskId, resolution(f.scheduler, lease.taskId), 'admin:tester'), e => e.statusCode === 409);
      assert.equal(f.db.prepare('SELECT held FROM pool_tasks WHERE id=?').get(lease.taskId).held, 1);
      assert.equal(f.scheduler.readTask(lease.taskId, 'caller-a-hash').state, state);
    }
    assert.equal(f.scheduler.listEvents().items.some(e => e.type === 'task_resolved'), false);
  } finally { f.db.close(); }
});

test('late receipt, changed account/version, and simultaneous manual releases fail closed', async () => {
  const f = fixture(); f.add('a', 500);
  try {
    const lease = await f.scheduler.acquireTask(input('release-race', null));
    f.scheduler.transitionTask(lease.taskId, { state: 'submitting' });
    f.scheduler.transitionTask(lease.taskId, { state: 'unknown' });
    const snapshot = resolution(f.scheduler, lease.taskId);
    await assert.rejects(f.scheduler.resolveStuckTask(lease.taskId, { ...snapshot, expectedAccountId: 'old-account' }), /已变化/);
    await assert.rejects(f.scheduler.resolveStuckTask(lease.taskId, { ...snapshot, expectedUpdatedAt: '2000-01-01T00:00:00.000Z' }), /已变化/);
    f.scheduler.transitionTask(lease.taskId, { state: 'submitted', upstreamTaskId: 'late-receipt' });
    await assert.rejects(f.scheduler.resolveStuckTask(lease.taskId, snapshot), /已变化/);
    f.scheduler.transitionTask(lease.taskId, { state: 'succeeded', result: { urls: ['https://fixture.invalid/result'] } });
    const terminalSnapshot = resolution(f.scheduler, lease.taskId, 'balance_reconciliation');
    const outcomes = await Promise.allSettled([1, 2].map(() => f.scheduler.resolveStuckTask(lease.taskId, terminalSnapshot, 'admin:tester')));
    // Only one refresh can acquire the calibration lease; no outcome changes success to failure.
    assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
    const after = f.scheduler.readTask(lease.taskId, 'caller-a-hash');
    assert.equal(after.state, 'succeeded'); assert.equal(after.upstreamTaskId, 'late-receipt'); assert.equal(after.settling, false);
  } finally { f.db.close(); }
});

test('manual release retains settling slot on refresh failure and permits confirmed reconciliation retry', async () => {
  const f = fixture(); f.add('a', 500);
  try {
    const lease = await f.scheduler.acquireTask(input('manual-refresh-fails', null));
    f.scheduler.transitionTask(lease.taskId, { state: 'submitting' });
    f.scheduler.transitionTask(lease.taskId, { state: 'unknown' });
    const snapshot = resolution(f.scheduler, lease.taskId);
    f.failRefresh(true);
    await assert.rejects(f.scheduler.resolveStuckTask(lease.taskId, snapshot, 'admin:tester'), /unavailable/);
    const after = f.scheduler.readTask(lease.taskId, 'caller-a-hash');
    assert.equal(after.state, 'failed'); assert.equal(after.settling, true);
    await assert.rejects(f.scheduler.resolveStuckTask(lease.taskId, snapshot, 'admin:tester'), /已变化/);
    f.failRefresh(false);
    const retry = await f.scheduler.resolveStuckTask(lease.taskId, resolution(f.scheduler, lease.taskId, 'balance_reconciliation'), 'admin:tester');
    assert.equal(retry.state, 'failed'); assert.equal(retry.settling, false);
    assert.equal((await f.scheduler.acquireTask(input('after-release', null))).account.id, 'a');
  } finally { f.db.close(); }
});
