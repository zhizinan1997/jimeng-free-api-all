import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { Duplex } from 'node:stream';
const require = createRequire(path.join(process.env.ACCEPTANCE_ROOT, 'subject.cjs'));
const Database = require('better-sqlite3');
globalThis.__poolFixture = { credits: {}, calls: [] };
const fixture = globalThis.__poolFixture;
const action = process.argv[2];
let owner = crypto.createHash('sha256').update('fixture-caller-a').digest('hex');
const otherOwner = crypto.createHash('sha256').update('fixture-caller-b').digest('hex');
const secretA = 'FIXTURE_PRIVATE_SESSION_A_7a6c9d20';
const secretB = 'FIXTURE_PRIVATE_SESSION_B_1b3f8e40';
const memoFile = process.env.DB_PATH + '.memo.json';

// Seed the exact pre-upgrade shape, without importing initialization or reading data/.
if (action === 'migration') {
  const db = new Database(process.env.DB_PATH);
  db.exec(`CREATE TABLE jimeng_accounts (id TEXT PRIMARY KEY,name TEXT NOT NULL,credential_kind TEXT NOT NULL CHECK(credential_kind IN ('cookie','sessionid')),credential_hash TEXT NOT NULL UNIQUE,credential_ciphertext TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,failure_count INTEGER NOT NULL DEFAULT 0,success_count INTEGER NOT NULL DEFAULT 0,cooldown_until TEXT,last_used_at TEXT,last_success_at TEXT,last_failure_at TEXT,free_credit INTEGER,purchase_credit INTEGER,vip_credit INTEGER,total_credit INTEGER,membership_json TEXT,status_checked_at TEXT,status_error TEXT,metadata_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);`);
  const key = crypto.createHash('sha256').update(process.env.JIMENG_ACCOUNT_POOL_KEY).digest();
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const bytes = Buffer.concat([cipher.update(secretA), cipher.final()]);
  const encrypted = [iv, cipher.getAuthTag(), bytes].map(x => x.toString('base64url')).join('.');
  db.prepare('INSERT INTO jimeng_accounts (id,name,credential_kind,credential_hash,credential_ciphertext,success_count,total_credit,status_checked_at,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('legacy-a', 'Existing remark', 'sessionid', crypto.createHash('sha256').update(secretA).digest('hex'), encrypted, 7, 300, new Date().toISOString(), '{"legacy":"keep"}', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
  db.close();
}
const subject = require(path.join(process.env.ACCEPTANCE_ROOT, 'subject.cjs'));
const { pool, poolModule, routes, database } = subject;
function has(...methods) { for (const method of methods) assert.equal(typeof pool[method], 'function', `MISSING_CONTRACT: accountPool.${method}`); }
async function add(name, credit, sessionId = secretA) {
  const account = await pool.create({ name, sessionId });
  if (credit !== undefined) { fixture.credits[sessionId] = credit; await pool.refreshStatus(account.id); }
  return account;
}
function input(requestId, changes = {}) { return { requestId, ownerHash: owner, requestFingerprint: 'fingerprint-' + requestId, kind: 'image', model: 'jimeng-4.0', estimatedCredits: 80, ...changes }; }
async function acquire(id, changes) { has('acquireTask'); return pool.acquireTask(input(id, changes)); }
async function dashboard() { has('getDashboard'); return pool.getDashboard(); }
async function settings(patch) { has('getSettings', 'updateSettings'); return pool.updateSettings({ ...await pool.getSettings(), ...patch }); }
function request(body = {}, headers = {}, params = {}) { return { body, headers, params, query: {} }; }
function handler(method, route) { const fn = routes[method]?.[route]; assert.equal(typeof fn, 'function', `MISSING_ROUTE: ${method} ${route}`); return fn; }
function status(response) { return response?.statusCode || 200; }
function body(response) { return response?.body ?? response; }
function adminCookie() { database.createUser('fixture-admin', 'fixture-only-password'); return { cookie: `session=${database.createSession(1)}` }; }
async function order(ids) {
  const headers = database.isSetupComplete() ? { cookie: `session=${database.createSession(1)}` } : adminCookie();
  const result = await handler('patch', '/order')(request({ accountIds: ids, revision: (await pool.getSettings()).revision }, headers));
  assert.equal(status(result), 200, JSON.stringify(body(result)));
}
async function submitted(lease) {
  has('transitionTask');
  await pool.transitionTask(lease.taskId, { state: 'submitting' });
  await pool.transitionTask(lease.taskId, { state: 'submitted', upstreamTaskId: 'fixture-history-' + lease.taskId });
}
async function rejected(fn) { await assert.rejects(async () => fn()); }
const attachedServers = new WeakSet();
async function dispatchHttp({ method = 'GET', url, headers = {}, payload, targetServer = subject.server, targetRoutes = subject.allRoutes } = {}) {
  if (!attachedServers.has(targetServer)) {
    targetServer.attachRoutes(targetRoutes);
    attachedServers.add(targetServer);
  }
  const bytes = payload === undefined ? null : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const socket = new Duplex({ read() {}, write(_chunk, _enc, cb) { cb(); } });
  const req = new http.IncomingMessage(socket);
  req.method = method; req.url = url;
  req.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (bytes && !req.headers['content-type']) req.headers['content-type'] = 'application/json';
  if (bytes && !req.headers['content-length']) req.headers['content-length'] = String(bytes.length);
  const res = new http.ServerResponse(req);
  const chunks = [];
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  res.write = (chunk, encoding, cb) => {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    return origWrite(chunk, encoding, cb);
  };
  const finished = new Promise(resolve => {
    res.end = (chunk, encoding, cb) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      const ret = origEnd(chunk, encoding, cb);
      resolve(); return ret;
    };
  });
  process.nextTick(() => { if (bytes) req.push(bytes); req.push(null); });
  await Promise.all([targetServer.app.callback()(req, res), finished]);
  const rawText = Buffer.concat(chunks).toString('utf8');
  let json = null; try { json = JSON.parse(rawText); } catch {}
  return { statusCode: res.statusCode, headers: res.getHeaders(), text: rawText, body: json };
}

switch (action) {
  case 'isolation': {
    assert.throws(() => fetch('https://example.invalid/'), /ACCEPTANCE_NETWORK_BLOCKED/);
    assert.throws(() => require('node:https').get('https://example.invalid/'), /ACCEPTANCE_NETWORK_BLOCKED/);
    assert.throws(() => require('node:net').connect(443, 'example.invalid'), /ACCEPTANCE_NETWORK_BLOCKED/);
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { env: { ...process.env, DB_PATH: path.join(process.env.ACCEPTANCE_REPO, 'data/jimeng.db') }, encoding: 'utf8' });
    assert.notEqual(child.status, 0); assert.match(child.stderr, /refuses DB_PATH/); break;
  }
  case 'contract':
    has('acquireTask', 'transitionTask', 'settleTask', 'readTask', 'readTaskCredential', 'listRecoverableTasks', 'getDashboard', 'getSettings', 'updateSettings', 'reorderAccounts', 'listTasks', 'listEvents', 'refreshStaleAccounts'); break;
  case 'threshold': {
    const a = await add('A', 199); await rejected(() => acquire('below'));
    fixture.credits[secretA] = 200; await pool.refreshStatus(a.id);
    await rejected(() => acquire('over-estimate', { estimatedCredits: 201 }));
    const first = await acquire('boundary', { estimatedCredits: 200 }); assert.equal(first.account.id, a.id);
    await rejected(() => acquire('over-reservation', { estimatedCredits: 1 }));
    const b = await add('B', 250, secretB);
    const second = await acquire('250-minus-80'); assert.equal(second.account.id, b.id);
    const snapshot = await dashboard(); assert.equal(snapshot.accounts.find(x => x.id === b.id).scheduling.availableCredits, 170);
    await rejected(() => acquire('170-below-threshold', { estimatedCredits: 1 })); break;
  }
  case 'ordering': {
    has('getSettings'); const a = await add('A', 1000); const b = await add('B', 1000, secretB); await order([b.id, a.id]);
    const before = await dashboard();
    for (let i = 0; i < 3; i++) { assert.equal((await dashboard()).summary.nextAccountId, b.id); await pool.select('round_robin'); }
    const after = await dashboard();
    assert.deepEqual(after.accounts.map(x => x.lastUsedAt), before.accounts.map(x => x.lastUsedAt));
    assert.deepEqual(after.tasks, before.tasks); assert.deepEqual(after.events, before.events);
    assert.equal((await acquire('first')).account.id, b.id); assert.equal((await acquire('second')).account.id, b.id);
    await settings({ mode: 'fixed', fixedAccountId: a.id }); await pool.setEnabled(a.id, false);
    await rejected(() => acquire('fixed-unavailable')); await pool.setEnabled(a.id, true);
    assert.equal((await acquire('fixed-restored')).account.id, a.id); break;
  }
  case 'unknown_balance': {
    const a = await add('A'); fixture.credits[secretA] = new Error('fixture upstream unavailable');
    await rejected(() => acquire('unknown'));
    assert.equal((await dashboard()).accounts[0].scheduling.availableCredits, null);
    fixture.credits[secretA] = 500; await pool.refreshStatus(a.id);
    const db = new Database(process.env.DB_PATH); db.prepare('UPDATE jimeng_accounts SET status_checked_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', a.id); db.close();
    fixture.credits[secretA] = new Error('fixture refresh failed'); await rejected(() => acquire('expired'));
    const snapshot = await dashboard(); assert.equal(snapshot.accounts[0].scheduling.eligible, false); assert.notEqual(snapshot.accounts[0].scheduling.availableCredits, 0); break;
  }
  case 'eligibility': {
    const a = await add('A', 1000); const b = await add('B', 1000, secretB);
    pool.markFailure(a.id, 60_000); assert.equal((await acquire('cooldown')).account.id, b.id);
    pool.markSuccess(a.id); assert.equal((await acquire('restored-priority')).account.id, a.id);
    const c = await add('C', undefined, 'fixture-session-c'); fixture.credits['fixture-session-c'] = 1000;
    pool.setMembershipStatusProvider(async () => ({ supportedModels: ['allowed-model'], maxConcurrentTasks: 1 })); await pool.refreshStatus(c.id);
    await settings({ mode: 'fixed', fixedAccountId: c.id });
    await rejected(() => acquire('unsupported-model', { model: 'not-supported' }));
    await acquire('supported-model', { model: 'allowed-model' });
    await rejected(() => acquire('concurrency-full', { model: 'allowed-model' })); break;
  }
  case 'concurrent': {
    await add('A', 250); has('acquireTask');
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => acquire('race-' + i)));
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal((await dashboard()).accounts[0].scheduling.reservedCredits, 80); break;
  }
  case 'unknown_cost': {
    await add('A', 1000); const lease = await acquire('unknown-price', { estimatedCredits: null });
    assert.equal((await dashboard()).accounts[0].scheduling.unknownCostBusy, true);
    await rejected(() => acquire('known-cannot-mix'));
    await rejected(() => acquire('unknown-cannot-mix', { estimatedCredits: null }));
    await submitted(lease); await pool.transitionTask(lease.taskId, { state: 'succeeded' });
    fixture.credits[secretA] = new Error('fixture settlement unavailable');
    try { await pool.settleTask(lease.taskId); } catch { /* Contract allows throwing while retaining hold. */ }
    await rejected(() => acquire('unsafe-release'));
    fixture.credits[secretA] = 900; await pool.settleTask(lease.taskId);
    assert.equal((await acquire('after-settlement')).account.id, lease.account.id); break;
  }
  case 'settlement': {
    await add('A', 250); const lease = await acquire('settle'); await submitted(lease);
    await pool.transitionTask(lease.taskId, { state: 'succeeded' });
    fixture.credits[secretA] = new Error('fixture settlement unavailable');
    try { await pool.settleTask(lease.taskId); } catch { /* Assert durable hold below. */ }
    await rejected(() => acquire('settlement-pending'));
    fixture.credits[secretA] = 170; await pool.settleTask(lease.taskId); await pool.settleTask(lease.taskId);
    const account = (await dashboard()).accounts[0]; assert.equal(account.scheduling.availableCredits, 170); assert.equal(account.scheduling.reservedCredits, 0); break;
  }
  case 'idempotency': {
    await add('A', 1000); const first = await acquire('same-id'); await submitted(first);
    const again = await acquire('same-id'); assert.equal(again.taskId, first.taskId); assert.equal(again.reused, true);
    await rejected(() => acquire('same-id', { requestFingerprint: 'different-payload' }));
    const other = await acquire('same-id', { ownerHash: otherOwner }); assert.notEqual(other.taskId, first.taskId);
    const samePrompt = await acquire('different-id', { requestFingerprint: input('same-id').requestFingerprint }); assert.notEqual(samePrompt.taskId, first.taskId);
    await rejected(() => pool.readTask(first.taskId, otherOwner)); await rejected(() => pool.readTaskCredential(first.taskId, otherOwner)); break;
  }
  case 'unknown_submit': {
    await add('A', 1000); const lease = await acquire('lost-response'); await pool.transitionTask(lease.taskId, { state: 'submitting' });
    await pool.transitionTask(lease.taskId, { state: 'unknown', error: 'fixture submission timed out' });
    const retry = await acquire('lost-response'); assert.equal(retry.reused, true); assert.equal(retry.taskId, lease.taskId); assert.equal(retry.state, 'unknown'); assert.equal(retry.upstreamTaskId, null);
    try { await pool.settleTask(lease.taskId); } catch { /* unknown must retain hold */ }
    assert.equal((await pool.readTask(lease.taskId, owner)).state, 'unknown');
    assert.ok((await pool.listRecoverableTasks()).some(x => x.id === lease.taskId));
    assert.ok((await dashboard()).accounts[0].scheduling.activeTaskCount > 0); break;
  }
  case 'disabled': {
    const a = await add('A', 500); const b = await add('B', 500, secretB); const lease = await acquire('existing'); await submitted(lease);
    await pool.setEnabled(a.id, false); await order([b.id, a.id]);
    const bound = await pool.readTaskCredential(lease.taskId, owner); assert.equal(bound.account.id, a.id); assert.equal(bound.sessionId, secretA);
    assert.equal((await poolModule.readTaskAccount(a.id)).account.id, a.id);
    await rejected(() => pool.delete(a.id)); await rejected(() => pool.update(a.id, { sessionId: 'fixture-changed-credential' }));
    assert.equal((await acquire('new-task')).account.id, b.id); break;
  }
  case 'affinity': {
    const a = await add('A', 500); const b = await add('B', 500, secretB); await order([b.id, a.id]);
    assert.equal((await acquire('bound-material', { preferredAccountId: a.id })).account.id, a.id);
    await pool.setEnabled(a.id, false); await rejected(() => acquire('bound-material-disabled', { preferredAccountId: a.id })); break;
  }
  case 'dto_secrets': {
    const a = await add('Local remark is not verified identity', 1000);
    const b = await add('No identity verification yet', undefined, secretB);
    const before = await dashboard(); assert.equal(before.accounts.find(x => x.id === b.id).upstreamIdentity.verified, false);
    const lease = await acquire('public-task'); await submitted(lease);
    const sensitive = `sessionid=${secretA}; authorization=Bearer fixture-managed-api-key; https://fixture.invalid/result?signature=FIXTURE_SIGNED_SECRET`;
    await pool.transitionTask(lease.taskId, { state: 'failed', error: sensitive, result: { url: 'https://fixture.invalid/result?signature=FIXTURE_SIGNED_SECRET' } });
    const dump = JSON.stringify([await dashboard(), await pool.listTasks(), await pool.listEvents(), globalThis.__poolLogs || []]);
    for (const secret of [secretA, secretB, 'fixture-managed-api-key', 'FIXTURE_SIGNED_SECRET']) assert.equal(dump.includes(secret), false, 'public secret leak: synthetic canary');
    const task = (await dashboard()).tasks.find(x => x.id === lease.taskId); assert.ok(task); assert.equal(task.accountId, a.id); break;
  }
  case 'admin_permissions': {
    for (const method of ['get', 'post', 'patch', 'delete']) for (const [route, fn] of Object.entries(routes[method] || {})) {
      for (const headers of [{}, { cookie: 'session=fixture-invalid' }, { authorization: 'Bearer fixture-api-key-not-admin' }]) {
        const result = await fn(request({}, headers, { id: 'fixture-not-real' }));
        assert.equal(status(result), 401, `${method} ${route} did not reject`); assert.ok(body(result).error);
      }
    } break;
  }
  case 'admin_validation': {
    const headers = adminCookie(); has('getSettings'); const a = await add('A', 500); const b = await add('B', 500, secretB);
    const initial = await pool.getSettings(); assert.equal(initial.threshold, 200); assert.equal(initial.balanceMaxAgeSeconds, 60);
    const patch = handler('patch', '/settings');
    for (const invalid of [{ threshold: -1 }, { threshold: '200' }, { threshold: null }, { mode: 'random' }, { balanceMaxAgeSeconds: 0 }, { mode: 'fixed', fixedAccountId: 'absent' }]) {
      const response = await patch(request({ ...initial, ...invalid }, headers)); assert.ok(status(response) >= 400, JSON.stringify(invalid)); assert.ok(body(response).error);
      assert.deepEqual(await pool.getSettings(), initial);
    }
    const success = await patch(request({ ...initial, threshold: 201 }, headers)); assert.equal(status(success), 200); assert.equal(body(success).threshold, 201);
    const conflict = await patch(request(initial, headers)); assert.equal(status(conflict), 409); assert.ok(body(conflict).error);
    const reorder = handler('patch', '/order');
    for (const accountIds of [[a.id], [a.id, a.id], [a.id, b.id, 'absent']]) {
      const result = await reorder(request({ accountIds, revision: (await pool.getSettings()).revision }, headers)); assert.ok(status(result) >= 400); assert.ok(body(result).error);
    }
    for (const route of ['/dashboard', '/tasks', '/events']) { handler('get', route); assert.ok(Object.keys(routes.get).indexOf(route) < Object.keys(routes.get).indexOf('/:id')); }
    break;
  }
  case 'migration': {
    has('getDashboard'); const a = pool.get('legacy-a'); assert.equal(a.name, 'Existing remark'); assert.equal(a.successCount, 7); assert.equal(a.metadata.legacy, 'keep');
    assert.equal((await poolModule.readTaskAccount(a.id)).sessionId, secretA); assert.equal((await dashboard()).accounts.length, 1);
    const db = new Database(process.env.DB_PATH); const row = db.prepare('SELECT * FROM jimeng_accounts WHERE id=?').get(a.id); db.close();
    assert.equal(row.created_at, '2026-01-01T00:00:00.000Z'); assert.equal(row.credential_ciphertext.includes(secretA), false); break;
  }
  case 'restart_write': {
    const key = database.createApiKey('restart-caller').key; owner = subject.context.ownerHash(key);
    const a = await add('A', 500); const b = await add('B', 500, secretB); await order([b.id, a.id]); await settings({ mode: 'fixed', fixedAccountId: a.id, threshold: 210 });
    const known = await acquire('known-after-restart'); await submitted(known);
    const unknown = await acquire('unknown-after-restart'); await pool.transitionTask(unknown.taskId, { state: 'submitting' }); await pool.transitionTask(unknown.taskId, { state: 'unknown' });
    await pool.setEnabled(a.id, false); fs.writeFileSync(memoFile, JSON.stringify({ a: a.id, b: b.id, key, known: known.taskId, unknown: unknown.taskId, settings: await pool.getSettings() })); break;
  }
  case 'restart_read': {
    const memo = JSON.parse(fs.readFileSync(memoFile)); owner = subject.context.ownerHash(memo.key); assert.deepEqual(await pool.getSettings(), memo.settings);
    const record = await pool.readTask(memo.known, owner); assert.equal(record.upstreamTaskId, 'fixture-history-' + memo.known); assert.equal(record.accountId, memo.a);
    const credential = await pool.readTaskCredential(memo.known, owner); assert.equal(credential.sessionId, secretA); assert.equal(credential.account.enabled, false);
    const pending = await pool.readTask(memo.unknown, owner); assert.equal(pending.state, 'unknown'); assert.equal(pending.upstreamTaskId, null);
    const accounts = (await dashboard()).accounts; assert.ok(accounts.find(x => x.id === memo.b).priority < accounts.find(x => x.id === memo.a).priority);
    assert.equal(accounts.find(x => x.id === memo.a).scheduling.reservedCredits, 160);
    await rejected(() => pool.readTaskCredential(memo.known, otherOwner));
    fixture.request = (method, uri, token, options) => {
      assert.equal(method, 'POST'); assert.equal(uri, '/mweb/v1/get_history_by_ids'); assert.equal(token, secretA); assert.equal(options.cookie, secretA);
      assert.deepEqual(options.data.history_ids, ['fixture-history-' + memo.known]);
      return { ['fixture-history-' + memo.known]: { status: 50, item_list: [{ image: { large_images: [{ image_url: 'https://fixture.invalid/generated.png' }] } }] } };
    };
    const query = id => subject.imageRoutes.get['/tasks/:taskId'](new subject.Request({ res: new EventEmitter(), request: { method: 'GET', path: '/v1/images/tasks/' + id, headers: { authorization: 'Bearer ' + memo.key }, body: {} }, params: { taskId: id }, query: {} }));
    const recovered = body(await query(memo.known)); assert.equal(recovered.recoverable, true); assert.equal(recovered.data[0].url, 'https://fixture.invalid/generated.png');
    const unknownResult = body(await query(memo.unknown)); assert.equal(unknownResult.recoverable, false); assert.equal(fixture.calls.filter(x => x.operation === 'request').length, 1);
    break;
  }
  case 'restart_video_write': {
    const key = database.createApiKey('restart-video-caller').key;
    const otherKey = database.createApiKey('restart-video-other').key;
    owner = subject.context.ownerHash(key);
    const a = await add('A', 1000); const b = await add('B', 1000, secretB);
    const knownVideo = await acquire('known-video', { kind: 'video', model: 'jimeng-video-seedance-2.0' });
    await submitted(knownVideo);
    const unknownVideo = await acquire('unknown-video', { kind: 'video', model: 'jimeng-video-seedance-2.0' });
    await pool.transitionTask(unknownVideo.taskId, { state: 'submitting' });
    await pool.transitionTask(unknownVideo.taskId, { state: 'unknown' });
    const knownImage = await acquire('known-image-for-mismatch', { kind: 'image', model: 'jimeng-image-4.0' });
    await submitted(knownImage);
    await order([b.id, a.id]); await settings({ mode: 'fixed', fixedAccountId: b.id }); await pool.setEnabled(a.id, false);
    fs.writeFileSync(memoFile, JSON.stringify({ a: a.id, b: b.id, key, otherKey, knownVideo: knownVideo.taskId, unknownVideo: unknownVideo.taskId, knownImage: knownImage.taskId }));
    break;
  }
  case 'restart_video_read': {
    const memo = JSON.parse(fs.readFileSync(memoFile)); owner = subject.context.ownerHash(memo.key);
    const query = (id, bearer = memo.key) => subject.videoRoutes.get['/tasks/:taskId'](new subject.Request({ res: new EventEmitter(), request: { method: 'GET', path: '/v1/videos/tasks/' + id, headers: { authorization: 'Bearer ' + bearer }, body: {} }, params: { taskId: id }, query: {} }));
    fixture.request = (method, uri, token, options) => {
      assert.equal(method, 'POST'); assert.equal(uri, '/mweb/v1/get_history_by_ids');
      assert.equal(token, secretA); assert.equal(options.cookie, secretA);
      assert.deepEqual(options.data.history_ids, ['fixture-history-' + memo.knownVideo]);
      return { ['fixture-history-' + memo.knownVideo]: { status: 50, item_list: [{ video: { transcoded_video: { origin: { video_url: 'https://fixture.invalid/recovered-video.mp4' } } } }] } };
    };
    const recovered = await query(memo.knownVideo);
    assert.equal(status(recovered), 200); assert.equal(body(recovered).recoverable, true);
    assert.equal(body(recovered).pool_task_id, memo.knownVideo);
    assert.equal(body(recovered).task.accountId, memo.a);
    assert.equal(body(recovered).data[0].url, 'https://fixture.invalid/recovered-video.mp4');
    const unknownResult = await query(memo.unknownVideo);
    assert.equal(status(unknownResult), 200); assert.equal(body(unknownResult).recoverable, false);
    assert.equal(body(unknownResult).task.state, 'unknown');
    const denied = await query(memo.knownVideo, memo.otherKey);
    assert.equal(status(denied), 403); assert.ok(body(denied).error);
    const mismatch = await query(memo.knownImage);
    assert.ok(status(mismatch) >= 400);
    assert.equal((await pool.readTask(memo.knownImage, owner)).state, 'submitted');
    assert.equal(fixture.calls.filter(x => x.operation === 'request').length, 1);
    assert.equal(fixture.calls.filter(x => x.operation === 'submit').length, 0);
    break;
  }
  case 'restart_audio_write': {
    const key = database.createApiKey('restart-audio-caller').key;
    const otherKey = database.createApiKey('restart-audio-other').key;
    owner = subject.context.ownerHash(key);
    const a = await add('A', 1000); const b = await add('B', 1000, secretB);
    const knownAudio = await acquire('known-audio', { kind: 'audio', model: 'jimeng-audio-seedaudio-1.0' });
    await submitted(knownAudio);
    const unknownAudio = await acquire('unknown-audio', { kind: 'audio', model: 'jimeng-audio-seedaudio-1.0' });
    await pool.transitionTask(unknownAudio.taskId, { state: 'submitting' });
    await pool.transitionTask(unknownAudio.taskId, { state: 'unknown' });
    const knownVideo = await acquire('known-video-for-mismatch', { kind: 'video', model: 'jimeng-video-seedance-2.0' });
    await submitted(knownVideo);
    await order([b.id, a.id]); await settings({ mode: 'fixed', fixedAccountId: b.id }); await pool.setEnabled(a.id, false);
    fs.writeFileSync(memoFile, JSON.stringify({ a: a.id, b: b.id, key, otherKey, knownAudio: knownAudio.taskId, unknownAudio: unknownAudio.taskId, knownVideo: knownVideo.taskId }));
    break;
  }
  case 'restart_audio_read': {
    const memo = JSON.parse(fs.readFileSync(memoFile)); owner = subject.context.ownerHash(memo.key);
    const query = (id, bearer = memo.key) => subject.audioRoutes.get['/tasks/:taskId'](new subject.Request({ res: new EventEmitter(), request: { method: 'GET', path: '/v1/audios/tasks/' + id, headers: { authorization: 'Bearer ' + bearer }, body: {} }, params: { taskId: id }, query: {} }));
    fixture.request = (method, uri, token, options) => {
      assert.equal(method, 'POST'); assert.equal(uri, '/mweb/v1/get_history_by_ids');
      assert.equal(token, secretA); assert.equal(options.cookie, secretA);
      assert.deepEqual(options.data.history_ids, ['fixture-history-' + memo.knownAudio]);
      return { ['fixture-history-' + memo.knownAudio]: { status: 50, item_list: [{ audio: { origin_audio: { audio_url: 'https://fixture.invalid/recovered-audio.mp3' } } }] } };
    };
    const recovered = await query(memo.knownAudio);
    assert.equal(status(recovered), 200); assert.equal(body(recovered).recoverable, true);
    assert.equal(body(recovered).pool_task_id, memo.knownAudio);
    assert.equal(body(recovered).task.accountId, memo.a);
    assert.equal(body(recovered).data[0].url, 'https://fixture.invalid/recovered-audio.mp3');
    const unknownResult = await query(memo.unknownAudio);
    assert.equal(status(unknownResult), 200); assert.equal(body(unknownResult).recoverable, false);
    assert.equal(body(unknownResult).task.state, 'unknown');
    const denied = await query(memo.knownAudio, memo.otherKey);
    assert.equal(status(denied), 403); assert.ok(body(denied).error);
    const mismatch = await query(memo.knownVideo);
    assert.ok(status(mismatch) >= 400);
    assert.equal((await pool.readTask(memo.knownVideo, owner)).state, 'submitted');
    assert.equal(fixture.calls.filter(x => x.operation === 'request').length, 1);
    assert.equal(fixture.calls.filter(x => x.operation === 'submit').length, 0);
    break;
  }
  case 'restart_chat_write': {
    const key = database.createApiKey('restart-chat-caller').key;
    const otherKey = database.createApiKey('restart-chat-other').key;
    owner = subject.context.ownerHash(key);
    const a = await add('A', 1000); const b = await add('B', 1000, secretB);
    const chatImage = await acquire('chat-image', { kind: 'image', model: 'jimeng-image-4.0' });
    await submitted(chatImage);
    const chatVideo = await acquire('chat-video', { kind: 'video', model: 'jimeng-video-seedance-2.0' });
    await submitted(chatVideo);
    const chatText = await acquire('chat-text', { kind: 'text', model: 'glm-5.3-flash' });
    await submitted(chatText);
    const chatUnknown = await acquire('chat-unknown', { kind: 'image', model: 'jimeng-image-4.0' });
    await pool.transitionTask(chatUnknown.taskId, { state: 'submitting' });
    await pool.transitionTask(chatUnknown.taskId, { state: 'unknown' });
    await order([b.id, a.id]); await settings({ mode: 'fixed', fixedAccountId: b.id }); await pool.setEnabled(a.id, false);
    fs.writeFileSync(memoFile, JSON.stringify({ a: a.id, b: b.id, key, otherKey, chatImage: chatImage.taskId, chatVideo: chatVideo.taskId, chatText: chatText.taskId, chatUnknown: chatUnknown.taskId }));
    break;
  }
  case 'restart_chat_read': {
    const memo = JSON.parse(fs.readFileSync(memoFile)); owner = subject.context.ownerHash(memo.key);
    const query = (id, bearer = memo.key) => subject.chatRoutes.get['/tasks/:taskId'](new subject.Request({ res: new EventEmitter(), request: { method: 'GET', path: '/v1/chat/tasks/' + id, headers: { authorization: 'Bearer ' + bearer }, body: {} }, params: { taskId: id }, query: {} }));
    fixture.request = (method, uri, token, options) => {
      assert.equal(method, 'POST'); assert.equal(uri, '/mweb/v1/get_history_by_ids');
      assert.equal(token, secretA); assert.equal(options.cookie, secretA);
      const hid = options.data.history_ids[0];
      if (hid === 'fixture-history-' + memo.chatImage) return { [hid]: { status: 50, item_list: [{ image: { large_images: [{ image_url: 'https://fixture.invalid/chat-recovered.png' }] } }] } };
      if (hid === 'fixture-history-' + memo.chatVideo) return { [hid]: { status: 50, item_list: [{ video: { transcoded_video: { origin: { video_url: 'https://fixture.invalid/chat-recovered.mp4' } } } }] } };
      throw new Error('UNEXPECTED_HISTORY_QUERY: ' + hid);
    };
    const imgRes = await query(memo.chatImage);
    assert.equal(status(imgRes), 200); assert.equal(body(imgRes).recoverable, true);
    assert.equal(body(imgRes).task.accountId, memo.a);
    assert.equal(body(imgRes).data[0].url, 'https://fixture.invalid/chat-recovered.png');
    const vidRes = await query(memo.chatVideo);
    assert.equal(status(vidRes), 200); assert.equal(body(vidRes).recoverable, true);
    assert.equal(body(vidRes).task.accountId, memo.a);
    assert.equal(body(vidRes).data[0].url, 'https://fixture.invalid/chat-recovered.mp4');
    const textRes = await query(memo.chatText);
    assert.equal(status(textRes), 200); assert.equal(body(textRes).recoverable, false);
    assert.equal(body(textRes).task.kind, 'text');
    assert.equal(body(textRes).task.upstreamTaskId, 'fixture-history-' + memo.chatText);
    const unknownRes = await query(memo.chatUnknown);
    assert.equal(status(unknownRes), 200); assert.equal(body(unknownRes).recoverable, false);
    assert.equal(body(unknownRes).task.state, 'unknown');
    const denied = await query(memo.chatImage, memo.otherKey);
    assert.equal(status(denied), 403); assert.ok(body(denied).error);
    assert.equal(fixture.calls.filter(x => x.operation === 'request').length, 2);
    assert.equal(fixture.calls.filter(x => x.operation === 'submit').length, 0);
    break;
  }
  case 'restart_maintenance_write': {
    const axios = require('axios');
    const secretC = 'FIXTURE_PRIVATE_SESSION_C_9e2a4c10';
    const secretD = 'FIXTURE_PRIVATE_SESSION_D_4d8b1f60';
    axios.defaults.adapter = async config => {
      const url = new URL(config.url);
      const route = url.pathname;
      const cookieHeader = typeof config.headers?.get === 'function' ? config.headers.get('Cookie') : config.headers?.Cookie || '';
      const sessionMatch = String(cookieHeader).match(/sessionid=([^;]+)/);
      const sid = sessionMatch ? sessionMatch[1] : 'unknown';
      if (route === '/commerce/v1/benefits/user_credit') {
        return { status: 200, statusText: 'OK', headers: {}, config, data: { ret: '0', data: { credit: { gift_credit: 1000, purchase_credit: 0, vip_credit: 0 } } } };
      }
      if (route === '/passport/account/info/v2') {
        return { status: 200, statusText: 'OK', headers: {}, config, data: { ret: '0', data: { user_info: { user_id: `maint-uid-${sid}`, nickname: 'Maint', is_vip: true } } } };
      }
      throw new Error('UNEXPECTED_MAINT_WRITE_UPSTREAM: ' + route);
    };
    const chain = require(path.join(process.env.ACCEPTANCE_ROOT, 'chain-subject.cjs'));
    const key = chain.database.createApiKey('restart-maint-caller').key;
    const callerHash = chain.ownerHash(key);
    const a = await chain.pool.create({ name: 'maint-A', cookie: `sessionid=${secretA}; webid=maint-a` });
    const knownVideo = await chain.pool.acquireTask({ requestId: 'maint-known-vid', ownerHash: callerHash, requestFingerprint: 'fp-maint-vid', kind: 'video', model: 'jimeng-video-seedance-2.0', estimatedCredits: null });
    chain.pool.transitionTask(knownVideo.taskId, { state: 'submitting' });
    chain.pool.transitionTask(knownVideo.taskId, { state: 'submitted', upstreamTaskId: 'hist-maint-vid-1' });
    await chain.pool.setEnabled(a.id, false);

    const b = await chain.pool.create({ name: 'maint-B', cookie: `sessionid=${secretB}; webid=maint-b` });
    const alreadySucceeded = await chain.pool.acquireTask({ requestId: 'maint-done-img', ownerHash: callerHash, requestFingerprint: 'fp-maint-img', kind: 'image', model: 'jimeng-image-4.0', estimatedCredits: 80 });
    chain.pool.transitionTask(alreadySucceeded.taskId, { state: 'submitting' });
    chain.pool.transitionTask(alreadySucceeded.taskId, { state: 'succeeded', upstreamTaskId: 'hist-maint-img-2', result: { kind: 'image', urls: ['https://fixture.invalid/maint-img.png'] } });

    const c = await chain.pool.create({ name: 'maint-C', cookie: `sessionid=${secretC}; webid=maint-c` });
    const unknownNoId = await chain.pool.acquireTask({ requestId: 'maint-unknown-noid', ownerHash: callerHash, requestFingerprint: 'fp-maint-noid', kind: 'video', model: 'jimeng-video-seedance-2.0', estimatedCredits: 80 });
    chain.pool.transitionTask(unknownNoId.taskId, { state: 'submitting' });
    chain.pool.transitionTask(unknownNoId.taskId, { state: 'unknown' });

    const d = await chain.pool.create({ name: 'maint-D', cookie: `sessionid=${secretD}; webid=maint-d` });
    const textTask = await chain.pool.acquireTask({ requestId: 'maint-text', ownerHash: callerHash, requestFingerprint: 'fp-maint-text', kind: 'text', model: 'glm-5.3-flash', estimatedCredits: 80 });
    chain.pool.transitionTask(textTask.taskId, { state: 'submitting' });
    chain.pool.transitionTask(textTask.taskId, { state: 'submitted', upstreamTaskId: 'conv-maint-text-4' });

    const curSettings = await chain.pool.getSettings();
    await chain.pool.reorderAccounts({ accountIds: [b.id, c.id, d.id, a.id], revision: curSettings.revision }, 'maint-setup');
    await chain.pool.updateSettings({ ...await chain.pool.getSettings(), mode: 'fixed', fixedAccountId: b.id });
    fs.writeFileSync(memoFile, JSON.stringify({
      a: a.id, b: b.id, c: c.id, d: d.id, key, secretB,
      knownVideo: knownVideo.taskId, alreadySucceeded: alreadySucceeded.taskId,
      unknownNoId: unknownNoId.taskId, textTask: textTask.taskId,
    }));
    break;
  }
  case 'restart_maintenance_read': {
    const memo = JSON.parse(fs.readFileSync(memoFile));
    const axios = require('axios');
    const historyQueries = [];
    const submitCalls = [];
    let failBCredit = true;
    axios.defaults.adapter = async config => {
      const reqBody = typeof config.data === 'string' ? JSON.parse(config.data) : Buffer.isBuffer(config.data) ? {} : config.data || {};
      const url = new URL(config.url);
      const route = url.pathname;
      const cookieHeader = typeof config.headers?.get === 'function' ? config.headers.get('Cookie') : config.headers?.Cookie || '';
      const sessionMatch = String(cookieHeader).match(/sessionid=([^;]+)/);
      const sid = sessionMatch ? sessionMatch[1] : 'unknown';
      if (route === '/mweb/v1/aigc_draft/generate') { submitCalls.push(route); throw new Error('MAINTENANCE_MUST_NOT_RESUBMIT'); }
      if (route === '/commerce/v1/benefits/user_credit') {
        if (sid === memo.secretB && failBCredit) throw new Error(`simulated credit failure cookie=${memo.secretB}`);
        return { status: 200, statusText: 'OK', headers: {}, config, data: { ret: '0', data: { credit: { gift_credit: 920, purchase_credit: 0, vip_credit: 0 } } } };
      }
      if (route === '/passport/account/info/v2') {
        return { status: 200, statusText: 'OK', headers: {}, config, data: { ret: '0', data: { user_info: { user_id: `maint-uid-${sid}`, nickname: 'Maint', is_vip: true } } } };
      }
      if (route === '/mweb/v1/get_history_by_ids') {
        historyQueries.push({ sid, historyIds: reqBody.history_ids });
        assert.equal(sid, secretA, 'recovery query must use original disabled account A credential');
        assert.deepEqual(reqBody.history_ids, ['hist-maint-vid-1']);
        return { status: 200, statusText: 'OK', headers: {}, config, data: { ret: '0', data: { 'hist-maint-vid-1': { status: 50, item_list: [{ video: { transcoded_video: { origin: { video_url: 'https://fixture.invalid/maint-recovered.mp4' } } } }] } } } };
      }
      throw new Error('UNEXPECTED_MAINT_READ_UPSTREAM: ' + route);
    };
    const chain = require(path.join(process.env.ACCEPTANCE_ROOT, 'chain-subject.cjs'));
    const callerHash = chain.ownerHash(memo.key);
    const events = [];
    let fakeNow = Date.now();
    const maintenance = chain.createPoolMaintenance({
      listRecoverableTasks: () => chain.pool.listRecoverableTasks(),
      recoverTask: chain.recoverStoredPoolTask,
      settleTask: async id => { await chain.pool.settleTask(id); },
      refreshStaleAccounts: async () => { await chain.pool.refreshStaleAccounts(); },
      report: event => events.push(event),
    }, { intervalMs: 100, now: () => fakeNow });

    await maintenance.tick();
    assert.equal(submitCalls.length, 0);
    assert.equal(historyQueries.length, 1);
    const knownAfterTick1 = chain.pool.readTask(memo.knownVideo, callerHash);
    assert.equal(knownAfterTick1.state, 'succeeded');
    assert.equal(knownAfterTick1.settling, false);
    assert.deepEqual(chain.pool.readTaskResult(memo.knownVideo, callerHash)?.urls, ['https://fixture.invalid/maint-recovered.mp4']);
    assert.equal(chain.pool.readTask(memo.alreadySucceeded, callerHash).settling, true);
    assert.deepEqual(events, [{ phase: 'settlement', taskId: memo.alreadySucceeded }]);
    assert.equal(JSON.stringify(events).includes(memo.secretB), false);

    failBCredit = false;
    fakeNow += 300;
    await maintenance.tick();
    assert.equal(chain.pool.readTask(memo.alreadySucceeded, callerHash).settling, false);
    assert.equal(chain.pool.readTask(memo.unknownNoId, callerHash).state, 'unknown');
    assert.equal(chain.pool.readTask(memo.textTask, callerHash).state, 'submitted');
    assert.equal(historyQueries.length, 1);
    assert.equal(submitCalls.length, 0);

    const routeRes = await chain.videoRoutes.get['/tasks/:taskId'](new chain.Request({
      res: new EventEmitter(),
      request: { method: 'GET', path: '/v1/videos/tasks/' + memo.knownVideo, headers: { authorization: 'Bearer ' + memo.key }, body: {} },
      params: { taskId: memo.knownVideo }, query: {},
    }));
    assert.equal(status(routeRes), 200);
    assert.equal(body(routeRes).recoverable, true);
    assert.equal(body(routeRes).data[0].url, 'https://fixture.invalid/maint-recovered.mp4');
    assert.equal(historyQueries.length, 1, 'stored recovered result must satisfy task query without re-querying upstream');
    maintenance.stop();
    break;
  }
  case 'http_static_and_admin_routes': {
    await add('A', 1000);
    const headers = adminCookie();
    const html = await dispatchHttp({ url: '/' });
    assert.equal(html.statusCode, 200); assert.match(html.text, /account-pool-ui\.js/);
    const js = await dispatchHttp({ url: '/account-pool-ui.js' });
    assert.equal(js.statusCode, 200); assert.match(String(js.headers['content-type']), /javascript/);
    const css = await dispatchHttp({ url: '/account-pool-ui.css' });
    assert.equal(css.statusCode, 200); assert.match(String(css.headers['content-type']), /css/);
    const unauth = await dispatchHttp({ url: '/account-pool/dashboard' });
    assert.equal(unauth.statusCode, 401);
    const dash = await dispatchHttp({ url: '/account-pool/dashboard', headers });
    assert.equal(dash.statusCode, 200); assert.equal(Array.isArray(dash.body?.accounts), true);
    break;
  }
  case 'http_task_type_mismatch_and_auth': {
    const key = database.createApiKey('http-caller').key;
    const otherKey = database.createApiKey('http-other').key;
    owner = subject.context.ownerHash(key);
    await add('A', 1000);
    const imgTask = await acquire('http-img', { kind: 'image', model: 'jimeng-image-4.0' }); await submitted(imgTask);
    const vidTask = await acquire('http-vid', { kind: 'video', model: 'jimeng-video-seedance-2.0' }); await submitted(vidTask);
    const audTask = await acquire('http-aud', { kind: 'audio', model: 'jimeng-audio-seedaudio-1.0' }); await submitted(audTask);
    fixture.request = (_m, uri, _t, options) => {
      assert.equal(uri, '/mweb/v1/get_history_by_ids');
      const hid = options.data.history_ids[0];
      if (hid === 'fixture-history-' + imgTask.taskId) return { [hid]: { status: 50, item_list: [{ image: { large_images: [{ image_url: 'https://fixture.invalid/http-img.png' }] } }] } };
      if (hid === 'fixture-history-' + vidTask.taskId) return { [hid]: { status: 50, item_list: [{ video: { play_url: 'https://fixture.invalid/http-vid.mp4' } }] } };
      if (hid === 'fixture-history-' + audTask.taskId) return { [hid]: { status: 50, item_list: [{ audio: { origin_audio: { url: 'https://fixture.invalid/http-aud.mp3' } } }] } };
      throw new Error('UNEXPECTED_HTTP_HISTORY: ' + hid);
    };
    const okImg = await dispatchHttp({ url: `/v1/images/tasks/${imgTask.taskId}`, headers: { authorization: 'Bearer ' + key } });
    assert.equal(okImg.statusCode, 200); assert.equal(okImg.body?.recoverable, true); assert.equal(okImg.body?.pool_task_id, imgTask.taskId);
    const okVid = await dispatchHttp({ url: `/v1/videos/tasks/${vidTask.taskId}`, headers: { authorization: 'Bearer ' + key } });
    assert.equal(okVid.statusCode, 200); assert.equal(okVid.body?.recoverable, true); assert.equal(okVid.body?.data?.[0]?.url, 'https://fixture.invalid/http-vid.mp4');
    const okAud = await dispatchHttp({ url: `/v1/audios/tasks/${audTask.taskId}`, headers: { authorization: 'Bearer ' + key } });
    assert.equal(okAud.statusCode, 200); assert.equal(okAud.body?.recoverable, true); assert.equal(okAud.body?.data?.[0]?.url, 'https://fixture.invalid/http-aud.mp3');
    const okChat = await dispatchHttp({ url: `/v1/chat/tasks/${vidTask.taskId}`, headers: { authorization: 'Bearer ' + key } });
    assert.equal(okChat.statusCode, 200); assert.equal(okChat.body?.recoverable, true);

    const callsBeforeErrors = fixture.calls.filter(x => x.operation === 'request').length;
    const misVid = await dispatchHttp({ url: `/v1/videos/tasks/${imgTask.taskId}`, headers: { authorization: 'Bearer ' + key } });
    assert.ok(misVid.statusCode >= 400, `expected >= 400 for kind mismatch, got ${misVid.statusCode}`);
    const misAud = await dispatchHttp({ url: `/v1/audios/tasks/${vidTask.taskId}`, headers: { authorization: 'Bearer ' + key } });
    assert.ok(misAud.statusCode >= 400, `expected >= 400 for kind mismatch, got ${misAud.statusCode}`);
    const misImg = await dispatchHttp({ url: `/v1/images/tasks/${audTask.taskId}`, headers: { authorization: 'Bearer ' + key } });
    assert.ok(misImg.statusCode >= 400, `expected >= 400 for kind mismatch, got ${misImg.statusCode}`);
    assert.equal((await pool.readTask(imgTask.taskId, owner)).state, 'submitted');
    assert.equal((await pool.readTask(vidTask.taskId, owner)).state, 'submitted');
    assert.equal((await pool.readTask(audTask.taskId, owner)).state, 'submitted');

    const foreign = await dispatchHttp({ url: `/v1/videos/tasks/${vidTask.taskId}`, headers: { authorization: 'Bearer ' + otherKey } });
    assert.equal(foreign.statusCode, 403);
    const missingTask = await dispatchHttp({ url: `/v1/videos/tasks/nonexistent-task-id`, headers: { authorization: 'Bearer ' + key } });
    assert.equal(missingTask.statusCode, 404);
    const noAuth = await dispatchHttp({ url: `/v1/videos/tasks/${vidTask.taskId}` });
    assert.equal(noAuth.statusCode, 401, `missing auth must return HTTP 401, got ${noAuth.statusCode}: ${noAuth.text}`);
    const badAuth = await dispatchHttp({ url: `/v1/videos/tasks/${vidTask.taskId}`, headers: { authorization: 'Bearer jm_invalid00000000000000000000' } });
    assert.equal(badAuth.statusCode, 401, `invalid key must return HTTP 401, got ${badAuth.statusCode}: ${badAuth.text}`);
    assert.equal(fixture.calls.filter(x => x.operation === 'request').length, callsBeforeErrors);
    break;
  }
  case 'http_task_recovery_missing_or_unknown': {
    const key = database.createApiKey('http-edge-caller').key;
    owner = subject.context.ownerHash(key);
    await add('A', 1000);
    const vidMissing = await acquire('edge-missing', { kind: 'video', model: 'jimeng-video-seedance-2.0' }); await submitted(vidMissing);
    const vidUnknownStatus = await acquire('edge-unknown-status', { kind: 'video', model: 'jimeng-video-seedance-2.0' }); await submitted(vidUnknownStatus);
    const vidFailedStatus = await acquire('edge-failed-status', { kind: 'video', model: 'jimeng-video-seedance-2.0' }); await submitted(vidFailedStatus);
    const vidEmptyDone = await acquire('edge-empty-done', { kind: 'video', model: 'jimeng-video-seedance-2.0' }); await submitted(vidEmptyDone);
    fixture.request = (_m, uri, _t, options) => {
      assert.equal(uri, '/mweb/v1/get_history_by_ids');
      const hid = options.data.history_ids[0];
      if (hid === 'fixture-history-' + vidMissing.taskId) return {};
      if (hid === 'fixture-history-' + vidUnknownStatus.taskId) return { [hid]: { status: 99, item_list: [] } };
      if (hid === 'fixture-history-' + vidFailedStatus.taskId) return { [hid]: { status: 30, fail_message: 'fixture upstream failure' } };
      if (hid === 'fixture-history-' + vidEmptyDone.taskId) return { [hid]: { status: 50, item_list: [] } };
      throw new Error('UNEXPECTED_EDGE_HISTORY: ' + hid);
    };
    for (const [label, task] of [['missing-record', vidMissing], ['unknown-status-99', vidUnknownStatus], ['failed-status-30', vidFailedStatus], ['empty-status-50', vidEmptyDone]]) {
      const res = await dispatchHttp({ url: `/v1/videos/tasks/${task.taskId}`, headers: { authorization: 'Bearer ' + key } });
      const persisted = await pool.readTask(task.taskId, owner);
      assert.notEqual(persisted.state, 'succeeded', `${label} must not mark task succeeded`);
      const falseSuccess = res.statusCode < 400 && res.body?.recoverable === true;
      assert.equal(falseSuccess, false, `${label} must not return 200 with recoverable=true (status=${res.statusCode}, body=${res.text})`);
    }
    break;
  }
  case 'http_audio_compat_queries_and_auth': {
    const axios = require('axios');
    let seq = 0;
    const historyMap = new Map();
    const historyQueries = [];
    let onHistory = null;
    axios.defaults.adapter = async config => {
      const reqBody = typeof config.data === 'string' ? JSON.parse(config.data) : Buffer.isBuffer(config.data) ? {} : config.data || {};
      const url = new URL(config.url);
      const route = url.pathname;
      const cookieHeader = typeof config.headers?.get === 'function' ? config.headers.get('Cookie') : config.headers?.Cookie || '';
      const sessionMatch = String(cookieHeader).match(/sessionid=([^;]+)/);
      const sid = sessionMatch ? sessionMatch[1] : 'unknown';
      let data;
      if (route === '/commerce/v1/benefits/user_credit') data = { credit: { gift_credit: 1000, purchase_credit: 0, vip_credit: 0 } };
      else if (route === '/passport/account/info/v2') data = { user_info: { user_id: `aud-uid-${sid}`, nickname: `Aud-${sid}`, is_vip: true } };
      else if (route === '/mweb/v1/aigc_draft/generate') {
        const id = `hist-aud-${++seq}`;
        const subId = `sub-aud-${seq}`;
        historyMap.set(id, { status: 20, item_list: [] });
        data = { aigc_data: { history_record_id: id, submit_id: subId, status: 20 } };
      } else if (route === '/mweb/v1/get_history_by_ids') {
        const ids = reqBody.history_ids || [];
        historyQueries.push({ sid, ids });
        if (onHistory) {
          data = await onHistory(ids, sid);
        } else {
          data = Object.fromEntries(ids.map(id => [id, historyMap.get(id)]));
        }
      } else {
        throw new Error('UNEXPECTED_AUDIO_HTTP_UPSTREAM: ' + route);
      }
      return { status: 200, statusText: 'OK', headers: {}, config, data: { ret: '0', data } };
    };
    const chain = require(path.join(process.env.ACCEPTANCE_ROOT, 'chain-subject.cjs'));
    const httpCall = opts => dispatchHttp({ ...opts, targetServer: chain.server, targetRoutes: chain.allRoutes });
    const ownerKey = chain.database.createApiKey('aud-http-owner').key;
    const otherKey = chain.database.createApiKey('aud-http-other').key;
    const disabledRec = chain.database.createApiKey('aud-http-disabled');
    chain.database.setApiKeyEnabled(disabledRec.apiKey.id, false);
    const callerHash = chain.ownerHash(ownerKey);
    const a = await chain.pool.create({ name: 'aud-A', cookie: `sessionid=${secretA}; webid=fixture` });
    const b = await chain.pool.create({ name: 'aud-B', cookie: `sessionid=${secretB}; webid=fixture` });

    const genCreate = await httpCall({
      method: 'POST', url: '/v1/audios/generations',
      headers: { authorization: 'Bearer ' + ownerKey, 'idempotency-key': 'http-aud-gen-1' },
      payload: { prompt: 'audio gen compat', voice_name: '苏感低音' },
    });
    assert.equal(genCreate.statusCode, 200, genCreate.text);
    const genUpId = genCreate.body?.data?.task_id;
    const genPoolId = genCreate.body?.pool_task_id;
    assert.ok(genUpId && genPoolId);
    assert.equal(chain.pool.readTask(genPoolId, callerHash).accountId, a.id);

    const compatCreate = await httpCall({
      method: 'POST', url: '/v1/audio/tasks',
      headers: { authorization: 'Bearer ' + ownerKey, 'idempotency-key': 'http-aud-compat-1' },
      payload: { input: 'audio tasks compat', voice_name: '苏感低音' },
    });
    assert.equal(compatCreate.statusCode, 200, compatCreate.text);
    const compatUpId = compatCreate.body?.task_id;
    const compatPoolId = compatCreate.body?.pool_task_id;
    assert.ok(compatUpId && compatPoolId);
    assert.equal(chain.pool.readTask(compatPoolId, callerHash).accountId, b.id);

    await chain.pool.reorderAccounts({ accountIds: [b.id, a.id], revision: (await chain.pool.getSettings()).revision });
    await chain.pool.setEnabled(a.id, false);

    for (const queryPath of [`/v1/audios/generations/${genUpId}`, `/v1/audio/tasks/${compatUpId}`]) {
      assert.equal((await httpCall({ url: queryPath })).statusCode, 401);
      assert.equal((await httpCall({ url: queryPath, headers: { authorization: 'Bearer jm_invalid00000000000000000000' } })).statusCode, 401);
      assert.equal((await httpCall({ url: queryPath, headers: { authorization: 'Bearer ' + disabledRec.key } })).statusCode, 401);
      assert.equal((await httpCall({ url: queryPath, headers: { authorization: 'Bearer ' + otherKey } })).statusCode, 403);
    }

    const procGen = await httpCall({ url: `/v1/audios/generations/${genUpId}`, headers: { authorization: 'Bearer ' + ownerKey } });
    assert.equal(procGen.statusCode, 200);
    assert.equal(procGen.body?.data?.state, 'processing');
    const procCompat = await httpCall({ url: `/v1/audio/tasks/${compatUpId}`, headers: { authorization: 'Bearer ' + ownerKey } });
    assert.equal(procCompat.statusCode, 200);
    assert.equal(procCompat.body?.status, 'processing');
    assert.deepEqual(historyQueries.map(x => x.sid), [secretA, secretB]);

    historyMap.set(genUpId, { status: 50, item_list: [{ audio: { origin_audio: { audio_url: 'https://fixture.invalid/http-gen-done.mp3', duration_ms: 5000 } } }] });
    historyMap.set(compatUpId, { status: 50, item_list: [{ audio: { origin_audio: { audio_url: 'https://fixture.invalid/http-compat-done.mp3', duration_ms: 5000 } } }] });

    const doneGen = await httpCall({ url: `/v1/audios/generations/${genUpId}`, headers: { authorization: 'Bearer ' + ownerKey } });
    assert.equal(doneGen.statusCode, 200);
    assert.equal(doneGen.body?.data?.state, 'succeeded');
    assert.equal(doneGen.body?.data?.audio_url, 'https://fixture.invalid/http-gen-done.mp3');
    assert.equal(doneGen.body?.data?.url, 'https://fixture.invalid/http-gen-done.mp3');
    assert.equal(chain.pool.readTask(genPoolId, callerHash).state, 'succeeded');
    assert.equal(chain.pool.readTask(genPoolId, callerHash).settling, false);

    const doneCompat = await httpCall({ url: `/v1/audio/tasks/${compatUpId}`, headers: { authorization: 'Bearer ' + ownerKey } });
    assert.equal(doneCompat.statusCode, 200);
    assert.equal(doneCompat.body?.status, 'succeeded');
    assert.equal(doneCompat.body?.audio_url, 'https://fixture.invalid/http-compat-done.mp3');
    assert.equal(doneCompat.body?.url, 'https://fixture.invalid/http-compat-done.mp3');
    assert.equal(chain.pool.readTask(compatPoolId, callerHash).state, 'succeeded');
    assert.equal(chain.pool.readTask(compatPoolId, callerHash).settling, false);

    const raceCreate = await httpCall({
      method: 'POST', url: '/v1/audio/tasks',
      headers: { authorization: 'Bearer ' + ownerKey, 'idempotency-key': 'http-aud-race-1' },
      payload: { input: 'audio race fail', voice_name: '苏感低音' },
    });
    assert.equal(raceCreate.statusCode, 200);
    const raceUpId = raceCreate.body?.task_id;
    const racePoolId = raceCreate.body?.pool_task_id;
    onHistory = async ids => {
      chain.pool.transitionTask(racePoolId, { state: 'failed', error: 'concurrent audio failure' });
      return Object.fromEntries(ids.map(id => [id, { status: 50, item_list: [{ audio: { origin_audio: { audio_url: 'https://fixture.invalid/stale-audio.mp3' } } }] }]));
    };
    const raceCompatRes = await httpCall({ url: `/v1/audio/tasks/${raceUpId}`, headers: { authorization: 'Bearer ' + ownerKey } });
    assert.equal(raceCompatRes.statusCode, 200);
    assert.equal(raceCompatRes.body?.status, 'failed');
    assert.equal(raceCompatRes.body?.audio_url, null);
    assert.equal(raceCompatRes.body?.url, null);
    const raceGenRes = await httpCall({ url: `/v1/audios/generations/${raceUpId}`, headers: { authorization: 'Bearer ' + ownerKey } });
    assert.equal(raceGenRes.statusCode, 200);
    assert.equal(raceGenRes.body?.data?.state, 'failed');
    assert.equal(raceGenRes.body?.data?.audio_url, null);
    assert.equal(raceGenRes.body?.data?.url, null);
    break;
  }
  case 'http_text_multiturn_and_unsupported_continuation': {
    const axios = require('axios');
    axios.defaults.adapter = async config => {
      const url = new URL(config.url);
      const route = url.pathname;
      const cookieHeader = typeof config.headers?.get === 'function' ? config.headers.get('Cookie') : config.headers?.Cookie || '';
      const sessionMatch = String(cookieHeader).match(/sessionid=([^;]+)/);
      const sid = sessionMatch ? sessionMatch[1] : 'unknown';
      if (route === '/commerce/v1/benefits/user_credit') {
        return { status: 200, statusText: 'OK', headers: {}, config, data: { ret: '0', data: { credit: { gift_credit: 1000, purchase_credit: 0, vip_credit: 0 } } } };
      }
      if (route === '/passport/account/info/v2') {
        return { status: 200, statusText: 'OK', headers: {}, config, data: { ret: '0', data: { user_info: { user_id: `text-uid-${sid}`, nickname: `Text-${sid}`, is_vip: true } } } };
      }
      throw new Error('UNEXPECTED_TEXT_HTTP_UPSTREAM: ' + route);
    };
    const chain = require(path.join(process.env.ACCEPTANCE_ROOT, 'chain-subject.cjs'));
    const httpCall = opts => dispatchHttp({ ...opts, targetServer: chain.server, targetRoutes: chain.allRoutes });
    globalThis.__poolTextFixture = { submits: [], cookies: [], fail: false };
    try {
      await chain.browserTransport.setMode('always', false);
      chain.browserTransport.request = async input => axios.defaults.adapter({ url: input.url, data: JSON.stringify(input.data || {}), headers: new axios.AxiosHeaders(input.headers) });
      const ownerKey = chain.database.createApiKey('text-http-owner').key;
      const callerHash = chain.ownerHash(ownerKey);
      const a = await chain.pool.create({ name: 'text-A', cookie: `sessionid=${secretA}; webid=fixture` });
      const b = await chain.pool.create({ name: 'text-B', cookie: `sessionid=${secretB}; webid=fixture` });

      const turn1 = await httpCall({
        method: 'POST', url: '/v1/chat/completions',
        headers: { authorization: 'Bearer ' + ownerKey, 'idempotency-key': 'mt-turn-1' },
        payload: { model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'turn 1 question' }], stream: false },
      });
      assert.equal(turn1.statusCode, 200, turn1.text);
      assert.equal(turn1.body?.choices?.[0]?.message?.content, 'fixture answer');
      assert.equal(turn1.headers['x-jimeng-context-mode'], undefined);
      const turn1Id = turn1.headers['x-pool-task-id'];
      assert.equal(chain.pool.readTask(turn1Id, callerHash).accountId, a.id);

      await chain.pool.reorderAccounts({ accountIds: [b.id, a.id], revision: (await chain.pool.getSettings()).revision });

      const turn2 = await httpCall({
        method: 'POST', url: '/v1/chat/completions',
        headers: { authorization: 'Bearer ' + ownerKey, 'idempotency-key': 'mt-turn-2' },
        payload: {
          model: 'glm-5.3-flash',
          messages: [
            { role: 'user', content: 'turn 1 question' },
            { role: 'assistant', content: 'fixture answer' },
            { role: 'user', content: 'turn 2 follow-up' },
          ],
          stream: false,
        },
      });
      assert.equal(turn2.statusCode, 200, turn2.text);
      assert.equal(turn2.body?.choices?.[0]?.message?.content, 'fixture answer');
      assert.equal(turn2.headers['x-jimeng-context-mode'], 'role-labelled-history');
      const turn2Id = turn2.headers['x-pool-task-id'];
      assert.equal(chain.pool.readTask(turn2Id, callerHash).accountId, b.id);
      assert.equal(chain.pool.readTask(turn1Id, callerHash).accountId, a.id);
      assert.equal(globalThis.__poolTextFixture.submits.length, 2);
      const turn2Prompt = globalThis.__poolTextFixture.submits[1].messages[0].content.content_parts[0].text;
      assert.match(turn2Prompt, /turn 1 question/);
      assert.match(turn2Prompt, /fixture answer/);
      assert.match(turn2Prompt, /turn 2 follow-up/);

      const unsupported = await httpCall({
        method: 'POST', url: '/v1/chat/completions',
        headers: { authorization: 'Bearer ' + ownerKey, 'idempotency-key': 'mt-unsupported' },
        payload: {
          model: 'glm-5.3-flash',
          previous_response_id: 'resp_fixture_123',
          messages: [{ role: 'user', content: 'continue' }],
          stream: false,
        },
      });
      assert.equal(unsupported.statusCode, 400, unsupported.text);
      assert.equal(chain.pool.listTasks().total, 2, 'rejected previous_response_id must not acquire a pool lease');
      assert.equal(globalThis.__poolTextFixture.submits.length, 2);
    } finally {
      delete globalThis.__poolTextFixture;
    }
    break;
  }
  case 'duplicate_session_cookie_row': {
    const a = await add('A-session', 1000, secretA);
    await rejected(() => pool.create({ name: 'A-cookie-dup', cookie: `webid=fixture-webid; sessionid=${secretA}; sid_tt=${secretA}` }));
    const b = await add('B-other', 1000, secretB);
    await rejected(() => pool.update(b.id, { cookie: `webid=fixture-webid; sessionid=${secretA}` }));
    assert.equal((await dashboard()).accounts.length, 2);
    assert.equal((await dashboard()).accounts.some(x => x.id === a.id), true);
    break;
  }
  case 'shared_verified_uid_exclusive': {
    fixture.request = (_m, uri, sessionId) => {
      if (uri === '/commerce/v1/benefits/user_credit') {
        const credit = fixture.credits[sessionId];
        return { credit: { gift_credit: credit, purchase_credit: 0, vip_credit: 0 } };
      }
      if (uri === '/passport/account/info/v2') return { user_info: { user_id: 'shared-verified-uid', nickname: 'Shared User', is_vip: true } };
      throw new Error('UNEXPECTED_SHARED_UID_URI: ' + uri);
    };
    const a = await add('A-uid', 1000, secretA);
    const b = await add('B-uid', 1000, secretB);
    const first = await acquire('uid-exclusive-1', { estimatedCredits: null });
    assert.equal(first.account.id, a.id);
    await rejected(() => acquire('uid-exclusive-2', { estimatedCredits: null }));
    const during = (await dashboard()).accounts;
    assert.equal(during.find(x => x.id === b.id).scheduling.eligible, false);
    await submitted(first);
    await pool.transitionTask(first.taskId, { state: 'succeeded' });
    await pool.settleTask(first.taskId);
    const after = await acquire('uid-exclusive-3', { estimatedCredits: null });
    assert.ok([a.id, b.id].includes(after.account.id));
    break;
  }
  case 'peer_refresh_blocks_stale_peer': {
    fixture.request = (_m, uri, sessionId) => {
      if (uri === '/commerce/v1/benefits/user_credit') {
        const credit = fixture.credits[sessionId];
        return { credit: { gift_credit: credit, purchase_credit: 0, vip_credit: 0 } };
      }
      if (uri === '/passport/account/info/v2') return { user_info: { user_id: 'shared-uid-peer-refresh', nickname: 'Shared User', is_vip: true } };
      throw new Error('UNEXPECTED_PEER_REFRESH_URI: ' + uri);
    };
    const a = await add('A-peer', 1000, secretA);
    const b = await add('B-peer', 1000, secretB);
    await order([b.id, a.id]);
    fixture.credits[secretA] = 50;
    fixture.credits[secretB] = 50;
    await pool.refreshStatus(a.id);
    const snapB = (await dashboard()).accounts.find(x => x.id === b.id);
    assert.equal(snapB.scheduling.eligible, false, 'peer B must not stay eligible on stale 1000 balance after peer A refreshed to 50');
    await rejected(() => acquire('peer-stale-order'));
    break;
  }
  case 'identity_temp_failure_preserves_subject': {
    let failIdentity = false;
    fixture.request = (_m, uri, sessionId) => {
      if (uri === '/commerce/v1/benefits/user_credit') {
        const credit = fixture.credits[sessionId];
        return { credit: { gift_credit: credit, purchase_credit: 0, vip_credit: 0 } };
      }
      if (uri === '/passport/account/info/v2') {
        if (failIdentity) throw new Error('temporary passport failure');
        return { user_info: { user_id: 'shared-uid-temp-fail', nickname: 'Shared User', is_vip: true } };
      }
      throw new Error('UNEXPECTED_TEMP_ID_URI: ' + uri);
    };
    const a = await add('A-id', 1000, secretA);
    const b = await add('B-id', 1000, secretB);
    assert.equal((await dashboard()).accounts.find(x => x.id === a.id).upstreamIdentity.userId, 'shared-uid-temp-fail');
    failIdentity = true;
    await pool.refreshStatus(a.id);
    const after = (await dashboard()).accounts;
    assert.equal(after.find(x => x.id === a.id).upstreamIdentity.verified, true, 'temporary identity failure must preserve verified flag');
    assert.equal(after.find(x => x.id === a.id).upstreamIdentity.userId, 'shared-uid-temp-fail', 'temporary identity failure must preserve previous userId');
    assert.equal(after.find(x => x.id === b.id).scheduling.eligible, false, 'peer B must stay blocked under preserved shared subject');
    await acquire('temp-id-lock-1', { estimatedCredits: null });
    await rejected(() => acquire('temp-id-lock-2', { estimatedCredits: null }));
    break;
  }
  case 'chain_risk_4013_fallback_timeout':
  case 'chain_status_99_with_url':
  case 'chain_status_50_missing_item_list':
  case 'chain_recovery_race_foreground_succeeded':
  case 'chain_recovery_race_foreground_failed':
  case 'chain_text_saved_result_recovery':
  case 'chain_video_sse_wait_hint_finish_reason': {
    const axios = require('axios');
    const mode = action;
    let seq = 0;
    const history = new Map();
    axios.defaults.adapter = async config => {
      const reqBody = typeof config.data === 'string' ? JSON.parse(config.data) : Buffer.isBuffer(config.data) ? {} : config.data || {};
      const url = new URL(config.url);
      const route = url.pathname;
      let data;
      if (route === '/commerce/v1/benefits/user_credit') data = { credit: { gift_credit: 1000, purchase_credit: 0, vip_credit: 0 } };
      else if (route === '/passport/account/info/v2') data = { user_info: { user_id: 'chain-verified-uid', nickname: 'Chain Fixture', is_vip: true } };
      else if (route.endsWith('get_common_config')) data = {};
      else if (route === '/mweb/v1/aigc_draft/generate') {
        if (mode === 'chain_risk_4013_fallback_timeout') return { status: 200, statusText: 'OK', headers: {}, config, data: { ret: '4013', errmsg: 'fixture rejected' } };
        if (mode === 'chain_video_sse_wait_hint_finish_reason') {
          await new Promise(resolve => setTimeout(resolve, 30));
          throw Object.assign(new Error('network timeout'), { code: 'ETIMEDOUT' });
        }
        const id = String(++seq);
        history.set(id, {
          status: mode === 'chain_status_99_with_url' ? 99 : 50,
          item_list: [{ image: { large_images: [{ image_url: 'https://fixture.invalid/chain-img.webp' }] } }],
        });
        data = { aigc_data: { history_record_id: id } };
      } else if (route === '/mweb/v1/get_history_by_ids') {
        data = Object.fromEntries((reqBody.history_ids || []).map(id => [
          id,
          mode === 'chain_status_50_missing_item_list' ? { status: 50 } : history.get(id),
        ]));
      } else {
        throw new Error('UNEXPECTED_CHAIN_UPSTREAM: ' + route);
      }
      return { status: 200, statusText: 'OK', headers: {}, config, data: { ret: '0', data } };
    };
    const chain = require(path.join(process.env.ACCEPTANCE_ROOT, 'chain-subject.cjs'));
    const key = chain.database.createApiKey('chain-caller').key;
    const otherKey = chain.database.createApiKey('chain-other').key;
    const callerHash = chain.ownerHash(key);
    const account = await chain.pool.create({ name: 'chain-a', cookie: `sessionid=${secretA}; webid=fixture-only` });
    await chain.pool.updateSettings({ ...await chain.pool.getSettings(), mode: 'fixed', fixedAccountId: account.id });
    const req = (reqBody = {}, id = 'chain-req-1', params = {}, keyValue = key) => ({
      body: reqBody, params, files: {}, query: {}, path: '/fixture',
      headers: { authorization: `Bearer ${keyValue}`, 'idempotency-key': id },
      signal: new AbortController().signal, validate() { return this; },
    });
    if (action === 'chain_risk_4013_fallback_timeout') {
      await chain.browserTransport.setMode('auto', false);
      const oldShouldUse = chain.browserTransport.shouldUse;
      const oldRequest = chain.browserTransport.request;
      chain.browserTransport.shouldUse = () => false;
      let fallbackCalls = 0;
      chain.browserTransport.request = async () => { fallbackCalls++; throw Object.assign(new Error('network timeout after submit'), { code: 'ETIMEDOUT' }); };
      try {
        const result = await chain.imageRoutes.post['/generations'](req({ prompt: 'chain risk 4013' }, 'chain-risk'));
        const taskId = result.body?.pool_task_id || result.pool_task_id;
        const task = chain.pool.readTask(taskId, callerHash);
        assert.equal(fallbackCalls, 1);
        assert.equal(task.state, 'unknown', `4013->fallback timeout must remain unknown, got ${task.state}`);
        assert.equal(chain.pool.get(account.id).scheduling.unknownCostBusy, true, 'account must remain held while fallback timeout is unknown');
      } finally {
        chain.browserTransport.shouldUse = oldShouldUse;
        chain.browserTransport.request = oldRequest;
      }
    } else if (action === 'chain_status_99_with_url') {
      const result = await chain.imageRoutes.post['/generations'](req({ prompt: 'chain status 99' }, 'chain-status99'));
      assert.equal(result.data?.[0]?.url, undefined, 'status 99 with URL must never return generated image URL as success');
      assert.ok(status(result) >= 400, `status 99 must not succeed with HTTP < 400, got ${status(result)}`);
      const taskId = result.body?.pool_task_id || result.pool_task_id;
      const task = chain.pool.readTask(taskId, callerHash);
      assert.notEqual(task.state, 'succeeded');
      assert.equal(chain.pool.get(account.id).scheduling.unknownCostBusy, true);
      const recovery = await chain.imageRoutes.get['/tasks/:taskId'](req({}, 'chain-status99-q', { taskId }));
      assert.equal(Boolean(status(recovery) < 400 && body(recovery)?.recoverable === true && body(recovery)?.data?.length), false, 'status 99 must not recover URL as success');
    } else if (action === 'chain_status_50_missing_item_list') {
      const result = await chain.imageRoutes.post['/generations'](req({ prompt: 'chain status 50 missing item_list' }, 'chain-missing-items'));
      const taskId = result.body?.pool_task_id || result.pool_task_id;
      const task = chain.pool.readTask(taskId, callerHash);
      assert.notEqual(task.state, 'succeeded', 'status 50 with missing item_list must not mark succeeded');
      assert.equal(chain.pool.get(account.id).scheduling.unknownCostBusy, true, 'account must remain busy when status 50 lacks item_list');
      assert.equal(result.data?.[0]?.url, undefined, 'status 50 with missing item_list must not return success URL');
      const recovery = await chain.imageRoutes.get['/tasks/:taskId'](req({}, 'chain-missing-items-q', { taskId }));
      assert.equal(Boolean(status(recovery) < 400 && body(recovery)?.recoverable === true), false, 'status 50 with missing item_list must not recover as success');
    } else if (action === 'chain_recovery_race_foreground_succeeded') {
      const lease = await chain.pool.acquireTask({ requestId: 'chain-race-ok', ownerHash: callerHash, requestFingerprint: 'chain-race-ok', kind: 'image', model: 'jimeng-image-5.0-lite', estimatedCredits: null });
      chain.pool.transitionTask(lease.taskId, { state: 'submitting' });
      chain.pool.transitionTask(lease.taskId, { state: 'submitted', upstreamTaskId: 'race-history-ok' });
      const response = await chain.recoverStoredPoolTask(lease.taskId, {
        queryHistory: async () => {
          chain.pool.transitionTask(lease.taskId, { state: 'succeeded', result: { kind: 'image', urls: ['https://fixture.invalid/winner.webp'] } });
          return { 'race-history-ok': { status: 20 } };
        },
      });
      assert.equal(response.task.state, 'succeeded');
      assert.equal(response.recoverable, true);
      assert.equal(response.data[0]?.url, 'https://fixture.invalid/winner.webp');
    } else if (action === 'chain_recovery_race_foreground_failed') {
      const lease = await chain.pool.acquireTask({ requestId: 'chain-race-fail', ownerHash: callerHash, requestFingerprint: 'chain-race-fail', kind: 'image', model: 'jimeng-image-5.0-lite', estimatedCredits: null });
      chain.pool.transitionTask(lease.taskId, { state: 'submitting' });
      chain.pool.transitionTask(lease.taskId, { state: 'submitted', upstreamTaskId: 'race-history-fail' });
      const response = await chain.recoverStoredPoolTask(lease.taskId, {
        queryHistory: async () => {
          chain.pool.transitionTask(lease.taskId, { state: 'failed' });
          return { 'race-history-fail': { status: 50, item_list: [{ image: { large_images: [{ image_url: 'https://fixture.invalid/stale.webp' }] } }] } };
        },
      });
      assert.equal(response.task.state, 'failed');
      assert.equal(response.recoverable, false);
      assert.deepEqual(response.data, []);
    } else if (action === 'chain_text_saved_result_recovery') {
      globalThis.__poolTextFixture = { submits: [], cookies: [], fail: false };
      await chain.browserTransport.setMode('always', false);
      chain.browserTransport.request = async input => axios.defaults.adapter({ url: input.url, data: JSON.stringify(input.data || {}), headers: new axios.AxiosHeaders(input.headers) });
      const reqBody = { model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'chain text' }] };
      const result = await chain.chatRoutes.post['/completions'](req(reqBody, 'chain-text'));
      assert.equal(result.body.choices[0].message.content, 'fixture answer');
      const id = result.headers['X-Pool-Task-Id'];
      const stored = chain.pool.readTaskResult(id, callerHash);
      assert.ok(stored && JSON.stringify(stored).includes('fixture answer'), `completed text must save minimal result, got ${JSON.stringify(stored)}`);
      const recovery = await chain.chatRoutes.get['/tasks/:taskId'](req({}, 'chain-text-query', { taskId: id }));
      assert.equal(status(recovery), 200);
      assert.equal(body(recovery).recoverable, true, 'owner query must recover saved text result');
      assert.ok(JSON.stringify(body(recovery)).includes('fixture answer'));
      const denied = await chain.chatRoutes.get['/tasks/:taskId'](req({}, 'chain-text-denied', { taskId: id }, otherKey));
      assert.ok(status(denied) >= 400);
      delete globalThis.__poolTextFixture;
    } else if (action === 'chain_video_sse_wait_hint_finish_reason') {
      const oldTimeout = globalThis.setTimeout;
      globalThis.setTimeout = (fn, ms, ...args) => oldTimeout(fn, ms === 120000 ? 0 : ms, ...args);
      try {
        const result = await chain.chatRoutes.post['/completions'](req({ model: 'jimeng-video-seedance-2.0', stream: true, messages: [{ role: 'user', content: 'chain sse' }] }, 'chain-sse'));
        let output = '';
        for await (const chunk of result.body) output += chunk.toString();
        const frames = output.split('\n\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
        const hintFrames = frames.filter(f => f.choices?.length);
        const stops = frames.filter(f => f.choices?.some(c => c.finish_reason === 'stop')).length;
        const errors = frames.filter(f => f.error).length;
        assert.ok(hintFrames.length >= 1, 'must emit 2-minute waiting hint frame');
        assert.equal(hintFrames[0].choices[0].finish_reason, null, '2-minute waiting hint frame must use finish_reason null');
        assert.equal(stops, 0, 'slow video SSE must not emit premature finish_reason stop before error');
        assert.equal(errors, 1);
        assert.equal(chain.pool.readTask(result.headers['X-Pool-Task-Id'], callerHash).state, 'unknown');
      } finally {
        globalThis.setTimeout = oldTimeout;
      }
    }
    break;
  }
  case 'seedance25_20s_actual_models': {
    const s25 = require(path.join(process.env.ACCEPTANCE_ROOT, 'seedance25-subject.cjs'));
    fixture.credits[secretA] = 1000;
    const generateRequests = [];
    const historyRequests = [];
    fixture.request = (_method, uri, token, options) => {
      if (uri.endsWith('get_common_config')) {
        return { models: [{ model_req_key: 'dreamina_seedance_45_pro', name: 'Seedance 2.5' }] };
      }
      if (uri === '/commerce/v1/benefits/user_credit') {
        return { credit: { gift_credit: 1000, purchase_credit: 0, vip_credit: 0 } };
      }
      if (uri === '/fixture/upload') {
        return { image_uri: 'uploaded:fixture-ref', width: 720, height: 720 };
      }
      if (uri === '/mweb/v1/aigc_draft/generate') {
        generateRequests.push({ token, options });
        return { aigc_data: { history_record_id: 'fixture-s25-20s-history' } };
      }
      if (uri === '/mweb/v1/get_history_by_ids') {
        historyRequests.push({ token, options });
        return { 'fixture-s25-20s-history': { status: 50, item_list: [{ video: { url: 'https://fixture.invalid/s25-20s.mp4' } }] } };
      }
      throw new Error('UNEXPECTED_S25_URI: ' + uri);
    };
    const staticCfg = await s25.models.resolveVideoModelConfig('jimeng-video-seedance-2.5');
    const dynamicCfg = await s25.models.resolveVideoModelConfig('jimeng-video-seedance-2.5', secretA);
    assert.equal(staticCfg.supportedDurations.includes(20), true);
    assert.equal(dynamicCfg.supportedDurations.includes(20), true);
    assert.equal(staticCfg.supportedDurations.length, 26);
    const omni20 = { duration: 20, resolution: '720p', functionMode: 'omni_reference', filePaths: ['https://fixture.invalid/ref.png'] };
    const videoUrl = await s25.videos.generateVideoWithRetry('jimeng-video-seedance-2.5', 'fixture 20s omni', omni20, secretA, secretA);
    assert.equal(videoUrl, 'https://fixture.invalid/s25-20s.mp4');
    assert.equal(generateRequests.length, 1);
    assert.match(JSON.stringify(generateRequests[0].options.data), /20000/);
    assert.equal(historyRequests.length, 1);
    assert.equal(historyRequests[0].token, secretA);
    assert.equal(historyRequests[0].options.cookie, secretA);
    for (const invalid of [
      { duration: 20, resolution: '720p', filePaths: ['https://fixture.invalid/ref.png'] },
      { ...omni20, resolution: '1080p' },
      { ...omni20, videoPaths: ['https://fixture.invalid/ref.mp4'] },
      { ...omni20, duration: 31 },
    ]) {
      await assert.rejects(() => s25.videos.generateVideoWithRetry('jimeng-video-seedance-2.5', 'invalid', invalid, secretA, secretA), /Seedance 2\.5/);
    }
    assert.equal(generateRequests.length, 1);
    break;
  }
  case 'heartbeat_pool_task_preservation': {
    await add('A', 1000);
    const key = database.createApiKey('heartbeat-caller').key;
    const callerHash = subject.context.ownerHash(key);
    let mode = 'success';
    let submitCalls = 0;
    const hbRoutes = subject.withPoolRoutes({
      prefix: '/fixture-hb',
      post: {
        '/run': async req => {
          await subject.auth.resolveAuthorization(req.headers.authorization);
          return subject.jsonHeartbeatResponse(async () => {
            submitCalls++;
            subject.context.beginPoolSubmission('hb-submit-' + submitCalls);
            await new Promise(resolve => setTimeout(resolve, 40));
            if (mode === 'fail') {
              await subject.context.failPoolTask();
              throw new Error('simulated late upstream timeout');
            }
            subject.context.acceptPoolSubmission('hb-history-' + submitCalls);
            await subject.context.finishPoolTask('succeeded');
            return { created: 1, data: [{ url: 'https://fixture.invalid/hb-ok.mp4' }] };
          }, 10);
        },
      },
    }, 'video', 'jimeng-video-seedance-2.0');
    const makeReq = idKey => new subject.Request({ res: new EventEmitter(), request: { method: 'POST', path: '/fixture-hb/run', headers: { authorization: 'Bearer ' + key, 'idempotency-key': idKey }, body: { prompt: idKey } }, params: {}, query: {} });
    const okResp = await hbRoutes.post['/run'](makeReq('hb-ok'));
    assert.equal(status(okResp), 200);
    let okRaw = ''; for await (const chunk of okResp.body) okRaw += chunk.toString();
    assert.match(okRaw, /^\n+\{/);
    assert.equal(JSON.parse(okRaw).data[0].url, 'https://fixture.invalid/hb-ok.mp4');
    const okTask = await pool.readTask(okResp.headers['X-Pool-Task-Id'], callerHash);
    assert.equal(okTask.state, 'succeeded');

    mode = 'fail';
    const failResp = await hbRoutes.post['/run'](makeReq('hb-fail'));
    let failRaw = ''; for await (const chunk of failResp.body) failRaw += chunk.toString();
    assert.match(failRaw, /^\n+\{/);
    const failJson = JSON.parse(failRaw);
    assert.equal(failJson.data, null);
    assert.notEqual(failJson.code, 0);
    const failTask = await pool.readTask(failResp.headers['X-Pool-Task-Id'], callerHash);
    assert.equal(failTask.state, 'unknown');
    assert.equal((await dashboard()).accounts[0].scheduling.unknownCostBusy, true);

    await pool.transitionTask(failTask.id, { state: 'failed' });
    await pool.settleTask(failTask.id);
    mode = 'success';
    const callsBeforeDisconnect = submitCalls;
    const discResp = await hbRoutes.post['/run'](makeReq('hb-disconnect'));
    discResp.body.destroy();
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(submitCalls, callsBeforeDisconnect + 1);
    const discTask = await pool.readTask(discResp.headers['X-Pool-Task-Id'], callerHash);
    assert.equal(discTask.state, 'succeeded');
    break;
  }
  case 'race_seed': await add('A', 250); has('acquireTask'); break;
  case 'race_acquire': {
    has('acquireTask'); await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(process.env.RACE_START) - Date.now())));
    try { await acquire('process-' + process.env.RACE_ID); console.log('RACE_ACCEPTED'); }
    catch (error) { assert.doesNotMatch(String(error), /SQLITE_BUSY|locked|TypeError|MISSING_CONTRACT/); console.log('RACE_REJECTED'); }
    break;
  }
  case 'race_verify': assert.equal((await dashboard()).accounts[0].scheduling.reservedCredits, 80); assert.equal((await dashboard()).summary.activeTaskCount, 1); break;
  case 'assets': {
    const a = await add('A', 500); const b = await add('B', 500, secretB);
    const key = database.createApiKey('asset-owner').key; const other = database.createApiKey('other-owner').key;
    const vidA = 'v0' + 'a'.repeat(24), vidB = 'v0' + 'b'.repeat(24), missing = 'v0' + 'c'.repeat(24);
    subject.assets.rememberUploadAsset(vidA, 5000, { token: secretA, cookie: secretA, accountId: a.id, managedKey: key });
    subject.assets.rememberUploadAsset(vidB, 5000, { token: secretB, cookie: secretB, accountId: b.id, managedKey: key });
    const prove = (vids, callingKey = key) => subject.assets.proveUploadAssets({ requestBody: { audio_paths: vids } }, [callingKey], k => database.validateApiKey(k).valid, poolModule.readTaskAccount);
    assert.equal(prove([vidA]), a.id); assert.throws(() => prove([vidA], other)); assert.throws(() => prove([vidA, vidB])); assert.throws(() => prove([missing]));
    break;
  }
  case 'readonly_auth': {
    await add('A', 500); const key = database.createApiKey('reader').key; const before = await dashboard();
    for (let i = 0; i < 3; i++) assert.equal((await subject.auth.resolveAuthorization('Bearer ' + key)).token, secretA);
    const after = await dashboard(); assert.deepEqual(after.tasks, before.tasks); assert.deepEqual(after.events, before.events); assert.deepEqual(after.accounts.map(a => a.lastUsedAt), before.accounts.map(a => a.lastUsedAt));
    assert.equal((await subject.auth.resolveAuthorization('Bearer fixture-native-session')).token, 'fixture-native-session');
    await rejected(() => subject.auth.resolveAuthorization('Bearer jm_invalidbutmanagedkeyformat123456789')); break;
  }
  case 'upload_flow': {
    const a = await add('A', 1000); const b = await add('B', 1000, secretB); const key = database.createApiKey('upload-owner').key;
    const req = (route, data, requestId) => new subject.Request({ res: new EventEmitter(), request: { method: 'POST', path: '/v1/audios' + route, headers: { authorization: 'Bearer ' + key, 'idempotency-key': requestId }, body: data }, params: {}, query: {} });
    const upload = body(await subject.audioRoutes.post['/uploads'](req('/uploads', { source: 'fixture-source.wav' }, 'upload-request')));
    assert.equal(upload.data.vid, 'v0' + 'a'.repeat(24));
    await order([b.id, a.id]);
    await subject.audioRoutes.post['/generations'](req('/generations', { prompt: 'fixture', audio_paths: [upload.data.vid], mode: 'unified_edit' }, 'generation-request'));
    const uploadCall = fixture.calls.find(x => x.operation === 'upload'); const submitCall = fixture.calls.find(x => x.operation === 'submit');
    assert.equal(uploadCall.accountId, a.id); assert.equal(uploadCall.token, secretA); assert.equal(submitCall.accountId, a.id);
    assert.equal((await dashboard()).tasks.find(x => x.requestId === 'generation-request').accountId, a.id); break;
  }
  case 'request_identity': {
    const dir = path.dirname(process.env.DB_PATH); fs.writeFileSync(path.join(dir, 'a'), 'same bytes'); fs.writeFileSync(path.join(dir, 'b'), 'same bytes');
    const req = { headers: {}, path: '/v1/images/generations', body: { model: 'image', prompt: 'fixture sensitive prompt' } };
    const first = await subject.context.requestIdentity(req, 'image', 'image'); const second = await subject.context.requestIdentity(req, 'image', 'image');
    assert.notEqual(first.requestId, second.requestId); assert.equal(first.requestFingerprint, second.requestFingerprint);
    const keyed = { ...req, headers: { 'idempotency-key': 'fixture-id' }, files: { file: { filepath: path.join(dir, 'a') } } };
    const fileA = await subject.context.requestIdentity(keyed, 'image', 'image'); keyed.files.file.filepath = path.join(dir, 'b');
    const fileB = await subject.context.requestIdentity(keyed, 'image', 'image'); assert.equal(fileA.requestFingerprint, fileB.requestFingerprint);
    fs.writeFileSync(path.join(dir, 'b'), 'different bytes'); assert.notEqual((await subject.context.requestIdentity(keyed, 'image', 'image')).requestFingerprint, fileA.requestFingerprint); break;
  }
  case 'retry_image':
  case 'retry_video': {
    const retry = require(path.join(process.env.ACCEPTANCE_ROOT, 'retry-subject.cjs')); fixture.credits[secretA] = 1000;
    fixture.request = (_method, uri) => { assert.match(uri, /generate/); throw Object.assign(new Error('fixture 积分不足 2039'), { code: -2008 }); };
    const options = action === 'retry_image' ? { ratio: '16:9', resolution: '4k', n: 1 } : { ratio: '16:9', resolution: '1080p', duration: 20 };
    const original = structuredClone(options);
    const invoke = action === 'retry_image' ? () => retry.images.generateImagesWithRetry('jimeng-image-4.0', 'fixture', options, secretA)
      : () => retry.videos.generateVideoWithRetry('jimeng-video-seedance-2.0', 'fixture', options, secretA);
    await assert.rejects(invoke, /积分不足/);
    const calls = fixture.calls.filter(x => x.operation === 'request'); assert.equal(calls.length, 1, 'must not retry after upstream rejection');
    assert.deepEqual(options, original);
    const payload = JSON.stringify(calls[0].options);
    if (action === 'retry_video') { assert.match(payload, /1080p/); assert.match(payload, /20000/); }
    else assert.equal(JSON.parse(calls[0].options.data.draft_content).component_list[0].abilities.generate.core_param.large_image_info.resolution_type, '4k');
    break;
  }
  case 'core_timeout': case 'core_error_secrets': {
    const axios = require('axios'); const calls = [];
    axios.defaults.adapter = async config => { calls.push(config); throw Object.assign(new Error(action === 'core_error_secrets' ? `network timeout; sessionid=${secretA}; prompt=FIXTURE_PRIVATE_PROMPT; signature=FIXTURE_SIGNED_SECRET` : 'fixture network timeout'), { code: 'ETIMEDOUT' }); };
    const core = require(path.join(process.env.ACCEPTANCE_ROOT, 'core-subject.cjs')); const transitions = [];
    const context = { requestId: 'core-timeout', requestFingerprint: 'core-fingerprint', kind: 'image', model: 'fixture', taskId: 'core-task', state: 'reserved', sessionId: secretA, credential: `sessionid=${secretA}`, pool: { transitionTask: (_id, change) => transitions.push(change), settleTask: async () => { throw new Error('unknown submission must not settle'); } } };
    await assert.rejects(() => core.context.runWithPoolTask(context, () => core.request('POST', '/mweb/v1/aigc_draft/generate', secretA, { maxRetries: 9, data: { submit_id: 'fixture-submit', duration: 20, resolution: '1080p' } })), /timeout/);
    assert.equal(calls.length, 1); assert.deepEqual(transitions.map(x => x.state), ['submitting', 'unknown']);
    assert.equal(context.state, 'unknown');
    if (action === 'core_error_secrets') {
      const logs = JSON.stringify(globalThis.__poolLogs);
      for (const marker of [secretA, 'FIXTURE_PRIVATE_PROMPT', 'FIXTURE_SIGNED_SECRET']) assert.equal(logs.includes(marker), false, 'low-level error logs leaked synthetic secret canary');
    }
    break;
  }
  case 'route_image': case 'route_video': case 'route_audio': case 'route_text': case 'route_compat':
  case 'route_text_stream': case 'route_compat_stream': case 'route_tts_compat': case 'route_audio_tasks': case 'route_audio_speech': {
    await add('A', 1000); await add('B', 1000, secretB); const key = database.createApiKey('route-caller').key;
    const kind = action.slice(6);
    const configs = {
      image: [subject.imageRoutes, '/generations', { model: 'jimeng-image-4.0', prompt: 'fixture', resolution: '4k' }],
      video: [subject.videoRoutes, '/generations', { model: 'jimeng-video-seedance-2.0', prompt: 'fixture', resolution: '1080p', duration: 10 }],
      audio: [subject.audioRoutes, '/generations', { model: 'jimeng-audio-seedaudio-1.0', prompt: 'fixture', duration: 5, async: true }],
      text: [subject.chatRoutes, '/completions', { model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'fixture' }], stream: false }],
      compat: [subject.chatRoutes, '/completions', { model: 'jimeng-image-4.0', messages: [{ role: 'user', content: 'fixture' }], stream: false }],
      text_stream: [subject.chatRoutes, '/completions', { model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'fixture' }], stream: true }],
      compat_stream: [subject.chatRoutes, '/completions', { model: 'jimeng-image-4.0', messages: [{ role: 'user', content: 'fixture' }], stream: true }],
      tts_compat: [subject.audioCompatRoutes.find(x => x.prefix === '/api/v3/tts'), '/create', { text: 'fixture', text_prompt: 'fixture', prompt: 'fixture' }],
      audio_tasks: [subject.audioCompatRoutes.find(x => x.prefix === '/v1/audio'), '/tasks', { input: 'fixture' }],
      audio_speech: [subject.audioCompatRoutes.find(x => x.prefix === '/v1/audio'), '/speech', { input: 'fixture' }],
    };
    const [router, route, requestBody] = configs[kind];
    const makeRequest = () => new subject.Request({ res: new EventEmitter(), request: { method: 'POST', path: router.prefix + route, headers: { authorization: 'Bearer ' + key, 'idempotency-key': 'lost-response-route' }, body: requestBody }, params: {}, query: {} });
    const first = await router.post[route](makeRequest()); assert.ok(status(first) >= 400);
    const firstSnapshot = await dashboard(); assert.equal(firstSnapshot.tasks.length, 1); assert.equal(firstSnapshot.tasks[0].state, 'unknown');
    const again = await router.post[route](makeRequest()); assert.equal(status(again), 202, 'replay must surface existing task, not authentication failure');
    assert.equal(body(again).reused, true); assert.equal(body(again).pool_task_id, firstSnapshot.tasks[0].id);
    assert.equal(fixture.calls.filter(x => x.operation === 'submit').length, 1);
    assert.equal((await dashboard()).tasks.length, 1); break;
  }
  default: throw new Error('Unknown scenario: ' + action);
}
console.log('SCENARIO_OK ' + action);
