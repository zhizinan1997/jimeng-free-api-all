// Free transport acceptance: mock generation only, isolated ports and Caddy container.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import assert from 'node:assert/strict';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, 'package.json'));
const { build } = require('esbuild');
const Koa = require('koa');
const mime = (await import('mime')).default;
const duration = Number(process.env.VIDEO_TEST_DURATION_MS || 315000);
const idle = Number(process.env.VIDEO_TEST_IDLE_MS || 300000);
const interval = Number(process.env.VIDEO_TEST_HEARTBEAT_MS || 15000);
const useHTTP2 = process.env.VIDEO_TEST_HTTP2 === '1';
assert(duration > idle && idle > interval * 2);
const bundled = await build({
  stdin: { contents: "export {jsonHeartbeatResponse} from './src/lib/json-heartbeat.ts'; export {default as Response} from './src/lib/response/Response.ts';", resolveDir: root },
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
  plugins: [{ name: 'isolate-side-effects', setup(b) {
    b.onLoad({ filter: /[/\\]lib[/\\]util\.ts$/ }, () => ({ contents: 'export default {timestamp:Date.now};', loader: 'ts' }));
    b.onLoad({ filter: /[/\\]lib[/\\]logger\.ts$/ }, () => ({ contents: 'export default {error:()=>{},info:()=>{},warn:()=>{}};', loader: 'ts' }));
  } }],
});
const module = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(name => name === 'mime' ? mime : require(name), module, module.exports);
const { jsonHeartbeatResponse, Response } = module.exports;
const result = { created: 1, data: [{ url: 'https://example.invalid/mock-video.mp4', revised_prompt: 'free fixture' }] };
const counts = { silent: 0, heartbeat: 0 };
const app = new Koa();
app.use(async ctx => {
  const kind = ctx.path === '/heartbeat' ? 'heartbeat' : 'silent';
  const operation = async () => {
    counts[kind]++;
    await new Promise(resolve => setTimeout(resolve, duration));
    return result;
  };
  const value = kind === 'heartbeat' ? await jsonHeartbeatResponse(operation, interval) : await operation();
  if (Response.isInstance(value)) value.injectTo(ctx);
  else ctx.body = value;
});
const server = await new Promise(resolve => { const s = app.listen(0, '0.0.0.0', () => resolve(s)); });
const upstreamPort = server.address().port;
const container = `video-json-acceptance-${process.pid}`;
const dir = join(root, 'output', container);
mkdirSync(dir, { recursive: true });
const configPath = join(dir, 'Caddyfile');
writeFileSync(configPath, `{\n admin off\n auto_https ${useHTTP2 ? 'disable_redirects' : 'off'}\n}\n${useHTTP2 ? 'https://localhost {\n tls internal' : ':80 {'}\n respond /__ready 204\n encode zstd gzip\n reverse_proxy host.docker.internal:${upstreamPort}\n}\n`);
let started = false;
function request(port, path) {
  if (useHTTP2) return new Promise(resolve => {
    const start = performance.now(), chunks = [], arrivals = [];
    let headers;
    // This trust exception is only for the isolated container's ephemeral certificate.
    const session = http2.connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false, servername: 'localhost' });
    const finish = value => { session.destroy(); resolve(value); };
    session.on('error', err => finish({completed:false, elapsedMs:performance.now()-start,error:err.message,arrivals}));
    const req = session.request({ ':path': path, ':authority': 'localhost', 'accept-encoding': 'gzip, zstd' });
    req.on('response', value => { headers = value; });
    req.on('data', value => { chunks.push(value); arrivals.push(performance.now()-start); });
    req.on('end', () => finish({completed:true,elapsedMs:performance.now()-start,status:headers[':status'],headers,arrivals,text:Buffer.concat(chunks).toString()}));
    req.on('error', err => finish({completed:false,elapsedMs:performance.now()-start,error:err.message,arrivals}));
    req.setTimeout(idle, () => req.destroy(new Error('simulated downstream idle timeout')));
    req.end();
  });
  return new Promise(resolve => {
    const start = performance.now();
    const chunks = [];
    const arrivals = [];
    let headers;
    const req = http.get({ host: '127.0.0.1', port, path, headers: { 'Accept-Encoding': 'gzip, zstd' } }, res => {
      headers = res.headers;
      res.on('data', chunk => { chunks.push(chunk); arrivals.push(performance.now() - start); });
      res.on('end', () => resolve({ completed: true, elapsedMs: performance.now() - start, status: res.statusCode, headers, arrivals, text: Buffer.concat(chunks).toString() }));
      res.on('error', err => resolve({ completed: false, elapsedMs: performance.now() - start, error: err.message, arrivals }));
    });
    req.setTimeout(idle, () => req.destroy(new Error('simulated downstream idle timeout')));
    req.on('error', err => resolve({ completed: false, elapsedMs: performance.now() - start, error: err.message, arrivals }));
  });
}
try {
  const containerPort = useHTTP2 ? 443 : 80;
  execFileSync('docker', ['run', '-d', '--rm', '--name', container, '-p', `127.0.0.1::${containerPort}`, '-v', `${configPath}:/etc/caddy/Caddyfile:ro`, 'caddy:2.10.2-alpine'], { stdio: 'pipe' });
  started = true;
  const port = Number(execFileSync('docker', ['port', container, `${containerPort}/tcp`], { encoding: 'utf8' }).trim().split(':').at(-1));
  // Container startup is bounded independently of the long response test.
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    // Docker can accept TCP before Caddy starts; require the HTTP readiness route.
    ready = await new Promise(resolve => { const r = (useHTTP2 ? https : http).get({host:'127.0.0.1',port,path:'/__ready',headers:{host:'localhost'},rejectUnauthorized:false,servername:'localhost'}, res => {res.resume();resolve(res.statusCode === 204);}); r.setTimeout(500,()=>r.destroy()); r.once('error',()=>resolve(false)); });
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, 'isolated Caddy failed readiness');
  console.log(JSON.stringify({ phase: 'started', protocol:useHTTP2?'h2':'http/1.1', upstreamPort, caddyPort: port, duration, idle, interval, externalGenerations: 0 }));
  const [silent, heartbeat] = await Promise.all([request(port, '/silent'), request(port, '/heartbeat')]);
  assert.equal(silent.completed, false, 'the silent control must hit downstream idle timeout');
  assert.match(silent.error, /idle timeout/);
  assert.equal(silent.arrivals.length, 0);
  assert.equal(heartbeat.completed, true);
  assert.equal(heartbeat.status, 200);
  assert.equal(heartbeat.headers['content-encoding'], undefined, 'no-transform must disable Caddy gzip/zstd buffering');
  assert.match(heartbeat.headers['cache-control'], /no-transform/);
  assert.equal(heartbeat.headers['content-length'], undefined);
  assert.match(heartbeat.text, /^\s+\{/);
  assert.deepEqual(JSON.parse(heartbeat.text), result);
  assert(heartbeat.arrivals.length >= Math.floor(duration / interval) - 1);
  assert(heartbeat.arrivals[0] < interval * 2);
  const gaps = heartbeat.arrivals.map((at, index) => at - (heartbeat.arrivals[index - 1] || 0));
  assert(Math.max(...gaps) < interval * 2);
  assert.deepEqual(counts, { silent: 1, heartbeat: 1 });
  const evidence = { passed: true, protocol:useHTTP2?'h2':'http/1.1', duration, idle, interval, counts, externalGenerations: 0, silent, heartbeat: { ...heartbeat, text: undefined, chunks: heartbeat.arrivals.length, maxGapMs: Math.max(...gaps), parsed: result } };
  writeFileSync(join(dir, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ phase: 'passed', evidence: join(dir, 'evidence.json'), silentMs: silent.elapsedMs, heartbeatMs: heartbeat.elapsedMs, chunks: heartbeat.arrivals.length, maxGapMs: Math.max(...gaps) }));
} finally {
  if (started) {
    const logs = spawnSync('docker', ['logs', container], { encoding: 'utf8' });
    writeFileSync(join(dir, 'caddy.log'), (logs.stdout || '') + (logs.stderr || ''));
    execFileSync('docker', ['stop', '-t', '1', container], { stdio: 'pipe' });
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
