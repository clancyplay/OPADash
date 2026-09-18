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
    if (e.touches && e.touches.length > 1) e.preventDefault();
  }, { passive: false });
})();

// Page nav
function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
}

const PAGE_IDS = ['home', 'balances', 'reports', 'rpnl', 'data'];
const NAV_IDS  = { home: 'navHome', balances: 'navBalances', reports: 'navReports', rpnl: 'navRpnl', data: 'navData' };
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
  if (name === 'rpnl'      && !rpnlReady) { initRpnl();      rpnlReady = true; }
  if (name === 'balances') {
    if (!balancesReady) { initBalances(); balancesReady = true; }
    else loadBalances();
    requestAnimationFrame(() => {
      if (typeof resizeBalCharts === 'function') {
        resizeBalCharts();
        requestAnimationFrame(resizeBalCharts);
      }
    });
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
  } else if (dataReady) { clearInterval(fxTimer); clearInterval(evTimer); clearInterval(pxTimer); clearInterval(lgTimer); }
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
    const foot = document.getElementById('rpnlTools');
    if (foot && foot.classList.contains('export-open') && typeof toggleRpnlExports === 'function') toggleRpnlExports();
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
  el.className = 'status-bar' + (cls ? ' ' + cls : '');
  el.innerHTML = html;
}
function setLoading(id, text) {
  setStatus(id, '<span class="spinner"></span><span>' + text + '</span>');
}

// Strategy filter — restored from localStorage so the last pick comes back.
let currentStrategy = lsGet(LS_STRATEGY, 'opa3');
// Append the active strategy to any strategy-tagged /api/* URL.
function withStrategy(url) {
  return url + (url.includes('?') ? '&' : '?') + 'strategy=' + encodeURIComponent(currentStrategy);
}
function withAllStrategies(url) {
  return url + (url.includes('?') ? '&' : '?') + 'strategy=all';
}
async function fetchStrategies() {
  try {
    const r = await fetch('/api/strategies');
    const list = await r.json();
    const sel = document.getElementById('strategy-select');
    if (sel && Array.isArray(list) && list.length) {
      sel.innerHTML = list.map(s => '<option value="' + s + '">' + s + '</option>').join('');
      const saved = lsGet(LS_STRATEGY, currentStrategy);
      if ([...sel.options].some(o => o.value === saved)) currentStrategy = saved;
      else if (![...sel.options].some(o => o.value === currentStrategy)) currentStrategy = list[0];
      sel.value = currentStrategy;
      lsSet(LS_STRATEGY, currentStrategy);
    }
  } catch { /* keep default opa3 */ }
}
async function onStrategyChange(val) {
  currentStrategy = val || 'opa3';
  lsSet(LS_STRATEGY, currentStrategy);
  const cur = document.querySelector('.page.visible');
  const name = cur ? cur.id : 'home';
  if (name === 'data' && dataReady) initData();
  if (name === 'balances' && balancesReady) loadBalances();
  checkHealth();
}


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
