/* Administrator account pool UI. No credential or mock data is stored here. */
(() => {
  const pool = { snapshot: null, order: [], revision: null, settingsDirty: false, orderDirty: false, conflict: false, busy: false, loading: false, epoch: 0, dragId: null, pages: { tasks: 0, events: 0 }, totals: { tasks: null, events: null } };
  const h = (value) => esc(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const number = (value) => typeof value === 'number' && Number.isFinite(value) ? String(value) : '未知';
  const accountName = (id) => pool.snapshot?.accounts.find((a) => a.id === id)?.name || id || '—';
  const states = { reserved: '已预占', submitting: '等待上游回执', submitted: '已提交', running: '运行中', succeeded: '已完成', failed: '失败', unknown: '提交待确认', settling: '结算待确认' };
  const kinds = { image: '图片', video: '视频', audio: '音频', text: '文本', upload: '素材上传' };
  const eventNames = { credits_rejected: '积分不足拒单', credit_retry_stopped: '换号接力结束', settings_updated: '设置更新', order_updated: '排序更新', account_selected: '任务选号', account_switched: '实际账号切换', task_acquired: '任务绑定', task_reserved: '任务预占', task_transition: '任务状态更新', task_state: '任务状态更新', task_settled: '任务结算', balance_settled: '余额结算释放', balance_refreshed: '余额刷新', balance_refresh_failed: '余额刷新失败', account_created: '添加账号', account_updated: '账号更新', credential_updated: '更新凭据', account_enabled: '启用账号', account_disabled: '停用账号', account_deleted: '删除账号' };
  const tag = (text, style = 'muted') => `<span class="badge badge-${style}">${h(text)}</span>`;
  const detail = (text, style = '') => `<div class="pool-detail ${style}">${h(text)}</div>`;
  function identityBlock(identity, membership) {
    const verified = Boolean(identity.verified);
    const failed = Boolean(identity.refreshFailed);
    const badgeLabel = verified ? (failed ? '身份为上次核验 · 本次刷新失败' : '上游身份已核验') : (failed ? '上游身份未核验 · 刷新失败' : '上游身份未核验');
    const subject = verified ? `${failed ? '沿用上次核验：' : ''}${identity.displayName || '未提供昵称'} · ID ${identity.userId || '未提供'}` : '未核验：本地备注不能证明上游身份';
    const checkedLabel = verified && failed ? '上次核验' : '核验时间';
    const attempt = failed || (identity.lastRefreshAttemptAt && identity.lastRefreshAttemptAt !== identity.checkedAt);
    const sourceLabel = identity.source ? `${verified && failed ? '上次核验来源' : '核验来源'}：${identity.source}` : '核验来源：服务端上游核验字段（具体来源未提供）';
    return [
      tag(badgeLabel, verified && !failed ? 'success' : 'warn'),
      detail(subject),
      detail(`${checkedLabel}：${dateText(identity.checkedAt)}`),
      attempt ? detail(`上次尝试刷新：${dateText(identity.lastRefreshAttemptAt)}`) : '',
      failed ? detail(`身份刷新失败：${identity.refreshError || '上游身份核验本次刷新失败'}`, 'pool-warning') : '',
      detail(sourceLabel),
      detail(`会员：${membershipText(membership)}`)
    ].join('');
  }
  function message(text = '', error = false) {
    $('pool-message').textContent = text;
    $('pool-message').classList.toggle('hidden', !text);
    $('pool-message').classList.toggle('pool-error', error);
  }
  async function request(path, method = 'GET', body) {
    const response = await fetch(path, { method, credentials: 'include', cache: 'no-store', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    let data;
    try { data = await response.json(); } catch { throw new Error(`服务未返回有效 JSON（HTTP ${response.status}），请刷新核对结果`); }
    if (!response.ok || data?.error || data?.success === false || isApiFailure(data)) {
      const revisionConflict = response.status === 409 && ['/account-pool/settings', '/account-pool/order'].includes(path);
      const error = new Error(revisionConflict ? '配置已被其他管理员修改，请点击“刷新面板”加载最新版本后重新修改。' : response.status === 401 ? '管理员登录已失效，请重新登录。' : typeof apiError(data, '') === 'string' && apiError(data, '') || `请求失败（HTTP ${response.status}）`);
      error.status = response.status;
      error.revisionConflict = revisionConflict;
      throw error;
    }
    return data;
  }
  function validSettings(settings) {
    return settings && ['auto', 'fixed'].includes(settings.mode) && Number.isInteger(settings.revision) && Number.isFinite(settings.threshold) && settings.threshold >= 0 && Number.isInteger(settings.balanceMaxAgeSeconds) && settings.balanceMaxAgeSeconds > 0;
  }
  function validDashboard(data) {
    return validSettings(data?.settings) && data.summary && Array.isArray(data.accounts) && Array.isArray(data.tasks) && Array.isArray(data.events);
  }
  function report(error) {
    if (error.revisionConflict) pool.conflict = true;
    message(error.message || '请求失败，请检查服务状态', true);
    showToast(error.message || '请求失败');
    controls();
  }
  function controls() {
    $('pool-settings-fields').disabled = !pool.snapshot || pool.busy || pool.conflict;
    $('pool-save-settings').disabled = !pool.settingsDirty || pool.busy || pool.conflict || pool.orderDirty;
    $('pool-save-order').disabled = !pool.orderDirty || pool.busy || pool.conflict || pool.settingsDirty;
    $('pool-refresh').disabled = pool.busy || pool.loading;
    $('pool-create').disabled = pool.busy;
    $('pool-settings-note').textContent = pool.conflict ? '版本冲突：草稿未保存，请刷新面板。' : pool.settingsDirty ? '设置尚未保存；自动刷新会保留草稿。' : pool.snapshot ? `已读取服务端设置 · 版本 ${pool.revision}` : '尚未读取到服务端设置';
    $('pool-order-note').textContent = pool.orderDirty ? '排序尚未保存，当前候选仍基于服务端顺序。保存后仅影响新任务。' : '停用只停止新任务派发；有进行中、待确认或结算任务的账号不能删除。';
    document.querySelectorAll('#accounts-table button').forEach((button) => {
      button.disabled = button.dataset.blocked === 'true' || pool.busy || pool.conflict;
    });
  }
  function fillSettings(settings) {
    $('pool-mode').value = settings.mode;
    $('pool-fixed').value = settings.fixedAccountId || '';
    $('pool-threshold').value = settings.threshold;
    $('pool-balance-age').value = settings.balanceMaxAgeSeconds;
    fixedHint();
  }
  function fixedHint() {
    const fixed = $('pool-mode').value === 'fixed';
    $('pool-fixed-group').classList.toggle('hidden', !fixed);
    $('pool-fixed').required = fixed;
    const account = pool.snapshot?.accounts.find((a) => a.id === $('pool-fixed').value);
    $('pool-fixed-reason').textContent = account ? `当前资格：${account.scheduling?.eligible ? '合格' : '不合格'} · ${account.scheduling?.reason || '原因未知'}。提交时重新核验。` : '请选择账号；不合格时任务会明确失败。';
  }
  function restoreRowFocus(id, action) {
    const row = [...$('accounts-table').querySelectorAll('tr')].find((item) => item.dataset.accountId === id);
    const button = row?.querySelector(`[data-action="${action}"]`);
    (button && !button.disabled ? button : row?.querySelector('[data-action="drag"]'))?.focus();
  }
  function renderAccounts() {
    const focused = document.activeElement?.closest('#accounts-table button[data-action]');
    const focusedId = focused?.closest('tr')?.dataset.accountId, focusedAction = focused?.dataset.action;
    const accounts = pool.order.map((id) => pool.snapshot.accounts.find((a) => a.id === id)).filter(Boolean);
    $('accounts-table').innerHTML = accounts.map((a, index) => {
      const schedule = a.scheduling || {}, identity = a.upstreamIdentity || {}, status = a.status || {};
      const stale = !status.checkedAt || !Number.isFinite(Date.parse(status.checkedAt)) || Date.now() - Date.parse(status.checkedAt) > pool.snapshot.settings.balanceMaxAgeSeconds * 1000;
      const busy = schedule.activeTaskCount > 0 || schedule.unknownCostBusy || pool.snapshot.tasks.some((t) => t.accountId === a.id && (t.settling || ['reserved', 'submitting', 'submitted', 'running', 'unknown', 'settling'].includes(t.state)));
      return `<tr data-account-id="${h(a.id)}"><td><div class="pool-order-actions"><button type="button" class="btn btn-secondary pool-drag" draggable="true" data-action="drag" aria-label="拖动排序 ${h(a.name)}；也可使用下方上移下移按钮">⠿ 排序 ${index + 1}</button><button type="button" class="btn btn-secondary" data-action="up" data-blocked="${index === 0 || pool.settingsDirty}" aria-label="上移 ${h(a.name)}">↑ 上移</button><button type="button" class="btn btn-secondary" data-action="down" data-blocked="${index === accounts.length - 1 || pool.settingsDirty}" aria-label="下移 ${h(a.name)}">↓ 下移</button></div></td><td class="pool-wrap"><strong>${h(a.name || '未命名账号')}</strong><span class="pool-id">${h(a.id)}</span>${identityBlock(identity, status.membership)}</td><td class="pool-wrap"><strong>可用 ${h(number(schedule.availableCredits))}</strong>${detail(`最新余额 ${number(status.totalCredit)} · 预占 ${number(schedule.reservedCredits)}`)}${detail(`余额更新：${dateText(status.checkedAt)}`)}${stale ? tag('余额未知或已过期', 'warn') : ''}${status.error ? detail(`刷新失败：${status.error}`, 'pool-warning') : ''}</td><td class="pool-wrap">${badge(a.enabled)} ${tag(schedule.eligible ? '可接新任务' : '暂不可接单', schedule.eligible ? 'success' : 'warn')}${detail(schedule.reason || '资格原因未知')}${detail(`进行中 / 待确认：${number(schedule.activeTaskCount)}`)}${schedule.unknownCostBusy ? tag('费用未知 · 独占中', 'warn') : ''}${a.cooldownUntil ? detail(`冷却至：${dateText(a.cooldownUntil)}`) : ''}${detail(`最近实际使用：${dateText(a.lastUsedAt)}`)}</td><td><div class="row-actions"><button type="button" class="btn btn-secondary" data-action="toggle">${a.enabled ? '停用' : '启用'}</button><button type="button" class="btn btn-secondary" data-action="refresh">刷新余额 / 状态</button><button type="button" class="btn btn-danger" data-action="delete" data-blocked="${busy}" ${busy ? 'title="有进行中、待确认或结算任务，不能删除"' : ''}>删除</button></div></td></tr>`;
    }).join('') || emptyRow(5, '还没有账号，请从左侧添加');
    controls();
    if (focusedId) restoreRowFocus(focusedId, focusedAction);
  }
  function renderRecords(kind, items) {
    if (kind === 'tasks') {
      $('pool-tasks').innerHTML = items.map((t) => `<tr><td class="pool-wrap"><strong>${h(t.id)}</strong><span class="pool-id">请求：${h(t.requestId)}</span></td><td class="pool-wrap">${h(t.accountName || accountName(t.accountId))}<span class="pool-id">${h(t.accountId)}</span></td><td class="pool-wrap">${h(kinds[t.kind] || t.kind)}${detail(t.model || '未提供模型')}</td><td class="pool-wrap">${tag(states[t.state] || t.state, t.state === 'succeeded' ? 'success' : ['unknown', 'failed', 'settling'].includes(t.state) ? 'warn' : 'muted')}${t.settling ? detail('结算待确认 · 占位尚未释放', 'pool-warning') : ''}${detail(`预估积分：${number(t.estimatedCredits)}`)}${t.error ? detail(t.error, 'pool-warning') : ''}</td><td class="pool-wrap">${h(t.upstreamTaskId || (t.state === 'unknown' ? '无上游 ID · 无法据此自动找回' : '尚无上游任务 ID'))}${detail(`创建：${dateText(t.createdAt)}`)}${detail(`更新：${dateText(t.updatedAt)}`)}</td></tr>`).join('') || emptyRow(5, '暂无任务记录');
    } else {
      $('pool-events').innerHTML = items.map((e) => `<tr><td>${h(dateText(e.createdAt))}</td><td class="pool-wrap">${h(eventNames[e.type] || e.type)}<span class="pool-id">${h(e.id)}</span></td><td class="pool-wrap">${h(e.fromAccountId || e.toAccountId ? `${accountName(e.fromAccountId)} → ${accountName(e.toAccountId)}` : accountName(e.accountId))}<span class="pool-id">${h(e.accountId || e.toAccountId || '')}</span></td><td class="pool-wrap">${h(e.reason || '未提供原因')}${e.actor ? detail(`操作者：${e.actor}`) : ''}</td></tr>`).join('') || emptyRow(4, '暂无操作或调度事件');
    }
    const offset = pool.pages[kind], total = pool.totals[kind];
    $(`pool-${kind}-page`).textContent = total === null ? `最近 ${items.length} 条` : `${total ? offset + 1 : 0}–${offset + items.length} / ${total} 条`;
    $(`pool-${kind}-prev`).disabled = offset === 0;
    $(`pool-${kind}-next`).disabled = total === null ? items.length < 50 : offset + items.length >= total;
  }
  function applyDashboard(data, reset = false) {
    if (!validDashboard(data)) throw new Error('账号池响应格式不完整，未更新界面，请检查服务版本。');
    if (reset) { pool.settingsDirty = false; pool.orderDirty = false; pool.conflict = false; }
    const dirty = pool.settingsDirty || pool.orderDirty;
    if (dirty && data.settings.revision !== pool.revision) {
      pool.conflict = true;
      message('服务端配置已更新，当前草稿未保存。请点击“刷新面板”加载最新版本后重新修改。', true);
    }
    pool.snapshot = data;
    if (!dirty) { pool.revision = data.settings.revision; pool.order = [...data.accounts].sort((a, b) => a.priority - b.priority).map((a) => a.id); }
    const selected = $('pool-fixed').value;
    $('pool-fixed').innerHTML = '<option value="">请选择账号</option>' + data.accounts.map((a) => `<option value="${h(a.id)}">${h(a.name || a.id)}${a.enabled ? '' : '（已停用）'}</option>`).join('');
    if (!pool.settingsDirty) fillSettings(data.settings); else { $('pool-fixed').value = selected; fixedHint(); }
    $('account-total').textContent = data.accounts.length;
    $('account-disabled').textContent = `已停用 ${data.accounts.filter((a) => !a.enabled).length} 个`;
    $('pool-next').textContent = data.summary.nextAccountId ? accountName(data.summary.nextAccountId) : '暂无合格候选';
    $('pool-next-reason').textContent = `${data.summary.nextReason || '原因未知'} · ${dateText(data.summary.predictedAt)} · 提交时再判定`;
    $('pool-active').textContent = number(data.summary.activeTaskCount);
    const active = data.accounts.filter((a) => a.scheduling?.activeTaskCount > 0);
    $('pool-active-accounts').textContent = active.length ? active.map((a) => `${a.name}：${a.scheduling.activeTaskCount}`).join('；') : '暂无实际任务占位';
    const latest = [...data.accounts].filter((a) => a.lastUsedAt).sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt))[0];
    $('pool-last-used').textContent = latest?.name || '暂无实际使用记录';
    $('pool-last-used-at').textContent = latest ? dateText(latest.lastUsedAt) : '预览候选不会更新实际使用时间';
    $('pool-last-switch').textContent = data.summary.lastSwitch ? `最近实际切换：${accountName(data.summary.lastSwitch.fromAccountId)} → ${accountName(data.summary.lastSwitch.toAccountId)} · ${data.summary.lastSwitch.reason} · ${dateText(data.summary.lastSwitch.createdAt)}` : '暂无实际切换事件；下一候选不代表已实际切换。';
    renderAccounts();
    for (const kind of ['tasks', 'events']) if (pool.pages[kind] === 0) { pool.totals[kind] = null; renderRecords(kind, data[kind]); }
  }
  window.loadAccounts = async function () {
    if (pool.loading || pool.busy || pool.dragId) return false;
    pool.loading = true; controls();
    const epoch = pool.epoch;
    try {
      const data = await request('/account-pool/dashboard');
      if (epoch !== pool.epoch) return false;
      applyDashboard(data);
      if (!pool.conflict) message();
      return true;
    } catch (error) { report(error); return false; }
    finally { pool.loading = false; controls(); }
  };
  window.refreshPoolDashboard = async function () {
    if ((pool.settingsDirty || pool.orderDirty) && !confirm('刷新将丢弃未保存的设置或排序草稿，继续吗？')) return;
    if (pool.busy || pool.loading) return;
    pool.loading = true; controls();
    try {
      const data = await request('/account-pool/dashboard');
      applyDashboard(data, true);
      pool.pages.tasks = pool.pages.events = 0;
      for (const kind of ['tasks', 'events']) { pool.totals[kind] = null; renderRecords(kind, data[kind]); }
      message(); showToast('已加载服务端最新快照');
    } catch (error) { report(error); }
    finally { pool.loading = false; controls(); }
  };
  async function mutate(work) {
    if (pool.busy) return;
    pool.busy = true; pool.epoch++; controls();
    try { await work(); } catch (error) { report(error); }
    finally { pool.busy = false; controls(); }
  }
  async function reloadAfterMutation(success) {
    try { applyDashboard(await request('/account-pool/dashboard')); message(success); showToast(success); }
    catch (error) { message(`${success}，但面板刷新失败：${error.message}。请刷新核对。`, true); }
  }
  $('pool-settings').addEventListener('input', () => {
    if (pool.orderDirty) { message('请先保存排序或刷新丢弃排序草稿，再修改设置。', true); fillSettings(pool.snapshot.settings); return; }
    pool.settingsDirty = true; fixedHint(); renderAccounts();
  });
  $('pool-settings').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!pool.snapshot || pool.conflict || pool.orderDirty || !pool.settingsDirty) return;
    const mode = $('pool-mode').value, fixedAccountId = mode === 'fixed' ? $('pool-fixed').value : null;
    const thresholdText = $('pool-threshold').value, ageText = $('pool-balance-age').value;
    const threshold = Number(thresholdText), balanceMaxAgeSeconds = Number(ageText);
    if (!thresholdText || !Number.isFinite(threshold) || threshold < 0 || !ageText || !Number.isInteger(balanceMaxAgeSeconds) || balanceMaxAgeSeconds <= 0 || (mode === 'fixed' && !fixedAccountId)) return message('请填写有效阈值、正整数有效期，并在固定模式选择账号。', true);
    mutate(async () => {
      const settings = await request('/account-pool/settings', 'PATCH', { mode, fixedAccountId, threshold, balanceMaxAgeSeconds, revision: pool.revision });
      if (!validSettings(settings)) throw new Error('保存响应不完整，无法确认设置已生效，请刷新核对。');
      pool.settingsDirty = false; pool.revision = settings.revision; pool.snapshot.settings = settings; fillSettings(settings);
      await reloadAfterMutation('调度设置已保存');
    });
  });
  function move(id, targetIndex, focusAction = 'drag') {
    if (pool.busy || pool.conflict || pool.settingsDirty) return;
    const index = pool.order.indexOf(id);
    if (index < 0 || targetIndex < 0 || targetIndex >= pool.order.length || index === targetIndex) return;
    pool.order.splice(index, 1); pool.order.splice(targetIndex, 0, id); pool.orderDirty = true; renderAccounts();
    restoreRowFocus(id, focusAction);
  }
  $('pool-save-order').addEventListener('click', () => {
    if (!pool.orderDirty || pool.settingsDirty || pool.conflict) return;
    mutate(async () => {
      const dashboard = await request('/account-pool/order', 'PATCH', { accountIds: pool.order, revision: pool.revision });
      if (!validDashboard(dashboard)) throw new Error('保存响应不完整，无法确认排序已生效，请刷新核对。');
      applyDashboard(dashboard, true); message('排序已保存；仅影响新任务。'); showToast('排序已保存');
    });
  });
  $('accounts-table').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]'), row = button?.closest('tr[data-account-id]');
    if (!row || button.disabled) return;
    const id = row.dataset.accountId, action = button.dataset.action;
    if (action === 'up' || action === 'down') return move(id, pool.order.indexOf(id) + (action === 'up' ? -1 : 1), action);
    if (action === 'toggle') window.setAccountStatus(id, !pool.snapshot.accounts.find((a) => a.id === id).enabled);
    if (action === 'refresh') window.refreshAccount(id);
    if (action === 'delete') window.deleteAccount(id);
  });
  $('accounts-table').addEventListener('dragstart', (event) => {
    const handle = event.target.closest('[data-action="drag"]');
    if (!handle || pool.busy || pool.conflict || pool.settingsDirty) return event.preventDefault();
    pool.dragId = handle.closest('tr').dataset.accountId;
    event.dataTransfer.setData('text/plain', pool.dragId); event.dataTransfer.effectAllowed = 'move';
  });
  $('accounts-table').addEventListener('dragover', (event) => {
    if (!pool.dragId) return;
    const row = event.target.closest('tr[data-account-id]');
    if (!row) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.pool-drop-target').forEach((r) => r.classList.remove('pool-drop-target'));
    row.classList.add('pool-drop-target');
  });
  function endDrag() { pool.dragId = null; document.querySelectorAll('.pool-drop-target').forEach((r) => r.classList.remove('pool-drop-target')); }
  $('accounts-table').addEventListener('drop', (event) => {
    event.preventDefault();
    const target = event.target.closest('tr[data-account-id]');
    if (pool.dragId && target) move(pool.dragId, pool.order.indexOf(target.dataset.accountId));
    endDrag();
  });
  $('accounts-table').addEventListener('dragend', endDrag);
  window.createAccount = async function () {
    const name = $('account-name').value.trim(), cookie = $('account-cookie').value.trim();
    if (!name || !cookie) return showToast('请填写账号备注和 Cookie');
    if (pool.settingsDirty || pool.orderDirty) return message('请先保存当前草稿或刷新丢弃，再添加账号。', true);
    await mutate(async () => {
      const account = await request('/account-pool/', 'POST', { name, cookie });
      if (typeof account?.id !== 'string') throw new Error('添加响应不完整，无法确认账号已保存，请刷新核对。');
      $('account-name').value = ''; $('account-cookie').value = '';
      await reloadAfterMutation('账号已加入账号池');
    });
  };
  window.setAccountStatus = (id, enabled) => mutate(async () => {
    const account = await request(`/account-pool/${encodeURIComponent(id)}/enabled`, 'PATCH', { enabled });
    if (account?.id !== id || account.enabled !== enabled) throw new Error('启停响应不完整，无法确认状态已保存，请刷新核对。');
    await reloadAfterMutation(enabled ? '账号已启用' : '账号已停用，已绑定任务保持原账号');
  });
  window.refreshAccount = (id) => mutate(async () => {
    const account = await request(`/account-pool/${encodeURIComponent(id)}/refresh-status`, 'POST');
    if (account?.status?.error) throw new Error(`余额 / 状态刷新失败：${account.status.error}`);
    if (account?.id !== id || !Number.isFinite(Date.parse(account?.status?.checkedAt))) throw new Error('刷新响应不完整，无法确认余额 / 状态，请刷新核对。');
    await reloadAfterMutation('账号余额 / 状态已刷新');
  });
  window.deleteAccount = async function (id) {
    if (pool.settingsDirty || pool.orderDirty) return message('请先保存当前草稿或刷新丢弃，再删除账号。', true);
    if (!confirm(`确定删除账号“${accountName(id)}”吗？有进行中、待确认或结算任务时服务端将拒绝删除。`)) return;
    await mutate(async () => {
      const result = await request(`/account-pool/${encodeURIComponent(id)}`, 'DELETE');
      if (result?.success !== true) throw new Error('删除响应不完整，无法确认账号已删除，请刷新核对。');
      await reloadAfterMutation('账号已删除');
    });
  };
  async function loadRecords(kind, offset) {
    const prev = $(`pool-${kind}-prev`), next = $(`pool-${kind}-next`);
    prev.disabled = next.disabled = true;
    try {
      const data = await request(`/account-pool/${kind}?limit=50&offset=${offset}`);
      if (!Array.isArray(data?.items) || !Number.isInteger(data.total)) throw new Error('记录响应格式不完整');
      pool.pages[kind] = offset; pool.totals[kind] = data.total; renderRecords(kind, data.items);
    } catch (error) { report(error); prev.disabled = pool.pages[kind] === 0; next.disabled = false; }
  }
  for (const kind of ['tasks', 'events']) {
    $(`pool-${kind}-prev`).addEventListener('click', () => loadRecords(kind, Math.max(0, pool.pages[kind] - 50)));
    $(`pool-${kind}-next`).addEventListener('click', () => loadRecords(kind, pool.pages[kind] + 50));
  }
})();
