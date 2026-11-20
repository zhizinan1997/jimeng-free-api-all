import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoolMaintenance } from './pool-maintenance.ts';

const task = (id, kind, state, upstreamTaskId = null) => ({ id, kind, state, upstreamTaskId });
test('reconciles terminal tasks and known media only; never queries unknown/text/reserved submissions', async () => {
  const calls = [];
  const service = createPoolMaintenance({
    listRecoverableTasks: () => [
      task('done', 'text', 'succeeded'), task('failed', 'upload', 'failed'),
      task('video', 'video', 'submitted', 'history-v'), task('audio', 'audio', 'unknown', 'history-a'),
      task('image', 'image', 'running', 'history-i'), task('unknown', 'video', 'unknown'),
      task('text', 'text', 'submitted', 'conversation'), task('reserved', 'video', 'reserved'),
      task('submitting', 'video', 'submitting'),
    ],
    settleTask: async id => { calls.push('settle:' + id); },
    recoverTask: async id => { calls.push('recover:' + id); },
    refreshStaleAccounts: async () => { calls.push('refresh'); },
  });
  await service.tick();
  assert.deepEqual(calls, ['settle:done', 'settle:failed', 'recover:video', 'recover:audio', 'recover:image', 'refresh']);
});
test('failures retain work, back off without logging secrets, and do not starve other tasks', async () => {
  let time = 0;
  const calls = [], events = [];
  const service = createPoolMaintenance({
    listRecoverableTasks: () => [task('a', 'audio', 'submitted', 'up-a'), task('b', 'video', 'submitted', 'up-b')],
    recoverTask: async id => { calls.push(id); if (id === 'a') throw new Error('cookie=not-for-logs'); },
    settleTask: async () => {},
    refreshStaleAccounts: async () => {},
    report: event => events.push(event),
  }, { now: () => time, intervalMs: 100 });
  await service.tick();
  time = 100;
  await service.tick();
  assert.deepEqual(calls, ['a', 'b', 'b']);
  time = 200;
  await service.tick();
  assert.equal(calls.filter(id => id === 'a').length, 2);
  assert.ok(!JSON.stringify(events).includes('not-for-logs'));
});
test('overlapping ticks cannot run concurrent recovery and stop prevents further operations', async () => {
  let release;
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const pause = new Promise(resolve => { release = resolve; });
  const calls = [];
  const service = createPoolMaintenance({
    listRecoverableTasks: () => [task('a', 'video', 'submitted', 'a'), task('b', 'video', 'submitted', 'b')],
    recoverTask: async id => { calls.push(id); entered(); await pause; },
    settleTask: async () => {},
    refreshStaleAccounts: async () => { calls.push('refresh'); },
  });
  const pending = service.tick();
  await ready;
  await service.tick();
  service.stop();
  release();
  await pending;
  await service.tick();
  assert.deepEqual(calls, ['a']);
});
test('bounded batches rotate fairly and completed records are not retained in retry state', async () => {
  let time = 0;
  let tasks = ['a', 'b', 'c'].map(id => task(id, 'video', 'submitted', id));
  const calls = [];
  const service = createPoolMaintenance({
    listRecoverableTasks: () => tasks,
    recoverTask: async id => { calls.push(id); },
    settleTask: async () => {},
    refreshStaleAccounts: async () => {},
  }, { now: () => time, intervalMs: 10, maxTasksPerTick: 1 });
  await service.tick(); await service.tick(); await service.tick();
  assert.deepEqual(calls, ['a', 'b', 'c']);
  tasks = []; await service.tick();
  tasks = [task('a', 'video', 'submitted', 'a')]; await service.tick();
  assert.deepEqual(calls, ['a', 'b', 'c', 'a']);
});
test('scan and balance failures are recorded without exposing exception text', async () => {
  const events = [];
  let failScan = true;
  const service = createPoolMaintenance({
    listRecoverableTasks: () => { if (failScan) throw Error('secret'); return []; },
    recoverTask: async () => {}, settleTask: async () => {},
    refreshStaleAccounts: async () => { throw Error('secret'); },
    report: event => events.push(event),
  });
  await service.tick(); failScan = false; await service.tick();
  assert.deepEqual(events, [{ phase: 'scan' }, { phase: 'balance' }]);
});
