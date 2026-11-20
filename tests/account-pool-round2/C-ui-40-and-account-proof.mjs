// Focused second-round UI acceptance: real HTTP + temporary DB + synthetic upstream.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork, execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jimeng-pool-ui-int-round2-')));
for (const name of ['node_modules', 'public', 'configs', 'package.json']) fs.symlinkSync(path.join(repo, name), path.join(root, name));
const bundle = path.join(root, 'server.mjs');
const checks = [], apiCalls = [], pageErrors = [];
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(repo,file))).digest('hex');
function fingerprint() {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(path.join(repo,dir),{withFileTypes:true})) {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(file); else if (entry.isFile()) files.push(file);
    }
  }
  for (const dir of ['src','public','configs']) walk(dir);
  files.push('package.json','tsconfig.json','tests/account-pool-ui/upstream-fixture.ts','tests/account-pool-ui/loopback-guard.cjs',path.relative(repo,fileURLToPath(import.meta.url)));
  for (const file of ['package-lock.json','pnpm-lock.yaml','yarn.lock']) if(fs.existsSync(path.join(repo,file))) files.push(file);
  return Object.fromEntries(files.sort().map(file=>[file,hash(file)]));
}
const before = fingerprint();
const version = {head:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),node:process.version};
fs.writeFileSync(path.join(root,'inputs.json'),JSON.stringify({version,files:before},null,2));
await build({
  stdin: { resolveDir: repo, loader: 'ts', contents: `
    import server from './src/lib/server.ts';
    import routes from './src/api/routes/index.ts';
    import pool from './src/lib/account-pool.ts';
    import auth from './src/lib/database.ts';
    async function main() {
      auth.createUser('round2-ui-admin', 'synthetic-password');
      const session = auth.createSession(1);
      const a = pool.create({name:'隔离账号 Alpha',sessionId:'virtual-alpha-250'});
      const b = pool.create({name:'隔离账号 Gamma',sessionId:'virtual-gamma-199'});
      await pool.refreshStatus(a.id); await pool.refreshStatus(b.id);
      server.attachRoutes(routes);
      const listener = server.app.listen(0, '127.0.0.1', () => process.send({ready:true,port:listener.address().port,session,ids:{a:a.id,b:b.id}}));
      let latestTask;
      process.on('message', async m => {
        try {
          if(m.action==='settleLatest') {
            pool.transitionTask(latestTask,{state:'succeeded',result:{synthetic:true}});
            await pool.settleTask(latestTask);
            return process.send({request:m.request,result:{taskId:latestTask}});
          }
          if(m.action!=='seedTask') throw Error('Unknown test control');
          const lease = await pool.acquireTask({requestId:'round2-ui-task-'+m.request,ownerHash:'synthetic-owner',requestFingerprint:'synthetic-fingerprint-'+m.request,kind:'video',model:'synthetic-model',estimatedCredits:null});
          pool.transitionTask(lease.taskId,{state:'submitting'});
          pool.transitionTask(lease.taskId,{state:'submitted',upstreamTaskId:'synthetic-upstream-task'});
          latestTask=lease.taskId;
          process.send({request:m.request,result:{taskId:lease.taskId,accountId:lease.account.id}});
        } catch(e) { process.send({request:m.request,error:e.message}); }
      });
    }
    main().catch(e=>{console.error(e);process.exit(1)});
  ` },
  outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external',
  banner:{js:"import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"},
  tsconfig: path.join(repo, 'tsconfig.json'),
  plugins: [{ name: 'isolated-upstream', setup(b) {
    b.onResolve({filter: /(?:^|\/)core\.ts$/}, () => ({path:path.join(repo,'tests/account-pool-ui/upstream-fixture.ts')}));
  }}]
});
const child = fork(bundle, [], { cwd: root, silent: true, env: {
  PATH:process.env.PATH,HOME:root,TMPDIR:root,TZ:'Asia/Shanghai',
  UI_INTEGRATION_ROOT:root,DB_PATH:path.join(root,'isolated.sqlite'),
  JIMENG_ACCOUNT_POOL_KEY:'synthetic-round2-key',JIMENG_BROWSER_TRANSPORT:'off',
  NODE_OPTIONS:`--require=${JSON.stringify(path.join(repo,'tests/account-pool-ui/loopback-guard.cjs'))}`
}});
let childLog = '', browser;
child.stdout.on('data', d => childLog += d); child.stderr.on('data', d => childLog += d);
const ready = new Promise((resolve,reject) => {
  const timer=setTimeout(()=>reject(Error('Isolated server did not start')),15000);
  child.once('error', reject);
  child.once('exit', code=>{clearTimeout(timer);reject(Error(`Isolated server exited ${code}`));});
  child.on('message', m=>{if(m.ready){clearTimeout(timer);resolve(m);}});
});
let seq=0;
function control(action) {
  return new Promise((resolve,reject)=>{
    const request=++seq;
    const timer=setTimeout(()=>{child.off('message',onMessage);reject(Error('Test control timed out'));},10000);
    function onMessage(m){if(m.request!==request)return;clearTimeout(timer);child.off('message',onMessage);m.error?reject(Error(m.error)):resolve(m.result);}
    child.on('message',onMessage); child.send({request,action});
  });
}
try {
  const {port,session,ids}=await ready;
  const base=`http://127.0.0.1:${port}`;
  const dashboard=async()=>{
    const res=await fetch(base+'/account-pool/dashboard',{headers:{cookie:`session=${session}`}});
    assert.equal(res.status,200);return res.json();
  };
  browser=await chromium.launch({headless:true,channel:'chrome'});
  const context=await browser.newContext({viewport:{width:1440,height:960}});
  await context.addCookies([{name:'session',value:session,url:base,httpOnly:true,sameSite:'Lax'}]);
  await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
  const page=await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('dialog', dialog=>dialog.accept());
  page.on('pageerror', e=>pageErrors.push(e.message));
  page.on('response', r=>{const u=new URL(r.url());if(u.pathname.startsWith('/account-pool/'))apiCalls.push({path:u.pathname,method:r.request().method(),status:r.status()});});
  await page.goto(base,{waitUntil:'domcontentloaded'});
  await page.locator('#dashboard.active').waitFor();
  await page.locator('.tab-btn[data-tab="accounts"]').click();
  await page.waitForFunction(()=>document.getElementById('pool-threshold').value==='200');
  await page.locator('#pool-threshold').fill('40');
  await page.locator('#pool-save-settings').click();
  await page.waitForFunction(()=>document.getElementById('pool-message').textContent.includes('调度设置已保存'));
  assert.equal((await dashboard()).settings.threshold,40);
  await page.reload({waitUntil:'domcontentloaded'});
  await page.locator('.tab-btn[data-tab="accounts"]').click();
  await page.waitForFunction(()=>document.getElementById('pool-threshold').value==='40');
  checks.push('40 分门槛通过真实 PATCH 保存，浏览器刷新与服务端再次读取一致');

  await page.locator(`[data-account-id="${ids.b}"] [data-action="up"]`).click();
  await page.locator('#pool-save-order').click();
  await page.waitForFunction(()=>document.getElementById('pool-message').textContent.includes('排序已保存'));
  assert.equal((await dashboard()).accounts[0].id,ids.b);
  assert.equal(await page.locator('#pool-next').innerText(),'隔离账号 Gamma');
  assert.equal(await page.locator('#pool-last-used').innerText(),'暂无实际使用记录');
  checks.push('手动排序真实保存；候选变化不冒充实际使用');
  await page.reload({waitUntil:'domcontentloaded'});
  await page.locator('.tab-btn[data-tab="accounts"]').click();
  await page.waitForFunction(()=>document.querySelector('#accounts-table tr')?.textContent.includes('隔离账号 Gamma'));

  const task=await control('seedTask');
  assert.equal(task.accountId,ids.b);
  await page.locator('#pool-refresh').click();
  await page.waitForFunction(()=>document.getElementById('pool-last-used').textContent==='隔离账号 Gamma');
  assert.equal(await page.locator('#pool-next').innerText(),'隔离账号 Alpha');
  const taskRow=page.locator('#pool-tasks tr').filter({hasText:task.taskId});
  assert.match(await taskRow.innerText(),/隔离账号 Gamma/);
  assert.match(await taskRow.innerText(),/synthetic-upstream-task/);
  checks.push('真实任务记录显示原绑定账号与上游 ID，下一候选与最近实际账号分开展示');

  await page.locator('#pool-mode').selectOption('fixed');
  await page.locator('#pool-fixed').selectOption(ids.b);
  await page.locator('#pool-save-settings').click();
  await page.waitForFunction(()=>document.getElementById('pool-next').textContent==='暂无合格候选');
  assert.equal((await dashboard()).settings.fixedAccountId,ids.b);
  assert.match(await taskRow.innerText(),/隔离账号 Gamma/);
  checks.push('固定号被在途未知费用任务占用时显示无合格候选，旧任务绑定保留');
  const priorSwitch=(await dashboard()).summary.lastSwitch;
  assert.equal(priorSwitch.toAccountId,ids.b);
  await page.locator('#pool-fixed').selectOption(ids.a);
  await page.locator('#pool-save-settings').click();
  await page.waitForFunction(()=>document.getElementById('pool-next').textContent==='隔离账号 Alpha' && document.getElementById('pool-message').textContent.includes('调度设置已保存'));
  assert.equal((await dashboard()).summary.lastSwitch.id,priorSwitch.id);
  assert.equal(await page.locator('#pool-last-used').innerText(),'隔离账号 Gamma');
  const secondTask=await control('seedTask');
  assert.equal(secondTask.accountId,ids.a);
  await page.locator('#pool-refresh').click();
  await page.waitForFunction(()=>document.getElementById('pool-last-used').textContent==='隔离账号 Alpha');
  const switched=(await dashboard()).summary.lastSwitch;
  assert.equal(switched.fromAccountId,ids.b);
  assert.equal(switched.toAccountId,ids.a);
  assert.equal(switched.reason,'固定账号策略');
  assert.match(await page.locator('#pool-last-switch').innerText(),/隔离账号 Gamma → 隔离账号 Alpha · 固定账号策略/);
  assert.match(await page.locator('#pool-events').innerText(),/手动排序中首个合格账号/);
  assert.match(await page.locator('#pool-events').innerText(),/固定账号策略/);
  assert.match(await taskRow.innerText(),/隔离账号 Gamma/);
  assert.equal(await page.locator('#pool-active').innerText(),'2');
  checks.push('仅实际 acquireTask 后产生 Gamma → Alpha 切换及固定账号策略原因；原任务绑定不变');

  const row=page.locator(`[data-account-id="${ids.a}"]`);
  const busyResponse=page.waitForResponse(r=>r.url()===base+`/account-pool/${ids.a}/refresh-status`);
  await row.locator('[data-action="refresh"]').click();
  assert.equal((await busyResponse).status(),409);
  await page.waitForFunction(()=>document.getElementById('pool-message').textContent.includes('账号有未结算任务，暂缓余额刷新'));
  checks.push('在途账号刷新收到真实 409，UI 展示暂缓刷新原因');
  assert.equal((await control('settleLatest')).taskId,secondTask.taskId);
  fs.writeFileSync(path.join(root,'fail-identity-sessions.json'),JSON.stringify(['virtual-alpha-250']));
  await row.locator('[data-action="refresh"]').click();
  await row.getByText('身份为上次核验 · 本次刷新失败',{exact:true}).waitFor();
  assert.match(await row.getByText('身份为上次核验 · 本次刷新失败',{exact:true}).getAttribute('class'),/badge-warn/);
  assert.equal((await dashboard()).accounts.find(a=>a.id===ids.a).upstreamIdentity.refreshFailed,true);
  await row.screenshot({path:path.join(root,'identity-failed.png')});
  fs.unlinkSync(path.join(root,'fail-identity-sessions.json'));
  await row.locator('[data-action="refresh"]').click();
  await row.getByText('上游身份已核验',{exact:true}).waitFor();
  assert.match(await row.getByText('上游身份已核验',{exact:true}).getAttribute('class'),/badge-success/);
  assert.equal((await dashboard()).accounts.find(a=>a.id===ids.a).upstreamIdentity.refreshFailed,false);
  await row.screenshot({path:path.join(root,'identity-recovered.png')});
  checks.push('身份刷新失败展示历史核验黄色状态，真实刷新恢复后绿标重现');

  // A competing administrator writes through the same real HTTP endpoint.
  await page.locator('#pool-threshold').fill('41');
  const current=(await dashboard()).settings;
  const concurrent=await fetch(base+'/account-pool/settings',{method:'PATCH',headers:{cookie:`session=${session}`,'content-type':'application/json'},body:JSON.stringify({...current,threshold:40})});
  assert.equal(concurrent.status,200);
  const conflictResponse=page.waitForResponse(r=>r.url()===base+'/account-pool/settings'&&r.request().method()==='PATCH');
  await page.locator('#pool-save-settings').click();
  assert.equal((await conflictResponse).status(),409);
  await page.waitForFunction(()=>document.getElementById('pool-message').textContent.includes('配置已被其他管理员修改'));
  assert.equal(await page.locator('#pool-threshold').inputValue(),'41');
  assert.equal(await page.locator('#pool-save-settings').isDisabled(),true);
  assert.equal((await dashboard()).settings.threshold,40);
  await page.locator('#pool-settings').screenshot({path:path.join(root,'settings-conflict.png')});
  await page.locator('#pool-refresh').click();
  await page.waitForFunction(()=>document.getElementById('pool-threshold').value==='40'&&!document.getElementById('pool-settings-fields').disabled);
  checks.push('真实 HTTP 409 保留草稿并锁定保存，刷新恢复服务端 40 分，无假成功');

  const validSettings=(await dashboard()).settings;
  await page.locator('#pool-balance-age').fill('86401');
  const rejectedResponse=page.waitForResponse(r=>r.url()===base+'/account-pool/settings'&&r.request().method()==='PATCH');
  await page.locator('#pool-save-settings').click();
  assert.equal((await rejectedResponse).status(),400);
  await page.waitForFunction(()=>document.getElementById('pool-message').textContent.includes('模式、阈值或余额有效期无效'));
  assert.doesNotMatch(await page.locator('#pool-message').innerText(),/已保存/);
  assert.equal(await page.locator('#pool-balance-age').inputValue(),'86401');
  assert.deepEqual((await dashboard()).settings,validSettings);
  await page.locator('#pool-settings').screenshot({path:path.join(root,'settings-rejected.png')});
  await page.locator('#pool-refresh').click();
  await page.waitForFunction(()=>document.getElementById('pool-balance-age').value!=='86401');
  checks.push('真实 HTTP 400 拒绝超限有效期，保留错误草稿且服务端设置和版本不变');

  for(const asset of ['account-pool-ui.js','account-pool-ui.css']) {
    const response=await fetch(base+'/'+asset);
    assert.equal(response.status,200);
    assert.equal(await response.text(),fs.readFileSync(path.join(repo,'public',asset),'utf8'));
  }
  assert.deepEqual(await page.evaluate(()=>{
    const style=getComputedStyle(document.documentElement);
    return ['--bg','--primary'].map(name=>style.getPropertyValue(name).trim());
  }),['#080c18','#8b5cf6']);
  await page.locator('#pool-threshold').scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(root,'desktop.png')});
  await page.locator('#pool-tasks').screenshot({path:path.join(root,'tasks.png')});
  await page.locator('#pool-events').screenshot({path:path.join(root,'events.png')});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  assert.equal(await page.locator('#pool-threshold').inputValue(),'40');
  await page.locator('#pool-threshold').scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(root,'mobile.png')});
  checks.push('390px 窄屏无全页横向溢出，40 分设置仍可见');
  assert.deepEqual(pageErrors,[]);
  assert.ok(apiCalls.some(c=>c.path==='/account-pool/settings'&&c.method==='PATCH'&&c.status===200));
  const after=fingerprint();
  assert.deepEqual(after,before,'Frozen production inputs changed during acceptance');
  fs.writeFileSync(path.join(root,'dashboard.json'),JSON.stringify(await dashboard(),null,2));
  fs.writeFileSync(path.join(root,'results.json'),JSON.stringify({passed:true,version,browser:browser.version(),checks,apiCalls,pageErrors,inputsUnchanged:true,environment:'isolated Koa + synthetic upstream; no real account mutation or generation'},null,2));
  console.log(JSON.stringify({passed:true,checks:checks.length,evidence:root}));
} catch(error) {
  fs.writeFileSync(path.join(root,'results.json'),JSON.stringify({passed:false,version,checks,apiCalls,error:error.message,pageErrors},null,2));
  console.error(error);console.error(`Evidence: ${root}`);process.exitCode=1;
} finally {
  await browser?.close();
  child.kill('SIGTERM');
  fs.writeFileSync(path.join(root,'server.log'),childLog);
}
