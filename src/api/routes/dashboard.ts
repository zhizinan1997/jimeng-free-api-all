import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import db from '@/lib/database.ts';
import { getCredit } from '@/api/controllers/core.ts';

function sessionUser(request: Request): number | null {
  const sessionId = request.headers.cookie?.match(/(?:^|;\s*)session=([^;]+)/)?.[1];
  return sessionId ? db.validateSession(sessionId) : null;
}

function authError(request: Request): Response | null {
  return sessionUser(request) ? null : new Response({ error: '未登录' }, { statusCode: 401 });
}

function keyId(request: Request): number | null {
  const id = Number(request.params.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export default {
  prefix: '/dashboard',
  get: {
    '/status': async () => ({ setupComplete: db.isSetupComplete() }),
    '/stats': async (request: Request) => {
      const error = authError(request); if (error) return error;
      return db.getStats();
    },
    '/logs': async (request: Request) => {
      const error = authError(request); if (error) return error;
      return db.getLogs(request.query.level as string, parseInt(request.query.limit as string) || 100);
    },
    '/media': async (request: Request) => {
      const error = authError(request); if (error) return error;
      return db.getMedia(parseInt(request.query.page as string) || 1, parseInt(request.query.limit as string) || 20, request.query.type as string);
    },
    '/credits': async (request: Request) => {
      const error = authError(request); if (error) return error;
      const key = request.query.key as string;
      if (!key) return { error: '缺少Key参数' };
      try { return await getCredit(key); } catch (e) { return { error: '查询失败', message: e.message }; }
    },
    '/keys': async (request: Request) => {
      const error = authError(request); if (error) return error;
      return db.listApiKeys();
    }
  },
  post: {
    '/setup': async (request: Request) => {
      if (db.isSetupComplete()) return new Response({ error: '已完成初始化设置' }, { statusCode: 400 });
      const { username, password } = request.body;
      if (!username || !password) return new Response({ error: '用户名和密码不能为空' }, { statusCode: 400 });
      if (password.length < 6) return new Response({ error: '密码长度至少6位' }, { statusCode: 400 });
      db.createUser(username, password);
      return { success: true, message: '设置成功' };
    },
    '/login': async (request: Request) => {
      const { username, password } = request.body;
      const userId = db.validateUser(username, password);
      if (!userId) return new Response({ error: '用户名或密码错误' }, { statusCode: 401 });
      const sessionId = db.createSession(userId);
      return new Response({ success: true }, { statusCode: 200, headers: { 'Set-Cookie': `session=${sessionId}; Path=/; HttpOnly; Max-Age=86400` } });
    },
    '/logout': async (request: Request) => {
      const sessionId = request.headers.cookie?.match(/(?:^|;\s*)session=([^;]+)/)?.[1];
      if (sessionId) db.deleteSession(sessionId);
      return new Response({ success: true }, { statusCode: 200, headers: { 'Set-Cookie': 'session=; Path=/; HttpOnly; Max-Age=0' } });
    },
    '/password': async (request: Request) => {
      const userId = sessionUser(request);
      if (!userId) return new Response({ error: '未登录' }, { statusCode: 401 });
      const { newPassword } = request.body;
      if (!newPassword || newPassword.length < 6) return new Response({ error: '密码长度至少6位' }, { statusCode: 400 });
      db.changePassword(userId, newPassword);
      return { success: true, message: '密码修改成功' };
    },
    '/keys': async (request: Request) => {
      const error = authError(request); if (error) return error;
      const name = typeof request.body?.name === 'string' ? request.body.name : '';
      const created = db.createApiKey(name);
      return { success: true, key: created.key, apiKey: created.apiKey };
    },
    '/keys/:id/status': async (request: Request) => {
      const error = authError(request); if (error) return error;
      const id = keyId(request);
      if (!id || typeof request.body?.enabled !== 'boolean') return new Response({ error: '参数无效' }, { statusCode: 400 });
      const apiKey = db.setApiKeyEnabled(id, request.body.enabled);
      if (!apiKey) return new Response({ error: 'Key不存在' }, { statusCode: 404 });
      return { success: true, apiKey };
    }
  },
  delete: {
    '/logs': async (request: Request) => {
      const error = authError(request); if (error) return error;
      db.clearLogs();
      return { success: true, message: '日志已清理' };
    },
    '/keys/:id': async (request: Request) => {
      const error = authError(request); if (error) return error;
      const id = keyId(request);
      if (!id) return new Response({ error: '参数无效' }, { statusCode: 400 });
      if (!db.deleteApiKey(id)) return new Response({ error: 'Key不存在' }, { statusCode: 404 });
      return { success: true };
    }
  }
};
