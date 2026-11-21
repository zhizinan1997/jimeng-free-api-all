import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const axios = require('axios');
const [action, kind] = process.argv.slice(2);
const dir = fs.realpathSync(process.env.B_CASE_DIR);
const root = fs.realpathSync(process.env.B_ROOT);
assert.ok(dir.startsWith(root + path.sep));
assert.ok(path.resolve(process.env.DB_PATH).startsWith(dir + path.sep));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const sessions = { A: 'B-round2-only-session-A', B: 'B-round2-only-session-B' };
const labels = Object.fromEntries(Object.entries(sessions).map(([label, session]) => [session, label]));
const cookie = label => `sessionid=${sessions[label]}; webid=B-complete-cookie-${label}`;
const uid = label => `B-synthetic-upstream-user-${label}`;
const trace = [];
const histories = new Map();
const memoPath = path.join(dir, 'private-synthetic-memo.json');
let app, key, otherKey, accounts;
const fixture = globalThis.__Bfixture = {
  mode: 'success', nextWorkspace: 1, holdSession: null, sequence: 0,
  digest,
  validateCookiePairs(pairs) {
    const session = pairs.find(([name]) => name === 'sessionid')?.[1];
    const label = labels[session];
    assert.ok(label, 'text transport must use an actual selected synthetic session');
    assert.equal(pairs.find(([name]) => name === 'webid')?.[1], `B-complete-cookie-${label}`);
  },
  record(operation, session, extra = {}) {
    assert.ok(labels[session], `Unknown synthetic credential for ${operation}`);
    trace.push({ sequence: trace.length + 1, operation, credentialFingerprint: digest(cookie(labels[session])), upstreamUserId: uid(labels[session]), ...extra });
  },
};
const submitTrace = () => trace.filter(row => row.operation === 'submit');
const queryTrace = () => trace.filter(row => row.operation === 'history-query');
const recordFor = id => ({ status: 50, item_list: [{
  image: { large_images: [{ image_url: `https://fixture.invalid/${id}.webp` }] },
  video: { play_url: `https://fixture.invalid/${id}.mp4` },
  audio: { origin_audio: { audio_url: `https://fixture.invalid/${id}.mp3`, duration: 7 } },
}] });
const headersValue = (config, name) => typeof config.headers?.get === 'function' ? config.headers.get(name) : config.headers?.[name];
axios.defaults.adapter = async config => {
  const url = new URL(config.url);
  const route = url.pathname;
  const body = typeof config.data === 'string' ? JSON.parse(config.data) : Buffer.isBuffer(config.data) ? {} : config.data || {};
  const raw = data => ({ status: 200, statusText: 'OK', headers: {}, config, data });
  const session = String(headersValue(config, 'Cookie') || '').match(/(?:^|;\s*)sessionid=([^;]+)/)?.[1];
  const label = labels[session];
  const actionName = url.searchParams.get('Action');
  if (actionName === 'ApplyUploadInner' || actionName === 'CommitUploadInner') {
    const uploadLabel = String(headersValue(config, 'Authorization') || '').match(/Credential=B-access-([AB])\//)?.[1];
    assert.ok(uploadLabel, 'signed upload must use account-specific upload token');
    fixture.record(actionName, sessions[uploadLabel], { assetId: `v0${uploadLabel.toLowerCase().repeat(23)}` });
    if (actionName === 'ApplyUploadInner') return raw({ Result: { InnerUploadAddress: { UploadNodes: [{
      UploadHost: 'fixture.vodupload.com', SessionKey: `B-upload-${uploadLabel}`,
      StoreInfos: [{ StoreUri: `B-store-${uploadLabel}`, Auth: `B-transfer-${uploadLabel}` }],
    }] } } });
    assert.equal(body.SessionKey, `B-upload-${uploadLabel}`);
    return raw({ Result: { Results: [{ Vid: `v0${uploadLabel.toLowerCase().repeat(23)}`, VideoMeta: { Duration: 7 } }] } });
  }
  if (url.hostname === 'fixture.vodupload.com') {
    const uploadLabel = route.match(/B-store-([AB])$/)?.[1];
    assert.ok(uploadLabel);
    assert.equal(headersValue(config, 'Authorization'), `B-transfer-${uploadLabel}`);
    fixture.record('upload-bytes', sessions[uploadLabel], { byteLength: config.data.length });
    return raw({ code: 2000 });
  }
  assert.ok(label, `Authenticated upstream request missing synthetic session: ${route}`);
  assert.ok(String(headersValue(config, 'Cookie')).includes(`webid=B-complete-cookie-${label}`), 'full original cookie must be forwarded');
  let data;
  if (route === '/commerce/v1/benefits/user_credit') {
    fixture.record('credit', session);
    data = { credit: { gift_credit: 1000, purchase_credit: 0, vip_credit: 0 } };
  } else if (route === '/passport/account/info/v2') {
    fixture.record('identity', session);
    return raw({ message: 'success', data: { user_id_str: uid(label), screen_name: `Synthetic ${label}`, is_vip: true } });
  } else if (route.endsWith('get_common_config')) data = {};
  else if (route === '/mweb/v1/get_upload_token') {
    fixture.record('upload-token', session);
    data = { access_key_id: `B-access-${label}`, secret_access_key: 'B-synthetic-signing-key', session_token: 'B-synthetic-session-token', space_name: 'B-isolated-space' };
  } else if (route === '/mweb/v1/aigc_draft/generate') {
    if (fixture.exitDuringSubmission) fixture.exitDuringSubmission(session, body.submit_id);
    const id = fixture.mode === 'timeout' ? null : `B-${kind}-history-${++fixture.sequence}`;
    fixture.record('submit', session, { kind, upstreamId: id,
      localSubmitFingerprint: digest(String(body.submit_id)), referencedAssetIds: [...JSON.stringify(body).matchAll(/v0[ab]{23}/g)].map(x => x[0]) });
    if (fixture.mode === 'timeout') throw Object.assign(new Error('B synthetic lost response'), { code: 'ETIMEDOUT' });
    histories.set(id, { session, result: recordFor(id) });
    data = { aigc_data: { history_record_id: id } };
  } else if (route === '/mweb/v1/get_history_by_ids') {
    const ids = body.history_ids || body.submit_ids || [];
    let waitedForRuleChange = false;
    assert.ok(ids.length > 0);
    fixture.record('history-query', session, { upstreamIds: ids });
    for (const id of ids) {
      assert.equal(histories.get(id)?.session, session, 'history queried with a different account than submitted');
      if (fixture.mode === 'restart-known') fixture.crashAfterSubmission(id);
      if (fixture.holdSession === session) {
        await new Promise(resolve => { fixture.release = resolve; fixture.started({ upstreamId: id, session }); });
        waitedForRuleChange = true;
      }
    }
    // First in-flight query returns pending. The controller must issue a fresh
    // query after reorder/disable, so the test does not merely finish an old query.
    data = Object.fromEntries(ids.map(id => [id, waitedForRuleChange ? { status: 20 } : histories.get(id).result]));
    fixture.record('history-result', session, { upstreamIds: ids, status: waitedForRuleChange ? 20 : 50 });
  } else throw new Error(`Unexpected synthetic upstream endpoint ${route}`);
  return raw({ ret: '0', data });
};

// Network guard is loaded by NODE_OPTIONS before this file. No initialize import.
app = require(path.join(root, 'subject.cjs'));
if (kind === 'text') {
  await app.browserTransport.setMode('always', false);
  app.browserTransport.shouldUse = () => false;
}
function request(body = {}, id = 'B-request', params = {}, token = key, requestPath = '/fixture') {
  const res = new EventEmitter();
  res.destroyed = false; res.writableFinished = false;
  return new app.Request({ res, request: {
    method: Object.keys(params).length ? 'GET' : 'POST', url: requestPath, path: requestPath,
    type: 'application/json', headers: { authorization: `Bearer ${token}`, 'idempotency-key': id }, body, files: {},
  }, query: {}, params, ip: '127.0.0.1' });
}
const bodyFor = (which = kind) => which === 'text'
  ? { model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'B synthetic request' }] }
  : which === 'image' ? { model: 'jimeng-image-5.0-lite', prompt: 'B synthetic image', resolution: '2k', n: 1 }
  : which === 'video' ? { model: 'jimeng-video-3.0', prompt: 'B synthetic video', duration: 5, resolution: '720p' }
  : { prompt: 'B synthetic speech', voice_name: '苏感低音' };
const routesFor = which => app[`${which === 'text' ? 'chat' : which}Routes`];
const generate = (id, body = bodyFor(), which = kind, token = key) => {
  const segment = which === 'text' ? '/completions' : '/generations';
  return routesFor(which).post[segment](request(body, id, {}, token, routesFor(which).prefix + segment));
};
const taskIdOf = response => response.pool_task_id || response.body?.pool_task_id || response.headers?.['X-Pool-Task-Id'];
const task = id => app.pool.readTask(id, app.ownerHash(key));
const query = (id, which = kind, token = key) => routesFor(which).get['/tasks/:taskId'](request({}, 'B-query', { taskId: id }, token));
const safeTask = t => ({ id: t.id, kind: t.kind, state: t.state, accountId: t.accountId, upstreamTaskId: t.upstreamTaskId, settling: t.settling });
async function initialize() {
  key = app.db.createApiKey('B-only-synthetic-caller').key;
  otherKey = app.db.createApiKey('B-other-synthetic-caller').key;
  accounts = Object.fromEntries(['A', 'B'].map(label => [label, app.pool.create({ name: `Local ${label}`, cookie: cookie(label) })]));
  app.pool.updateSettings({ ...app.pool.getSettings(), threshold: 40 });
  await Promise.all(Object.values(accounts).map(a => app.pool.refreshStatus(a.id)));
  for (const label of ['A', 'B']) assert.equal(app.pool.get(accounts[label].id).upstreamIdentity.userId, uid(label));
}
function changeRules(disable = true) {
  app.pool.reorderAccounts({ accountIds: [accounts.B.id, accounts.A.id], revision: app.pool.getSettings().revision });
  if (disable) app.pool.setEnabled(accounts.A.id, false);
  trace.push({ sequence: trace.length + 1, operation: 'rules-changed', originalAccountDisabled: disable, order: [accounts.B.id, accounts.A.id] });
}
function saveMemo(extra = {}) {
  fs.writeFileSync(memoPath, JSON.stringify({ key, otherKey, accounts, ...extra }, null, 2));
}
function loadMemo() {
  const memo = JSON.parse(fs.readFileSync(memoPath));
  ({ key, otherKey, accounts } = memo);
  return memo;
}
function evidence(summary) {
  const result = {
    action, kind, pid: process.pid, passed: true, summary,
    accounts: Object.fromEntries(Object.entries(accounts).map(([label, a]) => [label, {
      accountId: a.id, credentialFingerprint: digest(cookie(label)), upstreamUserId: uid(label),
      identitySource: '/passport/account/info/v2', synthetic: true,
    }])),
    submitCount: submitTrace().length, queryCount: queryTrace().length, trace,
  };
  const text = JSON.stringify(result, null, 2);
  for (const secret of [key, otherKey, ...Object.values(sessions)]) assert.ok(!text.includes(secret), 'raw synthetic credentials accidentally included in evidence');
  fs.writeFileSync(path.join(dir, `${action}.evidence.json`), text);
  console.log(JSON.stringify({ passed: true, action, kind, submitCount: result.submitCount, queryCount: result.queryCount }));
}
function assertOriginalTrace(id, label) {
  const submitted = submitTrace().filter(row => row.upstreamId === id);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].upstreamUserId, uid(label));
  const queries = queryTrace().filter(row => row.upstreamIds.includes(id));
  for (const row of queries) assert.equal(row.upstreamUserId, uid(label));
  if (kind === 'text') {
    const result = trace.find(row => row.operation === 'text-result' && row.upstreamId === id);
    assert.equal(result?.upstreamUserId, uid(label));
    for (const row of trace.filter(row => row.workspace === submitted[0].workspace)) assert.equal(row.upstreamUserId, uid(label));
  } else assert.ok(queries.length > 0);
}
async function finishAudio(response) {
  if (kind !== 'audio') return;
  const status = await app.audioRoutes.get['/generations/:taskId'](request({}, 'B-audio-query', { taskId: response.data.task_id }));
  assert.equal(status.data.complete, true);
}
async function waitUntil(fn) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('Expected persisted submission was not observed');
}

if (action === 'affinity') {
  await initialize();
  let first, pending, started;
  if (kind === 'audio') first = await generate('B-inflight-old');
  else {
    fixture.holdSession = sessions.A;
    const gate = new Promise(resolve => { fixture.started = resolve; });
    pending = generate('B-inflight-old');
    started = await gate;
    await waitUntil(() => app.pool.listTasks().items.some(t => t.upstreamTaskId === started.upstreamId));
  }
  const original = first ? task(taskIdOf(first)) : app.pool.listTasks().items.find(t => t.upstreamTaskId === started.upstreamId);
  assert.equal(original.accountId, accounts.A.id);
  assert.equal(original.state, 'submitted');
  changeRules();
  const next = await generate('B-inflight-new');
  assert.equal(task(taskIdOf(next)).accountId, accounts.B.id);
  await finishAudio(next);
  if (pending) { fixture.holdSession = null; fixture.release(); first = await pending; }
  else await finishAudio(first);
  const final = task(taskIdOf(first));
  assert.equal(final.state, 'succeeded');
  assert.equal(final.accountId, accounts.A.id);
  assert.equal(app.pool.get(accounts.A.id).enabled, false);
  assert.equal(submitTrace().length, 2);
  assertOriginalTrace(final.upstreamTaskId, 'A');
  assertOriginalTrace(task(taskIdOf(next)).upstreamTaskId, 'B');
  const changedAt = trace.find(row => row.operation === 'rules-changed').sequence;
  if (kind !== 'text') assert.ok(queryTrace().some(row => row.sequence > changedAt && row.upstreamIds.includes(final.upstreamTaskId) && row.upstreamUserId === uid('A')), 'original account must perform a fresh query after reorder/disable');
  else assert.ok(trace.some(row => row.operation === 'text-result' && row.sequence > changedAt && row.upstreamId === final.upstreamTaskId && row.upstreamUserId === uid('A')));
  evidence({ beforeChange: safeTask(original), afterChange: safeTask(final), nextTask: safeTask(task(taskIdOf(next))), order: app.pool.getDashboard().accounts.map(a => a.id), disabledOriginal: true });
} else if (action === 'unknown') {
  await initialize();
  fixture.mode = 'timeout';
  const failed = await generate('B-unknown-once');
  const id = taskIdOf(failed);
  assert.ok(id, 'lost response must retain local task ID');
  const original = task(id);
  assert.equal(original.state, 'unknown');
  assert.equal(original.accountId, accounts.A.id);
  assert.equal(original.upstreamTaskId, null);
  assert.equal(submitTrace().length, 1);
  changeRules();
  fixture.mode = 'success';
  const replay = await generate('B-unknown-once');
  assert.equal(replay.statusCode, 202);
  assert.equal(replay.body.reused, true);
  assert.equal(taskIdOf(replay), id);
  const restored = await query(id);
  assert.equal(restored.recoverable, false);
  assert.equal(task(id).state, 'unknown');
  assert.equal(submitTrace().length, 1);
  assert.equal(queryTrace().length, 0);
  const next = await generate('B-distinct-new');
  assert.equal(task(taskIdOf(next)).accountId, accounts.B.id);
  await finishAudio(next);
  assert.equal(submitTrace().length, 2);
  evidence({ original: safeTask(original), replayStatus: replay.statusCode, replayReused: true, originalSubmissionCountAfterReplay: 1, recoveryMessage: restored.message, nextTask: safeTask(task(taskIdOf(next))) });
} else if (action === 'restart-write' || action === 'saved-write') {
  await initialize();
  fixture.crashAfterSubmission = id => {
    const original = app.pool.listTasks().items.find(t => t.upstreamTaskId === id);
    assert.ok(original, 'real controller must have persisted confirmed upstream ID before process exit');
    assert.equal(original.state, 'submitted');
    assert.equal(original.accountId, accounts.A.id);
    changeRules();
    saveMemo({ taskId: original.id, upstreamId: id, originalState: original.state });
    evidence({ crashPoint: 'after real upstream acknowledgement persisted, before history result/answer', original: safeTask(original) });
    process.exit(0);
  };
  fixture.mode = action === 'saved-write' ? 'success' : 'restart-known';
  const restartBody = bodyFor();
  if (kind === 'image') restartBody.n = 2;
  const response = await generate('B-restart-real-submission', restartBody);
  if (action === 'saved-write') {
    const original = task(taskIdOf(response));
    assert.equal(original.state, 'succeeded');
    changeRules();
    saveMemo({ taskId: original.id, upstreamId: original.upstreamTaskId, originalState: original.state });
    evidence({ original: safeTask(original), savedAnswer: 'B synthetic answer' });
  } else if (kind === 'audio') fixture.crashAfterSubmission(task(taskIdOf(response)).upstreamTaskId);
  else assert.fail('expected synthetic process interruption at confirmed submission');
} else if (action === 'restart-read') {
  const memo = loadMemo();
  assert.equal(app.pool.get(accounts.A.id).enabled, false);
  assert.deepEqual(app.pool.getDashboard().accounts.map(a => a.id), [accounts.B.id, accounts.A.id]);
  assert.equal(app.pool.getSettings().threshold, 40);
  const before = task(memo.taskId);
  assert.equal(before.upstreamTaskId, memo.upstreamId);
  assert.equal(before.accountId, accounts.A.id);
  const result = recordFor(memo.upstreamId);
  if (kind === 'image' || kind === 'video') {
    result.item_list = ['first', 'second', 'third'].map(suffix => {
      const url = 'https://fixture.invalid/' + memo.upstreamId + '-' + suffix;
      return kind === 'image' ? { image: { large_images: [{ image_url: url }] } } : { video: { play_url: url } };
    });
  }
  histories.set(memo.upstreamId, { session: sessions.A, result });
  const response = await query(memo.taskId);
  assert.equal(submitTrace().length, 0);
  if (kind === 'text' && memo.originalState !== 'succeeded') {
    assert.equal(response.recoverable, false);
    assert.equal(task(memo.taskId).state, 'submitted');
    assert.equal(queryTrace().length, 0);
    evidence({ original: safeTask(before), recovered: false, limitation: response.message, submissionsAfterRestart: 0 });
  } else {
    assert.equal(response.recoverable, true);
    assert.equal(task(memo.taskId).state, 'succeeded');
    assert.equal(task(memo.taskId).accountId, accounts.A.id);
    if (kind === 'text') { assert.equal(response.answer, 'B synthetic answer'); assert.equal(queryTrace().length, 0); }
    else {
      assert.equal(queryTrace().length, 1);
      assert.equal(queryTrace()[0].upstreamUserId, uid('A'));
      assert.deepEqual(queryTrace()[0].upstreamIds, [memo.upstreamId]);
      assert.ok(response.data[0].url.includes(memo.upstreamId));
      if (kind === 'image' || kind === 'video') {
        // Only images carry an output-count contract. Video history retains every verified URL.
        const expected = (kind === 'image' ? ['first', 'second'] : ['first', 'second', 'third'])
          .map(suffix => 'https://fixture.invalid/' + memo.upstreamId + '-' + suffix);
        assert.deepEqual(response.data.map(item => item.url), expected);
        assert.deepEqual(response.result.urls, expected);
      }
    }
    evidence({ before: safeTask(before), after: safeTask(task(memo.taskId)), recovered: true, submissionsAfterRestart: 0, data: response.data });
  }
} else if (action === 'assets-write') {
  await initialize();
  const uploaded = await app.audioRoutes.post['/uploads'](request({ source: 'data:audio/mpeg;base64,QiBzeW50aGV0aWMgYXVkaW8=' }, 'B-upload'));
  assert.equal(uploaded.data.vid, `v0${'a'.repeat(23)}`);
  assert.equal(task(taskIdOf(uploaded)).accountId, accounts.A.id);
  assert.equal(task(taskIdOf(uploaded)).state, 'succeeded');
  assert.deepEqual(trace.filter(row => ['upload-token', 'ApplyUploadInner', 'upload-bytes', 'CommitUploadInner'].includes(row.operation)).map(row => row.upstreamUserId), Array(4).fill(uid('A')));
  changeRules(false);
  saveMemo({ assetId: uploaded.data.vid, uploadTaskId: taskIdOf(uploaded) });
  evidence({ assetId: uploaded.data.vid, uploadTask: safeTask(task(taskIdOf(uploaded))), nextUnboundAccount: app.pool.getDashboard().summary.nextAccountId });
} else if (action === 'assets-read') {
  const memo = loadMemo();
  const assetBody = { prompt: 'B synthetic edit', audio_paths: [memo.assetId], accountId: accounts.B.id };
  const generated = await generate('B-proven-asset', assetBody);
  assert.equal(task(taskIdOf(generated)).accountId, accounts.A.id);
  assert.ok(submitTrace()[0].referencedAssetIds.includes(memo.assetId));
  await finishAudio(generated);
  assertOriginalTrace(task(taskIdOf(generated)).upstreamTaskId, 'A');
  const foreign = await generate('B-foreign-asset', assetBody, kind, otherKey);
  assert.equal(foreign.statusCode, 403);
  const bare = await generate('B-bare-asset', { ...assetBody, audio_paths: [`v0${'c'.repeat(23)}`] });
  assert.equal(bare.statusCode, 403);
  app.pool.setEnabled(accounts.A.id, false);
  const disabled = await generate('B-disabled-asset', assetBody);
  assert.ok(disabled.statusCode >= 400, 'disabled original owner cannot silently switch material to B');
  assert.equal(submitTrace().length, 1);
  evidence({ assetId: memo.assetId, task: safeTask(task(taskIdOf(generated))), foreignCallerStatus: foreign.statusCode, unprovenAssetStatus: bare.statusCode, disabledOriginalStatus: disabled.statusCode, submissionCountAfterAllRejects: 1 });
} else if (action === 'compat-video') {
  await initialize();
  const response = await app.chatRoutes.post['/completions'](request({
    model: 'jimeng-video-3.0', messages: [{ role: 'user', content: 'B compatible video request' }],
  }, 'B-compatible-video', {}, key, '/v1/chat/completions'));
  const completed = task(taskIdOf(response));
  assert.equal(completed.kind, 'video');
  assert.equal(completed.accountId, accounts.A.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(submitTrace().length, 1);
  assert.equal(queryTrace().length, 1);
  assert.ok(response.choices[0].message.content.includes(`${completed.upstreamTaskId}.mp4`));
  assertOriginalTrace(completed.upstreamTaskId, 'A');
  evidence({ task: safeTask(completed), compatibilityResultContainsOriginalTaskUrl: true });
// B takeover increment: reject fixed-account failure before any transport starts.
} else if (action === 'fixed-entrypoints') {
  await initialize();
  app.pool.updateSettings({ ...app.pool.getSettings(), mode: 'fixed', fixedAccountId: accounts.A.id });
  app.pool.setEnabled(accounts.A.id, false);
  const dashboard = app.pool.getDashboard();
  assert.equal(dashboard.accounts.find(a => a.id === accounts.B.id).scheduling.eligible, true,
    'B must remain eligible, otherwise zero submissions would not prove no fallback');
  const entries = ['image', 'video', 'audio', 'text'].map(which => ({
    routes: routesFor(which), segment: which === 'text' ? '/completions' : '/generations', body: bodyFor(which),
  }));
  entries.push({ routes: app.chatRoutes, segment: '/completions', body: { ...bodyFor('text'), stream: true } });
  for (const media of ['image', 'video']) for (const stream of [false, true]) entries.push({
    routes: app.chatRoutes, segment: '/completions',
    body: { model: bodyFor(media).model, messages: [{ role: 'user', content: 'B fixed rejection' }], stream },
  });
  entries.push({ routes: app.audioRoutes, segment: '/uploads', body: { source: 'data:audio/mpeg;base64,Qg==' } });
  for (const routes of app.audioCompatRoutes) for (const segment of Object.keys(routes.post || {})) entries.push({
    routes, segment, body: { input: 'B fixed rejection', prompt: 'B fixed rejection' },
  });
  assert.equal(entries.length, 13, 'entrypoint inventory changed; review fixed-account coverage');
  const results = [];
  const traceBefore = trace.length;
  for (const [index, entry] of entries.entries()) {
    const routePath = entry.routes.prefix + entry.segment;
    const response = await entry.routes.post[entry.segment](request(entry.body, `B-fixed-${index}`, {}, key, routePath));
    assert.equal(response.statusCode, 409, `${routePath} must reject the fixed disabled account`);
    assert.equal(response.body.error.code, 'pool_request_rejected');
    assert.match(response.body.error.message, /指定账号不合格/);
    assert.equal(app.pool.listTasks().total, 0, `${routePath} must not create a fallback lease`);
    assert.equal(submitTrace().length, 0);
    assert.equal(queryTrace().length, 0);
    results.push({ path: routePath, model: entry.body.model || null, stream: Boolean(entry.body.stream),
      statusCode: response.statusCode, errorCode: response.body.error.code, message: response.body.error.message });
  }
  assert.deepEqual(trace.slice(traceBefore), [], 'rejection must happen before any transport or upload starts');
  evidence({ fixedAccountId: accounts.A.id, fixedAccountEnabled: false, alternativeAccountId: accounts.B.id,
    alternativeEligible: true, entries: results, taskCount: app.pool.listTasks().total,
    transportOperationsAfterInitialization: trace.length - traceBefore });
// B continuation: recovery through the legacy audio task ID and pre-ack crash.
} else if (action === 'compat-audio-write') {
  await initialize();
  const compat = app.audioCompatRoutes.find(route => route.prefix === '/v1/audio');
  const created = await compat.post['/tasks'](request(bodyFor(), 'B-audio-compat-restart', {}, key, '/v1/audio/tasks'));
  const original = task(taskIdOf(created));
  assert.equal(created.status, 'processing');
  assert.equal(created.task_id, original.upstreamTaskId);
  assert.equal(original.state, 'submitted');
  assert.equal(original.accountId, accounts.A.id);
  assert.equal(submitTrace().length, 1);
  assert.equal(submitTrace()[0].upstreamUserId, uid('A'));
  assert.equal(queryTrace().length, 0);
  changeRules();
  saveMemo({ taskId: original.id, compatibilityTaskId: created.task_id });
  evidence({ original: safeTask(original), compatibilityTaskId: created.task_id });
} else if (action === 'compat-audio-read') {
  const { taskId, compatibilityTaskId } = loadMemo();
  const before = task(taskId);
  assert.equal(before.state, 'submitted');
  assert.equal(before.upstreamTaskId, compatibilityTaskId);
  assert.equal(before.accountId, accounts.A.id);
  assert.equal(app.pool.get(accounts.A.id).enabled, false);
  assert.equal(app.pool.getDashboard().summary.nextAccountId, accounts.B.id);
  histories.set(compatibilityTaskId, { session: sessions.A, result: recordFor(compatibilityTaskId) });
  const compat = app.audioCompatRoutes.find(route => route.prefix === '/v1/audio');
  const poll = token => compat.get['/tasks/:taskId'](request({}, 'B-compat-poll', { taskId: compatibilityTaskId },
    token, `/v1/audio/tasks/${compatibilityTaskId}`));
  const foreign = await poll(otherKey);
  assert.equal(foreign.statusCode, 403);
  assert.equal(queryTrace().length, 0);
  const done = await poll(key);
  const after = task(taskId);
  assert.equal(done.task_id, compatibilityTaskId);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.audio_url, `https://fixture.invalid/${compatibilityTaskId}.mp3`);
  assert.equal(after.state, 'succeeded');
  assert.equal(after.accountId, before.accountId);
  assert.equal(after.settling, false);
  assert.equal(submitTrace().length, 0);
  assert.equal(queryTrace().length, 1);
  assert.deepEqual(queryTrace()[0].upstreamIds, [compatibilityTaskId]);
  assert.equal(queryTrace()[0].upstreamUserId, uid('A'));
  evidence({ before: safeTask(before), after: safeTask(after), compatibilityTaskId,
    foreignStatus: foreign.statusCode, audioUrl: done.audio_url });
} else if (action === 'unconfirmed-write') {
  await initialize();
  fixture.exitDuringSubmission = (session, localSubmitId) => {
    assert.equal(session, sessions.A);
    assert.ok(localSubmitId);
    fixture.record('submit', session, { kind, upstreamId: null, localSubmitFingerprint: digest(localSubmitId) });
    const original = app.pool.listTasks().items.find(t => t.requestId === 'B-exit-during-submit');
    assert.equal(original?.state, 'submitting');
    assert.equal(original.upstreamTaskId, null);
    assert.equal(original.accountId, accounts.A.id);
    assert.ok(app.pool.listRecoverableTasks().some(t => t.id === original.id), 'submission must retain occupancy');
    changeRules();
    saveMemo({ taskId: original.id });
    evidence({ original: safeTask(original), exitPoint: 'entered synthetic submit adapter; no response or error delivered' });
    process.exit(0);
  };
  await generate('B-exit-during-submit');
  assert.fail('expected isolated process exit before acknowledgement');
} else if (action === 'unconfirmed-read') {
  const { taskId } = loadMemo();
  const submitted = task(taskId);
  assert.equal(submitted.state, 'submitting');
  // Run the startup maintenance scan after a simulated three-minute outage.
  app.pool.scanTasksForMaintenance(Date.parse(submitted.updatedAt) + 180_000);
  const before = task(taskId);
  assert.equal(before.upstreamTaskId, null);
  assert.equal(before.accountId, accounts.A.id);
  assert.equal(app.pool.get(accounts.A.id).enabled, false);
  assert.equal(app.pool.getDashboard().summary.nextAccountId, accounts.B.id);
  const replay = await generate('B-exit-during-submit');
  assert.equal(replay.statusCode, 202);
  assert.equal(replay.body.reused, true);
  assert.equal(taskIdOf(replay), taskId);
  const recovery = await query(taskId);
  assert.equal(recovery.recoverable, false);
  assert.match(recovery.message, /未获得上游任务 ID/);
  const after = task(taskId);
  assert.deepEqual(safeTask(after), safeTask(before));
  assert.equal(app.pool.listTasks().total, 1);
  assert.deepEqual(trace, [], 'neither replay nor query may contact upstream');
  assert.ok(app.pool.listRecoverableTasks().some(t => t.id === taskId), 'no-ID task must still hold its original slot');
  assert.equal(after.state, 'unknown');
  assert.equal(replay.body.state, 'unknown');
  const next = task(taskIdOf(await generate('B-new-after-unconfirmed')));
  assert.equal(next.accountId, accounts.B.id);
  assert.equal(submitTrace().length, 1);
  assert.equal(submitTrace()[0].upstreamUserId, uid('B'));
  evidence({ before: safeTask(before), after: safeTask(after), replayStatus: replay.statusCode,
    replayState: replay.body.state, recoveryMessage: recovery.message, replayAndRecoveryUpstreamOperations: 0,
    occupancyHeld: true, next: safeTask(next) });
} else assert.fail(`Unknown scenario ${action}`);
