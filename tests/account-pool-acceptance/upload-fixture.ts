import { currentPoolTask } from '../../src/lib/pool-task-context.ts';
export async function uploadVideoReference(source: string, token: string, kind: string, cookie?: string) {
  (globalThis as any).__poolFixture.calls.push({ operation: 'upload', source, token, kind, cookie, accountId: currentPoolTask()?.accountId });
  return { vid: 'v0' + 'a'.repeat(24), durationMs: 5000, width: 0, height: 0 };
}
