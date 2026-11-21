import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPoolScheduler } from '../../src/lib/account-pool-scheduler.ts';

test('settings and order persist across process restart', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jimeng-A-persist-'));
  const dbFile = path.join(dir, 'persist.db');

  const db = new Database(dbFile);
  db.exec(`CREATE TABLE IF NOT EXISTS jimeng_accounts (
    id TEXT PRIMARY KEY, name TEXT, enabled INTEGER, total_credit REAL, status_checked_at TEXT, status_error TEXT,
    credential_kind TEXT, credential_hash TEXT, session_hash TEXT, credential_ciphertext TEXT, credential_version INTEGER,
    cooldown_until TEXT, membership_json TEXT, identity_json TEXT, last_used_at TEXT, priority INTEGER, created_at TEXT, updated_at TEXT
  )`);

  db.prepare('INSERT INTO jimeng_accounts (id,name,enabled,total_credit,status_checked_at,created_at,priority,credential_version) VALUES (?,?,1,?,?,?,?,1)')
    .run('a', 'a', 500, new Date().toISOString(), new Date().toISOString(), 0);
  db.prepare('INSERT INTO jimeng_accounts (id,name,enabled,total_credit,status_checked_at,created_at,priority,credential_version) VALUES (?,?,1,?,?,?,?,1)')
    .run('b', 'b', 500, new Date().toISOString(), new Date().toISOString(), 1);

  const scheduler = createPoolScheduler({ db,
    publicAccount: r => ({ id: r.id, name: r.name, enabled: !!r.enabled, lastUsedAt: r.last_used_at }),
    selection: id => ({ account: { id }, credential: `cookie-${id}`, sessionId: `session-${id}` }),
    encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString(),
    refresh: async (id, token) => { db.prepare('UPDATE jimeng_accounts SET total_credit=?,status_checked_at=? WHERE id=?').run(500, new Date().toISOString(), id); return { id }; }
  });

  let settings = scheduler.getSettings();
  settings = scheduler.updateSettings({ ...settings, threshold: 150, mode: 'fixed', fixedAccountId: 'b' });
  scheduler.reorderAccounts({ accountIds: ['b', 'a'], revision: settings.revision });

  const settingsRead = scheduler.getSettings();
  assert.equal(settingsRead.threshold, 150);
  assert.equal(settingsRead.mode, 'fixed');
  assert.equal(settingsRead.fixedAccountId, 'b');

  const dash = scheduler.getDashboard();
  assert.deepEqual(dash.accounts.map(x => x.id), ['b', 'a']);

  db.close();

  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import Database from 'better-sqlite3';
    import { createPoolScheduler } from ${JSON.stringify(new URL('../../src/lib/account-pool-scheduler.ts', import.meta.url).href)};
    const db = new Database(${JSON.stringify(dbFile)});
    const s = createPoolScheduler({
      db,
      publicAccount: r => ({ id: r.id, name: r.name, enabled: !!r.enabled, lastUsedAt: r.last_used_at }),
      selection: id => ({ account: { id }, credential: \`cookie-\${id}\`, sessionId: \`session-\${id}\` }),
      encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString(),
      refresh: async (id, token) => { throw Error('must not refresh'); }
    });
    const set = s.getSettings();
    if (set.threshold !== 150 || set.mode !== 'fixed' || set.fixedAccountId !== 'b') throw Error('settings not persisted');
    const dash = s.getDashboard();
    assert.deepEqual(dash.accounts.map(x => x.id), ['b', 'a']);
    db.close();
    console.log('OK');
  `], { encoding: 'utf8' });

  if (child.status !== 0) throw new Error('Child process failed: ' + child.stderr);
  assert.ok(child.stdout.includes('OK'));

  fs.rmSync(dir, { recursive: true });
});

test('reserved/submitted tasks persist after restart', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jimeng-A-tasks-'));
  const dbFile = path.join(dir, 'tasks.db');

  const db = new Database(dbFile);
  db.exec(`CREATE TABLE IF NOT EXISTS jimeng_accounts (
    id TEXT PRIMARY KEY, name TEXT, enabled INTEGER, total_credit REAL, status_checked_at TEXT, status_error TEXT,
    credential_kind TEXT, credential_hash TEXT, session_hash TEXT, credential_ciphertext TEXT, credential_version INTEGER,
    cooldown_until TEXT, membership_json TEXT, identity_json TEXT, last_used_at TEXT, priority INTEGER, created_at TEXT, updated_at TEXT
  )`);

  db.prepare('INSERT INTO jimeng_accounts (id,name,enabled,total_credit,status_checked_at,created_at,priority,credential_version) VALUES (?,?,1,?,?,?,?,1)')
    .run('x', 'x', 500, new Date().toISOString(), new Date().toISOString(), 0);

  const scheduler = createPoolScheduler({ db,
    publicAccount: r => ({ id: r.id, name: r.name, enabled: !!r.enabled, lastUsedAt: r.last_used_at }),
    selection: id => ({ account: { id }, credential: `cookie-${id}`, sessionId: `session-${id}` }),
    encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString(),
    refresh: async (id, token) => { db.prepare('UPDATE jimeng_accounts SET total_credit=? WHERE id=?').run(500, id); return { id }; }
  });

  const lease = await scheduler.acquireTask({
    requestId: 'restart-task-1', ownerHash: 'owner', requestFingerprint: 'fp', kind: 'video', model: 'm', estimatedCredits: 50
  });
  scheduler.transitionTask(lease.taskId, { state: 'submitting' });
  scheduler.transitionTask(lease.taskId, { state: 'submitted', upstreamTaskId: 'up-123' });

  const recovered = scheduler.listRecoverableTasks();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].state, 'submitted');

  db.close();

  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import Database from 'better-sqlite3';
    import { createPoolScheduler } from ${JSON.stringify(new URL('../../src/lib/account-pool-scheduler.ts', import.meta.url).href)};
    const db = new Database(${JSON.stringify(dbFile)});
    const s = createPoolScheduler({
      db,
      publicAccount: r => ({ id: r.id, name: r.name, enabled: !!r.enabled, lastUsedAt: r.last_used_at }),
      selection: id => ({ account: { id }, credential: \`cookie-\${id}\`, sessionId: \`session-\${id}\` }),
      encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString(),
      refresh: async (id, token) => { throw Error('must not refresh on restart'); }
    });
    const tasks = s.listRecoverableTasks();
    if (tasks.length !== 1) throw Error('tasks not persisted: ' + tasks.length);
    if (tasks[0].state !== 'submitted') throw Error('task state wrong: ' + tasks[0].state);
    if (tasks[0].upstreamTaskId !== 'up-123') throw Error('upstream ID wrong: ' + tasks[0].upstreamTaskId);
    db.close();
    console.log('OK');
  `], { encoding: 'utf8' });

  if (child.status !== 0) throw new Error('Child process failed: ' + child.stderr);
  assert.ok(child.stdout.includes('OK'));

  fs.rmSync(dir, { recursive: true });
});
