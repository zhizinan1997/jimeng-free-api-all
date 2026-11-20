import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import db from '@/lib/database.ts';
import accountPool, { PoolError, AccountPoolConfigurationError } from '@/lib/account-pool.ts';

/** Always emit direct JSON and an actual HTTP error, including service validation failures. */
async function admin(request: Request, action: (actor: string) => unknown) {
  const session = request.headers.cookie?.match(/(?:^|;\s*)session=([^;]+)/)?.[1];
  const userId = session ? db.validateSession(session) : null;
  if (!userId) return new Response({ error: '未登录' }, { statusCode: 401 });
  try { return new Response(await action(`admin:${userId}`), { statusCode: 200 }); }
  catch (error) {
    const status = error instanceof PoolError ? error.statusCode : error instanceof AccountPoolConfigurationError ? 503 : 500;
    // Never pass raw upstream/SQLite/encryption exception text to the browser.
    const message = error instanceof PoolError ? error.message : '账号操作失败，请检查输入、凭据和服务配置';
    return new Response({ error: message }, { statusCode: status });
  }
}
function id(request: Request) { if (!request.params?.id) throw new PoolError('缺少账号 id'); return String(request.params.id); }
function paging(request: Request) { return [Number(request.query?.limit ?? 50), Number(request.query?.offset ?? 0)] as const; }
export async function list(request: Request) { return admin(request, () => accountPool.list()); }
export async function get(request: Request) { return admin(request, () => accountPool.get(id(request))); }
export async function create(request: Request) { return admin(request, actor => accountPool.create(request.body || {}, actor)); }
export async function update(request: Request) { return admin(request, actor => accountPool.update(id(request), request.body || {}, actor)); }
export async function remove(request: Request) { return admin(request, actor => { accountPool.delete(id(request), actor); return { success: true }; }); }
export async function enable(request: Request) { return admin(request, actor => accountPool.setEnabled(id(request), request.body?.enabled, actor)); }
export async function refresh(request: Request) { return admin(request, actor => accountPool.refreshStatus(id(request), actor)); }
export async function select(request: Request) { return admin(request, () => ({ ...accountPool.select().account, selectionMode: 'preview', selectionNotice: '只读预览；提交时重新判定，不代表实际派发' })); }
export async function dashboard(request: Request) { return admin(request, () => accountPool.getDashboard()); }
export async function settings(request: Request) { return admin(request, actor => accountPool.updateSettings(request.body, actor)); }
export async function order(request: Request) { return admin(request, actor => accountPool.reorderAccounts(request.body, actor)); }
export async function tasks(request: Request) { return admin(request, () => accountPool.listTasks(...paging(request))); }
export async function events(request: Request) { return admin(request, () => accountPool.listEvents(...paging(request))); }
