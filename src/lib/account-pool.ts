import Database from "better-sqlite3";
import crypto from "crypto";
import fs from "fs-extra";
import path from "path";

import { getCredit, request } from "@/api/controllers/core.ts";

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
  if (!value) throw new Error("Cookie 中缺少 sessionid、sessionid_ss 或 sid_tt");
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

function credentialInput(input: AccountPoolCreateInput | AccountPoolUpdateInput): { value: string; kind: AccountCredentialKind } | null {
  if (input.cookie && input.sessionId) throw new Error("cookie 和 sessionId 只能提供一个");
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

let roundRobinCursor = 0;
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
      membership: parseJson(row.membership_json, "unknown"),
      checkedAt: row.status_checked_at,
      ...(row.status_error ? { error: row.status_error } : {})
    },
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getRow(id: string): AccountRow {
  const row = db.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(id) as AccountRow | undefined;
  if (!row) throw new Error(`账号不存在: ${id}`);
  return row;
}

export function setMembershipStatusProvider(provider?: MembershipStatusProvider): void {
  membershipStatusProvider = provider;
}

export function listAccounts(): PublicAccount[] {
  return (db.prepare(`SELECT * FROM ${TABLE} ORDER BY created_at ASC`).all() as AccountRow[]).map(toPublic);
}

export function getAccount(id: string): PublicAccount {
  return toPublic(getRow(id));
}

export function createAccount(input: AccountPoolCreateInput): PublicAccount {
  if (!input.name?.trim()) throw new Error("账号名称不能为空");
  const credential = credentialInput(input);
  if (!credential) throw new Error("必须提供 cookie 或 sessionId");
  extractSessionId(credential.value, credential.kind);
  const timestamp = now();
  const id = crypto.randomUUID();
  try {
    db.prepare(`INSERT INTO ${TABLE} (id, name, credential_kind, credential_hash, credential_ciphertext, enabled, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.name.trim(), credential.kind, hashCredential(credential.value), encrypt(credential.value), input.enabled === false ? 0 : 1,
      JSON.stringify(input.metadata || {}), timestamp, timestamp
    );
  } catch (error: any) {
    if (String(error?.message).includes("UNIQUE")) throw new Error("该账号凭据已存在");
    throw error;
  }
  return getAccount(id);
}

export function updateAccount(id: string, input: AccountPoolUpdateInput): PublicAccount {
  const row = getRow(id);
  const credential = credentialInput(input);
  if (credential) { extractSessionId(credential.value, credential.kind); }
  const timestamp = now();
  const values = {
    name: input.name === undefined ? row.name : input.name.trim(),
    enabled: input.enabled === undefined ? row.enabled : (input.enabled ? 1 : 0),
    metadata: input.metadata === undefined ? row.metadata_json : JSON.stringify(input.metadata),
    kind: credential?.kind || row.credential_kind,
    hash: credential ? hashCredential(credential.value) : row.credential_hash,
    ciphertext: credential ? encrypt(credential.value) : row.credential_ciphertext
  };
  if (!values.name) throw new Error("账号名称不能为空");
  try {
    db.prepare(`UPDATE ${TABLE} SET name = ?, credential_kind = ?, credential_hash = ?, credential_ciphertext = ?, enabled = ?, metadata_json = ?, updated_at = ? WHERE id = ?`).run(
      values.name, values.kind, values.hash, values.ciphertext, values.enabled, values.metadata, timestamp, id
    );
  } catch (error: any) {
    if (String(error?.message).includes("UNIQUE")) throw new Error("该账号凭据已存在");
    throw error;
  }
  return getAccount(id);
}

export function deleteAccount(id: string): void {
  const result = db.prepare(`DELETE FROM ${TABLE} WHERE id = ?`).run(id);
  if (!result.changes) throw new Error(`账号不存在: ${id}`);
}

export function setAccountEnabled(id: string, enabled: boolean): PublicAccount {
  getRow(id);
  db.prepare(`UPDATE ${TABLE} SET enabled = ?, updated_at = ? WHERE id = ?`).run(enabled ? 1 : 0, now(), id);
  return getAccount(id);
}

export function selectAccount(strategy: AccountSelectionStrategy = "least_failures"): AccountSelection {
  const rows = db.prepare(`SELECT * FROM ${TABLE} WHERE enabled = 1 AND (cooldown_until IS NULL OR cooldown_until <= ?) ORDER BY failure_count ASC, last_used_at ASC`).all(now()) as AccountRow[];
  if (!rows.length) throw new Error("没有可用的即梦账号");
  const row = strategy === "round_robin" ? rows[roundRobinCursor++ % rows.length] : rows[0];
  db.prepare(`UPDATE ${TABLE} SET last_used_at = ?, updated_at = ? WHERE id = ?`).run(now(), now(), row.id);
  const credential = decrypt(row.credential_ciphertext);
  return { account: getAccount(row.id), credential, sessionId: extractSessionId(credential, row.credential_kind) };
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

export async function refreshStatus(id: string): Promise<PublicAccount> {
  const row = getRow(id);
  const credential = decrypt(row.credential_ciphertext);
  const sessionId = extractSessionId(credential, row.credential_kind);
  try {
    const credit = await getCredit(sessionId);
    const membership = membershipStatusProvider ? await membershipStatusProvider(sessionId, toPublic(row)) : "unknown";
    const timestamp = now();
    db.prepare(`UPDATE ${TABLE} SET free_credit = ?, purchase_credit = ?, vip_credit = ?, total_credit = ?, membership_json = ?, status_checked_at = ?, status_error = NULL, updated_at = ? WHERE id = ?`).run(
      credit.giftCredit ?? null, credit.purchaseCredit ?? null, credit.vipCredit ?? null, credit.totalCredit ?? null, JSON.stringify(membership), timestamp, timestamp, id
    );
    return getAccount(id);
  } catch (error: any) {
    const message = error instanceof AccountPoolConfigurationError ? error.message : (error?.message || "状态查询失败");
    db.prepare(`UPDATE ${TABLE} SET status_checked_at = ?, status_error = ?, updated_at = ? WHERE id = ?`).run(now(), message.slice(0, 500), now(), id);
    throw error;
  }
}

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
  setMembershipStatusProvider
};

setMembershipStatusProvider(async (sessionId) => {
  const result = await request("POST", "/passport/account/info/v2", sessionId, {
    params: { account_sdk_source: "web" }
  });
  const source = result?.user_info || result?.user || result?.account || result;
  const membership = {
    isVip: source?.is_vip ?? source?.isVip ?? source?.vip_status ?? null,
    vipExpireAt: source?.vip_expire_time ?? source?.vipExpireTime ?? source?.vip_expire_at ?? null,
    membershipType: source?.membership_type ?? source?.membershipType ?? null
  };
  return Object.values(membership).some((value) => value !== null) ? membership : "unknown";
});

export default accountPool;
