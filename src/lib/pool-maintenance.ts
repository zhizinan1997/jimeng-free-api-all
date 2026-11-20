/** Background reconciliation never creates a generation or releases an unknown submission. */
export interface MaintenanceTask {
  id: string;
  kind: string;
  state: string;
  upstreamTaskId: string | null;
}
export interface PoolMaintenanceDependencies {
  listRecoverableTasks(): MaintenanceTask[];
  recoverTask(id: string): Promise<unknown>;
  settleTask(id: string): Promise<void>;
  refreshStaleAccounts(): Promise<void>;
  report?(event: { phase: 'scan' | 'recovery' | 'settlement' | 'balance'; taskId?: string }): void;
}
export function createPoolMaintenance(
  deps: PoolMaintenanceDependencies,
  options: { intervalMs?: number; maxTasksPerTick?: number; now?: () => number } = {}
) {
  const intervalMs = options.intervalMs ?? 30_000;
  const maxTasks = options.maxTasksPerTick ?? 20;
  if (!Number.isInteger(intervalMs) || intervalMs < 1 || !Number.isInteger(maxTasks) || maxTasks < 1) {
    throw new Error('Invalid pool maintenance interval or batch size');
  }
  const now = options.now ?? Date.now;
  const retries = new Map<string, { after: number; failures: number }>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  let stopped = false;
  let cursor = 0;

  async function tick() {
    if (running || stopped) return;
    running = true;
    try {
      let tasks: MaintenanceTask[];
      try {
        tasks = deps.listRecoverableTasks();
      } catch {
        deps.report?.({ phase: 'scan' });
        return;
      }
      const liveIds = new Set(tasks.map(task => task.id));
      for (const id of retries.keys()) if (!liveIds.has(id)) retries.delete(id);
      const candidates = tasks.filter(task =>
        ['succeeded', 'failed'].includes(task.state) ||
        (['image', 'video', 'audio'].includes(task.kind) && !!task.upstreamTaskId &&
          ['submitted', 'running', 'unknown'].includes(task.state))
      );
      const total = candidates.length;
      let processed = 0;
      const start = total ? cursor % total : 0;
      for (let checked = 0; checked < total && processed < maxTasks && !stopped; checked++) {
        const position = (start + checked) % total;
        const task = candidates[position];
        cursor = position + 1;
        if ((retries.get(task.id)?.after ?? 0) > now()) continue;
        processed++;
        const terminal = ['succeeded', 'failed'].includes(task.state);
        try {
          if (terminal) await deps.settleTask(task.id);
          else await deps.recoverTask(task.id);
          retries.set(task.id, { after: now() + intervalMs, failures: 0 });
        } catch {
          const failures = Math.min((retries.get(task.id)?.failures ?? 0) + 1, 8);
          retries.set(task.id, { after: now() + Math.min(intervalMs * 2 ** failures, 300_000), failures });
          // Upstream error objects may contain credentials; emit only a fixed phase and local ID.
          deps.report?.({ phase: terminal ? 'settlement' : 'recovery', taskId: task.id });
        }
      }
      if (!stopped) {
        try { await deps.refreshStaleAccounts(); }
        catch { deps.report?.({ phase: 'balance' }); }
      }
    } finally {
      running = false;
    }
  }
  function start() {
    if (timer) return;
    stopped = false;
    timer = setInterval(() => { void tick(); }, intervalMs);
    timer.unref?.();
    void tick();
  }
  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = undefined;
  }
  return { start, stop, tick };
}
