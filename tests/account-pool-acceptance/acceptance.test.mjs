import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const worker = fileURLToPath(new URL('./scenario.mjs', import.meta.url));
function run(action, dbPath, extra = {}) {
  return spawnSync(process.execPath, [worker, action], { cwd: process.env.ACCEPTANCE_ROOT,
    env: { ...process.env, DB_PATH: dbPath, ...extra }, encoding: 'utf8', timeout: 30000 });
}
function verify(result) { assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error || ''}`); }
const cases = {
  isolation: 'Harness: refuses real DB paths and blocks upstream network',
  contract: 'R01-R12: public contract exists (missing implementation is a failure)',
  threshold: 'R02: 199 rejected, 200 admitted, 250/80 leaves 170 and blocks next task',
  ordering: 'R01 R03: repeated previews are pure; priority remains stable; fixed never falls back',
  unknown_balance: 'R04: unknown/stale balance with refresh failure is never zero or available',
  eligibility: 'R04: cooldown, observed model entitlement and concurrency restrict new admission',
  concurrent: 'R02 R05: simultaneous admission cannot overspend the same 250-credit account',
  unknown_cost: 'R05: unknown cost occupies account exclusively until safe settlement',
  settlement: 'R05: refresh failure keeps reservation; refreshed balance is not double debited',
  idempotency: 'R08: request owner and fingerprint scope deduplication; no global prompt dedup',
  unknown_submit: 'R08: lost submit response remains unknown and never becomes a new lease',
  disabled: 'R07: disable/order changes do not change submitted task credential; delete/update protected',
  affinity: 'R06: proven account affinity cannot silently switch when unavailable',
  dto_secrets: 'R10 R11: dashboard/task/event DTOs and captured logs never contain secret fixtures',
  admin_permissions: 'R12: every management route rejects absent/invalid sessions and API-key-only access',
  admin_validation: 'R12: real settings/order handlers validate input and revision without false success',
  migration: 'R09 R12: old encrypted account table is preserved through additive migration',
  assets: 'R06: persistent upload proofs reject foreign callers, mixed accounts and unproven IDs',
  upload_flow: 'R06: independent upload and subsequent audio route remain on original account after reorder',
  readonly_auth: 'R01 R12: managed read authorization is pure and native session passthrough remains compatible',
  request_identity: 'R08: no-key client retries receive different IDs; multipart identity uses bytes',
  retry_image: 'R14: actual image retry controller does not resubmit or lower explicit resolution',
  retry_video: 'R14: actual video retry controller does not resubmit or lower explicit duration/resolution',
  core_timeout: 'R08: actual low-level request sends generation only once despite maxRetries=9 and timeout',
  core_error_secrets: 'R11: actual low-level request error logs redact sensitive upstream error contents',
  route_image: 'R08 R14: actual image route deduplicates a lost-response submission',
  route_video: 'R08 R14: actual video route deduplicates a lost-response submission',
  route_audio: 'R08 R14: actual audio route deduplicates a lost-response submission',
  route_text: 'R08 R14: actual text route deduplicates a lost-response submission',
  route_compat: 'R08 R14: actual compatible image-chat route deduplicates a lost-response submission',
  route_text_stream: 'R08 R14: actual streaming text route deduplicates a lost-response submission',
  route_compat_stream: 'R08 R14: actual streaming media-chat route deduplicates a lost-response submission',
  route_tts_compat: 'R08 R14: /api/v3/tts/create deduplicates a lost-response submission',
  route_audio_tasks: 'R08 R14: /v1/audio/tasks deduplicates a lost-response submission',
  route_audio_speech: 'R08 R14: /v1/audio/speech deduplicates a lost-response submission',
  http_static_and_admin_routes: 'R12 R13: real Koa HTTP routing serves static UI assets and enforces admin route order',
  http_task_type_mismatch_and_auth: 'R06 R09 R12: real Koa HTTP task recovery enforces auth, ownership and kind guard without mutating state',
  http_task_recovery_missing_or_unknown: 'R09: real Koa HTTP task recovery never reports false success on missing or unknown upstream state',
  http_audio_compat_queries_and_auth: 'R06 R07 R09 R12: real Koa HTTP audio compat queries enforce auth, original account, and terminal race guards',
  http_text_multiturn_and_unsupported_continuation: 'R01 R14: real Koa HTTP text chat supports role-labelled multi-turn history and rejects previous_response_id before lease',
  duplicate_session_cookie_row: 'R04 R05: same Jimeng session cannot be registered as both sessionId and cookie rows',
  shared_verified_uid_exclusive: 'R04 R05: two sessions with same verified upstream userId cannot hold double exclusive locks',
  peer_refresh_blocks_stale_peer: 'R02 R04 R05: refreshing one account in a shared subject prevents peers from admitting on stale balance',
  identity_temp_failure_preserves_subject: 'R04 R10: temporary identity failure preserves previous verified subject association',
  chain_risk_4013_fallback_timeout: 'R08 R14: direct 4013 followed by browser fallback timeout remains unknown and held',
  chain_status_99_with_url: 'R08 R09 R14: upstream status 99 with media URL is never returned or recovered as success',
  chain_status_50_missing_item_list: 'R08 R09 R14: status 50 with missing item_list never releases account or marks succeeded',
  chain_recovery_race_foreground_succeeded: 'R09 R14: recoverStoredPoolTask returns committed foreground success during history await',
  chain_recovery_race_foreground_failed: 'R09 R14: recoverStoredPoolTask does not return stale success data when foreground failed during await',
  chain_text_saved_result_recovery: 'R08 R09 R14: completed text persists minimal result and supports owner recovery when response is lost',
  chain_video_sse_wait_hint_finish_reason: 'R08 R14: slow video SSE 2-minute wait hint uses finish_reason null before error frame',
  seedance25_20s_actual_models: 'R14: actual resolveVideoModelConfig + generateVideoWithRetry supports Seedance 2.5 20s omni_reference and rejects invalid combinations',
  heartbeat_pool_task_preservation: 'R08 R09 R14: jsonHeartbeatResponse preserves pool task lease, error FailureBody, and disconnect safety',
};
for (const [name, title] of Object.entries(cases)) {
  test(title, () => {
    const dir = fs.mkdtempSync(path.join(process.env.ACCEPTANCE_ROOT, name + '-'));
    verify(run(name, path.join(dir, 'test.db')));
  });
}
test('R09: fresh process restores policy and invokes actual recovery route using original account', () => {
  const dir = fs.mkdtempSync(path.join(process.env.ACCEPTANCE_ROOT, 'restart-'));
  const db = path.join(dir, 'test.db');
  verify(run('restart_write', db));
  verify(run('restart_read', db));
});
test('R09: fresh process recovers /v1/videos/tasks/:taskId using original account without resubmitting', () => {
  const dir = fs.mkdtempSync(path.join(process.env.ACCEPTANCE_ROOT, 'restart-video-'));
  const db = path.join(dir, 'test.db');
  verify(run('restart_video_write', db));
  verify(run('restart_video_read', db));
});
test('R09: fresh process recovers /v1/audios/tasks/:taskId using original account without resubmitting', () => {
  const dir = fs.mkdtempSync(path.join(process.env.ACCEPTANCE_ROOT, 'restart-audio-'));
  const db = path.join(dir, 'test.db');
  verify(run('restart_audio_write', db));
  verify(run('restart_audio_read', db));
});
test('R09: fresh process recovers /v1/chat/tasks/:taskId for media and non-resumable text tasks', () => {
  const dir = fs.mkdtempSync(path.join(process.env.ACCEPTANCE_ROOT, 'restart-chat-'));
  const db = path.join(dir, 'test.db');
  verify(run('restart_chat_write', db));
  verify(run('restart_chat_read', db));
});
test('R09: fresh process maintenance worker reconciles disabled submitted task via real recoverStoredPoolTask without resubmitting', () => {
  const dir = fs.mkdtempSync(path.join(process.env.ACCEPTANCE_ROOT, 'restart-maint-'));
  const db = path.join(dir, 'test.db');
  verify(run('restart_maintenance_write', db));
  verify(run('restart_maintenance_read', db));
});
test('R05: two OS processes racing for one account yield exactly one accepted reservation', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.ACCEPTANCE_ROOT, 'race-'));
  const db = path.join(dir, 'test.db');
  verify(run('race_seed', db));
  const children = ['a', 'b'].map(id => new Promise(resolve => {
    const child = spawn(process.execPath, [worker, 'race_acquire'], { cwd: process.env.ACCEPTANCE_ROOT,
      env: { ...process.env, DB_PATH: db, RACE_ID: id, RACE_START: String(Date.now() + 1000) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', v => output += v); child.stderr.on('data', v => output += v);
    const timer = setTimeout(() => child.kill(), 15000);
    child.on('close', status => { clearTimeout(timer); resolve({ status, output }); });
  }));
  const results = await Promise.all(children);
  results.forEach(x => assert.equal(x.status, 0, x.output));
  assert.equal(results.filter(x => x.output.includes('RACE_ACCEPTED')).length, 1, JSON.stringify(results));
  assert.equal(results.filter(x => x.output.includes('RACE_REJECTED')).length, 1, JSON.stringify(results));
  verify(run('race_verify', db));
});
