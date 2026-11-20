import { AsyncLocalStorage } from 'node:async_hooks';
import { selectGeneratedImageUrls } from './image-results.ts';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';

export type TaskKind = 'image' | 'video' | 'audio' | 'text' | 'upload';
export interface PoolTaskStore {
  transitionTask(id: string, change: { state: string; upstreamTaskId?: string; result?: unknown; error?: string }): void;
  settleTask(id: string): Promise<void>;
  readTask?(id: string, ownerHash: string): { state: string; upstreamTaskId?: string | null; requestedImageCount?: number | null; settling?: boolean };
  readTaskResult?(id: string, ownerHash: string): unknown;
}
export interface TaskContext {
  requestId: string; requestFingerprint: string; kind: TaskKind; model: string;
  ownerHash?: string; taskId?: string; credential?: string; sessionId?: string;
  requestedImageCount?: number | null;
  accountId?: string; settlementPending?: boolean; pool?: PoolTaskStore; state?: string; upstreamTaskId?: string;
  /** Proven asset identities; never populated from a client accountId. */
  assets?: Map<string, { durationMs: number }>;
}
const storage = new AsyncLocalStorage<TaskContext>();
export const ownerHash = (value: string) => createHash('sha256').update(value).digest('hex');
export const currentPoolTask = () => storage.getStore();
export const runWithPoolTask = <T>(context: TaskContext, run: () => T): T => storage.run(context, run);

export function hasRecoverableResult(stored: any): boolean {
  if (!stored || typeof stored !== 'object') return false;
  if (Array.isArray(stored.urls) && stored.urls.some((u: unknown) => typeof u === 'string' && u.trim().length > 0)) return true;
  if (typeof stored.text === 'string' && stored.text.length > 0) return true;
  if (typeof stored.vid === 'string' && stored.vid.length > 0) return true;
  if (Array.isArray(stored.data) && stored.data.some((item: any) =>
    (typeof item?.url === 'string' && item.url.trim().length > 0) ||
    (typeof item?.text === 'string' && item.text.length > 0)
  )) return true;
  return Boolean(stored.data && typeof stored.data === 'object' && typeof stored.data.vid === 'string' && stored.data.vid.length > 0);
}

export function findHistoryRecord(result: any, id: string): any {
  if (!result || typeof result !== 'object' || !id) return undefined;
  const keyed = result[id];
  if (keyed && typeof keyed === 'object') return keyed;
  const list = [
    ...(Array.isArray(result.history_list) ? result.history_list : []),
    ...(Array.isArray(result.history_records) ? result.history_records : []),
  ];
  return list.find((item: any) =>
    [item?.history_record_id, item?.task?.task_id, item?.submit_id, item?.task?.submit_id]
      .some(candidate => candidate !== undefined && candidate !== null && String(candidate) === id)
  );
}

export function extractVerifiedHistoryUrls(record: any, kind: TaskKind, requestedImageCount?: number | null): string[] {
  if (!record || typeof record !== 'object') return [];
  const status = Number(record.status);
  if (![21, 50].includes(status)) return [];
  const items = Array.isArray(record.item_list) ? record.item_list : [];
  if (kind === 'image') return selectGeneratedImageUrls(items, requestedImageCount);
  return items.map((item: any) =>
    kind === 'video' ? (item?.video?.transcoded_video?.origin?.video_url || item?.video?.play_url || item?.video?.download_url || item?.video?.url) :
    kind === 'audio' ? (
      item?.audio?.origin_audio?.audio_url ||
      item?.audio?.origin_audio?.url ||
      item?.common_attr?.file?.file_url ||
      item?.common_attr?.item_urls?.find((u: unknown) => typeof u === 'string' && u.trim().length > 0) ||
      item?.audio?.audio_url ||
      item?.audio?.url
    ) :
    undefined
  )
    .filter((url: unknown): url is string => typeof url === 'string' && url.trim().length > 0)
    .map((url: string) => url.trim());
}

function syncStateFromStore(context: TaskContext): string | undefined {
  if (!context.taskId || !context.ownerHash || !context.pool?.readTask) return context.state;
  try {
    const stored = context.pool.readTask(context.taskId, context.ownerHash);
    if (stored?.state) context.state = stored.state;
    if (stored?.requestedImageCount != null) context.requestedImageCount = stored.requestedImageCount;
    if (stored?.upstreamTaskId && !context.upstreamTaskId) context.upstreamTaskId = stored.upstreamTaskId;
  } catch { /* ignore when using minimal store fixture */ }
  return context.state;
}

function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
/** Fingerprints are private digests, including file bytes rather than ephemeral multipart paths. */
export async function requestIdentity(request: any, kind: TaskKind, model: string): Promise<TaskContext> {
  const supplied = request.headers?.['idempotency-key'] ?? request.headers?.['x-request-id'];
  if (supplied !== undefined && (typeof supplied !== 'string' || !supplied.trim() || supplied.length > 200)) throw new Error('请求幂等标识必须是 1 至 200 字符');
  const files: any[] = [];
  async function append(value: any, field: string) {
    if (Array.isArray(value)) { for (const item of value) await append(item, field); return; }
    const file = value?.filepath || value?.path;
    if (file) {
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(file)) digest.update(chunk);
      files.push({ field, hash: digest.digest('hex') });
    }
  }
  for (const key of Object.keys(request.files || {}).sort()) await append(request.files[key], key);
  return { requestId: supplied?.trim() || randomUUID(), kind, model,
    requestFingerprint: ownerHash(JSON.stringify(canonical({ path: request.path, body: request.body, files }))) };
}

export function beginPoolSubmission(submitId?: string) {
  const context = currentPoolTask();
  if (!context?.taskId) return;
  if (context.state !== 'reserved') throw new Error('任务已经提交或待确认，禁止重复生成');
  // Local submit UUID is recorded for diagnosis only: it is not proof of acceptance.
  context.pool!.transitionTask(context.taskId, { state: 'submitting', result: submitId ? { submitId } : undefined });
  context.state = 'submitting';
}
export function acceptPoolSubmission(upstreamTaskId?: string) {
  const context = currentPoolTask();
  if (!context?.taskId) return;
  if (!upstreamTaskId) throw new Error('上游提交未返回任务 ID，保留待确认，禁止重复提交');
  context.pool!.transitionTask(context.taskId, { state: 'submitted', upstreamTaskId });
  context.state = 'submitted'; context.upstreamTaskId = upstreamTaskId;
}
export async function finishPoolTask(state: 'succeeded' | 'failed', error?: string, result?: unknown) {
  const context = currentPoolTask();
  if (!context?.taskId) return;
  if (state === 'succeeded' && result !== undefined && ['image', 'video', 'audio'].includes(context.kind) && !hasRecoverableResult(result)) {
    throw new Error('成功媒体任务必须包含已验证结果 URL');
  }
  const latest = syncStateFromStore(context);
  if (!['succeeded', 'failed'].includes(latest || '')) {
    try {
      context.pool!.transitionTask(context.taskId, { state, error, ...(result !== undefined ? { result } : {}) });
      context.state = state;
    } catch (err: any) {
      const synced = syncStateFromStore(context);
      if (!['succeeded', 'failed'].includes(synced || '')) throw err;
    }
  } else if (latest === 'succeeded' && state === 'succeeded' && result !== undefined) {
    let existing: unknown;
    try {
      existing = context.ownerHash && context.pool?.readTaskResult ? context.pool.readTaskResult(context.taskId, context.ownerHash) : undefined;
    } catch { existing = undefined; }
    if (!hasRecoverableResult(existing)) {
      try { context.pool!.transitionTask(context.taskId, { state: 'succeeded', result }); } catch {}
    }
  }
  try {
    await context.pool!.settleTask(context.taskId);
    context.settlementPending = false;
  } catch {
    // A retains its held slot and audits the failure. Deliver the actual result,
    // explicitly indicating that balance reconciliation still needs retry.
    context.settlementPending = true;
  }
}
export async function failPoolTask() {
  const context = currentPoolTask();
  if (!context?.taskId) return;
  const latest = syncStateFromStore(context);
  if (['succeeded', 'failed', 'unknown'].includes(latest || '')) return;
  if (latest === 'reserved') return finishPoolTask('failed', '提交前失败');
  // Do not copy arbitrary upstream errors (which may contain credentials or prompts).
  try {
    context.pool!.transitionTask(context.taskId, { state: 'unknown', error: '提交或查询中断，需原账号确认，未重新提交' });
    context.state = 'unknown';
  } catch (err: any) {
    const synced = syncStateFromStore(context);
    if (!['succeeded', 'failed', 'unknown'].includes(synced || '')) throw err;
  }
}
export function poolCookie(token: string, explicit?: string) {
  const context = currentPoolTask();
  return explicit || (context?.sessionId === token ? context.credential : undefined);
}

/** Only the existing history endpoint is a supported media recovery mechanism. */
export async function observePoolHistory(result: any, ids: string[] = []) {
  const context = currentPoolTask();
  if (!context?.taskId || !context.upstreamTaskId || !ids.map(String).includes(context.upstreamTaskId)) return;
  const record = findHistoryRecord(result, context.upstreamTaskId);
  if (!record || typeof record !== 'object' || record.status === undefined || record.status === null) return;
  const status = Number(record.status);
  if (!Number.isFinite(status)) return;
  const latest = syncStateFromStore(context);
  if (status === 30) {
    if (latest === 'succeeded') return;
    await finishPoolTask('failed', '上游任务失败');
  } else if ([21, 50].includes(status)) {
    const urls = extractVerifiedHistoryUrls(record, context.kind, context.requestedImageCount);
    if (urls.length === 0) return;
    const storedResult = { kind: context.kind, urls, data: urls.map(url => ({ url })) };
    await finishPoolTask('succeeded', undefined, storedResult);
  } else if ([20, 42, 45].includes(status) && !['running', 'succeeded', 'failed'].includes(latest || '')) {
    try {
      context.pool!.transitionTask(context.taskId, { state: 'running' });
      context.state = 'running';
    } catch (err: any) {
      const synced = syncStateFromStore(context);
      if (!['running', 'succeeded', 'failed'].includes(synced || '')) throw err;
    }
  }
}
