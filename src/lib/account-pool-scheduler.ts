import crypto from 'node:crypto';
import type { AccountSelection, PublicAccount } from './account-pool.ts';

export type PoolTaskState = 'reserved' | 'submitting' | 'submitted' | 'running' | 'succeeded' | 'failed' | 'unknown';
export type PoolTaskKind = 'text' | 'image' | 'video' | 'audio' | 'upload';
export interface PoolTask {
  id: string; requestId: string; accountId: string; accountName: string; kind: PoolTaskKind; model: string;
  requestedImageCount?: number | null;
  state: PoolTaskState; estimatedCredits: number | null; upstreamTaskId: string | null;
  createdAt: string; updatedAt: string; error: string | null; settling: boolean;
}
export interface PoolSettings { mode: 'auto' | 'fixed'; fixedAccountId: string | null; threshold: number; balanceMaxAgeSeconds: number; revision: number }
export interface PoolEvent { id: string; type: string; accountId: string | null; fromAccountId: string | null; toAccountId: string | null; reason: string; createdAt: string; actor?: string }
export interface AcquireTaskInput { requestId: string; ownerHash: string; requestFingerprint: string; kind: PoolTaskKind; model: string; estimatedCredits: number | null; requestedImageCount?: number; preferredAccountId?: string }
export interface PoolLease extends AccountSelection { taskId: string; reused: boolean; state: PoolTaskState; upstreamTaskId: string | null }
export interface PoolTaskRecoveryRecord { task: PoolTask; ownerHash: string; selection: AccountSelection }
export class PoolError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) { super(message); this.name = 'PoolError'; this.statusCode = statusCode; }
}
// Local acknowledgement window. A late upstream acknowledgement is still accepted.
const ACK_WAIT_MS = 120_000;
const stamp = () => new Date().toISOString();
const terminal = (state: string) => state === 'succeeded' || state === 'failed';
const json = (value: string, fallback: any) => { try { return JSON.parse(value); } catch { return fallback; } };
interface Dependencies {
  db: any; publicAccount(row: any): PublicAccount; selection(id: string): AccountSelection;
  refresh(id: string, lockToken: string): Promise<PublicAccount>; encrypt(value: string): string; decrypt(value: string): string;
  prepareRows?: () => void;
}

/** SQLite is the single authority for leases, idempotency, and settlement across processes. */
export function createPoolScheduler(deps: Dependencies) {
  const { db } = deps;
  db.pragma('busy_timeout = 5000');
  db.transaction(() => {
    const columns = new Set(db.prepare('PRAGMA table_info(jimeng_accounts)').all().map((r: any) => r.name));
    for (const [name, definition] of Object.entries({
      priority: 'INTEGER NOT NULL DEFAULT 0', credential_version: 'INTEGER NOT NULL DEFAULT 1',
      identity_json: 'TEXT', calibration_token: 'TEXT', calibration_until: 'INTEGER',
      session_hash: 'TEXT'
    })) if (!columns.has(name)) db.exec(`ALTER TABLE jimeng_accounts ADD COLUMN ${name} ${definition}`);
    db.exec(`CREATE TABLE IF NOT EXISTS pool_settings (id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL, fixed_account_id TEXT, threshold REAL NOT NULL, balance_max_age_seconds INTEGER NOT NULL, revision INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_jimeng_accounts_session_hash ON jimeng_accounts(session_hash);
      INSERT OR IGNORE INTO pool_settings VALUES (1, 'auto', NULL, 200, 60, 1);
      CREATE TABLE IF NOT EXISTS pool_tasks (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL, owner_hash TEXT NOT NULL, fingerprint TEXT NOT NULL,
        account_id TEXT NOT NULL, account_name TEXT NOT NULL, credential_version INTEGER NOT NULL,
        kind TEXT NOT NULL, model TEXT NOT NULL, state TEXT NOT NULL, estimated_credits REAL,
        upstream_task_id TEXT, result_ciphertext TEXT, error TEXT, held INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(owner_hash, request_id));
      CREATE INDEX IF NOT EXISTS pool_tasks_held ON pool_tasks(account_id, held);
      CREATE INDEX IF NOT EXISTS pool_tasks_unacknowledged ON pool_tasks(updated_at)
        WHERE held=1 AND state='submitting' AND upstream_task_id IS NULL;
      CREATE TABLE IF NOT EXISTS pool_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, account_id TEXT, from_account_id TEXT, to_account_id TEXT, reason TEXT NOT NULL, created_at TEXT NOT NULL, actor TEXT);
    `);
    const taskColumns = db.prepare('PRAGMA table_info(pool_tasks)').all();
    if (!taskColumns.some((column: any) => column.name === 'requested_image_count')) {
      db.exec('ALTER TABLE pool_tasks ADD COLUMN requested_image_count INTEGER CHECK (requested_image_count BETWEEN 1 AND 8)');
    }
    if (!columns.has('priority')) {
      db.prepare('SELECT id FROM jimeng_accounts ORDER BY created_at, rowid').all().forEach((r: any, i: number) => db.prepare('UPDATE jimeng_accounts SET priority=? WHERE id=?').run(i, r.id));
    }
  }).immediate();
  const accountColumns = new Set(db.prepare('PRAGMA table_info(jimeng_accounts)').all().map((r: any) => r.name));
  const hasDetailedCredits = ['free_credit', 'purchase_credit', 'vip_credit'].every(col => accountColumns.has(col));
  const syncPeerBalanceSql = hasDetailedCredits
    ? 'UPDATE jimeng_accounts SET free_credit=?, purchase_credit=?, vip_credit=?, total_credit=?, membership_json=?, updated_at=? WHERE id=?'
    : 'UPDATE jimeng_accounts SET total_credit=?, membership_json=?, updated_at=? WHERE id=?';
  const invalidatePeerBalanceSql = hasDetailedCredits
    ? 'UPDATE jimeng_accounts SET free_credit=NULL, purchase_credit=NULL, vip_credit=NULL, total_credit=NULL, status_checked_at=NULL, updated_at=? WHERE id=?'
    : 'UPDATE jimeng_accounts SET total_credit=NULL, status_checked_at=NULL, updated_at=? WHERE id=?';
  const rows = () => { deps.prepareRows?.(); return db.prepare('SELECT * FROM jimeng_accounts ORDER BY priority, created_at, rowid').all(); };
  const row = (id: string) => { const r = db.prepare('SELECT * FROM jimeng_accounts WHERE id=?').get(id); if (!r) throw new PoolError('账号不存在', 404); return r; };
  const task = (id: string) => { const r = db.prepare('SELECT * FROM pool_tasks WHERE id=?').get(id); if (!r) throw new PoolError('任务不存在', 404); return r; };
  function event(type: string, accountId: string | null, reason: string, from: string | null = null, to: string | null = null, actor?: string) {
    db.prepare('INSERT INTO pool_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), type, accountId, from, to, reason, stamp(), actor || null);
  }
  function getSettings(): PoolSettings {
    const s = db.prepare('SELECT * FROM pool_settings WHERE id=1').get();
    return { mode: s.mode, fixedAccountId: s.fixed_account_id, threshold: s.threshold, balanceMaxAgeSeconds: s.balance_max_age_seconds, revision: s.revision };
  }
  function checkRevision(revision: number) { if (!Number.isInteger(revision) || getSettings().revision !== revision) throw new PoolError('配置已更新，请刷新后重试', 409); }
  function updateSettings(input: PoolSettings, actor?: string): PoolSettings {
    return db.transaction(() => {
      checkRevision(input?.revision);
      if (!['auto', 'fixed'].includes(input.mode) || (input.fixedAccountId !== null && typeof input.fixedAccountId !== 'string') || !Number.isFinite(input.threshold) || input.threshold < 0 || input.threshold > 1e9 || !Number.isInteger(input.balanceMaxAgeSeconds) || input.balanceMaxAgeSeconds < 1 || input.balanceMaxAgeSeconds > 86400) throw new PoolError('模式、阈值或余额有效期无效');
      if (input.mode === 'fixed' && !input.fixedAccountId) throw new PoolError('固定模式必须选择账号');
      if (input.fixedAccountId) row(input.fixedAccountId);
      db.prepare('UPDATE pool_settings SET mode=?, fixed_account_id=?, threshold=?, balance_max_age_seconds=?, revision=revision+1 WHERE id=1').run(input.mode, input.fixedAccountId, input.threshold, input.balanceMaxAgeSeconds);
      event('settings_updated', input.fixedAccountId, `调度配置：${input.mode === 'fixed' ? '固定账号' : '自动优先排序'}；门槛 ${input.threshold}；余额有效期 ${input.balanceMaxAgeSeconds} 秒`, null, null, actor);
      return getSettings();
    }).immediate();
  }
  function reorderAccounts(input: { accountIds: string[]; revision: number }, actor?: string) {
    return db.transaction(() => {
      checkRevision(input?.revision);
      const ids = rows().map((r: any) => r.id);
      if (!Array.isArray(input.accountIds) || input.accountIds.length !== ids.length || new Set(input.accountIds).size !== ids.length || input.accountIds.some(id => !ids.includes(id))) throw new PoolError('排序必须包含全部账号且不得重复');
      input.accountIds.forEach((id, i) => db.prepare('UPDATE jimeng_accounts SET priority=? WHERE id=?').run(i, id));
      db.prepare('UPDATE pool_settings SET revision=revision+1 WHERE id=1').run();
      event('order_updated', null, '账号排序已更新', null, null, actor);
      return getDashboard();
    }).immediate();
  }
  function occupancy(id: string) {
    return db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(estimated_credits),0) AS reserved, SUM(CASE WHEN estimated_credits IS NULL THEN 1 ELSE 0 END) AS unknown_count FROM pool_tasks WHERE account_id=? AND held=1').get(id);
  }
  function verifiedIdentity(r: any) {
    const identity = json(r?.identity_json, null);
    if (!identity || (identity.credentialVersion != null && identity.credentialVersion !== r?.credential_version)) return null;
    return identity;
  }
  function verifiedUserId(r: any): string | null {
    const identity = verifiedIdentity(r);
    return identity?.verified === true && typeof identity.userId === 'string' && identity.userId ? identity.userId : null;
  }
  function subjectPeers(target: any, all = rows()) {
    const ids = new Set<string>([target.id]);
    const sessionHashes = new Set<string>(target.session_hash ? [target.session_hash] : []);
    const userIds = new Set<string>();
    const targetUid = verifiedUserId(target);
    if (targetUid) userIds.add(targetUid);
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of all) {
        if (ids.has(item.id)) continue;
        const itemUid = verifiedUserId(item);
        if ((item.session_hash && sessionHashes.has(item.session_hash)) || (itemUid && userIds.has(itemUid))) {
          ids.add(item.id);
          if (item.session_hash) sessionHashes.add(item.session_hash);
          if (itemUid) userIds.add(itemUid);
          changed = true;
        }
      }
    }
    return all.filter((item: any) => ids.has(item.id));
  }
  function occupancyForIds(peerIds: string[]) {
    const placeholders = peerIds.map(() => '?').join(',');
    return db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(estimated_credits),0) AS reserved, SUM(CASE WHEN estimated_credits IS NULL THEN 1 ELSE 0 END) AS unknown_count FROM pool_tasks WHERE account_id IN (${placeholders}) AND held=1`).get(...peerIds);
  }
  function eligibility(r: any, estimate: number | null = 0, model = '', allRows?: any[]) {
    const all = allRows || rows();
    const peers = subjectPeers(r, all), peerIds = peers.map((p: any) => p.id), primaryEnabled = peers.find((p: any) => p.enabled);
    const occupied = occupancyForIds(peerIds), settings = getSettings();
    const fresh = Number.isFinite(Date.parse(r.status_checked_at)) && Date.now() - Date.parse(r.status_checked_at) <= settings.balanceMaxAgeSeconds * 1000;
    const available = Number.isFinite(r.total_credit) && fresh && !r.status_error ? r.total_credit - occupied.reserved : null;
    let reason = '可接收新任务';
    if (!r.enabled) reason = '账号已停用';
    else if (primaryEnabled && primaryEnabled.id !== r.id) {
      const sameUid = verifiedUserId(r) && verifiedUserId(r) === verifiedUserId(primaryEnabled);
      reason = sameUid ? `与排在前面的账号「${primaryEnabled.name}」为同一上游身份，已禁止重复参与调度` : `与排在前面的账号「${primaryEnabled.name}」为同一会话凭据，已禁止重复参与调度`;
    }
    else if (r.status_error) reason = '余额或凭据校验失败';
    else if (!Number.isFinite(r.total_credit) || !fresh) reason = '余额未知或已过期';
    else if (r.cooldown_until && Date.parse(r.cooldown_until) > Date.now()) reason = '账号冷却中';
    else if (peers.some((p: any) => p.calibration_token && p.calibration_until > Date.now())) reason = '余额校准中';
    else if (occupied.unknown_count || (estimate === null && occupied.count)) reason = '未知费用任务需要独占账号';
    else if (db.prepare(`SELECT 1 FROM pool_tasks WHERE account_id IN (${peerIds.map(() => '?').join(',')}) AND held=1 AND state IN ('succeeded','failed','unknown') LIMIT 1`).get(...peerIds)) reason = '存在待确认或待结算任务';
    else if (available! < settings.threshold) reason = '可用积分低于接单门槛';
    else if (estimate !== null && available! < estimate) reason = '可用积分不足预估费用';
    else {
      const membership = json(r.membership_json, {});
      // Only explicit provider evidence can deny/allow a restricted model; local account notes are not proof.
      if (model && Array.isArray(membership?.supportedModels) && !membership.supportedModels.includes(model)) reason = '账号权益不支持该模型';
      else if (model && /(?:^|[-_])vip(?:$|[-_])/i.test(model) && membership?.isVip !== true && membership?.isVip !== 1) reason = '该模型所需会员权益未核验';
      else if (Number.isInteger(membership?.maxConcurrentTasks) && occupied.count >= membership.maxConcurrentTasks) reason = '已达账号并发限制';
      else { try { deps.selection(r.id); } catch { reason = '账号凭据不可解密或不可用'; } }
    }
    return { eligible: reason === '可接收新任务', reason, reservedCredits: occupied.reserved, availableCredits: available, activeTaskCount: occupied.count, unknownCostBusy: Boolean(occupied.unknown_count) };
  }
  function publicAccount(r: any, allRows?: any[]) {
    const raw = verifiedIdentity(r);
    const upstreamIdentity = raw
      ? {
          verified: Boolean(raw.verified),
          userId: typeof raw.userId === 'string' ? raw.userId : null,
          displayName: typeof raw.displayName === 'string' ? raw.displayName : null,
          checkedAt: typeof raw.checkedAt === 'string' ? raw.checkedAt : null,
          ...(typeof raw.source === 'string' ? { source: raw.source } : {}),
          refreshFailed: Boolean(raw.refreshFailed),
          refreshError: typeof raw.refreshError === 'string' ? raw.refreshError : null,
          ...(typeof raw.lastRefreshAttemptAt === 'string' ? { lastRefreshAttemptAt: raw.lastRefreshAttemptAt } : {})
        }
      : { verified: false, userId: null, displayName: null, checkedAt: null, refreshFailed: false, refreshError: null };
    return { ...deps.publicAccount(r), priority: r.priority, upstreamIdentity, scheduling: eligibility(r, 0, '', allRows) };
  }
  function candidate(estimate: number | null = 0, model = '', preferred?: string) {
    const settings = getSettings(), all = rows();
    // Proven material/session affinity overrides a policy change, but does not bypass new-task admission.
    const id = preferred || (settings.mode === 'fixed' ? settings.fixedAccountId : null);
    const candidates = id ? [row(id)] : all;
    const found = candidates.find((r: any) => eligibility(r, estimate, model, all).eligible);
    if (!found) throw new PoolError(id ? `指定账号不合格：${eligibility(candidates[0], estimate, model, all).reason}` : '没有符合条件的即梦账号', 409);
    return found;
  }
  function toTask(t: any): PoolTask { return { id: t.id, requestId: t.request_id, accountId: t.account_id, accountName: t.account_name, kind: t.kind, model: t.model, ...(t.kind === 'image' ? { requestedImageCount: t.requested_image_count } : {}), state: t.state, estimatedCredits: t.estimated_credits, upstreamTaskId: t.upstream_task_id, createdAt: t.created_at, updatedAt: t.updated_at, error: t.error, settling: Boolean(t.held && terminal(t.state)) }; }
  function owned(id: string, owner: string) { const t = task(id); if (!owner || t.owner_hash !== owner) throw new PoolError('无权读取该任务', 403); return t; }
  function readTask(id: string, owner: string): PoolTask { return toTask(owned(id, owner)); }
  function selectionForTaskRow(t: any): AccountSelection {
    const r = row(t.account_id);
    if (r.credential_version !== t.credential_version) throw new PoolError('任务原账号凭据版本已变更，不能恢复查询', 409);
    return deps.selection(r.id);
  }
  function readTaskCredential(id: string, owner: string): AccountSelection {
    return selectionForTaskRow(owned(id, owner));
  }
  function readTaskForRecovery(id: string): PoolTaskRecoveryRecord {
    const t = task(id);
    return { task: toTask(t), ownerHash: t.owner_hash, selection: selectionForTaskRow(t) };
  }
  const lease = (t: any, reused: boolean): PoolLease => ({ ...selectionForTaskRow(t), taskId: t.id, reused, state: t.state, upstreamTaskId: t.upstream_task_id });
  function replay(t: any, input: AcquireTaskInput): PoolLease {
    if (t.fingerprint !== input.requestFingerprint) throw new PoolError('幂等请求标识对应的请求内容不同', 409);
    const result = lease(t, true);
    // Only the authenticated caller's exact original request proves a pre-migration image count.
    if (t.kind === 'image' && t.requested_image_count == null && input.requestedImageCount !== undefined) {
      db.prepare('UPDATE pool_tasks SET requested_image_count=? WHERE id=? AND requested_image_count IS NULL').run(input.requestedImageCount, t.id);
    }
    return result;
  }
  async function acquireTask(input: AcquireTaskInput): Promise<PoolLease> {
    for (const key of ['requestId', 'ownerHash', 'requestFingerprint', 'model'] as const) if (typeof input?.[key] !== 'string' || !input[key].trim() || input[key].length > 512) throw new PoolError(`无效的 ${key}`);
    if (!['text','image','video','audio','upload'].includes(input.kind) || (input.estimatedCredits !== null && (!Number.isFinite(input.estimatedCredits) || input.estimatedCredits < 0))) throw new PoolError('任务类型或预估费用无效');
    if (input.preferredAccountId !== undefined && (typeof input.preferredAccountId !== 'string' || !input.preferredAccountId)) throw new PoolError('绑定账号无效');
    if (input.requestedImageCount !== undefined && (input.kind !== 'image' || !Number.isInteger(input.requestedImageCount) || input.requestedImageCount < 1 || input.requestedImageCount > 8)) throw new PoolError('无效的图片数量');
    const existing = db.prepare('SELECT * FROM pool_tasks WHERE owner_hash=? AND request_id=?').get(input.ownerHash, input.requestId);
    if (existing) return replay(existing, input);
    await refreshStaleAccounts(input.preferredAccountId);
    return db.transaction(() => {
      const old = db.prepare('SELECT * FROM pool_tasks WHERE owner_hash=? AND request_id=?').get(input.ownerHash, input.requestId);
      if (old) return replay(old, input);
      const selected = candidate(input.estimatedCredits, input.model, input.preferredAccountId), timestamp = stamp(), id = crypto.randomUUID();
      const previous = db.prepare("SELECT account_id FROM pool_tasks ORDER BY rowid DESC LIMIT 1").get();
      db.prepare('INSERT INTO pool_tasks (id, request_id, owner_hash, fingerprint, account_id, account_name, credential_version, kind, model, state, estimated_credits, requested_image_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, input.requestId, input.ownerHash, input.requestFingerprint, selected.id, selected.name, selected.credential_version, input.kind, input.model, 'reserved', input.estimatedCredits, input.requestedImageCount ?? null, timestamp, timestamp);
      db.prepare('UPDATE jimeng_accounts SET last_used_at=?, updated_at=? WHERE id=?').run(timestamp, timestamp, selected.id);
      event('task_reserved', selected.id, '新任务已绑定并原子预占');
      if (previous?.account_id !== selected.id) event('account_switched', selected.id, input.preferredAccountId ? '已核验的素材或会话归属' : getSettings().mode === 'fixed' ? '固定账号策略' : '手动排序中首个合格账号', previous?.account_id || null, selected.id);
      return lease(task(id), false);
    }).immediate();
  }
  function transitionTask(id: string, change: { state: PoolTaskState; upstreamTaskId?: string; result?: unknown; error?: string }): void {
    db.transaction(() => {
      const t = task(id);
      const allowed: Record<PoolTaskState, PoolTaskState[]> = { reserved: ['submitting','failed'], submitting: ['submitted','running','succeeded','failed','unknown'], submitted: ['running','succeeded','failed','unknown'], running: ['succeeded','failed','unknown'], unknown: ['submitted','running','succeeded','failed'], succeeded: [], failed: [] };
      if (!allowed[t.state as PoolTaskState] || (change.state !== t.state && !allowed[t.state as PoolTaskState].includes(change.state))) throw new PoolError('不允许的任务状态转换', 409);
      if (change.upstreamTaskId !== undefined && (typeof change.upstreamTaskId !== 'string' || !change.upstreamTaskId.trim() || change.upstreamTaskId.length > 512)) throw new PoolError('上游任务标识无效');
      if (t.upstream_task_id && change.upstreamTaskId && t.upstream_task_id !== change.upstreamTaskId) throw new PoolError('不能替换已绑定的上游任务标识', 409);
      // Never store raw exception messages: upstream errors may echo cookies, keys, or prompt text.
      const error = change.state === 'unknown' ? '上游提交或结果待确认' : change.state === 'failed' ? '上游任务失败，请核对任务状态' : null;
      const result = change.result === undefined ? t.result_ciphertext : deps.encrypt(JSON.stringify(change.result));
      db.prepare('UPDATE pool_tasks SET state=?, upstream_task_id=?, result_ciphertext=?, error=?, updated_at=? WHERE id=?').run(change.state, change.upstreamTaskId || t.upstream_task_id, result, error, stamp(), id);
      if (change.state !== t.state) event('task_state', t.account_id, `任务状态：${t.state} → ${change.state}`);
    }).immediate();
  }
  function lockRefresh(id: string): string {
    const token = crypto.randomUUID();
    const result = db.prepare('UPDATE jimeng_accounts SET calibration_token=?, calibration_until=? WHERE id=? AND (calibration_token IS NULL OR calibration_until<=?)').run(token, Date.now() + 120000, id, Date.now());
    if (!result.changes) throw new PoolError('账号余额正在校准', 409);
    return token;
  }
  async function calibrate(id: string, settling: boolean, actor?: string): Promise<void> {
    const token = db.transaction(() => {
      const peers = subjectPeers(row(id));
      const peerIds = peers.map((p: any) => p.id);
      const active = db.prepare(`SELECT 1 FROM pool_tasks WHERE account_id IN (${peerIds.map(() => '?').join(',')}) AND held=1 AND state NOT IN ('succeeded','failed') LIMIT 1`).get(...peerIds);
      if (active || (!settling && occupancyForIds(peerIds).count)) throw new PoolError('账号有未结算任务，暂缓余额刷新', 409);
      if (peers.some((p: any) => p.id !== id && p.calibration_token && p.calibration_until > Date.now())) throw new PoolError('同上游账号余额正在校准', 409);
      return lockRefresh(id);
    }).immediate();
    try {
      await deps.refresh(id, token);
      db.transaction(() => {
        const current = row(id);
        if (current.calibration_token !== token) throw new PoolError('余额校准租约已失效', 409);
        const peers = subjectPeers(current);
        const peerIds = peers.map((p: any) => p.id);
        const otherPeers = peers.filter((p: any) => p.id !== id);
        const syncedAt = current.updated_at || stamp();
        for (const peer of otherPeers) {
          if (peer.status_checked_at && !peer.status_error) {
            if (hasDetailedCredits) db.prepare(syncPeerBalanceSql).run(current.free_credit ?? null, current.purchase_credit ?? null, current.vip_credit ?? null, current.total_credit, current.membership_json, syncedAt, peer.id);
            else db.prepare(syncPeerBalanceSql).run(current.total_credit, current.membership_json, syncedAt, peer.id);
          } else {
            db.prepare(invalidatePeerBalanceSql).run(syncedAt, peer.id);
          }
        }
        if (settling) {
          const placeholders = peerIds.map(() => '?').join(',');
          db.prepare(`UPDATE pool_tasks SET held=0, updated_at=? WHERE account_id IN (${placeholders}) AND held=1 AND state IN ('succeeded','failed')`).run(stamp(), ...peerIds);
          event('balance_settled', id, otherPeers.length ? '已读取上游最新余额、同步同主体余额并释放结算占位' : '已读取上游最新余额并释放结算占位');
        }
        const refreshedIdentity = verifiedIdentity(current);
        if (!settling) event('balance_refreshed', id, refreshedIdentity?.refreshFailed ? '已刷新上游余额；本次身份核验失败，已保留未换凭据的既有主体（如有）' : '已刷新上游余额和身份核验信息', null, null, actor);
        db.prepare('UPDATE jimeng_accounts SET calibration_token=NULL, calibration_until=NULL WHERE id=? AND calibration_token=?').run(id, token);
      }).immediate();
    } catch (error) {
      db.prepare('UPDATE jimeng_accounts SET calibration_token=NULL, calibration_until=NULL WHERE id=? AND calibration_token=?').run(id, token);
      event('balance_refresh_failed', id, '余额刷新失败，保留占位及最后有效余额时间');
      throw error;
    }
  }
  async function settleTask(id: string): Promise<void> {
    const t = task(id); if (!t.held) return;
    if (!terminal(t.state)) throw new PoolError('待确认或进行中的任务不能释放预占', 409);
    await calibrate(t.account_id, true);
  }
  async function refreshAccount(id: string, actor?: string) { await calibrate(id, false, actor); return publicAccount(row(id), rows()); }
  async function refreshStaleAccounts(preferred?: string): Promise<void> {
    const settings = getSettings();
    const id = preferred || (settings.mode === 'fixed' ? settings.fixedAccountId : null);
    const all = rows();
    for (const r of id ? [row(id)] : all) {
      const latestAll = rows();
      const current = latestAll.find((item: any) => item.id === r.id);
      if (!current || !current.enabled) continue;
      const peers = subjectPeers(current, latestAll);
      const primaryEnabled = peers.find((p: any) => p.enabled);
      if (!id && primaryEnabled && primaryEnabled.id !== current.id) continue;
      if (occupancyForIds(peers.map((p: any) => p.id)).count || (current.cooldown_until && Date.parse(current.cooldown_until) > Date.now())) continue;
      if (!current.status_error && current.status_checked_at && Date.now() - Date.parse(current.status_checked_at) <= settings.balanceMaxAgeSeconds * 1000) continue;
      try { await refreshAccount(current.id); } catch { /* Failed refresh remains explicitly ineligible; admission fails closed. */ }
    }
  }
  function page(table: string, limit = 50, offset = 0) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0) throw new PoolError('分页参数无效');
    return { rows: db.prepare(`SELECT * FROM ${table} ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(limit, offset), total: db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n };
  }
  const listRecoverableTasks = (): PoolTask[] =>
    db.prepare('SELECT * FROM pool_tasks WHERE held=1 ORDER BY created_at').all().map(toTask);

  // Runs on startup and each maintenance tick. Multiple workers can safely scan
  // the same database. A slow live submission may still deliver its original ID.
  function scanTasksForMaintenance(now = Date.now()): PoolTask[] {
    const cutoff = new Date(now - ACK_WAIT_MS).toISOString();
    db.transaction(() => {
      const expired = db.prepare(`UPDATE pool_tasks SET state='unknown', updated_at=?, error=?
        WHERE held=1 AND state='submitting' AND upstream_task_id IS NULL AND updated_at<=?
        RETURNING id, account_id`).all(new Date(now).toISOString(), '尚未收到上游回执，请用原账号核对', cutoff);
      for (const task of expired) {
        event('task_state', task.account_id, `任务 ${task.id} 等待上游回执超时，转为提交待确认`);
      }
    }).immediate();
    return listRecoverableTasks();
  }

  function listTasks(limit = 50, offset = 0) { const p = page('pool_tasks', limit, offset); return { items: p.rows.map(toTask), total: p.total }; }
  function listEvents(limit = 50, offset = 0) { const p = page('pool_events', limit, offset); return { items: p.rows.map((r: any): PoolEvent => ({ id: r.id, type: r.type, accountId: r.account_id, fromAccountId: r.from_account_id, toAccountId: r.to_account_id, reason: r.reason, createdAt: r.created_at, ...(r.actor ? { actor: r.actor } : {}) })), total: p.total }; }
  function getDashboard() {
    let nextAccountId: string | null = null, nextReason = '提交时将再次校验余额、费用及资格';
    const all = rows();
    try { nextAccountId = candidate().id; } catch (e) { nextReason = e instanceof PoolError ? e.message : '暂无合格账号'; }
    const events = listEvents().items;
    const switchRow = db.prepare("SELECT * FROM pool_events WHERE type='account_switched' ORDER BY rowid DESC LIMIT 1").get();
    const lastSwitch: PoolEvent | null = switchRow ? { id: switchRow.id, type: switchRow.type, accountId: switchRow.account_id, fromAccountId: switchRow.from_account_id, toAccountId: switchRow.to_account_id, reason: switchRow.reason, createdAt: switchRow.created_at } : null;
    return { settings: getSettings(), summary: { nextAccountId, nextReason, predictedAt: stamp(), activeTaskCount: db.prepare('SELECT COUNT(*) AS n FROM pool_tasks WHERE held=1').get().n, lastSwitch }, accounts: all.map(item => publicAccount(item, all)), tasks: listTasks().items, events };
  }
  function assertMutable(id: string) { if (occupancy(id).count || (row(id).calibration_token && row(id).calibration_until > Date.now())) throw new PoolError('账号存在进行中、待确认或待结算任务，禁止删除或更换凭据', 409); }
  function accountChanged(type: string, id: string, actor?: string) {
    db.prepare('UPDATE pool_settings SET revision=revision+1 WHERE id=1').run();
    const reasons: Record<string, string> = { account_created: '新增账号', account_updated: '更新账号备注或配置', credential_updated: '更换凭据并清除旧余额及身份核验', account_enabled: '启用账号接收新任务', account_disabled: '停用新派发，保留已绑定任务', account_deleted: '删除无未结算任务的账号' };
    event(type, id, reasons[type] || '账号管理配置已更新', null, null, actor);
  }
  return { getSettings, updateSettings, reorderAccounts, getDashboard, listTasks, listEvents, acquireTask, transitionTask, settleTask, readTask, readTaskCredential, readTaskForRecovery,
    readTaskResult: (id: string, owner: string) => {
      const t = owned(id, owner);
      const result = t.result_ciphertext ? JSON.parse(deps.decrypt(t.result_ciphertext)) : null;
      // Preserve historical ciphertext; after a matching legacy replay cap both public URL lists.
      if (result && t.kind === 'image' && t.requested_image_count != null) {
        if (Array.isArray(result.urls)) result.urls = result.urls.slice(0, t.requested_image_count);
        if (Array.isArray(result.data)) result.data = result.data.slice(0, t.requested_image_count);
      }
      return result;
    },
    listRecoverableTasks, scanTasksForMaintenance,
    refreshStaleAccounts, refreshAccount, publicAccount, assertMutable, accountChanged,
    preview: (): AccountSelection => deps.selection(candidate().id)
  };
}
