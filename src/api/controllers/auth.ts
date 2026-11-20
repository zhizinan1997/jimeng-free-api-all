import _ from "lodash";
import { DEFAULT_IMAGE_COUNT } from "../../lib/image-results.ts";
import { parseCookiePairs } from "../../lib/jimeng-cookie.ts";

import { tokenSplit } from "@/api/controllers/core.ts";
import accountPool, { readTaskAccount } from "@/lib/account-pool.ts";
import { currentPoolTask, ownerHash } from "../../lib/pool-task-context.ts";
import { proveUploadAssets } from "../../lib/pool-task-assets.ts";
import db, { touchApiKey } from "@/lib/database.ts";

export interface ResolvedCredential {
  token: string;
  accountId?: string;
  managedKey?: string;
  /** 原始账号凭据；账号池 Cookie 需要完整传给浏览器传输层。 */
  cookie?: string;
  poolTaskId?: string;
  upstreamTaskId?: string;
  ownerHash?: string;
}

/** Resolve either a native Jimeng session token or a dashboard-managed API key. */
export function isManagedApiKey(value: string): boolean {
  return /^jm_[A-Za-z0-9_-]{20,}$/.test(value);
}

export async function resolveAuthorization(authorization: string, imageCount = DEFAULT_IMAGE_COUNT): Promise<ResolvedCredential> {
  const tokens = tokenSplit(authorization);
  if (tokens.length === 0) throw new Error("Authorization token is empty");

  const managedKey = tokens.find((token) => db.validateApiKey(token).valid);
  const looksLikeManagedKey = tokens.find(isManagedApiKey);
  if (managedKey) {
    const context = currentPoolTask();
    const pool = accountPool;
    if (context) {
      const proof = proveUploadAssets(context, [managedKey], key => db.validateApiKey(key).valid, readTaskAccount);
      const owner = ownerHash(managedKey);
      const lease = await pool.acquireTask({ requestId: context.requestId, ownerHash: owner,
        requestFingerprint: context.requestFingerprint, kind: context.kind, model: context.model,
        ...(context.kind === "image" ? { requestedImageCount: imageCount } : {}),
        estimatedCredits: null, ...(proof ? { preferredAccountId: proof } : {}) });
      if (lease.reused) {
        let storedResult: unknown = null;
        if (lease.state === 'succeeded') {
          try { storedResult = pool.readTaskResult(lease.taskId, owner); } catch { storedResult = null; }
        }
        throw new PoolTaskReplay(lease.taskId, lease.state, lease.upstreamTaskId, storedResult);
      }
      Object.assign(context, { ownerHash: owner, taskId: lease.taskId, pool, state: lease.state,
        requestedImageCount: context.kind === "image" ? imageCount : undefined,
        credential: lease.credential, sessionId: lease.sessionId, accountId: lease.account.id });
      touchApiKey(managedKey);
      return { token: lease.sessionId, accountId: lease.account.id, managedKey,
        cookie: lease.credential, poolTaskId: lease.taskId, ownerHash: owner };
    }
    // Read-only callers do not acquire a task or update lastUsedAt. Inspect the
    // fixed account even if it cannot accept new work, so its failure is visible.
    const dashboard = pool.getDashboard();
    const id = dashboard.settings.mode === 'fixed' ? dashboard.settings.fixedAccountId
      : dashboard.summary.nextAccountId || dashboard.accounts.find((a: any) => a.enabled)?.id;
    if (!id) throw new Error('没有可查询的即梦账号');
    const selected = readTaskAccount(id);
    return { token: selected.sessionId, accountId: selected.account.id, managedKey, cookie: selected.credential };
  }

  if (looksLikeManagedKey) {
    throw Object.assign(new Error("API key is invalid or disabled"), { statusCode: 401 });
  }

  const native = _.sample(tokens) as string;
  if (native.includes('=')) {
    const pairs = new Map(parseCookiePairs(native));
    const session = pairs.get('sessionid') || pairs.get('sessionid_ss') || pairs.get('sid_tt');
    if (!session) throw new Error('Cookie 缺少 sessionid');
    const context = currentPoolTask();
    if (context) Object.assign(context, { sessionId: session, credential: native });
    return { token: session, cookie: native };
  }
  return { token: native };
}

export function markCredentialSuccess(credential: ResolvedCredential): void {
  if (credential.accountId) accountPool.markSuccess(credential.accountId);
}

export function markCredentialFailure(credential: ResolvedCredential, cooldownMs?: number): void {
  if (credential.accountId && currentPoolTask()?.state !== "reserved") accountPool.markFailure(credential.accountId, cooldownMs);
}

export class PoolTaskReplay extends Error {
  constructor(public taskId: string, public state: string, public upstreamTaskId: string | null, public result: any = null) {
    super('请求标识已经存在，返回原任务，不重复生成');
  }
}

/** Recover an existing task, validating the calling key before decrypting its account. */
export function resolvePoolTaskCredential(taskId: string, authorization: string): ResolvedCredential {
  const key = tokenSplit(authorization).find(token => db.validateApiKey(token).valid);
  if (!key) throw Object.assign(new Error('API key is invalid or disabled'), { statusCode: 401 });
  const hash = ownerHash(key);
  const pool = accountPool;
  const task = pool.readTask(taskId, hash);
  const selected = pool.readTaskCredential(taskId, hash);
  const context = currentPoolTask();
  if (context) Object.assign(context, { taskId, ownerHash: hash, pool, state: task.state,
    kind: task.kind, model: task.model, upstreamTaskId: task.upstreamTaskId, requestedImageCount: task.requestedImageCount,
    credential: selected.credential, sessionId: selected.sessionId, accountId: selected.account.id });
  return { token: selected.sessionId, cookie: selected.credential, accountId: selected.account.id,
    managedKey: key, ownerHash: hash, poolTaskId: taskId, upstreamTaskId: task.upstreamTaskId };
}
