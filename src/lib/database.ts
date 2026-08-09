import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs-extra';
import crypto from 'crypto';

// 数据库文件路径
const DB_PATH = process.env.DB_PATH || './data/jimeng.db';

// 确保数据目录存在
fs.ensureDirSync(path.dirname(DB_PATH));

// 初始化数据库连接
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// 初始化表结构
db.exec(`
  -- 用户表（管理员账号）
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  -- Session表
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- API Key统计表
  CREATE TABLE IF NOT EXISTS key_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash TEXT NOT NULL,
    key_preview TEXT NOT NULL,
    model TEXT NOT NULL,
    credits_used INTEGER DEFAULT 0,
    remaining_credits INTEGER DEFAULT 0,
    call_count INTEGER DEFAULT 1,
    last_used TEXT DEFAULT (datetime('now', 'localtime')),
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  -- 管理端创建的 API Key（仅保存 hash，不保存原始 Key）
  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash TEXT NOT NULL UNIQUE,
    key_preview TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    last_used TEXT
  );

  -- 媒体记录表
  CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    url TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt TEXT,
    key_preview TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  -- 日志缓冲表
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  -- 创建索引
  CREATE INDEX IF NOT EXISTS idx_key_stats_key ON key_stats(key_hash);
  CREATE INDEX IF NOT EXISTS idx_api_keys_enabled ON api_keys(enabled);
  CREATE INDEX IF NOT EXISTS idx_media_created ON media(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
  CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at DESC);
`);

// 兼容早期可能已经存在的 api_keys 表：新增列时不影响现有数据。
const apiKeyColumns = db.prepare('PRAGMA table_info(api_keys)').all() as Array<{ name: string }>;
const apiKeyColumnNames = new Set(apiKeyColumns.map(column => column.name));
const apiKeyMigrations: Array<[string, string]> = [
  ['key_hash', "ALTER TABLE api_keys ADD COLUMN key_hash TEXT"],
  ['key_preview', "ALTER TABLE api_keys ADD COLUMN key_preview TEXT DEFAULT ''"],
  ['name', "ALTER TABLE api_keys ADD COLUMN name TEXT NOT NULL DEFAULT ''"],
  ['enabled', "ALTER TABLE api_keys ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1"],
  ['created_at', "ALTER TABLE api_keys ADD COLUMN created_at TEXT DEFAULT (datetime('now', 'localtime'))"],
  ['last_used', 'ALTER TABLE api_keys ADD COLUMN last_used TEXT']
];
for (const [column, statement] of apiKeyMigrations) {
  if (!apiKeyColumnNames.has(column)) db.exec(statement);
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);');

// 密码哈希
export function hashPassword(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// 生成Session ID
export function generateSessionId(): string {
  return crypto.randomBytes(32).toString('hex');
}

// Key预览（隐藏中间部分）
export function keyPreview(key: string): string {
  if (key.length <= 8) return key;
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

// Key哈希
export function hashKey(key: string): string {
  return crypto.createHash('md5').update(key).digest('hex');
}

// 管理端 API Key 使用 SHA-256；key_stats 继续使用原有 MD5，保证历史统计兼容。
function hashManagedApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function generateManagedApiKey(): string {
  return `jm_${crypto.randomBytes(32).toString('base64url')}`;
}

export interface ManagedApiKey {
  id: number;
  key_preview: string;
  name: string;
  enabled: boolean;
  created_at: string;
  last_used: string | null;
}

export function createApiKey(name = ''): { key: string; apiKey: ManagedApiKey } {
  const key = generateManagedApiKey();
  const keyHash = hashManagedApiKey(key);
  const preview = keyPreview(key);
  const result = db.prepare(
    'INSERT INTO api_keys (key_hash, key_preview, name, enabled) VALUES (?, ?, ?, 1)'
  ).run(keyHash, preview, name.trim().slice(0, 100));
  const apiKey = db.prepare(
    'SELECT id, key_preview, name, enabled, created_at, last_used FROM api_keys WHERE id = ?'
  ).get(result.lastInsertRowid) as any;
  return { key, apiKey: { ...apiKey, enabled: Boolean(apiKey.enabled) } };
}

export function listApiKeys(): ManagedApiKey[] {
  const rows = db.prepare(
    'SELECT id, key_preview, name, enabled, created_at, last_used FROM api_keys ORDER BY id DESC'
  ).all() as any[];
  return rows.map(row => ({ ...row, enabled: Boolean(row.enabled) }));
}

export function setApiKeyEnabled(id: number, enabled: boolean): ManagedApiKey | null {
  const result = db.prepare('UPDATE api_keys SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  if (!result.changes) return null;
  const row = db.prepare(
    'SELECT id, key_preview, name, enabled, created_at, last_used FROM api_keys WHERE id = ?'
  ).get(id) as any;
  return { ...row, enabled: Boolean(row.enabled) };
}

export function deleteApiKey(id: number): boolean {
  return db.prepare('DELETE FROM api_keys WHERE id = ?').run(id).changes > 0;
}

export function touchApiKey(key: string): void {
  db.prepare("UPDATE api_keys SET last_used = datetime('now', 'localtime') WHERE key_hash = ?")
    .run(hashManagedApiKey(key));
}

export function validateApiKey(key: string): { valid: boolean; apiKeyId?: number } {
  if (!key) return { valid: false };
  const row = db.prepare('SELECT id, enabled FROM api_keys WHERE key_hash = ?')
    .get(hashManagedApiKey(key)) as { id: number; enabled: number } | undefined;
  if (!row || !row.enabled) return { valid: false };
  return { valid: true, apiKeyId: row.id };
}

// ==================== 用户管理 ====================

export function isSetupComplete(): boolean {
  const result = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
  return result.count > 0;
}

export function createUser(username: string, password: string): void {
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hashPassword(password));
}

export function validateUser(username: string, password: string): number | null {
  const user = db.prepare('SELECT id, password_hash FROM users WHERE username = ?').get(username) as { id: number; password_hash: string } | undefined;
  if (user && user.password_hash === hashPassword(password)) {
    return user.id;
  }
  return null;
}

export function changePassword(userId: number, newPassword: string): void {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), userId);
}

// ==================== Session管理 ====================

export function createSession(userId: number): string {
  const sessionId = generateSessionId();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24小时
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(sessionId, userId, expiresAt);
  return sessionId;
}

export function validateSession(sessionId: string): number | null {
  const session = db.prepare('SELECT user_id, expires_at FROM sessions WHERE id = ?').get(sessionId) as { user_id: number; expires_at: string } | undefined;
  if (session && new Date(session.expires_at) > new Date()) {
    return session.user_id;
  }
  if (session) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }
  return null;
}

export function deleteSession(sessionId: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

// ==================== 统计管理 ====================

export function recordCall(key: string, model: string, creditsUsed: number = 0, remainingCredits: number = 0): void {
  console.log(`[DB] recordCall called: model=${model}, creditsUsed=${creditsUsed}, remainingCredits=${remainingCredits}`);
  const keyHash = hashKey(key);
  const preview = keyPreview(key);
  touchApiKey(key);
  
  try {
    const existing = db.prepare('SELECT id, call_count, credits_used FROM key_stats WHERE key_hash = ? AND model = ?').get(keyHash, model) as { id: number; call_count: number; credits_used: number } | undefined;
    
    if (existing) {
      db.prepare(`UPDATE key_stats SET call_count = ?, credits_used = ?, remaining_credits = ?, last_used = datetime('now', 'localtime') WHERE id = ?`)
        .run(existing.call_count + 1, existing.credits_used + creditsUsed, remainingCredits, existing.id);
      console.log(`[DB] Updated key_stats: id=${existing.id}, call_count=${existing.call_count + 1}, creditsUsed=${creditsUsed}`);
    } else {
      db.prepare('INSERT INTO key_stats (key_hash, key_preview, model, credits_used, remaining_credits) VALUES (?, ?, ?, ?, ?)')
        .run(keyHash, preview, model, creditsUsed, remainingCredits);
      console.log(`[DB] Inserted new key_stats: model=${model}, preview=${preview}, creditsUsed=${creditsUsed}`);
    }
  } catch (e) {
    console.error(`[DB] recordCall error:`, e);
  }
}

export function getStats() {
  // 按Key汇总（包含剩余积分）
  const keyStats = db.prepare(`
    SELECT key_preview, SUM(call_count) as total_calls, SUM(credits_used) as total_credits, 
           MAX(remaining_credits) as remaining_credits, MAX(last_used) as last_used
    FROM key_stats GROUP BY key_hash ORDER BY total_calls DESC
  `).all();
  
  // 按模型汇总
  const modelStats = db.prepare(`
    SELECT model, SUM(call_count) as total_calls, SUM(credits_used) as total_credits
    FROM key_stats GROUP BY model ORDER BY total_calls DESC
  `).all();
  
  // 总计
  const totals = db.prepare(`
    SELECT SUM(call_count) as total_calls, SUM(credits_used) as total_credits FROM key_stats
  `).get() as { total_calls: number; total_credits: number };
  
  return { keyStats, modelStats, totals };
}

// ==================== 媒体管理 ====================

export function saveMedia(type: 'image' | 'video', url: string, model: string, prompt: string, key: string): void {
  db.prepare('INSERT INTO media (type, url, model, prompt, key_preview) VALUES (?, ?, ?, ?, ?)')
    .run(type, url, model, prompt, keyPreview(key));
}

export function getMedia(page: number = 1, limit: number = 20, type?: string) {
  const offset = (page - 1) * limit;
  let query = 'SELECT * FROM media';
  let countQuery = 'SELECT COUNT(*) as total FROM media';
  const params: any[] = [];
  
  if (type) {
    query += ' WHERE type = ?';
    countQuery += ' WHERE type = ?';
    params.push(type);
  }
  
  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  
  const items = db.prepare(query).all(...params, limit, offset);
  const countResult = db.prepare(countQuery).get(...params) as { total: number };
  
  return {
    items,
    total: countResult.total,
    page,
    limit,
    totalPages: Math.ceil(countResult.total / limit)
  };
}

// ==================== 日志管理 ====================

const MAX_LOGS = 1000;

export function addLog(level: string, message: string): void {
  db.prepare('INSERT INTO logs (level, message) VALUES (?, ?)').run(level, message);
  
  // 清理旧日志
  db.prepare(`DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT ${MAX_LOGS})`).run();
}

export function getLogs(level?: string, limit: number = 100) {
  let query = 'SELECT * FROM logs';
  const params: any[] = [];
  
  if (level && level !== 'ALL') {
    query += ' WHERE level = ?';
    params.push(level);
  }
  
  query += ' ORDER BY id DESC LIMIT ?';
  params.push(limit);
  
  return db.prepare(query).all(...params);
}

export function clearLogs(): void {
  db.prepare('DELETE FROM logs').run();
}

export default {
  isSetupComplete,
  createUser,
  validateUser,
  changePassword,
  createSession,
  validateSession,
  deleteSession,
  createApiKey,
  listApiKeys,
  setApiKeyEnabled,
  deleteApiKey,
  validateApiKey,
  recordCall,
  getStats,
  saveMedia,
  getMedia,
  addLog,
  getLogs,
  clearLogs
};
