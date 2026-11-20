// Real Koa server + real routes/controllers/scheduler + temporary DB_PATH + isolated upstream browser integration test.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(testDir, '../..');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jimeng-pool-ui-int-')));
const evidenceDir = process.env.POOL_UI_EVIDENCE_DIR || path.join(root, 'evidence');
fs.mkdirSync(evidenceDir, { recursive: true });

const dbPath = path.join(root, 'isolated.db');
const guardPath = path.join(testDir, 'loopback-guard.cjs');
const fixturePath = path.join(testDir, 'upstream-fixture.ts');

for (const entry of ['node_modules', 'public', 'configs', 'package.json']) {
  fs.symlinkSync(path.join(repo, entry), path.join(root, entry));
}

async function allocateFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

const serverBundle = path.join(root, 'server-entry.mjs');
const seedBundle = path.join(root, 'seed-entry.mjs');
const esmBanner = { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" };

await build({
  stdin: {
    contents: `
      import "@/lib/initialize.ts";
      import server from "@/lib/server.ts";
      import routes from "@/api/routes/index.ts";
      server.attachRoutes(routes);
      server.listen().catch((err) => { console.error(err); process.exit(1); });
    `,
    resolveDir: repo,
    loader: 'ts'
  },
  outfile: serverBundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  banner: esmBanner,
  tsconfig: path.join(repo, 'tsconfig.json'),
  plugins: [{
    name: 'isolated-upstream',
    setup(b) {
      b.onResolve({ filter: /(?:^|\/)core\.ts$/ }, () => ({ path: fixturePath }));
    }
  }]
});

await build({
  stdin: {
    contents: `export { default as pool } from "@/lib/account-pool.ts";`,
    resolveDir: repo,
    loader: 'ts'
  },
  outfile: seedBundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  banner: esmBanner,
  tsconfig: path.join(repo, 'tsconfig.json'),
  plugins: [{
    name: 'isolated-upstream',
    setup(b) {
      b.onResolve({ filter: /(?:^|\/)core\.ts$/ }, () => ({ path: fixturePath }));
    }
  }]
});

const sharedServerEnv = (port) => ({
  PATH: process.env.PATH,
  HOME: root,
  TMPDIR: root,
  TZ: 'Asia/Shanghai',
  DB_PATH: dbPath,
  UI_INTEGRATION_ROOT: root,
  JIMENG_ACCOUNT_POOL_KEY: 'virtual-ui-integration-encryption-key',
  ACCOUNT_POOL_ENCRYPTION_KEY: 'virtual-ui-integration-encryption-key',
  JIMENG_BROWSER_TRANSPORT: 'off',
  SERVER_HOST: '127.0.0.1',
  SERVER_PORT: String(port),
  NODE_OPTIONS: `--require=${JSON.stringify(guardPath)}`
});

async function startServer(port) {
  const logs = [];
  const child = spawn(process.execPath, [serverBundle], {
    cwd: root,
    env: sharedServerEnv(port),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Isolated server exited prematurely (${child.exitCode}):\n${logs.join('')}`);
    }
    try {
      const res = await fetch(`${baseUrl}/dashboard/status`);
      if (res.ok) return { child, baseUrl, logs };
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  child.kill('SIGKILL');
  throw new Error(`Timed out waiting for isolated server:\n${logs.join('')}`);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

let port = await allocateFreePort();
let serverProc = await startServer(port);
let browser;
const checks = [];
const pageErrors = [];
const unexpectedConsoleErrors = [];
const assetStatuses = new Map();
const apiCalls = [];
let allowExpectedHttpErrorLog = false;
let allowPreLogin401 = true;

try {
  // 1. Verify admin auth gate on real /account-pool/dashboard before login
  const unauthRes = await fetch(`${serverProc.baseUrl}/account-pool/dashboard`);
  assert.equal(unauthRes.status, 401);
  const unauthBody = await unauthRes.json();
  assert.equal(unauthBody.error, '未登录');
  checks.push('未登录请求真实 /account-pool/dashboard 返回 401');

  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  page.on('dialog', (dialog) => dialog.accept());
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (allowExpectedHttpErrorLog && text.includes('status of 502') || allowExpectedHttpErrorLog && text.includes('status of 409')) return;
    if (allowPreLogin401 && text.includes('status of 401')) return;
    unexpectedConsoleErrors.push(text);
  });
  page.on('response', (res) => {
    const url = new URL(res.url());
    if (['/', '/account-pool-ui.css', '/account-pool-ui.js'].includes(url.pathname)) {
      assetStatuses.set(url.pathname, res.status());
    }
    if (url.pathname.startsWith('/account-pool')) {
      apiCalls.push({ method: res.request().method(), path: url.pathname + url.search, status: res.status() });
    }
  });

  // 2. Open real server dashboard, verify static assets 200, complete setup & login
  await page.goto(serverProc.baseUrl, { waitUntil: 'networkidle' });
  const directCss = await fetch(`${serverProc.baseUrl}/account-pool-ui.css`);
  const directJs = await fetch(`${serverProc.baseUrl}/account-pool-ui.js`);
  assert.equal(assetStatuses.get('/'), 200, `assets=${JSON.stringify([...assetStatuses])} logs=${serverProc.logs.join('')}`);
  assert.equal(assetStatuses.get('/account-pool-ui.css'), 200, `directCss=${directCss.status} assets=${JSON.stringify([...assetStatuses])} logs=${serverProc.logs.join('')}`);
  assert.equal(assetStatuses.get('/account-pool-ui.js'), 200, `directJs=${directJs.status} assets=${JSON.stringify([...assetStatuses])} logs=${serverProc.logs.join('')}`);

  await page.locator('#setup-username').fill('virtual-admin');
  await page.locator('#setup-password').fill('virtual-pass-123');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.locator('#setup-form button').click()
  ]);
  await page.locator('#login-username').fill('virtual-admin');
  await page.locator('#login-password').fill('virtual-pass-123');
  await page.locator('#login-form button').click();
  await page.locator('#dashboard.active').waitFor();
  allowPreLogin401 = false;
  await page.locator('.tab-btn[data-tab="accounts"]').click();
  await page.waitForFunction(() => document.getElementById('pool-threshold').value === '200');
  checks.push('真实 Koa 静态资源 (/account-pool-ui.js/.css) 200 加载并完成初始化与管理员登录');

  // 3. Create 4 virtual accounts via UI & test real upstream refresh + failure
  const accountsToAdd = [
    { name: '隔离主号 Alpha', cookie: 'sessionid=virtual-alpha-250; token=secret-alpha-never-leak' },
    { name: '隔离异常 Beta', cookie: 'sessionid=virtual-beta-fail; token=secret-beta-never-leak' },
    { name: '隔离低分 Gamma', cookie: 'sessionid=virtual-gamma-199; token=secret-gamma-never-leak' },
    { name: '隔离并发 Delta', cookie: 'sessionid=virtual-delta-300; token=secret-delta-never-leak' }
  ];
  for (const acc of accountsToAdd) {
    await page.locator('#account-name').fill(acc.name);
    await page.locator('#account-cookie').fill(acc.cookie);
    await page.locator('#pool-create').click();
    await page.waitForFunction((n) => document.getElementById('accounts-table').textContent.includes(n), acc.name);
  }

  // Verify raw secrets never appear in DOM or /account-pool/dashboard JSON
  const sessionCookies = await context.cookies();
  const sessionCookieHeader = sessionCookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const dashJson = await (await fetch(`${serverProc.baseUrl}/account-pool/dashboard`, { headers: { cookie: sessionCookieHeader } })).json();
  const serializedDash = JSON.stringify(dashJson);
  for (const secret of ['virtual-alpha-250', 'virtual-beta-fail', 'virtual-gamma-199', 'virtual-delta-300', 'secret-alpha-never-leak']) {
    assert.equal(serializedDash.includes(secret), false, `Secret leaked in dashboard JSON: ${secret}`);
  }
  const idByName = Object.fromEntries(dashJson.accounts.map((a) => [a.name, a.id]));

  // Refresh Alpha, Gamma, Delta (succeed) and Beta (502 failure)
  for (const name of ['隔离主号 Alpha', '隔离低分 Gamma', '隔离并发 Delta']) {
    const id = idByName[name];
    await page.locator(`[data-account-id="${id}"] [data-action="refresh"]`).click();
    await page.waitForFunction(
      (accountId) => document.querySelector(`[data-account-id="${accountId}"]`)?.textContent.includes('上游身份已核验'),
      id
    );
  }

  allowExpectedHttpErrorLog = true;
  await page.locator(`[data-account-id="${idByName['隔离异常 Beta']}"] [data-action="refresh"]`).click();
  await page.waitForFunction(() => document.getElementById('pool-message').textContent.includes('上游余额刷新失败'));
  allowExpectedHttpErrorLog = false;

  await page.locator('#pool-refresh').click();
  await page.waitForFunction((id) => document.querySelector(`[data-account-id="${id}"]`)?.textContent.includes('刷新失败：'), idByName['隔离异常 Beta']);

  const alphaText = await page.locator(`[data-account-id="${idByName['隔离主号 Alpha']}"]`).innerText();
  assert.match(alphaText, /上游核验账号 Alpha/);
  assert.match(alphaText, /upstream-alpha-uid/);
  assert.match(alphaText, /可用 250/);
  assert.match(alphaText, /可接新任务/);
  const betaText = await page.locator(`[data-account-id="${idByName['隔离异常 Beta']}"]`).innerText();
  assert.match(betaText, /上游身份未核验/);
  assert.match(betaText, /可用 未知/);
  assert.match(betaText, /余额未知或已过期/);
  assert.match(betaText, /暂不可接单/);
  const gammaText = await page.locator(`[data-account-id="${idByName['隔离低分 Gamma']}"]`).innerText();
  assert.match(gammaText, /可用 199/);
  assert.match(gammaText, /暂不可接单/);
  assert.equal(await page.locator('#pool-next').innerText(), '隔离主号 Alpha');
  checks.push('真实管理 API 创建虚拟账号、刷新核验身份/余额、502 刷新失败不作零处理、凭据零泄露');

  // 4. Settings validation, fixed mode ineligible warning & real persistence
  await page.locator('#pool-threshold').fill('-5');
  const settingsCallsBeforeInvalid = apiCalls.filter((c) => c.path === '/account-pool/settings').length;
  await page.locator('#pool-save-settings').click();
  assert.equal(apiCalls.filter((c) => c.path === '/account-pool/settings').length, settingsCallsBeforeInvalid);

  await page.locator('#pool-mode').selectOption('fixed');
  await page.locator('#pool-fixed').selectOption(idByName['隔离低分 Gamma']);
  assert.match(await page.locator('#pool-fixed-reason').innerText(), /不合格/);
  await page.locator('#pool-threshold').fill('200');
  await page.locator('#pool-save-settings').click();
  await page.waitForFunction(() => document.getElementById('pool-message').textContent.includes('调度设置已保存'));
  assert.equal(await page.locator('#pool-next').innerText(), '暂无合格候选');

  await page.locator('#pool-mode').selectOption('auto');
  await page.locator('#pool-threshold').fill('180');
  await page.locator('#pool-balance-age').fill('90');
  await page.locator('#pool-save-settings').click();
  await page.waitForFunction(() => document.getElementById('pool-next').textContent.trim() === '隔离主号 Alpha');
  checks.push('前端负阈值拦截、固定模式不合格提示、自动模式 180/90s 真实 PATCH 保存成功');

  // 5. Keyboard + Drag-and-Drop reordering persisted via real PATCH /account-pool/order
  const gammaUpBtn = page.locator(`[data-account-id="${idByName['隔离低分 Gamma']}"] [data-action="up"]`);
  await gammaUpBtn.focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#accounts-table tr').nth(1).getAttribute('data-account-id'), idByName['隔离低分 Gamma']);
  await page.evaluate(() => {
    window.__dragLog = [];
    for (const ev of ['dragstart', 'dragover', 'drop', 'dragend']) {
      document.getElementById('accounts-table').addEventListener(ev, (e) => {
        window.__dragLog.push(`${ev}:${e.target?.closest?.('tr')?.dataset?.accountId || 'none'}`);
      });
    }
  });
  const dragSource = page.locator(`[data-account-id="${idByName['隔离低分 Gamma']}"] [data-action="drag"]`);
  const dragTarget = page.locator(`[data-account-id="${idByName['隔离主号 Alpha']}"] [data-action="drag"]`);
  await dragTarget.scrollIntoViewIfNeeded();
  await dragSource.dragTo(dragTarget, { steps: 10 });
  const dragLog = await page.evaluate(() => window.__dragLog);
  assert.equal(
    await page.locator('#accounts-table tr').first().getAttribute('data-account-id'),
    idByName['隔离低分 Gamma'],
    `dragLog=${JSON.stringify(dragLog)}`
  );
  await page.locator('#pool-save-order').click();
  await page.waitForFunction(() => document.getElementById('pool-message').textContent.includes('排序已保存'));
  assert.equal(await page.locator('#pool-next').innerText(), '隔离低分 Gamma');
  checks.push('键盘 Enter 上移 + 鼠标拖放排序真实 PATCH /account-pool/order 持久化');

  // 6. Real HTTP 409 optimistic concurrency conflict & draft protection
  await page.locator('#pool-threshold').fill('210');
  const latestDash = await (await fetch(`${serverProc.baseUrl}/account-pool/dashboard`, { headers: { cookie: sessionCookieHeader } })).json();
  const conflictPatch = await fetch(`${serverProc.baseUrl}/account-pool/settings`, {
    method: 'PATCH',
    headers: { cookie: sessionCookieHeader, 'content-type': 'application/json' },
    body: JSON.stringify({ ...latestDash.settings, threshold: 185 })
  });
  assert.equal(conflictPatch.status, 200);

  allowExpectedHttpErrorLog = true;
  await page.locator('#pool-save-settings').click();
  await page.waitForFunction(() => document.getElementById('pool-message').textContent.includes('配置已被其他管理员修改'));
  allowExpectedHttpErrorLog = false;
  assert.equal(await page.locator('#pool-threshold').inputValue(), '210');
  assert.equal(await page.locator('#pool-save-settings').isDisabled(), true);
  assert.equal(await page.locator('#pool-threshold').isDisabled(), true);

  await page.locator('#pool-refresh').click();
  await page.waitForFunction(() => document.getElementById('pool-threshold').value === '185' && !document.getElementById('pool-settings-fields').disabled);
  checks.push('真实服务端 409 并发版本冲突保护草稿、锁定保存并在刷新面板后恢复');

  // 7. Seed 54 settled historical tasks + 2 active held tasks (settling on Alpha + unknown cost on Delta) in same temp DB
  const seedScript = `
    import { pathToFileURL } from 'node:url';
    (async () => {
      const { pool } = await import(pathToFileURL(${JSON.stringify(seedBundle)}).href);
      for (let i = 0; i < 54; i++) {
        const lease = await pool.acquireTask({
          requestId: 'hist-req-' + i,
          ownerHash: 'ui-int-owner',
          requestFingerprint: 'fp-hist-' + i,
          kind: 'image',
          model: 'jimeng-4.5',
          estimatedCredits: 1,
          preferredAccountId: ${JSON.stringify(idByName['隔离主号 Alpha'])}
        });
        pool.transitionTask(lease.taskId, { state: 'submitting' });
        pool.transitionTask(lease.taskId, { state: 'submitted', upstreamTaskId: 'upstream-hist-' + i });
        pool.transitionTask(lease.taskId, { state: 'succeeded', upstreamTaskId: 'upstream-hist-' + i, result: { ok: true } });
        await pool.settleTask(lease.taskId);
      }
      const settlingLease = await pool.acquireTask({
        requestId: 'active-settling-req',
        ownerHash: 'ui-int-owner',
        requestFingerprint: 'fp-settling',
        kind: 'image',
        model: 'jimeng-4.5',
        estimatedCredits: 60,
        preferredAccountId: ${JSON.stringify(idByName['隔离主号 Alpha'])}
      });
      pool.transitionTask(settlingLease.taskId, { state: 'submitting' });
      pool.transitionTask(settlingLease.taskId, { state: 'succeeded', upstreamTaskId: 'upstream-settling-1' });

      const unknownLease = await pool.acquireTask({
        requestId: 'active-unknown-req',
        ownerHash: 'ui-int-owner',
        requestFingerprint: 'fp-unknown',
        kind: 'video',
        model: 'jimeng-video-3.0',
        estimatedCredits: null,
        preferredAccountId: ${JSON.stringify(idByName['隔离并发 Delta'])}
      });
      pool.transitionTask(unknownLease.taskId, { state: 'submitting' });
      pool.transitionTask(unknownLease.taskId, { state: 'unknown', error: '模拟超时响应丢失' });
    })().catch((err) => { console.error(err); process.exit(1); });
  `;
  const seedRun = spawnSync(process.execPath, ['--input-type=module', '-e', seedScript], {
    cwd: root,
    env: sharedServerEnv(port),
    encoding: 'utf8'
  });
  assert.equal(seedRun.status, 0, seedRun.stderr || seedRun.stdout);

  await page.locator('#pool-refresh').click();
  await page.waitForFunction(() => document.getElementById('pool-active').textContent.trim() === '2');
  assert.match(await page.locator('#pool-active-accounts').innerText(), /隔离主号 Alpha：1/);
  assert.match(await page.locator('#pool-active-accounts').innerText(), /隔离并发 Delta：1/);
  assert.equal(await page.locator(`[data-account-id="${idByName['隔离主号 Alpha']}"] [data-action="delete"]`).isDisabled(), true);
  assert.equal(await page.locator(`[data-account-id="${idByName['隔离并发 Delta']}"] [data-action="delete"]`).isDisabled(), true);

  // Also verify backend directly rejects DELETE on busy account with HTTP 409
  const deleteBusyRes = await fetch(`${serverProc.baseUrl}/account-pool/${idByName['隔离主号 Alpha']}`, {
    method: 'DELETE',
    headers: { cookie: sessionCookieHeader }
  });
  assert.equal(deleteBusyRes.status, 409);

  const tasksTableText = await page.locator('#pool-tasks').innerText();
  assert.match(tasksTableText, /提交待确认/);
  assert.match(tasksTableText, /无上游 ID · 无法据此自动找回/);
  assert.match(tasksTableText, /结算待确认 · 占位尚未释放/);

  await page.locator('#pool-tasks-next').click();
  await page.waitForFunction(() => document.getElementById('pool-tasks-page').textContent.includes('51–56 / 56'));
  await page.locator('#pool-events-next').click();
  await page.waitForFunction(() => document.getElementById('pool-events-page').textContent.includes('51–100 /'));
  checks.push('多账号并发占位、unknown/settling 状态、占位账号前端禁删与服务端 409 拒删、真实任务/事件分页');

  // 8. Enable/disable & delete unheld account Gamma
  await page.locator(`[data-account-id="${idByName['隔离低分 Gamma']}"] [data-action="toggle"]`).click();
  await page.waitForFunction((id) => document.querySelector(`[data-account-id="${id}"]`)?.textContent.includes('已停用'), idByName['隔离低分 Gamma']);
  await page.locator(`[data-account-id="${idByName['隔离低分 Gamma']}"] [data-action="delete"]`).click();
  await page.waitForFunction((id) => !document.querySelector(`[data-account-id="${id}"]`), idByName['隔离低分 Gamma']);
  checks.push('真实停用与删除无占位账号成功');

  // 9. Real server restart against the same DB_PATH and verify persistence in browser
  await stopServer(serverProc.child);
  port = await allocateFreePort();
  serverProc = await startServer(port);
  await page.goto(serverProc.baseUrl, { waitUntil: 'networkidle' });
  await page.locator('#dashboard.active').waitFor();
  await page.locator('.tab-btn[data-tab="accounts"]').click();
  await page.waitForFunction(() => document.getElementById('pool-threshold').value === '185');
  assert.equal(await page.locator('#pool-balance-age').inputValue(), '90');
  assert.equal(await page.locator('#pool-active').innerText(), '2');
  assert.equal(await page.locator('#accounts-table tr').count(), 3);
  checks.push('服务重启后使用同一临时 DB_PATH 恢复会话、设置、排序、账号、身份及在途占位');

  // 10. Two accounts verifying to the same upstream user_id must surface deduplication reason and shared occupancy
  await page.locator('#account-name').fill('隔离同身份副号 Echo');
  await page.locator('#account-cookie').fill('sessionid=virtual-alpha-dup; token=secret-echo-never-leak');
  await page.locator('#pool-create').click();
  await page.waitForFunction(() => document.getElementById('accounts-table').textContent.includes('隔离同身份副号 Echo'));
  const postRestartCookies = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  const dashWithEcho = await (await fetch(`${serverProc.baseUrl}/account-pool/dashboard`, { headers: { cookie: postRestartCookies } })).json();
  const serializedEchoDash = JSON.stringify(dashWithEcho);
  assert.equal(serializedEchoDash.includes('virtual-alpha-dup'), false);
  assert.equal(serializedEchoDash.includes('secret-echo-never-leak'), false);
  const echoId = dashWithEcho.accounts.find((a) => a.name === '隔离同身份副号 Echo')?.id;
  assert.ok(echoId, 'Echo account id must exist');
  await page.locator(`[data-account-id="${echoId}"] [data-action="refresh"]`).click();
  await page.waitForFunction(
    (accountId) => document.querySelector(`[data-account-id="${accountId}"]`)?.textContent.includes('上游身份已核验'),
    echoId
  );
  const echoText = await page.locator(`[data-account-id="${echoId}"]`).innerText();
  assert.match(echoText, /上游身份已核验/);
  assert.match(echoText, /upstream-alpha-uid/);
  assert.match(echoText, /可用 200/);
  assert.match(echoText, /最新余额 260 · 预占 60/);
  assert.match(echoText, /暂不可接单/);
  assert.match(echoText, /与排在前面的账号「隔离主号 Alpha」为同一上游身份，已禁止重复参与调度/);
  assert.match(echoText, /进行中 \/ 待确认：1/);
  assert.equal(await page.locator('#pool-next').innerText(), '暂无合格候选');
  await page.locator('#pool-mode').selectOption('fixed');
  await page.locator('#pool-fixed').selectOption(echoId);
  assert.match(await page.locator('#pool-fixed-reason').innerText(), /不合格 · 与排在前面的账号「隔离主号 Alpha」为同一上游身份，已禁止重复参与调度/);
  await page.locator('#pool-refresh').click();
  await page.waitForFunction(() => document.getElementById('pool-mode').value === 'auto' && !document.getElementById('pool-settings-fields').disabled);
  checks.push('同上游 user_id 账号核验后展示同身份排重不可调度原因、共享预占且不作为下一候选');

  // Move Echo ahead of Alpha and persist order; UI must swap deduplication reason and keep shared occupancy notices
  const alphaId = idByName['隔离主号 Alpha'];
  for (let step = 0; step < 5; step++) {
    const ids = await page.locator('#accounts-table tr').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-account-id')));
    if (ids.indexOf(echoId) < ids.indexOf(alphaId)) break;
    await page.locator(`[data-account-id="${echoId}"] [data-action="up"]`).click();
  }
  const reorderedIds = await page.locator('#accounts-table tr').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-account-id')));
  assert.ok(reorderedIds.indexOf(echoId) < reorderedIds.indexOf(alphaId), `Expected Echo ahead of Alpha, got ${JSON.stringify(reorderedIds)}`);
  await page.locator('#pool-save-order').click();
  await page.waitForFunction(() => document.getElementById('pool-message').textContent.includes('排序已保存'));

  const echoAfterReorderText = await page.locator(`[data-account-id="${echoId}"]`).innerText();
  assert.match(echoAfterReorderText, /暂不可接单/);
  assert.match(echoAfterReorderText, /存在待确认或待结算任务/);
  assert.equal(/与排在前面的账号.*为同一上游身份/.test(echoAfterReorderText), false);
  assert.match(echoAfterReorderText, /可用 200/);
  assert.match(echoAfterReorderText, /最新余额 260 · 预占 60/);
  assert.match(echoAfterReorderText, /进行中 \/ 待确认：1/);

  const alphaAfterReorderText = await page.locator(`[data-account-id="${alphaId}"]`).innerText();
  assert.match(alphaAfterReorderText, /暂不可接单/);
  assert.match(alphaAfterReorderText, /与排在前面的账号「隔离同身份副号 Echo」为同一上游身份，已禁止重复参与调度/);
  assert.equal(/存在待确认或待结算任务/.test(alphaAfterReorderText), false);
  assert.match(alphaAfterReorderText, /可用 200/);
  assert.match(alphaAfterReorderText, /最新余额 260 · 预占 60/);
  assert.match(alphaAfterReorderText, /进行中 \/ 待确认：1/);

  assert.equal(await page.locator('#pool-active').innerText(), '2');
  const activeAccountsAfterReorder = await page.locator('#pool-active-accounts').innerText();
  assert.match(activeAccountsAfterReorder, /隔离同身份副号 Echo：1/);
  assert.match(activeAccountsAfterReorder, /隔离主号 Alpha：1/);
  assert.match(activeAccountsAfterReorder, /隔离并发 Delta：1/);
  assert.equal(await page.locator('#pool-next').innerText(), '暂无合格候选');

  await page.locator('#pool-mode').selectOption('fixed');
  await page.locator('#pool-fixed').selectOption(alphaId);
  assert.match(await page.locator('#pool-fixed-reason').innerText(), /不合格 · 与排在前面的账号「隔离同身份副号 Echo」为同一上游身份，已禁止重复参与调度/);
  await page.locator('#pool-fixed').selectOption(echoId);
  assert.match(await page.locator('#pool-fixed-reason').innerText(), /不合格 · 存在待确认或待结算任务/);
  await page.locator('#pool-refresh').click();
  await page.waitForFunction(() => document.getElementById('pool-mode').value === 'auto' && !document.getElementById('pool-settings-fields').disabled);
  checks.push('副号调到主号前面并保存排序后，UI 同步切换两者排重原因并保持共享预占与进行中占位提示');

  // 11. Identity endpoint temporary failure keeps same-credential verified userId & valid balance with warning badge (never green)
  await page.locator('#account-name').fill('隔离身份保留 Zeta');
  await page.locator('#account-cookie').fill('sessionid=virtual-zeta-240; token=secret-zeta-never-leak');
  await page.locator('#pool-create').click();
  await page.waitForFunction(() => document.getElementById('accounts-table').textContent.includes('隔离身份保留 Zeta'));
  const dashWithZeta = await (await fetch(`${serverProc.baseUrl}/account-pool/dashboard`, { headers: { cookie: postRestartCookies } })).json();
  const zetaId = dashWithZeta.accounts.find((a) => a.name === '隔离身份保留 Zeta')?.id;
  assert.ok(zetaId, 'Zeta account id must exist');
  await page.locator(`[data-account-id="${zetaId}"] [data-action="refresh"]`).click();
  await page.waitForFunction(
    (accountId) => document.querySelector(`[data-account-id="${accountId}"] td:nth-child(2) .badge-success`)?.textContent.includes('上游身份已核验'),
    zetaId
  );
  assert.equal(await page.locator('#pool-next').innerText(), '隔离身份保留 Zeta');

  fs.writeFileSync(path.join(root, 'fail-identity-sessions.json'), JSON.stringify(['virtual-zeta-240']));
  await page.locator(`[data-account-id="${zetaId}"] [data-action="refresh"]`).click();
  await page.waitForFunction(
    (accountId) => document.querySelector(`[data-account-id="${accountId}"]`)?.textContent.includes('身份刷新失败：'),
    zetaId
  );
  assert.equal(await page.locator(`[data-account-id="${zetaId}"] td:nth-child(2) .badge-success`).count(), 0);
  assert.match(await page.locator(`[data-account-id="${zetaId}"] td:nth-child(2) .badge-warn`).innerText(), /身份为上次核验 · 本次刷新失败/);
  const zetaFailedText = await page.locator(`[data-account-id="${zetaId}"]`).innerText();
  assert.match(zetaFailedText, /沿用上次核验：上游核验账号 Zeta · ID upstream-zeta-uid/);
  assert.match(zetaFailedText, /上次核验：/);
  assert.match(zetaFailedText, /上次尝试刷新：/);
  assert.match(zetaFailedText, /身份刷新失败：上游身份核验本次刷新失败，已保留当前凭据已核验主体/);
  assert.match(zetaFailedText, /可用 240/);
  assert.match(zetaFailedText, /最新余额 240 · 预占 0/);
  assert.equal(/余额未知或已过期/.test(zetaFailedText), false);
  assert.match(zetaFailedText, /可接新任务/);
  assert.equal(await page.locator('#pool-next').innerText(), '隔离身份保留 Zeta');

  const dashAfterZetaFail = await (await fetch(`${serverProc.baseUrl}/account-pool/dashboard`, { headers: { cookie: postRestartCookies } })).json();
  const zetaDto = dashAfterZetaFail.accounts.find((a) => a.id === zetaId);
  assert.equal(zetaDto?.upstreamIdentity?.verified, true);
  assert.equal(zetaDto?.upstreamIdentity?.userId, 'upstream-zeta-uid');
  assert.equal(zetaDto?.upstreamIdentity?.refreshFailed, true);
  assert.equal(typeof zetaDto?.upstreamIdentity?.refreshError, 'string');
  assert.equal(typeof zetaDto?.upstreamIdentity?.lastRefreshAttemptAt, 'string');

  await page.locator('#account-name').fill('隔离身份副号 Zeta2');
  await page.locator('#account-cookie').fill('sessionid=virtual-zeta-dup; token=secret-zeta2-never-leak');
  await page.locator('#pool-create').click();
  await page.waitForFunction(() => document.getElementById('accounts-table').textContent.includes('隔离身份副号 Zeta2'));
  const dashWithZeta2 = await (await fetch(`${serverProc.baseUrl}/account-pool/dashboard`, { headers: { cookie: postRestartCookies } })).json();
  const zeta2Id = dashWithZeta2.accounts.find((a) => a.name === '隔离身份副号 Zeta2')?.id;
  assert.ok(zeta2Id, 'Zeta2 account id must exist');
  await page.locator(`[data-account-id="${zeta2Id}"] [data-action="refresh"]`).click();
  await page.waitForFunction(
    (accountId) => document.querySelector(`[data-account-id="${accountId}"]`)?.textContent.includes('上游身份已核验'),
    zeta2Id
  );
  assert.match(
    await page.locator(`[data-account-id="${zeta2Id}"]`).innerText(),
    /与排在前面的账号「隔离身份保留 Zeta」为同一上游身份，已禁止重复参与调度/
  );
  fs.unlinkSync(path.join(root, 'fail-identity-sessions.json'));
  checks.push('身份端点暂时失败时 UI 标黄提示“身份为上次核验 · 本次刷新失败”并展示上次尝试与失败原因，不误导绿标、不改写合法余额且继续保留同 userId 排重关联');
  await page.screenshot({ path: path.join(evidenceDir, 'desktop-real.png'), fullPage: true });

  // 11. 390px narrow viewport responsive check
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#pool-refresh').click();
  await page.waitForFunction(() => !document.getElementById('pool-refresh').disabled);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator('.account-table-panel .table-scroll').evaluate((el) => el.scrollWidth > el.clientWidth), true);
  await page.screenshot({ path: path.join(evidenceDir, 'mobile-real.png'), fullPage: true });
  checks.push('390px 窄屏无全页溢出且表格局部可横向滚动');

  assert.equal(apiCalls.some((c) => c.path.includes('/account-pool/select')), false, 'UI must never call /select');
  assert.equal(pageErrors.length, 0, `Page errors: ${pageErrors.join('\n')}`);
  assert.equal(unexpectedConsoleErrors.length, 0, `Console errors: ${unexpectedConsoleErrors.join('\n')}`);
  checks.push('全程零 /select 调用、零未捕获脚本错误');

  const summary = {
    environment: 'Real Koa server + real SQLite (isolated temp DB_PATH) + isolated upstream fixture + virtual credentials; no production DB/upstream',
    node: process.version,
    browser: browser.version(),
    dbPath,
    evidenceDir,
    passed: checks.length,
    checks,
    apiCallCount: apiCalls.length,
    assetStatuses: Object.fromEntries(assetStatuses),
    pageErrors,
    unexpectedConsoleErrors
  };
  fs.writeFileSync(path.join(evidenceDir, 'results.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  if (browser) await browser.close();
  await stopServer(serverProc?.child);
}
