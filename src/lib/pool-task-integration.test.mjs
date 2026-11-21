import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const axios = require('axios');
const http = require('node:http');
const https = require('node:https');

// Bundle the real routes/controllers/store while leaving node dependencies shared.
// A rejecting adapter is installed before any application import: no upstream access.
test('real media entrypoints use A leases, idempotency, disabled-account recovery and immutable parameters', async t => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const dir = mkdtempSync(path.join(tmpdir(), 'pool-B-integration-'));
  const oldAdapter = axios.defaults.adapter;
  const oldHttp = http.request, oldHttps = https.request, oldFetch = globalThis.fetch;
  const blocked = () => { throw new Error('TEST_NETWORK_ACCESS_BLOCKED'); };
  http.request = blocked; https.request = blocked; globalThis.fetch = blocked;
  const oldEnv = {...process.env};
  process.env.DB_PATH = path.join(dir, 'isolated.db');
  process.env.JIMENG_ACCOUNT_POOL_KEY = 'pool-test-only-key-not-real-secret';
  process.env.JIMENG_BROWSER_TRANSPORT = 'off';
  process.env.VERCEL = '1';
  const calls = [];
  let behavior = 'success'; let sequence = 0;
  const history = new Map();
  let imageBatch;
  const rejectedSessions = new Set();
  const balances = new Map();
  let creditErrorCode = '1006';
  axios.defaults.adapter = async config => {
    const body = typeof config.data === 'string' ? JSON.parse(config.data) : Buffer.isBuffer(config.data) ? {} : config.data || {};
    const url = new URL(config.url); const route = url.pathname;
    calls.push({url:config.url,route,body,cookie:config.headers.get('Cookie')});
    let data;
    const raw = data => ({status:200,statusText:'OK',headers:{},config,data});
    if (url.hostname === 'fixture.invalid') return raw(Buffer.from('mock mp3'));
    if (url.searchParams.get('Action') === 'ApplyImageUpload') {
      if (behavior === 'fail-tail-upload' && calls.filter(c=>c.url?.includes('ApplyImageUpload')).length >= 2) {
        throw new Error('simulated tail upload failure');
      }
      return raw({Result:{UploadAddress:{UploadHosts:['fixture.imgupload.com'],SessionKey:'test-img-session',StoreInfos:[{StoreUri:'test-img',Auth:'test-img-auth'}]}}});
    }
    if (url.hostname === 'fixture.imgupload.com') return raw({code:2000});
    if (url.searchParams.get('Action') === 'CommitImageUpload') return raw({Result:{Results:[{Uri:'tos-cn-i-test/frame-uri'}]}});
    if (url.searchParams.get('Action') === 'ApplyUploadInner') return raw({Result:{InnerUploadAddress:{UploadNodes:[{UploadHost:'fixture.vodupload.com',SessionKey:'test-upload-session',StoreInfos:[{StoreUri:'test',Auth:'test-upload-auth'}]}]}}});
    if (url.hostname === 'fixture.vodupload.com') return raw({code:2000});
    if (url.searchParams.get('Action') === 'CommitUploadInner') return raw({Result:{Results:[{Vid:'v01234567890123456789012345',VideoMeta:{Duration:7}}]}});
    const session = String(config.headers.get('Cookie') || '').match(/sessionid=([^;]+)/)?.[1];
    if (route === '/commerce/v1/benefits/user_credit') data = {credit:{gift_credit:balances.get(session) ?? 1000,purchase_credit:0,vip_credit:0}};
    else if (route === '/passport/account/info/v2') {
      const cookieHeader = typeof config.headers?.get === 'function' ? config.headers.get('Cookie') : config.headers?.Cookie || '';
      const sessionMatch = String(cookieHeader).match(/sessionid=([^;]+)/);
      data = {user_info:{user_id:sessionMatch ? 'verified-' + sessionMatch[1] : 'verified-fixture-id',is_vip:true}};
    }
    else if (route.endsWith('get_common_config')) data = {};
    else if (route === '/mweb/v1/get_upload_token') data = {access_key_id:'test-access',secret_access_key:'test-secret',session_token:'test-session',space_name:'test-space'};
    else if (route === '/mweb/v1/aigc_draft/generate') {
      if (rejectedSessions.has(session)) return raw({ret:creditErrorCode,errmsg:'insufficient'});
      if (behavior === 'credit-with-task') return raw({ret:'1006',errmsg:'ambiguous',data:{aigc_data:{history_record_id:'unexpected-id'}}});
      if (behavior === 'risk-reject') return {status:200,statusText:'OK',headers:{},config,data:{ret:'4013',errmsg:'risk rejected'}};
      if (behavior === 'slow-timeout') { await new Promise(resolve=>setTimeout(resolve,30)); throw Object.assign(new Error('secret=leak-guard network timeout'), {code:'ETIMEDOUT'}); }
      if (behavior === 'timeout') throw Object.assign(new Error('network timeout'), {code:'ETIMEDOUT'});
      if (behavior === 'insufficient') return {status:200,statusText:'OK',headers:{},config,data:{ret:'1006',errmsg:'insufficient'}};
      const id = String(++sequence);
      const histStatus = behavior === 'unknown-history' ? 99 : behavior === 'empty-done' ? 50 : 50;
      if (behavior === 'missing-items') {
        history.set(id, {status:50});
      } else {
        const itemList = behavior === 'empty-done' ? [] : imageBatch ?? [{image:{large_images:[{image_url:'https://fixture.invalid/generated.webp'}]}, video:{play_url:'https://fixture.invalid/generated.mp4'},audio:{origin_audio:{audio_url:'https://fixture.invalid/generated.mp3'}}}];
        history.set(id, {status:histStatus, item_list:itemList});
      }
      data = {aigc_data:{history_record_id:id}};
    } else if (route === '/mweb/v1/get_history_by_ids') data = Object.fromEntries((body.history_ids || []).map(id => [id,history.get(id)]));
    else throw new Error(`UNEXPECTED_UPSTREAM ${route}`);
    return {status:200,statusText:'OK',headers:{},config,data:{ret:'0',data}};
  };
  t.after(() => { http.request=oldHttp; https.request=oldHttps; globalThis.fetch=oldFetch; axios.defaults.adapter=oldAdapter; for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key]; Object.assign(process.env,oldEnv); rmSync(dir,{recursive:true,force:true}); });
  writeFileSync(path.join(dir,'package.json'), JSON.stringify({name:'pool-isolated-test',version:'0.0.0'}));
  symlinkSync(path.join(root,'node_modules'),path.join(dir,'node_modules'),'dir');
  const entry = `export {default as pool} from ${JSON.stringify(path.join(root,'src/lib/account-pool.ts'))};
    export {default as db} from ${JSON.stringify(path.join(root,'src/lib/database.ts'))};
    export {default as imageRoutes} from ${JSON.stringify(path.join(root,'src/api/routes/images.ts'))};
    export {default as videoRoutes} from ${JSON.stringify(path.join(root,'src/api/routes/videos.ts'))};
    export {default as audioRoutes,audioCompatRoutes} from ${JSON.stringify(path.join(root,'src/api/routes/audios.ts'))};
    export {default as chatRoutes} from ${JSON.stringify(path.join(root,'src/api/routes/chat.ts'))};
    export {default as modelRoutes} from ${JSON.stringify(path.join(root,'src/api/routes/models.ts'))};
    export {default as browserTransport} from ${JSON.stringify(path.join(root,'src/lib/browser-transport.ts'))};
    export {default as accountStatusRoutes} from ${JSON.stringify(path.join(root,'src/api/routes/account-status.ts'))};
    export {rememberUploadAsset} from ${JSON.stringify(path.join(root,'src/lib/pool-task-assets.ts'))};
    export {resolveAuthorization} from ${JSON.stringify(path.join(root,'src/api/controllers/auth.ts'))};
    export {recoverStoredPoolTask} from ${JSON.stringify(path.join(root,'src/lib/pool-task-recovery.ts'))};
    export {runWithPoolTask,requestIdentity,ownerHash,beginPoolSubmission,acceptPoolSubmission} from ${JSON.stringify(path.join(root,'src/lib/pool-task-context.ts'))};`;
  const outfile = path.join(dir,'app.cjs');
  await build({stdin:{contents:entry,resolveDir:root,loader:'ts'},outfile,bundle:true,platform:'node',format:'cjs',packages:'external',logLevel:'silent',tsconfig:path.join(root,'tsconfig.json'),
    plugins:[{name:'isolated-agent-transport',setup(build) {
      build.onResolve({filter:/^mime$/}, () => ({path:path.join(root,'node_modules/mime/dist/src/index.js')}));
      build.onLoad({filter:/agent-browser-transport\.ts$/}, () => ({loader:'ts',contents:`
      import {PassThrough,Readable} from 'node:stream';
      const sse=(event,data)=>'event: '+event+'\\ndata: '+JSON.stringify(data)+'\\n\\n';
      export async function openAgentBrowserTransport(pairs,signal) {
        const fixture=globalThis.__poolTextFixture; fixture.cookies.push(pairs);
        const sub=new PassThrough();
        return { createWorkspace:async()=>1,
          subscribe:async()=>{sub.write(sse('system',{type:'subscribe_handshake',session_id:'test'}));return sub;},
          submit:async body=>{
            fixture.submits.push(body);
            if(fixture.fail) throw new Error('simulated text submission response lost');
            setTimeout(()=>sub.end(sse('message',{id:'answer',author:{role:'assistant'},metadata:{conversation_id:body.conversation_id},content:{content_type:'text',content_parts:[{text:'fixture answer'}]}})+sse('system',{type:'stream_complete',conversation_id:body.conversation_id})),1);
            return Readable.from([sse('handshake',{conversation_id:body.conversation_id}),sse('stream_complete',{success:true,error_code:'0'})]);
          }, close:async()=>{sub.destroy(); await fixture.onClose?.();} };
      }` })); }}]});
  const app = createRequire(import.meta.url)(outfile);
  const key = app.db.createApiKey('test-caller').key;
  const otherKey = app.db.createApiKey('other-caller').key;
  const a = app.pool.create({name:'fixture A',cookie:'sessionid=fixture-a; webid=full-cookie-a'});
  const b = app.pool.create({name:'fixture B',cookie:'sessionid=fixture-b; webid=full-cookie-b'});
  const req = (body={},id='request-1',params={},keyValue=key) => ({body,params,files:{},query:{},path:'/fixture',headers:{authorization:`Bearer ${keyValue}`,'idempotency-key':id},signal:new AbortController().signal,validate(){return this;}});
  const submissions = () => calls.filter(call => call.route.endsWith('/generate'));
  await t.test('queries and model lists never create leases or touch actual account use', async () => {
    await app.modelRoutes.get['/models'](req());
    await app.accountStatusRoutes.get['/status'](req());
    assert.equal(app.pool.listTasks().total,0);
    assert.equal(app.pool.get(a.id).lastUsedAt,null);
  });
  let imageTask;
  await t.test('image generation persists identity and submits one unchanged request', async () => {
    const response = await app.imageRoutes.post['/generations'](req({prompt:'private fixture',model:'jimeng-image-5.0-lite',resolution:'2k',n:1}));
    assert.ok(response.data?.[0]?.url, JSON.stringify(response));
    imageTask = response.pool_task_id;
    const task=app.pool.readTask(imageTask,app.ownerHash(key));
    assert.equal(task.accountId,a.id); assert.equal(task.state,'succeeded'); assert.equal(task.settling,false);
    assert.equal(submissions().length,1); assert.match(submissions()[0].cookie,/webid=full-cookie-a/);
    const replay=await app.imageRoutes.post['/generations'](req({prompt:'private fixture',model:'jimeng-image-5.0-lite',resolution:'2k',n:1}));
    assert.equal(replay.body.reused,true); assert.equal(replay.body.pool_task_id,imageTask); assert.equal(submissions().length,1);
    const conflict=await app.imageRoutes.post['/generations'](req({prompt:'changed',model:'jimeng-image-5.0-lite',resolution:'2k',n:1}));
    assert.equal(conflict.statusCode,409); assert.equal(submissions().length,1);
  });
  await t.test('disabled original account can recover known image; another caller cannot', async () => {
    app.pool.setEnabled(a.id,false);
    const response=await app.imageRoutes.get['/tasks/:taskId'](req({},'query',{taskId:imageTask}));
    assert.equal(response.task.accountId,a.id); assert.equal(response.data[0].url,'https://fixture.invalid/generated.webp');
    const before=calls.length;
    const denied=await app.imageRoutes.get['/tasks/:taskId'](req({},'query',{taskId:imageTask},otherKey));
    assert.equal(denied.statusCode,403); assert.equal(calls.length,before);
    app.pool.setEnabled(a.id,true);
  });
  // Each synthetic history mixes original images, fallback covers and an empty record.
  // The API must return the same ordered URLs on creation, lookup and idempotent replay.
  await t.test('image count matches original ordered URLs on POST, GET and replay', async t => {
    const urls = ['large-a', 'cover-b', 'large-c', 'large-d'].map(name => 'https://fixture.invalid/' + name + '.webp');
    imageBatch = [
      { image: { large_images: [{ image_url: urls[0] }] }, common_attr: { cover_url: 'https://fixture.invalid/thumbnail.webp' } },
      {},
      { common_attr: { cover_url: urls[1] } },
      ...urls.slice(2).map(url => ({ image: { large_images: [{ image_url: url }] } })),
    ];
    const imageReq = (body, id) => ({ ...req(body, id), path: '/v1/images/generations' });
    try {
      for (const n of [undefined, 1, 2, 8]) {
        await t.test('requested ' + (n ?? 'default'), async () => {
          const id = 'count-' + (n ?? 'default');
          const body = { model: 'jimeng-image-5.0-lite', prompt: 'isolated fixture', ...(n === undefined ? {} : { n }) };
          const submit = () => app.imageRoutes.post['/generations'](imageReq(body, id));
          const countBefore = submissions().length;
          const immediate = await submit();
          const expected = urls.slice(0, n ?? 1);
          assert.deepEqual(immediate.data.map(item => item.url), expected);
          const queried = await app.imageRoutes.get['/tasks/:taskId'](req({}, 'query', { taskId: immediate.pool_task_id }));
          assert.deepEqual(queried.data, immediate.data);
          assert.deepEqual(queried.result.urls, expected);
          if (queried.result.data) assert.deepEqual(queried.result.data, immediate.data);
          const repeated = await submit();
          assert.equal(repeated.body.reused, true);
          assert.deepEqual(repeated.body.data, immediate.data);
          assert.equal(submissions().length, countBefore + 1);
        });
      }
      await t.test('image chat uses the single output selected by its controller', async () => {
        const body = { model: 'jimeng-image-5.0-lite', messages: [{ role: 'user', content: 'isolated picture' }], n: 3 };
        const submit = () => app.chatRoutes.post['/completions']({ ...req(body, 'count-chat'), path: '/v1/chat/completions' });
        const immediate = await submit();
        assert.ok(immediate.choices[0].message.content.includes(urls[0]));
        assert.ok(!immediate.choices[0].message.content.includes(urls[1]));
        const queried = await app.chatRoutes.get['/tasks/:taskId'](req({}, 'query', { taskId: immediate.pool_task_id }));
        assert.deepEqual(queried.data, [{ url: urls[0] }]);
        const replayed = await submit();
        assert.deepEqual(replayed.body.data, queried.data);
        assert.ok(!replayed.body.choices[0].message.content.includes(urls[1]));
      });
    } finally {
      imageBatch = undefined;
    }
  });

  await t.test('legacy image count can be learned only from the original owner and matching request', async () => {
    const model = 'jimeng-image-5.0-lite';
    const body = { model, prompt: 'legacy', n: 2 };
    const id = 'old-batch';
    const request = ({ n = 2, caller = key } = {}) => ({ ...req({ ...body, n }, id, {}, caller), path: '/v1/images/generations' });
    const identity = await app.requestIdentity(request(), 'image', model);
    const urls = ['a', 'b', 'c', 'd'].map(s => 'https://fixture.invalid/old-' + s + '.webp');
    // Old persisted tasks have a fingerprint and encrypted result, but no requested count.
    async function oldTask(caller) {
      const { taskId } = await app.pool.acquireTask({ requestId: id, requestFingerprint: identity.requestFingerprint,
        ownerHash: app.ownerHash(caller), kind: 'image', model, estimatedCredits: null });
      app.pool.transitionTask(taskId, { state: 'submitting' });
      app.pool.transitionTask(taskId, { state: 'submitted', upstreamTaskId: 'legacy-' + taskId });
      app.pool.transitionTask(taskId, { state: 'succeeded', result: { kind: 'image', urls, data: urls.map(url => ({ url })) } });
      await app.pool.settleTask(taskId);
      return taskId;
    }
    const original = await oldTask(key);
    const other = await oldTask(otherKey);
    const read = async () => (await app.imageRoutes.get['/tasks/:taskId'](req({}, 'legacy-read', { taskId: original }))).data.map(x => x.url);
    const before = submissions().length;
    assert.deepEqual(await read(), urls);
    assert.equal((await app.imageRoutes.post['/generations'](request({ n: 1 }))).statusCode, 409);
    assert.deepEqual(await read(), urls);
    const foreignReplay = await app.imageRoutes.post['/generations'](request({ caller: otherKey }));
    assert.equal(foreignReplay.body.pool_task_id, other);
    assert.deepEqual(await read(), urls);
    const replayed = await app.imageRoutes.post['/generations'](request());
    assert.equal(replayed.body.reused, true);
    assert.deepEqual(replayed.body.data.map(x => x.url), urls.slice(0, 2));
    assert.equal(submissions().length, before);
    const child = spawnSync(process.execPath, ['-e', `
      const app=require(process.env.TEST_BUNDLE);
      const assert=require('node:assert/strict');
      require('node:http').request=require('node:https').request=global.fetch=()=>{ throw Error('No network'); };
      require('axios').defaults.adapter=async()=>{throw Error('Unexpected upstream access');};
      const req={params:{taskId:process.env.TEST_TASK},path:'/v1/images/tasks/'+process.env.TEST_TASK,headers:{authorization:'Bearer '+process.env.TEST_KEY},body:{},files:{}};
      app.imageRoutes.get['/tasks/:taskId'](req).then(r=>{
        assert.deepEqual(r.data.map(x=>x.url),JSON.parse(process.env.TEST_EXPECTED));
        assert.deepEqual(r.result.urls,JSON.parse(process.env.TEST_EXPECTED));
        if(r.result.data) assert.deepEqual(r.result.data,r.data);
      }).catch(e=>{console.error(e);process.exitCode=1});
    `], {cwd:dir, env:{...process.env, TEST_BUNDLE:outfile, TEST_TASK:original, TEST_KEY:key, TEST_EXPECTED:JSON.stringify(urls.slice(0, 2))}, encoding:'utf8', timeout:15000});
    assert.equal(child.status, 0, child.stderr || child.stdout);
  });
  await t.test('credit rejection relays one logical request through media entrypoints with original parameters', async t => {
    const source = 'data:audio/mpeg;base64,dGVzdA==';
    const image = 'data:image/png;base64,dGVzdA==';
    const compatAudio = app.audioCompatRoutes.find(route => route.prefix === '/v1/audio');
    const compatTts = app.audioCompatRoutes.find(route => route.prefix === '/api/v3/tts');
    const cases = [
      ['image', app.imageRoutes, '/generations', {prompt:'relay image',resolution:'2k',n:2,filePaths:[image]}, false],
      ['video', app.videoRoutes, '/generations', {prompt:'relay video',resolution:'720p',duration:5,file_paths:[image]}, false],
      ['audio', app.audioRoutes, '/generations', {prompt:'relay audio',audio_paths:[source],mode:'unified_edit',wait:true}, false],
      ['audio-async', compatAudio, '/tasks', {input:'relay async'}, false],
      ['tts', compatTts, '/create', {text_prompt:'relay tts'}, false],
      ['speech', compatAudio, '/speech', {input:'relay speech'}, false],
      ['chat-json', app.chatRoutes, '/completions', {model:'jimeng-image-5.0-lite',messages:[{role:'user',content:'relay chat'}]}, false],
      ['chat-sse', app.chatRoutes, '/completions', {model:'jimeng-image-5.0-lite',stream:true,messages:[{role:'user',content:'relay chat sse'}]}, true],
    ];
    const originalSettings = app.pool.getSettings();
    const oldTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => oldTimeout(fn, ms === 5000 ? 1 : ms, ...args);
    app.pool.updateSettings({...originalSettings,mode:'auto',fixedAccountId:null,threshold:40});
    balances.set('fixture-a',50); balances.set('fixture-b',100);
    await app.pool.refreshStatus(a.id); await app.pool.refreshStatus(b.id);
    rejectedSessions.add('fixture-a');
    try {
      for (const [name, routes, route, body, stream] of cases) await t.test(name, async () => {
        creditErrorCode = name === 'image' ? 5000 : '1006';
        const before = submissions().length, beforeTasks = app.pool.listTasks().total, beforeCalls = calls.length;
        const requestId = 'relay-' + name;
        const invoke = () => routes.post[route](req(body,requestId));
        const result = await invoke();
        if (stream) {
          let output = ''; for await (const chunk of result.body) output += chunk.toString();
          assert.match(output,/finish_reason":"stop/); assert.doesNotMatch(output,/media_generation_incomplete/);
        }
        assert.ok((result.statusCode || 200) < 400,JSON.stringify(result.body));
        const task = app.pool.listTasks().items.find(task => task.requestId === requestId);
        assert.ok(task); assert.equal(task.accountId,b.id); assert.ok(task.upstreamTaskId);
        assert.equal(app.pool.listTasks().total,beforeTasks + 1);
        const sent = submissions().slice(before);
        assert.equal(sent.length,2); assert.match(sent[0].cookie,/sessionid=fixture-a/); assert.match(sent[1].cookie,/sessionid=fixture-b/);
        const draft = JSON.parse(sent[1].body.draft_content).component_list[0];
        if (name === 'image') assert.equal(draft.abilities.gen_option.gen_count,2);
        if (name === 'video') assert.equal(draft.abilities.gen_video.text_to_video_params.video_gen_inputs[0].duration_ms,5000);
        if (['image','video','audio'].includes(name)) {
          const uploads = calls.slice(beforeCalls).filter(call => call.route === '/mweb/v1/get_upload_token');
          assert.ok(uploads.some(call => /sessionid=fixture-a/.test(call.cookie)));
          assert.ok(uploads.some(call => /sessionid=fixture-b/.test(call.cookie)));
        }
        for (const call of calls.slice(beforeCalls).filter(call => call.route === '/mweb/v1/get_history_by_ids')) assert.match(call.cookie,/sessionid=fixture-b/);
        assert.ok(app.pool.listEvents(200).items.some(event => event.fromAccountId === a.id && event.toAccountId === b.id && event.reason.includes(task.id)));
        if (task.state === 'submitted') await app.audioRoutes.get['/generations/:taskId'](req({},'query',{taskId:task.upstreamTaskId}));
        const replay = await invoke(); assert.equal(replay.body.reused,true); assert.equal(submissions().length,before+2);
        assert.equal(app.pool.readTask(task.id,app.ownerHash(key)).settling,false);
      });
    } finally {
      globalThis.setTimeout = oldTimeout;
      rejectedSessions.clear(); balances.clear();
      app.pool.updateSettings({...app.pool.getSettings(),mode:originalSettings.mode,fixedAccountId:originalSettings.fixedAccountId,threshold:originalSettings.threshold});
      await app.pool.refreshStatus(a.id); await app.pool.refreshStatus(b.id);
    }
  });
  await t.test('credit fallback boundaries exhaust accounts, preserve fixed/material rules, and stop on ambiguity', async t => {
    const settings = app.pool.getSettings();
    app.pool.updateSettings({...settings,mode:'auto',fixedAccountId:null,threshold:40});
    const reset = async () => {
      rejectedSessions.clear(); behavior='success';
      app.pool.markSuccess(a.id); app.pool.markSuccess(b.id);
      app.pool.updateSettings({...app.pool.getSettings(),mode:'auto',fixedAccountId:null});
      await app.pool.refreshStatus(a.id); await app.pool.refreshStatus(b.id);
    };
    try {
      await t.test('all refused accounts produce one failed task without duplicate replay', async () => {
        await reset(); rejectedSessions.add('fixture-a'); rejectedSessions.add('fixture-b');
        const before = submissions().length;
        const submit = () => app.imageRoutes.post['/generations'](req({prompt:'all refused'},'exhausted'));
        const result = await submit();
        assert.equal(result.statusCode,422); assert.equal(result.body.error.reason,'insufficient_credits_exhausted');
        assert.equal(result.body.state,'failed'); assert.equal(submissions().length,before+2);
        assert.equal(app.pool.readTask(result.body.pool_task_id,app.ownerHash(key)).settling,false);
        assert.equal((await submit()).body.reused,true); assert.equal(submissions().length,before+2);
      });
      await t.test('fixed account refuses once although a backup is available', async () => {
        await reset(); app.pool.updateSettings({...app.pool.getSettings(),mode:'fixed',fixedAccountId:a.id});
        rejectedSessions.add('fixture-a'); const before = submissions().length;
        const result = await app.imageRoutes.post['/generations'](req({prompt:'fixed refused'},'fixed-refused'));
        assert.equal(result.body.error.reason,'fixed_account_insufficient'); assert.equal(submissions().length,before+1);
      });
      await t.test('raw material identifier remains pinned with an explicit source-required error', async () => {
        await reset();
        const vid = 'v0'+'z'.repeat(24), account = app.pool.readTaskAccount(a.id);
        app.rememberUploadAsset(vid,5000,{token:account.sessionId,cookie:account.credential,accountId:a.id,managedKey:key});
        rejectedSessions.add('fixture-a'); const before = submissions().length;
        const result = await app.audioRoutes.post['/generations'](req({prompt:'material bound',audio_paths:[vid]},'material-bound'));
        assert.equal(result.body.error.reason,'reference_account_bound'); assert.equal(submissions().length,before+1);
      });
      await t.test('credit error containing a task identifier stays unknown on the original account', async () => {
        await reset(); behavior='credit-with-task'; const before = submissions().length;
        const result = await app.imageRoutes.post['/generations'](req({prompt:'ambiguous refusal'},'ambiguous-refusal'));
        assert.equal(result.body.state,'unknown'); assert.equal(submissions().length,before+1);
        const task = app.pool.readTask(result.body.pool_task_id,app.ownerHash(key)); assert.equal(task.accountId,a.id);
        app.pool.transitionTask(task.id,{state:'failed'}); await app.pool.settleTask(task.id);
      });
      await t.test('timeout after relaying stays bound to the backup and replay sends no new request', async () => {
        await reset(); rejectedSessions.add('fixture-a'); behavior='timeout'; const before = submissions().length;
        const submit = () => app.imageRoutes.post['/generations'](req({prompt:'relay then timeout'},'relay-timeout'));
        const result = await submit(); assert.equal(result.body.state,'unknown'); assert.equal(submissions().length,before+2);
        const task = app.pool.readTask(result.body.pool_task_id,app.ownerHash(key)); assert.equal(task.accountId,b.id);
        assert.equal((await submit()).body.reused,true); assert.equal(submissions().length,before+2);
        app.pool.transitionTask(task.id,{state:'failed'}); await app.pool.settleTask(task.id);
      });
    } finally {
      await reset();
      app.pool.updateSettings({...app.pool.getSettings(),mode:settings.mode,fixedAccountId:settings.fixedAccountId,threshold:settings.threshold});
    }
  });
  await t.test('network timeout creates one unknown task; replay cannot repeat submission', async () => {
    behavior='timeout'; const before=submissions().length;
    const response=await app.videoRoutes.post['/generations'](req({prompt:'video',resolution:'720p',duration:5},'timeout'));
    assert.equal(response.body.state,'unknown'); assert.equal(submissions().length,before+1);
    const replay=await app.videoRoutes.post['/generations'](req({prompt:'video',resolution:'720p',duration:5},'timeout'));
    assert.equal(replay.body.reused,true); assert.equal(submissions().length,before+1);
    assert.equal(app.pool.readTask(response.body.pool_task_id,app.ownerHash(key)).settling,false);
    assert.equal(app.pool.get(a.id).scheduling.unknownCostBusy,true);
    const query=await app.videoRoutes.get['/tasks/:taskId'](req({},'query',{taskId:response.body.pool_task_id}));
    assert.equal(query.recoverable,false); assert.equal(submissions().length,before+1);
    behavior='success';
  });
  await t.test('audio async creation and polling stay on original account and settle at terminal history', async () => {
    const response=await app.audioRoutes.post['/generations'](req({prompt:'hello',voice_name:'苏感低音'},'audio'));
    assert.ok(response.data?.task_id,JSON.stringify(response));
    assert.equal(app.pool.readTask(response.pool_task_id,app.ownerHash(key)).accountId,b.id);
    assert.equal(app.pool.readTask(response.pool_task_id,app.ownerHash(key)).state,'submitted');
    app.pool.setEnabled(b.id,false);
    const query=await app.audioRoutes.get['/generations/:taskId'](req({},'query',{taskId:response.data.task_id}));
    assert.equal(query.data.complete,true); assert.equal(app.pool.readTask(response.pool_task_id,app.ownerHash(key)).state,'succeeded');
    app.pool.setEnabled(b.id,true);
  });
  await t.test('explicit insufficient credits never downgrade resolution/duration or retry', async () => {
    behavior='insufficient'; const before=submissions().length;
    const response=await app.videoRoutes.post['/generations'](req({prompt:'reject',resolution:'720p',duration:5},'reject'));
    assert.equal(response.body.state,'failed'); assert.equal(submissions().length,before+1);
    behavior='success'; app.pool.markSuccess(b.id);
  });
  await t.test('bare managed vid is rejected; persisted owner proof pins the correct account', async () => {
    const vid='v01234567890123456789012345'; const before=submissions().length;
    assert.equal((await app.audioRoutes.post['/generations'](req({prompt:'asset',audio_paths:[vid]},'no-proof'))).statusCode,403);
    const upload = await app.audioRoutes.post['/uploads'](req({source:'data:audio/mpeg;base64,dGVzdA=='},'upload'));
    assert.equal(upload.data.vid,vid);
    assert.equal(app.pool.readTask(upload.pool_task_id,app.ownerHash(key)).state,'succeeded');
    assert.equal((await app.audioRoutes.post['/generations'](req({prompt:'asset',audio_paths:[vid],accountId:b.id},'foreign',{},otherKey))).statusCode,403);
    assert.equal(submissions().length,before);
    const response=await app.audioRoutes.post['/generations'](req({prompt:'asset',audio_paths:[vid],accountId:a.id},'proof'));
    assert.ok(response.data?.task_id,JSON.stringify(response));
    assert.equal(app.pool.readTask(response.pool_task_id,app.ownerHash(key)).accountId,b.id);
    await app.audioRoutes.get['/generations/:taskId'](req({},'query',{taskId:response.data.task_id}));
  });
  await t.test('compat chat image path shares the lease and terminal settlement', async () => {
    const before=submissions().length;
    const response=await app.chatRoutes.post['/completions'](req({model:'jimeng-image-5.0-lite',messages:[{role:'user',content:'fixture'}]},'chat'));
    assert.ok(response.choices?.[0]?.message?.content,JSON.stringify(response));
    assert.equal(app.pool.readTask(response.pool_task_id,app.ownerHash(key)).kind,'image');
    assert.equal(submissions().length,before+1);
  });
  await t.test('all audio compatibility entrypoints share submission and final settlement', async () => {
    const tts=app.audioCompatRoutes.find(route => route.prefix==='/api/v3/tts');
    const compat=app.audioCompatRoutes.find(route => route.prefix==='/v1/audio');
    const task=await compat.post['/tasks'](req({input:'compat task'},'compat-task'));
    assert.equal(task.status,'processing');
    const done=await compat.get['/tasks/:taskId'](req({},'query',{taskId:task.task_id}));
    assert.equal(done.status,'succeeded');
    const ttsResult=await tts.post['/create'](req({text_prompt:'compat tts'},'compat-tts'));
    assert.equal(ttsResult.status,'succeeded');
    const speech=await compat.post['/speech'](req({input:'compat speech'},'compat-speech'));
    assert.equal(speech.type,'audio/mpeg'); assert.ok(Buffer.isBuffer(speech.body));
  });
  await t.test('fresh process recovers a submitted audio task after original account disable', async () => {
    const created=await app.audioRoutes.post['/generations'](req({prompt:'restart fixture'},'restart-audio'));
    app.pool.setEnabled(b.id,false);
    const childCode = `const http=require('node:http'),https=require('node:https');
      http.request=https.request=global.fetch=()=>{throw new Error('TEST_NETWORK_ACCESS_BLOCKED')};
      const axios=require('axios');
      axios.defaults.adapter=async config=>{
        const route=new URL(config.url).pathname; const body=JSON.parse(config.data||'{}');
        let data;
        if(route==='/mweb/v1/get_history_by_ids') data=Object.fromEntries(body.history_ids.map(id=>[id,{status:50,item_list:[{audio:{origin_audio:{audio_url:'https://fixture.invalid/restarted.mp3'}}}]}]));
        else if(route==='/commerce/v1/benefits/user_credit') data={credit:{gift_credit:1000,purchase_credit:0,vip_credit:0}};
        else if(route==='/passport/account/info/v2') {
          const cookieHeader = typeof config.headers?.get === 'function' ? config.headers.get('Cookie') : config.headers?.Cookie || '';
          const sessionMatch = String(cookieHeader).match(/sessionid=([^;]+)/);
          data={user_info:{user_id:sessionMatch ? 'verified-' + sessionMatch[1] : 'verified-fixture-id'}};
        }
        else throw new Error('UNEXPECTED_UPSTREAM');
        return {status:200,statusText:'OK',headers:{},config,data:{ret:'0',data}};
      };
      const app=require(${JSON.stringify(outfile)});
      const request={params:{taskId:process.env.TEST_HISTORY},headers:{authorization:'Bearer '+process.env.TEST_KEY},body:{},files:{},path:'/fixture-query'};
      app.audioRoutes.get['/generations/:taskId'](request).then(result=>{
        if(!result.data?.complete) throw new Error(JSON.stringify(result));
        console.log('RECOVERY_OK');
      }).catch(error=>{console.error(error);process.exitCode=1});`;
    const child=spawnSync(process.execPath,['-e',childCode],{cwd:dir,env:{...process.env,TEST_HISTORY:created.data.task_id,TEST_KEY:key},encoding:'utf8',timeout:15000});
    assert.equal(child.status,0,child.stderr+'\n'+child.stdout); assert.match(child.stdout,/RECOVERY_OK/);
    assert.equal(app.pool.readTask(created.pool_task_id,app.ownerHash(key)).state,'succeeded');
    app.pool.setEnabled(b.id,true);
  });


  await t.test('media SSE failures have error frames without false successful stop or regeneration', async () => {
    behavior='insufficient'; const before=submissions().length;
    const result=await app.chatRoutes.post['/completions'](req({model:'jimeng-image-5.0-lite',stream:true,messages:[{role:'user',content:'stream failure'}]},'media-stream-failure'));
    let output=''; for await(const chunk of result.body) output+=chunk.toString();
    assert.match(output,/media_generation_incomplete/); assert.doesNotMatch(output,/"finish_reason":"stop"/);
    assert.equal(submissions().length,before+1);
    assert.equal(app.pool.readTask(result.headers['X-Pool-Task-Id'],app.ownerHash(key)).state,'failed');
    behavior='success'; app.pool.markSuccess(b.id);
  });
  await t.test('text JSON and SSE persist acknowledged conversation IDs and preserve full history', async () => {
    globalThis.__poolTextFixture={submits:[],cookies:[],fail:false};
    t.after(()=>{delete globalThis.__poolTextFixture;});
    await app.browserTransport.setMode('always',false);
    // Media account calibration must remain an isolated adapter call, too.
    app.browserTransport.request=async input => {
      const config={url:input.url,data:JSON.stringify(input.data||{}),headers:new axios.AxiosHeaders(input.headers)};
      return axios.defaults.adapter(config);
    };
    const body={model:'glm-5.3-flash',messages:[{role:'user',content:'first'},{role:'assistant',content:'previous'},{role:'user',content:'follow-up'}]};
    const result=await app.chatRoutes.post['/completions'](req(body,'text-json'));
    assert.equal(result.body.choices[0].message.content,'fixture answer');
    const task=app.pool.readTask(result.headers['X-Pool-Task-Id'],app.ownerHash(key));
    assert.equal(task.kind,'text'); assert.equal(task.state,'succeeded'); assert.ok(task.upstreamTaskId);
    assert.match(globalThis.__poolTextFixture.submits[0].messages[0].content.content_parts[0].text,/previous/);
    assert.ok(globalThis.__poolTextFixture.cookies[0].some(([name,value])=>name==='sessionid'&&value==='fixture-b'));
    const replay=await app.chatRoutes.post['/completions'](req(body,'text-json'));
    assert.equal(replay.body.reused,true); assert.equal(globalThis.__poolTextFixture.submits.length,1);
    const streamed=await app.chatRoutes.post['/completions'](req({...body,stream:true},'text-stream'));
    let content=''; for await(const chunk of streamed.body) content+=chunk.toString();
    assert.match(content,/fixture answer/); assert.match(content,/"finish_reason":"stop"/);
    assert.equal(app.pool.readTask(streamed.headers['X-Pool-Task-Id'],app.ownerHash(key)).state,'succeeded');
    const closeStarted = Promise.withResolvers();
    const releaseClose = Promise.withResolvers();
    globalThis.__poolTextFixture.onClose = () => { closeStarted.resolve(); return releaseClose.promise; };
    const client = new AbortController();
    const disconnectRequest = req({...body,stream:true}, 'text-complete-before-disconnect');
    disconnectRequest.signal = client.signal;
    const disconnectStream = await app.chatRoutes.post['/completions'](disconnectRequest);
    const completedId = disconnectStream.headers['X-Pool-Task-Id'];
    try {
      await closeStarted.promise;
      client.abort();
      const restored = await app.chatRoutes.get['/tasks/:taskId'](req({}, 'read-during-cleanup', {taskId:completedId}));
      assert.equal(restored.task.state, 'succeeded');
      assert.equal(restored.task.accountId, task.accountId);
      assert.equal(restored.task.upstreamTaskId, globalThis.__poolTextFixture.submits.at(-1).conversation_id);
      assert.equal(restored.answer, 'fixture answer');
      const denied = await app.chatRoutes.get['/tasks/:taskId'](req({}, 'other-read', {taskId:completedId}, otherKey));
      assert.equal(denied.statusCode, 403);
    } finally {
      releaseClose.resolve();
      delete globalThis.__poolTextFixture.onClose;
    }
    let disconnectedOutput = '';
    for await (const chunk of disconnectStream.body) disconnectedOutput += chunk.toString();
    assert.match(disconnectedOutput, /"code":"cancelled"/);
    assert.doesNotMatch(disconnectedOutput, /"finish_reason":"stop"/);
    assert.equal(app.pool.readTask(completedId, app.ownerHash(key)).state, 'succeeded');
    globalThis.__poolTextFixture.fail=true;
    const failed=await app.chatRoutes.post['/completions'](req(body,'text-lost'));
    assert.equal(app.pool.readTask(failed.headers['X-Pool-Task-Id'],app.ownerHash(key)).state,'unknown');
    assert.equal(globalThis.__poolTextFixture.submits.length,4);
    const repeated=await app.chatRoutes.post['/completions'](req(body,'text-lost'));
    assert.equal(repeated.body.reused,true); assert.equal(globalThis.__poolTextFixture.submits.length,4);
    const unsupported=await app.chatRoutes.post['/completions'](req({...body,conversation_id:task.upstreamTaskId},'unsupported-session'));
    assert.equal(unsupported.statusCode,400); assert.equal(globalThis.__poolTextFixture.submits.length,4);
  });

  await t.test('fixed unavailable account fails without switching; native sessions do not acquire a lease', async () => {
    const settings=app.pool.getSettings();
    app.pool.updateSettings({...settings,mode:'fixed',fixedAccountId:a.id});
    const before=submissions().length;
    const denied=await app.imageRoutes.post['/generations'](req({prompt:'fixed'},'fixed-unavailable'));
    assert.equal(denied.statusCode,409); assert.equal(submissions().length,before);
    const count=app.pool.listTasks().total;
    const native=await app.resolveAuthorization('Bearer native-fixture-session');
    assert.equal(native.token,'native-fixture-session'); assert.equal(native.accountId,undefined);
    assert.equal(app.pool.listTasks().total,count);
    const cookie='sessionid=native-cookie-session; webid=native-cookie-marker';
    const cookieCredential=await app.resolveAuthorization('Bearer '+cookie);
    assert.equal(cookieCredential.token,'native-cookie-session'); assert.equal(cookieCredential.cookie,cookie);
    const nativeAudio=await app.audioRoutes.post['/generations'](req({prompt:'native cookie fixture'},'native-cookie',{},cookie));
    assert.ok(nativeAudio.data.task_id); assert.equal(nativeAudio.pool_task_id,undefined);
    const nativeQuery=await app.audioRoutes.get['/generations/:taskId'](req({},'native-query',{taskId:nativeAudio.data.task_id},cookie));
    assert.equal(nativeQuery.data.complete,true); assert.equal(app.pool.listTasks().total,count);
    const lastUsed=app.pool.get(a.id).lastUsedAt;
    const cached=await app.accountStatusRoutes.get['/status'](req());
    assert.equal(cached.account.refresh_pending,true);
    assert.equal(app.pool.get(a.id).lastUsedAt,lastUsed);
  });

  await t.test('browser fallback preserves unknown on timeout/missing-ID and fails only on second explicit rejection', async () => {
    const c = app.pool.create({name:'fixture C',cookie:'sessionid=fixture-c; webid=full-cookie-c'});
    app.pool.updateSettings({...app.pool.getSettings(),mode:'fixed',fixedAccountId:c.id});
    await app.browserTransport.setMode('auto',false);
    const oldShouldUse=app.browserTransport.shouldUse, oldRequest=app.browserTransport.request;
    app.browserTransport.shouldUse=()=>false;
    behavior='risk-reject';
    try {
      // 1. Fallback timeout must keep task unknown & held (not released as failed).
      app.browserTransport.request=async()=>{throw Object.assign(new Error('network timeout after submit'),{code:'ETIMEDOUT'});};
      const timedOut=await app.imageRoutes.post['/generations'](req({prompt:'fb timeout'},'fb-timeout'));
      assert.equal(timedOut.statusCode,502);
      const t1=app.pool.readTask(timedOut.body.pool_task_id,app.ownerHash(key));
      assert.equal(t1.state,'unknown'); assert.equal(app.pool.get(c.id).scheduling.unknownCostBusy,true);
      // Clear unknown lock for next case via direct transition + settle in test harness.
      app.pool.transitionTask(t1.id,{state:'failed'}); await app.pool.settleTask(t1.id);
      app.pool.markSuccess(c.id);

      // 2. Fallback returning ret=0 without history_record_id must also preserve unknown & held.
      app.browserTransport.request=async()=>({status:200,statusText:'OK',headers:{},config:{},data:{ret:'0',data:{aigc_data:{}}}});
      const missingId=await app.imageRoutes.post['/generations'](req({prompt:'fb missing id'},'fb-missing-id'));
      assert.equal(missingId.statusCode,502);
      const t2=app.pool.readTask(missingId.body.pool_task_id,app.ownerHash(key));
      assert.equal(t2.state,'unknown');
      app.pool.transitionTask(t2.id,{state:'failed'}); await app.pool.settleTask(t2.id);
      app.pool.markSuccess(c.id);

      // 3. Second explicit 4013 rejection from browser fallback marks failed & settles.
      app.browserTransport.request=async()=>({status:200,statusText:'OK',headers:{},config:{},data:{ret:'4013',errmsg:'rejected again'}});
      const doubleReject=await app.imageRoutes.post['/generations'](req({prompt:'fb double reject'},'fb-double-reject'));
      const t3=app.pool.readTask(doubleReject.body.pool_task_id,app.ownerHash(key));
      assert.equal(t3.state,'failed'); assert.equal(app.pool.get(c.id).scheduling.unknownCostBusy,false);
      app.pool.markSuccess(c.id);

      // 4. Same-account fallback success preserves original account cookie and completes.
      app.browserTransport.shouldUse=()=>false;
      let seenCookie='';
      app.browserTransport.request=async(input)=>{
        seenCookie=input.cookiePairs.map(([k,v])=>`${k}=${v}`).join('; ');
        const id=String(++sequence);
        history.set(id,{status:50,item_list:[{image:{large_images:[{image_url:'https://fixture.invalid/fb-ok.webp'}]}}]});
        return {status:200,statusText:'OK',headers:{},config:{},data:{ret:'0',data:{aigc_data:{history_record_id:id}}}};
      };
      const ok=await app.imageRoutes.post['/generations'](req({prompt:'fb ok'},'fb-ok'));
      assert.equal(ok.data?.[0]?.url,'https://fixture.invalid/fb-ok.webp');
      assert.match(seenCookie,/sessionid=fixture-c/);
      assert.equal(app.pool.readTask(ok.pool_task_id,app.ownerHash(key)).state,'succeeded');
    } finally {
      app.browserTransport.shouldUse=oldShouldUse;
      app.browserTransport.request=oldRequest;
      await app.browserTransport.setMode('off',false);
      behavior='success';
    }
  });

  await t.test('status=99 never extracts URLs or marks succeeded across image, video, and audio', async () => {
    behavior='unknown-history';
    try {
      const imgRes=await app.imageRoutes.post['/generations'](req({prompt:'status 99 img'},'s99-img'));
      assert.equal(imgRes.statusCode,502); assert.equal(imgRes.body.data,undefined);
      const imgTask=app.pool.readTask(imgRes.body.pool_task_id,app.ownerHash(key));
      assert.equal(imgTask.state,'unknown');
      const imgRec=await app.imageRoutes.get['/tasks/:taskId'](req({},'q-s99-img',{taskId:imgTask.id}));
      assert.equal(imgRec.recoverable,false); assert.deepEqual(imgRec.data,[]);
      app.pool.transitionTask(imgTask.id,{state:'failed'}); await app.pool.settleTask(imgTask.id);
      app.pool.markSuccess(app.pool.getSettings().fixedAccountId);

      const audRes=await app.audioRoutes.post['/generations'](req({prompt:'status 99 aud',wait:true},'s99-aud'));
      assert.equal(audRes.statusCode,502);
      const audTask=app.pool.readTask(audRes.body.pool_task_id,app.ownerHash(key));
      assert.equal(audTask.state,'unknown');
      const audQuery=await app.audioRoutes.get['/generations/:taskId'](req({},'q-s99-aud',{taskId:audTask.upstreamTaskId}));
      assert.equal(audQuery.data.complete,false); assert.equal(audQuery.data.audio_url,null);
      app.pool.transitionTask(audTask.id,{state:'failed'}); await app.pool.settleTask(audTask.id);
      app.pool.markSuccess(app.pool.getSettings().fixedAccountId);
    } finally {
      behavior='success';
    }
  });

  await t.test('completed tasks persist encrypted results for replay and owner recovery without re-querying upstream', async () => {
    globalThis.__poolTextFixture={submits:[],cookies:[],fail:false};
    const oldBrowserRequest=app.browserTransport.request;
    await app.browserTransport.setMode('always',false);
    app.browserTransport.request=async input=>axios.defaults.adapter({url:input.url,data:JSON.stringify(input.data||{}),headers:new axios.AxiosHeaders(input.headers)});
    try {
      const textBody={model:'glm-5.3-flash',messages:[{role:'user',content:'persist text'}]};
      const textRes=await app.chatRoutes.post['/completions'](req(textBody,'persist-text-1'));
      const textId=textRes.headers['X-Pool-Task-Id'];
      assert.equal(app.pool.readTaskResult(textId,app.ownerHash(key)).text,'fixture answer');
      assert.equal(JSON.stringify(app.pool.listTasks()).includes('fixture answer'),false);
      assert.throws(()=>app.pool.readTaskResult(textId,app.ownerHash(otherKey)),e=>e.statusCode===403);

      const textReplay=await app.chatRoutes.post['/completions'](req(textBody,'persist-text-1'));
      assert.equal(textReplay.statusCode,200); assert.equal(textReplay.body.reused,true);
      assert.equal(textReplay.body.choices[0].message.content,'fixture answer');
      assert.equal(textReplay.body.answer,'fixture answer');
      assert.equal(globalThis.__poolTextFixture.submits.length,1);

      const textGet=await app.chatRoutes.get['/tasks/:taskId'](req({},'q-text-1',{taskId:textId}));
      assert.equal(textGet.recoverable,true); assert.equal(textGet.answer,'fixture answer');
      assert.equal(textGet.data[0].text,'fixture answer');

      await app.browserTransport.setMode('off',false);
      const imgRes=await app.imageRoutes.post['/generations'](req({prompt:'cached img'},'cached-img-1'));
      const imgId=imgRes.pool_task_id;
      const histCallsBefore=calls.filter(c=>c.route==='/mweb/v1/get_history_by_ids').length;
      const imgGet=await app.imageRoutes.get['/tasks/:taskId'](req({},'q-img-cached',{taskId:imgId}));
      assert.equal(imgGet.recoverable,true); assert.equal(imgGet.data[0].url,'https://fixture.invalid/generated.webp');
      assert.equal(calls.filter(c=>c.route==='/mweb/v1/get_history_by_ids').length,histCallsBefore);

      const imgReplay=await app.imageRoutes.post['/generations'](req({prompt:'cached img'},'cached-img-1'));
      assert.equal(imgReplay.statusCode,200); assert.equal(imgReplay.body.reused,true);
      assert.equal(imgReplay.body.data[0].url,'https://fixture.invalid/generated.webp');
    } finally {
      app.browserTransport.request=oldBrowserRequest;
      await app.browserTransport.setMode('off',false);
      delete globalThis.__poolTextFixture;
    }
  });

  await t.test('video SSE 2-minute hint uses finish_reason=null; heartbeat slow failure still marks unknown', async () => {
    const oldTimeout=globalThis.setTimeout;
    globalThis.setTimeout=(fn,ms,...args)=>oldTimeout(fn,(ms===120000||ms===15000)?5:ms,...args);
    behavior='slow-timeout';
    try {
      const sseRes=await app.chatRoutes.post['/completions'](req({model:'jimeng-video-seedance-2.0',stream:true,messages:[{role:'user',content:'slow sse'}]},'slow-sse-1'));
      let sseRaw=''; for await(const chunk of sseRes.body) sseRaw+=chunk.toString();
      const frames=sseRaw.split('\n\n').filter(line=>line.startsWith('data: {')).map(line=>JSON.parse(line.slice(6)));
      assert.equal(frames.filter(f=>f.choices?.some(c=>c.finish_reason==='stop')).length,0);
      assert.equal(frames.filter(f=>f.error).length,1);
      assert.equal(app.pool.readTask(sseRes.headers['X-Pool-Task-Id'],app.ownerHash(key)).state,'unknown');
      app.pool.transitionTask(sseRes.headers['X-Pool-Task-Id'],{state:'failed'});
      await app.pool.settleTask(sseRes.headers['X-Pool-Task-Id']);
      app.pool.markSuccess(app.pool.getSettings().fixedAccountId);

      const hbRes=await app.videoRoutes.post['/generations'](req({model:'jimeng-video-seedance-2.0',prompt:'slow hb'},'slow-hb-1'));
      assert.ok(hbRes.headers['X-Pool-Task-Id']);
      let hbRaw=''; for await(const chunk of hbRes.body) hbRaw+=chunk.toString();
      const hbBody=JSON.parse(hbRaw.trim());
      assert.equal(hbBody.pool_task_id,hbRes.headers['X-Pool-Task-Id']);
      assert.equal(hbBody.state,'unknown');
      assert.equal(hbRaw.includes('leak-guard'),false);
      assert.equal(app.pool.readTask(hbRes.headers['X-Pool-Task-Id'],app.ownerHash(key)).state,'unknown');
      app.pool.transitionTask(hbRes.headers['X-Pool-Task-Id'],{state:'failed'});
      await app.pool.settleTask(hbRes.headers['X-Pool-Task-Id']);
      app.pool.markSuccess(app.pool.getSettings().fixedAccountId);
    } finally {
      globalThis.setTimeout=oldTimeout;
      behavior='success';
    }
  });

  await t.test('recoverStoredPoolTask recovers submitted media on real SQLite even when account disabled', async () => {
    const cId=app.pool.getSettings().fixedAccountId;
    const created=await app.audioRoutes.post['/generations'](req({prompt:'stored recovery'},'stored-rec-1'));
    const taskId=created.pool_task_id;
    app.pool.setEnabled(cId,false);
    const rec=await app.recoverStoredPoolTask(taskId);
    assert.equal(rec.recoverable,true);
    assert.equal(rec.data[0].url,'https://fixture.invalid/generated.mp3');
    const done=app.pool.readTask(taskId,app.ownerHash(key));
    assert.equal(done.state,'succeeded'); assert.equal(done.settling,false);
    assert.equal(app.pool.readTaskResult(taskId,app.ownerHash(key)).urls[0],'https://fixture.invalid/generated.mp3');
    app.pool.setEnabled(cId,true);
  });

  await t.test('Seedance 2.5 20s omni_reference and tail-frame upload fail-closed integrate with pool routes', async () => {
    const cId=app.pool.getSettings().fixedAccountId;
    const before=submissions().length;
    const rejected20s=await app.videoRoutes.post['/generations'](req({model:'jimeng-video-seedance-2.5',prompt:'20s no omni',duration:20,resolution:'720p'},'s25-no-omni'));
    assert.equal(rejected20s.statusCode,502);
    assert.equal(submissions().length,before);
    assert.equal(app.pool.readTask(rejected20s.body.pool_task_id,app.ownerHash(key)).state,'failed');
    app.pool.markSuccess(cId);

    const ok20s=await app.videoRoutes.post['/generations'](req({model:'jimeng-video-seedance-2.5',prompt:'20s omni',duration:20,resolution:'720p',function_mode:'omni_reference',file_paths:['https://fixture.invalid/ref.png']},'s25-20s-omni'));
    assert.equal(ok20s.data?.[0]?.url,'https://fixture.invalid/generated.mp4');
    assert.equal(submissions().length,before+1);
    const lastSubmit=submissions().at(-1);
    const draft=JSON.parse(lastSubmit.body.draft_content);
    const videoInput=draft.component_list[0].abilities.gen_video.text_to_video_params.video_gen_inputs[0];
    assert.equal(videoInput.duration_ms,20000);
    assert.equal(app.pool.readTask(ok20s.pool_task_id,app.ownerHash(key)).state,'succeeded');

    behavior='fail-tail-upload';
    try {
      const tailFail=await app.videoRoutes.post['/generations'](req({model:'jimeng-video-seedance-2.0',prompt:'tail fail',duration:5,resolution:'720p',file_paths:['https://fixture.invalid/f1.png','https://fixture.invalid/f2.png']},'tail-fail-1'));
      assert.equal(tailFail.statusCode,502);
      assert.equal(submissions().length,before+1);
      assert.equal(app.pool.readTask(tailFail.body.pool_task_id,app.ownerHash(key)).state,'failed');
    } finally {
      behavior='success';
      app.pool.markSuccess(cId);
    }
  });

  await t.test('missing or invalid API key on task recovery returns 401 while foreign valid key stays 403', async () => {
    const unauthReq={body:{},params:{taskId:imageTask},files:{},query:{},path:'/tasks/'+imageTask,headers:{},signal:new AbortController().signal,validate(){return this;}};
    const noAuth=await app.videoRoutes.get['/tasks/:taskId'](unauthReq);
    assert.equal(noAuth.statusCode,401);
    const badAuth=await app.videoRoutes.get['/tasks/:taskId'](req({},'bad-auth',{taskId:imageTask},'jm_invalid00000000000000000000'));
    assert.equal(badAuth.statusCode,401);
    const foreign=await app.imageRoutes.get['/tasks/:taskId'](req({},'foreign-auth',{taskId:imageTask},otherKey));
    assert.equal(foreign.statusCode,403);
  });

  await t.test('status 50 with missing item_list never releases image/video/audio or returns HTTP 200', async () => {
    const cId=app.pool.getSettings().fixedAccountId;
    behavior='missing-items';
    try {
      const imgRes=await app.imageRoutes.post['/generations'](req({prompt:'missing items img'},'missing-items-img'));
      assert.equal(imgRes.statusCode,502);
      assert.equal(imgRes.data,undefined);
      const imgTask=app.pool.readTask(imgRes.body.pool_task_id,app.ownerHash(key));
      assert.equal(imgTask.state,'unknown');
      assert.equal(app.pool.get(cId).scheduling.unknownCostBusy,true);
      const imgRec=await app.imageRoutes.get['/tasks/:taskId'](req({},'missing-items-img-q',{taskId:imgTask.id}));
      assert.equal(imgRec.recoverable,false);
      assert.deepEqual(imgRec.data,[]);
      app.pool.transitionTask(imgTask.id,{state:'failed'});
      await app.pool.settleTask(imgTask.id);
      app.pool.markSuccess(cId);

      const audRes=await app.audioRoutes.post['/generations'](req({prompt:'missing items aud',wait:true},'missing-items-aud'));
      assert.equal(audRes.statusCode,502);
      const audTask=app.pool.readTask(audRes.body.pool_task_id,app.ownerHash(key));
      assert.equal(audTask.state,'unknown');
      assert.equal(app.pool.get(cId).scheduling.unknownCostBusy,true);
      app.pool.transitionTask(audTask.id,{state:'failed'});
      await app.pool.settleTask(audTask.id);
      app.pool.markSuccess(cId);
    } finally {
      behavior='success';
    }
  });

  await t.test('foreground recoverPoolTask and background recoverStoredPoolTask reconcile terminal race after await', async () => {
    const cId=app.pool.getSettings().fixedAccountId;
    const oldAdapterFn=axios.defaults.adapter;
    try {
      const leaseWin=await app.pool.acquireTask({requestId:'fg-race-win',ownerHash:app.ownerHash(key),requestFingerprint:'fg-race-win',kind:'image',model:'jimeng-image-5.0-lite',estimatedCredits:null});
      app.pool.transitionTask(leaseWin.taskId,{state:'submitting'});
      app.pool.transitionTask(leaseWin.taskId,{state:'submitted',upstreamTaskId:'fg-hist-win'});
      axios.defaults.adapter=async config=>{
        const url=new URL(config.url);
        if(url.pathname==='/mweb/v1/get_history_by_ids'){
          app.pool.transitionTask(leaseWin.taskId,{state:'succeeded',result:{kind:'image',urls:['https://fixture.invalid/fg-winner.webp']}});
          return {status:200,statusText:'OK',headers:{},config,data:{ret:'0',data:{'fg-hist-win':{status:20}}}};
        }
        return oldAdapterFn(config);
      };
      const fgWin=await app.imageRoutes.get['/tasks/:taskId'](req({},'fg-race-win-q',{taskId:leaseWin.taskId}));
      assert.equal(fgWin.task.state,'succeeded');
      assert.equal(fgWin.recoverable,true);
      assert.equal(fgWin.data[0]?.url,'https://fixture.invalid/fg-winner.webp');
      app.pool.markSuccess(cId);

      const leaseFail=await app.pool.acquireTask({requestId:'fg-race-fail',ownerHash:app.ownerHash(key),requestFingerprint:'fg-race-fail',kind:'image',model:'jimeng-image-5.0-lite',estimatedCredits:null});
      app.pool.transitionTask(leaseFail.taskId,{state:'submitting'});
      app.pool.transitionTask(leaseFail.taskId,{state:'submitted',upstreamTaskId:'fg-hist-fail'});
      axios.defaults.adapter=async config=>{
        const url=new URL(config.url);
        if(url.pathname==='/mweb/v1/get_history_by_ids'){
          app.pool.transitionTask(leaseFail.taskId,{state:'failed'});
          return {status:200,statusText:'OK',headers:{},config,data:{ret:'0',data:{'fg-hist-fail':{status:50,item_list:[{image:{large_images:[{image_url:'https://fixture.invalid/fg-stale.webp'}]}}]}}}};
        }
        return oldAdapterFn(config);
      };
      const fgFail=await app.imageRoutes.get['/tasks/:taskId'](req({},'fg-race-fail-q',{taskId:leaseFail.taskId}));
      assert.equal(fgFail.task.state,'failed');
      assert.equal(fgFail.recoverable,false);
      assert.deepEqual(fgFail.data,[]);
      app.pool.markSuccess(cId);
    } finally {
      axios.defaults.adapter=oldAdapterFn;
    }
  });

  await t.test('/v1/audios/generations/:taskId and /v1/audio/tasks/:taskId enforce 401/403 auth isolation and terminal race reconciliation', async () => {
    const cId=app.pool.getSettings().fixedAccountId;
    const compat=app.audioCompatRoutes.find(route=>route.prefix==='/v1/audio');
    const disabledKeyRecord=app.db.createApiKey('disabled-audio-caller');
    app.db.setApiKeyEnabled(disabledKeyRecord.apiKey.id,false);
    const oldAdapterFn=axios.defaults.adapter;
    try {
      const genWinCreate=await app.audioRoutes.post['/generations'](req({prompt:'aud gen win race'},'aud-gen-win-create'));
      const genWinUp=genWinCreate.data.task_id;
      const genWinPool=genWinCreate.pool_task_id;
      const unauthGen={body:{},params:{taskId:genWinUp},files:{},query:{},path:'/generations/'+genWinUp,headers:{},signal:new AbortController().signal,validate(){return this;}};
      assert.equal((await app.audioRoutes.get['/generations/:taskId'](unauthGen)).statusCode,401);
      assert.equal((await app.audioRoutes.get['/generations/:taskId'](req({},'bad-gen-key',{taskId:genWinUp},'jm_invalid00000000000000000000'))).statusCode,401);
      assert.equal((await app.audioRoutes.get['/generations/:taskId'](req({},'bad-gen-missing',{taskId:'missing-audio-task'},'jm_invalid00000000000000000000'))).statusCode,401);
      assert.equal((await app.audioRoutes.get['/generations/:taskId'](req({},'disabled-gen-key',{taskId:genWinUp},disabledKeyRecord.key))).statusCode,401);
      assert.equal((await app.audioRoutes.get['/generations/:taskId'](req({},'foreign-gen-key',{taskId:genWinUp},otherKey))).statusCode,403);

      axios.defaults.adapter=async config=>{
        const url=new URL(config.url);
        if(url.pathname==='/mweb/v1/get_history_by_ids'){
          app.pool.transitionTask(genWinPool,{state:'succeeded',result:{kind:'audio',urls:['https://fixture.invalid/gen-winner.mp3']}});
          return {status:200,statusText:'OK',headers:{},config,data:{ret:'0',data:{[genWinUp]:{status:20}}}};
        }
        return oldAdapterFn(config);
      };
      const genWinRes=await app.audioRoutes.get['/generations/:taskId'](req({},'aud-gen-win-q',{taskId:genWinUp}));
      assert.equal(genWinRes.data.state,'succeeded');
      assert.equal(genWinRes.data.status,50);
      assert.equal(genWinRes.data.complete,true);
      assert.equal(genWinRes.data.audio_url,'https://fixture.invalid/gen-winner.mp3');
      assert.equal(genWinRes.data.url,'https://fixture.invalid/gen-winner.mp3');
      assert.equal(app.pool.readTask(genWinPool,app.ownerHash(key)).settling,false);
      app.pool.markSuccess(cId);

      axios.defaults.adapter=oldAdapterFn;
      const genFailCreate=await app.audioRoutes.post['/generations'](req({prompt:'aud gen fail race'},'aud-gen-fail-create'));
      const genFailUp=genFailCreate.data.task_id;
      const genFailPool=genFailCreate.pool_task_id;
      axios.defaults.adapter=async config=>{
        const url=new URL(config.url);
        if(url.pathname==='/mweb/v1/get_history_by_ids'){
          app.pool.transitionTask(genFailPool,{state:'failed',error:'concurrent gen failure'});
          return {status:200,statusText:'OK',headers:{},config,data:{ret:'0',data:{[genFailUp]:{status:50,item_list:[{audio:{origin_audio:{audio_url:'https://fixture.invalid/gen-stale.mp3'}}}]}}}};
        }
        return oldAdapterFn(config);
      };
      const genFailRes=await app.audioRoutes.get['/generations/:taskId'](req({},'aud-gen-fail-q',{taskId:genFailUp}));
      assert.equal(genFailRes.data.state,'failed');
      assert.equal(genFailRes.data.status,30);
      assert.equal(genFailRes.data.complete,false);
      assert.equal(genFailRes.data.audio_url,null);
      assert.equal(genFailRes.data.url,null);
      assert.equal(app.pool.readTask(genFailPool,app.ownerHash(key)).settling,false);
      app.pool.markSuccess(cId);

      axios.defaults.adapter=oldAdapterFn;
      const compatWinCreate=await compat.post['/tasks'](req({input:'compat win race'},'compat-win-create'));
      const compatWinUp=compatWinCreate.task_id;
      const compatWinPool=compatWinCreate.pool_task_id;
      const unauthCompat={body:{},params:{taskId:compatWinUp},files:{},query:{},path:'/tasks/'+compatWinUp,headers:{},signal:new AbortController().signal,validate(){return this;}};
      assert.equal((await compat.get['/tasks/:taskId'](unauthCompat)).statusCode,401);
      assert.equal((await compat.get['/tasks/:taskId'](req({},'bad-compat-key',{taskId:compatWinUp},'jm_invalid00000000000000000000'))).statusCode,401);
      assert.equal((await compat.get['/tasks/:taskId'](req({},'disabled-compat-key',{taskId:compatWinUp},disabledKeyRecord.key))).statusCode,401);
      assert.equal((await compat.get['/tasks/:taskId'](req({},'foreign-compat-key',{taskId:compatWinUp},otherKey))).statusCode,403);

      axios.defaults.adapter=async config=>{
        const url=new URL(config.url);
        if(url.pathname==='/mweb/v1/get_history_by_ids'){
          app.pool.transitionTask(compatWinPool,{state:'succeeded',result:{kind:'audio',urls:['https://fixture.invalid/compat-winner.mp3']}});
          return {status:200,statusText:'OK',headers:{},config,data:{ret:'0',data:{[compatWinUp]:{status:20}}}};
        }
        return oldAdapterFn(config);
      };
      const compatWinRes=await compat.get['/tasks/:taskId'](req({},'compat-win-q',{taskId:compatWinUp}));
      assert.equal(compatWinRes.status,'succeeded');
      assert.equal(compatWinRes.audio_url,'https://fixture.invalid/compat-winner.mp3');
      assert.equal(compatWinRes.url,'https://fixture.invalid/compat-winner.mp3');
      assert.equal(app.pool.readTask(compatWinPool,app.ownerHash(key)).settling,false);
      app.pool.markSuccess(cId);

      axios.defaults.adapter=oldAdapterFn;
      const compatFailCreate=await compat.post['/tasks'](req({input:'compat fail race'},'compat-fail-create'));
      const compatFailUp=compatFailCreate.task_id;
      const compatFailPool=compatFailCreate.pool_task_id;
      axios.defaults.adapter=async config=>{
        const url=new URL(config.url);
        if(url.pathname==='/mweb/v1/get_history_by_ids'){
          app.pool.transitionTask(compatFailPool,{state:'failed',error:'concurrent compat failure'});
          return {status:200,statusText:'OK',headers:{},config,data:{ret:'0',data:{[compatFailUp]:{status:50,item_list:[{audio:{origin_audio:{audio_url:'https://fixture.invalid/compat-stale.mp3'}}}]}}}};
        }
        return oldAdapterFn(config);
      };
      const compatFailRes=await compat.get['/tasks/:taskId'](req({},'compat-fail-q',{taskId:compatFailUp}));
      assert.equal(compatFailRes.status,'failed');
      assert.equal(compatFailRes.audio_url,null);
      assert.equal(compatFailRes.url,null);
      assert.equal(app.pool.readTask(compatFailPool,app.ownerHash(key)).settling,false);
      app.pool.markSuccess(cId);

      axios.defaults.adapter=oldAdapterFn;
      const genCatchCreate=await app.audioRoutes.post['/generations'](req({prompt:'aud gen catch race'},'aud-gen-catch-create'));
      const genCatchUp=genCatchCreate.data.task_id;
      const genCatchPool=genCatchCreate.pool_task_id;
      axios.defaults.adapter=async config=>{
        const url=new URL(config.url);
        if(url.pathname==='/mweb/v1/get_history_by_ids'){
          app.pool.transitionTask(genCatchPool,{state:'succeeded',result:{kind:'audio',urls:['https://fixture.invalid/catch-winner.mp3']}});
          return {status:200,statusText:'OK',headers:{},config,data:{ret:'0',data:{}}};
        }
        return oldAdapterFn(config);
      };
      const genCatchRes=await app.audioRoutes.get['/generations/:taskId'](req({},'aud-gen-catch-q',{taskId:genCatchUp}));
      assert.equal(genCatchRes.data.state,'succeeded');
      assert.equal(genCatchRes.data.audio_url,'https://fixture.invalid/catch-winner.mp3');
      assert.equal(app.pool.readTask(genCatchPool,app.ownerHash(key)).settling,false);
      app.pool.markSuccess(cId);
    } finally {
      axios.defaults.adapter=oldAdapterFn;
    }
  });

});
