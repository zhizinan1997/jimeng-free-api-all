import { createUsageTracker } from '@/lib/usage.ts';
import { getCredit } from './core.ts';

export const usage = createUsageTracker(async token => {
  const credit = await getCredit(token, { signal: AbortSignal.timeout(5000), timeout: 5000 });
  return credit.totalCredit;
});
