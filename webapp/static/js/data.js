// ══════════════════════════════════════════════════════════
// Data page — fills / logs / tables / summary
// ══════════════════════════════════════════════════════════
const LS_DATA_TAB = 'opadash.dataTab';
const LS_DBT_COMPACT = 'opadash.dbtCompact';

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

function initData() {
  const compact = document.getElementById('dbtCompact');
  if (compact) compact.checked = lsGet(LS_DBT_COMPACT, '1') === '1';
  const tab = lsGet(LS_DATA_TAB, 'fills');
  showDataTab(['fills', 'logs', 'tables', 'rsum'].includes(tab) ? tab : 'fills');
  if (!window._dbtKeysBound) {
    window._dbtKeysBound = true;
    document.addEventListener('keydown', dbtOnKey);
  }
}

function showDataTab(name) {
  if (!['fills', 'logs', 'tables', 'rsum'].includes(name)) name = 'fills';
  dataTab = name;
  lsSet(LS_DATA_TAB, name);
  const root = document.getElementById('data');
  if (root) root.classList.toggle('fills-mode', name === 'fills');
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
  if (name === 'logs') { loadLogsX(true); setupLgAuto(); }
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
  const page = document.getElementById('data');
  if (!page || !page.classList.contains('visible')) return;
  if (dataTab !== 'fills' && dataTab !== 'tables') return;
  const tag = (ev.target && ev.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
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
let lgLastId = 0;
let lgFirstId = 0;

function lgMeta(l) {
  const bits = [l.strategy, l.contract, l.account, l.exchange].filter(Boolean);
  if (!bits.length) return '';
  return bits.map(b => '<span class="lchip">' + esc(b) + '</span>').join('');
}
function lgRenderLine(l) {
  const lv = String(l.level || '').trim();
  return '<div class="log-line"><span class="lt">' + fmtISTs(l.time) + '</span> ' +
    '<span class="lsvc">[' + esc(l.service) + ']</span> ' +
    '<span class="' + logLevelCls(lv) + '">' + esc(lv) + '</span> ' +
    lgMeta(l) +
    '<span style="color:#6b768e">' + esc(fmtLogName(l.name)) + '</span> ' + esc(l.message) + '</div>';
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

async function loadLogsX(reset) {
  const initLim = parseInt(document.getElementById('lgLimit').value) || 1000;
  const box = document.getElementById('lgBox');
  try {
    let lines;
    if (reset || !lgLastId) {
      const r = await fetch('/api/logs?' + qsObj(lgFilterParams({ limit: initLim })));
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
      lines = (await r.json()).reverse();
      box.innerHTML = '';
      lgFirstId = lines.length ? lines[0].id : 0;
    } else {
      const r = await fetch('/api/logs?' + qsObj(lgFilterParams({ limit: 500, after_id: lgLastId })));
      if (!r.ok) return;
      lines = await r.json();
      if (!lines.length) return;
    }
    if (!lines.length) {
      box.innerHTML = '<div class="tbl-empty">No logs yet. Redeploy the bot service to start streaming them here.</div>';
      lgLastId = 0;
      return;
    }
    box.insertAdjacentHTML('beforeend', lines.map(lgRenderLine).join(''));
    lgLastId = Math.max(lgLastId, ...lines.map(l => l.id));
    while (box.children.length > 8000) box.removeChild(box.firstChild);
    if (document.getElementById('lgScroll').checked) box.scrollTop = box.scrollHeight;
    document.getElementById('lgStatus').textContent = box.children.length + ' shown · last id ' + lgLastId;
  } catch (e) {
    document.getElementById('lgStatus').innerHTML = '<span style="color:var(--red)">Error: ' + esc(e.message) + '</span>';
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
    if (!lines.length) { document.getElementById('lgStatus').textContent = 'no older logs'; return; }
    const prevH = box.scrollHeight;
    box.insertAdjacentHTML('afterbegin', lines.map(lgRenderLine).join(''));
    lgFirstId = lines[0].id;
    box.scrollTop = box.scrollHeight - prevH;
    document.getElementById('lgStatus').textContent = box.children.length + ' shown · from id ' + lgFirstId;
  } catch (e) { /* ignore */ }
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
