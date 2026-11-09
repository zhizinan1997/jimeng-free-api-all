import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, createHash } from 'node:crypto';
import { startUsage, finishUsage, validateApiKey, recordCall } from './database.ts';

type UsageContext = {
  id: string; started: number; managedKey: string; model: string;
  token?: string; accountHash?: string;
  before?: number | null; overlap: boolean; succeeded: boolean;
  images: number; videos: number; settled: boolean;
};

// Injectable balance reader allows testing without contacting Jimeng or spending credits.
export function createUsageTracker(readBalance: (token: string) => Promise<number>) {
  const storage = new AsyncLocalStorage<UsageContext>();
  const active = new Map<string, Set<UsageContext>>();

  async function balance(token: string): Promise<number | null> {
    let timer: ReturnType<typeof setTimeout>;
    try {
      const result = await Promise.race([
        readBalance(token),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 5000); }),
      ]);
      return typeof result === 'number' && Number.isFinite(result) && result >= 0 ? result : null;
    } catch { return null; }
    finally { clearTimeout(timer!); }
  }

  async function attach(token: string) {
    const ctx = storage.getStore();
    if (!ctx || ctx.token) return;
    ctx.token = token;
    ctx.accountHash = createHash('sha256').update(token).digest('hex');
    const others = active.get(ctx.accountHash) || new Set<UsageContext>();
    if (others.size) {
      ctx.overlap = true;
      for (const other of others) other.overlap = true;
    }
    others.add(ctx);
    active.set(ctx.accountHash, others);
    ctx.before = await balance(token);
  }

  function success(images = 0, videos = 0) {
    const ctx = storage.getStore();
    if (!ctx) return;
    ctx.succeeded = true;
    ctx.images = images;
    ctx.videos = videos;
  }

  async function settle(ctx: UsageContext, status: string) {
    if (ctx.settled) return;
    ctx.settled = true;
    try {
      const after = ctx.token && status !== 'interrupted' ? await balance(ctx.token) : null;
      const known = !ctx.overlap && ctx.before != null && after != null && ctx.before >= after;
      finishUsage(ctx.id, status, ctx.images, ctx.videos, known ? ctx.before! - after! : null,
        known ? 'estimated' : ctx.overlap ? 'concurrent' : 'unknown', Date.now() - ctx.started);
      // Preserve the existing aggregate API without counting managed requests twice.
      // Its legacy schema cannot express unknown credits; /dashboard/usage can.
      if (status === 'success') recordCall(ctx.managedKey, ctx.model,
        known ? ctx.before! - after! : 0, after ?? 0);
    } finally {
      if (ctx.accountHash) {
        const others = active.get(ctx.accountHash);
        others?.delete(ctx);
        if (!others?.size) active.delete(ctx.accountHash);
      }
    }
  }

  function wrap(handler: (request: any) => Promise<any>, endpoint: string, defaultModel: string) {
    return async (request: any) => {
      const authorization = request.headers?.authorization;
      const tokens = typeof authorization === 'string'
        ? authorization.replace(/^Bearer\s+/i, '').split(',').map(t => t.trim()).filter(Boolean) : [];
      const managedKey = tokens.find(token => validateApiKey(token).valid);
      const key = managedKey ? validateApiKey(managedKey) : undefined;
      if (!key?.apiKeyId) return handler(request);
      const model = typeof request.body?.model === 'string' ? request.body.model : defaultModel;
      const ctx: UsageContext = { id: randomUUID(), started: Date.now(), managedKey, model, overlap: false,
        succeeded: false, images: 0, videos: 0, settled: false };
      startUsage(ctx.id, key.apiKeyId, endpoint, model);
      return storage.run(ctx, async () => {
        try {
          const result = await handler(request);
          const stream = result?.body;
          if (stream && typeof stream.once === 'function' && typeof stream.write === 'function') {
            const finish = () => { void settle(ctx, ctx.succeeded ? 'success' : 'failed').catch(console.error); };
            if (stream.writableFinished) finish();
            else {
              stream.once('finish', finish);
              stream.once('error', () => { void settle(ctx, 'failed').catch(console.error); });
              stream.once('close', () => {
                if (!stream.writableFinished) void settle(ctx, 'interrupted').catch(console.error);
              });
            }
          } else await settle(ctx, ctx.succeeded ? 'success' : 'failed');
          return result;
        } catch (error) {
          await settle(ctx, 'failed');
          throw error;
        }
      });
    };
  }
  return { wrap, attach, success, tracked: () => Boolean(storage.getStore()) };
}
