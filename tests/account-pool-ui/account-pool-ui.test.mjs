// Run directly with node. Starts only an isolated loopback mock; never imports backend or opens a DB.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../public');
const output = process.env.POOL_UI_EVIDENCE_DIR || await mkdtemp(join(tmpdir(), 'jimeng-pool-ui-C-'));
await mkdir(output, { recursive: true });
const now = new Date().toISOString();
const accounts = [
  { id: 'mock-alpha', name: '隔离测试 A', enabled: true, priority: 0, lastUsedAt: now, status: { totalCredit: 250, checkedAt: now, membership: '普通账号' }, upstreamIdentity: { verified: true, userId: 'mock-user-A', displayName: '测试上游身份 A', checkedAt: now, source: '隔离上游 fixture' }, scheduling: { eligible: true, reason: '排序最前且余额足够', availableCredits: 250, reservedCredits: 0, activeTaskCount: 1, unknownCostBusy: false } },
  { id: 'mock-beta', name: '隔离测试 B', enabled: true, priority: 1, lastUsedAt: now, status: { totalCredit: null, checkedAt: null, error: '隔离模拟刷新失败' }, upstreamIdentity: { verified: false, userId: null, displayName: null, checkedAt: null }, scheduling: { eligible: false, reason: '余额未知，提交待确认', availableCredits: null, reservedCredits: 0, activeTaskCount: 1, unknownCostBusy: true } },
  { id: 'mock-xss', name: '<img src=x onerror="window.XSS=true">', enabled: false, priority: 2, status: { totalCredit: 199, checkedAt: now }, upstreamIdentity: { verified: false }, scheduling: { eligible: false, reason: '<script>window.XSS=true</script>', availableCredits: 199, reservedCredits: 0, activeTaskCount: 0, unknownCostBusy: false } }
];
let dashboard = { settings: { mode: 'auto', fixedAccountId: null, threshold: 200, balanceMaxAgeSeconds: 60, revision: 1 }, summary: { nextAccountId: 'mock-alpha', nextReason: '排序最前且余额足够', predictedAt: now, activeTaskCount: 2, lastSwitch: null }, accounts, tasks: [ { id: 'mock-task-unknown', requestId: 'request-unknown', accountId: 'mock-beta', accountName: '隔离测试 B', kind: 'video', model: 'mock-video', state: 'unknown', estimatedCredits: null, upstreamTaskId: null, createdAt: now, updatedAt: now, error: '上游响应丢失' }, { id: 'mock-task-done', requestId: 'request-done', accountId: 'mock-alpha', accountName: '隔离测试 A', kind: 'image', model: 'mock-image', state: 'succeeded', settling: true, estimatedCredits: 80, upstreamTaskId: 'upstream-mock-1', createdAt: now, updatedAt: now, error: null } ], events: [{ id: 'mock-event', type: 'task_transition', accountId: 'mock-beta', fromAccountId: null, toAccountId: null, reason: '提交响应丢失，保留待确认', createdAt: now }] };
const requests = [], checks = [], browserErrors = [];
let failure = null;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let body = ''; for await (const chunk of req) body += chunk;
    const parsed = body ? JSON.parse(body) : null;
    requests.push({ method: req.method, path: url.pathname, body: parsed });
    function json(value, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }
    if (['/', '/account-pool-ui.js', '/account-pool-ui.css'].includes(url.pathname)) {
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const source = await readFile(join(root, file), 'utf8');
      res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
      res.end(file === 'index.html' ? source.replace('<body>', '<body><div style="padding:12px;color:#f6c85f;text-align:center">隔离 MOCK 验收 · 虚拟账号 · 未连接真实上游</div>') : source); return;
    }
    if (url.pathname === '/dashboard/status') return json({ setupComplete: true });
    if (url.pathname === '/dashboard/stats') return json({});
    if (url.pathname === '/dashboard/keys') return json([]);
    if (failure && failure.path === url.pathname && req.method !== 'GET') { const f = failure; failure = null; return json(f.body, f.status); }
    if (url.pathname === '/account-pool/dashboard') return json({ ...dashboard, tasks: dashboard.tasks.slice(0, 50), events: dashboard.events.slice(0, 50) });
    if (url.pathname === '/account-pool/settings') {
      if (parsed.revision !== dashboard.settings.revision) return json({ error: 'revision conflict' }, 409);
      dashboard.settings = { ...parsed, revision: dashboard.settings.revision + 1 };
      dashboard.summary.nextAccountId = parsed.mode === 'fixed' ? (dashboard.accounts.find((a) => a.id === parsed.fixedAccountId)?.scheduling.eligible ? parsed.fixedAccountId : null) : 'mock-alpha';
      dashboard.summary.nextReason = dashboard.summary.nextAccountId ? '隔离 fixture 候选，提交时再判定' : '固定账号不合格：余额未知';
      return json(dashboard.settings);
    }
    if (url.pathname === '/account-pool/order') {
      if (parsed.revision !== dashboard.settings.revision) return json({ error: 'revision conflict' }, 409);
      assert.equal(new Set(parsed.accountIds).size, dashboard.accounts.length);
      dashboard.accounts = parsed.accountIds.map((id, priority) => ({ ...dashboard.accounts.find((a) => a.id === id), priority }));
      dashboard.settings.revision++;
      return json(dashboard);
    }
    if (url.pathname.endsWith('/enabled')) { const a = dashboard.accounts.find((a) => url.pathname.includes(a.id)); a.enabled = parsed.enabled; return json(a); }
    if (url.pathname.endsWith('/refresh-status')) return json(dashboard.accounts.find((a) => url.pathname.includes(a.id)));
    if (url.pathname === '/account-pool/events' || url.pathname === '/account-pool/tasks') { const kind = url.pathname.split('/').pop(); return json({ items: dashboard[kind].slice(Number(url.searchParams.get('offset')), Number(url.searchParams.get('offset')) + 50), total: dashboard[kind].length }); }
    if (url.pathname.startsWith('/account-pool/')) return json({ success: true });
    return json({ error: 'isolated route not found' }, 404);
  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto(url);
  await page.locator('[data-tab="accounts"]').click();
  await page.locator('#accounts-table tr').first().waitFor();
  await page.waitForFunction(() => document.getElementById('account-total').textContent === '3');
  assert.match(await page.locator('#pool-next').innerText(), /隔离测试 A/);
  assert.match(await page.locator('#pool-tasks').innerText(), /提交待确认/);
  assert.match(await page.locator('#pool-tasks').innerText(), /结算待确认/);
  assert.match(await page.locator('#accounts-table').innerText(), /上游身份未核验/);
  assert.match(await page.locator('#accounts-table').innerText(), /可用 未知/);
  assert.match(await page.locator('#pool-active-accounts').innerText(), /隔离测试 A.*隔离测试 B/);
  assert.equal(await page.locator('#accounts-table img, #accounts-table script').count(), 0);
  assert.equal(await page.evaluate(() => window.XSS), undefined);
  assert.equal(await page.locator('[data-account-id="mock-beta"] [data-action="delete"]').isDisabled(), true);
  checks.push('候选 / 多实际账号 / 未核验 / 未知余额 / unknown 与 settling / 删除占位保护 / XSS');
  await page.screenshot({ path: join(output, 'desktop-mock.png'), fullPage: true });
  await page.locator('#pool-mode').selectOption('fixed');
  await page.locator('#pool-fixed').selectOption('mock-beta');
  assert.match(await page.locator('#pool-fixed-reason').innerText(), /不合格/);
  await page.locator('#pool-threshold').fill('220');
  await page.evaluate(() => loadAccounts());
  assert.equal(await page.locator('#pool-threshold').inputValue(), '220');
  await page.locator('#pool-save-settings').click();
  await page.waitForFunction(() => document.getElementById('pool-settings-note').textContent.includes('版本 2'));
  assert.deepEqual(dashboard.settings, { mode: 'fixed', fixedAccountId: 'mock-beta', threshold: 220, balanceMaxAgeSeconds: 60, revision: 2 });
  checks.push('固定不合格提示 / 草稿跨刷新保留 / 设置真实 PATCH 与 revision / 保存后服务端值');
  await page.locator('[data-account-id="mock-beta"] [data-action="up"]').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#accounts-table tr').first().getAttribute('data-account-id'), 'mock-beta');
  assert.equal(await page.evaluate(() => document.activeElement?.closest('tr')?.dataset.accountId), 'mock-beta');
  await page.locator('#pool-save-order').click();
  await page.waitForFunction(() => document.getElementById('pool-settings-note').textContent.includes('版本 3'));
  assert.equal(dashboard.accounts[0].id, 'mock-beta');
  await page.locator('[data-account-id="mock-alpha"] [data-action="drag"]').dragTo(page.locator('[data-account-id="mock-beta"] [data-action="drag"]'));
  assert.equal(await page.locator('#accounts-table tr').first().getAttribute('data-account-id'), 'mock-alpha');
  await page.locator('#pool-save-order').click();
  await page.waitForFunction(() => document.getElementById('pool-settings-note').textContent.includes('版本 4'));
  assert.equal(dashboard.accounts[0].id, 'mock-alpha');
  checks.push('键盘 Enter 上移 / 浏览器鼠标拖放 / 全量顺序 PATCH 持久化');
  await page.locator('#pool-threshold').fill('230');
  failure = { path: '/account-pool/settings', status: 409, body: { error: 'revision conflict' } };
  await page.locator('#pool-save-settings').click();
  await page.waitForFunction(() => document.getElementById('pool-message').textContent.includes('其他管理员'));
  assert.equal(dashboard.settings.threshold, 220);
  assert.equal(await page.locator('#pool-save-settings').isDisabled(), true);
  await page.locator('#pool-refresh').click();
  await page.waitForFunction(() => document.getElementById('pool-threshold').value === '220');
  checks.push('409 明确刷新提示 / 保留草稿且禁止重复保存 / 刷新丢弃后恢复');
  failure = { path: '/account-pool/settings', status: 200, body: { error: '模拟业务失败' } };
  await page.locator('#pool-threshold').fill('240');
  await page.locator('#pool-save-settings').click();
  await page.waitForFunction(() => document.getElementById('pool-message').textContent.includes('模拟业务失败'));
  assert.equal(dashboard.settings.threshold, 220);
  assert.match(await page.locator('#pool-settings-note').innerText(), /尚未保存/);
  await page.locator('#pool-refresh').click();
  await page.waitForFunction(() => document.getElementById('pool-threshold').value === '220');
  failure = { path: '/account-pool/mock-xss/enabled', status: 200, body: { code: -1, message: '模拟启用失败' } };
  await page.locator('[data-account-id="mock-xss"] [data-action="toggle"]').click();
  await page.waitForFunction(() => document.getElementById('pool-message').textContent.includes('模拟启用失败'));
  assert.equal(dashboard.accounts.find((a) => a.id === 'mock-xss').enabled, false);
  failure = { path: '/account-pool/mock-xss/enabled', status: 200, body: {} };
  await page.locator('[data-account-id="mock-xss"] [data-action="toggle"]').click();
  await page.waitForFunction(() => document.getElementById('pool-message').textContent.includes('启停响应不完整'));
  failure = { path: '/account-pool/mock-xss', status: 500, body: { error: '模拟删除失败' } };
  await page.locator('[data-account-id="mock-xss"] [data-action="delete"]').click();
  await page.waitForFunction(() => document.getElementById('pool-message').textContent.includes('模拟删除失败'));
  await page.locator('[data-account-id="mock-beta"] [data-action="refresh"]').click();
  await page.waitForFunction(() => document.getElementById('pool-message').textContent.includes('余额 / 状态刷新失败'));
  failure = { path: '/account-pool/mock-alpha/refresh-status', status: 409, body: { error: '账号有未结算任务，暂缓余额刷新' } };
  await page.locator('[data-account-id="mock-alpha"] [data-action="refresh"]').click();
  await page.waitForFunction(() => document.getElementById('pool-message').textContent.includes('暂缓余额刷新'));
  assert.equal(await page.locator('#pool-settings-fields').isDisabled(), false);
  checks.push('HTTP 200 业务错误及空响应 / 旧 code 错误 / HTTP 500 删除错误 / 嵌套余额刷新失败均不假报成功；占位 409 不误报版本冲突');
  await page.locator('#pool-threshold').fill('-1');
  const writesBefore = requests.filter((r) => r.path === '/account-pool/settings').length;
  await page.locator('#pool-save-settings').click();
  assert.equal(requests.filter((r) => r.path === '/account-pool/settings').length, writesBefore);
  await page.locator('#pool-threshold').fill('250');
  dashboard.settings.revision++;
  await page.evaluate(() => loadAccounts());
  assert.match(await page.locator('#pool-message').innerText(), /服务端配置已更新/);
  assert.equal(await page.locator('#pool-threshold').inputValue(), '250');
  await page.locator('#pool-refresh').click();
  await page.waitForFunction(() => document.getElementById('pool-threshold').value === '220');
  checks.push('无效负阈值不发送 / 自动刷新发现版本变化不覆盖本地草稿');
  dashboard.tasks = Array.from({ length: 55 }, (_, i) => ({ ...dashboard.tasks[0], id: `mock-page-task-${i}` }));
  await page.evaluate(() => loadAccounts());
  await page.locator('#pool-tasks-next').click();
  await page.waitForFunction(() => document.getElementById('pool-tasks-page').textContent.includes('51–55 / 55'));
  await page.locator('#pool-tasks-prev').click();
  await page.waitForFunction(() => document.getElementById('pool-tasks-page').textContent.includes('1–50 / 55'));
  checks.push('任务列表分页管理 API');
  dashboard.tasks = dashboard.tasks.slice(0, 2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#pool-refresh').click();
  await page.waitForFunction(() => !document.getElementById('pool-refresh').disabled);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator('.account-table-panel .table-scroll').evaluate((el) => el.scrollWidth > el.clientWidth), true);
  await page.screenshot({ path: join(output, 'mobile-mock.png'), fullPage: true });
  checks.push('390px 窄屏无全页溢出 / 表格局部横向滚动');
  assert.equal(requests.some((r) => r.path.includes('/select')), false);
  assert.equal(browserErrors.length, 0, browserErrors.join('\n'));
  checks.push('预览仅 dashboard GET / 无 select 派发 / 无浏览器脚本错误');
  await writeFile(join(output, 'results.json'), JSON.stringify({ environment: 'isolated mock only; no DB or upstream', node: process.version, browser: browser.version(), url, checks, requestCount: requests.length, browserErrors }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, checks, evidence: output }, null, 2));
} finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
