import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';
import Koa from 'koa';
import mime from 'mime';

// Execute the actual route, Request, Response and heartbeat helper in Node/Koa.
// Replace only paid generation, account/storage access, and the test interval.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mocks = {
    'api/controllers/videos.ts': `import {state} from 'test-state'; export const DEFAULT_MODEL='synthetic'; export async function generateVideoWithRetry(){state.submissions++;return state.generate();}`,
    'api/controllers/auth.ts': `import {state} from 'test-state'; export class PoolTaskReplay extends Error {} export async function resolveAuthorization(){if(state.authError)throw state.authError;return {token:'synthetic'};} export function markCredentialSuccess(){state.success++;} export function markCredentialFailure(){state.failure++;}`,
    'lib/pool-task-recovery.ts': `export async function recoverPoolTask(){throw Error('Recovery is verified by the separate account-pool integration suite');}`,
    'lib/database.ts': `import {state} from 'test-state'; export default {recordCall(){state.records++;},saveMedia(){state.media++;}};`,
    'lib/util.ts': `import {state} from 'test-state'; export default {timestamp:Date.now,unixTimestamp:()=>1,fetchFileBASE64:()=>state.base64()};`,
    'lib/logger.ts': `export default {error(){},warn(){},info(){}};`,
};
const built = await build({
    absWorkingDir: root, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
    stdin: { resolveDir: root, contents: `export {default as routes} from './src/api/routes/videos.ts';export {jsonHeartbeatResponse} from './src/lib/json-heartbeat.ts';export {default as Response} from './src/lib/response/Response.ts';export {default as FailureBody} from './src/lib/response/FailureBody.ts';export {default as Request} from './src/lib/request/Request.ts';export {default as APIException} from './src/lib/exceptions/APIException.ts';export {state} from 'test-state';` },
    plugins: [{ name: 'isolated-video-fixtures', setup(b) {
        b.onResolve({ filter: /^test-state$/ }, () => ({ path: 'state', namespace: 'fixture' }));
        b.onLoad({ filter: /^state$/, namespace: 'fixture' }, () => ({ contents: 'export const state={};', loader: 'js' }));
        b.onResolve({ filter: /^@\/lib\/json-heartbeat\.ts$/ }, () => ({ path: 'heartbeat', namespace: 'fixture' }));
        b.onLoad({ filter: /^heartbeat$/, namespace: 'fixture' }, () => ({ resolveDir: root, loader: 'js', contents: `import {state} from 'test-state';import {jsonHeartbeatResponse as actual} from './src/lib/json-heartbeat.ts';export async function jsonHeartbeatResponse(op,_interval,options){const result=await(state.disableHeartbeat?op():actual(op,20,options));if(result?.body?.destroy)state.streams.push(result.body);return result;}` }));
        b.onLoad({ filter: /\.ts$/ }, args => {
            const relative = path.relative(path.join(root, 'src'), args.path).split(path.sep).join('/');
            if (mocks[relative]) return { contents: mocks[relative], loader: 'ts' };
        });
    } }],
});
const fixture = { exports: {} };
const require = createRequire(import.meta.url);
// Production runs the ESM build; bridge mime's ESM default for this in-memory CJS fixture.
new Function('require', 'module', 'exports', built.outputFiles[0].text)(name => name === 'mime' ? mime : require(name), fixture, fixture.exports);
const { routes, jsonHeartbeatResponse, Request, Response, FailureBody, APIException, state } = fixture.exports;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const reset = () => Object.assign(state, { submissions: 0, records: 0, media: 0, success: 0, failure: 0, streams: [], authError: null, disableHeartbeat: false, generate: async () => 'https://example.invalid/generated.mp4', base64: async () => 'synthetic-base64' });

async function server(t) {
    reset();
    const app = new Koa();
    app.use(async ctx => {
        const chunks = [];
        for await (const chunk of ctx.req) chunks.push(chunk);
        ctx.request.body = JSON.parse(Buffer.concat(chunks).toString());
        try {
            const result = await routes.post['/generations'](new Request(ctx));
            (Response.isInstance(result) ? result : new Response(result)).injectTo(ctx);
        } catch (error) {
            new Response(new FailureBody(error)).injectTo(ctx);
        }
    });
    const listener = app.listen(0, '127.0.0.1');
    await new Promise(resolve => listener.once('listening', resolve));
    t.after(() => new Promise(resolve => {
        state.streams.forEach(stream => stream.destroy());
        listener.closeAllConnections(); listener.close(resolve);
    }));
    return listener.address().port;
}

function request(port, { idleMs = 150, body = {}, onData = () => {} } = {}) {
    let client;
    const promise = new Promise((resolve, reject) => {
        client = http.request({ hostname: '127.0.0.1', port, path: '/v1/videos/generations', method: 'POST', headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json', 'accept-encoding': 'gzip, zstd' } }, response => {
            let data = '';
            response.on('data', chunk => { data += chunk; onData(chunk, response); });
            response.on('end', () => resolve({ data, status: response.statusCode, headers: response.headers }));
            response.on('error', reject);
        });
        client.on('error', reject);
        client.setTimeout(idleMs, () => client.destroy(new Error('synthetic idle timeout')));
        client.end(JSON.stringify({ model: 'synthetic', prompt: 'isolated fixture', ...body }));
    });
    return { promise, destroy: () => client.destroy(new Error('synthetic client disconnect')) };
}

test('idle timeout reproduces old silent route; heartbeat preserves one JSON result', async t => {
    const port = await server(t);
    const old = deferred(); state.disableHeartbeat = true; state.generate = () => old.promise;
    await assert.rejects(request(port, { idleMs: 100 }).promise, /idle timeout/);
    old.resolve('https://example.invalid/old.mp4'); await sleep(20);
    assert.equal(state.submissions, 1); assert.equal(state.records, 1);

    reset(); const generation = deferred(); state.generate = () => generation.promise;
    let heartbeats = 0;
    const client = request(port, { idleMs: 100, onData(chunk) { if (/^\s+$/.test(chunk.toString())) heartbeats++; } });
    await sleep(240);
    assert.ok(heartbeats >= 3);
    generation.resolve('https://example.invalid/generated.mp4');
    const response = await client.promise;
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'], /application\/json/);
    assert.match(response.headers['cache-control'], /no-transform/);
    assert.equal(response.headers['content-length'], undefined);
    assert.equal(response.headers['content-encoding'], undefined);
    assert.deepEqual(JSON.parse(response.data), { created: 1, data: [{ url: 'https://example.invalid/generated.mp4', revised_prompt: 'isolated fixture' }] });
    assert.equal(state.submissions, 1); assert.equal(state.records, 1); assert.equal(state.media, 1);
});

test('fast JSON and pre-heartbeat HTTP errors keep their original contract', async t => {
    const port = await server(t);
    const success = await request(port).promise;
    assert.equal(success.data[0], '{'); assert.equal(success.headers['cache-control'], undefined);
    assert.equal(JSON.parse(success.data).data[0].url, 'https://example.invalid/generated.mp4');
    state.authError = new APIException([-11, 'synthetic denied']).setHTTPStatusCode(401);
    const denied = await request(port).promise;
    assert.equal(denied.status, 401); assert.equal(denied.data[0], '{');
    assert.equal(JSON.parse(denied.data).code, -11);
    state.authError = null;
    state.generate = async () => { throw new APIException([-12, 'synthetic quick limit']).setHTTPStatusCode(429); };
    const limited = await request(port).promise;
    assert.equal(limited.status, 429); assert.equal(limited.data[0], '{');
    assert.equal(JSON.parse(limited.data).code, -12);
    const invalid = await request(port, { body: { prompt: 42 } }).promise;
    assert.equal(JSON.parse(invalid.data).code, -2000);
    assert.equal(state.submissions, 2);
});

test('late generation failure is one original FailureBody JSON, not EOF or success', async t => {
    const port = await server(t);
    const generation = deferred(); state.generate = () => generation.promise;
    const received = deferred();
    const client = request(port, { onData: () => received.resolve() });
    await received.promise;
    generation.reject(new APIException([-2008, 'synthetic generation failed']));
    const response = await client.promise;
    assert.match(response.data, /^\s+\{/);
    assert.deepEqual(JSON.parse(response.data), { code: -2008, message: 'synthetic generation failed', data: null });
    assert.equal(state.submissions, 1); assert.equal(state.failure, 1); assert.equal(state.records, 0); assert.equal(state.media, 0);
});

test('disconnect after heartbeat stops transport but completes original generation once', async t => {
    const port = await server(t);
    const generation = deferred(); state.generate = () => generation.promise;
    const received = deferred();
    const client = request(port, { onData: () => received.resolve() });
    await received.promise;
    const rejected = assert.rejects(client.promise, /disconnect|aborted/);
    client.destroy(); await rejected;
    generation.resolve('https://example.invalid/recovered.mp4'); await sleep(40);
    assert.equal(state.submissions, 1); assert.equal(state.success, 1); assert.equal(state.records, 1); assert.equal(state.media, 1);
});

test('disconnect before first heartbeat destroys the later stream and retains one operation', async t => {
    const port = await server(t);
    const generation = deferred(), started = deferred();
    state.generate = () => { started.resolve(); return generation.promise; };
    const client = request(port);
    const rejected = assert.rejects(client.promise, /disconnect|aborted/);
    await started.promise; client.destroy(); await rejected;
    await sleep(70);
    assert.equal(state.streams.length, 1);
    assert.equal(state.streams[0].destroyed, true);
    generation.reject(new APIException([-2008, 'synthetic late failure'])); await sleep(30);
    assert.equal(state.submissions, 1); assert.equal(state.failure, 1); assert.equal(state.records, 0);
});

test('heartbeats continue during b64 delivery conversion', async t => {
    const port = await server(t);
    const conversion = deferred(); state.base64 = () => conversion.promise;
    let heartbeats = 0;
    const client = request(port, { idleMs: 100, body: { response_format: 'b64_json' }, onData(chunk) { if (/^\s+$/.test(chunk.toString())) heartbeats++; } });
    await sleep(220); assert.ok(heartbeats >= 3);
    conversion.resolve('synthetic-base64');
    assert.deepEqual(JSON.parse((await client.promise).data), { created: 1, data: [{ b64_json: 'synthetic-base64', revised_prompt: 'isolated fixture' }] });
    assert.equal(state.submissions, 1); assert.equal(state.records, 1); assert.equal(state.media, 1);
});

test('backpressure bounds heartbeat writes and stream close clears its timer', async t => {
    const generation = deferred();
    const response = await jsonHeartbeatResponse(() => generation.promise, 5);
    const stream = response.body;
    t.after(() => stream.destroy());
    stream.write(Buffer.alloc(stream.writableHighWaterMark * 2));
    assert.equal(stream.writableNeedDrain, true);
    const queued = stream.writableLength;
    await sleep(40); assert.equal(stream.writableLength, queued);
    let writes = 0;
    const originalWrite = stream.write.bind(stream);
    stream.write = (...args) => { writes++; return originalWrite(...args); };
    stream.destroy(); await sleep(30);
    assert.equal(writes, 0);
    generation.resolve({ complete: true }); await sleep(20);
    assert.equal(writes, 0); assert.equal(stream.destroyed, true);
});
