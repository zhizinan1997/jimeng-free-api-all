import Database from "better-sqlite3";
import crypto from "crypto";
import fs from "fs-extra";
import path from "path";

import { request } from "@/api/controllers/core.ts";
import { createPoolScheduler, PoolError } from "./account-pool-scheduler.ts";
import { parseJimengAccountInfo } from "./jimeng-account-info.ts";
export type { PoolTask, PoolTaskState, PoolTaskKind, PoolLease, PoolSettings, PoolEvent, AcquireTaskInput, PoolTaskRecoveryRecord } from "./account-pool-scheduler.ts";
export { PoolError } from "./account-pool-scheduler.ts";

const DB_PATH = process.env.DB_PATH || "./data/jimeng.db";
const TABLE = "jimeng_accounts";

export type AccountCredentialKind = "cookie" | "sessionid";
export type AccountSelectionStrategy = "round_robin" | "least_failures";

export interface AccountPoolCreateInput {
  name: string;
  cookie?: string;
  sessionId?: string;
  enabled?: boolean;
  metadata?: Record<string, unknown>;
}

export interface AccountPoolUpdateInput {
  name?: string;
  cookie?: string;
  sessionId?: string;
  enabled?: boolean;
  metadata?: Record<string, unknown>;
}

export interface AccountStatus {
  freeCredit: number | null;
  purchaseCredit: number | null;
  vipCredit: number | null;
  totalCredit: number | null;
  membership: unknown;
  checkedAt: string | null;
  error?: string;
}

export interface PublicAccount {
  id: string;
  name: string;
  credentialKind: AccountCredentialKind;
  credentialPreview: string;
  enabled: boolean;
  failureCount: number;
  successCount: number;
  cooldownUntil: string | null;
  lastUsedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  status: AccountStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AccountSelection {
  account: PublicAccount;
  /** Internal use by the caller that performs a Jimeng request. Never return this from an HTTP handler. */
  credential: string;
  sessionId: string;
}

export type MembershipStatusProvider = (sessionId: string, account: PublicAccount) => Promise<unknown>;

interface AccountRow {
  id: string;
  name: string;
  credential_kind: AccountCredentialKind;
  credential_hash: string;
  session_hash?: string | null;
  credential_ciphertext: string;
  enabled: number;
  failure_count: number;
  success_count: number;
  cooldown_until: string | null;
  last_used_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  free_credit: number | null;
  purchase_credit: number | null;
  vip_credit: number | null;
  total_credit: number | null;
  membership_json: string | null;
  status_checked_at: string | null;
  status_error: string | null;
  credential_version?: number;
  identity_json?: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

export class AccountPoolConfigurationError extends Error {
  constructor(message = "账号池未配置加密密钥，请设置 JIMENG_ACCOUNT_POOL_KEY 或 ACCOUNT_POOL_ENCRYPTION_KEY") {
    super(message);
    this.name = "AccountPoolConfigurationError";
  }
}

function now(): string {
  return new Date().toISOString();
}

function preview(value: string): string {
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function extractSessionId(credential: string, kind: AccountCredentialKind): string {
  const raw = credential.trim();
  if (kind === "sessionid") return raw;

  // 兼容浏览器开发者工具复制出来的多种 Cookie 形式：
  // `sessionid=...`、`Cookie: sessionid=...`、换行分隔以及带空格的键值对。
  const normalized = raw
    .replace(/^\s*cookie\s*:\s*/i, "")
    .replace(/[\r\n]+/g, ";");
  const pairs = new Map<string, string>();
  for (const item of normalized.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    const key = item.slice(0, separator).trim().toLowerCase();
    const value = item.slice(separator + 1).trim();
    if (key && value) pairs.set(key, value);
  }

  let value = pairs.get("sessionid") || pairs.get("sessionid_ss") || pairs.get("sid_tt");
  if (!value) {
    const sidGuard = pairs.get("sid_guard");
    value = sidGuard?.split("%7C")[0] || sidGuard?.split("|")[0];
  }
  // 也允许直接粘贴 sessionId，方便从接口或环境变量中复制。
  if (!value && !normalized.includes("=") && /^[^\s;]+$/.test(raw)) value = raw;
  if (!value) throw new PoolError("Cookie 中缺少 sessionid、sessionid_ss 或 sid_tt");
  try { return decodeURIComponent(value); } catch { return value; }
}

function getEncryptionKey(): Buffer {
  const raw = process.env.JIMENG_ACCOUNT_POOL_KEY || process.env.ACCOUNT_POOL_ENCRYPTION_KEY;
  if (!raw?.trim()) throw new AccountPoolConfigurationError();
  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

function encrypt(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function decrypt(value: string): string {
  const [ivText, tagText, ciphertextText] = value.split(".");
  if (!ivText || !tagText || !ciphertextText) throw new Error("账号凭据密文格式无效");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getEncryptionKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8");
}

function hashCredential(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function syncLegacySessionHashes(): void {
  const missing = db.prepare(`SELECT id, credential_kind, credential_ciphertext FROM ${TABLE} WHERE session_hash IS NULL`).all() as Array<{ id: string; credential_kind: AccountCredentialKind; credential_ciphertext: string }>;
  if (!missing.length) return;
  for (const item of missing) {
    try {
      const credential = decrypt(item.credential_ciphertext);
      const sessionHash = hashCredential(extractSessionId(credential, item.credential_kind));
      db.prepare(`UPDATE ${TABLE} SET session_hash = ? WHERE id = ? AND session_hash IS NULL`).run(sessionHash, item.id);
    } catch {
      // Keep legacy rows untouched when the key is unavailable or ciphertext cannot be decrypted yet.
    }
  }
}

function credentialInput(input: AccountPoolCreateInput | AccountPoolUpdateInput): { value: string; kind: AccountCredentialKind } | null {
  if (input.cookie && input.sessionId) throw new PoolError("cookie 和 sessionId 只能提供一个");
  if (input.cookie?.trim()) return { value: input.cookie.trim(), kind: "cookie" };
  if (input.sessionId?.trim()) return { value: input.sessionId.trim(), kind: "sessionid" };
  return null;
}

const dbDirectory = path.dirname(DB_PATH);
fs.ensureDirSync(dbDirectory);
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    credential_kind TEXT NOT NULL CHECK (credential_kind IN ('cookie', 'sessionid')),
    credential_hash TEXT NOT NULL UNIQUE,
    credential_ciphertext TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    failure_count INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    cooldown_until TEXT,
    last_used_at TEXT,
    last_success_at TEXT,
    last_failure_at TEXT,
    free_credit INTEGER,
    purchase_credit INTEGER,
    vip_credit INTEGER,
    total_credit INTEGER,
    membership_json TEXT,
    status_checked_at TEXT,
    status_error TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_${TABLE}_eligible ON ${TABLE}(enabled, cooldown_until, failure_count);
`);

let membershipStatusProvider: MembershipStatusProvider | undefined;

function toPublic(row: AccountRow): PublicAccount {
  return {
    id: row.id,
    name: row.name,
    credentialKind: row.credential_kind,
    credentialPreview: row.credential_kind === "cookie" ? "cookie:********" : preview(row.credential_hash),
    enabled: Boolean(row.enabled),
    failureCount: row.failure_count,
    successCount: row.success_count,
    cooldownUntil: row.cooldown_until,
    lastUsedAt: row.last_used_at,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    status: {
      freeCredit: row.free_credit,
      purchaseCredit: row.purchase_credit,
      vipCredit: row.vip_credit,
      totalCredit: row.total_credit,
      membership: publicMetadata(parseJson(row.membership_json, "unknown")),
      checkedAt: row.status_checked_at,
      ...(row.status_error ? { error: "上游余额刷新失败或凭据无法使用" } : {})
    },
    metadata: publicMetadata(parseJson(row.metadata_json, {})),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function publicMetadata(value: unknown): any {
  if (Array.isArray(value)) return value.map(publicMetadata);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/cookie|session|token|secret|password|authorization|api.?key|prompt|credential/i.test(key)).map(([key, item]) => [key, publicMetadata(item)]));
}

function validateInput(input: AccountPoolCreateInput | AccountPoolUpdateInput) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PoolError('账号参数无效');
  for (const key of ['name', 'cookie', 'sessionId'] as const) if (input[key] !== undefined && typeof input[key] !== 'string') throw new PoolError('账号字段类型无效');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new PoolError('enabled 必须为布尔值');
  if (input.metadata !== undefined && (!input.metadata || typeof input.metadata !== 'object' || Array.isArray(input.metadata))) throw new PoolError('metadata 必须为对象');
  if ((input.cookie !== undefined || input.sessionId !== undefined) && !input.cookie?.trim() && !input.sessionId?.trim()) throw new PoolError('凭据不能为空');
}

function getRow(id: string): AccountRow {
  const row = db.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(id) as AccountRow | undefined;
  if (!row) throw new PoolError("账号不存在", 404);
  return row;
}

export function setMembershipStatusProvider(provider?: MembershipStatusProvider): void {
  membershipStatusProvider = provider;
}

export function listAccounts(): PublicAccount[] {
  syncLegacySessionHashes();
  const list = db.prepare(`SELECT * FROM ${TABLE} ORDER BY priority, created_at, rowid`).all() as AccountRow[];
  return list.map(item => scheduler.publicAccount(item, list));
}

export function getAccount(id: string): PublicAccount {
  syncLegacySessionHashes();
  return scheduler.publicAccount(getRow(id));
}

export function createAccount(input: AccountPoolCreateInput, actor?: string): PublicAccount {
  validateInput(input);
  return db.transaction(() => {
    if (!input.name?.trim()) throw new PoolError("账号名称不能为空");
    const credential = credentialInput(input);
    if (!credential) throw new PoolError("必须提供 cookie 或 sessionId");
    const sessionHash = hashCredential(extractSessionId(credential.value, credential.kind));
    syncLegacySessionHashes();
    const duplicate = db.prepare(`SELECT id FROM ${TABLE} WHERE credential_hash = ? OR session_hash = ? LIMIT 1`).get(hashCredential(credential.value), sessionHash);
    if (duplicate) throw new PoolError("该账号凭据或会话已存在", 409);
    const timestamp = now();
    const id = crypto.randomUUID();
    try {
      db.prepare(`INSERT INTO ${TABLE} (id, name, credential_kind, credential_hash, session_hash, credential_ciphertext, enabled, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, input.name.trim(), credential.kind, hashCredential(credential.value), sessionHash, encrypt(credential.value), input.enabled === false ? 0 : 1,
        JSON.stringify(input.metadata || {}), timestamp, timestamp
      );
    } catch (error: any) {
      if (String(error?.message).includes("UNIQUE")) throw new PoolError("该账号凭据或会话已存在", 409);
      throw error;
    }
    db.prepare('UPDATE jimeng_accounts SET priority=(SELECT COALESCE(MAX(priority),-1)+1 FROM jimeng_accounts WHERE id<>?) WHERE id=?').run(id, id);
    scheduler.accountChanged('account_created', id, actor);
    return getAccount(id);
  }).immediate();
}

export function updateAccount(id: string, input: AccountPoolUpdateInput, actor?: string): PublicAccount {
  validateInput(input);
  return db.transaction(() => {
    const row = getRow(id);
    const credential = credentialInput(input);
    let sessionHash = row.session_hash ?? null;
    if (credential) {
      scheduler.assertMutable(id);
      sessionHash = hashCredential(extractSessionId(credential.value, credential.kind));
      syncLegacySessionHashes();
      const duplicate = db.prepare(`SELECT id FROM ${TABLE} WHERE id <> ? AND (credential_hash = ? OR session_hash = ?) LIMIT 1`).get(id, hashCredential(credential.value), sessionHash);
      if (duplicate) throw new PoolError("该账号凭据或会话已存在", 409);
    }
    const timestamp = now();
    const values = {
      name: input.name === undefined ? row.name : input.name.trim(),
      enabled: input.enabled === undefined ? row.enabled : (input.enabled ? 1 : 0),
      metadata: input.metadata === undefined ? row.metadata_json : JSON.stringify(input.metadata),
      kind: credential?.kind || row.credential_kind,
      hash: credential ? hashCredential(credential.value) : row.credential_hash,
      ciphertext: credential ? encrypt(credential.value) : row.credential_ciphertext
    };
    if (!values.name) throw new PoolError("账号名称不能为空");
    try {
      db.prepare(`UPDATE ${TABLE} SET name = ?, credential_kind = ?, credential_hash = ?, session_hash = ?, credential_ciphertext = ?, enabled = ?, metadata_json = ?, updated_at = ? WHERE id = ?`).run(
        values.name, values.kind, values.hash, sessionHash, values.ciphertext, values.enabled, values.metadata, timestamp, id
      );
    } catch (error: any) {
      if (String(error?.message).includes("UNIQUE")) throw new PoolError("该账号凭据或会话已存在", 409);
      throw error;
    }
    if (credential) db.prepare('UPDATE jimeng_accounts SET credential_version=credential_version+1, identity_json=NULL, status_checked_at=NULL, status_error=NULL, free_credit=NULL, purchase_credit=NULL, vip_credit=NULL, total_credit=NULL, membership_json=NULL, calibration_token=NULL, calibration_until=NULL WHERE id=?').run(id);
    scheduler.accountChanged(credential ? 'credential_updated' : input.enabled !== undefined ? (input.enabled ? 'account_enabled' : 'account_disabled') : 'account_updated', id, actor);
    return getAccount(id);
  }).immediate();
}

export function deleteAccount(id: string, actor?: string): void {
  db.transaction(() => {
    scheduler.assertMutable(id);
    if (scheduler.getSettings().fixedAccountId === id) throw new PoolError('请先取消该账号的固定模式配置', 409);
    const result = db.prepare(`DELETE FROM ${TABLE} WHERE id = ?`).run(id);
    if (!result.changes) throw new PoolError('账号不存在', 404);
    scheduler.accountChanged('account_deleted', id, actor);
  }).immediate();
}

export function setAccountEnabled(id: string, enabled: boolean, actor?: string): PublicAccount {
  if (typeof enabled !== 'boolean') throw new PoolError('enabled 必须为布尔值');
  return updateAccount(id, { enabled }, actor);
}

/** Legacy select is a read-only preview. New submissions MUST use acquireTask. */
export function selectAccount(_strategy: AccountSelectionStrategy = "least_failures"): AccountSelection {
  return scheduler.preview();
}

/** Read the task's original account without advancing pool rotation. */
export function readTaskAccount(id: string): AccountSelection {
  const row = getRow(id);
  const credential = decrypt(row.credential_ciphertext);
  return { account: toPublic(row), credential, sessionId: extractSessionId(credential, row.credential_kind) };
}

export function markSuccess(id: string): PublicAccount {
  getRow(id);
  db.prepare(`UPDATE ${TABLE} SET success_count = success_count + 1, failure_count = 0, cooldown_until = NULL, last_success_at = ?, updated_at = ? WHERE id = ?`).run(now(), now(), id);
  return getAccount(id);
}

export function markFailure(id: string, cooldownMs = 30_000): PublicAccount {
  getRow(id);
  const cooldownUntil = new Date(Date.now() + Math.max(0, cooldownMs)).toISOString();
  db.prepare(`UPDATE ${TABLE} SET failure_count = failure_count + 1, cooldown_until = ?, last_failure_at = ?, updated_at = ? WHERE id = ?`).run(cooldownUntil, now(), now(), id);
  return getAccount(id);
}

export type CreditStatusProvider = (sessionId: string, credential: string) => Promise<{ giftCredit?: number; purchaseCredit?: number; vipCredit?: number; totalCredit: number }>;
// Read the actual response shape: missing balance fields are unknown, never synthesized as zero.
let creditStatusProvider: CreditStatusProvider = async (sessionId, credential) => {
  const result = await request('POST', '/commerce/v1/benefits/user_credit', sessionId, { cookie: credential.includes('=') ? credential : undefined, data: {} });
  const credit = result?.credit;
  if (!credit || !['gift_credit','purchase_credit','vip_credit'].every(key => Number.isFinite(credit[key]) && credit[key] >= 0)) throw new PoolError('上游余额响应缺失有效积分', 502);
  return { giftCredit: credit.gift_credit, purchaseCredit: credit.purchase_credit, vipCredit: credit.vip_credit, totalCredit: credit.gift_credit + credit.purchase_credit + credit.vip_credit };
};
export function setCreditStatusProvider(provider: CreditStatusProvider): void { creditStatusProvider = provider; }

async function refreshStatusLocked(id: string, lockToken: string): Promise<PublicAccount> {
  const row = getRow(id);
  try {
    const credential = decrypt(row.credential_ciphertext);
    const sessionId = extractSessionId(credential, row.credential_kind);
    const credit = await creditStatusProvider(sessionId, credential);
    if (!Number.isFinite(credit.totalCredit) || credit.totalCredit < 0) throw new PoolError('上游余额无效', 502);
    // Identity is independently verified; membership failure must not invent identity or invalidate a valid balance.
    const timestamp = now();
    const existingIdentity = parseJson<Record<string, any> | null>(row.identity_json, null);
    const credentialVersion = typeof row.credential_version === 'number' ? row.credential_version : 1;
    const preservedIdentity = existingIdentity?.verified === true
      && typeof existingIdentity.userId === 'string'
      && existingIdentity.userId.length > 0
      && (existingIdentity.credentialVersion == null || existingIdentity.credentialVersion === credentialVersion)
      ? {
          verified: true,
          userId: existingIdentity.userId,
          displayName: typeof existingIdentity.displayName === 'string' ? existingIdentity.displayName : null,
          checkedAt: typeof existingIdentity.checkedAt === 'string' ? existingIdentity.checkedAt : null,
          source: typeof existingIdentity.source === 'string' ? existingIdentity.source : '/passport/account/info/v2',
          credentialVersion
        }
      : null;
    let membership: any = 'unknown';
    let identity: any = preservedIdentity ? { ...preservedIdentity, refreshFailed: false, refreshError: null } : null;
    if (membershipStatusProvider) {
      try {
        const evidence: any = await membershipStatusProvider(sessionId, toPublic(row));
        membership = evidence?.membership ?? evidence;
        if (evidence?.upstreamIdentity?.verified === true && typeof evidence.upstreamIdentity.userId === 'string' && evidence.upstreamIdentity.userId) {
          identity = {
            verified: true,
            userId: evidence.upstreamIdentity.userId,
            displayName: typeof evidence.upstreamIdentity.displayName === 'string' ? evidence.upstreamIdentity.displayName : null,
            checkedAt: timestamp,
            source: evidence.upstreamIdentity.source || '/passport/account/info/v2',
            credentialVersion,
            refreshFailed: false,
            refreshError: null,
            lastRefreshAttemptAt: timestamp
          };
        } else {
          identity = preservedIdentity
            ? { ...preservedIdentity, refreshFailed: true, refreshError: '上游身份核验本次刷新未返回有效用户标识，已保留当前凭据已核验主体', lastRefreshAttemptAt: timestamp }
            : { verified: false, userId: null, displayName: null, checkedAt: null, credentialVersion, refreshFailed: true, refreshError: '上游身份核验本次刷新未返回有效用户标识', lastRefreshAttemptAt: timestamp };
        }
      } catch {
        /* Retain prior verified subject for the unchanged credential while flagging the refresh failure separately. */
        identity = preservedIdentity
          ? { ...preservedIdentity, refreshFailed: true, refreshError: '上游身份核验本次刷新失败，已保留当前凭据已核验主体', lastRefreshAttemptAt: timestamp }
          : { verified: false, userId: null, displayName: null, checkedAt: null, credentialVersion, refreshFailed: true, refreshError: '上游身份核验本次刷新失败', lastRefreshAttemptAt: timestamp };
      }
    }
    const sessionHash = hashCredential(sessionId);
    const result = db.prepare(`UPDATE ${TABLE} SET session_hash=COALESCE(session_hash, ?), free_credit=?, purchase_credit=?, vip_credit=?, total_credit=?, membership_json=?, identity_json=?, status_checked_at=?, status_error=NULL, updated_at=? WHERE id=? AND calibration_token=? AND calibration_until>?`).run(
      sessionHash, credit.giftCredit ?? null, credit.purchaseCredit ?? null, credit.vipCredit ?? null, credit.totalCredit, JSON.stringify(publicMetadata(membership)), identity ? JSON.stringify(identity) : null, timestamp, timestamp, id, lockToken, Date.now()
    );
    if (!result.changes) throw new PoolError('余额校准租约失效', 409);
    return toPublic(getRow(id));
  } catch {
    db.prepare(`UPDATE ${TABLE} SET status_error=?, updated_at=? WHERE id=? AND calibration_token=?`).run('上游余额刷新失败或凭据无法使用', now(), id, lockToken);
    throw new PoolError('上游余额刷新失败；保留原余额时间和未结算占位', 502);
  }
}

const scheduler = createPoolScheduler({ db, publicAccount: toPublic, selection: readTaskAccount, refresh: refreshStatusLocked, encrypt, decrypt, prepareRows: syncLegacySessionHashes });
// The shared browser could cache another account's identity and balance. Clear both
// together, before any scheduler tick can use that identity to skip an account.
db.transaction(() => {
  db.exec('CREATE TABLE IF NOT EXISTS pool_migrations (name TEXT PRIMARY KEY NOT NULL)');
  const applied = db.prepare('INSERT OR IGNORE INTO pool_migrations (name) VALUES (?)')
    .run('isolated-browser-account-cache-v1');
  if (applied.changes) db.exec(`UPDATE jimeng_accounts
    SET identity_json=NULL, membership_json=NULL, free_credit=NULL, purchase_credit=NULL,
        vip_credit=NULL, total_credit=NULL, status_checked_at=NULL, status_error=NULL`);
}).immediate();

export const { acquireTask, transitionTask, settleTask, readTask, readTaskCredential, readTaskResult, readTaskForRecovery, listRecoverableTasks, getDashboard, getSettings, updateSettings, reorderAccounts, listTasks, listEvents, refreshStaleAccounts } = scheduler;
export const refreshStatus = scheduler.refreshAccount;

// Explicit named service API for callers that do not want to use the default object.
export const list = listAccounts;
export const create = createAccount;
export const update = updateAccount;
export const remove = deleteAccount;
export { deleteAccount as delete };
export const select = selectAccount;

export const accountPool = {
  list: listAccounts,
  get: getAccount,
  create: createAccount,
  update: updateAccount,
  delete: deleteAccount,
  setEnabled: setAccountEnabled,
  select: selectAccount,
  markSuccess,
  markFailure,
  refreshStatus,
  setMembershipStatusProvider,
  setCreditStatusProvider,
  readTaskAccount,
  acquireTask, transitionTask, settleTask, readTask, readTaskCredential, readTaskResult,
  readTaskForRecovery, listRecoverableTasks, getDashboard, getSettings, updateSettings, reorderAccounts,
  listTasks, listEvents, refreshStaleAccounts, scanTasksForMaintenance: scheduler.scanTasksForMaintenance
};

setMembershipStatusProvider(async (sessionId, account) => {
  const credential = readTaskAccount(account.id).credential;
  const result = await request("POST", "/passport/account/info/v2", sessionId, {
    cookie: credential.includes("=") ? credential : undefined,
    params: { account_sdk_source: "web" }
  });
  return parseJimengAccountInfo(result);
});

export default accountPool;
