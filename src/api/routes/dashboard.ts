import _ from 'lodash';
import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import db from '@/lib/database.ts';
import { getCredit } from '@/api/controllers/core.ts';

export default {
  prefix: '/dashboard',

  get: {
    // 检查是否需要初始化设置
    '/status': async (request: Request) => {
      return {
        setupComplete: db.isSetupComplete()
      };
    },

    // 获取统计数据
    '/stats': async (request: Request) => {
      const sessionId = request.headers.cookie?.match(/session=([^;]+)/)?.[1];
      if (!sessionId || !db.validateSession(sessionId)) {
        return new Response({ error: '未登录' }, { statusCode: 401 });
      }
      return db.getStats();
    },

    // 获取日志
    '/logs': async (request: Request) => {
      const sessionId = request.headers.cookie?.match(/session=([^;]+)/)?.[1];
      if (!sessionId || !db.validateSession(sessionId)) {
        return new Response({ error: '未登录' }, { statusCode: 401 });
      }
      const level = request.query.level as string;
      const limit = parseInt(request.query.limit as string) || 100;
      return db.getLogs(level, limit);
    },

    // 获取媒体列表（分页）
    '/media': async (request: Request) => {
      const sessionId = request.headers.cookie?.match(/session=([^;]+)/)?.[1];
      if (!sessionId || !db.validateSession(sessionId)) {
        return new Response({ error: '未登录' }, { statusCode: 401 });
      }
      const page = parseInt(request.query.page as string) || 1;
      const limit = parseInt(request.query.limit as string) || 20;
      const type = request.query.type as string;
      return db.getMedia(page, limit, type);
    },

    // 获取指定Key的积分
    '/credits': async (request: Request) => {
      const sessionId = request.headers.cookie?.match(/session=([^;]+)/)?.[1];
      if (!sessionId || !db.validateSession(sessionId)) {
        return new Response({ error: '未登录' }, { statusCode: 401 });
      }
      const key = request.query.key as string;
      if (!key) {
        return { error: '缺少Key参数' };
      }
      try {
        const credits = await getCredit(key);
        return credits;
      } catch (e) {
        return { error: '查询失败', message: e.message };
      }
    }
  },

  post: {
    // 初始化设置账号密码
    '/setup': async (request: Request) => {
      if (db.isSetupComplete()) {
        return new Response({ error: '已完成初始化设置' }, { statusCode: 400 });
      }
      const { username, password } = request.body;
      if (!username || !password) {
        return new Response({ error: '用户名和密码不能为空' }, { statusCode: 400 });
      }
      if (password.length < 6) {
        return new Response({ error: '密码长度至少6位' }, { statusCode: 400 });
      }
      db.createUser(username, password);
      return { success: true, message: '设置成功' };
    },

    // 登录
    '/login': async (request: Request) => {
      const { username, password } = request.body;
      const userId = db.validateUser(username, password);
      if (!userId) {
        return new Response({ error: '用户名或密码错误' }, { statusCode: 401 });
      }
      const sessionId = db.createSession(userId);
      return new Response(
        { success: true },
        { 
          statusCode: 200,
          headers: { 'Set-Cookie': `session=${sessionId}; Path=/; HttpOnly; Max-Age=86400` }
        }
      );
    },

    // 登出
    '/logout': async (request: Request) => {
      const sessionId = request.headers.cookie?.match(/session=([^;]+)/)?.[1];
      if (sessionId) {
        db.deleteSession(sessionId);
      }
      return new Response(
        { success: true },
        { 
          statusCode: 200,
          headers: { 'Set-Cookie': 'session=; Path=/; HttpOnly; Max-Age=0' }
        }
      );
    },

    // 修改密码
    '/password': async (request: Request) => {
      const sessionId = request.headers.cookie?.match(/session=([^;]+)/)?.[1];
      const userId = sessionId ? db.validateSession(sessionId) : null;
      if (!userId) {
        return new Response({ error: '未登录' }, { statusCode: 401 });
      }
      const { newPassword } = request.body;
      if (!newPassword || newPassword.length < 6) {
        return new Response({ error: '密码长度至少6位' }, { statusCode: 400 });
      }
      db.changePassword(userId, newPassword);
      return { success: true, message: '密码修改成功' };
    }
  },

  delete: {
    // 清理日志
    '/logs': async (request: Request) => {
      const sessionId = request.headers.cookie?.match(/session=([^;]+)/)?.[1];
      if (!sessionId || !db.validateSession(sessionId)) {
        return new Response({ error: '未登录' }, { statusCode: 401 });
      }
      db.clearLogs();
      return { success: true, message: '日志已清理' };
    }
  }
};
