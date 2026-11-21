import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createPoolScheduler } from '../../src/lib/account-pool-scheduler.ts';

function fixture(file = ':memory:') {
  const db = new Database(file);
  db.exec(`CREATE TABLE IF NOT EXISTS jimeng_accounts (
    id TEXT PRIMARY KEY, name TEXT, enabled INTEGER, total_credit REAL, status_checked_at TEXT, status_error TEXT,
    credential_kind TEXT, credential_hash TEXT, session_hash TEXT, credential_ciphertext TEXT, credential_version INTEGER,
    cooldown_until TEXT, membership_json TEXT, identity_json TEXT, last_used_at TEXT, priority INTEGER, created_at TEXT, updated_at TEXT
  )`);
  let balance = 250, fail = false;
  const scheduler = createPoolScheduler({ db,
    publicAccount: r => ({ id: r.id, name: r.name, enabled: !!r.enabled, lastUsedAt: r.last_used_at }),
    selection: id => ({ account: { id }, credential: `cookie-${id}`, sessionId: `session-${id}` }),
    encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString(),
    refresh: async (id, token) => { if (fail) throw new Error('upstream unavailable'); db.prepare('UPDATE jimeng_accounts SET total_credit=?,status_checked_at=?,status_error=NULL WHERE id=?').run(balance, new Date().toISOString(), id); return { id }; }
  });
  function add(id, credit = 250) { db.prepare('INSERT INTO jimeng_accounts (id,name,enabled,total_credit,status_checked_at,created_at,priority,credential_version) VALUES (?,?,1,?,?,?,?,1)').run(id, id, credit, new Date().toISOString(), new Date().toISOString(), db.prepare('SELECT COUNT(*) FROM jimeng_accounts').get()['COUNT(*)']); }
  return { db, scheduler, add, setBalance: value => balance = value, failRefresh: value => fail = value };
}

test('threshold 39/40/41 boundary admits only balances at or above 40 with payable estimates', async () => {
  const f = fixture();
  f.add('a', 39);
  f.add('b', 40);
  f.add('c', 41);

  let settings = f.scheduler.getSettings();
  assert.equal(settings.threshold, 200);

  settings = f.scheduler.updateSettings({ ...settings, threshold: 40 });
  assert.equal(settings.threshold, 40);

  const dash = f.scheduler.getDashboard();
  const a = dash.accounts.find(x => x.id === 'a');
  const b = dash.accounts.find(x => x.id === 'b');
  const c = dash.accounts.find(x => x.id === 'c');

  assert.equal(a.scheduling.eligible, false);
  assert.match(a.scheduling.reason, /接单门槛/);
  assert.equal(b.scheduling.eligible, true);
  assert.equal(c.scheduling.eligible, true);

  const lease = await f.scheduler.acquireTask({
    requestId: 'boundary-1', ownerHash: 'owner-hash', requestFingerprint: 'fp-1',
    kind: 'video', model: 'm', estimatedCredits: 40
  });
  assert.equal(lease.account.id, 'b');

  assert.equal(f.scheduler.getDashboard().accounts.find(x => x.id === 'b').scheduling.availableCredits, 0);
  const second = await f.scheduler.acquireTask({
    requestId: 'boundary-2', ownerHash: 'owner-hash', requestFingerprint: 'fp-2',
    kind: 'video', model: 'm', estimatedCredits: 41
  });
  assert.equal(second.account.id, 'c');

  f.db.close();
});

test('a 40 point threshold does not waive an 80 point estimated cost', async () => {
  const f = fixture();
  f.add('forty', 40);
  f.add('forty-one', 41);
  f.scheduler.updateSettings({ ...f.scheduler.getSettings(), threshold: 40 });
  await assert.rejects(f.scheduler.acquireTask({
    requestId: 'too-expensive', ownerHash: 'owner-hash', requestFingerprint: 'fp-too-expensive',
    kind: 'video', model: 'm', estimatedCredits: 80
  }), error => error.statusCode === 409 && /没有符合条件/.test(error.message));
  const settings = f.scheduler.getSettings();
  f.scheduler.updateSettings({ ...settings, mode: 'fixed', fixedAccountId: 'forty-one' });
  await assert.rejects(f.scheduler.acquireTask({
    requestId: 'too-expensive-fixed', ownerHash: 'owner-hash', requestFingerprint: 'fp-too-expensive-fixed',
    kind: 'video', model: 'm', estimatedCredits: 80
  }), error => error.statusCode === 409 && /可用积分不足预估费用/.test(error.message));
  assert.equal(f.scheduler.listTasks().total, 0);
  f.db.close();
});

test('an unsettled reservation below threshold routes the next affordable task to backup', async t => {
  const f = fixture();
  t.after(() => f.db.close());
  f.add('primary', 41);
  f.add('backup', 40);
  f.scheduler.updateSettings({ ...f.scheduler.getSettings(), threshold: 40 });
  const request = { ownerHash: 'owner-hash', kind: 'image', model: 'm', estimatedCredits: 2 };
  const first = await f.scheduler.acquireTask({
    ...request, requestId: 'held-first', requestFingerprint: 'held-1'
  });
  assert.equal(first.account.id, 'primary');
  const primary = f.scheduler.getDashboard().accounts.find(account => account.id === 'primary');
  assert.equal(primary.scheduling.reservedCredits, 2);
  assert.equal(primary.scheduling.availableCredits, 39);
  assert.match(primary.scheduling.reason, /低于接单门槛/);

  const second = await f.scheduler.acquireTask({
    ...request, requestId: 'held-next', requestFingerprint: 'held-2'
  });
  assert.equal(second.account.id, 'backup');
  const original = f.scheduler.readTask(first.taskId, request.ownerHash);
  assert.equal(original.state, 'reserved');
  assert.equal(original.accountId, 'primary');
});

test('cross-line switching: 250 -> lease 80 -> 170; then 60-cost new lease triggers auto-switch', async t => {
  const f = fixture();
  f.add('primary', 250);
  f.add('backup', 200);

  let settings = f.scheduler.getSettings();
  settings = f.scheduler.updateSettings({ ...settings, threshold: 200 });

  const lease1 = await f.scheduler.acquireTask({
    requestId: 'switch-1', ownerHash: 'owner-hash', requestFingerprint: 'fp-1',
    kind: 'image', model: 'm', estimatedCredits: 80
  });
  assert.equal(lease1.account.id, 'primary');

  f.scheduler.transitionTask(lease1.taskId, { state: 'submitting' });
  f.scheduler.transitionTask(lease1.taskId, { state: 'succeeded' });
  f.setBalance(170);
  await f.scheduler.settleTask(lease1.taskId);

  const dash = f.scheduler.getDashboard();
  assert.equal(dash.accounts.find(x => x.id === 'primary').scheduling.eligible, false);
  assert.equal(dash.accounts.find(x => x.id === 'backup').scheduling.eligible, true);
  assert.equal(dash.summary.nextAccountId, 'backup');

  const lease2 = await f.scheduler.acquireTask({
    requestId: 'switch-2', ownerHash: 'owner-hash', requestFingerprint: 'fp-2',
    kind: 'image', model: 'm', estimatedCredits: 60
  });
  assert.equal(lease2.account.id, 'backup');
  assert.equal(f.scheduler.getDashboard().summary.lastSwitch?.fromAccountId, 'primary');
  assert.equal(f.scheduler.getDashboard().summary.lastSwitch?.toAccountId, 'backup');

  f.db.close();
});

test('raising and lowering the threshold changes actual admission', async () => {
  const f = fixture();
  f.add('first', 41);
  f.add('second', 60);
  let settings = f.scheduler.updateSettings({ ...f.scheduler.getSettings(), threshold: 40 });
  assert.equal(f.scheduler.getDashboard().summary.nextAccountId, 'first');
  settings = f.scheduler.updateSettings({ ...settings, threshold: 50 });
  assert.equal(f.scheduler.getDashboard().summary.nextAccountId, 'second');
  const high = await f.scheduler.acquireTask({
    requestId: 'raised', ownerHash: 'owner-hash', requestFingerprint: 'fp-raised',
    kind: 'image', model: 'm', estimatedCredits: 1
  });
  assert.equal(high.account.id, 'second');
  settings = f.scheduler.updateSettings({ ...settings, threshold: 40 });
  assert.equal(f.scheduler.getDashboard().summary.nextAccountId, 'first');
  const low = await f.scheduler.acquireTask({
    requestId: 'lowered', ownerHash: 'owner-hash', requestFingerprint: 'fp-lowered',
    kind: 'image', model: 'm', estimatedCredits: 1
  });
  assert.equal(low.account.id, 'first');
  f.db.close();
});

test('manual order change affects new acquisition', async t => {
  const f = fixture();
  f.add('a', 500);
  f.add('b', 500);
  f.add('c', 500);

  const lease = await f.scheduler.acquireTask({
    requestId: 'order-1', ownerHash: 'owner-hash', requestFingerprint: 'fp-1',
    kind: 'image', model: 'm', estimatedCredits: 50
  });
  assert.equal(lease.account.id, 'a');

  let settings = f.scheduler.getSettings();
  f.scheduler.reorderAccounts({ accountIds: ['c', 'b', 'a'], revision: settings.revision });

  const lease2 = await f.scheduler.acquireTask({
    requestId: 'order-2', ownerHash: 'owner-hash', requestFingerprint: 'fp-2',
    kind: 'image', model: 'm', estimatedCredits: 50
  });
  assert.equal(lease2.account.id, 'c');
  assert.equal(f.scheduler.readTask(lease.taskId, 'owner-hash').accountId, 'a');

  f.db.close();
});

test('fixed mode: specified account required; different account fails', async t => {
  const f = fixture();
  f.add('a', 300);
  f.add('b', 300);

  let settings = f.scheduler.getSettings();
  settings = f.scheduler.updateSettings({ ...settings, mode: 'fixed', fixedAccountId: 'a', threshold: 100 });

  const dash = f.scheduler.getDashboard();
  assert.equal(dash.accounts.find(x => x.id === 'a').scheduling.eligible, true);

  const lease = await f.scheduler.acquireTask({
    requestId: 'fixed-1', ownerHash: 'owner-hash', requestFingerprint: 'fp-1',
    kind: 'image', model: 'm', estimatedCredits: 50
  });
  assert.equal(lease.account.id, 'a');

  f.db.prepare('UPDATE jimeng_accounts SET enabled=0 WHERE id=?').run('a');
  await assert.rejects(f.scheduler.acquireTask({
    requestId: 'fixed-2', ownerHash: 'owner-hash', requestFingerprint: 'fp-2',
    kind: 'image', model: 'm', estimatedCredits: 50
  }), error => error.statusCode === 409 && /指定账号不合格：账号已停用/.test(error.message));

  f.db.close();
});

test('no eligible account: clear rejection with reason', async t => {
  const f = fixture();
  f.add('a', 150);
  f.add('b', 150);

  let settings = f.scheduler.getSettings();
  settings = f.scheduler.updateSettings({ ...settings, threshold: 200 });

  const dash = f.scheduler.getDashboard();
  assert.equal(dash.summary.nextAccountId, null);

  await assert.rejects(f.scheduler.acquireTask({
    requestId: 'none-1', ownerHash: 'owner-hash', requestFingerprint: 'fp-1',
    kind: 'image', model: 'm', estimatedCredits: 50
  }), error => error.statusCode === 409 && /没有符合/.test(error.message));

  f.db.close();
});
