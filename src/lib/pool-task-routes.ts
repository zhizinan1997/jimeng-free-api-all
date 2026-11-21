import Response from './response/Response.ts';
import { PoolTaskReplay } from '../api/controllers/auth.ts';
import { failPoolTask, hasRecoverableResult, requestIdentity, runWithPoolTask, type TaskContext, type TaskKind } from './pool-task-context.ts';

export function poolTaskErrorPayload(error: any, context?: TaskContext) {
  if (!context?.taskId) return null;
  const insufficient = error?.errcode === -2009;
  const invalidParams = error?.errcode === -2000;
  return {
    statusCode: insufficient ? 422 : invalidParams ? 400 : 502,
    body: {
      error: {
        message: insufficient ? (context.creditRetryMessage || '即梦积分不足以执行当前任务')
          : invalidParams ? (error?.errmsg || '请求参数无效')
          : '任务未完成；保留原任务归属，请查询状态，不要更换请求标识重提',
        code: insufficient ? 'insufficient_credits' : invalidParams ? 'invalid_request' : 'pool_task_incomplete',
        ...(insufficient && context.creditRetryCode ? { reason: context.creditRetryCode } : {}),
      },
      pool_task_id: context.taskId,
      request_id: context.requestId,
      state: context.state,
      upstream_task_id: context.upstreamTaskId || null,
    },
  };
}

function replayBody(error: PoolTaskReplay, context: TaskContext, requestPath?: string) {
  const saved = error.state === 'succeeded' && hasRecoverableResult(error.result) ? error.result : null;
  const payload: Record<string, any> = {
    pool_task_id: error.taskId,
    state: error.state,
    upstream_task_id: error.upstreamTaskId,
    reused: true,
    message: saved ? '已存在的请求未重新提交；返回已保存结果' : '已存在的请求未重新提交；使用原任务 ID 查询状态',
  };
  if (!saved) return payload;
  if (typeof saved.text === 'string') {
    payload.object = 'chat.completion';
    payload.model = saved.model || context.model;
    payload.answer = saved.text;
    payload.choices = [{ index: 0, message: { role: 'assistant', content: saved.text }, finish_reason: 'stop' }];
    return payload;
  }
  if (Array.isArray(saved.urls) && saved.urls.length > 0) {
    payload.data = saved.urls.map((url: string) => ({ url }));
    if (saved.kind === 'audio') {
      payload.audio_url = saved.urls[0];
      payload.url = saved.urls[0];
    }
    if (requestPath?.includes('/completions')) {
      const label = saved.kind === 'video' ? 'video' : 'image';
      payload.object = 'chat.completion';
      payload.model = context.model;
      payload.choices = [{
        index: 0,
        message: { role: 'assistant', content: saved.urls.map((url: string, index: number) => `![${saved.kind === 'video' ? 'video' : `${label}_${index}`}](${url})`).join('\n') },
        finish_reason: 'stop',
      }];
    }
    return payload;
  }
  if (saved.data) payload.data = saved.data;
  return payload;
}

/** One context per HTTP request; async streams inherit it without sharing leases. */
export function withPoolRoutes<T extends { post?: Record<string, (request: any) => Promise<any>>; get?: Record<string, (request: any) => Promise<any>> }>(routes: T, kind: TaskKind | ((request: any) => TaskKind), defaultModel: string): T {
  for (const [method, handlers] of Object.entries({ post: routes.post, get: routes.get })) {
    for (const [path, handler] of Object.entries(handlers || {})) {
      handlers[path] = async (request: any) => {
        const taskKind = path === '/uploads' ? 'upload' : typeof kind === 'function' ? kind(request) : kind;
        const context = await requestIdentity(request, taskKind, request.body?.model || defaultModel);
        // Raw material IDs require a caller-scoped persistent upload proof.
        (context as any).requestBody = request.body;
        return runWithPoolTask(context, async () => {
          try {
            const result = await handler(request);
            if (result instanceof Response && result.statusCode >= 400) await failPoolTask();
            if (context.taskId) {
              if (result instanceof Response) result.headers = { ...result.headers, 'X-Pool-Task-Id': context.taskId, 'X-Request-Id': context.requestId, ...(context.settlementPending ? { 'X-Pool-Settlement-Pending': 'true' } : {}) };
              else if (result && typeof result === 'object') return { ...result, pool_task_id: context.taskId, request_id: context.requestId, ...(context.settlementPending ? { settlement_pending: true } : {}) };
            }
            return result;
          } catch (error) {
            if (error instanceof PoolTaskReplay) return new Response(
              replayBody(error, context, request.path || path),
              { statusCode: error.state === 'failed' ? 409 : error.state === 'succeeded' ? 200 : 202 }
            );
            if (method === 'post') await failPoolTask();
            if (!context.taskId && Number.isInteger(error?.statusCode)) return new Response({ error: { message: error.message, code: 'pool_request_rejected' } }, { statusCode: error.statusCode });
            const sanitized = poolTaskErrorPayload(error, context);
            if (sanitized) return new Response(sanitized.body, { statusCode: sanitized.statusCode });
            throw error;
          }
        });
      };
    }
  }
  return routes;
}
