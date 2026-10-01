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
const LS_ACCOUNT = 'opadash.account';
const LS_EXCHANGE = 'opadash.exchange';
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

// Dashboard filters — restored from localStorage so the last picks come back.
let currentStrategy = lsGet(LS_STRATEGY, 'all');
let currentAccount = lsGet(LS_ACCOUNT, 'all');
let currentExchange = lsGet(LS_EXCHANGE, 'all');
function strategyIsAll(s) {
  return !s || ['all', '*', 'any'].includes(String(s).toLowerCase().trim());
}
function accountIsAll(s) {
  return strategyIsAll(s);
}
function exchangeIsAll(s) {
  return strategyIsAll(s);
}
// Append the active dashboard filters to API URLs. APIs that do not use a
// filter safely ignore it; rPnL also filters its client-side summary rows.
function withStrategy(url) {
  const params = new URLSearchParams({
    strategy: strategyIsAll(currentStrategy) ? 'all' : currentStrategy,
  });
  if (!accountIsAll(currentAccount)) params.set('account', currentAccount);
  if (!exchangeIsAll(currentExchange)) params.set('exchange', currentExchange);
  return url + (url.includes('?') ? '&' : '?') + params.toString();
}
async function fetchStrategies() {
  try {
    const r = await fetch('/api/strategies');
    const list = await r.json();
    const sel = document.getElementById('strategy-select');
    if (!sel) return;
    const tags = (Array.isArray(list) ? list : []).filter(Boolean);
    sel.innerHTML = '<option value="all">All</option>' +
      tags.map(s => '<option value="' + escHtml(s) + '">' + escHtml(s) + '</option>').join('');
    const saved = lsGet(LS_STRATEGY, currentStrategy);
    if ([...sel.options].some(o => o.value === saved)) currentStrategy = saved;
    else currentStrategy = 'all';
    sel.value = currentStrategy;
    lsSet(LS_STRATEGY, currentStrategy);
  } catch { /* keep default all */ }
}
function filterOptionRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter(row => {
    const account = String(row.account || '');
    const venues = [row.quote_venue, row.hedge_venue, row.exchange]
      .map(v => String(v || '').toLowerCase());
    return (accountIsAll(currentAccount) || account === currentAccount) &&
      (exchangeIsAll(currentExchange) || venues.includes(currentExchange));
  });
}
async function fetchFilterOptions() {
  try {
    const response = await fetch('/api/rpnl/symbols?strategy=all');
    const rows = await response.json();
    const accounts = new Map();
    const exchanges = new Set();
    (Array.isArray(rows) ? rows : []).forEach(row => {
      const account = String(row.account || '');
      if (account) accounts.set(account, String(row.account_name || account));
      [row.quote_venue, row.hedge_venue, row.exchange].forEach(venue => {
        venue = String(venue || '').toLowerCase();
        if (venue) exchanges.add(venue);
      });
    });
    const accountSelect = document.getElementById('account-select');
    const exchangeSelect = document.getElementById('exchange-select');
    if (accountSelect) {
      accountSelect.innerHTML = '<option value="all">All</option>' +
        [...accounts].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) =>
          '<option value="' + escHtml(value) + '">' + escHtml(label) + '</option>').join('');
      currentAccount = [...accountSelect.options].some(o => o.value === currentAccount) ? currentAccount : 'all';
      accountSelect.value = currentAccount;
      lsSet(LS_ACCOUNT, currentAccount);
    }
    if (exchangeSelect) {
      exchangeSelect.innerHTML = '<option value="all">All</option>' +
        [...exchanges].sort().map(value => '<option value="' + escHtml(value) + '">' + escHtml(value) + '</option>').join('');
      currentExchange = [...exchangeSelect.options].some(o => o.value === currentExchange) ? currentExchange : 'all';
      exchangeSelect.value = currentExchange;
      lsSet(LS_EXCHANGE, currentExchange);
    }
  } catch { /* keep default all */ }
}
function toggleNavFilters() {
  const menu = document.getElementById('navFiltersMenu');
  const button = document.getElementById('navFiltersBtn');
  if (!menu) return;
  const open = menu.hidden;
  menu.hidden = !open;
  if (button) button.setAttribute('aria-expanded', open ? 'true' : 'false');
}
function closeNavFilters(event) {
  const wrap = document.getElementById('navFilters');
  const menu = document.getElementById('navFiltersMenu');
  const button = document.getElementById('navFiltersBtn');
  if (!menu || menu.hidden || (event && wrap && wrap.contains(event.target))) return;
  menu.hidden = true;
  if (button) button.setAttribute('aria-expanded', 'false');
}
async function refreshDashboardFilters() {
  if (typeof rpnlForceKeepSel !== 'undefined') rpnlForceKeepSel = false;
  const currentPage = document.querySelector('.page.visible');
  const pageName = currentPage ? currentPage.id : 'home';
  if (typeof fetchRpnlSymbols === 'function') await fetchRpnlSymbols();
  if (rpnlReady && typeof loadRpnlFresh === 'function') loadRpnlFresh();
  if (pageName === 'data' && dataReady) initData();
  if (balancesReady) loadBalances();
  if (reportsReady) loadReports();
  checkHealth();
}
async function onStrategyChange(val) {
  currentStrategy = val || 'all';
  lsSet(LS_STRATEGY, currentStrategy);
  await refreshDashboardFilters();
}
async function onAccountChange(val) {
  currentAccount = val || 'all';
  lsSet(LS_ACCOUNT, currentAccount);
  await refreshDashboardFilters();
}
async function onExchangeChange(val) {
  currentExchange = val || 'all';
  lsSet(LS_EXCHANGE, currentExchange);
  await refreshDashboardFilters();
}
document.addEventListener('click', closeNavFilters);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeNavFilters();
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
