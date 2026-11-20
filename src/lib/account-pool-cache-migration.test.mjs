import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { build } from 'esbuild';

test('legacy shared-browser readings expire once; credentials, settings and held tasks survive', async t => {
  const root = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jimeng-cache-migration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  const file = path.join(dir, 'pool.db');
  await build({
    entryPoints: ['src/lib/account-pool.ts'], outfile: path.join(dir, 'pool.cjs'),
    bundle: true, platform: 'node', format: 'cjs', packages: 'external',
    plugins: [{ name: 'no-network', setup(builder) {
      builder.onResolve({ filter: /controllers\/core\.ts$/ }, () => ({ path: 'core', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export function request(){throw Error("unexpected upstream request")}' }));
    } }],
  });
  function start(body = '') {
    const proc = spawnSync(process.execPath, ['-e', `const pool=require('./pool.cjs').default; (async()=>{ ${body} })().catch(e=>{ console.error(e);process.exitCode=1; });`], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, DB_PATH: file, JIMENG_ACCOUNT_POOL_KEY: 'isolated-migration-test' },
    });
    assert.equal(proc.status, 0, proc.stderr);
  }
  start(`for(const name of ['a','b','c','d']) pool.create({ name, cookie:'sessionid=test-session-'+name });
         pool.updateSettings({...pool.getSettings(),threshold:40});
         pool.reorderAccounts({ accountIds: pool.list().map(a=>a.id).reverse(), revision:pool.getSettings().revision });`);
  const db = new Database(file);
  t.after(() => db.close());
  const readRows = () => db.prepare('SELECT * FROM jimeng_accounts ORDER BY priority').all();
  const held = () => db.prepare('SELECT * FROM pool_tasks').all();
  const settings = () => db.prepare('SELECT * FROM pool_settings').get();
  // Reproduce the pre-upgrade store, where each distinct session had the same cached subject.
  db.exec('DROP TABLE pool_migrations');
  const stamp = new Date().toISOString();
  db.prepare(`UPDATE jimeng_accounts SET identity_json=?,membership_json='{}',free_credit=88,
    purchase_credit=0,vip_credit=0,total_credit=88,status_checked_at=?`)
    .run(JSON.stringify({verified:true,userId:'incorrect-shared-subject',credentialVersion:1}),stamp);
  db.prepare(`INSERT INTO pool_tasks(id,request_id,owner_hash,fingerprint,account_id,account_name,
    credential_version,kind,model,state,upstream_task_id,held,created_at,updated_at)
    VALUES('held-task','req','owner','fp',?,'a',1,'audio','test','submitted','upstream',1,?,?)`)
    .run(db.prepare("SELECT id FROM jimeng_accounts WHERE name='a'").get().id,stamp,stamp);
  const accountsBefore=readRows(), heldBefore=held(), settingsBefore=settings();
  start();
  const cleared = readRows();
  const cacheColumns = ['identity_json','membership_json','free_credit','purchase_credit','vip_credit','total_credit','status_checked_at','status_error'];
  const withoutCache = rows => rows.map(r => Object.fromEntries(Object.entries(r).filter(([key]) => !cacheColumns.includes(key))));
  assert.deepEqual(withoutCache(cleared), withoutCache(accountsBefore));
  assert.ok(cleared.every(r => cacheColumns.every(key => r[key] === null)));
  assert.deepEqual(settings(), settingsBefore);
  assert.deepEqual(held(), heldBefore);

  start(`pool.setCreditStatusProvider(async () => ({giftCredit:125,purchaseCredit:0,vipCredit:0,totalCredit:125}));
    pool.setMembershipStatusProvider(async (sessionId, account) => ({
      upstreamIdentity:{verified:true,userId:'actual-'+account.name},membership:'unknown'
    }));
    await pool.refreshStaleAccounts();`);
  const refreshed = readRows();
  assert.equal(refreshed.find(r=>r.name==='a').status_checked_at,null); // Its original task is still in flight.
  for (const r of refreshed.filter(r=>r.name!=='a')) {
    assert.equal(JSON.parse(r.identity_json).userId,'actual-'+r.name);
    assert.equal(r.total_credit,125);
    assert.equal(r.free_credit,125);
    assert.ok(r.status_checked_at);
  }
  start();
  assert.deepEqual(readRows(), refreshed);
  assert.deepEqual(held(), heldBefore);
  assert.deepEqual(settings(), settingsBefore);
});
