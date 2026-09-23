// ══════════════════════════════════════════════════════════
// Data page — fills / logs / tables / summary
// ══════════════════════════════════════════════════════════
const LS_DATA_TAB = 'opadash.dataTab';
const LS_DBT_COMPACT = 'opadash.dbtCompact';
const LS_LG_COLS = 'opadash.lgCols';
const LS_LG_WIDTHS = 'opadash.lgColW';
const LS_LG_VIEW = 'opadash.lgView';

let dataTab = 'fills';
let lgTimer, rsTimer;

const DBT_HIDDEN_ALWAYS = new Set(['id', 'details']);
const DBT_COMPACT_HIDE = {
  fills: new Set([
    'id', 'details', 'volatility', 'implied_vol', 'funding_rate', 'predicted_funding',
    'open_interest', 'volume', 'settlement_px', 'commission_asset', 'product_id',
    'margin_ccy', 'pair', 'crop', 'kind', 'expiry', 'field', 'fill_type', 'role',
    'cost', 'slippage',
  ]),
  logs: new Set(['id']),
  account_balances: new Set(['id']),
  bot_command: new Set(['id', 'payload']),
  bot_setup: new Set(['setup']),
  deposits_withdrawals: new Set(['id']),
  coindcx_transactions: new Set(['id']),
};
const DBT_LABELS = {
  fills: 'Fills',
  logs: 'Logs',
  account_balances: 'Account balances',
  bot_ping: 'Bot pings',
  bot_setup: 'Bot setups',
  bot_command: 'Bot commands',
  bot_hold: 'Bot holds',
  deposits_withdrawals: 'Deposits / withdrawals',
  coindcx_transactions: 'CoinDCX txns',
};
const DBT_COL_HINTS = {
  fills: ['created_at', 'contract', 'account', 'exchange', 'side', 'strategy', 'order_id'],
  logs: ['created_at', 'strategy', 'account', 'contract', 'exchange', 'service', 'level'],
  account_balances: ['created_at', 'account', 'exchange', 'strategy'],
  bot_ping: ['pinged_at', 'strategy', 'account', 'contract'],
  bot_setup: ['updated_at', 'strategy', 'account', 'contract'],
  bot_command: ['created_at', 'strategy', 'account', 'contract', 'status'],
  bot_hold: ['updated_at', 'strategy', 'account', 'contract'],
  coindcx_transactions: ['created_at', 'pair'],
  deposits_withdrawals: ['created_at', 'account', 'exchange'],
};

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function fmtISTs(unixSecs) {
  return new Date(unixSecs * 1000).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    second: '2-digit', hour12: false,
  });
}
function fmtCount(n) {
  return Number(n || 0).toLocaleString('en-IN');
}
function stopDataTimers() {
  clearInterval(lgTimer);
  clearInterval(rsTimer);
}

function bindDataKeys() {
  if (window._dbtKeysBound) return;
  window._dbtKeysBound = true;
  document.addEventListener('keydown', dbtOnKey);
  document.addEventListener('click', (e) => {
    if (e.target.closest('.lg-cols-wrap')) return;
    document.querySelectorAll('.lg-cols-menu').forEach(menu => { menu.hidden = true; });
  });
}

function initData() {
  const compact = document.getElementById('dbtCompact');
  if (compact) compact.checked = lsGet(LS_DBT_COMPACT, '1') === '1';
  const tab = lsGet(LS_DATA_TAB, 'fills');
  showDataTab(['fills', 'logs', 'tables', 'rsum'].includes(tab) ? tab : 'fills');
  bindDataKeys();
  lgEnsureBoxBound(document.getElementById('lgBox'));
  lgSyncViewButtons();
}

function showDataTab(name) {
  if (!['fills', 'logs', 'tables', 'rsum'].includes(name)) name = 'fills';
  dataTab = name;
  lsSet(LS_DATA_TAB, name);
  const root = document.getElementById('data');
  if (root) {
    root.classList.toggle('fills-mode', name === 'fills');
    root.classList.toggle('logs-mode', name === 'logs');
  }
  ['browser', 'logs', 'rsum'].forEach(t => {
    const panel = document.getElementById('dpanel-' + t);
    const show = t === 'browser' ? (name === 'fills' || name === 'tables') : t === name;
    if (panel) panel.classList.toggle('visible', show);
  });
  ['fills', 'logs', 'tables', 'rsum'].forEach(t => {
    const tab = document.getElementById('dtab-' + t);
    if (tab) tab.classList.toggle('active', t === name);
  });
  stopDataTimers();
  if (name === 'fills' || name === 'tables') {
    if (typeof strategyIsAll === 'function' && !strategyIsAll(currentStrategy)) {
      const el = document.getElementById('dbtStrategy');
      if (el) el.value = currentStrategy;
    }
    loadDbTables();
    if (name === 'fills') {
      if (dbtName && dbtName !== 'fills') dbtLastOther = dbtName;
      openDbTable('fills', { preset: dbtName === 'fills' ? '' : 'today', keep: dbtName === 'fills' });
    } else if (dbtLastOther && dbtLastOther !== 'fills') {
      openDbTable(dbtLastOther, { keep: true });
    } else if (dbtName === 'fills') {
      dbtPaintList();
    }
  }
  if (name === 'logs') {
    if (typeof strategyIsAll === 'function' && !strategyIsAll(currentStrategy)) {
      const el = document.getElementById('lgStrategy');
      if (el) el.value = currentStrategy;
    }
    loadLogsX(true);
    setupLgAuto();
    lgSyncViewButtons();
  }
  if (name === 'rsum') { loadRsum(); setupRsAuto(); }
  if (name === 'logs' || name === 'rsum') {
    const status = document.getElementById('dbtStatus');
    if (status) status.textContent = '';
  }
}

// ── Table browser ─────────────────────────────────────────
let dbtName = null, dbtLastOther = null, dbtOffset = 0, dbtTotal = 0;
let dbtSort = '', dbtDir = 'desc';
let dbtColumns = [];
let dbtTypes = {};
let dbtPageRows = [];
let dbtPeekIdx = -1;
let dbtGen = 0;
let dbtTables = [];
const dbtFacetsCache = {};

function qsObj(p) {
  return Object.entries(p).filter(([, v]) => v !== '' && v != null && v !== false)
    .map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
}
function istYMD(offsetDays) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const today = fmt.format(new Date());
  if (!offsetDays) return today;
  const [y, m, d] = today.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + offsetDays));
  return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0');
}
function dbtLabel(name) {
  return DBT_LABELS[name] || name;
}
function dbtCompactOn() {
  const el = document.getElementById('dbtCompact');
  return !el || el.checked;
}
function dbtVisibleCols() {
  const hide = new Set(DBT_HIDDEN_ALWAYS);
  if (dbtCompactOn()) {
    (DBT_COMPACT_HIDE[dbtName] || []).forEach(c => hide.add(c));
  }
  const vis = dbtColumns.filter(c => !hide.has(c));
  return vis.length ? vis : dbtColumns;
}
function dbtToggleCompact() {
  const el = document.getElementById('dbtCompact');
  lsSet(LS_DBT_COMPACT, el && el.checked ? '1' : '0');
  if (dbtPageRows.length) dbtPaintGrid();
}

async function downloadNamedCsv(url, fallbackName) {
  const r = await fetch(url);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  const blob = await r.blob();
  const cd = r.headers.get('Content-Disposition') || '';
  const m = cd.match(/filename="([^"]+)"/);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (m && m[1]) || fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

function dbtPaintList() {
  const list = document.getElementById('dbtList');
  if (!list) return;
  if (!dbtTables.length) {
    list.innerHTML = '<div class="tbl-empty sm">No tables.</div>';
    return;
  }
  list.innerHTML = dbtTables.map(t =>
    '<button type="button" class="tbl-item' + (t.name === dbtName ? ' active' : '') +
      '" id="dbt-' + t.name + '" onclick="openDbTable(\'' + t.name + '\')">' +
      '<span class="tbl-item-name">' + esc(dbtLabel(t.name)) + '</span>' +
      '<span class="cnt">' + fmtCount(t.rows) + '</span></button>'
  ).join('');
}

async function loadDbTables() {
  try {
    const r = await fetch('/api/db/tables');
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    dbtTables = await r.json();
    dbtPaintList();
    if (dataTab === 'tables' && !dbtName && dbtTables.length) {
      openDbTable(dbtTables[0].name);
    }
  } catch (e) {
    const list = document.getElementById('dbtList');
    if (list) list.innerHTML = '<div class="tbl-empty sm" style="color:var(--red)">' + esc(e.message) + '</div>';
  }
}

function dbtClearFilterInputs() {
  ['dbtFrom', 'dbtFromTime', 'dbtTo', 'dbtToTime', 'dbtContract', 'dbtAccount', 'dbtExchange',
    'dbtStrategy', 'dbtService', 'dbtPair', 'dbtStatusCol', 'dbtOrderId', 'dbtQ'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const side = document.getElementById('dbtSide'); if (side) side.value = '';
  const level = document.getElementById('dbtLevel'); if (level) level.value = '';
  const preset = document.getElementById('dbtPreset'); if (preset) preset.value = '';
}

function openDbTable(name, opts) {
  opts = opts || {};
  const same = dbtName === name;
  dbtName = name;
  if (name && name !== 'fills') dbtLastOther = name;
  dbtPaintList();
  const title = document.getElementById('dbtTitle');
  if (title) title.textContent = dbtLabel(name);
  document.getElementById('dbtExportBtn').disabled = false;
  document.getElementById('dbtExportPageBtn').disabled = false;
  document.getElementById('dbtCopyBtn').disabled = false;
  dbtSyncFilterVisibility(DBT_COL_HINTS[name] || dbtColumns);
  loadDbFacets(name);
  if (opts.keep && same) {
    renderDbTable();
    return;
  }
  if (!same) {
    dbtOffset = 0;
    dbtSort = '';
    dbtDir = 'desc';
    dbtPeekIdx = -1;
    dbtClearFilterInputs();
    document.getElementById('dbtPeek').hidden = true;
    if (typeof strategyIsAll === 'function' && !strategyIsAll(currentStrategy)) {
      const strat = document.getElementById('dbtStrategy');
      if (strat) strat.value = currentStrategy;
    }
  }
  if (opts.preset) {
    const preset = document.getElementById('dbtPreset');
    if (preset) preset.value = opts.preset;
    dbtApplyPreset();
    return;
  }
  renderDbTable();
}
function dbtPage(dir) {
  const limit = parseInt(document.getElementById('dbtLimit').value) || 100;
  dbtOffset = Math.max(0, dbtOffset + dir * limit);
  renderDbTable();
}
function dbtGoto(offset) { dbtOffset = Math.max(0, offset); renderDbTable(); }
function dbtLastPage() {
  const limit = parseInt(document.getElementById('dbtLimit').value) || 100;
  dbtGoto(Math.max(0, Math.floor(Math.max(dbtTotal - 1, 0) / limit) * limit));
}
function dbtFilterKey(ev) { if (ev.key === 'Enter') { ev.preventDefault(); dbtApply(); } }
function dbtApply() { dbtOffset = 0; renderDbTable(); }
function dbtClearFilters() {
  dbtClearFilterInputs();
  dbtSort = '';
  dbtDir = 'desc';
  dbtApply();
}
function dbtMarkCustomRange() {
  const preset = document.getElementById('dbtPreset');
  if (preset) preset.value = '';
}
function dbtApplyPreset() {
  const p = document.getElementById('dbtPreset').value;
  const from = document.getElementById('dbtFrom');
  const to = document.getElementById('dbtTo');
  const fromT = document.getElementById('dbtFromTime');
  const toT = document.getElementById('dbtToTime');
  if (!p) {
    from.value = ''; to.value = '';
    if (fromT) fromT.value = '';
    if (toT) toT.value = '';
    dbtApply();
    return;
  }
  to.value = istYMD(0);
  if (fromT) fromT.value = '00:00';
  if (toT) toT.value = '23:59';
  if (p === 'today') from.value = istYMD(0);
  else if (p === '24h') {
    const parts = ms => {
      const p = {};
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(new Date(ms)).forEach(x => { if (x.type !== 'literal') p[x.type] = x.value; });
      return p;
    };
    const a = parts(Date.now() - 24 * 3600 * 1000);
    const b = parts(Date.now());
    from.value = a.year + '-' + a.month + '-' + a.day;
    to.value = b.year + '-' + b.month + '-' + b.day;
    if (fromT) fromT.value = a.hour + ':' + a.minute;
    if (toT) toT.value = b.hour + ':' + b.minute;
  } else if (p === '7d') from.value = istYMD(-6);
  else if (p === '30d') from.value = istYMD(-29);
  else if (p === '90d') from.value = istYMD(-89);
  dbtApply();
}
function dbtSortBy(col) {
  if (dbtSort === col) dbtDir = dbtDir === 'desc' ? 'asc' : 'desc';
  else {
    dbtSort = col;
    dbtDir = (col === 'id' || col.endsWith('_at') || col === 'pinged_at') ? 'desc' : 'asc';
  }
  dbtOffset = 0;
  renderDbTable();
}
function dbtSyncFilterVisibility(cols) {
  const set = new Set(cols || []);
  const hasTime = set.has('created_at') || set.has('updated_at') || set.has('time') || set.has('pinged_at');
  const compactHide = dbtCompactOn() ? (DBT_COMPACT_HIDE[dbtName] || new Set()) : new Set();
  const box = document.getElementById('dbtFilters');
  if (!box) return;
  box.hidden = !dbtName;
  box.querySelectorAll('[data-need]').forEach(el => {
    const need = el.getAttribute('data-need');
    const on = need === 'time' ? hasTime : (set.has(need) && !compactHide.has(need));
    el.hidden = !on;
  });
}
function dbtIstBound(dateId, timeId, isEnd) {
  const d = (document.getElementById(dateId)?.value || '').trim();
  if (!d) return '';
  let t = (document.getElementById(timeId)?.value || '').trim();
  if (!t) t = isEnd ? '23:59' : '00:00';
  if (t.length === 5) t += ':00';
  return d + 'T' + t;
}
function dbtFilterParams() {
  const val = id => (document.getElementById(id)?.value || '').trim();
  const p = {};
  const since = dbtIstBound('dbtFrom', 'dbtFromTime', false);
  const until = dbtIstBound('dbtTo', 'dbtToTime', true);
  if (since) p.since = since;
  if (until) p.until = until;
  if (val('dbtContract')) p.contract = val('dbtContract');
  const acct = val('dbtAccount');
  if (acct) p.account = acct === '(blank)' ? '__blank__' : acct;
  if (val('dbtExchange')) p.exchange = val('dbtExchange');
  if (val('dbtStrategy')) p.strategy = val('dbtStrategy');
  if (val('dbtSide')) p.side = val('dbtSide');
  if (val('dbtService')) p.service = val('dbtService');
  if (val('dbtLevel')) p.level = val('dbtLevel');
  if (val('dbtPair')) p.pair = val('dbtPair');
  if (val('dbtStatusCol')) p.status = val('dbtStatusCol');
  if (val('dbtOrderId')) p.order_id = val('dbtOrderId');
  if (val('dbtQ')) p.q = val('dbtQ');
  if (dbtSort) p.sort = dbtSort;
  if (dbtDir) p.dir = dbtDir;
  return p;
}
function dbtPaintChips() {
  const el = document.getElementById('dbtChips');
  if (!el) return;
  const p = dbtFilterParams();
  const bits = [];
  if (p.since || p.until) {
    const preset = (document.getElementById('dbtPreset') || {}).value;
    bits.push(preset === 'today' ? 'Today IST' : preset === '24h' ? 'Last 24h' : 'Custom range');
  }
  ['contract', 'account', 'exchange', 'strategy', 'side', 'service', 'level', 'pair', 'status', 'order_id', 'q'].forEach(k => {
    if (!p[k]) return;
    const label = k === 'q' ? 'search' : k.replace('_', ' ');
    bits.push(label + ': ' + (p[k] === '__blank__' ? '(blank)' : p[k]));
  });
  if (dbtSort) bits.push('sort ' + dbtSort + ' ' + dbtDir);
  el.hidden = !bits.length;
  el.innerHTML = bits.map(b => '<span class="dbt-chip">' + esc(b) + '</span>').join('');
}
async function loadDbFacets(name) {
  if (dbtFacetsCache[name]) { dbtFillFacets(dbtFacetsCache[name]); return; }
  try {
    const r = await fetch('/api/db/table/' + encodeURIComponent(name) + '/facets');
    if (!r.ok) return;
    const d = await r.json();
    dbtFacetsCache[name] = d.facets || {};
    dbtFillFacets(dbtFacetsCache[name]);
  } catch {}
}
function dbtFillFacets(facets) {
  const map = {
    contract: 'dbtContractList', account: 'dbtAccountList', exchange: 'dbtExchangeList',
    strategy: 'dbtStrategyList', service: 'dbtServiceList', pair: 'dbtPairList', status: 'dbtStatusList',
  };
  Object.entries(map).forEach(([col, id]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = (facets[col] || []).map(v => '<option value="' + String(v).replace(/"/g, '&quot;') + '">').join('');
  });
}
function dbtIsNum(col, types) {
  const t = (types && types[col]) || '';
  return /int|numeric|double|real|decimal|float/.test(t);
}
function dbtIsTime(col) {
  return col === 'created_at' || col === 'updated_at' || col === 'pinged_at' || col === 'taken_at' || col === 'done_at' || col === 'synced_at';
}
function dbtCellClass(col, v) {
  if (v == null || v === '') return 'muted';
  if (col === 'side') {
    const sl = String(v).toLowerCase();
    if (sl === 'buy') return 'side-buy';
    if (sl === 'sell') return 'side-sell';
  }
  if (col === 'level') return logLevelCls(v);
  if (col === 'rpnl' || col === 'upnl' || col === 'net_pnl' || col === 'amount') {
    const n = Number(v);
    if (!isFinite(n) || n === 0) return 'num';
    return 'num ' + (n > 0 ? 'pos-pos' : 'pos-neg');
  }
  if (col === 'fee' || col === 'cost') return 'num pos-neg';
  if (dbtIsNum(col, dbtTypes)) return 'num';
  return '';
}
function dbtCellText(col, v) {
  if (v == null) return '';
  if (dbtIsTime(col) && typeof v === 'number') return fmtISTs(v);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}
function dbtCellHtml(col, v) {
  if (v == null || v === '') return '<span class="muted">—</span>';
  if (dbtIsTime(col) && typeof v === 'number') return esc(fmtISTs(v));
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (col === 'level') return esc(String(v));
  const s = String(v);
  if ((s.startsWith('{') || s.startsWith('[')) && s.length > 24) {
    return '<span class="json-chip" title="' + esc(s).replace(/"/g, '&quot;') + '">{…}</span>';
  }
  if (s.length > 80) return '<span title="' + esc(s).replace(/"/g, '&quot;') + '">' + esc(s.slice(0, 80)) + '…</span>';
  if (col === 'rpnl' || col === 'upnl' || col === 'fee' || col === 'cost' || col === 'net_pnl') {
    const n = Number(v);
    if (isFinite(n)) {
      const abs = Math.abs(n);
      const d = abs >= 100 ? 2 : (abs >= 1 ? 2 : 4);
      return (n > 0 && col !== 'fee' ? '+' : '') + n.toLocaleString('en-IN', { maximumFractionDigits: d });
    }
  }
  return esc(s);
}
function dbtShowPeek(i) {
  dbtPeekIdx = i;
  document.querySelectorAll('#dbtGrid tbody tr').forEach((tr, idx) => tr.classList.toggle('selected', idx === i));
  const row = dbtPageRows[i];
  const peek = document.getElementById('dbtPeek');
  if (!peek) return;
  if (!row) { peek.hidden = true; return; }
  const lines = Object.entries(row).map(([k, v]) => {
    let shown = v;
    if (v == null) shown = '—';
    else if (dbtIsTime(k) && typeof v === 'number') shown = fmtISTs(v);
    else if (typeof v === 'string' && (v.startsWith('{') || v.startsWith('['))) {
      try { shown = JSON.stringify(JSON.parse(v), null, 2); } catch {}
    } else if (typeof v === 'boolean') shown = v ? 'true' : 'false';
    return '<div class="peek-row"><span class="pk">' + esc(k) + '</span><span class="pv">' + esc(String(shown)) + '</span></div>';
  });
  peek.hidden = false;
  peek.innerHTML =
    '<div class="peek-h"><span>Row ' + (dbtOffset + i + 1) + ' of ' + fmtCount(dbtTotal) +
      ' · ↑↓ to move · Esc to close</span>' +
      '<span class="peek-acts">' +
        '<button class="btn" type="button" onclick="dbtCopyPeek()">Copy</button>' +
        '<button class="btn" type="button" onclick="dbtClosePeek()">Close</button>' +
      '</span></div>' +
    lines.join('');
  peek.scrollTop = 0;
}
function dbtClosePeek() {
  dbtPeekIdx = -1;
  const peek = document.getElementById('dbtPeek');
  if (peek) peek.hidden = true;
  document.querySelectorAll('#dbtGrid tbody tr.selected').forEach(tr => tr.classList.remove('selected'));
}
async function dbtCopyPeek() {
  const row = dbtPageRows[dbtPeekIdx];
  if (!row) return;
  const text = Object.entries(row).map(([k, v]) => {
    let shown = v;
    if (v == null) shown = '';
    else if (dbtIsTime(k) && typeof v === 'number') shown = fmtISTs(v);
    return k + ': ' + shown;
  }).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied row', 'ok');
  } catch { toast('Clipboard blocked', 'err'); }
}
function dbtOnKey(ev) {
  const tag = (ev.target && ev.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  lgOnKey(ev);
  const page = document.getElementById('data');
  if (!page || !page.classList.contains('visible')) return;
  if (dataTab === 'logs') return;
  if (dataTab !== 'fills' && dataTab !== 'tables') return;
  if (ev.key === 'Escape') { dbtClosePeek(); return; }
  if (!dbtPageRows.length) return;
  if (ev.key === 'ArrowDown' || ev.key === 'j') {
    ev.preventDefault();
    dbtShowPeek(Math.min(dbtPageRows.length - 1, (dbtPeekIdx < 0 ? 0 : dbtPeekIdx + 1)));
  } else if (ev.key === 'ArrowUp' || ev.key === 'k') {
    ev.preventDefault();
    dbtShowPeek(Math.max(0, (dbtPeekIdx < 0 ? 0 : dbtPeekIdx - 1)));
  } else if (ev.key === 'ArrowRight') {
    ev.preventDefault();
    if (!document.getElementById('dbtNext').disabled) dbtPage(1);
  } else if (ev.key === 'ArrowLeft') {
    ev.preventDefault();
    if (!document.getElementById('dbtPrev').disabled) dbtPage(-1);
  }
}

function dbtPaintGrid() {
  const grid = document.getElementById('dbtGrid');
  const cols = dbtVisibleCols();
  if (!dbtPageRows.length) {
    grid.innerHTML = '<div class="tbl-empty">No rows match these filters.</div>';
    return;
  }
  const thead = cols.map(c => {
    const on = dbtSort === c;
    const arrow = on ? (dbtDir === 'asc' ? '▲' : '▼') : '';
    return '<th class="sortable' + (on ? ' sorted' : '') + (dbtIsNum(c, dbtTypes) ? ' num' : '') +
      '" onclick="dbtSortBy(\'' + c + '\')">' + esc(c) +
      (arrow ? '<span class="sa">' + arrow + '</span>' : '') + '</th>';
  }).join('');
  const body = dbtPageRows.map((row, ri) => {
    const tds = cols.map(col => {
      const cls = dbtCellClass(col, row[col]);
      return '<td' + (cls ? ' class="' + cls + '"' : '') + '>' + dbtCellHtml(col, row[col]) + '</td>';
    }).join('');
    return '<tr class="clickable' + (ri === dbtPeekIdx ? ' selected' : '') + '" onclick="dbtShowPeek(' + ri + ')">' + tds + '</tr>';
  }).join('');
  grid.innerHTML = '<table class="dtable"><thead><tr>' + thead + '</tr></thead><tbody>' + body + '</tbody></table>';
}

function dbtPaintPager() {
  const pager = document.getElementById('dbtPager');
  const limit = parseInt(document.getElementById('dbtLimit').value) || 100;
  pager.hidden = false;
  pager.style.display = 'flex';
  const from = dbtTotal ? (dbtOffset + 1) : 0;
  document.getElementById('dbtPageInfo').textContent =
    fmtCount(from) + '–' + fmtCount(Math.min(dbtOffset + limit, dbtTotal)) + ' of ' + fmtCount(dbtTotal);
  document.getElementById('dbtPrev').disabled = dbtOffset <= 0;
  document.getElementById('dbtFirst').disabled = dbtOffset <= 0;
  document.getElementById('dbtNext').disabled = dbtOffset + limit >= dbtTotal;
  document.getElementById('dbtLast').disabled = dbtOffset + limit >= dbtTotal;
  const exp = document.getElementById('dbtExportBtn');
  const expPage = document.getElementById('dbtExportPageBtn');
  const copyBtn = document.getElementById('dbtCopyBtn');
  if (exp) exp.disabled = !dbtTotal;
  if (expPage) expPage.disabled = !dbtPageRows.length;
  if (copyBtn) copyBtn.disabled = !dbtPageRows.length;
}

function dbtPaintStats(stats) {
  const el = document.getElementById('dbtStats');
  if (!el) return;
  if (!stats || !dbtTotal) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  const n = (x) => (x == null ? '—' : Number(x).toLocaleString('en-IN', { maximumFractionDigits: 2 }));
  const pnl = (x) => {
    if (x == null) return '—';
    const v = Number(x);
    return (v >= 0 ? '+' : '') + '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  };
  const cls = (x) => (Number(x) >= 0 ? 'pos-pos' : 'pos-neg');
  let html = '<div class="ins-cell"><div class="k">Matching rows</div><div class="v">' + fmtCount(dbtTotal) + '</div></div>';
  if (stats.rpnl != null) html += '<div class="ins-cell"><div class="k">Sum rPnL</div><div class="v ' + cls(stats.rpnl) + '">' + pnl(stats.rpnl) + '</div></div>';
  if (stats.fee != null) html += '<div class="ins-cell"><div class="k">Sum fee</div><div class="v pos-neg">' + n(stats.fee) + '</div></div>';
  if (stats.cost != null) html += '<div class="ins-cell"><div class="k">Sum cost</div><div class="v">' + n(stats.cost) + '</div></div>';
  el.innerHTML = html;
}

async function renderDbTable() {
  if (!dbtName) return;
  const gen = ++dbtGen;
  dbtPaintList();
  dbtPaintChips();
  const limit = parseInt(document.getElementById('dbtLimit').value) || 100;
  const grid = document.getElementById('dbtGrid');
  const filters = dbtFilterParams();
  const hadRows = dbtPageRows.length > 0;
  if (!hadRows) grid.innerHTML = '<div class="tbl-empty">Loading ' + esc(dbtLabel(dbtName)) + '…</div>';
  else grid.classList.add('is-loading');
  const status = document.getElementById('dbtStatus');
  if (status) status.textContent = 'Loading ' + dbtLabel(dbtName) + '…';
  try {
    const r = await fetch('/api/db/table/' + encodeURIComponent(dbtName) + '?' + qsObj({ limit, offset: dbtOffset, ...filters }));
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    const d = await r.json();
    if (gen !== dbtGen) return;
    dbtTotal = d.total;
    dbtColumns = d.columns || [];
    dbtTypes = d.types || {};
    dbtSort = d.sort || dbtSort;
    dbtDir = d.dir || dbtDir;
    dbtSyncFilterVisibility(dbtColumns);
    dbtPageRows = (d.rows || []).map(row => {
      const o = {};
      dbtColumns.forEach((c, i) => { o[c] = row[i]; });
      return o;
    });
    dbtPaintGrid();
    dbtPaintPager();
    dbtPaintStats(d.stats);
    dbtPaintChips();
    const title = document.getElementById('dbtTitle');
    if (title) title.textContent = dbtLabel(dbtName) + ' · ' + fmtCount(dbtTotal);
    if (status) status.textContent = fmtCount(dbtTotal) + ' rows' + (dbtSort ? ' · ' + dbtSort + ' ' + dbtDir : '');
    if (dbtPeekIdx >= 0 && dbtPeekIdx < dbtPageRows.length) dbtShowPeek(dbtPeekIdx);
    else dbtClosePeek();
  } catch (e) {
    if (gen !== dbtGen) return;
    if (!hadRows) grid.innerHTML = '<div class="tbl-empty" style="color:var(--red)">Error: ' + esc(e.message) + '</div>';
    if (status) status.innerHTML = '<span style="color:var(--red)">' + esc(e.message) + '</span>';
    toast(e.message, 'err');
  } finally {
    if (gen === dbtGen) grid.classList.remove('is-loading');
  }
}

async function exportDbTable() {
  if (!dbtName) return;
  const n = Math.min(Math.max(dbtTotal, 1), 100000);
  if (dbtTotal > 100000) toast('Exporting first 100,000 of ' + fmtCount(dbtTotal) + ' matching rows', '');
  document.getElementById('dbtStatus').textContent = 'Exporting ' + fmtCount(n) + ' matching rows…';
  try {
    const params = { ...dbtFilterParams(), limit: n };
    await downloadNamedCsv(
      '/api/db/table/' + encodeURIComponent(dbtName) + '/export?' + qsObj(params),
      dbtExportFilename(false)
    );
    document.getElementById('dbtStatus').textContent = 'Exported ' + fmtCount(n) + ' matching rows';
    toast('Exported ' + fmtCount(n) + ' rows', 'ok');
  } catch (e) {
    toast('Export failed: ' + e.message, 'err');
    document.getElementById('dbtStatus').innerHTML = '<span style="color:var(--red)">Export: ' + esc(e.message) + '</span>';
  }
}

function dbtExportFilename(pageOnly) {
  const p = dbtFilterParams();
  const bits = [dbtName];
  if (p.since) bits.push('from-' + p.since.replace(/[:T]/g, '').slice(0, 12));
  if (p.until) bits.push('to-' + p.until.replace(/[:T]/g, '').slice(0, 12));
  if (p.contract) bits.push(p.contract);
  if (p.account && p.account !== '__blank__') bits.push(p.account);
  if (p.exchange) bits.push(p.exchange);
  if (p.strategy) bits.push(p.strategy);
  if (p.side) bits.push(p.side);
  if (pageOnly) bits.push('page');
  return bits.join('_').replace(/[^\w.\-]+/g, '_') + '.csv';
}
function dbtCsvEsc(v) {
  const s = String(v ?? '');
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function dbtRowsCsv(rows) {
  const cols = dbtVisibleCols();
  return [cols.map(dbtCsvEsc).join(',')].concat(
    rows.map(row => cols.map(c => dbtCsvEsc(dbtCellText(c, row[c]))).join(','))
  ).join('\n');
}
function downloadTextFile(name, text, mime) {
  const blob = new Blob([text], { type: mime || 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}
function exportDbTablePage() {
  if (!dbtName || !dbtPageRows.length) { toast('Nothing on this page to export', 'err'); return; }
  downloadTextFile(dbtExportFilename(true), dbtRowsCsv(dbtPageRows), 'text/csv;charset=utf-8');
  toast('Exported ' + dbtPageRows.length + ' on-screen rows', 'ok');
}

async function copyDbTablePage() {
  if (!dbtPageRows.length) return;
  const cols = dbtVisibleCols();
  const lines = [cols.join('\t')].concat(dbtPageRows.map(row => cols.map(c => {
    return String(dbtCellText(c, row[c])).replace(/\t/g, ' ').replace(/\n/g, ' ');
  }).join('\t')));
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    toast('Copied ' + dbtPageRows.length + ' rows', 'ok');
  } catch {
    toast('Clipboard blocked', 'err');
  }
}

// ── Summary ───────────────────────────────────────────────
async function loadRsum() {
  const hours = document.getElementById('rsHours').value;
  document.getElementById('rsStatusMsg').textContent = 'Loading…';
  try {
    const r = await fetch(withStrategy('/api/rpnl/rollup' + (hours ? '?hours=' + hours : '')));
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    renderRsum(await r.json());
    document.getElementById('rsStatusMsg').textContent = 'Updated ' + new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
  } catch (e) {
    document.getElementById('rsStatusMsg').innerHTML = '<span style="color:var(--red)">Error: ' + esc(e.message) + '</span>';
  }
}
function pnlStr(v) { return (v >= 0 ? '+' : '') + '₹' + Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function pnlCls(v) { return v >= 0 ? 'pos-pos' : 'pos-neg'; }
function renderRsum(d) {
  const t = d.totals || { total: 0, fills: 0 };
  const cell = (k, v, cls) => '<div class="ins-cell"><div class="k">' + k + '</div><div class="v' + (cls ? ' ' + cls : '') + '">' + v + '</div></div>';
  document.getElementById('rsTotals').innerHTML =
    cell('rPnL', pnlStr(t.total), pnlCls(t.total)) +
    cell('Fills', fmtCount(t.fills || 0));

  const empty = '<div class="tbl-empty">No fills in this window.</div>';
  const sym = d.by_symbol || [];
  document.getElementById('rsSymGrid').innerHTML = !sym.length ? empty
    : '<table class="dtable"><thead><tr><th>Contract</th><th>Venue</th><th class="num">rPnL</th><th class="num">Fills</th></tr></thead><tbody>'
      + sym.map(s =>
        '<tr><td>' + esc(s.contract) + '</td>'
        + '<td>' + esc(s.quote_label || '') + '</td>'
        + '<td class="num ' + pnlCls(s.total) + '">' + pnlStr(s.total) + '</td>'
        + '<td class="num">' + fmtCount(s.fills || 0) + '</td></tr>'
      ).join('')
      + '<tr class="total-row"><td>Total</td><td></td>'
      + '<td class="num ' + pnlCls(t.total) + '">' + pnlStr(t.total) + '</td>'
      + '<td class="num">' + fmtCount(t.fills || 0) + '</td></tr>'
      + '</tbody></table>';

  const day = d.by_day || [];
  document.getElementById('rsDayGrid').innerHTML = !day.length ? empty
    : '<table class="dtable"><thead><tr><th>Date</th><th class="num">rPnL</th><th class="num">Fills</th></tr></thead><tbody>'
      + day.map(x =>
        '<tr><td>' + esc(x.date) + '</td>'
        + '<td class="num ' + pnlCls(x.total) + '">' + pnlStr(x.total) + '</td>'
        + '<td class="num">' + fmtCount(x.fills || 0) + '</td></tr>'
      ).join('') + '</tbody></table>';
}
function setupRsAuto() {
  clearInterval(rsTimer);
  if (document.getElementById('rsAuto').checked && dataTab === 'rsum') rsTimer = setInterval(loadRsum, 30000);
}
document.addEventListener('change', (e) => {
  if (e.target && e.target.id === 'rsHours') loadRsum();
});

// ── Live logs ─────────────────────────────────────────────
const LG_CAP = 8000;
const LG_META = new Set(['time', 'level', 'service', 'strategy', 'account', 'contract', 'exchange', 'name']);
const LG_COLS = [
  { key: 'time', label: 'Time', def: 'compact' },
  { key: 'level', label: 'Level', def: 'compact' },
  { key: 'kind', label: 'Kind', def: 'compact' },
  { key: 'strategy', label: 'Strategy', def: 'compact' },
  { key: 'contract', label: 'Contract', def: 'compact' },
  { key: 'bid', label: 'Bid', def: 'compact' },
  { key: 'ask', label: 'Ask', def: 'compact' },
  { key: 'hook', label: 'Hook', def: 'compact' },
  { key: 'pos', label: 'Pos', def: 'compact' },
  { key: 'buy', label: 'Buy', def: 'expand' },
  { key: 'sell', label: 'Sell', def: 'expand' },
  { key: 'side', label: 'Side', def: 'hide' },
  { key: 'qty', label: 'Qty', def: 'hide' },
  { key: 'px', label: 'Price', def: 'hide' },
  { key: 'spread', label: 'Spread', def: 'hide' },
  { key: 'hem', label: 'Hem', def: 'hide' },
  { key: 'span', label: 'Span', def: 'hide' },
  { key: 'step', label: 'Step', def: 'hide' },
  { key: 'cap', label: 'Cap', def: 'hide' },
  { key: 'rpnl', label: 'rPnL', def: 'hide' },
  { key: 'http', label: 'HTTP', def: 'hide' },
  { key: 'account', label: 'Account', def: 'hide' },
  { key: 'exchange', label: 'Exchange', def: 'hide' },
  { key: 'service', label: 'Service', def: 'hide' },
  { key: 'name', label: 'Logger', def: 'hide' },
  { key: 'detail', label: 'Detail', def: 'compact' },
  { key: 'message', label: 'Raw', def: 'hide' },
];
const LG_NUM = new Set(['bid', 'ask', 'pos', 'qty', 'px', 'spread', 'rpnl', 'cap']);
const LG_FLEX = new Set(['buy', 'sell', 'detail', 'message', 'hook', 'http']);
const LG_W_DEF = {
  time: 118, level: 62, kind: 64, strategy: 76, contract: 92,
  bid: 70, ask: 70, hook: 92, pos: 56, buy: 220, sell: 220,
  side: 52, qty: 56, px: 76, spread: 64, hem: 52, span: 52, step: 64,
  cap: 64, rpnl: 58, http: 160, account: 80, exchange: 76, service: 64,
  name: 108, detail: 160, message: 220,
};
const LG_W_MIN = 44;
const LG_W_MAX = 720;
let lgLastId = 0;
let lgFirstId = 0;
let lgRows = [];
let lgPeekId = 0;
let lgColStates = lgLoadCols();
let lgColWidths = lgLoadWidths();
let lgResize = null;
let lgPeekSrc = 'data';
let lgView = (lsGet(LS_LG_VIEW, 'table') === 'raw') ? 'raw' : 'table';

function lgLogRows(source) {
  if (source === 'rpnl' && typeof rpnlLogRows !== 'undefined' && Array.isArray(rpnlLogRows)) return rpnlLogRows;
  return lgRows;
}
function lgPeekEl(source) {
  return document.getElementById(source === 'rpnl' ? 'rpnlLgPeek' : 'lgPeek');
}
function lgBoxEl(source) {
  return document.getElementById(source === 'rpnl' ? 'rpnlLogsBox' : 'lgBox');
}
function lgSyncViewButtons() {
  document.querySelectorAll('.lg-view-btn').forEach(btn => {
    btn.classList.toggle('on', btn.getAttribute('data-lg-view') === lgView);
  });
  const rpnlLogs = typeof rpnlKind !== 'undefined' && rpnlKind === 'logs' &&
    typeof rpnlLogsOpen === 'function' && rpnlLogsOpen();
  document.querySelectorAll('.lg-view-btn.rp-log-view').forEach(btn => {
    btn.hidden = !rpnlLogs;
  });
  document.querySelectorAll('.lg-cols-wrap').forEach(el => {
    const rpnlOnly = el.classList.contains('rp-log-cols');
    el.hidden = lgView === 'raw' || (rpnlOnly && !rpnlLogs);
  });
}
function lgSetView(view) {
  lgView = view === 'raw' ? 'raw' : 'table';
  lsSet(LS_LG_VIEW, lgView);
  lgClosePeek();
  lgSyncViewButtons();
  lgPaintAll();
  if (typeof rpnlRepaintLogs === 'function') rpnlRepaintLogs();
}
function lgRawLine(l) {
  const bits = [l.strategy, l.contract, l.account, l.exchange].filter(Boolean);
  const chips = bits.map(b => '<span class="lchip">' + esc(b) + '</span>').join('');
  const lv = String(l.level || '').trim();
  return '<div class="log-line"><span class="lt">' + fmtISTs(l.time) + '</span> ' +
    '<span class="lsvc">[' + esc(l.service || '') + ']</span> ' +
    '<span class="' + logLevelCls(lv) + '">' + esc(lv) + '</span> ' +
    chips +
    '<span style="color:#6b768e">' + esc(fmtLogName(l.name)) + '</span> ' +
    esc(l.message || '') + '</div>';
}

function lgDefaultCols() {
  const o = {};
  LG_COLS.forEach(c => { o[c.key] = c.def; });
  return o;
}
function lgLoadCols() {
  const o = lgDefaultCols();
  try {
    const raw = JSON.parse(lsGet(LS_LG_COLS, '') || 'null');
    if (raw && typeof raw === 'object') {
      LG_COLS.forEach(c => {
        if (raw[c.key] === 'hide' || raw[c.key] === 'compact' || raw[c.key] === 'expand') o[c.key] = raw[c.key];
      });
    }
  } catch {}
  return o;
}
function lgSaveCols() { lsSet(LS_LG_COLS, JSON.stringify(lgColStates)); }
function lgColState(key) { return lgColStates[key] || 'compact'; }
function lgVisibleCols() { return LG_COLS.filter(c => lgColState(c.key) !== 'hide'); }
function lgLoadWidths() {
  const o = {};
  try {
    const raw = JSON.parse(lsGet(LS_LG_WIDTHS, '') || 'null');
    if (raw && typeof raw === 'object') {
      Object.keys(raw).forEach(k => {
        const n = Number(raw[k]);
        if (Number.isFinite(n)) o[k] = Math.max(LG_W_MIN, Math.min(LG_W_MAX, Math.round(n)));
      });
    }
  } catch {}
  return o;
}
function lgSaveWidths() { lsSet(LS_LG_WIDTHS, JSON.stringify(lgColWidths)); }
function lgColWidth(key) {
  const n = lgColWidths[key];
  if (Number.isFinite(n)) return n;
  return LG_W_DEF[key] || 100;
}
function lgColIsFlex(key) { return LG_FLEX.has(key); }
function lgSetWidth(key, px, persist) {
  const w = Math.max(LG_W_MIN, Math.min(LG_W_MAX, Math.round(px)));
  lgColWidths[key] = w;
  const css = w + 'px';
  document.querySelectorAll('.lg-table col[data-col="' + key + '"]').forEach(col => { col.style.width = css; });
  document.querySelectorAll('.lg-table th[data-col="' + key + '"]').forEach(th => {
    th.style.width = css;
    th.style.minWidth = css;
    th.style.maxWidth = persist || !lgColIsFlex(key) ? css : '';
  });
  if (persist) lgSaveWidths();
}
function lgColFloor(key) {
  if (key === 'buy' || key === 'sell') return 108;
  if (key === 'detail' || key === 'message' || key === 'http') return 80;
  if (lgColIsFlex(key)) return 72;
  return lgColWidth(key);
}
function lgFitMin(key) {
  if (key === 'buy' || key === 'sell') return 100;
  if (key === 'time') return 104;
  if (key === 'detail' || key === 'message' || key === 'http') return 68;
  if (lgColIsFlex(key)) return 60;
  if (key === 'level' || key === 'kind' || key === 'pos') return 46;
  return 50;
}
function lgLayoutRoot(box) {
  if (lgResize || !box) return;
  const table = box.querySelector('table.lg-table');
  if (!table) return;
  const vis = lgVisibleCols();
  if (!vis.length) return;
  const avail = Math.max(0, box.clientWidth);
  const base = vis.map(c => lgColWidth(c.key));
  const sum = base.reduce((a, b) => a + b, 0);
  const flex = vis.map((c, i) => lgColIsFlex(c.key) ? i : -1).filter(i => i >= 0);
  const out = base.slice();
  if (avail > sum && flex.length) {
    const extra = avail - sum;
    let used = 0;
    const each = extra / flex.length;
    flex.forEach((i, n) => {
      const add = n === flex.length - 1 ? extra - used : Math.floor(each);
      used += add;
      out[i] += add;
    });
  } else if (avail < sum && flex.length) {
    let deficit = sum - avail;
    const slack = flex.map(i => ({ i, room: Math.max(0, out[i] - lgColFloor(vis[i].key)) }))
      .filter(x => x.room > 0);
    const roomSum = slack.reduce((a, x) => a + x.room, 0);
    if (roomSum > 0) {
      slack.forEach((x, n) => {
        if (deficit <= 0) return;
        const share = n === slack.length - 1 ? deficit : Math.round(deficit * (x.room / roomSum));
        const take = Math.max(0, Math.min(x.room, share, deficit));
        out[x.i] -= take;
        deficit -= take;
      });
    }
  }
  let used = out.reduce((a, b) => a + b, 0);
  if (avail > 0 && used > avail) {
    let deficit = used - avail;
    const mins = vis.map(c => lgFitMin(c.key));
    const slack = out.map((w, i) => ({ i, room: Math.max(0, w - mins[i]) })).filter(x => x.room > 0);
    const roomSum = slack.reduce((a, x) => a + x.room, 0);
    if (roomSum > 0) {
      slack.forEach((x, n) => {
        if (deficit <= 0) return;
        const share = n === slack.length - 1 ? deficit : Math.round(deficit * (x.room / roomSum));
        const take = Math.max(0, Math.min(x.room, share, deficit));
        out[x.i] -= take;
        deficit -= take;
      });
    }
  }
  vis.forEach((c, i) => {
    const css = out[i] + 'px';
    const col = table.querySelector('col[data-col="' + c.key + '"]');
    const th = table.querySelector('th[data-col="' + c.key + '"]');
    if (col) col.style.width = css;
    if (th) {
      th.style.width = css;
      th.style.minWidth = Math.min(base[i], out[i]) + 'px';
      th.style.maxWidth = css;
    }
  });
  table.style.width = Math.max(avail, out.reduce((a, b) => a + b, 0)) + 'px';
}
function lgLayoutColumns() {
  lgLayoutRoot(document.getElementById('lgBox'));
  lgLayoutRoot(document.getElementById('rpnlLogsBox'));
}
function lgRenderColgroup() {
  return '<colgroup>' + LG_COLS.map(c => {
    const hide = lgColState(c.key) === 'hide' ? ' class="lg-hide"' : '';
    return '<col data-col="' + c.key + '"' + hide + ' style="width:' + lgColWidth(c.key) + 'px">';
  }).join('') + '</colgroup>';
}
function lgEnsureBoxBound(box) {
  if (!box) return;
  if (!box._lgResizeBound) {
    box._lgResizeBound = true;
    box.addEventListener('pointerdown', lgResizeDown);
    box.addEventListener('dblclick', lgResizeDbl);
  }
  if (!box._lgLayoutRo && window.ResizeObserver) {
    box._lgLayoutRo = new ResizeObserver(() => {
      if (lgResize) return;
      lgLayoutRoot(box);
    });
    box._lgLayoutRo.observe(box);
  }
  lgLayoutRoot(box);
}
function lgEnsureResizeBound() {
  lgEnsureBoxBound(document.getElementById('lgBox'));
  lgEnsureBoxBound(document.getElementById('rpnlLogsBox'));
}
function lgResizeDown(ev) {
  const handle = ev.target.closest('.lg-th-resize');
  if (!handle || ev.button) return;
  ev.preventDefault();
  ev.stopPropagation();
  const key = handle.dataset.col;
  const th = handle.parentElement;
  lgResize = {
    key,
    startX: ev.clientX,
    startW: th.getBoundingClientRect().width,
    moved: false,
    pid: ev.pointerId,
  };
  try { handle.setPointerCapture(ev.pointerId); } catch {}
  document.body.classList.add('lg-resizing');
  const blockClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    handle.removeEventListener('click', blockClick, true);
  };
  handle.addEventListener('click', blockClick, true);
  window.addEventListener('pointermove', lgResizeMove);
  window.addEventListener('pointerup', lgResizeUp);
  window.addEventListener('pointercancel', lgResizeUp);
}
function lgResizeMove(ev) {
  if (!lgResize) return;
  const dx = ev.clientX - lgResize.startX;
  if (Math.abs(dx) > 2) lgResize.moved = true;
  lgSetWidth(lgResize.key, lgResize.startW + dx, false);
}
function lgResizeUp() {
  if (!lgResize) return;
  if (lgResize.moved) lgSaveWidths();
  lgResize = null;
  document.body.classList.remove('lg-resizing');
  window.removeEventListener('pointermove', lgResizeMove);
  window.removeEventListener('pointerup', lgResizeUp);
  window.removeEventListener('pointercancel', lgResizeUp);
  lgLayoutColumns();
}
function lgResizeDbl(ev) {
  const handle = ev.target.closest('.lg-th-resize');
  if (!handle) return;
  ev.preventDefault();
  ev.stopPropagation();
  lgAutoFit(handle.dataset.col, handle.closest('table'));
}
function lgAutoFit(key, table) {
  table = table || document.querySelector('#lgBox table.lg-table') ||
    document.querySelector('#rpnlLogsBox table.lg-table');
  if (!table) return;
  const th = table.querySelector('th[data-col="' + key + '"]');
  const tds = table.querySelectorAll('td[data-col="' + key + '"]');
  let max = 56;
  const probe = document.getElementById('lgWidthProbe') || (() => {
    const el = document.createElement('span');
    el.id = 'lgWidthProbe';
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
    return el;
  })();
  const sample = th || tds[0];
  if (sample) {
    const cs = getComputedStyle(sample);
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;font:' +
      cs.font + ';letter-spacing:' + cs.letterSpacing + ';';
  }
  if (th) {
    probe.textContent = (th.childNodes[0] && th.childNodes[0].textContent) || '';
    max = Math.max(max, probe.offsetWidth + 36);
  }
  const n = Math.min(tds.length, 80);
  for (let i = 0; i < n; i++) {
    const td = tds[i];
    const rungs = td.querySelector('.lg-rungs');
    if (rungs) {
      const prev = rungs.style.width;
      rungs.style.width = 'max-content';
      max = Math.max(max, Math.ceil(rungs.scrollWidth) + 24);
      rungs.style.width = prev;
    } else {
      probe.textContent = (td.innerText || '').replace(/\s+/g, ' ').trim();
      max = Math.max(max, probe.offsetWidth + 20);
    }
  }
  lgSetWidth(key, max, true);
  lgLayoutColumns();
}

function lgParseQuoteRung(raw) {
  const src = String(raw || '').trim();
  if (!src || src === '-') return null;
  const off = /\boff\b/.test(src);
  const s = src.replace(/\s*\boff\b\s*/g, ' ').trim();
  const m = s.match(/^([0-9.eE+-]+)\s+(\S+?)(?:\s+|×)([0-9.eE+-]+)$/)
    || s.match(/^([0-9.eE+-]+)\s+(\S+)$/);
  if (!m) return { kind: 'rung', text: src, px: '', role: src, qty: '', off };
  const qty = m[3] || '';
  const role = m[2];
  const px = m[1];
  return {
    kind: 'rung', px, role, qty, off,
    text: (qty ? qty + '@' : '') + px + (role ? ' ' + role : '') + (off ? ' off' : ''),
  };
}
function lgParseQuoteRungs(inner) {
  if (!inner || inner.trim() === '-') return [];
  return inner.split(',').map(lgParseQuoteRung).filter(Boolean);
}
function lgParseLegBody(depth, body) {
  const b = String(body || '').trim();
  const edit = b.match(/^([0-9.eE+-]+)@([0-9.eE+-]+)→([0-9.eE+-]+)@([0-9.eE+-]+)/);
  if (edit) {
    return {
      kind: 'edit', depth,
      qty0: edit[1], px0: edit[2], qty1: edit[3], px1: edit[4],
      text: depth + ' ' + edit[1] + '@' + edit[2] + '→' + edit[3] + '@' + edit[4],
    };
  }
  const cr = b.match(/^([0-9.eE+-]+)@([0-9.eE+-]+)/);
  if (cr) {
    return { kind: 'create', depth, qty: cr[1], px: cr[2], text: depth + ' ' + cr[1] + '@' + cr[2] };
  }
  const at = b.match(/^id=(\S+)\s+([0-9.eE+-]+)\s+@\s+([0-9.eE+-]+)/);
  if (at) {
    return { kind: 'create', depth, id: at[1], qty: at[2], px: at[3], text: depth + ' ' + at[2] + '@' + at[3] };
  }
  return { kind: 'leg', depth, text: (depth + (b ? ' ' + b : '')).trim() };
}
function lgParseBatchLegs(s) {
  const buy = [], sell = [];
  const re = /\b(buy|sell):(\d+)\s*/g;
  const hits = [];
  let m;
  while ((m = re.exec(s))) hits.push({ side: m[1], depth: m[2], i: m.index, end: m.index + m[0].length });
  for (let i = 0; i < hits.length; i++) {
    const from = hits[i].end;
    const to = i + 1 < hits.length ? hits[i + 1].i : s.length;
    const part = lgParseLegBody(hits[i].depth, s.slice(from, to));
    (hits[i].side === 'buy' ? buy : sell).push(part);
  }
  return { buy, sell };
}
function lgJoinParts(parts) {
  return (parts || []).map(p => p.text).join(' · ');
}
function lgParse(msg) {
  const s = String(msg || '').trim();
  const out = {
    kind: 'other', bid: '', ask: '', hook: '', spread: '', pos: '', hem: '', span: '', step: '',
    cap: '', buy: '', sell: '', buyParts: [], sellParts: [], side: '', qty: '', px: '', rpnl: '',
    http: '', detail: s,
  };
  const kv = {};
  s.replace(/\b([a-z_][a-z0-9_]*)=([^\s]+)/gi, (_, k, v) => { kv[k.toLowerCase()] = v; return ''; });
  out.pos = kv.pos || '';
  out.hem = kv.hem || '';
  out.span = kv.span || '';
  out.step = kv.step || kv.tail || '';
  out.spread = kv.spread || '';
  out.cap = kv.cap || '';
  out.rpnl = kv.rpnl || '';

  const fill = s.match(/^fill\s+(buy|sell)\s+([0-9.eE+-]+)\s+@\s+([0-9.eE+-]+)(?:\s+rpnl=(\S+))?(.*)$/i);
  if (fill) {
    out.kind = 'fill';
    out.side = fill[1].toLowerCase();
    out.qty = fill[2];
    out.px = fill[3];
    if (fill[4]) out.rpnl = fill[4];
    out.detail = (fill[5] || '').trim();
    const bit = { kind: 'fill', qty: fill[2], px: fill[3], text: fill[2] + '@' + fill[3] };
    if (out.side === 'buy') { out.buyParts = [bit]; out.buy = bit.text; }
    else { out.sellParts = [bit]; out.sell = bit.text; }
    return out;
  }

  const http = s.match(/^(GET|PUT|POST|DELETE)\s+(\/\S+)\s+(\d{3})(?:\s+(.*))?$/);
  if (http) {
    out.kind = 'http';
    out.http = http[1] + ' ' + http[2] + ' ' + http[3];
    out.detail = [out.http, http[4] || ''].filter(Boolean).join(' ');
    return out;
  }

  const batch = s.match(/^(EDIT|CREATE|CANCEL)\s+batch\b(.*)$/i);
  if (batch) {
    out.kind = batch[1].toLowerCase();
    const rest = (batch[2] || '').trim();
    if (/\b(?:buy|sell):\d+/.test(rest) && !/^(failed|gone|rejected)\b/i.test(rest)) {
      const legs = lgParseBatchLegs(rest);
      out.buyParts = legs.buy;
      out.sellParts = legs.sell;
      out.buy = lgJoinParts(legs.buy);
      out.sell = lgJoinParts(legs.sell);
      out.detail = '';
    } else {
      out.detail = rest;
    }
    return out;
  }

  const one = s.match(/^(CREATE|EDIT|CANCEL|ADOPT)\s+(buy|sell):(\d+)\s+(.*)$/i);
  if (one) {
    out.kind = one[1].toLowerCase();
    const part = lgParseLegBody(one[3], one[4]);
    if (one[2].toLowerCase() === 'buy') { out.buyParts = [part]; out.buy = part.text; }
    else { out.sellParts = [part]; out.sell = part.text; }
    out.side = one[2].toLowerCase();
    if (part.qty) out.qty = part.qty;
    if (part.px) out.px = part.px;
    if (part.qty1) { out.qty = part.qty1; out.px = part.px1; }
    out.detail = '';
    return out;
  }

  const book = s.match(/\bbook\s+([0-9.eE+-]+)\s*\/\s*([0-9.eE+-]+)/);
  const buyM = s.match(/\bbuy\[([^\]]*)\]/);
  const sellM = s.match(/\bsell\[([^\]]*)\]/);
  if (book || buyM || sellM || /^now=/.test(s)) {
    out.kind = 'quote';
    if (book) { out.bid = book[1]; out.ask = book[2]; }
    const hook = s.match(/\b(?:hook|ref)=(\S+)(?:\s+([0-9.eE+-]+))?/);
    if (hook) out.hook = hook[2] ? hook[1] + ' ' + hook[2] : hook[1];
    else if (kv.mid) out.hook = 'mid ' + kv.mid;
    if (buyM) { out.buyParts = lgParseQuoteRungs(buyM[1]); out.buy = lgJoinParts(out.buyParts); }
    if (sellM) { out.sellParts = lgParseQuoteRungs(sellM[1]); out.sell = lgJoinParts(out.sellParts); }
    out.detail = '';
    return out;
  }
  return out;
}
function lgParsed(l) {
  if (!l._p || l._p._raw !== l.message) {
    l._p = lgParse(l.message);
    l._p._raw = l.message;
  }
  return l._p;
}

function lgDash(v) {
  const s = String(v ?? '').trim();
  return s ? esc(s) : '<span class="muted">—</span>';
}
function lgLevelKind(level) {
  const lv = String(level || '').trim().toUpperCase();
  if (lv === 'ERROR' || lv === 'CRITICAL') return 'err';
  if (lv === 'WARNING' || lv === 'WARN') return 'warn';
  return '';
}
function lgCellText(l, key) {
  if (key === 'time') return fmtISTs(l.time);
  if (key === 'name') return fmtLogName(l.name);
  if (key === 'message') return l.message || '';
  if (LG_META.has(key)) return l[key] == null ? '' : String(l[key]);
  const p = lgParsed(l);
  if (key === 'kind') return p.kind || '';
  const v = p[key];
  return v == null ? '' : String(v);
}
function lgMiniParts(parts) {
  if (!parts || !parts.length) return '';
  const k = parts[0].kind;
  const cell = (v, extra) => {
    const t = v == null ? '' : String(v);
    return '<span class="' + (extra || '') + '" title="' + esc(t) + '">' + esc(t) + '</span>';
  };
  if (k === 'rung') {
    return '<div class="lg-rungs lg-rungs-quote">' + parts.map(p => {
      const m = p.off ? ' muted' : '';
      return cell(p.qty, 'lg-rq' + m) + cell(p.px, 'lg-rp' + m) + cell(p.role + (p.off ? ' off' : ''), 'lg-rr' + m);
    }).join('') + '</div>';
  }
  if (k === 'edit') {
    return '<div class="lg-rungs lg-rungs-edit">' + parts.map(p =>
      cell(p.depth, 'lg-rd') +
      cell(p.qty0, 'lg-rq') + cell(p.px0, 'lg-rp') +
      cell('→', 'lg-ra') +
      cell(p.qty1, 'lg-rq') + cell(p.px1, 'lg-rp')
    ).join('') + '</div>';
  }
  if (k === 'fill') {
    return '<div class="lg-rungs lg-rungs-fill">' + parts.map(p => cell(p.qty, 'lg-rq') + cell(p.px, 'lg-rp')).join('') + '</div>';
  }
  if (k === 'create') {
    return '<div class="lg-rungs lg-rungs-create">' + parts.map(p =>
      cell(p.depth, 'lg-rd') + cell(p.qty, 'lg-rq') + cell(p.px, 'lg-rp')
    ).join('') + '</div>';
  }
  return parts.map(p => '<div class="lg-rung">' + esc(p.text) + '</div>').join('');
}
function lgCellHtml(l, col) {
  const key = col.key;
  const st = lgColState(key);
  if (key === 'level') {
    const lv = String(l.level || '').trim().toUpperCase();
    return '<span class="lg-pill ' + logLevelCls(lv) + '">' + esc(lv || '—') + '</span>';
  }
  if (key === 'kind') {
    const kind = lgParsed(l).kind || 'other';
    return '<span class="lg-pill lg-kind-' + esc(kind) + '">' + esc(kind) + '</span>';
  }
  if (key === 'side') {
    const side = lgCellText(l, 'side');
    if (!side) return lgDash('');
    return '<span class="side-' + (side === 'sell' ? 'sell' : 'buy') + '">' + esc(side) + '</span>';
  }
  if ((key === 'buy' || key === 'sell') && st === 'expand') {
    const parts = lgParsed(l)[key === 'buy' ? 'buyParts' : 'sellParts'];
    if (parts && parts.length) return lgMiniParts(parts);
  }
  const text = lgCellText(l, key);
  return text ? esc(text) : lgDash('');
}
function lgTdClass(col) {
  const bits = ['lg-' + lgColState(col.key)];
  if (LG_NUM.has(col.key)) bits.push('num');
  if (col.key === 'buy') bits.push('lg-buy');
  if (col.key === 'sell') bits.push('lg-sell');
  if (col.key === 'time') bits.push('muted', 'lg-time');
  if (col.key === 'message' || col.key === 'detail' || col.key === 'http') bits.push('lg-msg');
  return bits.join(' ');
}
function lgRenderRow(l, source) {
  source = source || 'data';
  const lv = String(l.level || '').trim().toUpperCase();
  const kind = lgLevelKind(lv);
  const sel = (l.id === lgPeekId && source === lgPeekSrc) ? ' selected' : '';
  const tds = LG_COLS.map(col => {
    const hide = lgColState(col.key) === 'hide' ? ' lg-hide' : '';
    return '<td class="' + lgTdClass(col) + hide + '" data-col="' + col.key + '">' + lgCellHtml(l, col) + '</td>';
  }).join('');
  return '<tr class="clickable' + (kind ? ' lg-' + kind : '') + sel +
    '" data-id="' + l.id + '" onclick="lgShowPeek(' + l.id + ',\'' + source + '\')">' + tds + '</tr>';
}
function lgRenderHead() {
  return LG_COLS.map(col => {
    const st = lgColState(col.key);
    const hide = st === 'hide' ? ' lg-hide' : '';
    const w = lgColWidth(col.key);
    const hint = 'Drag edge to resize · click wraps/clips · × hides';
    const max = lgColIsFlex(col.key) ? '' : ';max-width:' + w + 'px';
    return '<th class="lg-th lg-' + st + hide + '" data-col="' + col.key +
      '" style="width:' + w + 'px;min-width:' + w + 'px' + max + '" title="' + hint +
      '" onclick="lgColCycle(\'' + col.key + '\')">' +
      esc(col.label) +
      '<span class="lg-th-mode">' + (st === 'expand' ? '+' : '…') + '</span>' +
      '<button type="button" class="lg-th-x" title="Hide column" onclick="event.stopPropagation(); lgColSet(\'' +
      col.key + '\',\'hide\')">×</button>' +
      '<span class="lg-th-resize" data-col="' + col.key + '" title="Drag to resize"></span></th>';
  }).join('');
}
function lgColCycle(key) {
  const st = lgColState(key);
  if (st === 'hide') { lgColSet(key, 'compact'); return; }
  lgColSet(key, st === 'expand' ? 'compact' : 'expand');
}
function lgColSet(key, state) {
  lgColStates[key] = state;
  lgSaveCols();
  const dataBox = document.getElementById('lgBox');
  const rpnlBox = document.getElementById('rpnlLogsBox');
  const dataTop = dataBox ? dataBox.scrollTop : 0;
  const rpnlTop = rpnlBox ? rpnlBox.scrollTop : 0;
  const openMenus = [...document.querySelectorAll('.lg-cols-menu')].filter(m => !m.hidden);
  lgPaintAll();
  if (typeof rpnlRepaintLogs === 'function') rpnlRepaintLogs();
  if (dataBox) dataBox.scrollTop = dataTop;
  if (rpnlBox) rpnlBox.scrollTop = rpnlTop;
  if (lgPeekId) lgShowPeek(lgPeekId, lgPeekSrc);
  openMenus.forEach(menu => { lgPaintColMenu(menu); menu.hidden = false; });
}
function lgResetCols() {
  lgColStates = lgDefaultCols();
  lgColWidths = {};
  lgSaveCols();
  lgSaveWidths();
  lgColSet(LG_COLS[0].key, lgColState(LG_COLS[0].key));
}
function lgToggleColsMenu(ev) {
  const wrap = ev && ev.target && ev.target.closest('.lg-cols-wrap');
  const menu = (wrap && wrap.querySelector('.lg-cols-menu')) || document.getElementById('lgColsMenu');
  if (!menu) return;
  const open = menu.hidden;
  document.querySelectorAll('.lg-cols-menu').forEach(m => { m.hidden = true; });
  if (open) {
    lgPaintColMenu(menu);
    menu.hidden = false;
  }
}
function lgPaintColMenu(el) {
  const menu = el || document.getElementById('lgColsMenu') || document.getElementById('rpnlLgColsMenu');
  if (!menu) return;
  const btn = (key, st, label) => {
    const on = lgColState(key) === st ? ' on' : '';
    return '<button type="button" class="lg-col-st' + on + '" onclick="lgColSet(\'' + key + '\',\'' + st + '\')">' + label + '</button>';
  };
  menu.innerHTML = LG_COLS.map(col =>
    '<div class="lg-cols-row"><span>' + esc(col.label) + '</span>' +
    btn(col.key, 'compact', '…') +
    btn(col.key, 'expand', '+') +
    btn(col.key, 'hide', '×') +
    '</div>'
  ).join('') +
    '<div class="lg-cols-foot"><button type="button" class="btn" onclick="lgResetCols()">Reset columns</button>' +
    '<span class="muted" style="margin-left:8px;font-size:11px">Drag header edges to set width</span></div>';
}
function lgPaintColChips() {
  const el = document.getElementById('lgColChips');
  if (!el) return;
  if (lgView === 'raw') { el.hidden = true; el.innerHTML = ''; return; }
  const hidden = LG_COLS.filter(c => lgColState(c.key) === 'hide');
  if (!hidden.length) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = '<span class="muted" style="font-size:11px">Hidden</span> ' + hidden.map(c =>
    '<button type="button" class="dbt-chip" onclick="lgColSet(\'' + c.key + '\',\'compact\')">' +
    esc(c.label) + ' +</button>'
  ).join('');
}
function lgFilterParams(extra) {
  const val = id => (document.getElementById(id)?.value || '').trim();
  return {
    service: val('lgService'),
    level: val('lgLevel'),
    search: val('lgSearch'),
    since: val('lgFrom'),
    until: val('lgTo'),
    strategy: val('lgStrategy'),
    contract: val('lgContract'),
    account: val('lgAccount'),
    exchange: val('lgExchange'),
    ...(extra || {}),
  };
}
function lgTbody(box) {
  box = box || document.getElementById('lgBox');
  return box && box.querySelector('tbody');
}
function lgPaintInto(box, rows, source, emptyMsg) {
  if (!box) return;
  lgEnsureBoxBound(box);
  if (!rows.length) {
    box.innerHTML = '<div class="tbl-empty">' + esc(emptyMsg || 'No logs yet.') + '</div>';
    return;
  }
  if (lgView === 'raw') {
    box.innerHTML = rows.map(lgRawLine).join('');
    return;
  }
  box.innerHTML = '<table class="dtable lg-table">' + lgRenderColgroup() + '<thead><tr>' + lgRenderHead() +
    '</tr></thead><tbody>' + rows.map(l => lgRenderRow(l, source || 'data')).join('') + '</tbody></table>';
  lgLayoutRoot(box);
}
function lgPaintAll() {
  const box = document.getElementById('lgBox');
  if (!box) return;
  lgPaintInto(
    box, lgRows, 'data',
    'No logs yet. Redeploy the bot service to start streaming them here.',
  );
  lgPaintChrome();
}
function lgAppendInto(box, lines, where, source) {
  if (!box || !lines.length) return;
  if (lgView === 'raw') {
    box.insertAdjacentHTML(where === 'start' ? 'afterbegin' : 'beforeend', lines.map(lgRawLine).join(''));
    return;
  }
  const tb = lgTbody(box);
  if (!tb) {
    lgPaintInto(box, lgLogRows(source), source);
    return;
  }
  tb.insertAdjacentHTML(
    where === 'start' ? 'afterbegin' : 'beforeend',
    lines.map(l => lgRenderRow(l, source || 'data')).join(''),
  );
}
function lgAppendRows(lines, where) {
  lgAppendInto(document.getElementById('lgBox'), lines, where, 'data');
}
function lgTrimLive() {
  const box = document.getElementById('lgBox');
  const tb = lgTbody(box);
  while (lgRows.length > LG_CAP) {
    const drop = lgRows.shift();
    if (drop && drop.id === lgPeekId && lgPeekSrc === 'data') lgClosePeek();
    if (lgView === 'raw') {
      if (box && box.firstChild) box.removeChild(box.firstChild);
    } else if (tb && tb.firstChild) tb.removeChild(tb.firstChild);
  }
  lgFirstId = lgRows.length ? lgRows[0].id : 0;
}
function lgPaintStats() {
  const el = document.getElementById('lgStats');
  if (!el) return;
  if (!lgRows.length) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  const counts = { INFO: 0, WARNING: 0, ERROR: 0 };
  lgRows.forEach(l => {
    const lv = String(l.level || '').toUpperCase();
    if (lv === 'WARN' || lv === 'WARNING') counts.WARNING++;
    else if (lv === 'ERROR' || lv === 'CRITICAL') counts.ERROR++;
    else if (lv === 'INFO') counts.INFO++;
  });
  const cell = (k, v, cls) =>
    '<div class="ins-cell"><div class="k">' + k + '</div><div class="v' +
    (cls ? ' ' + cls : '') + '">' + fmtCount(v) + '</div></div>';
  el.hidden = false;
  el.innerHTML =
    cell('Shown', lgRows.length) +
    cell('Info', counts.INFO, 'lv-INFO') +
    cell('Warn', counts.WARNING, 'lv-WARNING') +
    cell('Error', counts.ERROR, 'lv-ERROR');
}
function lgPaintChrome() {
  lgPaintStats();
  lgPaintColChips();
  const title = document.getElementById('lgTitle');
  if (title) title.textContent = lgRows.length ? 'Logs · ' + fmtCount(lgRows.length) + ' shown' : 'Logs';
  const copy = document.getElementById('lgCopyBtn');
  if (copy) copy.disabled = !lgRows.length;
  const status = document.getElementById('lgStatus');
  if (status) {
    status.textContent = lgLastId ? 'id ' + lgLastId : '';
  }
  if (lgPeekId) {
    const box = lgBoxEl(lgPeekSrc);
    const tr = box && box.querySelector('tr[data-id="' + lgPeekId + '"]');
    if (tr) tr.classList.add('selected');
  }
}

async function loadLogsX(reset) {
  const initLim = parseInt(document.getElementById('lgLimit').value) || 1000;
  const box = document.getElementById('lgBox');
  try {
    let lines;
    if (reset || !lgLastId) {
      box.classList.add('is-loading');
      const r = await fetch('/api/logs?' + qsObj(lgFilterParams({ limit: initLim })));
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
      lines = (await r.json()).reverse();
      lgRows = lines;
      lgPeekId = 0;
      lgFirstId = lines.length ? lines[0].id : 0;
      lgLastId = lines.length ? lines[lines.length - 1].id : 0;
      lgPaintAll();
      lgClosePeek();
    } else {
      const r = await fetch('/api/logs?' + qsObj(lgFilterParams({ limit: 500, after_id: lgLastId })));
      if (!r.ok) return;
      lines = (await r.json()).filter(l => l.id > lgLastId);
      if (!lines.length) return;
      lgRows.push(...lines);
      lgLastId = Math.max(lgLastId, ...lines.map(l => l.id));
      lgAppendRows(lines, 'end');
      lgTrimLive();
      lgPaintChrome();
    }
    if (document.getElementById('lgScroll').checked) box.scrollTop = box.scrollHeight;
  } catch (e) {
    document.getElementById('lgStatus').innerHTML = '<span style="color:var(--red)">Error: ' + esc(e.message) + '</span>';
  } finally {
    box.classList.remove('is-loading');
  }
}

async function loadOlderLogs() {
  if (!lgFirstId) return;
  const chunk = parseInt(document.getElementById('lgLimit').value) || 1000;
  const box = document.getElementById('lgBox');
  try {
    const r = await fetch('/api/logs?' + qsObj(lgFilterParams({ limit: chunk, before_id: lgFirstId })));
    if (!r.ok) return;
    const lines = (await r.json()).reverse();
    if (!lines.length) {
      document.getElementById('lgStatus').textContent = 'no older logs';
      return;
    }
    const prevH = box.scrollHeight;
    lgRows.unshift(...lines);
    lgFirstId = lines[0].id;
    lgAppendRows(lines, 'start');
    lgPaintChrome();
    box.scrollTop = box.scrollHeight - prevH;
  } catch (e) { /* ignore */ }
}

function lgClearFilters() {
  ['lgService', 'lgLevel', 'lgSearch', 'lgFrom', 'lgTo', 'lgStrategy',
    'lgContract', 'lgAccount', 'lgExchange'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  loadLogsX(true);
}

function lgShowPeek(id, source) {
  if (lgView === 'raw') return;
  source = source || lgPeekSrc || 'data';
  lgPeekSrc = source;
  lgPeekId = id;
  const rows = lgLogRows(source);
  const row = rows.find(r => r.id === id);
  const peek = lgPeekEl(source);
  const box = lgBoxEl(source);
  document.querySelectorAll('#lgBox tbody tr, #rpnlLogsBox tbody tr').forEach(tr => {
    tr.classList.toggle('selected', source === (tr.closest('#rpnlLogsBox') ? 'rpnl' : 'data') && Number(tr.dataset.id) === id);
  });
  if (!peek) return;
  const other = lgPeekEl(source === 'rpnl' ? 'data' : 'rpnl');
  if (other) other.hidden = true;
  if (!row) { peek.hidden = true; return; }
  const p = lgParsed(row);
  const fields = [
    ['id', row.id],
    ['time', fmtISTs(row.time)],
    ['level', row.level],
    ['kind', p.kind],
    ['service', row.service],
    ['strategy', row.strategy],
    ['account', row.account],
    ['contract', row.contract],
    ['exchange', row.exchange],
    ['logger', row.name],
    ['bid', p.bid],
    ['ask', p.ask],
    ['hook', p.hook],
    ['spread', p.spread],
    ['pos', p.pos],
    ['hem', p.hem],
    ['span', p.span],
    ['step', p.step],
    ['cap', p.cap],
    ['buy', p.buy],
    ['sell', p.sell],
    ['side', p.side],
    ['qty', p.qty],
    ['price', p.px],
    ['rpnl', p.rpnl],
    ['http', p.http],
    ['detail', p.detail],
    ['raw', row.message],
  ].filter(([, v]) => v != null && String(v).trim() !== '');
  const idx = rows.findIndex(r => r.id === id);
  peek.hidden = false;
  peek.innerHTML =
    '<div class="peek-h"><span>Row ' + (idx + 1) + ' of ' + fmtCount(rows.length) +
      ' · ↑↓ to move · Esc to close</span>' +
      '<span class="peek-acts">' +
        '<button class="btn" type="button" onclick="lgCopyPeek()">Copy</button>' +
        '<button class="btn" type="button" onclick="lgClosePeek()">Close</button>' +
      '</span></div>' +
    fields.map(([k, v]) =>
      '<div class="peek-row"><span class="pk">' + esc(k) + '</span><span class="pv">' +
      esc(v == null || v === '' ? '—' : String(v)) + '</span></div>'
    ).join('');
  peek.scrollTop = 0;
  const tr = box && box.querySelector('tr[data-id="' + id + '"]');
  if (tr) tr.scrollIntoView({ block: 'nearest' });
}
function lgClosePeek() {
  lgPeekId = 0;
  const dataPeek = document.getElementById('lgPeek');
  const rpnlPeek = document.getElementById('rpnlLgPeek');
  if (dataPeek) dataPeek.hidden = true;
  if (rpnlPeek) rpnlPeek.hidden = true;
  document.querySelectorAll('#lgBox tbody tr.selected, #rpnlLogsBox tbody tr.selected').forEach(tr => {
    tr.classList.remove('selected');
  });
}
async function lgCopyPeek() {
  const row = lgLogRows(lgPeekSrc).find(r => r.id === lgPeekId);
  if (!row) return;
  const p = lgParsed(row);
  const text = [
    ['id', row.id],
    ['time', fmtISTs(row.time)],
    ['level', row.level],
    ['kind', p.kind],
    ['strategy', row.strategy],
    ['contract', row.contract],
    ['account', row.account],
    ['bid', p.bid],
    ['ask', p.ask],
    ['hook', p.hook],
    ['pos', p.pos],
    ['buy', p.buy],
    ['sell', p.sell],
    ['side', p.side],
    ['qty', p.qty],
    ['price', p.px],
    ['http', p.http],
    ['detail', p.detail],
    ['raw', row.message],
  ].filter(([, v]) => v != null && String(v).trim() !== '')
    .map(([k, v]) => k + ': ' + v).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied row', 'ok');
  } catch { toast('Clipboard blocked', 'err'); }
}
function lgOnKey(ev) {
  if (ev.key === 'Escape' && lgPeekId) {
    lgClosePeek();
    ev.preventDefault();
    return;
  }
  if (lgView === 'raw') return;
  const dataPage = document.getElementById('data');
  const rpnlPage = document.getElementById('rpnl');
  let source = null;
  if (dataPage && dataPage.classList.contains('visible') && dataTab === 'logs') source = 'data';
  else if (rpnlPage && rpnlPage.classList.contains('visible') &&
      typeof rpnlLogsOpen === 'function' && rpnlLogsOpen() && rpnlKind === 'logs') source = 'rpnl';
  if (!source) return;
  const rows = lgLogRows(source);
  if (!rows.length) return;
  const idx = rows.findIndex(r => r.id === lgPeekId && source === lgPeekSrc);
  if (ev.key === 'ArrowDown' || ev.key === 'j') {
    ev.preventDefault();
    const next = idx < 0 ? 0 : Math.min(rows.length - 1, idx + 1);
    lgShowPeek(rows[next].id, source);
  } else if (ev.key === 'ArrowUp' || ev.key === 'k') {
    ev.preventDefault();
    const next = idx < 0 ? rows.length - 1 : Math.max(0, idx - 1);
    lgShowPeek(rows[next].id, source);
  }
}

async function copyLogsPage() {
  if (!lgRows.length) return;
  let text;
  if (lgView === 'raw') {
    text = lgRows.map(l => {
      const bits = [fmtISTs(l.time), '[' + (l.service || '') + ']', l.level,
        l.strategy, l.contract, l.account, fmtLogName(l.name), l.message]
        .filter(v => v != null && String(v).trim() !== '');
      return bits.join(' ');
    }).join('\n');
  } else {
    const cols = lgVisibleCols();
    const header = cols.map(c => c.label).join('\t');
    text = [header].concat(lgRows.map(l => cols.map(c => {
      return lgCellText(l, c.key).replace(/\t/g, ' ').replace(/\n/g, ' ');
    }).join('\t'))).join('\n');
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied ' + lgRows.length + (lgView === 'raw' ? ' lines' : ' rows'), 'ok');
  } catch {
    toast('Clipboard blocked', 'err');
  }
}

async function exportLogsCsv() {
  document.getElementById('lgStatus').textContent = 'Exporting…';
  try {
    await downloadNamedCsv('/api/logs/export?' + qsObj(lgFilterParams({ limit: 50000 })), 'logs.csv');
    document.getElementById('lgStatus').textContent = 'Exported logs';
  } catch (e) {
    document.getElementById('lgStatus').innerHTML = '<span style="color:var(--red)">Export: ' + esc(e.message) + '</span>';
  }
}

function setupLgAuto() {
  clearInterval(lgTimer);
  if (document.getElementById('lgAuto').checked && dataTab === 'logs') lgTimer = setInterval(() => loadLogsX(false), 3000);
}

bindDataKeys();
lgSyncViewButtons();
