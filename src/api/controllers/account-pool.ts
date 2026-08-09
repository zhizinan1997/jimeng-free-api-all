import Request from "@/lib/request/Request.ts";
import Response from "@/lib/response/Response.ts";
import db from "@/lib/database.ts";
import accountPool, { type AccountSelectionStrategy } from "@/lib/account-pool.ts";

function requireAdmin(request: Request): Response | null {
  const sessionId = request.headers.cookie?.match(/(?:^|;\s*)session=([^;]+)/)?.[1];
  if (!sessionId || !db.validateSession(sessionId)) return new Response({ error: "未登录" }, { statusCode: 401 });
  return null;
}

function id(request: Request): string {
  return String(request.params.id);
}

function accountIdOrResponse(request: Request): string | Response {
  if (!request.params?.id) return new Response({ error: "缺少账号 id" }, { statusCode: 400 });
  return id(request);
}

export async function list(request: Request) { const denied = requireAdmin(request); return denied || accountPool.list(); }
export async function get(request: Request) { const denied = requireAdmin(request); const accountId = accountIdOrResponse(request); return denied || (accountId instanceof Response ? accountId : accountPool.get(accountId)); }
export async function create(request: Request) { const denied = requireAdmin(request); return denied || accountPool.create(request.body || {}); }
export async function update(request: Request) { const denied = requireAdmin(request); const accountId = accountIdOrResponse(request); return denied || (accountId instanceof Response ? accountId : accountPool.update(accountId, request.body || {})); }
export async function remove(request: Request) { const denied = requireAdmin(request); const accountId = accountIdOrResponse(request); if (denied) return denied; if (accountId instanceof Response) return accountId; accountPool.delete(accountId); return { success: true }; }
export async function enable(request: Request) { const denied = requireAdmin(request); const accountId = accountIdOrResponse(request); return denied || (accountId instanceof Response ? accountId : accountPool.setEnabled(accountId, Boolean(request.body?.enabled))); }
export async function refresh(request: Request) { const denied = requireAdmin(request); const accountId = accountIdOrResponse(request); return denied || (accountId instanceof Response ? accountId : accountPool.refreshStatus(accountId)); }
export async function select(request: Request) { const denied = requireAdmin(request); return denied || accountPool.select((request.query.strategy || "least_failures") as AccountSelectionStrategy).account; }
