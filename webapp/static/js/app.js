(function () {
  const orig = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const res = await orig(input, init);
    if (res.status === 401) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (!String(url).includes('/login')) location.href = '/login';
    }
    return res;
  };
})();
(function preventPageZoom() {
  const stop = function (e) { e.preventDefault(); };
  document.addEventListener('gesturestart', stop, { passive: false });
  document.addEventListener('gesturechange', stop, { passive: false });
  document.addEventListener('gestureend', stop, { passive: false });
  document.addEventListener('touchmove', function (e) {
    if (!(e.touches && e.touches.length > 1)) return;
    const t = e.target;
    if (t && t.closest && t.closest('#ohlcChart.y-scale, #rpnlChart.y-scale')) return;
    e.preventDefault();
  }, { passive: false });
})();

// Mobile nested panes: page (parent) owns vertical scroll first. The table
// only keeps Y when the page cannot move that way and the rows actually overflow.
(function nestedPaneScroll() {
  const SELECTOR = '.tbl-grid-wrap, .rp-logs-box, .dbt-peek, .fill-scroll';
  const attached = new WeakSet();
  let lastY = 0, lastX = 0, active = null, axis = null;

  function isPhoneScroll() {
    return window.matchMedia('(max-width: 720px), (hover: none) and (pointer: coarse)').matches;
  }
  function parentScroller(el) {
    let n = el && el.parentElement;
    while (n && n !== document.body && n !== document.documentElement) {
      const st = getComputedStyle(n);
      const oy = st.overflowY;
      if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 1) return n;
      n = n.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }
  function sync(el) {
    if (!el || el.nodeType !== 1) return;
    el.classList.add('js-pane-scroll');
    if (!isPhoneScroll()) {
      el.classList.remove('pane-can-y');
      el.style.touchAction = '';
      return;
    }
    const canY = el.scrollHeight > el.clientHeight + 2;
    el.classList.toggle('pane-can-y', canY);
    el.style.touchAction = canY ? 'pan-x pan-y' : 'pan-x';
  }
  function attach(el) {
    if (!el || el.nodeType !== 1 || attached.has(el)) return;
    attached.add(el);
    const kick = function () { sync(el); };
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(kick);
      ro.observe(el);
    }
    const mo = new MutationObserver(kick);
    mo.observe(el, { childList: true, subtree: true });
    kick();
  }
  function scan(root) {
    const scope = root && root.nodeType === 1 ? root : document;
    if (scope.matches && scope.matches(SELECTOR)) attach(scope);
    if (scope.querySelectorAll) scope.querySelectorAll(SELECTOR).forEach(attach);
  }
  window.syncPaneScrollers = function () {
    scan(document);
  };

  document.addEventListener('touchstart', function (e) {
    if (!isPhoneScroll() || e.touches.length !== 1) { active = null; return; }
    const el = e.target.closest && e.target.closest(SELECTOR);
    active = el || null;
    axis = null;
    lastY = e.touches[0].clientY;
    lastX = e.touches[0].clientX;
    if (el) sync(el);
  }, { passive: true, capture: true });

  document.addEventListener('touchmove', function (e) {
    if (!active || !isPhoneScroll() || e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    const x = e.touches[0].clientX;
    const dy = y - lastY;
    const dx = x - lastX;
    if (!axis) {
      if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
      axis = Math.abs(dx) > Math.abs(dy) * 1.1 ? 'x' : 'y';
    }
    lastY = y;
    lastX = x;
    if (axis !== 'y') return;
    const el = active;
    const parent = parentScroller(el);
    if (!parent || parent === el) return;
    const pTop = parent.scrollTop;
    const pMax = Math.max(0, parent.scrollHeight - parent.clientHeight);
    if ((dy > 0 && pTop > 0) || (dy < 0 && pTop < pMax - 0.5)) {
      parent.scrollTop = pTop - dy;
      if (e.cancelable) e.preventDefault();
      return;
    }
    if (el.classList.contains('pane-can-y')) return;
    if (e.cancelable) e.preventDefault();
  }, { passive: false, capture: true });

  function endTouch() { active = null; axis = null; }
  document.addEventListener('touchend', endTouch, { passive: true, capture: true });
  document.addEventListener('touchcancel', endTouch, { passive: true, capture: true });

  window.addEventListener('resize', function () {
    document.querySelectorAll(SELECTOR).forEach(sync);
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', function () {
      document.querySelectorAll(SELECTOR).forEach(sync);
    });
  }
  const boot = function () {
    scan(document);
    if (document.body) {
      new MutationObserver(function (muts) {
        muts.forEach(function (m) {
          m.addedNodes.forEach(function (n) {
            if (n.nodeType === 1) scan(n);
          });
        });
      }).observe(document.body, { childList: true, subtree: true });
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

// Page nav
function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
}

function logLevelCls(level) {
  const u = String(level || '').trim().toUpperCase();
  if (u === 'DEBUG' || u === 'INFO' || u === 'WARNING' || u === 'ERROR' || u === 'CRITICAL') return 'lv-' + u;
  if (u === 'WARN') return 'lv-WARNING';
  return '';
}

function fmtLogName(name) {
  return String(name || '').replace(/^(uvicorn|gunicorn)\.(error|access)$/i, '$1');
}

const PAGE_IDS = ['home', 'balances', 'reports', 'rpnl', 'opps', 'data'];
const NAV_IDS  = { home: 'navHome', balances: 'navBalances', reports: 'navReports', rpnl: 'navRpnl', opps: 'navOpps', data: 'navData' };
let rpnlReady = false, reportsReady = false, balancesReady = false, dataReady = false;
let pendingRpnlKey = null, pendingReportAcct = null, pendingReportWiden = false;
let rpnlForceKeepSel = false;

const LS_STRATEGY = 'opadash.strategy';
const LS_PAGE = 'opadash.page';
const LS_RPNL_HOURS = 'opadash.rpnlHours';
const LS_RPNL_CANDLE = 'opadash.rpnlCandle';
const LS_RPNL_BUCKET = 'opadash.rpnlBucket';
const LS_RPNL_AUTO = 'opadash.rpnlAuto';
function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null || v === '' ? fallback : v; } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}
function restoreSel(id, key, fallback) {
  const el = document.getElementById(id);
  if (!el) return;
  const v = lsGet(key, fallback);
  if (v != null && [...el.options].some(o => o.value === v)) el.value = v;
}
function restoreRpnlPrefs() {
  restoreSel('rpnlHours', LS_RPNL_HOURS, '24');
  restoreSel('rpnlCandle', LS_RPNL_CANDLE, '5m');
  restoreSel('rpnlBucket', LS_RPNL_BUCKET, '5');
  const box = document.getElementById('rpnlAuto');
  if (box) box.checked = lsGet(LS_RPNL_AUTO, '1') === '1';
}
function saveRpnlPrefs() {
  const hours = document.getElementById('rpnlHours');
  const candle = document.getElementById('rpnlCandle');
  const bucket = document.getElementById('rpnlBucket');
  const auto = document.getElementById('rpnlAuto');
  if (hours && hours.value) lsSet(LS_RPNL_HOURS, hours.value);
  if (candle && candle.value) lsSet(LS_RPNL_CANDLE, candle.value);
  if (bucket && bucket.value) lsSet(LS_RPNL_BUCKET, bucket.value);
  if (auto) lsSet(LS_RPNL_AUTO, auto.checked ? '1' : '0');
}

function showPage(name) {
  if (!PAGE_IDS.includes(name)) name = 'home';
  PAGE_IDS.forEach(p => {
    document.getElementById(p).classList.toggle('visible', p === name);
    document.getElementById(NAV_IDS[p]).classList.toggle('active', p === name);
  });
  lsSet(LS_PAGE, name);
  if (name !== 'rpnl' && typeof closeRpOps === 'function') closeRpOps();
  if (name !== 'rpnl' && typeof closeRpnlKind === 'function') closeRpnlKind();
  if (name === 'rpnl'      && !rpnlReady) { initRpnl();      rpnlReady = true; }
  if (name === 'balances') {
    if (!balancesReady) { initBalances(); balancesReady = true; }
    else {
      loadBalances();
      if (typeof setupBalAuto === 'function') setupBalAuto();
    }
    requestAnimationFrame(() => {
      if (typeof resizeBalCharts === 'function') {
        resizeBalCharts();
        requestAnimationFrame(resizeBalCharts);
      }
    });
  } else if (typeof stopBalAuto === 'function') {
    stopBalAuto();
  }
  if (name === 'reports') {
    if (!reportsReady) { initReports(); reportsReady = true; }
    else { loadReports(); requestAnimationFrame(resizeReportChart); }
  }
  if (name === 'rpnl' && pendingRpnlKey) {
    const k = pendingRpnlKey;
    pendingRpnlKey = null;
    const sel = document.getElementById('rpnlSymbol');
    if (sel) { ensureRpnlOption(k, k.replace('::', ' · ')); sel.value = k; }
    if (rpnlReady) pickRpnlContract(k);
  }
  if (name === 'data') {
    if (!dataReady) { initData(); dataReady = true; }
    else showDataTab(dataTab);
  } else if (typeof stopDataTimers === 'function') {
    stopDataTimers();
  }
  if (name === 'opps') {
    if (!oppReady) { initOpps(); oppReady = true; }
    else loadOpps(false);
    if (typeof setupOppAuto === 'function') setupOppAuto();
  } else if (typeof stopOppAuto === 'function') {
    stopOppAuto();
  }
  // Charts need a resize when their container becomes visible
  if (name === 'rpnl') {
    if (rpnlChart) {
      requestAnimationFrame(() => {
        resizeRpnlCharts();
        requestAnimationFrame(resizeRpnlCharts);
      });
    }
    startRpnlLive();
  } else {
    stopRpnlLive();
    const rp = document.getElementById('rpnl');
    if (rp && rp.classList.contains('more-open') && typeof toggleRpnlMore === 'function') toggleRpnlMore();
    if (typeof closeOhlcTools === 'function') closeOhlcTools();
    if (typeof clearRpnlYScaleMode === 'function') clearRpnlYScaleMode();
    const foot = document.getElementById('rpnlTools');
    if (foot && foot.classList.contains('export-open') && typeof toggleRpnlExports === 'function') toggleRpnlExports();
  }
  if (typeof syncPaneScrollers === 'function') {
    requestAnimationFrame(syncPaneScrollers);
  }
}

function goToReportAccount(accountId) {
  const id = String(accountId || '').trim();
  if (!id) return;
  pendingReportAcct = id;
  pendingReportWiden = false;
  showPage('reports');
}
function goToRpnlChart(contract, account, strategy) {
  if (!contract) return;
  strategy = strategy || '';
  if (!strategy && typeof rpnlSummaryCache !== 'undefined') {
    const hit = (rpnlSummaryCache || []).find(r =>
      (r.contract || '') === contract && (r.account || '') === (account || '')
    );
    if (hit && hit.strategy) strategy = hit.strategy;
  }
  const key = contract + '::' + (account || '') + '::' + strategy;
  const wasReady = rpnlReady;
  ensureRpnlOption(key, contract + (account ? ' · ' + account : '') + (strategy ? ' · ' + strategy : ''));
  const sel = document.getElementById('rpnlSymbol');
  if (sel) sel.value = key;
  pendingRpnlKey = wasReady ? key : null;
  rpnlForceKeepSel = true;
  showPage('rpnl');
}
function focusReportAccount(accountId) {
  const id = String(accountId || '').trim();
  if (!id) return false;
  const key = encodeURIComponent(id);
  let el = document.getElementById('acct-' + key);
  if (!el) {
    el = [...document.querySelectorAll('.rpt-acct')].find(e =>
      (e.getAttribute('data-filter') || '').indexOf(id) >= 0
    );
  }
  if (!el) return false;
  document.querySelectorAll('.rpt-acct').forEach(e => e.classList.remove('flash'));
  const openKey = (el.id || '').replace(/^acct-/, '');
  rptOpenAccts.add(openKey);
  el.classList.add('open', 'flash');
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return true;
}

// Toast helper
let _toastTimer;
function toast(msg, cls) {
  let el = document.getElementById('_toast');
  if (!el) {
    el = document.createElement('div');
    el.id = '_toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = 'toast show ' + (cls || '');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.className = 'toast ' + (cls || ''); }, 2600);
}

const IST_OFFSET = 19800; // +5:30 in seconds
function fmtIST(unixSecs) {
  return new Date(unixSecs * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}
function fmtAgo(secs) {
  if (secs == null) return 'never';
  secs = Math.floor(secs);
  if (secs < 60)   return secs + 's ago';
  if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
  if (secs < 86400) return Math.floor(secs / 3600) + 'h ' + Math.floor((secs % 3600) / 60) + 'm ago';
  return Math.floor(secs / 86400) + 'd ago';
}

// Status helpers
function setStatus(id, html, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  try {
    el.className = 'status-bar' + (cls ? ' ' + cls : '');
    el.innerHTML = html;
  } catch (e) {}
}
function setLoading(id, text) {
  setStatus(id, '<span class="spinner"></span><span>' + text + '</span>');
}

// Strategy filter — lives inside the rPnL + Reports "Filters" popovers.
let currentStrategy = lsGet(LS_STRATEGY, 'all');
function strategyIsAll(s) {
  return !s || ['all', '*', 'any'].includes(String(s).toLowerCase().trim());
}
// Append the active strategy to any strategy-tagged /api/* URL.
function withStrategy(url) {
  const tag = strategyIsAll(currentStrategy) ? 'all' : currentStrategy;
  return url + (url.includes('?') ? '&' : '?') + 'strategy=' + encodeURIComponent(tag);
}
const STRATEGY_SELECTS = ['fmStrategy'];
async function fetchStrategies() {
  try {
    const list = await (await fetch('/api/strategies')).json();
    const tags = (Array.isArray(list) ? list : []).filter(Boolean);
    const opts = '<option value="all">All strategies</option>' +
      tags.map(s => '<option value="' + escHtml(s) + '">' + escHtml(s) + '</option>').join('');
    const saved = lsGet(LS_STRATEGY, currentStrategy);
    currentStrategy = (tags.includes(saved) || saved === 'all') ? saved : 'all';
    lsSet(LS_STRATEGY, currentStrategy);
    STRATEGY_SELECTS.forEach(id => {
      const s = document.getElementById(id);
      if (!s) return;
      s.innerHTML = opts;
      s.value = currentStrategy;
    });
  } catch { /* keep default all */ }
}
// Shared strategy pick — server-side filter, so reload the active page.
async function setStrategy(val) {
  currentStrategy = val || 'all';
  lsSet(LS_STRATEGY, currentStrategy);
  STRATEGY_SELECTS.forEach(id => {
    const s = document.getElementById(id);
    if (s && [...s.options].some(o => o.value === currentStrategy)) s.value = currentStrategy;
  });
  if (typeof rpnlForceKeepSel !== 'undefined') rpnlForceKeepSel = false;
  const cur = document.querySelector('.page.visible');
  const name = cur ? cur.id : '';
  if (name === 'rpnl') {
    if (typeof fetchRpnlSymbols === 'function') await fetchRpnlSymbols();
    if (rpnlReady && typeof loadRpnlFresh === 'function') loadRpnlFresh();
  } else if (name === 'reports') {
    if (reportsReady) loadReports();
  }
}

// ---- Scope filter: exchange → accounts tree, multi-select (rPnL + Reports) ----
const SCOPE_SEP = '\u241f';
function scopeKey(ex, acct) { return String(ex || '').toLowerCase() + SCOPE_SEP + String(acct || ''); }
function loadScopeSet(key) {
  try { return new Set(JSON.parse(lsGet('opadash.scope.' + key, '[]')) || []); } catch { return new Set(); }
}
function saveScopeSet(key, set) { lsSet('opadash.scope.' + key, JSON.stringify([...set])); }

// pairs: [{ex, label, account, accName}] → grouped + sorted exchange nodes.
function scopeGroupsFrom(pairs) {
  const byEx = new Map();
  (pairs || []).forEach(p => {
    const ex = String(p.ex || '').toLowerCase();
    const acct = String(p.account || '');
    if (!ex || !acct) return;
    if (!byEx.has(ex)) byEx.set(ex, { ex, label: p.label || ex, accounts: new Map() });
    const g = byEx.get(ex);
    if (p.label) g.label = p.label;
    if (!g.accounts.has(acct)) g.accounts.set(acct, p.accName || acct);
  });
  return [...byEx.values()]
    .sort((a, b) => String(a.label).localeCompare(String(b.label)))
    .map(g => ({
      ex: g.ex, label: g.label,
      accounts: [...g.accounts].map(([id, name]) => ({ id, name }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    }));
}

function scopeRender(treeEl, state) {
  if (!treeEl) return;
  const groups = (state && state.groups) || [];
  if (!groups.length) {
    treeEl.innerHTML = '<div class="scope-empty">No accounts in view</div>';
    return;
  }
  treeEl.innerHTML = groups.map(g => {
    const total = g.accounts.length;
    const sel = g.accounts.filter(a => state.selected.has(scopeKey(g.ex, a.id))).length;
    const allOn = total > 0 && sel === total;
    const open = state.expanded.has(g.ex);
    return '<div class="scope-group' + (open ? ' open' : '') + '">' +
      '<div class="scope-head">' +
        '<button type="button" class="scope-tw" data-tw="' + escHtml(g.ex) + '" aria-label="toggle">' +
          (open ? '▾' : '▸') + '</button>' +
        '<label class="scope-chk">' +
          '<input type="checkbox" data-ex-all="' + escHtml(g.ex) + '"' +
            (allOn ? ' checked' : '') + (sel > 0 && !allOn ? ' data-indet="1"' : '') + '>' +
          '<span class="rpnl-venue ' + rpnlVenueClass(g.ex) + '">' + escHtml(g.label) + '</span>' +
        '</label>' +
        '<span class="scope-count">' + (sel ? sel + '/' : '') + total + '</span>' +
      '</div>' +
      '<div class="scope-accts"' + (open ? '' : ' hidden') + '>' +
        g.accounts.map(a =>
          '<label class="scope-acct">' +
            '<input type="checkbox" data-ex="' + escHtml(g.ex) + '" data-acct="' + escHtml(a.id) + '"' +
              (state.selected.has(scopeKey(g.ex, a.id)) ? ' checked' : '') + '>' +
            '<span>' + escHtml(a.name) + '</span>' +
          '</label>').join('') +
      '</div>' +
    '</div>';
  }).join('');
  treeEl.querySelectorAll('input[data-indet]').forEach(i => { i.indeterminate = true; });
}

// getState returns the live scope object, so one bound tree can serve any page.
function scopeBind(treeEl, getState, onSelect) {
  if (!treeEl || treeEl.dataset.bound) return;
  treeEl.dataset.bound = '1';
  treeEl.addEventListener('click', ev => {
    const tw = ev.target.closest('[data-tw]');
    if (!tw) return;
    const state = getState();
    if (!state) return;
    const ex = tw.getAttribute('data-tw');
    if (state.expanded.has(ex)) state.expanded.delete(ex); else state.expanded.add(ex);
    scopeRender(treeEl, state);
  });
  treeEl.addEventListener('change', ev => {
    const state = getState();
    if (!state) return;
    const t = ev.target;
    if (t.matches('[data-ex-all]')) {
      const ex = t.getAttribute('data-ex-all');
      const g = (state.groups || []).find(x => x.ex === ex);
      if (g) g.accounts.forEach(a => {
        const k = scopeKey(ex, a.id);
        if (t.checked) state.selected.add(k); else state.selected.delete(k);
      });
    } else if (t.matches('[data-acct]')) {
      const k = scopeKey(t.getAttribute('data-ex'), t.getAttribute('data-acct'));
      if (t.checked) state.selected.add(k); else state.selected.delete(k);
    } else { return; }
    scopeRender(treeEl, state);
    if (typeof onSelect === 'function') onSelect();
  });
}

function scopeMatch(state, exchanges, account) {
  if (!state || !state.selected || !state.selected.size) return true;
  const acct = String(account || '');
  return (exchanges || []).some(ex => state.selected.has(scopeKey(ex, acct)));
}

function setFilterBadge(btnId, count) {
  const b = document.getElementById(btnId);
  if (!b) return;
  b.classList.toggle('on', count > 0);
  b.textContent = count > 0 ? 'Filters · ' + count : 'Filters';
}

// ---- Shared Filters modal ----
let activeFilterCtx = null;
function filterModalCount() {
  const el = document.getElementById('fmCount');
  if (!el || !activeFilterCtx) return;
  const n = activeFilterCtx.scope.selected.size;
  el.textContent = n ? n + ' account' + (n === 1 ? '' : 's') + ' selected' : 'All accounts';
}
function openFilterModal(ctx) {
  activeFilterCtx = ctx;
  const modal = document.getElementById('filterModal');
  if (!modal) return;
  const title = document.getElementById('filterModalTitle');
  if (title) title.textContent = ctx.title || 'Filters';
  const ss = document.getElementById('fmStrategy');
  if (ss && [...ss.options].some(o => o.value === currentStrategy)) ss.value = currentStrategy;
  if (typeof ctx.refresh === 'function') ctx.refresh();
  scopeRender(document.getElementById('fmScopeTree'), ctx.scope);
  filterModalCount();
  modal.hidden = false;
  document.body.classList.add('modal-open');
}
function closeFilterModal() {
  const modal = document.getElementById('filterModal');
  if (modal) modal.hidden = true;
  document.body.classList.remove('modal-open');
}
function filterModalClear() {
  if (!activeFilterCtx) return;
  activeFilterCtx.scope.selected.clear();
  scopeRender(document.getElementById('fmScopeTree'), activeFilterCtx.scope);
  filterModalCount();
  if (typeof activeFilterCtx.apply === 'function') activeFilterCtx.apply();
}
function initFilterModal() {
  const tree = document.getElementById('fmScopeTree');
  if (!tree) return;
  scopeBind(tree, () => activeFilterCtx && activeFilterCtx.scope, () => {
    filterModalCount();
    if (activeFilterCtx && typeof activeFilterCtx.apply === 'function') activeFilterCtx.apply();
  });
}

// Escape closes the Filters modal.
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeFilterModal();
});


// DB health badge
async function checkHealth() {
  const badge = document.getElementById('dbBadge');
  const statusEl = document.getElementById('dbInfoStatus');
  const fillsRow = document.getElementById('dbInfoFills');
  const errRow   = document.getElementById('dbInfoErr');
  try {
    const r = await fetch('/api/health');
    const h = await r.json();
    if (h.db === 'ok') {
      badge.className = 'db-badge ok';
      badge.textContent = 'DB connected';
      statusEl.textContent = 'Connected';
      statusEl.style.color = 'var(--green)';
      if (h.fills_count !== undefined) {
        fillsRow.style.display = '';
        document.getElementById('dbInfoFillsVal').textContent = h.fills_count.toLocaleString();
      }
      errRow.style.display = 'none';
    } else {
      badge.className = 'db-badge warn';
      badge.textContent = 'DB error';
      statusEl.textContent = h.db;
      statusEl.style.color = 'var(--red)';
      errRow.style.display = '';
      document.getElementById('dbInfoErrMsg').textContent = h.detail || 'unknown';
    }
  } catch(e) {
    badge.className = 'db-badge warn';
    badge.textContent = 'DB error';
    statusEl.textContent = 'health check failed';
    statusEl.style.color = 'var(--red)';
  }
}
