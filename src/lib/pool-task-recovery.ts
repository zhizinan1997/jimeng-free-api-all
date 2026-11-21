import accountPool from './account-pool.ts';
import { resolvePoolTaskCredential } from '../api/controllers/auth.ts';
import { request as upstreamRequest } from '../api/controllers/core.ts';
import {
  currentPoolTask,
  extractVerifiedHistoryUrls,
  findHistoryRecord,
  hasRecoverableResult,
  observePoolHistory,
  runWithPoolTask,
  type PoolTaskStore,
  type TaskContext,
  type TaskKind,
} from './pool-task-context.ts';

const RECOVERABLE_MEDIA_KINDS = new Set<TaskKind>(['image', 'video', 'audio']);
const TEXT_ANSWER_NOT_SAVED = {
  recoverable: false,
  recovery_code: 'text_answer_not_saved',
  message: '已记录原文本会话 ID，尚未保存完整答案。原账号暂无经过验证的重连查询接口，请保留原任务 ID，勿重新提交。',
} as const;

async function queryUpstreamHistory(upstreamTaskId: string, token: string, cookie?: string) {
  const isSubmitUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(upstreamTaskId);
  return upstreamRequest('POST', '/mweb/v1/get_history_by_ids', token, {
    cookie,
    data: isSubmitUuid ? { submit_ids: [upstreamTaskId] } : { history_ids: [upstreamTaskId] },
    maxRetries: 1,
  });
}

function storedResultPayload(task: any, stored: any) {
  if (!hasRecoverableResult(stored)) return null;
  if (typeof stored.text === 'string') {
    return {
      task,
      recoverable: true,
      data: [{ text: stored.text, ...(stored.model ? { model: stored.model } : {}) }],
      answer: stored.text,
      result: stored,
    };
  }
  if (stored.kind === 'upload' || typeof stored.vid === 'string') {
    return {
      task,
      recoverable: true,
      data: stored.data || { vid: stored.vid, duration_ms: stored.duration_ms },
      result: stored,
    };
  }
  if (Array.isArray(stored.urls) && stored.urls.length > 0) {
    return {
      task,
      recoverable: true,
      data: stored.urls.map((url: string) => ({ url })),
      result: stored,
    };
  }
  return null;
}

async function settleBestEffort(pool: Pick<PoolTaskStore, 'settleTask'>, taskId: string, shouldSettle?: boolean) {
  if (!shouldSettle) return;
  try { await pool.settleTask(taskId); } catch {}
}

/** Reconcile final stored/terminal state after an async query so late upstream snapshots never override committed results. */
async function resolveTerminalPayload(
  pool: Pick<PoolTaskStore, 'settleTask' | 'readTask' | 'readTaskResult'>,
  id: string,
  owner: string,
  fallbackUrls: string[],
  kind: TaskKind,
  settleIfPending: boolean
) {
  const latest = pool.readTask!(id, owner);
  if (latest.state === 'failed') {
    if (settleIfPending && latest.settling) await settleBestEffort(pool, id, true);
    const refreshed = pool.readTask!(id, owner);
    return {
      task: refreshed,
      recoverable: false,
      data: [],
      message: (refreshed as any).error || '上游任务失败，未重新提交',
    };
  }
  if (latest.state === 'succeeded') {
    if (settleIfPending && latest.settling) await settleBestEffort(pool, id, true);
    const refreshed = pool.readTask!(id, owner);
    let stored: unknown = null;
    try { stored = pool.readTaskResult?.(id, owner); } catch { stored = null; }
    const saved = storedResultPayload(refreshed, stored);
    if (saved) return saved;
    if (fallbackUrls.length > 0) {
      return {
        task: refreshed,
        recoverable: true,
        data: fallbackUrls.map((url: string) => ({ url })),
        result: { kind, urls: fallbackUrls },
      };
    }
    return {
      task: refreshed,
      recoverable: false,
      data: [],
      message: '任务已完成但未保存可恢复结果，且无可重连查询接口',
    };
  }
  return null;
}

/** Query only persisted history IDs, never resubmit a job to simulate recovery. */
export async function recoverPoolTask(
  request: any,
  expectedKind?: string,
  deps?: {
    pool?: typeof accountPool;
    queryHistory?: (upstreamTaskId: string, token: string, cookie?: string) => Promise<any>;
  }
) {
  const id = request.params.taskId;
  const credential = resolvePoolTaskCredential(id, request.headers.authorization || request.headers['x-api-key'] || '');
  const context = currentPoolTask()!;
  if (expectedKind && context.kind !== expectedKind) throw new Error('任务类型与查询入口不匹配');
  const pool = deps?.pool || accountPool;
  const owner = credential.ownerHash!;
  const summary = () => pool.readTask(id, owner);
  const initial = summary();
  if (initial.state === 'failed') {
    return (await resolveTerminalPayload(pool, id, owner, [], context.kind, true))!;
  }
  if (initial.state === 'succeeded') {
    const terminal = await resolveTerminalPayload(pool, id, owner, [], context.kind, true);
    if (terminal && (terminal.recoverable || !credential.upstreamTaskId || !RECOVERABLE_MEDIA_KINDS.has(context.kind))) {
      return terminal;
    }
  }
  if (!credential.upstreamTaskId || !RECOVERABLE_MEDIA_KINDS.has(context.kind)) {
    if (context.kind === 'text' && credential.upstreamTaskId) return { task: initial, data: [], ...TEXT_ANSWER_NOT_SAVED };
    return { task: summary(), recoverable: false,
      message: !credential.upstreamTaskId ? '未获得上游任务 ID，无法自动查询；保留原绑定，未重新提交'
        : '此类型暂无经过验证的重连查询接口，未尝试重新生成' };
  }
  const history = deps?.queryHistory
    ? await deps.queryHistory(credential.upstreamTaskId, credential.token, credential.cookie)
    : await queryUpstreamHistory(credential.upstreamTaskId, credential.token, credential.cookie);
  if (deps?.queryHistory) await observePoolHistory(history, [credential.upstreamTaskId]);
  const record = findHistoryRecord(history, credential.upstreamTaskId);
  const urls = extractVerifiedHistoryUrls(record, context.kind, context.requestedImageCount);
  const terminal = await resolveTerminalPayload(pool, id, owner, urls, context.kind, true);
  if (terminal) return terminal;
  return {
    task: summary(),
    recoverable: urls.length > 0,
    data: urls.map((url: string) => ({ url })),
    ...(urls.length > 0 ? { result: { kind: context.kind, urls } } : {}),
  };
}

export interface StoredRecoveryStore extends PoolTaskStore {
  readTaskForRecovery(id: string): {
    task: {
      id: string;
      kind: TaskKind;
      requestedImageCount?: number | null;
      model: string;
      state: string;
      upstreamTaskId: string | null;
      settling?: boolean;
      error?: string | null;
    };
    ownerHash: string;
    selection: { account: { id: string }; credential: string; sessionId: string };
  };
  readTask(id: string, ownerHash: string): any;
  readTaskResult(id: string, ownerHash: string): unknown;
}

/** Reconcile a persisted pool task under its original account context without resubmitting. */
export async function recoverStoredPoolTask(
  id: string,
  deps?: {
    pool?: StoredRecoveryStore;
    queryHistory?: (upstreamTaskId: string, token: string, cookie?: string) => Promise<any>;
  }
) {
  const pool: StoredRecoveryStore = deps?.pool || accountPool;
  const recovery = pool.readTaskForRecovery(id);
  const { task, ownerHash, selection } = recovery;
  const summary = () => pool.readTask(id, ownerHash);

  if (task.state === 'succeeded' || task.state === 'failed') {
    await pool.settleTask(task.id);
    const terminal = await resolveTerminalPayload(pool, id, ownerHash, [], task.kind, false);
    if (terminal) return terminal;
    return { task: summary(), recoverable: false, data: [] };
  }

  if (!task.upstreamTaskId || !RECOVERABLE_MEDIA_KINDS.has(task.kind)) {
    if (task.kind === 'text' && task.upstreamTaskId) return { task, data: [], ...TEXT_ANSWER_NOT_SAVED };
    return {
      task,
      recoverable: false,
      data: [],
      message: !task.upstreamTaskId
        ? '未获得上游任务 ID，保留原状态，未重新提交'
        : '此类型暂无经过验证的重连查询接口，保留原状态',
    };
  }

  const context: TaskContext = {
    requestId: `maintenance-${task.id}`,
    requestFingerprint: `maintenance-${task.id}`,
    kind: task.kind,
    requestedImageCount: task.requestedImageCount,
    model: task.model,
    ownerHash,
    taskId: task.id,
    pool,
    state: task.state,
    upstreamTaskId: task.upstreamTaskId,
    credential: selection.credential,
    sessionId: selection.sessionId,
    accountId: selection.account.id,
  };

  return runWithPoolTask(context, async () => {
    const before = await resolveTerminalPayload(pool, id, ownerHash, [], task.kind, true);
    if (before) return before;
    const history = deps?.queryHistory
      ? await deps.queryHistory(task.upstreamTaskId!, selection.sessionId, selection.credential)
      : await queryUpstreamHistory(task.upstreamTaskId!, selection.sessionId, selection.credential);
    // Injected queryHistory bypasses core.ts; run observePoolHistory identically in both paths.
    if (deps?.queryHistory) await observePoolHistory(history, [task.upstreamTaskId!]);
    const record = findHistoryRecord(history, task.upstreamTaskId!);
    const urls = extractVerifiedHistoryUrls(record, task.kind, context.requestedImageCount);
    const after = await resolveTerminalPayload(pool, id, ownerHash, urls, task.kind, true);
    if (after) return after;
    return {
      task: summary(),
      recoverable: urls.length > 0,
      data: urls.map((url: string) => ({ url })),
      ...(urls.length > 0 ? { result: { kind: task.kind, urls } } : {}),
    };
  });
}
