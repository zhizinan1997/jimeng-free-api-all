#!/usr/bin/env node
// Read-only candidate verification: isolated test databases and a unique build output.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'jimeng-pool-integrated-'));
const steps = [];
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function sourceManifest() {
  const result = spawnSync('git', ['ls-files', '-cz', '--others', '--exclude-standard'], { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw Error('Cannot enumerate candidate source files');
  return Object.fromEntries([...new Set(result.stdout.split('\0').filter(name => name && name !== '.DS_Store' && !name.startsWith('docs/')))].sort()
    .filter(name => fs.existsSync(path.join(repo, name)) && fs.statSync(path.join(repo, name)).isFile())
    .map(name => [name, hash(fs.readFileSync(path.join(repo, name)))]));
}
const before = sourceManifest();
fs.writeFileSync(path.join(evidence, 'source-manifest.json'), JSON.stringify(before, null, 2));
const unitFiles = fs.readdirSync(path.join(repo, 'src/lib')).filter(file => file.endsWith('.test.mjs')).sort().map(file => `src/lib/${file}`);
const commands = [
  ['unit', 'node', ['--test', ...unitFiles, 'src/api/controllers/video-history.test.mjs']],
  ['seedance-preservation', 'bun', ['test', 'src/api/controllers/seedance25.test.mjs']],
  ['independent-acceptance', 'node', ['scripts/account-pool-acceptance-run.mjs']],
  ['ui-real', 'node', ['tests/account-pool-ui/integration.test.mjs']],
  ['startup', 'node', ['tests/account-pool-ui/startup.test.mjs']],
  ['types', 'npx', ['tsc', '--noEmit', '--skipLibCheck']],
  ['build', 'npm', ['run', 'build', '--', '--out-dir', path.join(evidence, 'build')]],
  ['whitespace', 'git', ['diff', '--check']],
];
for (const [name, command, args] of commands) {
  const log = path.join(evidence, `${name}.log`);
  const fd = fs.openSync(log, 'w');
  const start = Date.now();
  const result = spawnSync(command, args, {
    cwd: repo, env: { ...process.env, POOL_UI_EVIDENCE_DIR: path.join(evidence, name) },
    stdio: ['ignore', fd, fd], timeout: 300_000,
  });
  fs.closeSync(fd);
  steps.push({ name, command: [command, ...args], code: result.status, signal: result.signal, error: result.error?.message || null, elapsedMs: Date.now() - start, log });
  console.log(`${name}: ${result.status === 0 ? 'PASS' : 'FAIL'} (${Date.now() - start}ms)`);
}
const after = sourceManifest();
const stable = JSON.stringify(before) === JSON.stringify(after);
const build = path.join(evidence, 'build');
const artifactHashes = {};
for (const file of ['index.js', 'index.js.map', 'index.cjs', 'index.cjs.map', 'index.d.ts', 'index.d.cts', 'index.html', 'account-pool-ui.js', 'account-pool-ui.css']) {
  const full = path.join(build, file);
  if (fs.existsSync(full)) artifactHashes[file] = hash(fs.readFileSync(full));
}
const report = {
  verifiedAt: new Date().toISOString(), environment: 'local isolated databases and virtual upstream; no production deployment or paid generation',
  node: process.version, repo, evidence, sourceStable: stable, sourceFingerprint: hash(JSON.stringify(before)),
  passed: stable && steps.every(step => step.code === 0), steps, artifactHashes,
};
fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
console.log(`Evidence: ${evidence}`);
if (!stable) console.error('Source changed during verification; this run cannot be promoted.');
process.exitCode = report.passed ? 0 : 1;
