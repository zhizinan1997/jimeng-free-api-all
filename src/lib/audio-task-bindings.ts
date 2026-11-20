import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { parseCookiePairs } from './jimeng-cookie.ts';

type Credential = { token: string; managedKey?: string; accountId?: string; cookie?: string; poolTaskId?: string; durationMs?: number };
type Binding = { owner_hash: string; account_id: string | null; credential_hash: string; expires_at: number; pool_task_id?: string; duration_ms?: number };
const bindingError = (message: string, statusCode = 403) => Object.assign(new Error(message), { statusCode });
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

/** Stores identities only: cookies remain in the encrypted account pool. */
export class AudioTaskBindings {
  private db: Database.Database;
  constructor(file: string) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS audio_task_bindings (
      task_id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL, account_id TEXT,
      credential_hash TEXT NOT NULL, expires_at INTEGER NOT NULL
    )`);
    this.migrate();
  }
  private migrate() {
    const columns = this.db.prepare('PRAGMA table_info(audio_task_bindings)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'pool_task_id')) this.db.exec('ALTER TABLE audio_task_bindings ADD COLUMN pool_task_id TEXT');
    if (!columns.some(column => column.name === 'duration_ms')) this.db.exec('ALTER TABLE audio_task_bindings ADD COLUMN duration_ms INTEGER');
  }
  remember(ids: Array<string | undefined | null>, credential: Credential) {
    if (!credential.token || (credential.managedKey && !credential.accountId)) throw bindingError('音频任务缺少账号绑定');
    const expires = Date.now() + 24 * 60 * 60 * 1000;
    const owner = hash(credential.managedKey || credential.cookie || credential.token);
    const fingerprint = hash(credential.cookie || credential.token);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM audio_task_bindings WHERE expires_at <= ?').run(Date.now());
      for (const id of ids) {
        if (!id?.trim()) continue;
        const old = this.db.prepare('SELECT * FROM audio_task_bindings WHERE task_id = ?').get(id.trim()) as Binding | undefined;
        if (old && (old.owner_hash !== owner || old.account_id !== (credential.accountId || null) || old.credential_hash !== fingerprint)) throw bindingError('音频任务绑定冲突');
        this.db.prepare('INSERT OR REPLACE INTO audio_task_bindings (task_id, owner_hash, account_id, credential_hash, expires_at, pool_task_id, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id.trim(), owner, credential.accountId || null, fingerprint, expires, credential.poolTaskId || null, credential.durationMs || null);
      }
    })();
  }
  resolve(taskId: string, tokens: string[], validateKey: (key: string) => boolean, readAccount: (id: string) => { sessionId: string; credential: string }): Credential {
    if (!tokens.length) throw bindingError('缺少 Authorization 鉴权头', 401);
    const hasValidManagedKey = tokens.some(validateKey);
    if (!hasValidManagedKey && tokens.some(token => /^jm_[A-Za-z0-9_-]{20,}$/.test(token))) {
      throw bindingError('API key is invalid or disabled', 401);
    }
    const binding = this.db.prepare('SELECT * FROM audio_task_bindings WHERE task_id = ? AND expires_at > ?').get(taskId.trim(), Date.now()) as Binding | undefined;
    if (!binding) throw bindingError('音频任务绑定不存在或已过期，不能切换账号查询');
    if (binding.account_id && !hasValidManagedKey) {
      throw bindingError('API key is invalid or disabled', 401);
    }
    const owner = tokens.find(token => hash(token) === binding.owner_hash);
    if (!owner) throw bindingError('无权查询该音频任务');
    const extras = { ...(binding.pool_task_id ? { poolTaskId: binding.pool_task_id } : {}), ...(binding.duration_ms ? { durationMs: binding.duration_ms } : {}) };
    if (!binding.account_id) {
      if (owner.includes('=')) {
        const pairs = new Map(parseCookiePairs(owner));
        const session = pairs.get('sessionid') || pairs.get('sessionid_ss') || pairs.get('sid_tt');
        if (!session) throw bindingError('原生 Cookie 缺少 sessionid');
        return { token: session, cookie: owner, ...extras };
      }
      return { token: owner, ...extras };
    }
    if (!validateKey(owner)) throw bindingError('API key is invalid or disabled', 401);
    const account = readAccount(binding.account_id);
    if (hash(account.credential) !== binding.credential_hash) throw bindingError('音频任务原账号凭据已变更，不能切换账号查询');
    return { token: account.sessionId, cookie: account.credential, accountId: binding.account_id, managedKey: owner, ...extras };
  }
  close() { this.db.close(); }
}
