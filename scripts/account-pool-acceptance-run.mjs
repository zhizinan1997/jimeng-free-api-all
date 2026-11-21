#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jimeng-pool-acceptance-')));
const testDir = path.join(repo, 'tests/account-pool-acceptance');
// No inherited DB, cookie, API key, proxy, NODE_OPTIONS or browser profile.
const env = {
  PATH: process.env.PATH, HOME: root, TMPDIR: root, TZ: 'Asia/Shanghai',
  DB_PATH: path.join(root, 'guard.db'), ACCEPTANCE_ROOT: root, ACCEPTANCE_REPO: repo,
  JIMENG_ACCOUNT_POOL_KEY: 'fixture-only-encryption-key-no-production-use',
  ACCOUNT_POOL_ENCRYPTION_KEY: 'fixture-only-encryption-key-no-production-use',
  NODE_OPTIONS: `--require=${JSON.stringify(path.join(testDir, 'network-guard.cjs'))}`,
  JIMENG_BROWSER_TRANSPORT: 'off',
  VERCEL: '1',
};
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'dir');
fs.symlinkSync(path.join(repo, 'public'), path.join(root, 'public'), 'dir');
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'pool-acceptance-isolated', version: '0.0.0' }));
const entry = `export { default as pool } from ${JSON.stringify(path.join(repo, 'src/lib/account-pool.ts'))};
export * as poolModule from ${JSON.stringify(path.join(repo, 'src/lib/account-pool.ts'))};
export { default as routes } from ${JSON.stringify(path.join(repo, 'src/api/routes/account-pool.ts'))};
export * as database from ${JSON.stringify(path.join(repo, 'src/lib/database.ts'))};
export * as auth from ${JSON.stringify(path.join(repo, 'src/api/controllers/auth.ts'))};
export * as context from ${JSON.stringify(path.join(repo, 'src/lib/pool-task-context.ts'))};
export * as assets from ${JSON.stringify(path.join(repo, 'src/lib/pool-task-assets.ts'))};
export { withPoolRoutes } from ${JSON.stringify(path.join(repo, 'src/lib/pool-task-routes.ts'))};
export { jsonHeartbeatResponse } from ${JSON.stringify(path.join(repo, 'src/lib/json-heartbeat.ts'))};
export { default as Request } from ${JSON.stringify(path.join(repo, 'src/lib/request/Request.ts'))};
export { default as server } from ${JSON.stringify(path.join(repo, 'src/lib/server.ts'))};
export { default as allRoutes } from ${JSON.stringify(path.join(repo, 'src/api/routes/index.ts'))};
export { default as imageRoutes } from ${JSON.stringify(path.join(repo, 'src/api/routes/images.ts'))};
export { default as videoRoutes } from ${JSON.stringify(path.join(repo, 'src/api/routes/videos.ts'))};
export { default as audioRoutes, audioCompatRoutes } from ${JSON.stringify(path.join(repo, 'src/api/routes/audios.ts'))};
export { default as chatRoutes } from ${JSON.stringify(path.join(repo, 'src/api/routes/chat.ts'))};`;
const result = await build({
  stdin: { contents: entry, resolveDir: repo, loader: 'ts' },
  outfile: path.join(root, 'subject.cjs'), bundle: true, platform: 'node', format: 'cjs',
  packages: 'external', metafile: true, tsconfig: path.join(repo, 'tsconfig.json'),
  plugins: [{ name: 'isolated-upstream', setup(b) {
    b.onResolve({ filter: /controllers\/(images|videos|audios|chat|text-chat)\.ts$/ }, () => ({ path: path.join(testDir, 'media-route-fixture.ts') }));
    b.onResolve({ filter: /video-reference-upload\.ts$/ }, () => ({ path: path.join(testDir, 'upload-fixture.ts') }));
    b.onResolve({ filter: /(?:^|\/)core\.ts$/ }, () => ({ path: path.join(testDir, 'upstream-fixture.ts') }));
    b.onResolve({ filter: /^mime$/ }, () => ({ path: path.join(repo, 'node_modules/mime/dist/src/index.js') }));
    b.onResolve({ filter: /browser-transport\.ts$/ }, () => ({ path: 'browser', namespace: 'fixture' }));
    b.onResolve({ filter: /(?:^|\/)logger\.ts$/ }, () => ({ path: 'logger', namespace: 'fixture' }));
    b.onLoad({ filter: /upload/, namespace: 'fixture' }, () => ({ contents: 'export async function uploadVideoReference() { throw new Error("NO_UPLOAD_FIXTURE") }', loader: 'js' }));
    b.onLoad({ filter: /browser/, namespace: 'fixture' }, () => ({ contents: 'export default {enabled:false, shouldUse:()=>false, getStatus:async()=>({mode:"off"}), setMode:async()=>{}}', loader: 'js' }));
    b.onLoad({ filter: /logger/, namespace: 'fixture' }, () => ({ contents: 'export default new Proxy({}, {get:(_,level)=>(...args)=>{(globalThis.__poolLogs ||= []).push({level,args})}})', loader: 'js' }));
  } }],
});
const retryResult = await build({
  stdin: { contents: `export * as images from ${JSON.stringify(path.join(repo, 'src/api/controllers/images.ts'))}; export * as videos from ${JSON.stringify(path.join(repo, 'src/api/controllers/videos.ts'))};`, resolveDir: repo, loader: 'ts' },
  outfile: path.join(root, 'retry-subject.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external', metafile: true, tsconfig: path.join(repo, 'tsconfig.json'),
  plugins: [{ name: 'isolated-media-upstream', setup(b) {
    b.onResolve({ filter: /(?:^|\/)core\.ts$/ }, () => ({ path: path.join(testDir, 'upstream-fixture.ts') }));
    b.onResolve({ filter: /(?:^|\/)models\.ts$/ }, () => ({ path: path.join(testDir, 'model-fixture.ts') }));
    b.onResolve({ filter: /video-reference-upload\.ts$/ }, () => ({ path: 'upload', namespace: 'fixture' }));
    b.onResolve({ filter: /(?:^|\/)logger\.ts$/ }, () => ({ path: 'logger', namespace: 'fixture' }));
    b.onLoad({ filter: /upload/, namespace: 'fixture' }, () => ({ contents: 'export async function uploadVideoReference() { throw new Error("NO_UPLOAD_FIXTURE") }', loader: 'js' }));
    b.onLoad({ filter: /logger/, namespace: 'fixture' }, () => ({ contents: 'export default new Proxy({}, {get:(_,level)=>(...args)=>{(globalThis.__poolLogs ||= []).push({level,args})}})', loader: 'js' }));
  } }],
});
const coreResult = await build({
  stdin: { contents: `export {request} from ${JSON.stringify(path.join(repo, 'src/api/controllers/core.ts'))}; export * as context from ${JSON.stringify(path.join(repo, 'src/lib/pool-task-context.ts'))};`, resolveDir: repo, loader: 'ts' },
  outfile: path.join(root, 'core-subject.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external', metafile: true, tsconfig: path.join(repo, 'tsconfig.json'),
  plugins: [{ name: 'isolated-core-transport', setup(b) {
    b.onResolve({ filter: /browser-transport\.ts$/ }, () => ({ path: 'browser', namespace: 'fixture' }));
    b.onResolve({ filter: /(?:^|\/)logger\.ts$/ }, () => ({ path: 'logger', namespace: 'fixture' }));
    b.onLoad({ filter: /browser/, namespace: 'fixture' }, () => ({ contents: 'export default {enabled:false, shouldUse:()=>false}', loader: 'js' }));
    b.onLoad({ filter: /logger/, namespace: 'fixture' }, () => ({ contents: 'export default new Proxy({}, {get:(_,level)=>(...args)=>{(globalThis.__poolLogs ||= []).push({level,args})}})', loader: 'js' }));
  } }],
});
const seedance25Result = await build({
  stdin: { contents: `export * as models from ${JSON.stringify(path.join(repo, 'src/api/controllers/models.ts'))};
export * as videos from ${JSON.stringify(path.join(repo, 'src/api/controllers/videos.ts'))};
export * as policy from ${JSON.stringify(path.join(repo, 'src/api/controllers/seedance25-policy.ts'))};`, resolveDir: repo, loader: 'ts' },
  outfile: path.join(root, 'seedance25-subject.cjs'), bundle: true, platform: 'node', format: 'cjs',
  packages: 'external', metafile: true, tsconfig: path.join(repo, 'tsconfig.json'),
  plugins: [{ name: 'isolated-seedance25-upstream', setup(b) {
    b.onResolve({ filter: /(?:^|\/)core\.ts$/ }, () => ({ path: path.join(testDir, 'upstream-fixture.ts') }));
    b.onResolve({ filter: /video-reference-upload\.ts$/ }, () => ({ path: path.join(testDir, 'upload-fixture.ts') }));
    b.onResolve({ filter: /(?:^|\/)logger\.ts$/ }, () => ({ path: 'logger', namespace: 'fixture' }));
    b.onResolve({ filter: /browser-transport\.ts$/ }, () => ({ path: 'browser', namespace: 'fixture' }));
    b.onLoad({ filter: /browser/, namespace: 'fixture' }, () => ({ contents: 'export default {enabled:false, shouldUse:()=>false}', loader: 'js' }));
    b.onLoad({ filter: /logger/, namespace: 'fixture' }, () => ({ contents: 'export default new Proxy({}, {get:(_,level)=>(...args)=>{(globalThis.__poolLogs ||= []).push({level,args})}})', loader: 'js' }));
  } }],
});
const chainEntry = `export { default as pool } from ${JSON.stringify(path.join(repo, 'src/lib/account-pool.ts'))};
export * as database from ${JSON.stringify(path.join(repo, 'src/lib/database.ts'))};
export { default as server } from ${JSON.stringify(path.join(repo, 'src/lib/server.ts'))};
export { default as allRoutes } from ${JSON.stringify(path.join(repo, 'src/api/routes/index.ts'))};
export { default as imageRoutes } from ${JSON.stringify(path.join(repo, 'src/api/routes/images.ts'))};
export { default as videoRoutes } from ${JSON.stringify(path.join(repo, 'src/api/routes/videos.ts'))};
export { default as audioRoutes, audioCompatRoutes } from ${JSON.stringify(path.join(repo, 'src/api/routes/audios.ts'))};
export { default as chatRoutes } from ${JSON.stringify(path.join(repo, 'src/api/routes/chat.ts'))};
export { default as browserTransport } from ${JSON.stringify(path.join(repo, 'src/lib/browser-transport.ts'))};
export { default as Request } from ${JSON.stringify(path.join(repo, 'src/lib/request/Request.ts'))};
export { ownerHash } from ${JSON.stringify(path.join(repo, 'src/lib/pool-task-context.ts'))};
export { createPoolMaintenance } from ${JSON.stringify(path.join(repo, 'src/lib/pool-maintenance.ts'))};
export { recoverStoredPoolTask } from ${JSON.stringify(path.join(repo, 'src/lib/pool-task-recovery.ts'))};`;
const chainResult = await build({
  stdin: { contents: chainEntry, resolveDir: repo, loader: 'ts' },
  outfile: path.join(root, 'chain-subject.cjs'), bundle: true, platform: 'node', format: 'cjs',
  packages: 'external', metafile: true, tsconfig: path.join(repo, 'tsconfig.json'),
  plugins: [{ name: 'isolated-chain-agent-transport', setup(b) {
    b.onResolve({ filter: /^mime$/ }, () => ({ path: path.join(repo, 'node_modules/mime/dist/src/index.js') }));
    b.onResolve({ filter: /(?:^|\/)logger\.ts$/ }, () => ({ path: 'logger', namespace: 'fixture' }));
    b.onLoad({ filter: /logger/, namespace: 'fixture' }, () => ({ contents: 'export default new Proxy({}, {get:(_,level)=>(...args)=>{(globalThis.__poolLogs ||= []).push({level,args})}})', loader: 'js' }));
    b.onLoad({ filter: /agent-browser-transport\.ts$/ }, () => ({ loader: 'ts', contents: `
      import { PassThrough, Readable } from 'node:stream';
      const sse = (event, data) => 'event: ' + event + '\\ndata: ' + JSON.stringify(data) + '\\n\\n';
      export async function openAgentBrowserTransport(pairs) {
        const fixture = globalThis.__poolTextFixture;
        fixture.cookies.push(pairs);
        const sub = new PassThrough();
        return {
          createWorkspace: async () => 1,
          subscribe: async () => { sub.write(sse('system', { type: 'subscribe_handshake', session_id: 'test' })); return sub; },
          submit: async body => {
            fixture.submits.push(body);
            if (fixture.fail) throw new Error('simulated text submission response lost');
            setTimeout(() => sub.end(sse('message', { id: 'answer', author: { role: 'assistant' }, metadata: { conversation_id: body.conversation_id }, content: { content_type: 'text', content_parts: [{ text: 'fixture answer' }] } }) + sse('system', { type: 'stream_complete', conversation_id: body.conversation_id })), 1);
            return Readable.from([sse('handshake', { conversation_id: body.conversation_id }), sse('stream_complete', { success: true, error_code: '0' })]);
          },
          close: async () => { sub.destroy(); }
        };
      }` }));
  } }],
});
const sources = {};
for (const input of new Set([...Object.keys(result.metafile.inputs), ...Object.keys(retryResult.metafile.inputs), ...Object.keys(coreResult.metafile.inputs), ...Object.keys(seedance25Result.metafile.inputs), ...Object.keys(chainResult.metafile.inputs)])) {
  const file = path.resolve(repo, input);
  if (fs.existsSync(file) && fs.statSync(file).isFile()) sources[path.relative(repo, file)] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ startedAt: new Date().toISOString(), node: process.version, head, sources, isolation: 'temporary DB, synthetic credentials, replaced core, process network guard; no application initialize' }, null, 2));
console.log(`Acceptance evidence: ${root}`);
const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', path.join(testDir, 'acceptance.test.mjs')], { cwd: root, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
fs.writeFileSync(path.join(root, 'test-output.tap'), (run.stdout || '') + (run.stderr || ''));
fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ exitCode: run.status, signal: run.signal, error: run.error?.message || null }, null, 2));
process.stdout.write(run.stdout || '');
process.stderr.write(run.stderr || '');
console.log(`Retained isolated evidence: ${root}`);
process.exitCode = run.status ?? 1;
