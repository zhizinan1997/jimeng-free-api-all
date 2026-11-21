#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(testDir, '../..');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jimeng-pool-acceptance-B-round2-')));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const guard = path.join(repo, 'tests/account-pool-acceptance/network-guard.cjs');
const sources = {};
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'dir');
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'B-isolated', version: '0.0.0' }));
const exports = {
  pool: 'src/lib/account-pool.ts', db: 'src/lib/database.ts',
  imageRoutes: 'src/api/routes/images.ts', videoRoutes: 'src/api/routes/videos.ts',
  audioRoutes: 'src/api/routes/audios.ts', chatRoutes: 'src/api/routes/chat.ts',
  browserTransport: 'src/lib/browser-transport.ts', Request: 'src/lib/request/Request.ts',
};
const entry = Object.entries(exports).map(([name, file]) => `export { default as ${name} } from ${JSON.stringify(path.join(repo, file))};`).join('\n')
  + `\nexport { audioCompatRoutes } from ${JSON.stringify(path.join(repo, 'src/api/routes/audios.ts'))};`
  + `\nexport { ownerHash, currentPoolTask } from ${JSON.stringify(path.join(repo, 'src/lib/pool-task-context.ts'))};`;
const built = await build({
  stdin: { contents: entry, resolveDir: repo, loader: 'ts' }, outfile: path.join(root, 'subject.cjs'),
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', metafile: true,
  tsconfig: path.join(repo, 'tsconfig.json'), logLevel: 'silent',
  plugins: [{ name: 'B-transport-only-isolation', setup(b) {
    b.onResolve({ filter: /agent-browser-transport\.ts$/ }, () => ({ path: path.join(testDir, 'B-agent-fixture.ts') }));
    b.onResolve({ filter: /^mime$/ }, () => ({ path: path.join(repo, 'node_modules/mime/dist/src/index.js') }));
    b.onResolve({ filter: /(?:^|\/)logger\.ts$/ }, () => ({ path: 'logger', namespace: 'B-fixture' }));
    b.onLoad({ filter: /logger/, namespace: 'B-fixture' }, () => ({ loader: 'js', contents: 'export default new Proxy({}, {get:()=>()=>{}});' }));
  } }],
});
for (const input of Object.keys(built.metafile.inputs)) {
  const file = path.resolve(repo, input);
  if (fs.existsSync(file)) sources[path.relative(repo, file)] = hash(file);
}
for (const file of [...fs.readdirSync(testDir).filter(x => x.startsWith('B-')).map(x => path.join(testDir, x)), guard, path.join(repo, 'package.json'), path.join(repo, 'tsconfig.json')]) {
  sources[path.relative(repo, file)] = hash(file);
}
const priorDirectory = process.env.B_PRIOR_EVIDENCE_DIR;
let oldEvidence = { directory: null, available: false };
if (priorDirectory !== undefined) {
  if (!priorDirectory.trim()) throw new Error('B_PRIOR_EVIDENCE_DIR must name a legacy evidence directory');
  const existing = path.resolve(priorDirectory);
  const priorManifest = path.join(existing, 'manifest.json');
  const priorTap = path.join(existing, 'test-output.tap');
  const prior = JSON.parse(fs.readFileSync(priorManifest));
  const inputs = Object.entries(prior.sources);
  const differences = inputs.filter(([file, value]) => !fs.existsSync(path.join(repo, file)) || hash(path.join(repo, file)) !== value).map(([file]) => file);
  oldEvidence = { directory: existing, available: true, manifestSha256: hash(priorManifest), tapSha256: hash(priorTap),
    head: prior.head, comparedInputs: inputs.length, differences,
    limitation: 'Previous manifest did not hash scenario.mjs, acceptance.test.mjs or runner.' };
}
const manifest = {
  startedAt: new Date().toISOString(), head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim(),
  node: process.version, repo, sources, bundleSha256: hash(path.join(root, 'subject.cjs')),
  oldEvidence,
  isolation: 'No initialize import; temporary DB; clean child environment; synthetic credential/transport; net/tls/http/https/dns/fetch/WebSocket blocked before import; real routes/controllers/core/store; no dist mutation',
};
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`B evidence: ${root}`);
const env = { PATH: process.env.PATH, TMPDIR: root, TZ: 'Asia/Shanghai', ACCEPTANCE_ROOT: root,
  DB_PATH: path.join(root, 'guard.db'), B_ROOT: root,
  JIMENG_ACCOUNT_POOL_KEY: 'B-round2-synthetic-encryption-key',
  JIMENG_BROWSER_TRANSPORT: 'off', JIMENG_AGENT_TIMEOUT_MS: '5000', VERCEL: '1',
  NODE_OPTIONS: `--require=${JSON.stringify(guard)}` };
const scenarios = [
  ...['image', 'video', 'audio', 'text'].map(kind => [`affinity-${kind}`, [['affinity', kind]]]),
  ...['image', 'video', 'audio', 'text'].map(kind => [`unknown-${kind}`, [['unknown', kind]]]),
  ...['image', 'video', 'audio', 'text'].map(kind => [`restart-${kind}`, [['restart-write', kind], ['restart-read', kind]]]),
  ['restart-text-saved', [['saved-write', 'text'], ['restart-read', 'text']]],
  ['assets', [['assets-write', 'audio'], ['assets-read', 'audio']]],
  ['compat-video', [['compat-video', 'video']]],
  ['fixed-entrypoints', [['fixed-entrypoints', 'image']]],
  ['restart-audio-compat', [['compat-audio-write', 'audio'], ['compat-audio-read', 'audio']]],
  ['restart-submit-unconfirmed', [['unconfirmed-write', 'video'], ['unconfirmed-read', 'video']]],
];
const selected = process.argv.slice(2);
for (const name of selected) if (!scenarios.some(([scenario]) => scenario === name)) throw new Error(`Unknown B scenario: ${name}`);
const result = { exitCode: 0, scenarios: [] };
for (const [name, steps] of scenarios.filter(([name]) => selected.length === 0 || selected.includes(name))) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  const item = { name, steps: [] };
  for (const [action, kind] of steps) {
    const args = [path.join(testDir, 'B-scenario.mjs'), action, kind];
    const run = spawnSync(process.execPath, args, { cwd: root,
      env: { ...env, DB_PATH: path.join(dir, 'test.db'), B_CASE_DIR: dir }, encoding: 'utf8', timeout: 45000, maxBuffer: 1024 * 1024 });
    fs.writeFileSync(path.join(dir, `${action}.log`), (run.stdout || '') + (run.stderr || ''));
    item.steps.push({ action, kind, exitCode: run.status, signal: run.signal, error: run.error?.message || null, command: [process.execPath, ...args] });
    console.log(`${name}/${action}: ${run.status === 0 ? 'PASS' : 'FAIL'}`);
    if (run.status !== 0) { result.exitCode = 1; console.log((run.stdout || '') + (run.stderr || '')); break; }
  }
  result.scenarios.push(item);
}
manifest.inputDifferencesAfterRun = Object.entries(sources).filter(([file, value]) => hash(path.join(repo, file)) !== value).map(([file]) => file);
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
console.log(`B retained evidence: ${root}`);
process.exitCode = result.exitCode;
