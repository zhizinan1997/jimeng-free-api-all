import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import Koa from 'koa';
import Router from 'koa-router';
import bodyParser from 'koa-bodyparser';

// Real service, real SQLite, real controller/route and HTTP; only the upstream transport is isolated.
test('account service and management HTTP preserve auth, error status, persistence and safe DTOs', async t => {
  const root = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jimeng-A-api-'));
  process.env.DB_PATH = path.join(dir, 'api.db');
  process.env.JIMENG_ACCOUNT_POOL_KEY = 'virtual-test-encryption-key';
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  const bundle = path.join(dir, 'entry.cjs');
  await build({ stdin: { contents: `export {default as pool} from './src/lib/account-pool.ts'; export {default as routes} from './src/api/routes/account-pool.ts'; export {default as auth} from './src/lib/database.ts';`, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: bundle,
    plugins: [{ name: 'isolated-upstream', setup(build) { build.onResolve({ filter: /controllers\/core\.ts$/ }, () => ({ path: 'core', namespace: 'isolated' })); build.onLoad({ filter: /.*/, namespace: 'isolated' }, () => ({ contents: `export async function request(method,path){ if(path.includes('user_credit'))return {credit:{gift_credit:250,purchase_credit:0,vip_credit:0}}; if(path.includes('account/info'))return {message:'success',data:{user_id_str:'verified-upstream-id',screen_name:'upstream display'}}; throw Error('network disabled'); }`, loader: 'js' })); } }]
  });
  const { pool, routes, auth } = createRequire(import.meta.url)(bundle);
  auth.createUser('virtual-admin', 'virtual-password'); const session = auth.createSession(1);
  const app = new Koa(), router = new Router(); app.use(bodyParser());
  for (const method of ['get','post','patch','delete']) for (const [url, handler] of Object.entries(routes[method] || {})) router[method](`${routes.prefix}${url}`, async ctx => {
    const response = await handler({ headers: ctx.headers, params: ctx.params, query: ctx.query, body: ctx.request.body }); response.injectTo(ctx);
  });
  app.use(router.routes()); const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (url, method = 'GET', body, logged = true) => {
    const response = await fetch(base + url, { method, headers: { ...(logged ? { cookie: `session=${session}` } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  try {
    assert.equal((await call('/account-pool/dashboard', 'GET', undefined, false)).status, 401);
    const created = await call('/account-pool/', 'POST', { name: 'local remark', sessionId: 'virtual-upstream-secret', metadata: { note: 'safe', apiKey: 'must-not-leak', nested: { cookie: 'must-not-leak' } } });
    assert.equal(created.status, 200); const id = created.body.id;
    assert.equal(created.body.upstreamIdentity.verified, false);
    assert.equal(JSON.stringify(created).includes('must-not-leak'), false);
    assert.equal((await call(`/account-pool/${id}/enabled`, 'PATCH', { enabled: 'false' })).status, 400);
    assert.equal(pool.get(id).enabled, true);
    const refreshed = await call(`/account-pool/${id}/refresh-status`, 'POST');
    assert.equal(refreshed.status, 200); assert.equal(refreshed.body.upstreamIdentity.userId, 'verified-upstream-id'); assert.equal(refreshed.body.name, 'local remark');
    assert.equal(refreshed.body.upstreamIdentity.displayName, 'upstream display');
    assert.equal(refreshed.body.upstreamIdentity.source, '/passport/account/info/v2');
    assert.equal(refreshed.body.status.membership, 'unknown');
    const snapshot = await call('/account-pool/dashboard'); assert.equal(snapshot.status, 200); assert.equal(snapshot.body.summary.nextAccountId, id);
    assert.equal((await call('/account-pool/select')).body.selectionMode, 'preview'); assert.equal(pool.get(id).lastUsedAt, null);
    const settings = snapshot.body.settings;
    assert.equal((await call('/account-pool/settings', 'PATCH', { ...settings, threshold: '200' })).status, 400);
    assert.equal((await call('/account-pool/settings', 'PATCH', { ...settings, mode: 'fixed', fixedAccountId: id })).status, 200);
    assert.equal((await call('/account-pool/settings', 'PATCH', settings)).status, 409);
    const input = { requestId: 'safe-request-id', ownerHash: 'hash-of-verified-caller', requestFingerprint: 'hash-of-request', kind: 'video', model: 'normal-video', estimatedCredits: 80 };
    const lease = await pool.acquireTask(input); assert.equal(lease.sessionId, 'virtual-upstream-secret');
    assert.equal((await call(`/account-pool/${id}`, 'DELETE')).status, 409);
    assert.equal((await call(`/account-pool/${id}`, 'PATCH', { sessionId: 'replacement-secret' })).status, 409);
    assert.equal((await call(`/account-pool/${id}/refresh-status`, 'POST')).status, 409);
    assert.equal((await call(`/account-pool/${id}/enabled`, 'PATCH', { enabled: false })).status, 200);
    assert.equal(pool.readTaskCredential(lease.taskId, input.ownerHash).sessionId, 'virtual-upstream-secret');
    const recovery = pool.readTaskForRecovery(lease.taskId);
    assert.equal(recovery.task.id, lease.taskId);
    assert.equal(recovery.ownerHash, input.ownerHash);
    assert.equal(recovery.selection.sessionId, 'virtual-upstream-secret');
    assert.throws(() => pool.readTaskCredential(lease.taskId, 'other-caller'), e => e.statusCode === 403);
    pool.transitionTask(lease.taskId, { state: 'submitting' });
    pool.transitionTask(lease.taskId, { state: 'unknown', error: 'virtual-upstream-secret sensitive prompt' });
    assert.equal((await pool.acquireTask(input)).reused, true);
    assert.equal((await call('/account-pool/tasks?limit=0')).status, 400);
    const dashboard = await call('/account-pool/dashboard');
    for (const secret of ['virtual-upstream-secret', 'replacement-secret', 'hash-of-verified-caller', 'hash-of-request', 'sensitive prompt']) assert.equal(JSON.stringify(dashboard).includes(secret), false);
    pool.transitionTask(lease.taskId, { state: 'succeeded', upstreamTaskId: 'known-history', result: { url: 'signed-private-result' } });
    let rejected = true; pool.setCreditStatusProvider(async () => { if (rejected) throw Error('virtual-upstream-secret'); return { totalCredit: 170 }; });
    const checkedAt = pool.get(id).status.checkedAt;
    await assert.rejects(pool.settleTask(lease.taskId), e => e.statusCode === 502);
    assert.equal(pool.get(id).status.checkedAt, checkedAt);
    assert.equal(pool.getDashboard().summary.activeTaskCount, 1);
    rejected = false; await pool.settleTask(lease.taskId);
    assert.equal(pool.get(id).scheduling.availableCredits, 170);
    assert.deepEqual(pool.readTaskResult(lease.taskId, input.ownerHash), { url: 'signed-private-result' });
    assert.equal(JSON.stringify(pool.getDashboard()).includes('signed-private-result'), false);
    const bytes = fs.readFileSync(process.env.DB_PATH + '-wal').toString();
    assert.equal(bytes.includes('virtual-upstream-secret'), false); assert.equal(bytes.includes('signed-private-result'), false);
    pool.update(id, { sessionId: 'replacement-secret' });
    assert.equal(pool.get(id).status.totalCredit, null); assert.equal(pool.get(id).upstreamIdentity.verified, false);
    assert.throws(() => pool.readTaskCredential(lease.taskId, input.ownerHash), /版本已变更/);
    assert.throws(() => pool.readTaskForRecovery(lease.taskId), e => e.statusCode === 409 && /版本已变更/.test(e.message));
    t.diagnostic(`isolated HTTP/SQLite evidence: ${dir}`);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('normalized session deduplication, same upstream userId exclusivity, and legacy duplicate compatibility on real SQLite', async t => {
  const root = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jimeng-A-dedup-'));
  process.env.DB_PATH = path.join(dir, 'dedup.db');
  process.env.JIMENG_ACCOUNT_POOL_KEY = 'virtual-test-encryption-key';
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  const bundle = path.join(dir, 'entry.cjs');
  await build({
    stdin: { contents: `export {default as pool} from './src/lib/account-pool.ts'; export {default as routes} from './src/api/routes/account-pool.ts'; export {default as auth} from './src/lib/database.ts'; export {default as Database} from 'better-sqlite3';`, resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: bundle,
    plugins: [{ name: 'isolated-upstream', setup(build) {
      build.onResolve({ filter: /controllers\/core\.ts$/ }, () => ({ path: 'core', namespace: 'isolated' }));
      build.onLoad({ filter: /.*/, namespace: 'isolated' }, () => ({
        contents: `export async function request(method,path){ if(path.includes('user_credit'))return {credit:{gift_credit:250,purchase_credit:0,vip_credit:0}}; if(path.includes('account/info'))return {user_info:{user_id:'same-verified-uid',nickname:'shared upstream',is_vip:false}}; throw Error('network disabled'); }`,
        loader: 'js'
      }));
    } }]
  });
  const { pool, routes, auth, Database } = createRequire(import.meta.url)(bundle);
  auth.createUser('virtual-admin', 'virtual-password'); const session = auth.createSession(1);
  const app = new Koa(), router = new Router(); app.use(bodyParser());
  for (const method of ['get','post','patch','delete']) for (const [url, handler] of Object.entries(routes[method] || {})) router[method](`${routes.prefix}${url}`, async ctx => {
    const response = await handler({ headers: ctx.headers, params: ctx.params, query: ctx.query, body: ctx.request.body }); response.injectTo(ctx);
  });
  app.use(router.routes()); const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (url, method = 'GET', body) => {
    const response = await fetch(base + url, { method, headers: { cookie: `session=${session}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  try {
    // 1. Same session cannot be added twice across raw sessionId vs full Cookie forms, nor via PATCH update.
    const a1 = await call('/account-pool/', 'POST', { name: 'sess-primary', sessionId: 'dup-session-alpha' });
    assert.equal(a1.status, 200);
    const a1CookieDup = await call('/account-pool/', 'POST', { name: 'cookie-dup', cookie: 'Cookie: sessionid=dup-session-alpha; ttwid=extra' });
    assert.equal(a1CookieDup.status, 409);
    const a2 = await call('/account-pool/', 'POST', { name: 'sess-secondary', sessionId: 'distinct-session-beta' });
    assert.equal(a2.status, 200);
    const a2PatchDup = await call(`/account-pool/${a2.body.id}`, 'PATCH', { cookie: 'sid_tt=dup-session-alpha; other=1' });
    assert.equal(a2PatchDup.status, 409);

    // 2. Two different sessions verified to the same upstream userId cannot hold two unknown-cost leases.
    assert.equal((await call(`/account-pool/${a1.body.id}/refresh-status`, 'POST')).status, 200);
    assert.equal((await call(`/account-pool/${a2.body.id}/refresh-status`, 'POST')).status, 200);
    const dash = await call('/account-pool/dashboard');
    assert.equal(dash.status, 200);
    assert.equal(dash.body.accounts.length, 2);
    assert.equal(dash.body.accounts[0].scheduling.eligible, true);
    assert.equal(dash.body.accounts[1].scheduling.eligible, false);
    assert.match(dash.body.accounts[1].scheduling.reason, /同一上游身份/);

    const lease1 = await pool.acquireTask({ requestId: 'uid-req-1', ownerHash: 'owner-1', requestFingerprint: 'fp-1', kind: 'video', model: 'm', estimatedCredits: null });
    assert.equal(lease1.account.id, a1.body.id);
    await assert.rejects(pool.acquireTask({ requestId: 'uid-req-2', ownerHash: 'owner-1', requestFingerprint: 'fp-2', kind: 'video', model: 'm', estimatedCredits: null }), e => e.statusCode === 409);
    assert.equal((await call(`/account-pool/${a1.body.id}/enabled`, 'PATCH', { enabled: false })).status, 200);
    await assert.rejects(pool.acquireTask({ requestId: 'uid-req-3', ownerHash: 'owner-1', requestFingerprint: 'fp-3', kind: 'video', model: 'm', estimatedCredits: null }), e => e.statusCode === 409);

    // Clean up lease1 so we can test legacy pre-existing duplicate rows with NULL session_hash.
    pool.transitionTask(lease1.taskId, { state: 'submitting' });
    pool.transitionTask(lease1.taskId, { state: 'failed' });
    await pool.settleTask(lease1.taskId);
    assert.equal((await call(`/account-pool/${a1.body.id}`, 'DELETE')).status, 200);
    assert.equal((await call(`/account-pool/${a2.body.id}`, 'DELETE')).status, 200);

    // 3. Simulate legacy DB rows that already had raw sessionId + full Cookie for the same session with session_hash=NULL.
    const crypto = await import('node:crypto');
    const key = crypto.createHash('sha256').update(process.env.JIMENG_ACCOUNT_POOL_KEY, 'utf8').digest();
    const enc = v => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, iv); const b = Buffer.concat([c.update(v, 'utf8'), c.final()]); return [iv.toString('base64url'), c.getAuthTag().toString('base64url'), b.toString('base64url')].join('.'); };
    const rawDb = new Database(process.env.DB_PATH);
    const ts = new Date().toISOString();
    rawDb.prepare(`INSERT INTO jimeng_accounts (id,name,credential_kind,credential_hash,session_hash,credential_ciphertext,enabled,total_credit,status_checked_at,identity_json,priority,created_at,updated_at) VALUES (?,?,?,?,NULL,?,1,250,?,?,?,?,?)`).run('legacy-sess', 'legacy-sess', 'sessionid', crypto.createHash('sha256').update('legacy-shared-sess').digest('hex'), enc('legacy-shared-sess'), ts, JSON.stringify({ verified: true, userId: 'legacy-uid', displayName: 'Legacy', checkedAt: ts }), 0, ts, ts);
    rawDb.prepare(`INSERT INTO jimeng_accounts (id,name,credential_kind,credential_hash,session_hash,credential_ciphertext,enabled,total_credit,status_checked_at,identity_json,priority,created_at,updated_at) VALUES (?,?,?,?,NULL,?,1,250,?,?,?,?,?)`).run('legacy-cookie', 'legacy-cookie', 'cookie', crypto.createHash('sha256').update('sessionid=legacy-shared-sess; extra=1').digest('hex'), enc('sessionid=legacy-shared-sess; extra=1'), ts, JSON.stringify({ verified: true, userId: 'legacy-uid', displayName: 'Legacy', checkedAt: ts }), 1, ts, ts);
    rawDb.close();

    const legacyDash = await call('/account-pool/dashboard');
    assert.equal(legacyDash.status, 200);
    assert.equal(legacyDash.body.accounts.length, 2);
    assert.equal(legacyDash.body.accounts[0].scheduling.eligible, true);
    assert.equal(legacyDash.body.accounts[1].scheduling.eligible, false);
    assert.match(legacyDash.body.accounts[1].scheduling.reason, /同一上游身份/);
    const legacyLease = await pool.acquireTask({ requestId: 'legacy-req-1', ownerHash: 'owner-1', requestFingerprint: 'lfp-1', kind: 'video', model: 'm', estimatedCredits: null });
    assert.equal(legacyLease.account.id, 'legacy-sess');
    await assert.rejects(pool.acquireTask({ requestId: 'legacy-req-2', ownerHash: 'owner-1', requestFingerprint: 'lfp-2', kind: 'video', model: 'm', estimatedCredits: null }), e => e.statusCode === 409);
    assert.equal(pool.readTaskForRecovery(legacyLease.taskId).selection.sessionId, 'legacy-shared-sess');
    t.diagnostic(`isolated dedup HTTP/SQLite evidence: ${dir}`);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('createPoolMaintenance integrates with real accountPool recovery, settlement retry, and stale refresh', async t => {
  const root = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jimeng-A-maint-'));
  process.env.DB_PATH = path.join(dir, 'maint.db');
  process.env.JIMENG_ACCOUNT_POOL_KEY = 'virtual-test-encryption-key';
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  const bundle = path.join(dir, 'entry.cjs');
  await build({
    stdin: {
      contents: `export {default as pool} from './src/lib/account-pool.ts'; export {createPoolMaintenance} from './src/lib/pool-maintenance.ts';`,
      resolveDir: root,
      loader: 'ts'
    },
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: bundle,
    plugins: [{
      name: 'isolated-upstream',
      setup(build) {
        build.onResolve({ filter: /controllers\/core\.ts$/ }, () => ({ path: 'core', namespace: 'isolated' }));
        build.onLoad({ filter: /.*/, namespace: 'isolated' }, () => ({
          contents: `export async function request(method,path,token){ if(path.includes('user_credit'))return {credit:{gift_credit:300,purchase_credit:0,vip_credit:0}}; if(path.includes('account/info'))return {user_info:{user_id:'uid-'+token,nickname:'nick-'+token,is_vip:false}}; throw Error('network disabled'); }`,
          loader: 'js'
        }));
      }
    }]
  });
  const { pool, createPoolMaintenance } = createRequire(import.meta.url)(bundle);

  const acc1 = pool.create({ name: 'maint-1', sessionId: 'sess-maint-1' });
  const acc2 = pool.create({ name: 'maint-2', sessionId: 'sess-maint-2' });
  const acc3 = pool.create({ name: 'maint-3', sessionId: 'sess-maint-3' });
  await pool.refreshStatus(acc1.id);
  await pool.refreshStatus(acc2.id);
  await pool.refreshStatus(acc3.id);

  const t1 = await pool.acquireTask({ requestId: 'maint-r1', ownerHash: 'owner-1', requestFingerprint: 'fp-1', kind: 'video', model: 'm-video', estimatedCredits: 80 });
  assert.equal(t1.account.id, acc1.id);
  pool.transitionTask(t1.taskId, { state: 'submitting' });
  pool.transitionTask(t1.taskId, { state: 'submitted', upstreamTaskId: 'up-video-1' });
  // Disable acc1 after submission: maintenance recovery must still read its original credential and settle it.
  pool.setEnabled(acc1.id, false);

  const t2 = await pool.acquireTask({ requestId: 'maint-r2', ownerHash: 'owner-1', requestFingerprint: 'fp-2', kind: 'image', model: 'm-image', estimatedCredits: 60 });
  assert.equal(t2.account.id, acc2.id);
  pool.transitionTask(t2.taskId, { state: 'submitting' });
  pool.transitionTask(t2.taskId, { state: 'succeeded', upstreamTaskId: 'up-image-2', result: { url: 'saved-image-url' } });

  const t3 = await pool.acquireTask({ requestId: 'maint-r3', ownerHash: 'owner-1', requestFingerprint: 'fp-3', kind: 'video', model: 'm-video', estimatedCredits: 20 });
  assert.equal(t3.account.id, acc3.id);
  // Leave t3 in reserved without upstreamTaskId: maintenance must neither query nor release unknown/reserved tasks.

  let failAcc2Settle = true;
  pool.setCreditStatusProvider(async sessionId => {
    if (sessionId === 'sess-maint-1') return { totalCredit: 220 };
    if (sessionId === 'sess-maint-2') {
      if (failAcc2Settle) throw new Error('secret=sess-maint-2 upstream-502');
      return { totalCredit: 240 };
    }
    return { totalCredit: 300 };
  });

  let now = 0;
  const recovered = [], events = [];
  const maintenance = createPoolMaintenance({
    listRecoverableTasks: () => pool.listRecoverableTasks(),
    recoverTask: async id => {
      const { task, selection } = pool.readTaskForRecovery(id);
      recovered.push({ taskId: task.id, accountId: selection.account.id, sessionId: selection.sessionId, upstreamTaskId: task.upstreamTaskId });
      pool.transitionTask(task.id, { state: 'succeeded', result: { url: 'recovered-video-url' } });
      await pool.settleTask(task.id);
    },
    settleTask: id => pool.settleTask(id),
    refreshStaleAccounts: () => pool.refreshStaleAccounts(),
    report: event => events.push(event)
  }, { intervalMs: 100, now: () => now });

  await maintenance.tick();
  assert.deepEqual(recovered, [{ taskId: t1.taskId, accountId: acc1.id, sessionId: 'sess-maint-1', upstreamTaskId: 'up-video-1' }]);
  assert.equal(pool.get(acc1.id).scheduling.availableCredits, 220);
  assert.deepEqual(pool.readTaskResult(t1.taskId, 'owner-1'), { url: 'recovered-video-url' });
  assert.deepEqual(events, [{ phase: 'settlement', taskId: t2.taskId }]);
  assert.equal(JSON.stringify(events).includes('sess-maint-2'), false);
  assert.deepEqual(pool.listRecoverableTasks().map(item => item.id).sort(), [t2.taskId, t3.taskId].sort());

  failAcc2Settle = false;
  now = 200;
  await maintenance.tick();
  assert.equal(pool.get(acc2.id).scheduling.availableCredits, 240);
  assert.equal(pool.get(acc2.id).scheduling.eligible, true);
  assert.deepEqual(pool.listRecoverableTasks().map(item => item.id), [t3.taskId]);
  assert.equal(pool.getDashboard().summary.activeTaskCount, 1);
  t.diagnostic(`isolated maintenance/SQLite evidence: ${dir}`);
});

test('real service syncs peer balance on settle and retains verified UID when identity endpoint temporarily fails', async t => {
  const root = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jimeng-A-reaudit-'));
  process.env.DB_PATH = path.join(dir, 'reaudit.db');
  process.env.JIMENG_ACCOUNT_POOL_KEY = 'virtual-test-encryption-key';
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  const bundle = path.join(dir, 'entry.cjs');
  await build({
    stdin: {
      contents: `export {default as pool} from './src/lib/account-pool.ts'; export {default as routes} from './src/api/routes/account-pool.ts'; export {default as auth} from './src/lib/database.ts';`,
      resolveDir: root,
      loader: 'ts'
    },
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: bundle,
    plugins: [{
      name: 'isolated-upstream',
      setup(build) {
        build.onResolve({ filter: /controllers\/core\.ts$/ }, () => ({ path: 'core', namespace: 'isolated' }));
        build.onLoad({ filter: /.*/, namespace: 'isolated' }, () => ({
          contents: `
            export async function request(method, path, token) {
              const ctl = globalThis.__reauditUpstream;
              if (path.includes('user_credit')) {
                const total = ctl.credits.get(token) ?? 250;
                return { credit: { gift_credit: total, purchase_credit: 0, vip_credit: 0 } };
              }
              if (path.includes('account/info')) {
                if (ctl.failIdentity.has(token)) throw new Error('identity endpoint 502');
                return { user_info: { user_id: ctl.uids.get(token) || ('uid-' + token), nickname: 'nick-' + token, is_vip: false } };
              }
              throw Error('network disabled');
            }
          `,
          loader: 'js'
        }));
      }
    }]
  });
  const credits = new Map([['sess-a1', 250], ['sess-b1', 250], ['sess-c2', 1000], ['sess-d2', 1000], ['sess-c2-v2', 1000]]);
  const uids = new Map([['sess-a1', 'uid-group-1'], ['sess-b1', 'uid-group-1'], ['sess-c2', 'same-verified-upstream-user'], ['sess-d2', 'same-verified-upstream-user'], ['sess-c2-v2', 'reverified-new-uid']]);
  const failIdentity = new Set();
  globalThis.__reauditUpstream = { credits, uids, failIdentity };
  const { pool, routes, auth } = createRequire(import.meta.url)(bundle);
  auth.createUser('virtual-admin', 'virtual-password');
  const session = auth.createSession(1);
  const app = new Koa(), router = new Router();
  app.use(bodyParser());
  for (const method of ['get', 'post', 'patch', 'delete']) {
    for (const [url, handler] of Object.entries(routes[method] || {})) {
      router[method](`${routes.prefix}${url}`, async ctx => {
        const response = await handler({ headers: ctx.headers, params: ctx.params, query: ctx.query, body: ctx.request.body });
        response.injectTo(ctx);
      });
    }
  }
  app.use(router.routes());
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (url, method = 'GET', body) => {
    const response = await fetch(base + url, {
      method,
      headers: { cookie: `session=${session}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() };
  };

  try {
    // Scenario 1: Same UID across different sessions; settle drops balance to 170, disable primary -> peer cannot bypass 200 threshold.
    const a1 = (await call('/account-pool/', 'POST', { name: 'a', sessionId: 'sess-a1' })).body;
    const b1 = (await call('/account-pool/', 'POST', { name: 'b', sessionId: 'sess-b1' })).body;
    assert.equal((await call(`/account-pool/${a1.id}/refresh-status`, 'POST')).status, 200);
    assert.equal((await call(`/account-pool/${b1.id}/refresh-status`, 'POST')).status, 200);

    const lease1 = await pool.acquireTask({ requestId: 'p1-1-req-1', ownerHash: 'owner-1', requestFingerprint: 'fp-p1-1', kind: 'image', model: 'm', estimatedCredits: 80 });
    assert.equal(lease1.account.id, a1.id);
    pool.transitionTask(lease1.taskId, { state: 'submitting' });
    pool.transitionTask(lease1.taskId, { state: 'succeeded' });
    credits.set('sess-a1', 170);
    credits.set('sess-b1', 170);
    await pool.settleTask(lease1.taskId);

    assert.equal((await call(`/account-pool/${a1.id}/enabled`, 'PATCH', { enabled: false })).status, 200);
    const dash1 = await call('/account-pool/dashboard');
    const b1View = dash1.body.accounts.find(x => x.id === b1.id);
    assert.equal(b1View.status.totalCredit, 170);
    assert.equal(b1View.scheduling.availableCredits, 170);
    assert.equal(b1View.scheduling.eligible, false);
    assert.match(b1View.scheduling.reason, /接单门槛/);
    assert.equal(dash1.body.summary.nextAccountId, null);
    await assert.rejects(pool.acquireTask({ requestId: 'p1-1-req-2', ownerHash: 'owner-1', requestFingerprint: 'fp-p1-2', kind: 'image', model: 'm', estimatedCredits: 50 }), e => e.statusCode === 409);

    // Clean up Scenario 1 accounts so Scenario 2 starts clean.
    assert.equal((await call(`/account-pool/${a1.id}`, 'DELETE')).status, 200);
    assert.equal((await call(`/account-pool/${b1.id}`, 'DELETE')).status, 200);

    // Scenario 2: Same UID verified -> identity endpoint temporarily fails on C while balance succeeds -> C keeps verified UID, flags refresh failure separately, and concurrent unknown-cost leases cannot both succeed.
    const c2 = (await call('/account-pool/', 'POST', { name: 'c', sessionId: 'sess-c2' })).body;
    const d2 = (await call('/account-pool/', 'POST', { name: 'd', sessionId: 'sess-d2' })).body;
    const c2Init = await call(`/account-pool/${c2.id}/refresh-status`, 'POST');
    assert.equal(c2Init.status, 200);
    assert.equal(c2Init.body.upstreamIdentity.verified, true);
    assert.equal(c2Init.body.upstreamIdentity.userId, 'same-verified-upstream-user');
    assert.equal(c2Init.body.upstreamIdentity.refreshFailed, false);
    const verifiedAt = c2Init.body.upstreamIdentity.checkedAt;
    assert.equal((await call(`/account-pool/${d2.id}/refresh-status`, 'POST')).status, 200);

    failIdentity.add('sess-c2');
    const c2AfterFail = await call(`/account-pool/${c2.id}/refresh-status`, 'POST');
    assert.equal(c2AfterFail.status, 200);
    assert.equal(c2AfterFail.body.status.totalCredit, 1000);
    assert.equal(c2AfterFail.body.status.error, undefined);
    assert.equal(c2AfterFail.body.upstreamIdentity.verified, true);
    assert.equal(c2AfterFail.body.upstreamIdentity.userId, 'same-verified-upstream-user');
    assert.equal(c2AfterFail.body.upstreamIdentity.checkedAt, verifiedAt);
    assert.equal(c2AfterFail.body.upstreamIdentity.refreshFailed, true);
    assert.ok(c2AfterFail.body.upstreamIdentity.refreshError);
    assert.ok(c2AfterFail.body.upstreamIdentity.lastRefreshAttemptAt);

    const dash2 = await call('/account-pool/dashboard');
    assert.equal(dash2.body.accounts.find(x => x.id === c2.id).scheduling.eligible, true);
    assert.equal(dash2.body.accounts.find(x => x.id === d2.id).scheduling.eligible, false);
    assert.match(dash2.body.accounts.find(x => x.id === d2.id).scheduling.reason, /同一上游身份/);

    const concurrent = await Promise.allSettled([
      pool.acquireTask({ requestId: 'p1-2-race-1', ownerHash: 'owner-1', requestFingerprint: 'fp-race-1', kind: 'video', model: 'm', estimatedCredits: null }),
      pool.acquireTask({ requestId: 'p1-2-race-2', ownerHash: 'owner-1', requestFingerprint: 'fp-race-2', kind: 'video', model: 'm', estimatedCredits: null })
    ]);
    assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(concurrent.filter(r => r.status === 'rejected').length, 1);
    const winner = concurrent.find(r => r.status === 'fulfilled').value;
    assert.equal(winner.account.id, c2.id);

    pool.transitionTask(winner.taskId, { state: 'submitting' });
    pool.transitionTask(winner.taskId, { state: 'failed' });
    await pool.settleTask(winner.taskId);

    // Credential replacement must clear previous verified identity and require re-verification.
    const rotated = await call(`/account-pool/${c2.id}`, 'PATCH', { sessionId: 'sess-c2-v2' });
    assert.equal(rotated.status, 200);
    assert.equal(rotated.body.upstreamIdentity.verified, false);
    assert.equal(rotated.body.upstreamIdentity.userId, null);
    assert.equal(rotated.body.upstreamIdentity.refreshFailed, false);
    assert.equal(rotated.body.status.totalCredit, null);

    failIdentity.add('sess-c2-v2');
    const rotatedFailedId = await call(`/account-pool/${c2.id}/refresh-status`, 'POST');
    assert.equal(rotatedFailedId.status, 200);
    assert.equal(rotatedFailedId.body.status.totalCredit, 1000);
    assert.equal(rotatedFailedId.body.upstreamIdentity.verified, false);
    assert.equal(rotatedFailedId.body.upstreamIdentity.userId, null);
    assert.equal(rotatedFailedId.body.upstreamIdentity.refreshFailed, true);

    failIdentity.delete('sess-c2-v2');
    const rotatedRecovered = await call(`/account-pool/${c2.id}/refresh-status`, 'POST');
    assert.equal(rotatedRecovered.status, 200);
    assert.equal(rotatedRecovered.body.upstreamIdentity.verified, true);
    assert.equal(rotatedRecovered.body.upstreamIdentity.userId, 'reverified-new-uid');
    assert.equal(rotatedRecovered.body.upstreamIdentity.refreshFailed, false);
    assert.equal(rotatedRecovered.body.upstreamIdentity.refreshError, null);

    // Scenario 3: Resolve stuck unknown task via admin HTTP endpoint (401 without session, 200 with session).
    // Refresh d2 too so both c2 and d2 carry explicit is_vip: false; -vip model is rejected while standard model acquires.
    assert.equal((await call(`/account-pool/${d2.id}/refresh-status`, 'POST')).status, 200);
    const vipAttempt = await pool.acquireTask({ requestId: 'p1-3-vip-deny', ownerHash: 'owner-1', requestFingerprint: 'fp-p1-3-vip', kind: 'video', model: 'jimeng-video-seedance-2.0-vip', estimatedCredits: null })
      .then(lease => ({ ok: true, accountId: lease.account.id }), err => ({ ok: false, statusCode: err.statusCode, message: err.message }));
    assert.equal(vipAttempt.ok, false, `Expected 409 rejection, got ${JSON.stringify({ vipAttempt, rotatedMembership: rotatedRecovered.body.status.membership, accounts: (await call('/account-pool/dashboard')).body.accounts.map(a => ({ id: a.id, m: a.status.membership, s: a.scheduling })) })}`);
    assert.equal(vipAttempt.statusCode, 409);
    assert.match(vipAttempt.message, /该模型所需会员权益未核验/);
    const stuckLease = await pool.acquireTask({ requestId: 'p1-3-stuck', ownerHash: 'owner-1', requestFingerprint: 'fp-p1-3', kind: 'video', model: 'jimeng-video-seedance-2.0', estimatedCredits: null });
    pool.transitionTask(stuckLease.taskId, { state: 'submitting' });
    pool.transitionTask(stuckLease.taskId, { state: 'unknown' });
    const unauthResolve = await fetch(`${base}/account-pool/tasks/${stuckLease.taskId}/resolve`, { method: 'POST' });
    assert.equal(unauthResolve.status, 401);
    assert.equal((await call(`/account-pool/tasks/${stuckLease.taskId}/resolve`, 'POST')).status, 400);
    const stuckTask = pool.readTask(stuckLease.taskId, 'owner-1');
    const confirmation = { expectedState: stuckTask.state, expectedUpdatedAt: stuckTask.updatedAt,
      expectedAccountId: stuckTask.accountId, confirmation: 'upstream_not_created_or_failed' };
    assert.equal((await call(`/account-pool/tasks/${stuckLease.taskId}/resolve`, 'POST', { ...confirmation, expectedAccountId: 'old-account' })).status, 409);
    const resolvedRes = await call(`/account-pool/tasks/${stuckLease.taskId}/resolve`, 'POST', confirmation);
    assert.equal(resolvedRes.status, 200);
    assert.equal(resolvedRes.body.success, true);
    assert.equal(resolvedRes.body.task.state, 'failed');
    assert.equal(resolvedRes.body.task.settling, false);
    assert.equal((await call('/account-pool/dashboard')).body.accounts.find(x => x.id === c2.id).scheduling.unknownCostBusy, false);
    assert.equal((await call(`/account-pool/tasks/${stuckLease.taskId}/resolve`, 'POST', confirmation)).status, 409);

    t.diagnostic(`isolated P1 reaudit HTTP/SQLite evidence: ${dir}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
