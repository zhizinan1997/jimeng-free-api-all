// Full src/index.ts startup smoke test with temporary cwd/DB/credentials, loopback-only guard, and pool-maintenance checks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(testDir, '../..');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jimeng-pool-ui-int-startup-')));
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

const startupBundle = path.join(root, 'startup-entry.mjs');
const seedBundle = path.join(root, 'seed-entry.mjs');
const esmBanner = { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" };
const isolatedPlugin = {
  name: 'isolated-upstream',
  setup(b) {
    b.onResolve({ filter: /(?:^|\/)core\.ts$/ }, () => ({ path: fixturePath }));
  }
};

await build({
  entryPoints: [path.join(repo, 'src/index.ts')],
  outfile: startupBundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  banner: esmBanner,
  tsconfig: path.join(repo, 'tsconfig.json'),
  plugins: [isolatedPlugin]
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
  plugins: [isolatedPlugin]
});

const sharedEnv = (port) => ({
  PATH: process.env.PATH,
  HOME: root,
  TMPDIR: root,
  TZ: 'Asia/Shanghai',
  DB_PATH: dbPath,
  UI_INTEGRATION_ROOT: root,
  JIMENG_ACCOUNT_POOL_KEY: 'virtual-ui-startup-encryption-key',
  ACCOUNT_POOL_ENCRYPTION_KEY: 'virtual-ui-startup-encryption-key',
  JIMENG_BROWSER_TRANSPORT: 'off',
  SERVER_HOST: '127.0.0.1',
  SERVER_PORT: String(port),
  NODE_OPTIONS: `--require=${JSON.stringify(guardPath)}`
});

const seedScript = `
  import { pathToFileURL } from 'node:url';
  (async () => {
    const { pool } = await import(pathToFileURL(${JSON.stringify(seedBundle)}).href);
    const gamma = pool.create({ name: '启动结算 Gamma', cookie: 'sessionid=virtual-gamma-199; token=secret-gamma-startup' });
    await pool.refreshStatus(gamma.id);
    pool.updateSettings({ mode: 'auto', fixedAccountId: null, threshold: 180, balanceMaxAgeSeconds: 60, revision: pool.getSettings().revision });
    const gammaLease = await pool.acquireTask({
      requestId: 'startup-settle-1',
      ownerHash: 'startup-owner',
      requestFingerprint: 'fp-startup-settle-1',
      kind: 'image',
      model: 'jimeng-4.5',
      estimatedCredits: 20
    });
    pool.transitionTask(gammaLease.taskId, { state: 'submitting' });
    pool.transitionTask(gammaLease.taskId, {
      state: 'succeeded',
      upstreamTaskId: 'up-startup-gamma-done',
      result: { kind: 'image', urls: ['http://127.0.0.1/startup-mock.png'] }
    });

    const delta = pool.create({ name: '启动待确认 Delta', cookie: 'sessionid=virtual-delta-300; token=secret-delta-startup' });
    await pool.refreshStatus(delta.id);
    const deltaLease = await pool.acquireTask({
      requestId: 'startup-unknown-1',
      ownerHash: 'startup-owner',
      requestFingerprint: 'fp-startup-unknown-1',
      kind: 'video',
      model: 'jimeng-video-3.0',
      estimatedCredits: null
    });
    pool.transitionTask(deltaLease.taskId, { state: 'submitting' });
    pool.transitionTask(deltaLease.taskId, { state: 'unknown' });

    // Create Alpha after acquireTask calls so it stays unrefreshed until src/index.ts boots pool-maintenance
    const alpha = pool.create({ name: '启动主号 Alpha', cookie: 'sessionid=virtual-alpha-250; token=secret-alpha-startup' });
    const beforeDash = pool.getDashboard();
    const alphaBefore = beforeDash.accounts.find((a) => a.id === alpha.id);
    if (alphaBefore?.status?.totalCredit !== null || alphaBefore?.upstreamIdentity?.verified !== false) {
      throw new Error('Expected Alpha to be stale and unverified prior to startup');
    }
    console.log(JSON.stringify({ alphaId: alpha.id, gammaId: gamma.id, deltaId: delta.id }));
  })().catch((err) => { console.error(err); process.exit(1); });
`;

const port = await allocateFreePort();
const seedRun = spawnSync(process.execPath, ['--input-type=module', '-e', seedScript], {
  cwd: root,
  env: sharedEnv(port),
  encoding: 'utf8'
});
assert.equal(seedRun.status, 0, seedRun.stderr || seedRun.stdout);
const seeded = JSON.parse(seedRun.stdout.trim().split('\n').pop());

async function startBundledIndex(listenPort) {
  const logs = [];
  const child = spawn(process.execPath, [startupBundle], {
    cwd: root,
    env: sharedEnv(listenPort),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  const baseUrl = `http://127.0.0.1:${listenPort}`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early (${child.exitCode}):\n${logs.join('')}`);
    try {
      const res = await fetch(`${baseUrl}/dashboard/status`);
      if (res.ok && logs.join('').includes('Service startup completed')) {
        return { child, baseUrl, logs };
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill('SIGKILL');
  throw new Error(`Startup timed out:\n${logs.join('')}`);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return child?.exitCode ?? null;
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  child.kill('SIGINT');
  const code = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => { child.kill('SIGKILL'); resolve(-1); }, 5000))
  ]);
  return code;
}

let serverProc;
const checks = [];
try {
  serverProc = await startBundledIndex(port);
  checks.push('真实 src/index.ts 打包并在临时 cwd 与 DB_PATH 完成初始化及 HTTP 服务监听');

  const logFiles = fs.existsSync(path.join(root, 'logs')) ? fs.readdirSync(path.join(root, 'logs')) : [];
  assert.ok(logFiles.some((f) => f.endsWith('.log')), `Expected log file in temp cwd logs dir, got ${JSON.stringify(logFiles)}`);

  const [htmlRes, jsRes, cssRes, unauthRes] = await Promise.all([
    fetch(`${serverProc.baseUrl}/`),
    fetch(`${serverProc.baseUrl}/account-pool-ui.js`),
    fetch(`${serverProc.baseUrl}/account-pool-ui.css`),
    fetch(`${serverProc.baseUrl}/account-pool/dashboard`)
  ]);
  assert.equal(htmlRes.status, 200);
  const htmlBody = await htmlRes.text();
  assert.match(htmlBody, /account-pool-ui\.js/);
  assert.match(htmlBody, /account-pool-ui\.css/);

  assert.equal(jsRes.status, 200);
  assert.match(jsRes.headers.get('content-type') || '', /javascript/);
  assert.equal(await jsRes.text(), fs.readFileSync(path.join(repo, 'public/account-pool-ui.js'), 'utf8'));

  assert.equal(cssRes.status, 200);
  assert.match(cssRes.headers.get('content-type') || '', /css/);
  assert.equal(await cssRes.text(), fs.readFileSync(path.join(repo, 'public/account-pool-ui.css'), 'utf8'));

  assert.equal(unauthRes.status, 401);
  const unauthJson = await unauthRes.json();
  assert.equal(unauthJson.error, '未登录');
  checks.push('实际 HTTP 服务静态资源 (/, /account-pool-ui.js, /account-pool-ui.css) 200 且未登录 /account-pool/dashboard 返回 401');

  const setupRes = await fetch(`${serverProc.baseUrl}/dashboard/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'virtual-startup-admin', password: 'virtual-startup-pass' })
  });
  assert.equal(setupRes.status, 200);

  const loginRes = await fetch(`${serverProc.baseUrl}/dashboard/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'virtual-startup-admin', password: 'virtual-startup-pass' })
  });
  assert.equal(loginRes.status, 200);
  const setCookie = loginRes.headers.get('set-cookie') || '';
  const sessionCookie = setCookie.split(';')[0];
  assert.match(sessionCookie, /^session=/);

  let dash = null;
  const pollDeadline = Date.now() + 8000;
  while (Date.now() < pollDeadline) {
    const res = await fetch(`${serverProc.baseUrl}/account-pool/dashboard`, {
      headers: { cookie: sessionCookie }
    });
    assert.equal(res.status, 200);
    const candidate = await res.json();
    const alpha = candidate.accounts.find((a) => a.id === seeded.alphaId);
    const gamma = candidate.accounts.find((a) => a.id === seeded.gammaId);
    if (alpha?.upstreamIdentity?.verified && gamma?.scheduling?.activeTaskCount === 0) {
      dash = candidate;
      break;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(dash, `Timed out waiting for startup pool-maintenance tick.\nLogs:\n${serverProc.logs.join('')}`);

  const serialized = JSON.stringify(dash);
  for (const secret of ['virtual-alpha-250', 'virtual-gamma-199', 'virtual-delta-300', 'secret-alpha-startup', 'secret-gamma-startup', 'secret-delta-startup']) {
    assert.equal(serialized.includes(secret), false, `Secret leaked in dashboard response: ${secret}`);
  }

  const alpha = dash.accounts.find((a) => a.id === seeded.alphaId);
  assert.equal(alpha.status.totalCredit, 250);
  assert.equal(alpha.upstreamIdentity.verified, true);
  assert.equal(alpha.upstreamIdentity.userId, 'upstream-alpha-uid');
  assert.equal(alpha.scheduling.eligible, true);

  const gamma = dash.accounts.find((a) => a.id === seeded.gammaId);
  assert.equal(gamma.status.totalCredit, 199);
  assert.equal(gamma.scheduling.activeTaskCount, 0);
  const gammaTask = dash.tasks.find((t) => t.requestId === 'startup-settle-1');
  assert.equal(gammaTask?.state, 'succeeded');
  assert.equal(gammaTask?.settling, false);

  const delta = dash.accounts.find((a) => a.id === seeded.deltaId);
  assert.equal(delta.scheduling.activeTaskCount, 1);
  assert.equal(delta.scheduling.unknownCostBusy, true);
  const deltaTask = dash.tasks.find((t) => t.requestId === 'startup-unknown-1');
  assert.equal(deltaTask?.state, 'unknown');
  assert.equal(deltaTask?.upstreamTaskId, null);

  assert.equal(dash.summary.activeTaskCount, 1);
  assert.equal(dash.summary.nextAccountId, seeded.gammaId);
  assert.ok(dash.events.some((e) => e.type === 'balance_refreshed' && e.accountId === seeded.alphaId));
  assert.ok(dash.events.some((e) => e.type === 'balance_settled' && e.accountId === seeded.gammaId));
  checks.push('启动时 pool-maintenance 自动刷新过期账号余额/身份 (Alpha=250)、结算已完成任务 (Gamma settling->released) 并保留无上游 ID 的 unknown 独占任务 (Delta)');

  const exitCode = await stopServer(serverProc.child);
  serverProc = null;
  assert.equal(exitCode, 0, `Expected graceful SIGINT exit code 0, got ${exitCode}`);
  checks.push('收到 SIGINT 后触发退出清理并正常结束');

  const summary = {
    environment: 'Bundled real src/index.ts + temporary cwd & DB_PATH + isolated upstream fixture + loopback guard; no production DB/upstream',
    node: process.version,
    cwd: root,
    dbPath,
    evidenceDir,
    passed: checks.length,
    checks
  };
  fs.writeFileSync(path.join(evidenceDir, 'results.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await stopServer(serverProc?.child);
}
