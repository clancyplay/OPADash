// rPnL symbol list — fetched from DB fills table
const rpnlScope = { selected: loadScopeSet('rpnl'), expanded: new Set(), groups: [] };
const LS_RPNL_LIVE_ONLY = 'opadash.rpnlLiveOnly';
const LS_RPNL_HIDE_STOPPED = 'opadash.rpnlHideStopped';
let rpnlLiveOnly = (typeof lsGet === 'function' ? lsGet(LS_RPNL_LIVE_ONLY, '1') : '1') !== '0';
let rpnlHideStopped = (typeof lsGet === 'function' ? lsGet(LS_RPNL_HIDE_STOPPED, '0') : '0') === '1';

function rpnlIsLiveRow(r) {
  return !!(r && (r.live || rpnlIsBooting(r)));
}
function rpnlScopeMatch(row) {
  const venues = [row.quote_venue, row.hedge_venue, row.exchange]
    .map(v => String(v || '').toLowerCase()).filter(Boolean);
  return scopeMatch(rpnlScope, venues, row.account);
}
function rpnlIsStoppedRunning(r) {
  if (!r || !r.live || rpnlIsPairHedge(r)) return false;
  return rpnlDashStatus(r.settings).key === 'stopped';
}
function rpnlWithoutStopped(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!rpnlHideStopped) return list;
  return list.filter(r => !rpnlIsStoppedRunning(r));
}
function rpnlApplyFilter(rows) {
  let out = (Array.isArray(rows) ? rows : []).filter(rpnlScopeMatch);
  if (rpnlLiveOnly) out = out.filter(rpnlIsLiveRow);
  if (rpnlHideStopped) out = out.filter(r => !rpnlIsStoppedRunning(r));
  return out;
}
function rpnlEmptyFilterMsg() {
  if (rpnlHideStopped && rpnlLiveOnly) {
    return 'No running bots left in this window. Turn off Hide stopped or Live only in Filters.';
  }
  if (rpnlHideStopped) return 'Stopped bots are hidden. Turn off Hide stopped in Filters to see them.';
  if (rpnlLiveOnly) return 'No live bots in this window. Turn off Live only in Filters to see the rest.';
  return 'No live bots or fills in this window.';
}
// Build exchange→accounts tree from the unfiltered symbol rows.
function rpnlScopeGroups(rows) {
  const pairs = [];
  (Array.isArray(rows) ? rows : []).forEach(r => {
    const acct = String(r.account || '');
    if (!acct) return;
    const name = r.account_name || acct;
    const qv = String(r.quote_venue || '').toLowerCase();
    if (qv) pairs.push({ ex: qv, label: r.quote_label || qv, account: acct, accName: name });
    const hv = String(r.hedge_venue || '').toLowerCase();
    if (hv && r.has_hedge) pairs.push({ ex: hv, label: r.hedge_label || hv, account: acct, accName: name });
    const ex = String(r.exchange || '').toLowerCase();
    if (ex) pairs.push({ ex, label: ex, account: acct, accName: name });
  });
  return scopeGroupsFrom(pairs);
}
function rpnlSyncFilterUI() {
  rpnlScope.groups = rpnlScopeGroups(rpnlSymbolRows);
  // Drop stale selections no longer present in the current view.
  const live = new Set();
  rpnlScope.groups.forEach(g => g.accounts.forEach(a => live.add(scopeKey(g.ex, a.id))));
  [...rpnlScope.selected].forEach(k => { if (!live.has(k)) rpnlScope.selected.delete(k); });
  const stratN = strategyIsAll(currentStrategy) ? 0 : 1;
  // Live-only is the default view — only badge when the user turns it off
  // (showing historical too) or when strategy/accounts are narrowed.
  const liveN = rpnlLiveOnly ? 0 : 1;
  const hideN = rpnlHideStopped ? 1 : 0;
  setFilterBadge('rpnlFilterBtn', stratN + liveN + hideN + rpnlScope.selected.size);
}
// Account/exchange is a client-side filter, so just re-render from cached rows.
function rpnlScopeApply() {
  saveScopeSet('rpnl', rpnlScope.selected);
  rpnlSyncFilterUI();
  rpnlRenderSymbolOptions();
  if (rpnlReady) loadRpnlFresh();
}
function setRpnlLiveOnly(on) {
  rpnlLiveOnly = !!on;
  if (typeof lsSet === 'function') lsSet(LS_RPNL_LIVE_ONLY, rpnlLiveOnly ? '1' : '0');
  rpnlSyncFilterUI();
  rpnlRenderSymbolOptions();
  if (rpnlReady && typeof loadRpnlFresh === 'function') loadRpnlFresh();
}
function setRpnlHideStopped(on) {
  rpnlHideStopped = !!on;
  if (typeof lsSet === 'function') lsSet(LS_RPNL_HIDE_STOPPED, rpnlHideStopped ? '1' : '0');
  rpnlSyncFilterUI();
  rpnlRenderSymbolOptions();
  if (rpnlReady && typeof loadRpnlFresh === 'function') loadRpnlFresh();
}
function openRpnlFilters() {
  closeOhlcTools();
  openFilterModal({
    title: 'rPnL filters',
    scope: rpnlScope,
    refresh: rpnlSyncFilterUI,
    apply: rpnlScopeApply,
    showLiveOnly: true,
    liveOnly: rpnlLiveOnly,
    onLiveOnly: setRpnlLiveOnly,
    showHideStopped: true,
    hideStopped: rpnlHideStopped,
    onHideStopped: setRpnlHideStopped,
  });
}
let rpnlSymbolRows = [];
function rpnlRenderSymbolOptions() {
  const sel = document.getElementById('rpnlSymbol');
  if (!sel) return;
  const list = rpnlApplyFilter(rpnlSymbolRows);
  if (list.length === 0) {
    sel.innerHTML = '<option value="">No data in DB</option>';
    return;
  }
  const keep = sel.value;
  list.sort((a, b) => rpnlRowRank(a) - rpnlRowRank(b));
  sel.innerHTML = list.map(c =>
    '<option value="' + escHtml(rpnlOptionValue(c)) + '">' +
      escHtml(rpnlSelMark(c) + (c.label || c.contract)) + '</option>'
  ).join('');
  if (keep && [...sel.options].some(o => o.value === keep)) sel.value = keep;
  else {
    const hit = keep && [...sel.options].find(o => rpnlSelMatch(o.value, keep));
    if (hit) sel.value = hit.value;
  }
}
async function fetchRpnlSymbols() {
  try {
    const r = await fetch(withStrategy('/api/rpnl/symbols'));
    const rows = await r.json();
    rpnlSymbolRows = (Array.isArray(rows) ? rows : []).map(c => typeof c === 'string'
      ? { contract: c, account: '', label: c }
      : c);
    rpnlSyncFilterUI();
    rpnlRenderSymbolOptions();
  } catch {
    const sel = document.getElementById('rpnlSymbol');
    if (sel) sel.innerHTML = '<option value="">Error</option>';
  }
}


function rpnlBootLabel(r) {
  const d = String((r && r.deploy) || '').trim().toLowerCase();
  if (d === 'building') return 'Building';
  if (d === 'deploying') return 'Deploying';
  if (d === 'starting') return 'Starting';
  if (d === 'queued') return 'Queued';
  return d ? d.charAt(0).toUpperCase() + d.slice(1) : '';
}
function rpnlIsBooting(r) {
  return !!(r && r.deploy && !r.live);
}
function rpnlRowRank(r) {
  if (rpnlIsBooting(r)) return 0;
  if (r && r.live) return rpnlIsStoppedRunning(r) ? 2 : 1;
  if (r && r.removed) return 3;
  return 4;
}
function rpnlSelMark(c) {
  if (c && c.live) return '● ';
  if (rpnlIsBooting(c)) return '◌ ';
  return '';
}
function rpnlOptionValue(r) {
  return (r.contract || '') + '::' + (r.account || '') + '::' + (r.strategy || '');
}
function parseRpnlSel(v) {
  const parts = String(v || '').split('::');
  return {
    contract: parts[0] || '',
    account: parts[1] || '',
    strategy: parts.slice(2).join('::') || '',
  };
}
function rpnlSelMatch(a, b) {
  const x = parseRpnlSel(a), y = parseRpnlSel(b);
  if (x.contract !== y.contract || x.account !== y.account) return false;
  if (!x.strategy || !y.strategy) return true;
  return x.strategy === y.strategy;
}
function currentRpnlSel() {
  return parseRpnlSel((document.getElementById('rpnlSymbol') || {}).value || '');
}
function rpnlAccountLabel(r) {
  const name = String((r && r.account_name) || '').trim();
  const id = String((r && r.account) || '').trim();
  if (name && name !== id) return name;
  return name || id;
}
// The user's pick is kept separately from the <select>, so switching to an
// unhedged contract can show 'quote' without losing the preference.
let rpnlVenuePref = 'both';
function onRpnlVenueChange() {
  const sel = document.getElementById('rpnlVenue');
  rpnlVenuePref = (sel && sel.value) || 'both';
  loadRpnlFresh();
}
// What we ask the server for — always the raw preference, since whether a
// contract has a hedge is only known from the response.
function rpnlVenueParam() {
  return rpnlVenuePref;
}
// What we draw: 'both' | 'quote' | 'hedge', collapsed for unhedged contracts.
function currentRpnlVenue() {
  return rpnlMeta.has_hedge ? rpnlVenuePref : 'quote';
}
function updateRpnlPaneLabels() {
  const sel = currentRpnlSel();
  const venue = currentRpnlVenue();
  const qlab = rpnlMeta.quote_label || 'Delta';
  const hlab = rpnlMeta.hedge_label || 'Hedge';
  const qsym = rpnlMeta.quote_symbol || sel.contract || '';
  const venueLab = rpnlMeta.has_hedge
    ? (venue === 'hedge' ? hlab : (venue === 'quote' ? qlab : qlab + ' + ' + hlab))
    : '';
  const ivl = (document.getElementById('rpnlCandle') || {}).value || '5m';
  const title = document.getElementById('ohlcHudTitle');
  if (title) title.textContent = (qsym || 'Price') + (qlab ? ' · ' + qlab : '') + ' · ' + ivl;
  const lab = document.getElementById('rpnlPaneLabel');
  if (lab) lab.textContent = (rpnlView === 'cumul' ? 'Cumulative rPnL ₹' : 'Per-bucket rPnL ₹') + (venueLab ? ' · ' + venueLab : '');
}


// rPnL Chart
let rpnlChart, rpnlSeries, rpnlHistSeries, rpnlHedgeSeries, rpnlNetSeries, rpnlTimer;
let rpnlRangePinned = false;
let rpnlSelectMode = false;
let rpnlPinFrom = null;
let rpnlPinTo = null;
let rpnlSelDrag = null;
let ohlcChart, ohlcSeries, ohlcHedgeMarkerSeries, ohlcVolSeries;
let ohlcBarSeries, ohlcLineSeries, ohlcAreaSeries, ohlcQuoteMarkerSeries;
let ohlcMaSeries = { 7: null, 25: null, 99: null };
let ohlcMaCache = { 7: [], 25: [], 99: [] };
let ohlcOrderLines = [];
let ohlcOrderSig = '';
let ohlcOrderOwner = null;
let ohlcOrderScaleSeries = null;
let riOrdersOpen = false;
let riSetupOpen = false;
let ohlcHiLine = null, ohlcLoLine = null, ohlcHiLoOwner = null;
let ohlcMarkerSig = '';
let rpnlMarkerSig = '';
let ohlcHoverTime = null;
let ohlcStyle = 'candle';
let ohlcMaOn = { 7: true, 25: true, 99: false };
let ohlcShowVol = true;
let ohlcShowFills = true;
let ohlcLogScale = false;
let ohlcShowHiLo = false;
let rpnlAutoY = true;
const OHLC_MA = [
  { p: 7, color: '#f5d76e' },
  { p: 25, color: '#42a5f5' },
  { p: 99, color: '#ab47bc' },
];
const LS_OHLC_STYLE = 'opadash.ohlcStyle';
const LS_OHLC_MA = 'opadash.ohlcMa';
const LS_OHLC_VOL = 'opadash.ohlcVol';
const LS_OHLC_FILLS = 'opadash.ohlcFills';
const LS_OHLC_LOG = 'opadash.ohlcLog';
const LS_OHLC_HILO = 'opadash.ohlcHiLo';
let rpnlSummaryCache = [];
let rpnlPairHedge = {};
let rpnlLoadSeq = 0;
let rpnlQuoteTimer = null;
let rpnlLoadBusy = false;
let rpnlNeedsFit = false;
let rpnlFitTimer = 0;
let rpnlHoldSnap = null;
let rpnlLastSize = { ow: 0, oh: 0, rw: 0, rh: 0 };
let rpnlLogsLastId = 0;
let rpnlLogsFirstId = 0;
let rpnlLogsBusy = false;
let rpnlLogsOlderBusy = false;
let rpnlLogsNoOlder = false;
let rpnlLogRows = [];
let rpnlKind = 'logs';
let rpnlKindBusy = false;
let rpnlKindOffset = 0;
let rpnlKindTotal = 0;
let rpnlKindNoMore = false;
let rpnlKindCols = [];
let rpnlKindRows = [];
let rpnlFillLiveAt = 0;
let rpnlFillSel = new Set();
let rpnlFillAnchor = -1;
let rpnlView         = 'cumul';
let rpnlDrawnView    = '';
let rpnlPtsCache     = [];
let rpnlHedgeCache   = [];
let ohlcBarsCache    = [];
let rpnlFillsCache   = [];
let rpnlCurrentHours = null;
let rpnlLoadingMore  = false;
let rpnlSyncing      = false;
let rpnlSyncGen      = 0;
let rpnlSyncOrigin   = null;
let rpnlSyncPrefer   = 'ohlc';
let rpnlAlignTimer   = 0;
let rpnlLastPush     = { from: NaN, to: NaN, origin: '' };
let rpnlXhSyncing    = false;
let rpnlMeta = {
  quote_venue: 'delta', quote_label: 'Delta', quote_symbol: '',
  hedge_venue: '', hedge_label: '', hedge_symbol: '', has_hedge: false,
};

function rpnlVenueClass(v) {
  v = (v || 'delta').toLowerCase();
  if (v === 'binance') return 'binance';
  if (v === 'kucoin') return 'kucoin';
  if (v === 'coindcx') return 'coindcx';
  if (v === 'aster') return 'aster';
  if (v === 'bybit') return 'bybit';
  if (v === 'coinbase') return 'coinbase';
  return 'delta';
}

function inrFmt(n) {
  const v = Number(n) || 0;
  const sign = v < 0 ? '−' : '';
  return sign + '₹' + Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

function inrFmtDec(n, d) {
  const v = Number(n) || 0;
  const sign = v < 0 ? '−' : '+';
  return sign + '₹' + Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fmtPct(frac) {
  const p = Number(frac) * 100;
  if (!isFinite(p)) return '';
  if (Math.abs(p) < 0.01) return p.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') + '%';
  if (Math.abs(p) < 1) return p.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + '%';
  return p.toFixed(1).replace(/\.0$/, '') + '%';
}

function fmtG(v) {
  const n = Number(v);
  if (!isFinite(n)) return String(v);
  if (Number.isInteger(n)) return String(n);
  return String(parseFloat(n.toPrecision(6)));
}

/** Full order/candle price for axis + line labels — do not chop tick decimals. */
function fmtPxFull(v) {
  const n = Number(v);
  if (!isFinite(n)) return String(v ?? '');
  const a = Math.abs(n);
  const s = n < 0 ? '−' : '';
  let d;
  if (a >= 1000) d = 2;
  else if (a >= 100) d = 3;
  else if (a >= 1) d = 4;
  else if (a >= 0.01) d = 6;
  else d = 8;
  let out = a.toFixed(d);
  if (out.indexOf('.') >= 0) out = out.replace(/0+$/, '').replace(/\.$/, '');
  return s + out;
}

function rpnlPillIssue(mode) {
  const m = String(mode || '').trim().toLowerCase();
  if (!m || m === 'quoting') return false;
  if (/bid\s*\+|ask\s*[-−]/.test(m)) return false;
  return true;
}

function rpnlDashStatus(s) {
  if (!s) return { key: '', label: '', tone: '' };
  const mode = String(s.mode || '').trim().toLowerCase();
  const held = s.hold === true || s.hold === 1 || s.hold === 'true' || s.hold === '1';
  if (mode === 'flattening') return { key: 'flattening', label: 'Closing', tone: 'bad' };
  if (held || mode === 'stopped') return { key: 'stopped', label: 'Stopped', tone: 'stop' };
  return { key: '', label: '', tone: '' };
}

function rpnlStatusLabel(mode) {
  const m = String(mode || '').trim().toLowerCase();
  if (m === 'stopped') return 'Stopped';
  if (m === 'flattening') return 'Closing';
  if (m === 'paused') return 'Paused';
  if (m === 'waiting') return 'Waiting';
  if (m === 'stale') return 'Stale book';
  if (m === 'rest') return 'Rest';
  if (m === 'no-volume') return 'Quiet';
  if (m === 'fill-pause') return 'Fill pause';
  if (m === 'grind-cover') return 'Cover';
  if (m === 'trend-cover') return 'Trend cover';
  if (m === 'size-cool') return 'Size cool';
  if (m === 'clock-closed') return 'Clock';
  if (m === 'wind-down') return 'Wind-down';
  if (m === 'open-delay') return 'Open delay';
  if (m === 'day-stop') return 'Day stop';
  if (m === 'hold-stop') return 'Max hold';
  if (m === 'cover') return 'Cover';
  return String(mode || '').trim();
}

function rpnlModeText(s, brief) {
  if (!s) return '';
  if (s.pair_hedge === true || s.pair_hedge === 'true' || s.pair_hedge === 1 ||
      String(s.role || '').toLowerCase() === 'hedge' || String(s.mode || '').toLowerCase() === 'hedge') {
    return '';
  }
  const dash = rpnlDashStatus(s);
  if (dash.label) return dash.label;
  const mode = String(s.mode || '').trim();
  const why = String(s.mode_why || '').trim();
  let left = Number(s.pause_left);
  if (!isFinite(left)) left = 0;
  let rest = Number(s.rest_left);
  if (!isFinite(rest)) rest = 0;
  const size = s.size_pct == null ? NaN : Number(s.size_pct);
  const skipWhy = brief && (!!s.trip_why || !!s.probing);
  const show = mode && mode !== 'quoting' && (!brief || rpnlPillIssue(mode));
  if (show) {
    let t = rpnlStatusLabel(mode);
    if (left > 0) t += ' ' + Math.round(left) + 's';
    else if (rest > 0) t += ' ' + Math.round(rest) + 's';
    if (why && !skipWhy && !/^dash stop$/i.test(why)) t += ' · ' + why;
    if (isFinite(size) && size < 99.5 && mode !== 'size-cool') t += ' · size ' + fmtG(size) + '%';
    return t;
  }
  if (isFinite(size) && size < 99.5) return 'size ' + fmtG(size) + '%';
  return '';
}

function fmtWinSecs(s) {
  const n = Number(s);
  if (!isFinite(n) || n <= 0) return '';
  if (n >= 3600 && n % 3600 === 0) return (n / 3600) + 'h';
  if (n >= 60 && n % 60 === 0) return (n / 60) + 'm';
  if (n >= 60) return Math.round(n / 60) + 'm';
  return Math.round(n) + 's';
}

function fmtUsdSigned(v) {
  const n = Number(v);
  if (!isFinite(n)) return '—';
  const abs = Math.abs(n);
  const body = abs >= 10 ? abs.toFixed(1) : abs.toFixed(2);
  return (n >= 0 ? '+$' : '−$') + body.replace(/\.0$/, '');
}

function rpnlTapeChip(label, usd, secs, title) {
  const n = Number(usd);
  const cls = !isFinite(n) || Math.abs(n) < 1e-9 ? '' : (n < 0 ? ' short' : ' long');
  const win = fmtWinSecs(secs);
  const t = escHtml(label + (win ? ' ' + win : '') + ' ' + fmtUsdSigned(n));
  const tip = title ? ' title="' + escHtml(title) + '"' : '';
  return '<span class="ri-chip tape' + cls + '"' + tip + '>' + t + '</span>';
}

function rpnlTapeHtml(s) {
  if (!s) return '';
  const bits = [];
  if (s.win_rpnl != null && s.win_secs != null) {
    const probe = !!s.probing;
    const floor = s.grind != null ? Number(s.grind) : NaN;
    const title = probe
      ? 'pause-probe rolling rPnL (tape cleared on flatten)'
      : ('grind window' + (isFinite(floor) && floor > 0 ? ' · red still quotes · flatten ≤ −$' + fmtG(floor) : ''));
    bits.push(rpnlTapeChip(probe ? 'probe' : 'win', s.win_rpnl, s.win_secs, title));
  }
  if (s.burst_rpnl != null && s.burst_secs != null) {
    const floor = s.fate != null ? Number(s.fate) : NaN;
    const title = 'FATE burst' + (isFinite(floor) && floor > 0 ? ' · trip ≤ −$' + fmtG(floor) : '');
    bits.push(rpnlTapeChip('burst', s.burst_rpnl, s.burst_secs, title));
  }
  return bits.join('');
}

function rpnlMark(ok, bad) {
  if (bad) return '<span class="bad">trip</span>';
  return ok ? '<span class="ok">ok</span>' : '<span class="wait">wait</span>';
}

function rpnlPrettyTrip(raw, floor) {
  const m = String(raw || '');
  const need = (isFinite(floor) && floor > 0) ? '  (need $' + fmtG(floor) + ')' : '';
  let hit = m.match(/FATE\s+peak=([-\d.]+)\s+burst=([-\d.]+)/i);
  if (hit) return 'FATE  peak ' + fmtUsdSigned(hit[1]) + '  burst ' + fmtUsdSigned(hit[2]) + need;
  hit = m.match(/FATE\s+peak=([-\d.]+)\s+giveback=([-\d.]+)/i);
  if (hit) {
    return 'FATE  peak ' + fmtUsdSigned(hit[1]) +
      '  gave back $' + fmtG(Math.abs(Number(hit[2]))) + need;
  }
  hit = m.match(/GRIND\s+([\d.]+)s=([-\d.]+)/i);
  if (hit) return 'GRIND  ' + (fmtWinSecs(hit[1]) || (hit[1] + 's')) + ' ' + fmtUsdSigned(hit[2]) + need;
  return m;
}

function rpnlFateHtml(s, live) {
  const floor = Number(s.fate);
  if (!isFinite(floor) || floor <= 0) return '';
  const win = fmtWinSecs(s.fate_window) || '';
  const burstWin = fmtWinSecs(s.burst_secs || s.fate_burst) || '';
  if (!live) {
    const mult = s.fate_mult != null ? Number(s.fate_mult) : NaN;
    let t = 'flatten when burst/giveback ≥ $' + fmtG(floor);
    if (isFinite(mult) && mult > 0) t += ' or ' + fmtG(mult) + '× peak';
    if (win) t += ' · ' + win;
    if (burstWin) t += ' burst ' + burstWin;
    return '<div class="ri-gate"><b>FATE</b> ' + escHtml(t) + '</div>';
  }
  const peak = Number(s.fate_peak);
  const nowv = Number(s.fate_now);
  const burstN = Number(s.burst_rpnl);
  const bNeed = Number(s.fate_burst_need);
  const dNeed = Number(s.fate_dd_need);
  const dd = Number(s.fate_dd);
  const bits = [];
  if (win) bits.push(win);
  if (isFinite(peak)) bits.push('peak ' + fmtUsdSigned(peak));
  if (isFinite(nowv)) bits.push('now ' + fmtUsdSigned(nowv));
  if (isFinite(burstN)) bits.push('burst' + (burstWin ? ' ' + burstWin : '') + ' ' + fmtUsdSigned(burstN));
  const trips = [];
  if (isFinite(bNeed) && bNeed > 0) trips.push('burst ≤ −$' + fmtG(bNeed));
  if (isFinite(dNeed) && dNeed > 0) trips.push('giveback ≥ $' + fmtG(dNeed));
  if (trips.length) bits.push('trip ' + trips.join(' / '));
  const burstTrip = isFinite(burstN) && isFinite(bNeed) && bNeed > 0 && burstN <= -bNeed + 1e-9;
  const ddTrip = isFinite(dd) && isFinite(dNeed) && dNeed > 0 && dd >= dNeed - 1e-9;
  return '<div class="ri-gate"><b>FATE</b> ' + escHtml(bits.join('  ')) + ' ' + rpnlMark(!(burstTrip || ddTrip), burstTrip || ddTrip) + '</div>';
}

function rpnlGrindHtml(s, live) {
  const floor = Number(s.grind);
  if (!isFinite(floor) || floor <= 0) return '';
  const win = fmtWinSecs(s.grind_secs || s.grind_window) || '';
  if (!live) {
    let t = 'flatten at ≤ −$' + fmtG(floor);
    if (win) t += ' over ' + win;
    t += ' · red quotes until then';
    return '<div class="ri-gate"><b>GRIND</b> ' + escHtml(t) + '</div>';
  }
  const g = s.grind_rpnl != null ? Number(s.grind_rpnl) : Number(s.win_rpnl);
  const bits = [];
  if (win) bits.push(win);
  if (isFinite(g)) bits.push(fmtUsdSigned(g));
  bits.push('flatten ≤ −$' + fmtG(floor));
  const trip = isFinite(g) && g <= -floor + 1e-9;
  return '<div class="ri-gate"><b>GRIND</b> ' + escHtml(bits.join('  ')) + ' ' + rpnlMark(!trip, trip) + '</div>';
}

function rpnlLater(ok) {
  if (ok) return '<span class="ok">ok</span>';
  return '<span class="then">after fills</span>';
}

function rpnlProbeHtml(s) {
  const need = Number(s.probe_need);
  const needBit = isFinite(need) && need > 0 ? fmtUsdSigned(need) : '';
  const clock = Number(s.pause_clock);
  const lockLeft = Number(s.probe_lock_left);
  const lockOk = s.probe_lock_ok != null ? !!s.probe_lock_ok : !(lockLeft > 0);
  const clockOk = !(clock > 0);
  const rpnlReady = !!s.probe_rpnl_ready;
  const nNeed = Number(s.probe_n_need);
  const nHave = Number(s.probe_n_have);
  const nSum = Number(s.probe_n_sum);
  const win = fmtWinSecs(s.win_secs || s.probe_window) || '5m';
  const noFills = !rpnlReady && (!isFinite(nHave) || nHave <= 0);
  const wait = noFills
    ? ('probe fills — ' + win + ' ≥ ' + (needBit || '+$0') + (nNeed > 0 ? (' or last ' + nNeed) : ''))
    : String(s.probe_hold || 'probe green');
  const rows = [];
  rows.push('<div class="ri-gate"><b>lift</b> now: ' + escHtml(wait) + '</div>');
  rows.push(
    '<div class="ri-gate sub">clock ' + escHtml(clock > 0 ? Math.round(clock) + 's' : 'done') +
    ' ' + rpnlMark(clockOk) +
    ' · lock ' + escHtml(lockLeft > 0 ? Math.round(lockLeft) + 's' : 'done') +
    ' ' + rpnlMark(lockOk) + '</div>'
  );
  const winRpnl = s.probe_win_rpnl != null ? Number(s.probe_win_rpnl) : Number(s.win_rpnl);
  let p = win + ' ' + (isFinite(winRpnl) ? fmtUsdSigned(winRpnl) : '—');
  if (needBit) p += ' / need ' + needBit;
  let last = '';
  if (nNeed > 0) {
    last = 'last ' + (isFinite(nHave) ? nHave : 0) + '/' + nNeed +
      (isFinite(nSum) ? ' ' + fmtUsdSigned(nSum) : '');
  }
  rows.push(
    '<div class="ri-gate sub">' + escHtml(p) + ' ' + rpnlMark(!!s.probe_win_ok) +
    (last ? ' · ' + escHtml(last) + ' ' + rpnlMark(!!s.probe_last_ok) : '') +
    ' · uPnL ' + escHtml(isFinite(Number(s.probe_upnl)) ? fmtUsdSigned(Number(s.probe_upnl)) : '—') +
    ' ' + rpnlMark(!!s.probe_upnl_ok) +
    '</div>'
  );
  const recSecs = fmtWinSecs(s.probe_recent_secs) || fmtWinSecs(s.probe_recent) || '';
  const rec = Number(s.probe_recent_rpnl);
  const recTxt = 'recent' + (recSecs ? ' ' + recSecs : '') + (isFinite(rec) ? ' ' + fmtUsdSigned(rec) : '');
  const recMark = rpnlReady
    ? rpnlMark(s.probe_recent_ok != null ? !!s.probe_recent_ok : true)
    : rpnlLater(s.probe_recent_ok != null ? !!s.probe_recent_ok : false);
  rows.push(
    '<div class="ri-gate sub">' + escHtml(recTxt) + ' ' + recMark +
    (s.probe_need_chop
      ? ' · chop ' + (rpnlReady ? rpnlMark(!!s.probe_chop_ok) : rpnlLater(!!s.probe_chop_ok))
      : '') +
    (rpnlReady && s.probe_trend_ok === false ? ' · trend ' + rpnlMark(false) : '') +
    '</div>'
  );
  return rows.join('');
}

function rpnlGatesHtml(s) {
  if (!s) return '';
  const paused = s.mode === 'paused' || s.mode === 'flattening' || !!s.probing;
  const rows = [];
  const trip = String(s.trip_why || '');
  if (paused && trip) {
    rows.push('<div class="ri-gate"><b>tripped</b> ' + escHtml(rpnlPrettyTrip(trip, Number(s.fate))) + '</div>');
  }
  if (s.probing) {
    rows.push(rpnlProbeHtml(s));
  } else if (paused) {
    const clock = Number(s.pause_clock || s.pause_left);
    if (clock > 0) {
      rows.push('<div class="ri-gate"><b>lift</b> now: clock ' + Math.round(clock) + 's ' + rpnlMark(false) + '</div>');
    }
  }
  if (!paused) {
    const fate = rpnlFateHtml(s, true);
    const grind = rpnlGrindHtml(s, true);
    if (fate) rows.push(fate);
    if (grind) rows.push(grind);
  }
  if (!rows.length) return '';
  return '<div class="ri-gates">' + rows.join('') + '</div>';
}

function sanitizeOhlcBar(b) {
  if (!b) return null;
  const o = Number(b.open), h = Number(b.high), l = Number(b.low), c = Number(b.close);
  if (![o, h, l, c].every(isFinite)) return null;
  const open = o > 0 ? o : c;
  const close = c > 0 ? c : o;
  if (!(open > 0) || !(close > 0)) return null;
  const high = Math.max(open, h, l, close);
  const low = Math.min(open, h, l, close);
  if (!(high > 0) || !(low > 0) || high < low) return null;
  const t = unixBarTime(b.time);
  if (t == null) return null;
  return { time: t, open, high, low, close, volume: Number(b.volume) || 0 };
}

function ohlcLastPx() {
  if (!ohlcBarsCache.length) return 0;
  const b = ohlcBarsCache[ohlcBarsCache.length - 1];
  const px = Number(b && (b.close != null ? b.close : b.value));
  return isFinite(px) && px > 0 ? px : 0;
}

function liveUsdInr(s) {
  const rate = Number(s && s.usdinr);
  return isFinite(rate) && rate > 0 ? rate : 85;
}

function liveVenueCv(s, venue) {
  const cv = Number(s && s.cv);
  if (isFinite(cv) && cv > 0) return cv;
  const v = String(venue || '').toLowerCase();
  if (v === 'aster' || v === 'binance' || v === 'kucoin' || v === 'bybit' ||
      v === 'coinbase' || v === 'coindcx') return 1;
  return 1;
}

function liveUpnlCapInr(s) {
  const rate = liveUsdInr(s);
  const wallet = Number(s && s.wallet_inr);
  const maxUsd = Number(s && s.max_usd);
  let cap = 0;
  if (isFinite(wallet) && wallet > 0) cap = Math.max(cap, wallet * 4);
  if (isFinite(maxUsd) && maxUsd > 0) cap = Math.max(cap, maxUsd * rate * 8);
  return cap;
}

function liveUpnlInr(s, venue) {
  if (!s) return null;
  const size = Number(s.pos);
  if (!isFinite(size) || !size) return null;
  const entry = Number(s.entry);
  const mark = Number(s.mark);
  const rate = liveUsdInr(s);
  const cv = liveVenueCv(s, venue);
  let computed = null;
  if (isFinite(entry) && entry > 0 && isFinite(mark) && mark > 0) {
    computed = size * (mark - entry) * rate * cv;
  }
  const reported = (s.upnl != null && s.upnl !== '') ? Number(s.upnl) : NaN;
  const cap = liveUpnlCapInr(s);
  const pick = function (v) {
    if (v == null || !isFinite(v)) return null;
    if (cap > 0 && Math.abs(v) > cap) return null;
    return v;
  };
  const fromBook = pick(computed);
  if (fromBook != null) return fromBook;
  if (isFinite(reported)) return pick(reported);
  return null;
}

function liveUpnlUsd(s, venue) {
  const u = liveUpnlInr(s, venue);
  if (u == null) return null;
  return u / liveUsdInr(s);
}

function usdFmtDec(n, d) {
  const v = Number(n) || 0;
  const sign = v < 0 ? '−' : '+';
  return sign + '$' + Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: d, maximumFractionDigits: d,
  });
}

function rpnlBaseUnit(sym) {
  let u = String(sym || '').toUpperCase().trim();
  if (!u) return '';
  if (u.startsWith('B-') && u.indexOf('_') >= 0) return u.slice(2).split('_')[0];
  const opt = u.match(/^[CP]-([A-Z0-9]+)/);
  if (opt) return opt[1];
  u = u.replace(/[-_]/g, '');
  const suffixes = ['USDTM', 'PERPINTX', 'PERP', 'USDT', 'USDC', 'USD', 'INR'];
  for (let i = 0; i < suffixes.length; i++) {
    const suf = suffixes[i];
    if (u.endsWith(suf) && u.length > suf.length) return u.slice(0, -suf.length);
  }
  return u;
}

function rpnlArbHtml(s) {
  if (!s || s.arb_pos == null || !s.arb_sym) return '';
  const leg = {
    pos: s.arb_pos,
    entry: s.arb_entry,
    mark: s.arb_mark,
    cv: s.arb_cv,
    usdinr: s.usdinr,
    upnl: s.arb_upnl,
    upnl_usd: s.arb_upnl_usd,
  };
  const name = s.hedge_via || s.arb_venue || '';
  return (name ? '<span class="ri-chip">' + escHtml(name) + '</span>' : '') +
    rpnlPosHtml(leg, 'ri-pos', s.arb_venue || '', s.arb_sym);
}

function rpnlPosHtml(s, cls, venue, sym) {
  if (!s || s.pos == null) return '';
  const n = Number(s.pos);
  if (!isFinite(n)) return '';
  cls = cls || 'p-pos';
  if (Math.abs(n) < 1e-12) return '<span class="' + cls + '">flat</span>';
  const side = n > 0 ? 'long' : 'short';
  const unit = rpnlBaseUnit(sym);
  const cv = Number(s.cv);
  const qty = (isFinite(cv) && cv > 0 && Math.abs(cv - 1) > 1e-9)
    ? fmtG(Math.abs(n)) + ' lots x ' + fmtG(cv) + (unit ? ' ' + unit : '')
    : fmtG(Math.abs(n)) + (unit ? ' ' + unit : '');
  let t = side + ' ' + qty;
  if (s.entry != null && Number(s.entry) > 0) t += ' @ ' + fmtG(s.entry);
  let extra = '';
  const u = liveUpnlInr(s, venue);
  if (u != null && isFinite(u)) {
    const d = Math.abs(u) < 100 ? 2 : 0;
    const usd = liveUpnlUsd(s, venue);
    const usdBit = (usd != null && isFinite(usd)) ? ' (' + usdFmtDec(usd, 2) + ')' : '';
    extra = ' · <span class="' + (u >= 0 ? 'up' : 'dn') + '">uPnL ' +
      escHtml(inrFmtDec(u, d) + usdBit) + '</span>';
  }
  return '<span class="' + cls + ' ' + side + '">' + escHtml(t) + extra + '</span>';
}

function rpnlWalletHtml(s) {
  if (!s || s.wallet_inr == null) return '';
  const n = Number(s.wallet_inr);
  if (!isFinite(n)) return '';
  return '<span class="ri-chip">wallet ' + inrFmt(n) + '</span>';
}

function rpnlLooksOption(sym) {
  const s = String(sym || '').toUpperCase();
  if (/^[CP]-/.test(s)) return true;
  return /^[CP][A-Z]{2,}\d{6,}$/.test(s);
}

function rpnlHedgeOf(r) {
  const s = (r && r.settings) || {};
  if (s.hedge_of) return String(s.hedge_of);
  return r && r._hedgeOf ? String(r._hedgeOf) : '';
}

function rpnlIsPairHedge(r) {
  const s = (r && r.settings) || {};
  if (s.pair_hedge === true || s.pair_hedge === 'true' || s.pair_hedge === 1 ||
      String(s.role || '').toLowerCase() === 'hedge' || String(s.mode || '').toLowerCase() === 'hedge') {
    return true;
  }
  return !!(r && r._pairHedge);
}

function rpnlMarkPairHedges(rows) {
  const groups = {};
  (rows || []).forEach(r => {
    if (String(r.strategy || '').toLowerCase() !== 'pair') return;
    const k = (r.account || '') + '|' + (r.strategy || '');
    (groups[k] = groups[k] || []).push(r);
  });
  Object.keys(groups).forEach(k => {
    const g = groups[k];
    const opts = g.filter(r => rpnlLooksOption(r.quote_symbol || r.contract));
    const perps = g.filter(r => !rpnlLooksOption(r.quote_symbol || r.contract));
    if (!opts.length || !perps.length) return;
    const names = opts.map(r => r.quote_symbol || r.contract).filter(Boolean);
    const label = names.join(' · ');
    const tagged = perps.filter(r => {
      const s = r.settings || {};
      return s.pair_hedge === true || s.pair_hedge === 'true' || s.pair_hedge === 1 ||
        String(s.role || '').toLowerCase() === 'hedge' || String(s.mode || '').toLowerCase() === 'hedge';
    });
    const mark = tagged.length ? tagged : (perps.length === 1 ? perps : []);
    mark.forEach(r => {
      r._pairHedge = true;
      if (!rpnlHedgeOf(r) && label) r._hedgeOf = label;
    });
  });
}

function rpnlPairLegLabel(opts) {
  const names = opts.map(r => r.quote_symbol || r.contract).filter(Boolean);
  if (!names.length) return '';
  return names.length === 1 ? names[0] : names[0] + ' +' + (names.length - 1);
}

// Pair makes one pill per option leg plus a hedge-perp pill. Fold each account's
// pair rows into a single group pill (combined rPnL, with an option/hedge split).
function rpnlCollapsePairs(rows) {
  rpnlPairHedge = {};
  const groups = {};
  const out = [];
  (rows || []).forEach(r => {
    if (String(r.strategy || '').toLowerCase() !== 'pair') { out.push(r); return; }
    const k = (r.account || '') + '|pair';
    (groups[k] = groups[k] || []).push(r);
  });
  Object.keys(groups).forEach(k => {
    const g = groups[k];
    const opts = g.filter(r => rpnlLooksOption(r.quote_symbol || r.contract));
    const hedges = g.filter(r => rpnlIsPairHedge(r) || !rpnlLooksOption(r.quote_symbol || r.contract));
    if (!opts.length) { Array.prototype.push.apply(out, g); return; }
    const sum = (arr, key) => arr.reduce((s, r) => s + (Number(r[key]) || 0), 0);
    const primary = opts.slice().sort((a, b) =>
      rpnlRowRank(a) - rpnlRowRank(b) ||
      (Math.abs(Number(b.rpnl) || 0) - Math.abs(Number(a.rpnl) || 0)))[0];
    const group = Object.assign({}, primary);
    group._pairGroup = true;
    group._optRpnl = sum(opts, 'rpnl');
    group._optFills = sum(opts, 'fills');
    group._hedgeRpnl = sum(hedges, 'rpnl');
    group._hedgeFills = sum(hedges, 'fills');
    group._legLabel = rpnlPairLegLabel(opts);
    group._legCount = opts.length;
    group.live = g.some(r => r.live);
    const hedgeSym = hedges.length ? (hedges[0].quote_symbol || hedges[0].contract) : '';
    if (hedgeSym) rpnlPairHedge[rpnlOptionValue(group)] = hedgeSym;
    out.push(group);
  });
  return out;
}

function rpnlOrdersBtnHtml(r) {
  const n = openOrdersForInspect(r).length;
  return '<button type="button" class="orders' + (riOrdersOpen ? ' open' : '') + '"' +
    ' data-ri-orders="toggle" title="Open orders" aria-label="Open orders" aria-expanded="' +
    (riOrdersOpen ? 'true' : 'false') + '" aria-controls="riOrdersBody">' +
    '<span class="act-ico" aria-hidden="true">≡</span>Orders' +
    '<span class="ri-orders-n' + (n ? '' : ' zero') + '">' + n + '</span></button>';
}

function rpnlRestartBtnHtml() {
  return '<button type="button" class="go" data-rp-restart="1" title="Open new contract with these settings" aria-label="Restart">' +
    '<span class="act-ico" aria-hidden="true">↻</span>Restart</button>';
}

function rpnlActsHtml(r) {
  const ordersBtn = rpnlOrdersBtnHtml(r);
  if (rpnlIsPairHedge(r)) {
    return '<div class="p-acts">' + ordersBtn + '</div>';
  }
  if (!r.live) {
    const restart = rpnlIsBooting(r) ? '' : rpnlRestartBtnHtml();
    return '<div class="p-acts">' + restart + ordersBtn + '</div>';
  }
  const s = r.settings || {};
  const mode = String(s.mode || '').trim().toLowerCase();
  const flattening = mode === 'flattening';
  const held = !flattening && (s.hold === true || s.hold === 1 || s.hold === 'true' || s.hold === '1' || mode === 'stopped');
  const quoting = !held && !flattening;
  const paused = quoting && (
    mode === 'paused' || mode === 'fill-pause' || mode === 'size-cool' ||
    mode === 'rest' || !!s.probing || Number(s.pause_left) > 0
  );
  const liveOrders = Number(s.live_orders);
  const hasQuotes = quoting && (!isFinite(liveOrders) || liveOrders > 0);
  const act = (cmd, glyph, label, cls) =>
    '<button type="button"' + (cls ? ' class="' + cls + '"' : '') +
    ' data-bot-cmd="' + cmd + '" title="' + label + '" aria-label="' + label + '">' +
    '<span class="act-ico" aria-hidden="true">' + glyph + '</span>' + label + '</button>';
  let html = '<div class="p-acts">';
  if (quoting) html += act('stop', '■', 'Stop');
  if (held) html += act('resume', '▶', 'Resume', 'go');
  if (hasQuotes) html += act('cancel', '✕', 'Cancel');
  if (paused) html += act('clear', '↺', 'Clear');
  html += act('flatten', '×', 'Close', 'danger' + (flattening ? ' on' : ''));
  html += ordersBtn;
  if (!flattening) {
    html += '<button type="button" class="edit" data-rp-edit="1" title="Edit settings" aria-label="Edit">' +
      '<span class="act-ico" aria-hidden="true">✎</span>Edit</button>';
  }
  html += '</div>';
  return html;
}

async function waitBotCommand(id, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 20000)) {
    try {
      const r = await fetch('/api/bot/command/' + id);
      const d = await r.json().catch(() => ({}));
      const st = String(d.status || '');
      if (st === 'done' || st === 'error') return d;
    } catch (e) {}
    await new Promise(res => setTimeout(res, 400));
  }
  return { status: 'timeout' };
}

async function sendBotCmd(pill, cmd) {
  const contract = pill.dataset.contract || '';
  const account = pill.dataset.account || '';
  const name = pill.dataset.qsym || contract;
  if (!contract || !cmd) return;
  if (pill.dataset.hedge === '1' || rpnlIsPairHedge(currentRpnlRow())) {
    toast('pair hedge is automatic — use the option contracts', 'err');
    return;
  }
  if (cmd === 'flatten' && !confirm('Cancel every open order on ' + name + ' and market-close the position? Quoting stays off until Resume.')) return;
  if (cmd === 'stop' && !confirm('Stop quoting ' + name + ' and cancel open orders? Position stays until Close or Remove.')) return;
  const body = {
    cmd: cmd, contract: contract, account: account,
    strategy: pill.dataset.strategy || currentRpnlSel().strategy || (strategyIsAll(currentStrategy) ? '' : currentStrategy),
  };
  try {
    const r = await fetch('/api/bot/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      toast((d && d.detail) || ('command failed ' + r.status), 'err');
      return;
    }
    if ((cmd === 'flatten' || cmd === 'stop') && d.id) {
      toast((cmd === 'flatten' ? 'closing ' : 'cancelling quotes on ') + name + '…', 'ok');
      const waited = await waitBotCommand(d.id, 28000);
      if (waited && waited.status === 'error') {
        toast((waited.error || 'failed') + ' — retry', 'err');
        setTimeout(() => { if (typeof loadRpnl === 'function') loadRpnl(true); }, 800);
        return;
      }
      if (waited && waited.status === 'timeout') {
        toast('still working on ' + name + ' — check open orders', 'err');
        setTimeout(() => { if (typeof loadRpnl === 'function') loadRpnl(true); }, 800);
        return;
      }
    }
    const msg = cmd === 'flatten' ? 'closed '
      : cmd === 'clear' ? 'clearing pause + limits '
      : cmd === 'setup' ? 'updating '
      : cmd === 'stop' ? 'stopped quotes on '
      : cmd + ' ';
    toast(msg + name, 'ok');
    setTimeout(() => { if (typeof loadRpnl === 'function') loadRpnl(true); }, 1200);
  } catch (e) {
    toast(String(e), 'err');
  }
}

function rpnlGeomBit(name, ticks, pct, extra) {
  const t = Number(ticks);
  let bit = null;
  if (ticks != null && isFinite(t) && t > 0) bit = name + ' ' + fmtG(t) + 't';
  else if (pct != null) bit = name + ' ' + fmtG(pct) + '%';
  if (bit && extra) bit += extra;
  return bit;
}

/** Signed bid/ask distance — ticks win when non-zero (incl. negative into the spread). */
function rpnlSideDistBit(name, ticks, pct) {
  const t = Number(ticks);
  if (ticks != null && ticks !== '' && isFinite(t) && t !== 0) return name + ' ' + fmtG(t) + 't';
  if (pct != null && pct !== '') return name + ' ' + fmtG(pct) + '%';
  if (ticks != null && ticks !== '' && isFinite(t)) return name + ' ' + fmtG(t) + 't';
  return null;
}

function rpnlHasSideDist(s) {
  if (!s) return false;
  return s.bid != null || s.ask != null || s.bid_ticks != null || s.ask_ticks != null;
}

function rpnlSideDistBits(s) {
  const bits = [];
  const bid = rpnlSideDistBit('bid', s.bid_ticks, s.bid);
  const ask = rpnlSideDistBit('ask', s.ask_ticks, s.ask);
  if (bid) bits.push(bid);
  if (ask) bits.push(ask);
  return bits;
}

/** Normalize live geom text: touch uses bid/ask distance, not K. */
function rpnlNormGeomParts(s, strategy) {
  const strat = String(strategy || (s && s.strategy) || '').toLowerCase();
  const touchLike = strat === 'touch' || rpnlHasSideDist(s);
  const raw = s && s.geom ? String(s.geom).split(' · ').map(function (b) {
    return String(b || '').trim();
  }).filter(Boolean) : null;

  if (raw && raw.length) {
    let parts = raw.slice();
    if (touchLike) {
      const kBit = parts.find(function (b) { return /^k\b/i.test(b); });
      parts = parts.filter(function (b) { return !/^k\b/i.test(b); });
      const hasSide = parts.some(function (b) { return /^(bid|ask)\b/i.test(b); });
      if (!hasSide) {
        let side = rpnlSideDistBits(s);
        if (!side.length && (s.k != null || s.k_ticks != null)) {
          // Legacy touch bots still publish K — show it as bid/ask distance.
          const legacy = rpnlSideDistBit('bid', s.k_ticks, s.k);
          const legacyAsk = rpnlSideDistBit('ask', s.k_ticks, s.k);
          if (legacy) side = [legacy, legacyAsk].filter(Boolean);
        }
        if (!side.length && kBit) {
          const m = String(kBit).match(/^k\s+(.+)$/i);
          if (m && m[1]) side = ['bid ' + m[1], 'ask ' + m[1]];
        }
        if (side.length) parts = side.concat(parts);
      }
    }
    return parts;
  }

  const bits = [];
  if (touchLike) {
    let side = rpnlSideDistBits(s);
    if (!side.length && strat === 'touch' && (s.k != null || s.k_ticks != null)) {
      const legacy = rpnlSideDistBit('bid', s.k_ticks, s.k);
      const legacyAsk = rpnlSideDistBit('ask', s.k_ticks, s.k);
      if (legacy) side = [legacy, legacyAsk].filter(Boolean);
    }
    side.forEach(function (b) { bits.push(b); });
  }
  return bits.length ? bits : null;
}

function rpnlSetupBits(s, strategy) {
  const bits = [];
  const on = v => v === true || v === 'true' || v === 'on' || v === 1 || v === '1';
  const hedge = on(s.pair_hedge) || s.role === 'hedge' || String(s.mode || '').toLowerCase() === 'hedge';
  const strat = String(strategy || s.strategy || '').toLowerCase();
  const touchLike = strat === 'touch' || rpnlHasSideDist(s);
  if (!hedge) {
    if (s.edge != null) bits.push('edge ' + fmtG(s.edge) + '%');
    if (s.hook) bits.push('hook ' + s.hook);
  }
  if (hedge) bits.push('pair hedge');
  if (s.hedge_of) bits.push('hedges ' + s.hedge_of);
  if (s.hedge_via) bits.push('hedged by ' + s.hedge_via);
  if (s.hedge_pct != null) bits.push('hedge ' + fmtG(s.hedge_pct) + '%');
  if (s.hedge_target != null) bits.push('target ' + fmtG(s.hedge_target));
  if (!hedge) {
  const geomParts = rpnlNormGeomParts(s, strat);
  if (geomParts && geomParts.length) {
    geomParts.forEach(function (b) {
      if (b) bits.push(rpnlRoundGeomText(b));
    });
  } else {
    const hem = rpnlGeomBit('hem', s.hem_ticks, s.hem);
    const span = rpnlGeomBit('span', s.span_ticks, s.span);
    let stepExtra = '';
    if (s.step_mult != null && s.step_mult !== 1 && s.step_mult !== '1' && Number(s.step_mult) !== 1) {
      const t = String(s.step_mult);
      stepExtra = '×' + (isFinite(Number(t)) ? fmtG(Number(t)) : t);
    }
    const step = rpnlGeomBit('step', s.step_ticks, s.step, stepExtra);
    if (touchLike) rpnlSideDistBits(s).forEach(function (b) { bits.push(b); });
    if (hem) bits.push(hem);
    if (span) bits.push(span);
    if (step) bits.push(step);
    if (!touchLike) {
      if (s.k_ticks != null && Number(s.k_ticks) !== 0) bits.push('k ' + fmtG(s.k_ticks) + 't');
      else if (s.k != null) bits.push('k ' + fmtG(s.k) + '%');
    }
  }
  if (s.touch_ticks != null) bits.push('touch ' + fmtG(s.touch_ticks) + 't');
  if (s.min_spread != null && Number(s.min_spread) > 0) bits.push('min spread ' + fmtG(s.min_spread) + '%');
  if (s.spread_pad != null && Number(s.spread_pad) > 0) bits.push('pad ' + fmtG(s.spread_pad) + '%');
  if (s.quote_ms != null) bits.push('quote ' + fmtG(s.quote_ms) + 'ms');
  if (s.place_secs != null) bits.push('place ' + fmtG(s.place_secs) + 's');
  if (s.vol_gate != null) bits.push('vol gate ' + (on(s.vol_gate) ? 'on' : 'off'));
  if (s.flow_gate != null) bits.push('flow gate ' + (on(s.flow_gate) ? 'on' : 'off'));
  if (s.flatten != null) bits.push('flatten ' + fmtG(s.flatten) + '%');
  if (s.stop_pause != null) bits.push('pause ' + fmtG(s.stop_pause) + 's');
  if (s.grind != null) bits.push('grind $' + fmtG(s.grind) + (s.grind_window != null ? '/' + (fmtWinSecs(s.grind_window) || (s.grind_window + 's')) : ''));
  if (s.fate != null) bits.push('fate $' + fmtG(s.fate));
    if (s.live_orders != null && s.orders != null) bits.push('orders ' + s.live_orders + '/' + s.orders);
    else if (s.orders != null) bits.push('orders ' + s.orders);
    if (s.max_usd != null) bits.push('max $' + fmtG(s.max_usd));
    else if (s.max_pos != null) bits.push('max ' + fmtG(s.max_pos));
    if (s.ignore != null) bits.push((s.ignore_usd ? 'ignore $' : 'ignore ') + fmtG(s.ignore));
  }
  return bits;
}

function rpnlSymbolBits(s) {
  const bits = [];
  if (s.quantity != null) bits.push(s.quantity + 'L');
  if (s.max_position != null) bits.push('max ' + s.max_position + 'L');
  if (Number(s.hedge_ratio) > 0) bits.push('hedge ' + Math.round(Number(s.hedge_ratio) * 100) + '%');
  if (s.wide_offset_enabled) bits.push('wide ' + fmtPct(s.wide_offset_pct));
  else bits.push('offset ' + (s.quote_offset_ticks ?? 0) + 't');
  if (s.ladder_enabled) bits.push('ladder ' + (s.ladder_levels || 1) + '×' + (s.ladder_size_mult || 1));
  if (s.delta_leverage) bits.push('Δ ' + s.delta_leverage + 'x');
  if (Number(s.hedge_ratio) > 0 && s.hedge_leverage) {
    bits.push((s.hedge_venue_label || s.hedge_venue || 'hedge') + ' ' + s.hedge_leverage + 'x');
  }
  if (s.stop_loss_enabled && Number(s.stop_loss_pct) > 0 && !s.wide_offset_enabled) bits.push('SL ' + fmtPct(s.stop_loss_pct));
  else bits.push('SL off');
  if (s.spread_gate_enabled && Number(s.min_spread_pct) > 0) bits.push('spread ' + fmtPct(s.min_spread_pct));
  else if (s.spread_gate_enabled === false) bits.push('spread off');
  if (Number(s.min_book_size) > 0) bits.push('book≥' + s.min_book_size);
  if (Number(s.contract_value) > 0) bits.push('cv ' + s.contract_value);
  if (Number(s.tick_size) > 0) bits.push('tick ' + s.tick_size);
  return bits;
}

function rpnlCfgBits(s, strategy) {
  if (!s) return [];
  if (s.kind === 'setup' || s.hem != null || s.geom != null || s.hem_auto != null || s.fit_auto != null || s.max_usd != null || s.k != null || s.edge != null || s.mode != null || s.bid != null || s.ask != null || s.bid_ticks != null || s.ask_ticks != null) {
    return rpnlSetupBits(s, strategy);
  }
  return rpnlSymbolBits(s);
}

function rpnlCfgTitle(s) {
  if (!s) return 'No live bot setup for this contract yet — restart the strategy so it can write hem/span/max';
  const skip = new Set(['coindcx_sl_tick', 'kind', 'quotes']);
  return Object.entries(s)
    .filter(([k, v]) => !skip.has(k) && v !== '' && v != null)
    .map(([k, v]) => k + ': ' + v)
    .join('\n');
}

function rpnlCfgHtml(s, strategy) {
  const bits = rpnlCfgBits(s, strategy);
  const mode = rpnlModeText(s);
  if (!bits.length && !mode) return '<div class="p-cfg none">no bot setup yet</div>';
  const spans = [];
  if (mode) spans.push('<span>' + escHtml(mode) + '</span>');
  bits.forEach(function (b) {
    const geom = /^(hem|span|step|tail|k|bid|ask) /.test(String(b));
    spans.push('<span' + (geom ? ' class="p-geom"' : '') + '>' + escHtml(b) + '</span>');
  });
  return '<div class="p-cfg" title="' + escHtml(rpnlCfgTitle(s)).replace(/\n/g, '&#10;') + '">' +
    spans.join('') + '</div>';
}

function rpnlWindowLabel(hours) {
  if (hours === 'today') return 'today';
  const h = Number(hours);
  if (!h || !isFinite(h)) return '';
  if (h >= 24 && h % 24 === 0) {
    const d = h / 24;
    return d === 1 ? '24h' : d + 'd';
  }
  return h + 'h';
}

function rpnlHoursSel() {
  return (document.getElementById('rpnlHours') || {}).value || '24';
}

function rpnlWindowQuery() {
  if (rpnlCurrentHours !== null) return '&hours=' + rpnlCurrentHours;
  const v = rpnlHoursSel();
  if (v === 'today') return '&today=true';
  return '&hours=' + encodeURIComponent(v);
}

function rpnlWindowTag() {
  if (rpnlCurrentHours !== null) return rpnlWindowLabel(rpnlCurrentHours);
  const v = rpnlHoursSel();
  return v === 'today' ? 'today' : rpnlWindowLabel(v);
}

function rpnlWindowFillCount(r) {
  return (Number(r && r.fills) || 0) + (Number(r && r.hedge_fills) || 0);
}

function filterRpnlWindowRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter(r => r.live || r.removed || rpnlIsBooting(r) || rpnlWindowFillCount(r) > 0);
}

function syncRpnlSymbolSelect(rows) {
  const sel = document.getElementById('rpnlSymbol');
  if (!sel) return '';
  const keep = sel.value;
  const keepMissing = rpnlForceKeepSel;
  rpnlForceKeepSel = false;
  if (!rows.length) {
    if (keepMissing && keep && keep.indexOf('::') >= 0) {
      sel.innerHTML = '<option value="' + escHtml(keep) + '">' + escHtml(keep.replace('::', ' · ')) + '</option>';
      sel.value = keep;
      return keep;
    }
    sel.innerHTML = '<option value="">No live bots or fills</option>';
    return '';
  }
  const sorted = rows.slice().sort((a, b) => rpnlRowRank(a) - rpnlRowRank(b));
  sel.innerHTML = sorted.map(c =>
    '<option value="' + escHtml(rpnlOptionValue(c)) + '">' +
      escHtml(rpnlSelMark(c) + (c.label || pillOptionLabel(c))) + '</option>'
  ).join('');
  if (keep && [...sel.options].some(o => o.value === keep)) sel.value = keep;
  else if (keep) {
    const hit = [...sel.options].find(o => rpnlSelMatch(o.value, keep));
    if (hit) sel.value = hit.value;
    else if (keepMissing && keep.indexOf('::') >= 0) {
      const opt = document.createElement('option');
      opt.value = keep;
      opt.textContent = keep.replace(/::/g, ' · ');
      sel.appendChild(opt);
      sel.value = keep;
    } else sel.selectedIndex = 0;
  } else sel.selectedIndex = 0;
  return sel.value;
}

function rpnlCanonSym(sym) {
  return String(sym || '').toUpperCase().replace(/[-_]/g, '');
}

function pairGroupRows(row, rows) {
  const list = rows || rpnlSummaryCache || [];
  if (!row) return [];
  const strat = String(row.strategy || '').toLowerCase();
  if (strat !== 'pair') return row.live ? [row] : [];
  const acct = row.account || '';
  return list.filter(r =>
    r.live &&
    String(r.strategy || '').toLowerCase() === 'pair' &&
    (r.account || '') === acct
  );
}

function openOrdersForInspect(row, rows) {
  const mine = rpnlCanonSym((row && (row.quote_symbol || row.contract)) || '');
  const out = [];
  pairGroupRows(row, rows).forEach(r => {
    if (rpnlIsPairHedge(r)) return;
    const quotes = r.settings && Array.isArray(r.settings.quotes) ? r.settings.quotes : [];
    const sym = r.quote_symbol || r.contract || '';
    quotes.forEach(q => {
      const px = Number(q.price);
      if (!isFinite(px) || px <= 0) return;
      const side = String(q.side || '').toLowerCase();
      if (side !== 'buy' && side !== 'sell') return;
      out.push({
        side: side,
        price: px,
        qty: q.qty,
        role: String(q.role || '').trim(),
        symbol: sym,
        mine: rpnlCanonSym(sym) === mine,
      });
    });
  });
  out.sort((a, b) =>
    Number(!!b.mine) - Number(!!a.mine) ||
    (a.side === b.side ? 0 : a.side === 'buy' ? -1 : 1) ||
    a.price - b.price
  );
  return out;
}

function quotesForCurrentRpnl(rows) {
  const row = currentRpnlRow(rows);
  if (!row || !row.live || rpnlIsPairHedge(row) || !row.settings || !Array.isArray(row.settings.quotes)) return [];
  return row.settings.quotes;
}

function openOrdersSig(row, rows) {
  return JSON.stringify(openOrdersForInspect(row, rows).map(q => [q.symbol, q.side, q.price, q.qty, q.role]));
}

function setRiSetupOpen(on) {
  riSetupOpen = !!on;
  const box = document.getElementById('rpnlInspect');
  const wrap = box && box.querySelector('.ri-setup');
  if (wrap) {
    wrap.classList.toggle('open', riSetupOpen);
    if (riSetupOpen) wrap.removeAttribute('hidden');
    else wrap.setAttribute('hidden', '');
  }
  const cur = (document.getElementById('rpnlSymbol') || {}).value || '';
  document.querySelectorAll('.rpnl-pill [data-ri-setup]').forEach(btn => {
    const pill = btn.closest('[data-rpnl-key]');
    const mine = !!(riSetupOpen && pill && pill.dataset.rpnlKey === cur);
    btn.classList.toggle('on', mine);
    btn.setAttribute('aria-expanded', mine ? 'true' : 'false');
  });
  if (typeof resizeRpnlCharts === 'function') {
    requestAnimationFrame(function () { resizeRpnlCharts(); });
  }
}

function setRiOrdersOpen(on) {
  riOrdersOpen = !!on;
  const page = document.getElementById('rpnl');
  if (page) page.classList.toggle('orders-open', riOrdersOpen);
  const box = document.getElementById('rpnlInspect');
  const wrap = box && box.querySelector('.ri-orders');
  if (wrap) {
    wrap.classList.toggle('open', riOrdersOpen);
    const body = wrap.querySelector('.ri-orders-body');
    if (body) {
      if (riOrdersOpen) body.removeAttribute('hidden');
      else body.setAttribute('hidden', '');
    }
  }
  const tog = box && box.querySelector('[data-ri-orders="toggle"]');
  if (tog) {
    tog.setAttribute('aria-expanded', riOrdersOpen ? 'true' : 'false');
    tog.classList.toggle('open', riOrdersOpen);
  }
  if (typeof resizeRpnlCharts === 'function') {
    requestAnimationFrame(function () { resizeRpnlCharts(); });
  }
}

function rpnlOrdersHtml(row, rows) {
  if (!row) return '';
  const orders = openOrdersForInspect(row, rows);
  const n = orders.length;
  const rowsHtml = n
    ? orders.map(q => {
        const buy = q.side === 'buy';
        const qty = q.qty != null && q.qty !== '' ? fmtG(q.qty) : '';
        const role = q.role ? '<span class="ri-ord-role">' + escHtml(q.role) + '</span>' : '';
        const sym = q.symbol && !q.mine ? '<span class="ri-ord-sym">' + escHtml(q.symbol) + '</span>' : '';
        return '<li class="ri-ord ' + (buy ? 'buy' : 'sell') + (q.mine ? ' mine' : '') + '">' +
          '<span class="ri-ord-side">' + (buy ? 'Buy' : 'Sell') + '</span>' +
          '<span class="ri-ord-qty">' + escHtml(qty || '—') + '</span>' +
          '<span class="ri-ord-at">@</span>' +
          '<span class="ri-ord-px">' + escHtml(fmtPxFull(q.price)) + '</span>' +
          role +
          (q.mine ? '<span class="ri-ord-here">this</span>' : sym) +
        '</li>';
      }).join('')
    : '<li class="ri-ord empty">No working quotes</li>';
  return '<div class="ri-orders' + (riOrdersOpen ? ' open' : '') + '">' +
    '<div class="ri-orders-scrim" data-ri-orders="close"></div>' +
    '<div class="ri-orders-body" id="riOrdersBody" role="dialog" aria-label="Open orders"' +
      (riOrdersOpen ? '' : ' hidden') + '>' +
      '<div class="ri-orders-grab" aria-hidden="true"></div>' +
      '<div class="ri-orders-h">' +
        '<span>Open orders</span>' +
        '<span class="ri-orders-n' + (n ? '' : ' zero') + '">' + n + '</span>' +
        '<button type="button" class="ri-orders-x" data-ri-orders="close" aria-label="Close">Close</button>' +
      '</div>' +
      '<ul class="ri-orders-list">' + rowsHtml + '</ul>' +
    '</div>' +
  '</div>';
}

function currentRpnlRow(rows) {
  const cur = (document.getElementById('rpnlSymbol') || {}).value || '';
  const list = rows || rpnlSummaryCache || [];
  return list.find(r => rpnlOptionValue(r) === cur)
    || list.find(r => rpnlSelMatch(rpnlOptionValue(r), cur))
    || null;
}

function clearOhlcOrderLines() {
  ohlcOrderSig = '';
  const owner = ohlcOrderOwner || ohlcSeries;
  ohlcOrderLines.forEach(line => {
    try { if (owner) owner.removePriceLine(line); } catch (e) {}
  });
  ohlcOrderLines = [];
  ohlcOrderOwner = null;
}

function applyOhlcOrderLines(quotes) {
  const list = Array.isArray(quotes) ? quotes : [];
  const series = ohlcActiveSeries();
  const sig = JSON.stringify(list.map(q => [q.side, q.price, q.qty, q.role])) + '#' + (ohlcBarsCache.length ? 1 : 0) + '#' + ohlcStyle;
  if (sig === ohlcOrderSig && ohlcOrderOwner === series) {
    updateRpnlPaneLabels();
    return;
  }
  clearOhlcOrderLines();
  ohlcOrderSig = sig;
  if (!series || !list.length || !ohlcBarsCache.length) {
    applyOhlcOrderScale([]);
    updateRpnlPaneLabels();
    return;
  }
  const dash = (window.LightweightCharts && LightweightCharts.LineStyle)
    ? LightweightCharts.LineStyle.Dashed
    : 2;
  ohlcOrderOwner = series;
  list.forEach(q => {
    const px = Number(q.price);
    if (!isFinite(px) || px <= 0) return;
    const buy = String(q.side || '').toLowerCase() === 'buy';
    const qty = q.qty != null && q.qty !== '' ? fmtG(q.qty) : '';
    const role = String(q.role || '').trim();
    const title = [qty, role || (buy ? 'B' : 'S')].filter(Boolean).join(' ');
    try {
      ohlcOrderLines.push(series.createPriceLine({
        price: px,
        color: buy ? '#26a69a' : '#ef5350',
        lineWidth: 1,
        lineStyle: dash,
        axisLabelVisible: true,
        title: title,
      }));
    } catch (e) {}
  });
  applyOhlcOrderScale(list);
  updateRpnlPaneLabels();
}

function applyOhlcOrderScale(quotes) {
  if (!ohlcOrderScaleSeries) return;
  const bars = ohlcBarsCache || [];
  const px = (quotes || []).map(q => Number(q.price)).filter(p => isFinite(p) && p > 0);
  if (!bars.length || !px.length) {
    try { ohlcOrderScaleSeries.setData([]); } catch (e) {}
    return;
  }
  const lo = Math.min.apply(null, px);
  const hi = Math.max.apply(null, px);
  const t0 = bars[0].time;
  const t1 = bars[bars.length - 1].time;
  const pts = t0 === t1
    ? [{ time: t0, value: (lo + hi) / 2 }]
    : [{ time: t0, value: lo }, { time: t1, value: hi }];
  try { ohlcOrderScaleSeries.setData(pts); } catch (e) {}
}

function setOhlcEmpty(show, msg) {
  const el = document.getElementById('ohlcEmpty');
  if (!el) return;
  if (msg) el.textContent = msg;
  el.classList.toggle('show', !!show);
}

function startRpnlLive() {
  if (!rpnlQuoteTimer) rpnlQuoteTimer = setInterval(refreshRpnlLive, 1000);
  setupRpnlAuto();
}

function stopRpnlLive() {
  if (rpnlQuoteTimer) {
    clearInterval(rpnlQuoteTimer);
    rpnlQuoteTimer = null;
  }
  clearInterval(rpnlTimer);
  rpnlTimer = null;
}

async function refreshRpnlLive() {
  const page = document.getElementById('rpnl');
  if (!page || !page.classList.contains('visible')) return;
  if (document.hidden || rpnlLoadingMore || rpnlLoadBusy) return;
  const winQ = rpnlWindowQuery();
  const winLab = rpnlWindowTag();
  const hoursArg = winLab === 'today' ? 'today' : (rpnlCurrentHours !== null ? rpnlCurrentHours : rpnlHoursSel());
  try {
    const sR = await fetch(withStrategy('/api/rpnl/summary' + (winQ ? '?' + winQ.slice(1) : '')));
    if (!sR.ok) return;
    const rows = filterRpnlWindowRows(await sR.json());
    renderRpnlSummary(rows, hoursArg);
    tickOhlcLiveMark();
    paintOhlcHud(ohlcHoverTime);
    updateOhlcCountdown();
  } catch (e) {}
  if (rpnlLogsOpen() && rpnlKind === 'logs' && rpnlLogsLiveOn()) loadRpnlLogs(false);
  if (rpnlLogsOpen() && rpnlKind === 'fills' && rpnlFillsLiveOn()) {
    const now = Date.now();
    if (now - rpnlFillLiveAt > 2500) {
      rpnlFillLiveAt = now;
      loadRpnlKindLive();
    }
  }
}

function rpnlClockStatus(s) {
  s = s || {};
  if (!s.clock_on) return 'Off';
  const phase = rpnlStatusLabel(s.clock_phase || 'open');
  const win = s.clock_window ? ' ' + s.clock_window : '';
  const next = s.clock_next ? ' → ' + s.clock_next : '';
  let left = Number(s.clock_left);
  if (!isFinite(left) || left <= 0) left = 0;
  const secs = left ? ' · ' + fmtWinSecs(left) : '';
  const why = s.clock_why ? ' · ' + s.clock_why : '';
  const day = s.clock_day_loss > 0 || s.clock_day_win > 0
    ? ' · day ' + fmtUsdSigned(s.clock_day_rpnl)
    : '';
  return phase + win + next + secs + why + day;
}

function renderRpnlInspect(row) {
  const box = document.getElementById('rpnlInspect');
  if (!box) return;
  if (!row) {
    box.className = 'rpnl-inspect';
    box.innerHTML = '';
    box.dataset.sig = '';
    box.dataset.hedge = '';
    riOrdersOpen = false;
    riSetupOpen = false;
    const page = document.getElementById('rpnl');
    if (page) page.classList.remove('orders-open');
    return;
  }
  const s = row.settings || null;
  const qlab = row.quote_label || 'Delta';
  const qsym = row.quote_symbol || row.contract;
  const hlab = row.hedge_label || 'Hedge';
  const hedged = !!row.has_hedge && !!row.hedge_fills;
  const quote = Number(row.rpnl) || 0;
  const hedge = hedged ? (Number(row.hedge_rpnl) || 0) : 0;
  const modeTxt = rpnlModeText(s, true);
  const cfgSig = s ? rpnlCfgBits(s, row.strategy).join(',') : '';
  const sig = [
    row.contract, row.account, Number(!!row.live), quote, hedge, row.fills, row.hedge_fills,
    s && s.pos, s && s.entry, s && s.upnl, s && s.upnl_usd, s && s.mark, s && s.cv, s && s.usdinr, s && s.wallet_inr, s && s.mode, s && s.hold, s && s.pause_left,
    s && s.win_rpnl, s && s.burst_rpnl, s && s.probing, s && s.rest_left,
    s && s.trip_why, s && s.probe_hold, s && s.probe_lock_left, s && s.probe_n_have,
    s && s.probe_win_ok, s && s.fate_peak, s && s.grind_rpnl, s && s.pause_clock,
    s && s.probe_rpnl_ready, s && s.probe_chop_ok,
    s && s.max_usd, s && s.max_pos, s && s.live_orders,
    s && s.arb_pos, s && s.arb_entry, s && s.arb_upnl, s && s.arb_mark, s && s.arb_side, s && s.geom,
    s && s.pair_hedge, s && s.role, s && s.hedge_of, s && s.hedge_via,
    s && s.clock_on, s && s.clock_phase, s && s.clock_windows, s && s.clock_orders, s && s.clock_pos,
    s && s.clock_override, s && s.clock_armed, s && s.clock_suggest, s && s.clock_arm,
    cfgSig, modeTxt, openOrdersSig(row),
  ].join('|');
  const pairHedge = rpnlIsPairHedge(row);
  const hedgeOf = rpnlHedgeOf(row);
  const via = s && s.hedge_via;
  const cfgHtml = (!pairHedge && s) ? rpnlCfgHtml(s, row.strategy) : '';
  box.className = 'rpnl-inspect open' + (pairHedge ? ' hedge' : '');
  box.dataset.contract = row.contract || '';
  box.dataset.account = row.account || '';
  box.dataset.strategy = row.strategy || '';
  box.dataset.qsym = qsym;
  box.dataset.hedge = pairHedge ? '1' : '';
  if (box.dataset.sig === sig && box.innerHTML) return;
  box.dataset.sig = sig;
  const infoEl = box.querySelector('.ri-info');
  const toolsEl = box.querySelector('.ri-tools');
  const infoLeft = infoEl ? infoEl.scrollLeft : 0;
  const toolsLeft = toolsEl ? toolsEl.scrollLeft : 0;
  box.innerHTML =
    '<div class="ri-bar">' +
      '<div class="ri-row ri-info">' +
        '<div class="ri-stats">' +
          '<span class="ri-sym">' + escHtml(qsym) + '</span>' +
          (pairHedge ? '' : rpnlStatusChip(s)) +
          (pairHedge
            ? '<span class="ri-chip hedge">Hedge' + (hedgeOf ? ' of ' + escHtml(hedgeOf) : '') + '</span>'
            : (via ? '<span class="ri-chip hedge">hedged by ' + escHtml(via) + '</span>' : '')) +
          '<span class="ri-chip">' + escHtml(qlab) + ' · ' + (row.fills || 0) + ' fills' +
            (hedged ? ' · ' + escHtml(hlab) + ' ' + (row.hedge_fills || 0) : '') + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="ri-row ri-tools">' + rpnlActsHtml(row) + '</div>' +
      (cfgHtml ? '<div class="ri-setup' + (riSetupOpen ? ' open' : '') + '"' + (riSetupOpen ? '' : ' hidden') + '>' + cfgHtml + '</div>' : '') +
      rpnlOrdersHtml(row) +
    '</div>';
  const infoNow = box.querySelector('.ri-info');
  const toolsNow = box.querySelector('.ri-tools');
  const keepScroll = function (el, left) {
    if (!el || left <= 0) return;
    el.scrollLeft = left;
    requestAnimationFrame(function () { el.scrollLeft = left; });
  };
  keepScroll(infoNow, infoLeft);
  keepScroll(toolsNow, toolsLeft);
  const page = document.getElementById('rpnl');
  if (page) page.classList.toggle('orders-open', riOrdersOpen);
  setRiSetupOpen(riSetupOpen);
  if (!box.dataset.bound) {
    box.dataset.bound = '1';
    box.addEventListener('click', ev => {
      const ordersBtn = ev.target.closest('[data-ri-orders]');
      if (ordersBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        const cmd = ordersBtn.getAttribute('data-ri-orders');
        setRiOrdersOpen(cmd === 'toggle' ? !riOrdersOpen : false);
        return;
      }
      const edit = ev.target.closest('[data-rp-edit]');
      if (edit) {
        ev.preventDefault();
        ev.stopPropagation();
        if (typeof openRpOpsEdit === 'function') openRpOpsEdit(currentRpnlRow());
        return;
      }
      const restart = ev.target.closest('[data-rp-restart]');
      if (restart) {
        ev.preventDefault();
        ev.stopPropagation();
        if (typeof openRpRestart === 'function') openRpRestart(currentRpnlRow());
        return;
      }
      const act = ev.target.closest('[data-bot-cmd]');
      if (act) {
        ev.preventDefault();
        ev.stopPropagation();
        sendBotCmd(act.closest('.rpnl-inspect') || box, act.getAttribute('data-bot-cmd'));
        return;
      }
    });
    document.addEventListener('keydown', ev => {
      if (ev.key !== 'Escape') return;
      if (riOrdersOpen) { setRiOrdersOpen(false); ev.preventDefault(); return; }
      if (riSetupOpen) { setRiSetupOpen(false); ev.preventDefault(); }
    });
  }
}

function rpnlLiveDot(r) {
  if (rpnlIsBooting(r)) {
    return '<span class="p-live booting" title="' + escHtml(rpnlBootLabel(r)) + '"></span>';
  }
  if (!r || !r.live) return '';
  const st = rpnlIsPairHedge(r) ? { key: '', label: 'Hedge' } : rpnlDashStatus(r.settings);
  const cls = 'p-live' + (st.key ? ' ' + st.key : '');
  const title = st.label || 'Live';
  return '<span class="' + cls + '" title="' + escHtml(title) + '"></span>';
}

function rpnlStatusChip(s) {
  const st = rpnlDashStatus(s);
  if (!st.label) return '';
  return '<span class="ri-chip status ' + st.tone + '">' + escHtml(st.label) + '</span>';
}

function rpnlPillMode(r) {
  if (rpnlIsBooting(r)) return '';
  if (r && r.removed) return 'Removed · restart ready';
  return rpnlModeText(r && r.settings, true) || '';
}

function rpnlPillMax(r) {
  const s = r && r.settings || {};
  if (s.max_usd != null && isFinite(Number(s.max_usd))) return 'max $' + fmtG(s.max_usd);
  if (s.max_pos != null && isFinite(Number(s.max_pos))) return 'max ' + fmtG(s.max_pos);
  if (s.max_position != null && isFinite(Number(s.max_position))) return 'max ' + fmtG(s.max_position);
  return '';
}

function rpnlRoundGeomText(text) {
  return String(text || '').replace(/\d+\.\d+/g, function (m) {
    const n = Number(m);
    if (!isFinite(n)) return m;
    return n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  });
}

function rpnlPillGeom(r) {
  const s = r && r.settings;
  if (!s) return '';
  const parts = rpnlNormGeomParts(s, r.strategy);
  if (parts && parts.length) {
    return rpnlRoundGeomText(parts.join(' · ')).replace(/\(book\)/gi, '(b)');
  }
  const g = s.geom;
  if (!g) return '';
  return rpnlRoundGeomText(g).replace(/\(book\)/gi, '(b)');
}

function rpnlPillWallet(r) {
  const n = Number(r && r.settings && r.settings.wallet_inr);
  if (!isFinite(n) || n <= 0) return '';
  return 'bal ' + inrFmt(n);
}

function rpnlPillAcctKey(r) {
  return (r.quote_symbol || r.contract) + '|' + rpnlAccountLabel(r) + '|' + (r.strategy || '');
}

function rpnlPillAcctText(r, nameCount) {
  const acct = rpnlAccountLabel(r);
  if (!acct) return '';
  const dupe = nameCount && nameCount[rpnlPillAcctKey(r)] > 1 && r.account && r.account !== acct;
  return dupe ? acct + ' #' + r.account : acct;
}

function rpnlPillSetupBtn(r, cur) {
  if (rpnlIsPairHedge(r) || !(r && r.settings)) return '';
  const mine = rpnlOptionValue(r) === cur && riSetupOpen;
  return '<button type="button" class="p-setup-btn' + (mine ? ' on' : '') + '" data-ri-setup="toggle"' +
    ' title="Setup" aria-label="Setup" aria-expanded="' + (mine ? 'true' : 'false') + '">i</button>';
}

const RPNL_COLORS = {
  red: '#e08a86', orange: '#e0a36a', yellow: '#d4bc72', green: '#7dbea0',
  blue: '#86aee0', purple: '#b79ad4', white: '#d0d7e4', brown: '#c9a888', black: '#9aa3b5',
};

function rpnlPillColor(r) {
  const s = (r && r.settings) || {};
  const name = String(s.color || '').trim().toLowerCase();
  const named = RPNL_COLORS[name] || '';
  const raw = String(s.color_hex || '');
  const hex = named || (/^#[0-9a-fA-F]{6}$/.test(raw) ? raw : '');
  return hex ? { hex } : { hex: '' };
}

function rpnlPaintPillColor(el, r) {
  if (!el) return;
  const spec = rpnlPillColor(r);
  el.classList.remove('tone-ink');
  el.style.background = '';
  if (spec.hex) {
    el.style.setProperty('--pill', spec.hex);
    el.classList.add('has-color');
  } else {
    el.style.removeProperty('--pill');
    el.classList.remove('has-color');
  }
}

function rpnlWindowCoins(r) {
  const qty = Number(r && r.fills_qty);
  if (!isFinite(qty) || qty <= 0) return 0;
  const cv = Number(r && r.settings && r.settings.cv);
  if (isFinite(cv) && cv > 0 && Math.abs(cv - 1) > 1e-9) return qty * cv;
  return qty;
}

function rpnlWindowFilledText(r, unitBit) {
  return '(' + fmtG(rpnlWindowCoins(r)) + unitBit + ' filled)';
}

function rpnlHeldLines(s, sym, r) {
  const unit = rpnlBaseUnit(sym);
  const unitBit = unit ? ' ' + unit : '';
  const n = s && s.pos != null ? Number(s.pos) : NaN;
  const open = isFinite(n) && Math.abs(n) >= 1e-12;
  const cv = Number(s && s.cv);
  const lots = isFinite(cv) && cv > 0 && Math.abs(cv - 1) > 1e-9;
  const lines = [];
  if (open) {
    const base = lots ? Math.abs(n) * cv : Math.abs(n);
    let held = fmtG(base) + unitBit;
    if (s.entry != null && Number(s.entry) > 0) held += ' @ ' + fmtG(s.entry);
    lines.push({ cls: 'p-held', text: held });
  }
  if (lots || rpnlWindowCoins(r) > 0) {
    const lot = lots ? '1 lot = ' + fmtG(cv) + unitBit + ' ' : '';
    lines.push({ cls: 'p-lot', text: lot + rpnlWindowFilledText(r, unitBit) });
  }
  if (!lines.length) return null;
  return { side: open ? (n > 0 ? 'long' : 'short') : '', lines: lines };
}

function rpnlPillUpnl(r) {
  const s = r && r.settings;
  if (!s) return null;
  const inr = liveUpnlInr(s, r.quote_venue);
  if (inr == null || !isFinite(inr)) return null;
  const usd = liveUpnlUsd(s, r.quote_venue);
  const d = Math.abs(inr) < 100 ? 2 : 0;
  const usdBit = (usd != null && isFinite(usd)) ? ' (' + usdFmtDec(usd, 2) + ')' : '';
  return { text: 'uPnL ' + inrFmtDec(inr, d) + usdBit, up: inr >= 0 };
}

function rpnlPillBookHtml(r) {
  const s = r && r.settings;
  if (!s || r.removed) return '';
  const sym = r._pairGroup
    ? (r._legLabel || r.quote_symbol || r.contract)
    : (r.quote_symbol || r.contract);
  const up = rpnlPillUpnl(r);
  const pos = rpnlHeldLines(s, sym, r);
  let html = '';
  if (up) html += '<div class="p-upnl ' + (up.up ? 'up' : 'dn') + '">' + escHtml(up.text) + '</div>';
  if (pos) {
    html += '<div class="p-pos ' + pos.side + '">';
    for (let i = 0; i < pos.lines.length; i++) {
      html += '<div class="' + pos.lines[i].cls + '">' + escHtml(pos.lines[i].text) + '</div>';
    }
    html += '</div>';
  }
  return html;
}

function rpnlSyncPillBook(el, r) {
  const html = rpnlPillBookHtml(r);
  let book = el.querySelector('.p-book');
  if (!html) {
    if (book) book.remove();
    return;
  }
  if (!book) {
    book = document.createElement('div');
    book.className = 'p-book';
    const val = el.querySelector('.p-val');
    if (val) val.insertAdjacentElement('afterend', book);
    else el.appendChild(book);
  }
  book.innerHTML = html;
}

function rpnlPillHtml(r, cur, nameCount) {
  const key = rpnlOptionValue(r);
  const active = key === cur ? ' active' : '';
  const bootOnly = rpnlIsBooting(r) && !rpnlWindowFillCount(r);
  const liveCls = r.live ? ' live' : (rpnlIsBooting(r) ? ' booting' : (r.removed ? ' removed' : ''));
  const acct = rpnlPillAcctText(r, nameCount);
  const qv = r.quote_venue || 'delta';
  const qlab = r.quote_label || 'Delta';
  const qsym = r._pairGroup ? (r._legLabel || r.quote_symbol || r.contract) : (r.quote_symbol || r.contract);
  const main = rpnlPillMain(r);
  const mainCol = (bootOnly || r.removed) ? '#ffb74d' : (main >= 0 ? 'var(--green)' : 'var(--red)');
  const mode = rpnlPillMode(r);
  const maxBit = rpnlIsPairHedge(r) ? '' : rpnlPillMax(r);
  const geomBit = rpnlIsPairHedge(r) ? '' : rpnlPillGeom(r);
  const walletBit = rpnlPillWallet(r);
  const strat = r.strategy || '';
  const hedgeBit = rpnlIsPairHedge(r);
  const st = rpnlDashStatus(r.settings);
  const statusCls = hedgeBit || !st.key ? '' : ' ' + st.key;
  const modeCls = st.tone ? ' ' + st.tone : '';
  const hedgeOf = rpnlHedgeOf(r);
  const via = r.settings && r.settings.hedge_via;
  const shownMode = hedgeBit ? '' : mode;
  const tint = rpnlPillColor(r);
  const book = rpnlPillBookHtml(r);
  return '<div class="rpnl-pill' + active + liveCls + statusCls + (hedgeBit ? ' hedge' : '') + (tint.hex ? ' has-color' : '') + '"' +
    (tint.hex ? ' style="--pill:' + tint.hex + '"' : '') +
    ' role="button" tabindex="0" data-rpnl-key="' + escHtml(key) + '">' +
    '<div class="p-name">' + rpnlLiveDot(r) +
      '<span class="p-sym">' + escHtml(qsym || '') + '</span>' +
      (acct ? '<span class="rpnl-acct">' + escHtml(acct) + '</span>' : '') +
      (strat ? '<span class="rpnl-strat">' + escHtml(strat) + '</span>' : '') +
      (hedgeBit ? '<span class="rpnl-hedge">Hedge</span>' : '') +
      '<span class="rpnl-venue ' + rpnlVenueClass(qv) + '">' + escHtml(qlab) + '</span>' +
      rpnlPillSetupBtn(r, cur) +
    '</div>' +
    '<div class="p-val" style="color:' + mainCol + '">' + rpnlPillValInner(r) + '</div>' +
    (book ? '<div class="p-book">' + book + '</div>' : '') +
    (r._pairGroup ? '<div class="p-hedge" title="option vs hedge">opt ' + inrFmt(r._optRpnl || 0) + ' · hedge ' + inrFmt(r._hedgeRpnl || 0) + '</div>' : '') +
    (hedgeBit && hedgeOf ? '<div class="p-hedge" title="' + escHtml(hedgeOf) + '">of ' + escHtml(hedgeOf) + '</div>' : '') +
    (!hedgeBit && via ? '<div class="p-hedge via" title="' + escHtml(via) + '">hedged by ' + escHtml(via) + '</div>' : '') +
    (maxBit ? '<div class="p-max">' + escHtml(maxBit) + '</div>' : '') +
    (geomBit ? '<div class="p-geom" title="' + escHtml(r.settings && r.settings.geom || geomBit) + '">' + escHtml(geomBit) + '</div>' : '') +
    (walletBit ? '<div class="p-bal">' + escHtml(walletBit) + '</div>' : '') +
    (shownMode ? '<div class="p-mode' + modeCls + '">' + escHtml(shownMode) + '</div>' : '') +
    '</div>';
}

function rpnlPillMain(r) {
  if (r && r._pairGroup) return (Number(r._optRpnl) || 0) + (Number(r._hedgeRpnl) || 0);
  const hedged = !!r.has_hedge && !!r.hedge_fills;
  return (Number(r.rpnl) || 0) + (hedged ? (Number(r.hedge_rpnl) || 0) : 0);
}

function rpnlPillUsdText(r, inr) {
  const usd = (Number(inr) || 0) / liveUsdInr(r && r.settings);
  const abs = Math.abs(usd);
  const d = abs >= 100 ? 0 : (abs >= 10 ? 1 : 2);
  const sign = usd < 0 ? '−' : '';
  return sign + '$' + abs.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function rpnlPillValInner(r) {
  if (r && r.removed) return '<span class="p-boot">Removed</span>';
  if (rpnlIsBooting(r) && !rpnlWindowFillCount(r)) {
    return '<span class="p-boot">' + escHtml(rpnlBootLabel(r)) + '</span>';
  }
  const main = rpnlPillMain(r);
  return inrFmt(main) + '<span class="p-usd">' + rpnlPillUsdText(r, main) + '</span>';
}

function renderRpnlSummary(rows, hours) {
  const wrap = document.getElementById('rpnlSummaryWrap');
  if (!wrap) return;
  rows = rpnlApplyFilter(filterRpnlWindowRows(rows));
  rpnlMarkPairHedges(rows);
  if (!rows.length) {
    wrap.dataset.keys = '';
    wrap.innerHTML = '<div class="rpnl-empty">' + rpnlEmptyFilterMsg() + '</div>';
    rpnlSummaryCache = [];
    renderRpnlInspect(null);
    applyOhlcOrderLines([]);
    return;
  }
  rpnlSummaryCache = rows;
  if (typeof refreshOpsLiveGeom === 'function') refreshOpsLiveGeom();
  const display = rpnlCollapsePairs(rows);
  const cur = (document.getElementById('rpnlSymbol') || {}).value || '';
  const nameCount = {};
  display.forEach(r => {
    const n = rpnlPillAcctKey(r);
    nameCount[n] = (nameCount[n] || 0) + 1;
  });
  const sorted = display.slice().sort((a, b) => rpnlRowRank(a) - rpnlRowRank(b));
  const keys = sorted.map(r => rpnlOptionValue(r)).join('\n');
  if (wrap.dataset.keys !== keys) {
    wrap.dataset.keys = keys;
    wrap.innerHTML = sorted.map(r => rpnlPillHtml(r, cur, nameCount)).join('');
  } else {
    const byKey = new Map(sorted.map(r => [rpnlOptionValue(r), r]));
    [...wrap.querySelectorAll('.rpnl-pill')].forEach(el => {
      const r = byKey.get(el.dataset.rpnlKey);
      if (!r) return;
      el.classList.toggle('active', el.dataset.rpnlKey === cur);
      el.classList.toggle('live', !!r.live);
      el.classList.toggle('booting', rpnlIsBooting(r));
      el.classList.toggle('hedge', rpnlIsPairHedge(r));
      const st = rpnlDashStatus(r.settings);
      el.classList.toggle('stopped', !rpnlIsPairHedge(r) && st.key === 'stopped');
      el.classList.toggle('flattening', !rpnlIsPairHedge(r) && st.key === 'flattening');
      rpnlPaintPillColor(el, r);
      const val = el.querySelector('.p-val');
      const main = rpnlPillMain(r);
      if (val) {
        val.innerHTML = rpnlPillValInner(r);
        val.style.color = (rpnlIsBooting(r) && !rpnlWindowFillCount(r))
          ? '#ffb74d'
          : (main >= 0 ? 'var(--green)' : 'var(--red)');
      }
      rpnlSyncPillBook(el, r);
      const mode = rpnlPillMode(r);
      let modeEl = el.querySelector('.p-mode');
      if (mode) {
        if (!modeEl) {
          modeEl = document.createElement('div');
          el.appendChild(modeEl);
        }
        modeEl.className = 'p-mode' + (st.tone ? ' ' + st.tone : '');
        modeEl.textContent = mode;
      } else if (modeEl) {
        modeEl.remove();
      }
      const maxBit = rpnlIsPairHedge(r) ? '' : rpnlPillMax(r);
      let maxEl = el.querySelector('.p-max');
      if (maxBit) {
        if (!maxEl) {
          maxEl = document.createElement('div');
          maxEl.className = 'p-max';
          const valEl = el.querySelector('.p-val');
          if (valEl && valEl.nextSibling) el.insertBefore(maxEl, valEl.nextSibling);
          else el.appendChild(maxEl);
        }
        maxEl.textContent = maxBit;
      } else if (maxEl) {
        maxEl.remove();
      }
      const walletBit = rpnlPillWallet(r);
      let balEl = el.querySelector('.p-bal');
      if (walletBit) {
        if (!balEl) {
          balEl = document.createElement('div');
          balEl.className = 'p-bal';
          const after = el.querySelector('.p-max') || el.querySelector('.p-val');
          if (after && after.nextSibling) el.insertBefore(balEl, after.nextSibling);
          else el.appendChild(balEl);
        }
        balEl.textContent = walletBit;
      } else if (balEl) {
        balEl.remove();
      }
      const geomBit = rpnlIsPairHedge(r) ? '' : rpnlPillGeom(r);
      let geomEl = el.querySelector('.p-geom');
      if (geomBit) {
        if (!geomEl) {
          geomEl = document.createElement('div');
          geomEl.className = 'p-geom';
          const after = el.querySelector('.p-bal') || el.querySelector('.p-max') || el.querySelector('.p-val');
          if (after && after.nextSibling) el.insertBefore(geomEl, after.nextSibling);
          else el.appendChild(geomEl);
        }
        geomEl.textContent = geomBit;
        geomEl.title = (r.settings && r.settings.geom) || geomBit;
      } else if (geomEl) {
        geomEl.remove();
      }
      const nameEl = el.querySelector('.p-name');
      if (nameEl) {
        const dot = nameEl.querySelector('.p-live');
        if (r.live || rpnlIsBooting(r)) {
          const stDot = rpnlIsBooting(r)
            ? { key: 'booting', label: rpnlBootLabel(r) }
            : (rpnlIsPairHedge(r) ? { key: '', label: 'Hedge' } : rpnlDashStatus(r.settings));
          if (!dot) nameEl.insertAdjacentHTML('afterbegin', rpnlLiveDot(r));
          else {
            dot.className = 'p-live' + (stDot.key ? ' ' + stDot.key : '');
            dot.title = stDot.label || 'Live';
          }
        } else if (dot) dot.remove();
        const qsym = r.quote_symbol || r.contract;
        let symEl = nameEl.querySelector('.p-sym');
        if (symEl) symEl.textContent = qsym || '';
        const acct = rpnlPillAcctText(r, nameCount);
        let acctEl = nameEl.querySelector('.rpnl-acct');
        if (acct) {
          if (!acctEl) {
            acctEl = document.createElement('span');
            acctEl.className = 'rpnl-acct';
            const after = nameEl.querySelector('.p-sym');
            if (after && after.nextSibling) nameEl.insertBefore(acctEl, after.nextSibling);
            else nameEl.appendChild(acctEl);
          }
          acctEl.textContent = acct;
        } else if (acctEl) {
          acctEl.remove();
        }
        let stratEl = nameEl.querySelector('.rpnl-strat');
        if (r.strategy) {
          if (!stratEl) {
            stratEl = document.createElement('span');
            stratEl.className = 'rpnl-strat';
            const venueEl = nameEl.querySelector('.rpnl-venue');
            if (venueEl) nameEl.insertBefore(stratEl, venueEl);
            else nameEl.appendChild(stratEl);
          }
          stratEl.textContent = r.strategy;
        } else if (stratEl) {
          stratEl.remove();
        }
        let hedgeTag = nameEl.querySelector('.rpnl-hedge');
        if (rpnlIsPairHedge(r)) {
          if (!hedgeTag) {
            hedgeTag = document.createElement('span');
            hedgeTag.className = 'rpnl-hedge';
            hedgeTag.textContent = 'Hedge';
            const venueEl = nameEl.querySelector('.rpnl-venue');
            if (venueEl) nameEl.insertBefore(hedgeTag, venueEl);
            else nameEl.appendChild(hedgeTag);
          }
        } else if (hedgeTag) {
          hedgeTag.remove();
        }
        let setupBtn = nameEl.querySelector('[data-ri-setup]');
        if (!rpnlIsPairHedge(r) && r.settings) {
          if (!setupBtn) {
            nameEl.insertAdjacentHTML('beforeend', rpnlPillSetupBtn(r, cur));
            setupBtn = nameEl.querySelector('[data-ri-setup]');
          }
          const mine = el.dataset.rpnlKey === cur && riSetupOpen;
          if (setupBtn) {
            setupBtn.classList.toggle('on', mine);
            setupBtn.setAttribute('aria-expanded', mine ? 'true' : 'false');
          }
        } else if (setupBtn) {
          setupBtn.remove();
        }
      }
      const hedgeOf = rpnlHedgeOf(r);
      const via = r.settings && r.settings.hedge_via;
      const hedgeNote = rpnlIsPairHedge(r) && hedgeOf
        ? 'of ' + hedgeOf
        : (!rpnlIsPairHedge(r) && via ? 'hedged by ' + via : '');
      let hedgeLine = el.querySelector('.p-hedge');
      if (hedgeNote) {
        if (!hedgeLine) {
          hedgeLine = document.createElement('div');
          const valEl = el.querySelector('.p-val');
          if (valEl && valEl.nextSibling) el.insertBefore(hedgeLine, valEl.nextSibling);
          else el.appendChild(hedgeLine);
        }
        hedgeLine.className = 'p-hedge' + (rpnlIsPairHedge(r) ? '' : ' via');
        hedgeLine.textContent = hedgeNote;
        hedgeLine.title = rpnlIsPairHedge(r) ? hedgeOf : (via || '');
      } else if (hedgeLine) {
        hedgeLine.remove();
      }
    });
  }
  if (!wrap.dataset.bound) {
    wrap.dataset.bound = '1';
    wrap.addEventListener('click', ev => {
      const pill = ev.target.closest('[data-rpnl-key]');
      if (!pill) return;
      const key = pill.dataset.rpnlKey;
      const cur = (document.getElementById('rpnlSymbol') || {}).value || '';
      if (ev.target.closest('[data-ri-setup]')) {
        ev.preventDefault();
        ev.stopPropagation();
        if (key === cur) {
          setRiSetupOpen(!riSetupOpen);
          return;
        }
        riSetupOpen = true;
        pickRpnlContract(key, { keepSetup: true });
        return;
      }
      if (key !== cur) riSetupOpen = false;
      pickRpnlContract(key);
    });
    wrap.addEventListener('keydown', ev => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      if (ev.target.closest('[data-ri-setup]')) return;
      const pill = ev.target.closest('[data-rpnl-key]');
      if (!pill) return;
      ev.preventDefault();
      pickRpnlContract(pill.dataset.rpnlKey);
    });
  }
  renderRpnlInspect(currentRpnlRow(rows));
  applyOhlcOrderLines(quotesForCurrentRpnl(rows));
}

function pillOptionLabel(r) {
  const acct = rpnlAccountLabel(r);
  return (r.quote_symbol || r.contract || '') +
    (r.quote_label ? ' · ' + r.quote_label : '') +
    (acct ? ' · ' + acct : '') +
    (r.strategy ? ' · ' + r.strategy : '');
}

// Returns the <option> for a key, creating it when the dropdown doesn't have it.
function ensureRpnlOption(key, label) {
  const sel = document.getElementById('rpnlSymbol');
  if (!sel || !key) return null;
  let opt = [...sel.options].find(o => o.value === key);
  if (!opt) {
    const placeholder = [...sel.options].find(o => !o.value);
    if (placeholder) placeholder.remove();
    opt = document.createElement('option');
    opt.value = key;
    opt.textContent = label || key.replace('::', ' · ');
    sel.appendChild(opt);
  }
  return opt;
}

function pickRpnlContract(key, opts) {
  const sel = document.getElementById('rpnlSymbol');
  if (!sel) return;
  if (!(opts && opts.keepSetup)) riSetupOpen = false;
  ensureRpnlOption(key, '');
  sel.value = key;
  loadRpnlFresh();
}

function nearestByTime(arr, t) {
  if (!arr || !arr.length) return null;
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].time < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(arr[lo - 1].time - t) <= Math.abs(arr[lo].time - t)) return arr[lo - 1];
  return arr[lo];
}

function rpnlDataBounds() {
  const times = [];
  if (ohlcBarsCache.length) {
    times.push(ohlcBarsCache[0].time, ohlcBarsCache[ohlcBarsCache.length - 1].time);
  }
  if (rpnlPtsCache.length) {
    times.push(rpnlPtsCache[0].time, rpnlPtsCache[rpnlPtsCache.length - 1].time);
  }
  if (rpnlHedgeCache.length) {
    times.push(rpnlHedgeCache[0].time, rpnlHedgeCache[rpnlHedgeCache.length - 1].time);
  }
  if (!times.length) return null;
  return { from: Math.min.apply(null, times), to: Math.max.apply(null, times) };
}

// Map cumulative rPnL onto OHLC candle times so both charts have the same
// bar count. LWC spaces bars by index, not calendar time — mismatched counts
// make timestamps sit at different x positions even in the same window.
function alignRpnlToBars(rpnlPts, bars, prevAligned) {
  if (!bars.length) return rpnlPts;
  const prevMap = prevAligned && prevAligned.length
    ? new Map(prevAligned.map(p => [p.time, p.value])) : null;
  if (!rpnlPts.length) {
    if (prevMap) return bars.map(b => ({ time: b.time, value: prevMap.has(b.time) ? prevMap.get(b.time) : 0 }));
    return bars.map(b => ({ time: b.time, value: 0 }));
  }
  let i = 0;
  let last = 0;
  const firstT = rpnlPts[0].time;
  const out = [];
  for (const b of bars) {
    while (i < rpnlPts.length && rpnlPts[i].time <= b.time) {
      last = rpnlPts[i].value;
      i++;
    }
    let value;
    if (b.time < firstT) {
      value = prevMap && prevMap.has(b.time) ? prevMap.get(b.time) : 0;
    } else {
      value = last;
    }
    out.push({ time: b.time, value });
  }
  return out;
}

function rpnlBeginSync(origin) {
  rpnlSyncing = true;
  rpnlSyncOrigin = origin || '*';
  const gen = ++rpnlSyncGen;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (gen !== rpnlSyncGen) return;
      rpnlSyncing = false;
      rpnlSyncOrigin = null;
    });
  });
}

function rpnlRangeIsEcho(chartId, range) {
  if (!range) return true;
  if (rpnlSyncOrigin === '*') return true;
  if (!rpnlSyncing) return false;
  if (chartId === rpnlSyncOrigin) return false;
  return !!(rpnlLastPush.origin &&
    Math.abs(range.from - rpnlLastPush.from) < 0.25 &&
    Math.abs(range.to - rpnlLastPush.to) < 0.25);
}

function scheduleRpnlAlign(origin) {
  if (origin === 'ohlc' || origin === 'rpnl') rpnlSyncPrefer = origin;
  clearTimeout(rpnlAlignTimer);
  rpnlAlignTimer = setTimeout(() => alignRpnlTimeScales(rpnlSyncPrefer), 40);
}

function alignRpnlTimeScales(preferred) {
  if (alignRpnlTimeScales._lock || !ohlcChart || !rpnlChart) return;
  const srcId = preferred === 'rpnl' ? 'rpnl' : 'ohlc';
  const src = srcId === 'rpnl' ? rpnlChart : ohlcChart;
  const dst = srcId === 'rpnl' ? ohlcChart : rpnlChart;
  let a, b;
  try {
    a = src.timeScale().getVisibleLogicalRange();
    b = dst.timeScale().getVisibleLogicalRange();
  } catch (e) { return; }
  if (!a || !(a.to > a.from)) return;
  if (b && Math.abs(b.from - a.from) < 0.04 && Math.abs(b.to - a.to) < 0.04) return;
  alignRpnlTimeScales._lock = true;
  rpnlLastPush = { from: a.from, to: a.to, origin: srcId };
  rpnlBeginSync(srcId);
  try {
    dst.timeScale().setVisibleLogicalRange({ from: a.from, to: a.to });
  } catch (e) {}
  requestAnimationFrame(() => {
    requestAnimationFrame(() => { alignRpnlTimeScales._lock = false; });
  });
}

function syncRpnlTimeScale(origin, range) {
  if (!ohlcChart || !rpnlChart) return;
  const src = origin === 'ohlc' ? ohlcChart : rpnlChart;
  const dst = origin === 'ohlc' ? rpnlChart : ohlcChart;
  const logical = range || src.timeScale().getVisibleLogicalRange();
  if (!logical) return;
  try {
    const dstLogical = dst.timeScale().getVisibleLogicalRange();
    if (dstLogical &&
        Math.abs(dstLogical.from - logical.from) < 0.04 &&
        Math.abs(dstLogical.to - logical.to) < 0.04) {
      scheduleRpnlAlign(origin);
      return;
    }
  } catch (e) {}
  rpnlSyncPrefer = origin;
  rpnlLastPush = { from: logical.from, to: logical.to, origin };
  rpnlBeginSync(origin);
  try {
    dst.timeScale().setVisibleLogicalRange({ from: logical.from, to: logical.to });
  } catch (e) { /* not ready */ }
  scheduleRpnlAlign(origin);
}

function onRpnlLogicalRange(chartId) {
  return function (range) {
    if (!range) return;
    // Fit wraps itself in a sync echo. That echo is the first time the visible
    // range actually matches the loaded window, so high/low still has to move.
    if (rpnlRangeIsEcho(chartId, range)) {
      if (chartId === 'ohlc') updateOhlcHiLo();
      return;
    }
    if (rpnlUserInput) rpnlMarkUserView();
    else rpnlMaybeDetachFromLive();
    syncRpnlTimeScale(chartId, range);
    const src = chartId === 'ohlc' ? ohlcChart : rpnlChart;
    const timeRange = src.timeScale().getVisibleRange();
    if (timeRange) maybeExtendRpnl(timeRange);
    if (!rpnlRangePinned && !rpnlSelectMode) rpnlSyncRangeFromView();
    rpnlPaintBrush();
    if (chartId === 'ohlc') {
      updateOhlcHiLo();
      syncOhlcGoLive();
    }
  };
}

function maybeExtendRpnl(range) {
  return;
}

function fillMarkersFromFills(fills, bars, hedgeOnly) {
  const qv = (rpnlMeta.quote_venue || 'delta').toLowerCase();
  let list = (fills || []).filter(f => {
    const ex = (f.exchange || 'delta').toLowerCase();
    const isQuote = ex === qv;
    return hedgeOnly ? !isQuote : isQuote;
  });
  if (list.length > 300) list = list.filter(f => Math.abs(f.rpnl) > 1e-9);
  const byT = new Map();
  for (const f of list) {
    const raw = f.time;
    const snap = bars && bars.length ? nearestByTime(bars, raw) : null;
    const t = snap ? snap.time : raw;
    const prev = byT.get(t);
    if (!prev || Math.abs(f.rpnl) >= Math.abs(prev.rpnl)) byT.set(t, Object.assign({}, f, { _t: t }));
  }
  // Labelling every fill turns the chart into a wall of text — only the
  // biggest moves get a number, the rest stay as plain markers.
  const marks = [...byT.values()];
  const labelled = new Set(
    marks.slice()
      .sort((a, b) => Math.abs(b.rpnl) - Math.abs(a.rpnl))
      .slice(0, 25)
      .map(f => f._t)
  );
  return marks.map(f => {
    const win = f.rpnl > 1e-6, lose = f.rpnl < -1e-6;
    const show = labelled.has(f._t) && (win || lose);
    return {
      time: f._t,
      position: f.side === 'buy' ? 'belowBar' : 'aboveBar',
      color: hedgeOnly ? '#ff9800' : (win ? '#26a69a' : (lose ? '#ef5350' : '#7f8598')),
      shape: hedgeOnly ? 'circle' : (f.side === 'buy' ? 'arrowUp' : 'arrowDown'),
      size: show ? 1 : 0.6,
      text: show ? ((f.rpnl >= 0 ? '+' : '−') + Math.abs(Math.round(f.rpnl))) : '',
    };
  }).sort((a, b) => a.time - b.time);
}

function applyRpnlFillMarkers() {
  const fills = ohlcShowFills ? (rpnlFillsCache || []) : [];
  const snap = rpnlPtsCache.length ? rpnlPtsCache : ohlcBarsCache;
  const venue = currentRpnlVenue();
  const deltaMarks = venue === 'hedge' ? [] : fillMarkersFromFills(fills, snap, false);
  const hedgeMarks = (venue === 'quote' || !rpnlMeta.has_hedge)
    ? [] : fillMarkersFromFills(fills, snap, true);
  const sig = rpnlView + '|' + JSON.stringify([deltaMarks, hedgeMarks]);
  if (sig === rpnlMarkerSig) return;
  rpnlMarkerSig = sig;
  try {
    if (rpnlView === 'cumul') {
      if (rpnlSeries) rpnlSeries.setMarkers(deltaMarks);
      if (rpnlHistSeries) rpnlHistSeries.setMarkers([]);
      if (rpnlHedgeSeries) rpnlHedgeSeries.setMarkers(hedgeMarks);
    } else {
      if (rpnlSeries) rpnlSeries.setMarkers([]);
      if (rpnlHedgeSeries) rpnlHedgeSeries.setMarkers([]);
      if (rpnlHistSeries) rpnlHistSeries.setMarkers([]);
    }
  } catch (e) {}
}

function loadRpnlFresh() {
  saveRpnlPrefs();
  rpnlCurrentHours = null;
  rpnlFollowView();
  rpnlResumeLiveFollow();
  loadRpnl(false);
}

function rpnlPageVisible() {
  const page = document.getElementById('rpnl');
  return !!(page && page.classList.contains('visible'));
}

function fitRpnlView() {
  if (!ohlcChart || !rpnlChart) return;
  rpnlResetPriceZoom(ohlcChart);
  rpnlResetPriceZoom(rpnlChart);
  rpnlResumeLiveFollow();
  applyRpnlChartSize();
  rpnlBeginSync();
  try {
    rpnlApplyLiveEdgePad();
    ohlcChart.timeScale().fitContent();
    rpnlChart.timeScale().fitContent();
  } catch (e) {}
  updateOhlcHiLo();
  syncOhlcGoLive();
}

// Double-click reset. Y-axis click restores that pane's price autoscale; a click
// on the chart body refits both panes together (replaces the built-in reset,
// which only refit one pane and left the two panes a wrong, mismatched size).
function rpnlResetDblClick(ev) {
  const el = ev && ev.currentTarget;
  if (!el) return;
  if (rpnlTouchOnYAxis(el, ev.clientX)) {
    const chart = el.id === 'rpnlChart' ? rpnlChart : ohlcChart;
    rpnlResetPriceZoom(chart);
    if (chart === rpnlChart && !rpnlAutoY) { rpnlAutoY = true; syncRpnlViewButtons(); }
    return;
  }
  fitRpnlView();
}

function bindRpnlDblReset() {
  ['ohlcChart', 'rpnlChart'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el || el.dataset.dblReset) return;
    el.dataset.dblReset = '1';
    el.addEventListener('dblclick', rpnlResetDblClick);
  });
}

function rpnlLogicalLooksUnfitted() {
  const n = Math.max(ohlcBarsCache.length, rpnlPtsCache.length);
  if (!n || !ohlcChart) return false;
  try {
    const vr = ohlcChart.timeScale().getVisibleLogicalRange();
    if (!vr) return true;
    const span = vr.to - vr.from;
    if (!(span > 0.5)) return true;
    // Broken first-paint only — not normal zoom/pan (from can be < 0 with padding).
    if (span > n * 3 + 40) return true;
    return false;
  } catch (e) { return true; }
}

function captureRpnlView() {
  if (!ohlcChart) return null;
  try {
    const logical = ohlcChart.timeScale().getVisibleLogicalRange();
    if (!logical || !(logical.to > logical.from)) return null;
    return { logical: { from: logical.from, to: logical.to } };
  } catch (e) { return null; }
}

function freezeRpnlView(snap) {
  // Camera is the logical range. Never re-apply rightOffset — LWC treats that
  // option as "pin the last bar this many slots from the right edge".
}

function restoreRpnlView(snap) {
  if (!snap || !snap.logical || !ohlcChart || !rpnlChart) return false;
  rpnlBeginSync();
  try {
    const logical = { from: snap.logical.from, to: snap.logical.to };
    ohlcChart.timeScale().setVisibleLogicalRange(logical);
    rpnlChart.timeScale().setVisibleLogicalRange(logical);
  } catch (e) {
    return false;
  }
  return true;
}

function rpnlDatumEq(a, b) {
  if (!a || !b || a.time !== b.time) return false;
  if ('value' in a || 'value' in b) return a.value === b.value && a.color === b.color;
  return a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close
    && (a.volume || 0) === (b.volume || 0);
}

function rpnlMergeByTime(prev, next) {
  if (!next || !next.length) return (prev || []).slice();
  if (!prev || !prev.length) return next.slice();
  const map = new Map();
  for (let i = 0; i < prev.length; i++) map.set(prev[i].time, prev[i]);
  for (let i = 0; i < next.length; i++) map.set(next[i].time, next[i]);
  const out = Array.from(map.values()).sort((a, b) => a.time - b.time);
  const cap = 10000;
  if (out.length > cap + 400) return out.slice(out.length - cap);
  return out;
}

function rpnlShiftLogical(snap, prev, next) {
  if (!snap || !snap.logical || !prev || !next || !prev.length || !next.length) return snap;
  if (prev[0].time === next[0].time) return snap;
  let dropped = 0;
  while (dropped < prev.length && prev[dropped].time < next[0].time) dropped++;
  if (!dropped) return snap;
  return {
    logical: { from: snap.logical.from - dropped, to: snap.logical.to - dropped },
  };
}

function rpnlDefaultRightOffset() {
  return window.matchMedia('(max-width: 720px)').matches ? 2 : 4;
}

function rpnlApplyTimeScaleOpts(opts) {
  if (!ohlcChart) return;
  try { ohlcChart.timeScale().applyOptions(opts); } catch (e) {}
  try { if (rpnlChart) rpnlChart.timeScale().applyOptions(opts); } catch (e) {}
}

function rpnlAtLiveEdge() {
  if (!ohlcChart || !ohlcBarsCache.length) return true;
  try {
    const vr = ohlcChart.timeScale().getVisibleLogicalRange();
    if (!vr) return true;
    const last = ohlcBarsCache.length - 1;
    return vr.to >= last - 0.35;
  } catch (e) { return true; }
}

let rpnlFollowLive = true;
let rpnlUserInput = false;
let rpnlLiveShiftOn = false;
let rpnlFollowGuard = 0;

function rpnlMarkUserView() {
  if (rpnlSyncing && !rpnlUserInput) return;
  if (!rpnlUserInput && Date.now() < rpnlFollowGuard) return;
  rpnlNeedsFit = false;
  clearTimeout(rpnlFitTimer);
  if (!rpnlFollowLive) {
    rpnlSetLiveShift(false);
    syncOhlcGoLive();
    return;
  }
  rpnlFollowLive = false;
  rpnlSetLiveShift(false);
  syncOhlcGoLive();
}

function rpnlMaybeDetachFromLive() {
  if (!rpnlFollowLive || rpnlSyncing || rpnlLoadBusy || rpnlHoldSnap) return;
  if (Date.now() < rpnlFollowGuard) return;
  if (!ohlcBarsCache.length) return;
  if (!rpnlAtLiveEdge()) rpnlMarkUserView();
}

function rpnlResumeLiveFollow() {
  rpnlFollowLive = true;
  rpnlFollowGuard = Date.now() + 700;
  rpnlSetLiveShift(true);
  syncOhlcGoLive();
}

function rpnlApplyLiveEdgePad() {
  rpnlLiveShiftOn = true;
  rpnlApplyTimeScaleOpts({
    shiftVisibleRangeOnNewBar: true,
    rightOffset: rpnlDefaultRightOffset(),
  });
}

function bindRpnlUserCamera() {
  if (bindRpnlUserCamera._bound) return;
  bindRpnlUserCamera._bound = true;
  const mark = (ev) => {
    rpnlUserInput = true;
    const t = ev && ev.target && ev.target.closest && ev.target.closest('#rpnlChart, #ohlcChart');
    if (t) rpnlSyncPrefer = t.id === 'rpnlChart' ? 'rpnl' : 'ohlc';
  };
  const clear = () => {
    clearTimeout(bindRpnlUserCamera._clr);
    bindRpnlUserCamera._clr = setTimeout(() => { rpnlUserInput = false; }, 320);
  };
  const stack = document.querySelector('#rpnl .rp-charts');
  const targets = [stack, document.getElementById('ohlcChart'), document.getElementById('rpnlChart')]
    .filter(Boolean);
  const opts = { capture: true, passive: true };
  targets.forEach(el => {
    el.addEventListener('pointerdown', mark, opts);
    el.addEventListener('wheel', mark, opts);
    el.addEventListener('touchstart', mark, opts);
    el.addEventListener('gesturestart', mark, opts);
  });
  window.addEventListener('pointerup', clear);
  window.addEventListener('pointercancel', clear);
  bindRpnlYScaleMode();
}

function rpnlMobileYAxis() {
  return window.matchMedia('(max-width: 720px)').matches;
}
function rpnlPriceAxisWidth(chart) {
  try {
    const w = chart && chart.priceScale('right') && chart.priceScale('right').width();
    if (w && w > 8) return w;
  } catch (e) {}
  return rpnlMobileYAxis() ? 62 : 58;
}
function rpnlTouchOnYAxis(el, clientX) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const chart = el.id === 'rpnlChart' ? rpnlChart : ohlcChart;
  return clientX >= (r.right - rpnlPriceAxisWidth(chart) - 12);
}
function setRpnlYScaleMode(el, on) {
  if (!el) return;
  on = !!on;
  el.classList.toggle('y-scale', on);
  const pane = el.closest('.rp-pane');
  if (pane) pane.classList.toggle('y-scale', on);
}
function clearRpnlYScaleMode() {
  ['ohlcChart', 'rpnlChart'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) setRpnlYScaleMode(el, false);
  });
}
// This chart build has no priceScale.setVisibleRange. Manual Y zoom is held
// by the series autoscale provider, which the library actually applies.
let ohlcPriceLock = null;
let rpnlPriceLock = null;
function rpnlPriceMargins(chart) {
  if (chart === ohlcChart) return { top: 0.1, bottom: ohlcShowVol ? 0.18 : 0.05 };
  return { top: 0.1, bottom: 0.08 };
}
function ohlcWrapAutoscale(base) {
  return function (original) {
    if (ohlcPriceLock && ohlcPriceLock.max > ohlcPriceLock.min) {
      return { priceRange: { minValue: ohlcPriceLock.min, maxValue: ohlcPriceLock.max } };
    }
    if (typeof base === 'function') return base(original);
    return typeof original === 'function' ? original() : null;
  };
}
function ohlcInstallPriceLock() {
  if (!ohlcChart || ohlcInstallPriceLock._done) return;
  ohlcInstallPriceLock._done = true;
  [ohlcSeries, ohlcBarSeries, ohlcLineSeries, ohlcAreaSeries,
    ohlcQuoteMarkerSeries, ohlcHedgeMarkerSeries].forEach(s => {
    if (s) s.applyOptions({ autoscaleInfoProvider: ohlcWrapAutoscale(null) });
  });
  Object.keys(ohlcMaSeries || {}).forEach(p => {
    if (ohlcMaSeries[p]) ohlcMaSeries[p].applyOptions({ autoscaleInfoProvider: ohlcWrapAutoscale(null) });
  });
}
function ohlcNudgeScale() {
  if (!ohlcChart) return;
  try { ohlcChart.priceScale('right').applyOptions({ autoScale: true, scaleMargins: rpnlPriceMargins(ohlcChart) }); } catch (e) {}
  const s = typeof ohlcActiveSeries === 'function' ? ohlcActiveSeries() : ohlcSeries;
  const bar = ohlcBarsCache && ohlcBarsCache[ohlcBarsCache.length - 1];
  if (!s || !bar) return;
  try {
    if (ohlcStyle === 'line' || ohlcStyle === 'area') s.update({ time: bar.time, value: bar.close });
    else s.update(bar);
  } catch (e) {}
}
function chartReadPriceSpan(chart, el, series) {
  if (!chart || !series || !el) return null;
  let timeH = 0;
  try { timeH = chart.timeScale().height() || 0; } catch (e) {}
  const paneH = Math.max(8, (el.clientHeight || 0) - timeH);
  let top = null, bot = null;
  try {
    top = series.coordinateToPrice(1);
    bot = series.coordinateToPrice(paneH - 2);
  } catch (e) {}
  if (top == null || bot == null || !isFinite(top) || !isFinite(bot)) return null;
  const min = Math.min(top, bot);
  const max = Math.max(top, bot);
  if (!(max > min)) return null;
  return { min: min, max: max };
}
function ohlcReadPriceSpan() {
  const s = typeof ohlcActiveSeries === 'function' ? ohlcActiveSeries() : ohlcSeries;
  return chartReadPriceSpan(ohlcChart, document.getElementById('ohlcChart'), s);
}
function rpnlActiveValueSeries() {
  if (rpnlView === 'bucket' && rpnlHistSeries) return rpnlHistSeries;
  try {
    if (rpnlNetSeries && rpnlNetSeries.options().visible) return rpnlNetSeries;
    if (rpnlSeries && rpnlSeries.options().visible) return rpnlSeries;
    if (rpnlHedgeSeries && rpnlHedgeSeries.options().visible) return rpnlHedgeSeries;
  } catch (e) {}
  return rpnlSeries || rpnlHedgeSeries || rpnlHistSeries;
}
function rpnlReadPriceSpan() {
  return chartReadPriceSpan(rpnlChart, document.getElementById('rpnlChart'), rpnlActiveValueSeries());
}
function chartZoomSpan(range, factor, log) {
  if (!range || !(factor > 0)) return null;
  if (log && range.min > 0 && range.max > 0) {
    const a = Math.log(range.min);
    const b = Math.log(range.max);
    const mid = (a + b) / 2;
    const half = Math.max(1e-8, (b - a) / 2 * factor);
    const min = Math.exp(mid - half);
    const max = Math.exp(mid + half);
    if (!(max > min) || !isFinite(min) || !isFinite(max)) return null;
    return { min: min, max: max };
  }
  const mid = (range.min + range.max) / 2;
  const half = (range.max - range.min) / 2 * factor;
  if (!(half > 0) || !isFinite(mid)) return null;
  return { min: mid - half, max: mid + half };
}
function ohlcZoomSpan(range, factor) {
  return chartZoomSpan(range, factor, !!ohlcLogScale);
}
function rpnlWrapAutoscale(base) {
  return function (original) {
    if (rpnlPriceLock && rpnlPriceLock.max > rpnlPriceLock.min) {
      return { priceRange: { minValue: rpnlPriceLock.min, maxValue: rpnlPriceLock.max } };
    }
    if (typeof base === 'function') return base(original);
    return typeof original === 'function' ? original() : null;
  };
}
function rpnlInstallPriceLock() {
  if (!rpnlChart || rpnlInstallPriceLock._done) return;
  rpnlInstallPriceLock._done = true;
  [rpnlSeries, rpnlHistSeries, rpnlHedgeSeries, rpnlNetSeries].forEach(s => {
    if (s) s.applyOptions({ autoscaleInfoProvider: rpnlWrapAutoscale(null) });
  });
}
function rpnlNudgeScale() {
  if (!rpnlChart) return;
  try { rpnlChart.priceScale('right').applyOptions({ autoScale: true, scaleMargins: rpnlPriceMargins(rpnlChart) }); } catch (e) {}
  const s = rpnlActiveValueSeries();
  if (!s) return;
  if (s === rpnlHistSeries) {
    const venue = typeof currentRpnlVenue === 'function' ? currentRpnlVenue() : 'quote';
    const src = venue === 'hedge' ? (rpnlHedgeCache || []) : (rpnlPtsCache || []);
    const i = src.length - 1;
    if (i < 0) return;
    const val = i === 0 ? src[i].value : parseFloat((src[i].value - src[i - 1].value).toFixed(4));
    try {
      s.update({ time: src[i].time, value: val, color: val >= 0 ? 'rgba(38,166,154,0.85)' : 'rgba(239,83,80,0.85)' });
    } catch (e) {}
    return;
  }
  let pt = null;
  if (s === rpnlHedgeSeries) pt = rpnlHedgeCache && rpnlHedgeCache[rpnlHedgeCache.length - 1];
  else if (s === rpnlNetSeries) {
    const net = (typeof netFromCaches === 'function') ? netFromCaches(rpnlPtsCache, rpnlHedgeCache) : [];
    pt = net[net.length - 1];
  } else pt = rpnlPtsCache && rpnlPtsCache[rpnlPtsCache.length - 1];
  if (!pt) return;
  try { s.update({ time: pt.time, value: pt.value }); } catch (e) {}
}
function rpnlResetPriceZoom(chart) {
  if (!chart) return;
  if (chart === ohlcChart) {
    ohlcPriceLock = null;
    ohlcNudgeScale();
    return;
  }
  if (chart === rpnlChart) {
    rpnlPriceLock = null;
    rpnlAutoY = true;
    rpnlNudgeScale();
    if (typeof syncRpnlViewButtons === 'function') syncRpnlViewButtons();
    return;
  }
  try {
    chart.priceScale('right').applyOptions({ autoScale: true, scaleMargins: rpnlPriceMargins(chart) });
  } catch (e) {}
}
function rpnlZoomPriceScale(chart, dy, h) {
  if (chart !== ohlcChart || !dy) return;
  const range = ohlcPriceLock
    ? { min: ohlcPriceLock.min, max: ohlcPriceLock.max }
    : ohlcReadPriceSpan();
  if (!range) return;
  const factor = Math.exp(dy / Math.max(160, (h || 240) * 0.48));
  const next = ohlcZoomSpan(range, factor);
  if (!next) return;
  ohlcPriceLock = next;
  ohlcNudgeScale();
}
function bindChartYHit(hit, read, applyRange, reset) {
  if (!hit || hit.dataset.bound) return;
  hit.dataset.bound = '1';
  let drag = null;
  let tap = null;
  let lastTap = 0;
  hit.addEventListener('touchstart', (ev) => {
    if (rpnlSelectMode || ev.touches.length !== 1) { drag = null; return; }
    const t = ev.touches[0];
    const range = read();
    if (!range) return;
    drag = { y: t.clientY, range: range };
    tap = { x: t.clientX, y: t.clientY, t: Date.now() };
  }, { passive: true });
  hit.addEventListener('touchmove', (ev) => {
    if (!drag || ev.touches.length !== 1) return;
    const dy = ev.touches[0].clientY - drag.y;
    if (Math.abs(dy) < 1) return;
    if (ev.cancelable) ev.preventDefault();
    const h = hit.clientHeight || 240;
    let factor = Math.exp(dy / Math.max(160, h * 0.48));
    factor = Math.max(1 / 60, Math.min(60, factor));
    applyRange(drag.range, factor);
    tap = null;
  }, { passive: false });
  const endTouch = (ev) => {
    const t = ev.changedTouches && ev.changedTouches[0];
    if (tap && t && Math.abs(t.clientX - tap.x) < 14 && Math.abs(t.clientY - tap.y) < 14 && (Date.now() - tap.t) < 350) {
      const now = Date.now();
      if (lastTap && now - lastTap < 320) {
        reset();
        lastTap = 0;
      } else lastTap = now;
    }
    drag = null;
    tap = null;
  };
  hit.addEventListener('touchend', endTouch, { passive: true });
  hit.addEventListener('touchcancel', () => { drag = null; tap = null; }, { passive: true });
}
function bindOhlcYHit() {
  bindChartYHit(
    document.getElementById('ohlcYHit'),
    ohlcReadPriceSpan,
    function (range, factor) {
      const next = ohlcZoomSpan(range, factor);
      if (!next) return;
      ohlcPriceLock = next;
      ohlcNudgeScale();
    },
    function () { rpnlResetPriceZoom(ohlcChart); }
  );
}
function bindRpnlYHit() {
  bindChartYHit(
    document.getElementById('rpnlYHit'),
    rpnlReadPriceSpan,
    function (range, factor) {
      const next = chartZoomSpan(range, factor, false);
      if (!next) return;
      rpnlPriceLock = next;
      rpnlAutoY = false;
      rpnlNudgeScale();
      if (typeof syncRpnlViewButtons === 'function') syncRpnlViewButtons();
    },
    function () { rpnlResetPriceZoom(rpnlChart); }
  );
}
function bindRpnlYScaleMode() {
  if (bindRpnlYScaleMode._bound) return;
  bindRpnlYScaleMode._bound = true;
  ['ohlcChart', 'rpnlChart'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    let ax = 0, ay = 0, lastY = 0, t0 = 0;
    el.addEventListener('touchstart', (ev) => {
      const t = ev.changedTouches && ev.changedTouches[0];
      if (!t) return;
      ax = t.clientX; ay = t.clientY; lastY = t.clientY; t0 = Date.now();
    }, { passive: true });
    el.addEventListener('touchmove', (ev) => {
      if (!el.classList.contains('y-scale') || !ev.touches || !ev.touches[0]) return;
      const t = ev.touches[0];
      const dx = t.clientX - ax;
      const dy = t.clientY - lastY;
      if (Math.abs(t.clientY - ay) <= Math.abs(dx) && Math.abs(dx) > 6) return;
      if (Math.abs(dy) < 1) return;
      ev.preventDefault();
      const chart = el.id === 'rpnlChart' ? rpnlChart : ohlcChart;
      rpnlZoomPriceScale(chart, dy, el.clientHeight);
      lastY = t.clientY;
    }, { passive: false });
    el.addEventListener('touchend', (ev) => {
      if (!rpnlMobileYAxis() || el.id === 'ohlcChart' || el.id === 'rpnlChart') return;
      const t = ev.changedTouches && ev.changedTouches[0];
      if (!t) return;
      const tap = Math.abs(t.clientX - ax) < 12 && Math.abs(t.clientY - ay) < 12 && (Date.now() - t0) < 450;
      if (!tap) return;
      if (rpnlTouchOnYAxis(el, t.clientX)) {
        setRpnlYScaleMode(el, !el.classList.contains('y-scale'));
      } else if (el.classList.contains('y-scale')) {
        setRpnlYScaleMode(el, false);
      }
    }, { passive: true });
  });
  const mq = window.matchMedia('(max-width: 720px)');
  const onMq = (e) => { if (!e.matches) clearRpnlYScaleMode(); };
  if (mq.addEventListener) mq.addEventListener('change', onMq);
  else if (mq.addListener) mq.addListener(onMq);
  bindOhlcYHit();
  bindRpnlYHit();
}

function rpnlSetLiveShift(on) {
  if (!ohlcChart) return;
  on = !!on;
  if (on === rpnlLiveShiftOn) return;
  rpnlLiveShiftOn = on;
  rpnlApplyTimeScaleOpts({ shiftVisibleRangeOnNewBar: on });
}

function rpnlSetSeriesData(series, next, prev, live) {
  if (!series) return false;
  next = next || [];
  prev = prev || [];
  if (!next.length) {
    if (prev.length) {
      try { series.setData([]); } catch (e) {}
      return true;
    }
    return false;
  }
  if (live && prev.length && prev[0].time === next[0].time && next.length >= prev.length) {
    let i = 0;
    const lim = Math.min(prev.length, next.length);
    while (i < lim && rpnlDatumEq(prev[i], next[i])) i++;
    if (i === next.length) return false;
    if (i >= prev.length - 1) {
      try {
        rpnlSetLiveShift(rpnlFollowLive);
        for (; i < next.length; i++) series.update(next[i]);
        return false;
      } catch (e) { /* full replace */ }
    }
  }
  const snap = live ? (captureRpnlView() || rpnlHoldSnap) : rpnlHoldSnap;
  try { series.setData(next); } catch (e) { return true; }
  if (snap) restoreRpnlView(snap);
  return true;
}

function ohlcActiveSeries() {
  if (ohlcStyle === 'bar' && ohlcBarSeries) return ohlcBarSeries;
  if (ohlcStyle === 'line' && ohlcLineSeries) return ohlcLineSeries;
  if (ohlcStyle === 'area' && ohlcAreaSeries) return ohlcAreaSeries;
  return ohlcSeries;
}

function ohlcLineData(bars) {
  return (bars || []).map(b => ({ time: b.time, value: b.close }));
}

function ohlcSma(bars, period) {
  const out = [];
  if (!bars || bars.length < period) return out;
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= period) sum -= bars[i - period].close;
    if (i >= period - 1) out.push({ time: bars[i].time, value: sum / period });
  }
  return out;
}

function rpnlCandleSecs() {
  const v = (document.getElementById('rpnlCandle') || {}).value || '5m';
  const n = parseInt(v, 10) || 5;
  if (v.indexOf('h') >= 0) return n * 3600;
  if (v.indexOf('d') >= 0) return n * 86400;
  return n * 60;
}

function restoreOhlcPrefs() {
  const style = lsGet(LS_OHLC_STYLE, 'candle');
  if (style === 'candle' || style === 'bar' || style === 'line' || style === 'area') ohlcStyle = style;
  try {
    const ma = JSON.parse(lsGet(LS_OHLC_MA, '{}'));
    if (ma && typeof ma === 'object') {
      [7, 25, 99].forEach(p => { if (p in ma) ohlcMaOn[p] = !!ma[p]; });
    }
  } catch (e) {}
  ohlcShowVol = lsGet(LS_OHLC_VOL, '1') !== '0';
  ohlcShowFills = lsGet(LS_OHLC_FILLS, '1') !== '0';
  ohlcLogScale = lsGet(LS_OHLC_LOG, '0') === '1';
  ohlcShowHiLo = lsGet(LS_OHLC_HILO, '0') === '1';
}

function saveOhlcPrefs() {
  lsSet(LS_OHLC_STYLE, ohlcStyle);
  lsSet(LS_OHLC_MA, JSON.stringify(ohlcMaOn));
  lsSet(LS_OHLC_VOL, ohlcShowVol ? '1' : '0');
  lsSet(LS_OHLC_FILLS, ohlcShowFills ? '1' : '0');
  lsSet(LS_OHLC_LOG, ohlcLogScale ? '1' : '0');
  lsSet(LS_OHLC_HILO, ohlcShowHiLo ? '1' : '0');
}

function syncOhlcToolButtons() {
  const box = document.getElementById('ohlcTools');
  if (!box) return;
  box.querySelectorAll('[data-ohlc-style]').forEach(btn => {
    btn.classList.toggle('on', btn.getAttribute('data-ohlc-style') === ohlcStyle);
  });
  box.querySelectorAll('[data-ohlc-ma]').forEach(btn => {
    const p = parseInt(btn.getAttribute('data-ohlc-ma'), 10);
    btn.classList.toggle('on', !!ohlcMaOn[p]);
  });
  const vol = box.querySelector('[data-ohlc-tog="vol"]');
  const fills = box.querySelector('[data-ohlc-tog="fills"]');
  const log = box.querySelector('[data-ohlc-tog="log"]');
  const hilo = box.querySelector('[data-ohlc-tog="hilo"]');
  if (vol) vol.classList.toggle('on', ohlcShowVol);
  if (fills) fills.classList.toggle('on', ohlcShowFills);
  if (log) log.classList.toggle('on', ohlcLogScale);
  if (hilo) hilo.classList.toggle('on', ohlcShowHiLo);
}

function bindOhlcTools() {
  const box = document.getElementById('ohlcTools');
  if (!box || box.dataset.bound) return;
  box.dataset.bound = '1';
  box.addEventListener('click', ev => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    const style = btn.getAttribute('data-ohlc-style');
    const ma = btn.getAttribute('data-ohlc-ma');
    const tog = btn.getAttribute('data-ohlc-tog');
    if (style) {
      ohlcStyle = style;
      applyOhlcChartStyle();
    } else if (ma) {
      const p = parseInt(ma, 10);
      ohlcMaOn[p] = !ohlcMaOn[p];
      const snap = captureRpnlView();
      if (snap) rpnlHoldSnap = snap;
      applyOhlcMovingAverages(ohlcBarsCache, true);
      if (snap) restoreRpnlView(snap);
      rpnlHoldSnap = null;
    } else if (tog === 'vol') {
      ohlcShowVol = !ohlcShowVol;
      applyOhlcVolVisible();
    } else if (tog === 'fills') {
      ohlcShowFills = !ohlcShowFills;
      ohlcMarkerSig = '';
      rpnlMarkerSig = '';
      applyOhlcFillMarkers();
      applyRpnlFillMarkers();
    } else if (tog === 'log') {
      ohlcLogScale = !ohlcLogScale;
      applyOhlcLogScale();
    } else if (tog === 'hilo') {
      ohlcShowHiLo = !ohlcShowHiLo;
      updateOhlcHiLo();
    } else return;
    saveOhlcPrefs();
    syncOhlcToolButtons();
  });
}

function applyOhlcLogScale() {
  if (!ohlcChart || !window.LightweightCharts) return;
  const mode = ohlcLogScale
    ? LightweightCharts.PriceScaleMode.Logarithmic
    : LightweightCharts.PriceScaleMode.Normal;
  try { ohlcChart.priceScale('right').applyOptions({ mode }); } catch (e) {}
}

function applyOhlcVolVisible() {
  if (ohlcVolSeries) ohlcVolSeries.applyOptions({ visible: ohlcShowVol });
  if (!ohlcChart) return;
  try {
    ohlcChart.priceScale('').applyOptions({
      scaleMargins: { top: ohlcShowVol ? 0.78 : 0.96, bottom: 0 },
    });
    ohlcChart.priceScale('right').applyOptions({
      scaleMargins: { top: 0.1, bottom: ohlcShowVol ? 0.18 : 0.05 },
    });
  } catch (e) {}
}

function applyOhlcWatermark() {
  if (!ohlcChart) return;
  const sym = rpnlMeta.quote_symbol || currentRpnlSel().contract || '';
  const ivl = (document.getElementById('rpnlCandle') || {}).value || '5m';
  const sig = sym + '|' + ivl;
  if (applyOhlcWatermark._sig === sig) return;
  applyOhlcWatermark._sig = sig;
  try {
    ohlcChart.applyOptions({
      watermark: {
        visible: !!sym,
        text: sym ? (sym + '  ' + ivl) : '',
        fontSize: 46,
        fontFamily: 'inherit',
        fontStyle: 'bold',
        color: 'rgba(209,212,220,0.04)',
        horzAlign: 'center',
        vertAlign: 'center',
      },
    });
  } catch (e) {}
}

function applyOhlcChartStyle() {
  if (!ohlcSeries) return;
  const s = ohlcStyle;
  const vis = (want) => ({ visible: s === want, lastValueVisible: s === want, priceLineVisible: s === want });
  try {
    ohlcSeries.applyOptions(vis('candle'));
    if (ohlcBarSeries) ohlcBarSeries.applyOptions(vis('bar'));
    if (ohlcLineSeries) ohlcLineSeries.applyOptions(vis('line'));
    if (ohlcAreaSeries) ohlcAreaSeries.applyOptions(vis('area'));
  } catch (e) {}
  clearOhlcHiLo();
  ohlcOrderSig = '';
  applyOhlcOrderLines(quotesForCurrentRpnl());
  applyOhlcFillMarkers();
  updateOhlcHiLo();
  syncOhlcToolButtons();
}

function applyOhlcMovingAverages(bars, live) {
  OHLC_MA.forEach(({ p, color }) => {
    const series = ohlcMaSeries[p];
    if (!series) return;
    const prev = ohlcMaCache[p] || [];
    const next = ohlcMaOn[p] ? ohlcSma(bars, p) : [];
    series.applyOptions({ visible: !!ohlcMaOn[p] && next.length > 0, color });
    rpnlSetSeriesData(series, next, live ? prev : [], !!live);
    ohlcMaCache[p] = next;
  });
}

function applyOhlcAllSeries(bars, prevBars, live) {
  const clean = (bars || []).map(sanitizeOhlcBar).filter(Boolean);
  if (bars === ohlcBarsCache) ohlcBarsCache = clean;
  bars = clean;
  const prevLine = ohlcLineData(prevBars);
  const line = ohlcLineData(bars);
  rpnlSetSeriesData(ohlcSeries, bars, prevBars, live);
  if (ohlcBarSeries) rpnlSetSeriesData(ohlcBarSeries, bars, prevBars, live);
  if (ohlcLineSeries) rpnlSetSeriesData(ohlcLineSeries, line, prevLine, live);
  if (ohlcAreaSeries) rpnlSetSeriesData(ohlcAreaSeries, line, prevLine, live);
  if (ohlcQuoteMarkerSeries) rpnlSetSeriesData(ohlcQuoteMarkerSeries, line, prevLine, live);
  if (ohlcHedgeMarkerSeries) rpnlSetSeriesData(ohlcHedgeMarkerSeries, line, prevLine, live);
  if (ohlcVolSeries) rpnlSetSeriesData(ohlcVolSeries, volumeBarsFromOhlc(bars), volumeBarsFromOhlc(prevBars), live);
  applyOhlcMovingAverages(bars, live);
}

function applyOhlcFillMarkers() {
  const fills = ohlcShowFills ? (rpnlFillsCache || []) : [];
  const qMarks = fillMarkersFromFills(fills, ohlcBarsCache, false);
  const hMarks = (rpnlMeta.has_hedge ? fillMarkersFromFills(fills, ohlcBarsCache, true) : []);
  const sig = JSON.stringify([qMarks, hMarks]);
  if (sig === ohlcMarkerSig) return;
  ohlcMarkerSig = sig;
  try {
    if (ohlcQuoteMarkerSeries) ohlcQuoteMarkerSeries.setMarkers(qMarks);
    if (ohlcHedgeMarkerSeries) ohlcHedgeMarkerSeries.setMarkers(hMarks);
    if (ohlcSeries) ohlcSeries.setMarkers([]);
  } catch (e) {}
}

function clearOhlcHiLo() {
  if (ohlcHiLoOwner) {
    if (ohlcHiLine) try { ohlcHiLoOwner.removePriceLine(ohlcHiLine); } catch (e) {}
    if (ohlcLoLine) try { ohlcHiLoOwner.removePriceLine(ohlcLoLine); } catch (e) {}
  }
  ohlcHiLine = ohlcLoLine = null;
  ohlcHiLoOwner = null;
}

function rpnlWindowStartUnix() {
  const v = rpnlCurrentHours !== null ? String(rpnlCurrentHours) : rpnlHoursSel();
  if (v === 'today') {
    const shift = (5 * 60 + 30) * 60 * 1000;
    const ist = new Date(Date.now() + shift);
    return Math.floor(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) / 1000) - (5 * 60 + 30) * 60;
  }
  const h = parseFloat(v);
  if (!isFinite(h) || h <= 0) return null;
  return Math.floor(Date.now() / 1000) - Math.round(h * 3600);
}

function rpnlClipBarsToWindow(bars) {
  const start = rpnlWindowStartUnix();
  if (start == null || !bars || !bars.length) return bars || [];
  const cut = start - rpnlCandleSecs();
  if (bars[0].time >= cut) return bars;
  return bars.filter(b => b && b.time >= cut);
}

function ohlcRangeTime(t) {
  if (typeof t === 'number' && isFinite(t)) return t > 1e12 ? Math.floor(t / 1000) : t;
  if (t && typeof t === 'object' && t.year) return Date.UTC(t.year, (t.month || 1) - 1, t.day || 1) / 1000;
  return null;
}

function ohlcHiLoBetween(bars, fromT, toT) {
  let hi = -Infinity, lo = Infinity, n = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (!b || b.time < fromT || b.time > toT) continue;
    const high = Math.max(b.open, b.high, b.low, b.close);
    const low = Math.min(b.open, b.high, b.low, b.close);
    if (high > hi) hi = high;
    if (low < lo) lo = low;
    n++;
  }
  if (!n || !isFinite(hi) || !isFinite(lo)) return null;
  return { hi, lo };
}

function ohlcVisibleHiLo() {
  const bars = ohlcBarsCache;
  if (!bars.length) return null;
  const winStart = rpnlWindowStartUnix();
  const dataFrom = bars[0].time;
  const dataTo = bars[bars.length - 1].time + rpnlCandleSecs();
  let fromT = winStart != null ? winStart : dataFrom;
  let toT = dataTo;
  try {
    if (ohlcChart && !rpnlLogicalLooksUnfitted()) {
      const vr = ohlcChart.timeScale().getVisibleRange();
      const a = vr && ohlcRangeTime(vr.from);
      const b = vr && ohlcRangeTime(vr.to);
      if (a != null && b != null && b > a && b >= dataFrom && a <= dataTo) {
        fromT = a;
        toT = b;
      }
    }
  } catch (e) {}
  if (winStart != null && fromT < winStart) fromT = winStart;
  return ohlcHiLoBetween(bars, fromT, toT) || ohlcHiLoBetween(bars, winStart != null ? winStart : dataFrom, dataTo);
}

function updateOhlcHiLo() {
  if (!ohlcShowHiLo) {
    clearOhlcHiLo();
    return;
  }
  const series = ohlcActiveSeries();
  if (!series || !ohlcChart || !ohlcBarsCache.length) return;
  const range = ohlcVisibleHiLo();
  if (!range) return;
  const hi = range.hi, lo = range.lo;
  if (ohlcHiLoOwner && ohlcHiLoOwner !== series) clearOhlcHiLo();
  const dash = (window.LightweightCharts && LightweightCharts.LineStyle)
    ? LightweightCharts.LineStyle.Dotted : 3;
  const spec = (price, color, title) => ({
    price, color, lineWidth: 1, lineStyle: dash, axisLabelVisible: true, title,
  });
  try {
    ohlcHiLoOwner = series;
    if (!ohlcHiLine) ohlcHiLine = series.createPriceLine(spec(hi, 'rgba(38,166,154,.8)', 'H ' + fmtPxFull(hi)));
    else ohlcHiLine.applyOptions(spec(hi, 'rgba(38,166,154,.8)', 'H ' + fmtPxFull(hi)));
    if (!ohlcLoLine) ohlcLoLine = series.createPriceLine(spec(lo, 'rgba(239,83,80,.8)', 'L ' + fmtPxFull(lo)));
    else ohlcLoLine.applyOptions(spec(lo, 'rgba(239,83,80,.8)', 'L ' + fmtPxFull(lo)));
  } catch (e) {}
}

function syncOhlcGoLive() {
  const btn = document.getElementById('ohlcGoLive');
  if (!btn) return;
  const live = rpnlFollowLive && rpnlAtLiveEdge();
  btn.hidden = live;
  btn.classList.toggle('on', !live);
}

function rpnlVisibleSpan() {
  try {
    const vr = ohlcChart && ohlcChart.timeScale().getVisibleLogicalRange();
    if (vr && vr.to > vr.from) return vr.to - vr.from;
  } catch (e) {}
  const n = Math.max(ohlcBarsCache.length, rpnlPtsCache.length);
  return Math.min(120, Math.max(24, n || 24));
}

function rpnlScrollToLive() {
  const n = Math.max(ohlcBarsCache.length, rpnlPtsCache.length);
  if (!n || !ohlcChart) return;
  const span = rpnlVisibleSpan();
  const logical = {
    from: (n - 1) + rpnlDefaultRightOffset() - span,
    to: (n - 1) + rpnlDefaultRightOffset(),
  };
  rpnlBeginSync();
  try {
    ohlcChart.timeScale().setVisibleLogicalRange(logical);
    if (rpnlChart) rpnlChart.timeScale().setVisibleLogicalRange(logical);
  } catch (e) {}
}

function rpnlGoLive() {
  if (!ohlcChart) return;
  rpnlResumeLiveFollow();
  try { rpnlApplyLiveEdgePad(); } catch (e) {}
  rpnlScrollToLive();
  syncOhlcGoLive();
}

function fmtOhlcEta(secs) {
  if (secs < 0) secs = 0;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return h + ':' + String(mm).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function updateOhlcCountdown() {
  const el = document.getElementById('ohlcHudEta');
  if (!el) return;
  if (!ohlcBarsCache.length) { el.textContent = ''; return; }
  const last = ohlcBarsCache[ohlcBarsCache.length - 1];
  const left = (last.time + rpnlCandleSecs()) - Math.floor(Date.now() / 1000);
  el.textContent = fmtOhlcEta(left);
}

function paintOhlcHud(time) {
  const stats = document.getElementById('ohlcHudStats');
  const chgEl = document.getElementById('ohlcHudChg');
  if (!stats) return;
  if (!ohlcBarsCache.length) {
    stats.textContent = '';
    if (chgEl) chgEl.textContent = '';
    return;
  }
  const d = time ? nearestByTime(ohlcBarsCache, time) : ohlcBarsCache[ohlcBarsCache.length - 1];
  if (!d) return;
  const idx = ohlcBarsCache.indexOf(d);
  const prev = idx > 0 ? ohlcBarsCache[idx - 1] : null;
  const base = prev ? prev.close : d.open;
  const delta = d.close - base;
  const pct = base ? (delta / base) * 100 : 0;
  const up = delta >= 0;
  const cls = up ? 'up' : 'dn';
  if (chgEl) {
    chgEl.className = 'hud-chg ' + cls;
    chgEl.textContent = (up ? '+' : '−') + fmtPxFull(Math.abs(delta)) +
      ' (' + (up ? '+' : '−') + Math.abs(pct).toFixed(Math.abs(pct) >= 10 ? 2 : 3) + '%)';
  }
  const fill = fillAtTime(d.time);
  let html =
    '<span>O <b>' + fmtPxFull(d.open) + '</b></span>' +
    '<span>H <b>' + fmtPxFull(Math.max(d.open, d.high, d.low, d.close)) + '</b></span>' +
    '<span>L <b>' + fmtPxFull(Math.min(d.open, d.high, d.low, d.close)) + '</b></span>' +
    '<span>C <b class="' + cls + '">' + fmtPxFull(d.close) + '</b></span>' +
    '<span>Vol <b>' + fmtVol(d.volume) + '</b></span>';
  if (fill && ohlcShowFills) {
    const col = fill.rpnl >= 0 ? '#26a69a' : '#ef5350';
    const qv = (rpnlMeta.quote_venue || 'delta').toLowerCase();
    const ven = ((fill.exchange || 'delta').toLowerCase() === qv)
      ? (rpnlMeta.quote_label || 'Quote') : (rpnlMeta.hedge_label || 'Hedge');
    html += '<span class="hud-fill">' + ven + ' ' + (fill.side || '') +
      ' <b style="color:' + col + '">' + inrFmtDec(fill.rpnl, 2) + '</b></span>';
  }
  stats.innerHTML = html;
  updateOhlcCountdown();
}

function tickOhlcLiveMark() {
  if (!ohlcBarsCache.length || rpnlLoadBusy) return;
  rpnlSetLiveShift(rpnlFollowLive);
  const row = currentRpnlRow();
  const mark = Number(row && row.settings && row.settings.mark);
  if (!isFinite(mark) || mark <= 0) return;
  const last = ohlcBarsCache[ohlcBarsCache.length - 1];
  const close = Number(last.close);
  if (!isFinite(close) || close <= 0) return;
  if (Math.abs(mark - close) / close > 0.12) return;
  const now = Math.floor(Date.now() / 1000);
  if (now >= last.time + rpnlCandleSecs() + 2) return;
  if (mark === close) { updateOhlcCountdown(); return; }
  const next = sanitizeOhlcBar({
    time: last.time,
    open: last.open,
    high: Math.max(last.high, mark),
    low: Math.min(last.low, mark),
    close: mark,
    volume: last.volume,
  });
  if (!next) return;
  ohlcBarsCache[ohlcBarsCache.length - 1] = next;
  const pt = { time: next.time, value: next.close };
  try {
    if (ohlcSeries) ohlcSeries.update(next);
    if (ohlcBarSeries) ohlcBarSeries.update(next);
    if (ohlcLineSeries) ohlcLineSeries.update(pt);
    if (ohlcAreaSeries) ohlcAreaSeries.update(pt);
    if (ohlcQuoteMarkerSeries) ohlcQuoteMarkerSeries.update(pt);
    if (ohlcHedgeMarkerSeries) ohlcHedgeMarkerSeries.update(pt);
  } catch (e) {}
  tickOhlcMasLast(next);
  if (!ohlcHoverTime) paintOhlcHud(null);
  updateOhlcHiLo();
}

function tickOhlcMasLast(bar) {
  const bars = ohlcBarsCache;
  OHLC_MA.forEach(({ p }) => {
    if (!ohlcMaOn[p] || !ohlcMaSeries[p] || bars.length < p) return;
    let sum = 0;
    for (let i = bars.length - p; i < bars.length; i++) sum += bars[i].close;
    const pt = { time: bar.time, value: sum / p };
    const cache = ohlcMaCache[p];
    if (cache.length) cache[cache.length - 1] = pt;
    try { ohlcMaSeries[p].update(pt); } catch (e) {}
  });
}

function tryRpnlFit() {
  if (!rpnlFollowLive) {
    rpnlNeedsFit = false;
    return true;
  }
  if (rpnlHoldSnap) return false;
  if (!rpnlPageVisible() || !ohlcChart || !rpnlChart) return false;
  if (!applyRpnlChartSize()) return false;
  if (!ohlcBarsCache.length && !rpnlPtsCache.length) return false;
  fitRpnlView();
  if (rpnlLogicalLooksUnfitted()) return false;
  updateOhlcHiLo();
  rpnlNeedsFit = false;
  if (!rpnlRangePinned) rpnlSyncRangeFromView();
  rpnlPaintBrush();
  equalizeRpnlAxisWidth();
  return true;
}

function scheduleRpnlFit() {
  if (!rpnlFollowLive || rpnlHoldSnap || !rpnlPageVisible()) return;
  rpnlNeedsFit = true;
  const kick = () => { if (rpnlNeedsFit) tryRpnlFit(); };
  requestAnimationFrame(() => {
    kick();
    requestAnimationFrame(kick);
  });
  clearTimeout(rpnlFitTimer);
  let n = 0;
  const tick = () => {
    if (!rpnlNeedsFit || !rpnlPageVisible()) return;
    tryRpnlFit();
    n += 1;
    if (rpnlNeedsFit && n < 10) rpnlFitTimer = setTimeout(tick, Math.min(400, 60 * n));
  };
  rpnlFitTimer = setTimeout(tick, 40);
}

function syncRpnlViewButtons() {
  const cumul = document.getElementById('viewCumul');
  const bucket = document.getElementById('viewBucket');
  const autoY = document.getElementById('toggleAutoY');
  if (cumul) cumul.classList.toggle('on', rpnlView === 'cumul');
  if (bucket) bucket.classList.toggle('on', rpnlView === 'bucket');
  if (autoY) {
    autoY.classList.toggle('on', rpnlAutoY);
    autoY.textContent = rpnlAutoY ? 'Auto Y' : 'Lock Y';
  }
}

function toggleAutoY() {
  rpnlAutoY = !rpnlAutoY;
  if (rpnlAutoY) {
    rpnlPriceLock = null;
    rpnlNudgeScale();
  } else if (rpnlChart) {
    rpnlChart.priceScale('right').applyOptions({ autoScale: false });
  }
  syncRpnlViewButtons();
}

function setRpnlView(v) {
  rpnlView = v;
  syncRpnlViewButtons();
  const lab = document.getElementById('rpnlPaneLabel');
  if (lab) updateRpnlPaneLabels();
  const saved = ohlcChart ? ohlcChart.timeScale().getVisibleLogicalRange() : null;
  const snap = captureRpnlView();
  if (snap) {
    rpnlHoldSnap = snap;
    freezeRpnlView(snap);
  }
  if (rpnlPtsCache.length) applyRpnlData(rpnlPtsCache, true, rpnlPtsCache, rpnlHedgeCache);
  if (snap) {
    restoreRpnlView(snap);
    rpnlHoldSnap = null;
  } else if (saved) {
    restoreRpnlView({ logical: { from: saved.from, to: saved.to } });
  }
}

function showRpnlError(msg, detail) {
  const el = document.getElementById('rpnlError');
  if (!el) return;
  el.style.display = 'block';
  el.innerHTML = '<div class="err-title">Failed to load rPnL data</div>' +
    '<div>' + msg + '</div>' +
    (detail ? '<div style="margin-top:6px;color:var(--muted);">Detail: <code>' + detail + '</code></div>' : '') +
    '<div style="margin-top:10px;color:var(--muted);">Make sure <code>DATABASE_URL</code> is set in the Railway webapp environment variables.</div>';
}

function hideRpnlError() {
  const el = document.getElementById('rpnlError');
  if (el) el.style.display = 'none';
}

function rpnlIstTick(time) {
  const d = new Date((typeof time === 'number' ? time : 0) * 1000);
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}

function rpnlTrimNum(x) {
  const n = Number(x);
  if (!isFinite(n)) return '0';
  const s = Math.abs(n) >= 10 ? n.toFixed(1) : n.toFixed(2);
  return s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}
function rpnlAxisInr(p) {
  const v = Number(p) || 0;
  const sign = v < 0 ? '−' : '';
  const a = Math.abs(v);
  if (a >= 1e7) return sign + rpnlTrimNum(a / 1e7) + 'Cr';
  if (a >= 1e5) return sign + rpnlTrimNum(a / 1e5) + 'L';
  if (a >= 1e3) return sign + rpnlTrimNum(a / 1e3) + 'k';
  return sign + String(Math.round(a));
}
function rpnlInrFormat() {
  return { type: 'custom', minMove: 1, formatter: rpnlAxisInr };
}

function rpnlChartBase(timeScaleVisible) {
  const mobile = window.matchMedia('(max-width: 720px)').matches;
  const xh = 'rgba(224, 227, 235, 0.28)';
  return {
    autoSize: false,
    layout: { background: { color: '#0e1117' }, textColor: '#d1d4dc', fontSize: mobile ? 10 : 11 },
    grid:   { vertLines: { color: '#191e2b' }, horzLines: { color: '#191e2b' } },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Magnet,
      vertLine: {
        color: xh, width: 1, style: LightweightCharts.LineStyle.Dashed,
        labelBackgroundColor: '#2962ff',
      },
      horzLine: {
        color: xh, width: 1, style: LightweightCharts.LineStyle.Dashed,
        labelBackgroundColor: '#2962ff',
      },
    },
    rightPriceScale: {
      borderColor: '#303647',
      minimumWidth: mobile ? 62 : 58,
      entireTextOnly: true,
      scaleMargins: { top: 0.1, bottom: timeScaleVisible ? 0.08 : 0.18 },
    },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: {
      // Built-in reset only refits the one pane that was clicked, desyncing the
      // two panes (wrong-size graph). Custom dblclick below refits both together.
      axisPressedMouseMove: { time: true, price: true },
      axisDoubleClickReset: false,
      mouseWheel: true,
      pinch: true,
    },
    kineticScroll: { mouse: false, touch: true },
    localization: {
      timeFormatter: (t) => rpnlIstTick(t),
      priceFormatter: timeScaleVisible ? rpnlAxisInr : undefined,
    },
    timeScale: {
      visible: timeScaleVisible,
      timeVisible: true,
      secondsVisible: false,
      borderColor: '#303647',
      rightOffset: mobile ? 2 : 4,
      barSpacing: 7,
      minBarSpacing: 1.5,
      fixLeftEdge: false,
      fixRightEdge: false,
      lockVisibleTimeRangeOnResize: true,
      shiftVisibleRangeOnNewBar: false,
      tickMarkFormatter: (time) => {
        const d = new Date(time * 1000);
        return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata',
          hour: '2-digit', minute: '2-digit', hour12: false, day: '2-digit', month: 'short' });
      },
    },
  };
}

function fmtChartTime(unix) {
  return rpnlIstTick(unix);
}

function fillAtTime(t) {
  if (!rpnlFillsCache.length) return null;
  let best = null, bestD = 1e18;
  for (const f of rpnlFillsCache) {
    const d = Math.abs(f.time - t);
    if (d < bestD) { bestD = d; best = f; }
  }
  const candleSecs = ohlcBarsCache.length > 1 ? Math.max(30, ohlcBarsCache[1].time - ohlcBarsCache[0].time) : 300;
  return best && bestD <= candleSecs ? best : null;
}

function fmtVol(n) {
  const v = Math.abs(Number(n) || 0);
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function volumeBarsFromOhlc(bars) {
  return (bars || []).map(b => ({
    time: b.time,
    value: Number(b.volume) || 0,
    color: (b.close >= b.open) ? 'rgba(38,166,154,0.45)' : 'rgba(239,83,80,0.45)',
  }));
}

function paintOhlcLegend(time) {
  ohlcHoverTime = time || null;
  paintOhlcHud(time);
  const el = document.getElementById('ohlcLegend');
  if (el) el.style.display = 'none';
}

function paintRpnlLegend(time) {
  const el = document.getElementById('rpnlLegend');
  if (!time) { el.style.display = 'none'; return; }
  const venue = currentRpnlVenue();
  const p = nearestByTime(rpnlPtsCache, time);
  const h = nearestByTime(rpnlHedgeCache, time);
  if (!p && !h) { el.style.display = 'none'; return; }
  let html = '<div class="leg-time">' + fmtChartTime((p || h).time) + '</div>';
  if (p && venue !== 'hedge') {
    let val = p.value;
    if (rpnlView === 'bucket') {
      const i = rpnlPtsCache.indexOf(p);
      val = i <= 0 ? p.value : parseFloat((p.value - rpnlPtsCache[i - 1].value).toFixed(4));
    }
    const col = val >= 0 ? '#26a69a' : '#ef5350';
    html += '<div class="leg-row"><span class="leg-label">' + (rpnlMeta.quote_label || 'Quote') + ' ' + (rpnlView === 'cumul' ? 'Cumul' : 'Bucket') + '</span>' +
      '<span class="leg-val" style="color:' + col + '">' + inrFmtDec(val, 2) + '</span></div>';
  }
  if (h && venue !== 'quote' && rpnlMeta.has_hedge) {
    let val = h.value;
    if (rpnlView === 'bucket') {
      const i = rpnlHedgeCache.indexOf(h);
      val = i <= 0 ? h.value : parseFloat((h.value - rpnlHedgeCache[i - 1].value).toFixed(4));
    }
    const col = val >= 0 ? '#ff9800' : '#ef5350';
    html += '<div class="leg-row"><span class="leg-label">' + (rpnlMeta.hedge_label || 'Hedge') + '</span>' +
      '<span class="leg-val" style="color:' + col + '">' + inrFmtDec(val, 2) + '</span></div>';
  }
  if (p && h && venue === 'both') {
    const net = (p.value || 0) + (h.value || 0);
    html += '<div class="leg-row"><span class="leg-label">Net</span>' +
      '<span class="leg-val" style="color:' + (net >= 0 ? '#90caf9' : '#ef5350') + '">' + inrFmtDec(net, 2) + '</span></div>';
  }
  el.innerHTML = html;
  el.style.display = 'block';
}

function syncCrosshair(origin, param) {
  if (rpnlXhSyncing) return;
  if (!param || !param.time || !param.point || param.point.x < 0) {
    ohlcHoverTime = null;
    paintOhlcHud(null);
    paintRpnlLegend(null);
    rpnlXhSyncing = true;
    try {
      if (origin !== 'ohlc' && ohlcChart) ohlcChart.clearCrosshairPosition();
      if (origin !== 'rpnl' && rpnlChart) rpnlChart.clearCrosshairPosition();
    } catch (e) {}
    rpnlXhSyncing = false;
    return;
  }
  const t = param.time;
  ohlcHoverTime = t;
  paintOhlcHud(t);
  paintRpnlLegend(t);
  rpnlXhSyncing = true;
  try {
    const ohlcS = ohlcActiveSeries();
    if (origin !== 'ohlc' && ohlcS) {
      const bar = nearestByTime(ohlcBarsCache, t);
      if (bar) ohlcChart.setCrosshairPosition(bar.close, bar.time, ohlcS);
    }
    if (origin !== 'rpnl') {
      const p = nearestByTime(rpnlPtsCache, t);
      const series = rpnlView === 'cumul' ? rpnlSeries : rpnlHistSeries;
      if (p && series) {
        let price = p.value;
        if (rpnlView === 'bucket') {
          const i = rpnlPtsCache.indexOf(p);
          price = i <= 0 ? p.value : p.value - rpnlPtsCache[i - 1].value;
        }
        rpnlChart.setCrosshairPosition(price, p.time, series);
      }
    }
  } catch (e) {}
  rpnlXhSyncing = false;
}

function initRpnl() {
  restoreOhlcPrefs();
  const pxFmt = { type: 'custom', minMove: 0.00000001, formatter: function (p) {
    return fmtPxFull(p);
  } };
  ohlcChart = LightweightCharts.createChart(document.getElementById('ohlcChart'), rpnlChartBase(false));
  ohlcSeries = ohlcChart.addCandlestickSeries({
    upColor: '#26a69a', downColor: '#ef5350',
    borderUpColor: '#26a69a', borderDownColor: '#ef5350',
    wickUpColor: '#26a69a', wickDownColor: '#ef5350',
    lastValueVisible: true, priceLineVisible: true,
    priceFormat: pxFmt,
  });
  ohlcBarSeries = ohlcChart.addBarSeries({
    upColor: '#26a69a', downColor: '#ef5350',
    thinBars: false,
    lastValueVisible: false, priceLineVisible: false, visible: false,
    priceFormat: pxFmt,
  });
  ohlcLineSeries = ohlcChart.addLineSeries({
    color: '#26a69a', lineWidth: 2,
    lastValueVisible: false, priceLineVisible: false, visible: false,
    priceFormat: pxFmt,
  });
  ohlcAreaSeries = ohlcChart.addAreaSeries({
    topColor: 'rgba(38,166,154,0.28)',
    bottomColor: 'rgba(38,166,154,0.00)',
    lineColor: '#26a69a', lineWidth: 2,
    lastValueVisible: false, priceLineVisible: false, visible: false,
    priceFormat: pxFmt,
  });
  ohlcQuoteMarkerSeries = ohlcChart.addLineSeries({
    color: 'rgba(0,0,0,0)',
    lastValueVisible: false,
    priceLineVisible: false,
    crosshairMarkerVisible: false,
  });
  ohlcOrderScaleSeries = ohlcChart.addLineSeries({
    color: 'rgba(0,0,0,0)',
    lastValueVisible: false,
    priceLineVisible: false,
    crosshairMarkerVisible: false,
    autoscaleInfoProvider: ohlcWrapAutoscale(function (original) {
      const quotes = quotesForCurrentRpnl();
      const px = (quotes || []).map(q => Number(q.price)).filter(p => isFinite(p) && p > 0);
      const base = typeof original === 'function' ? original() : null;
      if (!px.length) return base;
      let min = Math.min.apply(null, px);
      let max = Math.max.apply(null, px);
      if (base && base.priceRange) {
        min = Math.min(min, base.priceRange.minValue);
        max = Math.max(max, base.priceRange.maxValue);
      }
      const mid = (min + max) / 2 || max || 1;
      const span = Math.max(max - min, Math.abs(mid) * 0.003);
      const pad = Math.max(span * 0.12, Math.abs(mid) * 0.002);
      return { priceRange: { minValue: Math.max(0, min - pad), maxValue: max + pad } };
    }),
  });
  ohlcHedgeMarkerSeries = ohlcChart.addLineSeries({
    color: 'rgba(0,0,0,0)',
    lastValueVisible: false,
    priceLineVisible: false,
    crosshairMarkerVisible: false,
  });
  OHLC_MA.forEach(({ p, color }) => {
    ohlcMaSeries[p] = ohlcChart.addLineSeries({
      color, lineWidth: 1,
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
      visible: !!ohlcMaOn[p],
      priceFormat: pxFmt,
    });
  });
  ohlcInstallPriceLock();
  ohlcVolSeries = ohlcChart.addHistogramSeries({
    priceFormat: { type: 'volume' },
    priceScaleId: '',
    lastValueVisible: false,
    priceLineVisible: false,
  });
  ohlcChart.priceScale('').applyOptions({
    scaleMargins: { top: 0.78, bottom: 0 },
  });
  applyOhlcVolVisible();
  applyOhlcLogScale();
  applyOhlcChartStyle();
  bindOhlcTools();

  rpnlChart = LightweightCharts.createChart(document.getElementById('rpnlChart'), rpnlChartBase(true));
  rpnlSeries = rpnlChart.addLineSeries({
    color: '#26a69a',
    lineWidth: 2,
    title: 'Delta',
    lastValueVisible: true,
    priceLineVisible: true,
    lineType: LightweightCharts.LineType.WithSteps,
    priceFormat: rpnlInrFormat(),
  });
  rpnlHistSeries = rpnlChart.addHistogramSeries({
    priceFormat: rpnlInrFormat(),
    priceScaleId: 'right',
  });
  rpnlHistSeries.applyOptions({ visible: false });
  rpnlHedgeSeries = rpnlChart.addLineSeries({
    color: '#ff9800',
    lineWidth: 2,
    title: 'Hedge',
    lastValueVisible: true,
    priceLineVisible: true,
    lineType: LightweightCharts.LineType.WithSteps,
    priceFormat: rpnlInrFormat(),
  });
  rpnlNetSeries = rpnlChart.addLineSeries({
    color: '#90caf9',
    lineWidth: 2,
    lineStyle: LightweightCharts.LineStyle.Dashed,
    title: 'Net',
    lastValueVisible: true,
    priceLineVisible: false,
    lineType: LightweightCharts.LineType.WithSteps,
    priceFormat: rpnlInrFormat(),
  });
  rpnlInstallPriceLock();
  rpnlHedgeSeries.applyOptions({ visible: false });
  rpnlNetSeries.applyOptions({ visible: false });
  setRpnlView('cumul');

  ohlcChart.timeScale().subscribeVisibleLogicalRangeChange(onRpnlLogicalRange('ohlc'));
  rpnlChart.timeScale().subscribeVisibleLogicalRangeChange(onRpnlLogicalRange('rpnl'));
  ohlcChart.subscribeCrosshairMove((param) => syncCrosshair('ohlc', param));
  rpnlChart.subscribeCrosshairMove((param) => syncCrosshair('rpnl', param));
  bindRpnlSelectLayer();
  bindRpnlUserCamera();
  bindRpnlDblReset();

  window.addEventListener('resize', resizeRpnlCharts);
  requestAnimationFrame(resizeRpnlCharts);
  if (window.ResizeObserver) {
    const stack = document.querySelector('#rpnl .rp-charts');
    if (stack && !stack.dataset.ro) {
      stack.dataset.ro = '1';
      let t = 0;
      const ro = new ResizeObserver(() => {
        clearTimeout(t);
        t = setTimeout(resizeRpnlCharts, 40);
      });
      ro.observe(stack);
      const o = document.getElementById('ohlcChart');
      const r = document.getElementById('rpnlChart');
      if (o) ro.observe(o);
      if (r) ro.observe(r);
    }
  }
  loadRpnl(false);
  document.addEventListener('click', closeRpnlPopovers);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      const page = document.getElementById('rpnl');
      if (page && page.classList.contains('visible') && rpnlFollowLive &&
          (ohlcBarsCache.length || rpnlPtsCache.length)) {
        scheduleRpnlFit();
      }
    });
  }
}

function toggleOhlcTools() {
  const box = document.getElementById('ohlcTools');
  const btn = document.getElementById('ohlcToolsBtn');
  if (!box) return;
  const open = box.classList.toggle('open');
  if (btn) {
    btn.classList.toggle('on', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
}
function closeOhlcTools() {
  const box = document.getElementById('ohlcTools');
  if (!box || !box.classList.contains('open')) return;
  toggleOhlcTools();
}
function toggleRpnlExports() {
  const foot = document.getElementById('rpnlTools');
  if (!foot) return;
  const open = foot.classList.toggle('export-open');
  const btn = document.getElementById('rpnlExportBtn');
  if (btn) btn.classList.toggle('on', open);
}
function closeRpnlPopovers(ev) {
  const page = document.getElementById('rpnl');
  if (!page || !page.classList.contains('visible')) return;
  const foot = document.getElementById('rpnlTools');
  if (foot && foot.classList.contains('export-open') && !(ev && ev.target && ev.target.closest('.rp-foot'))) {
    toggleRpnlExports();
  }
  const t = ev && ev.target;
  if (!(t && (t.closest('#ohlcTools') || t.closest('#ohlcToolsBtn')))) {
    closeOhlcTools();
  }
}

function rpnlFitWidth(el) {
  const page = document.getElementById('rpnl');
  const cap = Math.max(0, (page && page.clientWidth) || window.innerWidth || 0);
  const pane = el && el.parentElement;
  const raw = (el && el.clientWidth) || (pane && pane.clientWidth) || cap;
  return cap ? Math.min(raw, cap) : raw;
}
function rpnlMeasureChartSize() {
  if (!rpnlChart || !ohlcChart) return null;
  const o = document.getElementById('ohlcChart');
  const r = document.getElementById('rpnlChart');
  if (!o || !r) return null;
  const paneO = o.parentElement;
  const paneR = r.parentElement;
  const ow = rpnlFitWidth(o);
  const rw = rpnlFitWidth(r);
  const oh = o.clientHeight || (paneO && paneO.clientHeight) || 0;
  const rh = r.clientHeight || (paneR && paneR.clientHeight) || 0;
  if (ow < 8 || oh < 8 || rw < 8 || rh < 8) return null;
  return { ow, oh, rw, rh };
}
function applyRpnlChartSize() {
  const s = rpnlMeasureChartSize();
  if (!s) return false;
  if (s.ow === rpnlLastSize.ow && s.oh === rpnlLastSize.oh &&
      s.rw === rpnlLastSize.rw && s.rh === rpnlLastSize.rh) return true;
  try {
    ohlcChart.applyOptions({ width: s.ow, height: s.oh });
    rpnlChart.applyOptions({ width: s.rw, height: s.rh });
    rpnlLastSize = s;
  } catch (e) { return false; }
  return true;
}
// Both panes share total width, so the only horizontal offset between candles
// and the rPnL line is the right price-axis width (price labels vs ₹ labels
// differ in length). Pin both axes to the wider of the two so plots align.
function equalizeRpnlAxisWidth(_again) {
  if (!ohlcChart || !rpnlChart) return;
  let wo = 0, wr = 0;
  try { wo = ohlcChart.priceScale('right').width() || 0; } catch (e) {}
  try { wr = rpnlChart.priceScale('right').width() || 0; } catch (e) {}
  if (wo < 8 || wr < 8) return;
  if (Math.abs(wo - wr) <= 1) return;
  const want = Math.ceil(Math.max(wo, wr));
  try { ohlcChart.applyOptions({ rightPriceScale: { minimumWidth: want } }); } catch (e) {}
  try { rpnlChart.applyOptions({ rightPriceScale: { minimumWidth: want } }); } catch (e) {}
  if (!_again) requestAnimationFrame(() => equalizeRpnlAxisWidth(true));
}
function resizeRpnlCharts() {
  if (!rpnlPageVisible()) return;
  const next = rpnlMeasureChartSize();
  if (!next) {
    if (rpnlFollowLive && !rpnlHoldSnap && (rpnlNeedsFit || rpnlLogicalLooksUnfitted())) scheduleRpnlFit();
    return;
  }
  const same = next.ow === rpnlLastSize.ow && next.oh === rpnlLastSize.oh &&
               next.rw === rpnlLastSize.rw && next.rh === rpnlLastSize.rh;
  if (same && !rpnlHoldSnap) {
    rpnlPaintBrush();
    return;
  }
  const snap = rpnlHoldSnap || captureRpnlView();
  applyRpnlChartSize();
  requestAnimationFrame(() => {
    if (rpnlHoldSnap) {
      restoreRpnlView(rpnlHoldSnap);
      rpnlPaintBrush();
      return;
    }
    if (!(ohlcBarsCache.length || rpnlPtsCache.length)) {
      rpnlPaintBrush();
      return;
    }
    if (rpnlFollowLive && rpnlNeedsFit) {
      if (!tryRpnlFit()) scheduleRpnlFit();
    } else if (snap) {
      restoreRpnlView(snap);
    } else if (rpnlFollowLive) {
      try {
        const vr = ohlcChart.timeScale().getVisibleLogicalRange();
        if (!vr || vr.to - vr.from < 1) {
          if (!tryRpnlFit()) scheduleRpnlFit();
        } else syncRpnlTimeScale('ohlc');
      } catch (e) { scheduleRpnlFit(); }
    }
    rpnlPaintBrush();
    applyOhlcOrderLines(quotesForCurrentRpnl());
    equalizeRpnlAxisWidth();
  });
}
let _vpResizeTimer;
function onViewportChange() {
  clearTimeout(_vpResizeTimer);
  _vpResizeTimer = setTimeout(() => {
    const rpnl = document.getElementById('rpnl');
    const reports = document.getElementById('reports');
    if (rpnl && rpnl.classList.contains('visible')) resizeRpnlCharts();
    if (reports && reports.classList.contains('visible') && typeof resizeReportChart === 'function') resizeReportChart();
  }, 180);
}
window.addEventListener('orientationchange', onViewportChange);
if (window.visualViewport) window.visualViewport.addEventListener('resize', onViewportChange);

function barsAlignReady(pts, bucketSecs) {
  return fillGaps(pts, bucketSecs);
}

// Hedge-only view and hedge legend make no sense for an unhedged contract.
function syncRpnlVenueControl() {
  const sel = document.getElementById('rpnlVenue');
  if (!sel) return;
  const hedged = !!rpnlMeta.has_hedge;
  const hlab = rpnlMeta.hedge_label || 'Hedge';
  sel.hidden = !hedged;
  sel.style.display = hedged ? '' : 'none';
  [...sel.options].forEach(o => {
    if (o.value === 'both')  { o.textContent = 'Quote + ' + hlab; o.disabled = !hedged; }
    if (o.value === 'quote') { o.textContent = (rpnlMeta.quote_label || 'Quote') + ' only'; }
    if (o.value === 'hedge') { o.textContent = hlab + ' only'; o.disabled = !hedged; }
  });
  sel.value = hedged ? rpnlVenuePref : 'quote';
  sel.title = hedged ? '' : '';
  const page = document.getElementById('rpnl');
  if (page) page.classList.toggle('hedge-on', hedged);
}

function fillGaps(pts, bucketSecs) {
  if (pts.length < 2) return pts;
  const span = pts[pts.length - 1].time - pts[0].time;
  if (span / bucketSecs > 4000) return pts;
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    out.push(pts[i]);
    if (i < pts.length - 1) {
      let t = pts[i].time + bucketSecs;
      let n = 0;
      while (t < pts[i + 1].time - 1 && n < 500) {
        out.push({ time: t, value: pts[i].value });
        t += bucketSecs;
        n++;
      }
    }
  }
  return out;
}

function unixBarTime(t) {
  t = Number(t);
  if (!isFinite(t) || t <= 0) return null;
  if (t > 1e12) t = Math.floor(t / 1000);
  return Math.floor(t);
}

function dedupeTimes(rows) {
  const byT = new Map();
  for (const r of rows) {
    const t = unixBarTime(r.time);
    if (t == null) continue;
    byT.set(t, Object.assign({}, r, { time: t }));
  }
  return [...byT.values()].sort((a, b) => a.time - b.time);
}

function netFromCaches(deltaPts, hedgePts) {
  const n = Math.max(deltaPts.length, hedgePts.length);
  if (!n) return [];
  const times = [];
  const seen = new Set();
  for (const p of deltaPts.concat(hedgePts)) {
    if (!seen.has(p.time)) { seen.add(p.time); times.push(p.time); }
  }
  times.sort((a, b) => a - b);
  const dMap = new Map(deltaPts.map(p => [p.time, p.value]));
  const hMap = new Map(hedgePts.map(p => [p.time, p.value]));
  let lastD = 0, lastH = 0;
  return times.map(t => {
    if (dMap.has(t)) lastD = dMap.get(t);
    if (hMap.has(t)) lastH = hMap.get(t);
    return { time: t, value: lastD + lastH };
  });
}

function applyRpnlData(pts, keepRange, prevPts, prevHedge) {
  const venue = currentRpnlVenue();
  const showDelta = venue !== 'hedge';
  const hedgePts = rpnlHedgeCache;
  const showHedge = venue !== 'quote' && rpnlMeta.has_hedge && hedgePts.length > 0;
  const netPts = (showDelta && showHedge) ? netFromCaches(pts, hedgePts) : [];
  const prevDelta = prevPts || [];
  const prevH = prevHedge || [];
  const prevNet = (showDelta && showHedge && prevDelta.length) ? netFromCaches(prevDelta, prevH) : [];
  const live = !!(keepRange && rpnlDrawnView === rpnlView && (prevDelta.length || prevH.length));
  if (rpnlView === 'cumul') {
    rpnlSeries.applyOptions({ visible: showDelta });
    rpnlHistSeries.applyOptions({ visible: false });
    rpnlSetSeriesData(rpnlSeries, showDelta ? pts : [], showDelta ? prevDelta : [], live);
    if (rpnlHedgeSeries) {
      rpnlHedgeSeries.applyOptions({ visible: showHedge });
      rpnlSetSeriesData(rpnlHedgeSeries, showHedge ? hedgePts : [], showHedge ? prevH : [], live);
    }
    if (rpnlNetSeries) {
      rpnlNetSeries.applyOptions({ visible: netPts.length > 0 });
      rpnlSetSeriesData(rpnlNetSeries, netPts, prevNet, live);
    }
  } else {
    rpnlSeries.applyOptions({ visible: false });
    if (rpnlHedgeSeries) rpnlHedgeSeries.applyOptions({ visible: false });
    if (rpnlNetSeries) rpnlNetSeries.applyOptions({ visible: false });
    rpnlHistSeries.applyOptions({ visible: true });
    const src = venue === 'both' && netPts.length ? netPts
      : (venue === 'hedge' ? hedgePts : pts);
    const prevSrc = venue === 'both' && prevNet.length ? prevNet
      : (venue === 'hedge' ? prevH : prevDelta);
    const bars = src.map((p, i) => {
      const val = i === 0 ? p.value : parseFloat((p.value - src[i-1].value).toFixed(4));
      return { time: p.time, value: val, color: val >= 0 ? 'rgba(38,166,154,0.85)' : 'rgba(239,83,80,0.85)' };
    });
    const prevBars = prevSrc.map((p, i) => {
      const val = i === 0 ? p.value : parseFloat((p.value - prevSrc[i-1].value).toFixed(4));
      return { time: p.time, value: val, color: val >= 0 ? 'rgba(38,166,154,0.85)' : 'rgba(239,83,80,0.85)' };
    });
    rpnlSetSeriesData(rpnlHistSeries, bars, prevBars, live);
  }
  rpnlDrawnView = rpnlView;
  applyRpnlFillMarkers();
  if (!live && rpnlAutoY && rpnlChart) {
    try { rpnlChart.priceScale('right').applyOptions({ autoScale: true }); } catch (e) {}
  }
}

async function extendRpnl() {
  if (rpnlLoadingMore || !rpnlPtsCache.length) return;
  if (rpnlCurrentHours === null && rpnlHoursSel() === 'today') return;
  const currentH = rpnlCurrentHours !== null
    ? rpnlCurrentHours
    : parseInt(rpnlHoursSel(), 10);
  if (!isFinite(currentH) || currentH >= 720) return;

  rpnlLoadingMore = true;
  const visLogical = ohlcChart.timeScale().getVisibleLogicalRange();
  rpnlCurrentHours = Math.min(currentH * 2, 720);
  await loadRpnl(true);
  if (visLogical) {
    restoreRpnlView({ logical: { from: visLogical.from, to: visLogical.to } });
  }
  rpnlLoadingMore = false;
}

function clearRpnlCharts() {
  rpnlPtsCache = []; rpnlHedgeCache = []; rpnlFillsCache = []; ohlcBarsCache = [];
  ohlcMaCache = { 7: [], 25: [], 99: [] };
  ohlcMarkerSig = '';
  rpnlMarkerSig = '';
  rpnlDrawnView = '';
  clearOhlcOrderLines();
  clearOhlcHiLo();
  try {
    if (rpnlSeries) rpnlSeries.setData([]);
    if (rpnlHedgeSeries) rpnlHedgeSeries.setData([]);
    if (rpnlNetSeries) rpnlNetSeries.setData([]);
    if (rpnlHistSeries) { rpnlHistSeries.setData([]); rpnlHistSeries.setMarkers([]); }
    if (ohlcSeries) { ohlcSeries.setData([]); ohlcSeries.setMarkers([]); }
    if (ohlcBarSeries) ohlcBarSeries.setData([]);
    if (ohlcLineSeries) ohlcLineSeries.setData([]);
    if (ohlcAreaSeries) ohlcAreaSeries.setData([]);
    if (ohlcVolSeries) ohlcVolSeries.setData([]);
    if (ohlcQuoteMarkerSeries) { ohlcQuoteMarkerSeries.setData([]); ohlcQuoteMarkerSeries.setMarkers([]); }
    if (ohlcHedgeMarkerSeries) { ohlcHedgeMarkerSeries.setData([]); ohlcHedgeMarkerSeries.setMarkers([]); }
    OHLC_MA.forEach(({ p }) => { if (ohlcMaSeries[p]) ohlcMaSeries[p].setData([]); });
  } catch (e) {}
  paintOhlcHud(null);
}

async function loadRpnl(keepRange) {
  const seq = ++rpnlLoadSeq;
  rpnlLoadBusy = true;
  if (!keepRange) rpnlNeedsFit = true;
  try {
  const winQ   = rpnlWindowQuery();
  const winLab = rpnlWindowTag();
  const bucket = document.getElementById('rpnlBucket').value;
  const hoursArg = winLab === 'today' ? 'today' : (rpnlCurrentHours !== null ? rpnlCurrentHours : rpnlHoursSel());
  hideRpnlError();
  updateRpnlPaneLabels();

  let rows = null;
  try {
    const sR = await fetch(withStrategy('/api/rpnl/summary' + (winQ ? '?' + winQ.slice(1) : '')));
    if (seq !== rpnlLoadSeq) return;
    if (sR.ok) rows = filterRpnlWindowRows(await sR.json());
  } catch (e) { /* chart load can still proceed with the current symbol */ }
  if (seq !== rpnlLoadSeq) return;
  if (rows) {
    const prevKey = (document.getElementById('rpnlSymbol') || {}).value || '';
    const shown = rpnlWithoutStopped(rows);
    const key = syncRpnlSymbolSelect(shown);
    renderRpnlSummary(rows, hoursArg);
    if (!key) {
      if (rows.length) {
        setOhlcEmpty(true, 'Stopped bots are hidden');
        clearRpnlCharts();
        return;
      }
      toast('No contracts with fills in this window. Try a longer Window.');
      setOhlcEmpty(true, 'No price candles for this window');
      clearRpnlCharts();
      return;
    }
    if (key !== prevKey) keepRange = false;
  }

  const picked = currentRpnlSel();
  const venue  = rpnlVenueParam();
  const sym    = picked.contract;
  if (!sym) return;
  const prevBars = ohlcBarsCache.slice();
  const prevPts = rpnlPtsCache.slice();
  const prevHedge = rpnlHedgeCache.slice();
  const acctBit = '&account=' + encodeURIComponent(picked.account);
  try {
    const stratQ = '&strategy=' + encodeURIComponent(
      picked.strategy || (strategyIsAll(currentStrategy) ? 'all' : currentStrategy)
    );
    const candleIvl = (document.getElementById('rpnlCandle') || {}).value || '5m';
    const pairHedgeSym = rpnlPairHedge[sym + '::' + picked.account + '::' + picked.strategy] || '';
    const exForUrl = pairHedgeSym ? 'both' : venue;
    const hedgeQ = pairHedgeSym ? '&hedge_symbol=' + encodeURIComponent(pairHedgeSym) : '';
    const url = '/api/rpnl?symbol=' + encodeURIComponent(sym) + winQ + '&bucket=' + bucket + acctBit + '&exchange=' + exForUrl + stratQ + hedgeQ;
    const fillUrl = '/api/rpnl/fills?symbol=' + encodeURIComponent(sym) + winQ + '&bucket=' + bucket + acctBit + stratQ;
    const candleUrl = '/api/candles?symbol=' + encodeURIComponent(sym) + '&interval=' + candleIvl + winQ + acctBit + stratQ;
    const settled = await Promise.allSettled([
      fetch(url),
      fetch(candleUrl),
      fetch(fillUrl + '&exchange=quote'),
      pairHedgeSym
        ? fetch('/api/rpnl/fills?symbol=' + encodeURIComponent(pairHedgeSym) + winQ + '&bucket=' + bucket + acctBit + stratQ + '&exchange=quote')
        : (venue === 'quote' ? Promise.resolve(null) : fetch(fillUrl + '&exchange=hedge')),
    ]);
    if (seq !== rpnlLoadSeq) return;
    const take = i => settled[i].status === 'fulfilled' ? settled[i].value : null;
    let r = take(0);
    let cR = take(1);
    const fR = take(2);
    const hFR = take(3);
    if (!cR || !cR.ok) {
      await new Promise(res => setTimeout(res, 400));
      if (seq !== rpnlLoadSeq) return;
      try { cR = await fetch(candleUrl); } catch (e) { cR = null; }
      if (seq !== rpnlLoadSeq) return;
    }
    if (!r || !r.ok) {
      const body = r ? await r.json().catch(() => ({ detail: r.statusText })) : { detail: 'network error' };
      const status = r ? r.status : 0;
      showRpnlError('HTTP ' + status, body.detail || 'request failed');
      return;
    }
    const d   = await r.json();
    if (seq !== rpnlLoadSeq) return;
    rpnlMeta = {
      quote_venue: d.quote_venue || 'delta',
      quote_label: d.quote_label || 'Delta',
      quote_symbol: d.quote_symbol || d.contract || '',
      hedge_venue: d.hedge_venue || '',
      hedge_label: d.hedge_label || '',
      hedge_symbol: d.hedge_symbol || '',
      has_hedge: !!d.has_hedge,
    };
    if (rpnlSeries) rpnlSeries.applyOptions({ title: rpnlMeta.quote_label });
    if (rpnlHedgeSeries) rpnlHedgeSeries.applyOptions({ title: rpnlMeta.hedge_label || 'Hedge' });
    syncRpnlVenueControl();
    updateRpnlPaneLabels();
    const pts = dedupeTimes((d.points || []).map(p => ({ time: p.time, value: p.rpnl })));
    const hedgeRaw = dedupeTimes((d.hedge_points || []).map(p => ({ time: p.time, value: p.rpnl })));
    const bucketSecs = parseInt(bucket) * 60;
    const filled = barsAlignReady(pts, bucketSecs);
    const hedgeFilled = barsAlignReady(hedgeRaw, bucketSecs);

    let bars = [];
    let candleNote = '';
    if (ohlcSeries && cR && cR.ok) {
      try {
        const cd = await cR.json();
        if (seq !== rpnlLoadSeq) return;
        bars = dedupeTimes((cd.candles || []).map(sanitizeOhlcBar).filter(Boolean));
        if (!bars.length) candleNote = ' · no OHLC from ' + (cd.quote_label || cd.venue || 'venue');
      } catch (e) {
        candleNote = ' · candles parse failed';
      }
    } else if (ohlcSeries) {
      let body = {};
      try { if (cR) body = await cR.json(); } catch (e) {}
      candleNote = ' · candles failed: ' + (body.detail || (cR && cR.statusText) || 'network');
    }
    const liveUpdate = !!keepRange && (prevBars.length > 0 || prevPts.length > 0);
    if (liveUpdate && !bars.length && prevBars.length) bars = prevBars;
    let savedView = liveUpdate ? captureRpnlView() : null;
    if (liveUpdate) {
      ohlcBarsCache = rpnlClipBarsToWindow(rpnlMergeByTime(prevBars, bars));
      savedView = rpnlShiftLogical(savedView, prevBars, ohlcBarsCache);
      if (savedView) rpnlHoldSnap = savedView;
    } else {
      ohlcBarsCache = rpnlClipBarsToWindow(bars);
      ohlcPriceLock = null;
      try { ohlcChart.priceScale('right').applyOptions({ autoScale: true, scaleMargins: rpnlPriceMargins(ohlcChart) }); } catch (e) {}
      if (rpnlPriceLock) {
        rpnlPriceLock = null;
        rpnlAutoY = true;
        if (typeof syncRpnlViewButtons === 'function') syncRpnlViewButtons();
        try { rpnlChart.priceScale('right').applyOptions({ autoScale: true, scaleMargins: rpnlPriceMargins(rpnlChart) }); } catch (e) {}
      }
    }
    setOhlcEmpty(!ohlcBarsCache.length, ohlcBarsCache.length ? '' : ((candleNote || '').replace(/^ · /, '') || 'No price candles for this window'));
    try {
      applyOhlcAllSeries(ohlcBarsCache, prevBars, liveUpdate);
    } catch (e) {
      if (!liveUpdate) {
        ohlcBarsCache = [];
        setOhlcEmpty(true, 'Price chart could not render these candles');
      }
    }

    rpnlPtsCache = ohlcBarsCache.length ? alignRpnlToBars(filled, ohlcBarsCache, liveUpdate ? prevPts : null) : filled;
    rpnlHedgeCache = hedgeFilled.length && ohlcBarsCache.length
      ? alignRpnlToBars(hedgeFilled, ohlcBarsCache, liveUpdate ? prevHedge : null)
      : hedgeFilled;
    applyRpnlData(rpnlPtsCache, true, prevPts, prevHedge);

    if (fR && fR.ok) {
      const fd = await fR.json();
      if (seq !== rpnlLoadSeq) return;
      let fills = fd.fills || [];
      if (hFR && hFR.ok) {
        const hf = await hFR.json();
        if (seq !== rpnlLoadSeq) return;
        fills = fills.concat(hf.fills || []);
      }
      rpnlFillsCache = fills;
    } else if (!liveUpdate) {
      rpnlFillsCache = [];
    }
    applyOhlcFillMarkers();
    applyRpnlFillMarkers();

    applyOhlcOrderLines(quotesForCurrentRpnl());
    applyOhlcWatermark();
    paintOhlcHud(ohlcHoverTime);
    updateOhlcHiLo();
    syncOhlcGoLive();

    if (keepRange) {
      rpnlNeedsFit = false;
    } else {
      rpnlNeedsFit = true;
    }
    rpnlHoldSnap = null;

    if (filled.length === 0 && !hedgeRaw.length && !ohlcBarsCache.length) {
      const boot = (rpnlSummaryCache || []).find(row =>
        rpnlIsBooting(row) && rpnlCanonSym(row.contract) === rpnlCanonSym(sym)
      );
      if (boot) {
        setOhlcEmpty(true, rpnlBootLabel(boot) + ' — waiting for the process to come online');
        if (!keepRange && rpnlNeedsFit) scheduleRpnlFit();
        return;
      }
      toast('No fills for ' + (d.contract || sym) + ' in this window.');
      if (!keepRange && rpnlNeedsFit) scheduleRpnlFit();
      return;
    }

    if (!rpnlRangePinned) rpnlSyncRangeFromView();
    rpnlPaintBrush();
    equalizeRpnlAxisWidth();
    if (!keepRange && rpnlNeedsFit) scheduleRpnlFit();
    if (rpnlLogsOpen() && !keepRange) rpnlKindReload();
  } catch(e) {
    console.error('[rPnL] fetch threw:', e);
    showRpnlError('Network or parse error', e.message);
  }
  } finally {
    rpnlHoldSnap = null;
    if (seq === rpnlLoadSeq) rpnlLoadBusy = false;
  }
}

function setupRpnlAuto() {
  clearInterval(rpnlTimer);
  rpnlTimer = null;
  const box = document.getElementById('rpnlAuto');
  const vis = document.getElementById('rpnl') && document.getElementById('rpnl').classList.contains('visible');
  if (box) lsSet(LS_RPNL_AUTO, box.checked ? '1' : '0');
  if (box && box.checked && vis) rpnlTimer = setInterval(() => loadRpnl(true), 10000);
}

function unixToDatetimeLocalIST(unix) {
  if (unix == null || !isFinite(unix)) return '';
  const n = Number(unix);
  const s = new Date(n * 1000).toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' });
  return s.replace(' ', 'T').slice(0, 16);
}
function datetimeLocalISTToUnix(s) {
  if (!s) return null;
  const iso = s.length === 16 ? s + ':00' : s;
  const [date, time] = iso.split('T');
  if (!date || !time) return null;
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm, ss] = time.split(':').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d, hh, mm, ss || 0) / 1000) - IST_OFFSET;
}
function rpnlVisibleUnixRange() {
  if (!rpnlChart) return null;
  try {
    const r = rpnlChart.timeScale().getVisibleRange();
    if (!r || r.from == null || r.to == null) return null;
    return { from: Number(r.from), to: Number(r.to) };
  } catch (e) { return null; }
}
function rpnlActiveRange() {
  if (rpnlRangePinned && rpnlPinFrom != null && rpnlPinTo != null) {
    const a = Math.min(rpnlPinFrom, rpnlPinTo);
    const b = Math.max(rpnlPinFrom, rpnlPinTo);
    return { from: a, to: b };
  }
  return rpnlVisibleUnixRange();
}
function rpnlHasSelection() {
  return !!(rpnlRangePinned && rpnlPinFrom != null && rpnlPinTo != null &&
    Math.abs(Number(rpnlPinTo) - Number(rpnlPinFrom)) >= 1);
}
function rpnlSelectionBounds() {
  if (!rpnlHasSelection()) return null;
  const a = Math.min(Number(rpnlPinFrom), Number(rpnlPinTo));
  const b = Math.max(Number(rpnlPinFrom), Number(rpnlPinTo));
  return { from: a, to: b };
}
function rpnlFmtIstClock(unix) {
  return new Date(unix * 1000).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}
function rpnlFmtIstRange(from, to) {
  const a = new Date(from * 1000);
  const b = new Date(to * 1000);
  const opts = { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false };
  const left = a.toLocaleString('en-IN', opts);
  const sameDay = a.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' }) ===
    b.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' });
  const right = sameDay ? rpnlFmtIstClock(to) : b.toLocaleString('en-IN', opts);
  return left + ' – ' + right;
}
function rpnlSetRangeInputs(from, to, silent) {
  const a = document.getElementById('rpnlFrom');
  const b = document.getElementById('rpnlTo');
  if (!a || !b || from == null || to == null) return;
  const fv = unixToDatetimeLocalIST(from);
  const tv = unixToDatetimeLocalIST(to);
  if (silent) {
    a.value = fv;
    b.value = tv;
    return;
  }
  if (a.value !== fv) a.value = fv;
  if (b.value !== tv) b.value = tv;
}
function rpnlSetRangeMode() {
  const el = document.getElementById('rpnlRangeMode');
  const clearBtn = document.getElementById('rpnlClearBtn');
  const jumpBtn = document.getElementById('rpnlJumpBtn');
  const selBtn = document.getElementById('rpnlSelectBtn');
  const hint = document.getElementById('rpnlSelectHint');
  const page = document.getElementById('rpnl');
  const pinned = rpnlHasSelection();
  if (selBtn) {
    selBtn.classList.toggle('on', rpnlSelectMode);
    selBtn.setAttribute('aria-pressed', rpnlSelectMode ? 'true' : 'false');
  }
  if (clearBtn) clearBtn.hidden = !pinned;
  if (jumpBtn) jumpBtn.hidden = !pinned;
  if (hint) hint.hidden = !rpnlSelectMode;
  if (page) page.classList.toggle('selecting', rpnlSelectMode);
  if (el) {
    el.className = 'range-mode' + (rpnlSelectMode ? ' sel' : pinned ? ' pin' : '');
    if (rpnlSelectMode) {
      el.textContent = 'Drag on chart';
      el.title = 'Drag left or right on Price or rPnL';
    } else if (pinned) {
      const r = rpnlSelectionBounds();
      const mins = Math.max(1, Math.round((r.to - r.from) / 60));
      el.textContent = 'Selected · ' + mins + 'm';
      el.title = rpnlFmtIstRange(r.from, r.to) + ' IST — tap to jump';
    } else {
      el.textContent = 'Live window';
      el.title = 'Logs and fills follow the hours dropdown. Select a slice on the chart to pin.';
    }
  }
  syncRpnlKindButtons();
}
function rpnlRangeModeClick() {
  if (rpnlSelectMode) {
    setRpnlSelectMode(false);
    return;
  }
  if (rpnlHasSelection()) rpnlJumpChartToRange();
}
function rpnlSyncRangeFromView() {
  const r = rpnlVisibleUnixRange();
  if (!r) return;
  rpnlSetRangeInputs(r.from, r.to, true);
  rpnlSetRangeMode();
}
function rpnlFollowView() {
  rpnlSelDrag = null;
  rpnlRangePinned = false;
  rpnlPinFrom = rpnlPinTo = null;
  setRpnlSelectMode(false);
  rpnlSyncRangeFromView();
  rpnlPaintBrush();
  if (rpnlLogsOpen()) rpnlKindReload();
}
function rpnlPinFromInputs() {
  const from = datetimeLocalISTToUnix(document.getElementById('rpnlFrom').value);
  const to = datetimeLocalISTToUnix(document.getElementById('rpnlTo').value);
  if (from == null || to == null || !(to > from)) {
    toast('Need a valid From < To in IST', 'err');
    return;
  }
  rpnlRangePinned = true;
  rpnlPinFrom = from;
  rpnlPinTo = to;
  setRpnlSelectMode(false);
  rpnlSetRangeMode();
  rpnlPaintBrush();
  if (rpnlLogsOpen()) rpnlKindReload();
}
function rpnlJumpChartToRange() {
  const r = rpnlSelectionBounds() || rpnlActiveRange();
  if (!r || !rpnlChart || !ohlcChart) return;
  rpnlBeginSync();
  try {
    rpnlChart.timeScale().setVisibleRange({ from: r.from, to: r.to });
    ohlcChart.timeScale().setVisibleRange({ from: r.from, to: r.to });
  } catch (e) {}
  rpnlFollowLive = false;
  rpnlSetLiveShift(false);
  syncOhlcGoLive();
}
function rpnlApplySelectHandle(chart) {
  if (!chart) return;
  try {
    chart.applyOptions({
      handleScroll: { mouseWheel: true, pressedMouseMove: !rpnlSelectMode, horzTouchDrag: !rpnlSelectMode, vertTouchDrag: false },
      handleScale: {
        axisPressedMouseMove: { time: !rpnlSelectMode, price: !rpnlSelectMode },
        mouseWheel: !rpnlSelectMode,
        pinch: !rpnlSelectMode,
      },
    });
  } catch (e) {}
}
function setRpnlSelectMode(on) {
  const next = !!on;
  if (!next && rpnlSelDrag && rpnlSelDrag.started) {
    rpnlRangePinned = !!rpnlSelDrag.prevPinned;
    rpnlPinFrom = rpnlSelDrag.prevFrom;
    rpnlPinTo = rpnlSelDrag.prevTo;
    rpnlSelDrag = null;
  }
  rpnlSelectMode = next;
  document.querySelectorAll('.rp-y-hit').forEach(function (hit) {
    hit.style.pointerEvents = next ? 'none' : '';
  });
  document.querySelectorAll('.rpnl-select-layer').forEach(function (layer) {
    layer.hidden = !rpnlSelectMode;
  });
  rpnlApplySelectHandle(rpnlChart);
  rpnlApplySelectHandle(ohlcChart);
  rpnlSetRangeMode();
  rpnlPaintBrush();
}
function toggleRpnlSelect() {
  setRpnlSelectMode(!rpnlSelectMode);
}
function rpnlPaintOneBrush(box, chart) {
  if (!box || !chart) return;
  if (rpnlPinFrom == null || rpnlPinTo == null || (!rpnlHasSelection() && !rpnlSelDrag)) {
    box.hidden = true;
    return;
  }
  const a = Math.min(Number(rpnlPinFrom), Number(rpnlPinTo));
  const b = Math.max(Number(rpnlPinFrom), Number(rpnlPinTo));
  let x1, x2;
  try {
    x1 = chart.timeScale().timeToCoordinate(a);
    x2 = chart.timeScale().timeToCoordinate(b);
  } catch (e) { box.hidden = true; return; }
  if (x1 == null || x2 == null) { box.hidden = true; return; }
  box.hidden = false;
  box.style.left = Math.min(x1, x2) + 'px';
  box.style.width = Math.max(2, Math.abs(x2 - x1)) + 'px';
}
function rpnlPaintBrush() {
  rpnlPaintOneBrush(document.getElementById('rpnlBrush'), rpnlChart);
  rpnlPaintOneBrush(document.getElementById('ohlcBrush'), ohlcChart);
}
function bindRpnlSelectLayer() {
  document.querySelectorAll('.rpnl-select-layer').forEach(function (layer) {
    if (layer.dataset.bound) return;
    layer.dataset.bound = '1';
    const which = layer.getAttribute('data-rpnl-sel') === 'ohlc' ? 'ohlc' : 'rpnl';
    const chartOf = function () { return which === 'ohlc' ? ohlcChart : rpnlChart; };
    const elOf = function () {
      return document.getElementById(which === 'ohlc' ? 'ohlcChart' : 'rpnlChart') || layer;
    };
    const xToTime = function (clientX) {
      const chart = chartOf();
      if (!chart) return null;
      const rect = elOf().getBoundingClientRect();
      const x = clientX - rect.left;
      let t;
      try { t = chart.timeScale().coordinateToTime(x); } catch (e) { return null; }
      if (t == null) return null;
      if (typeof t === 'number' && isFinite(t)) return t;
      if (typeof t === 'object' && t.timestamp != null) return Number(t.timestamp);
      const n = Number(t);
      return isFinite(n) ? n : null;
    };
    layer.addEventListener('pointerdown', function (ev) {
      if (!rpnlSelectMode) return;
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      const t = xToTime(ev.clientX);
      if (t == null) return;
      rpnlSelDrag = {
        id: ev.pointerId,
        startX: ev.clientX,
        started: true,
        prevPinned: rpnlRangePinned,
        prevFrom: rpnlPinFrom,
        prevTo: rpnlPinTo,
      };
      try { layer.setPointerCapture(ev.pointerId); } catch (e) {}
      rpnlRangePinned = true;
      rpnlPinFrom = rpnlPinTo = Number(t);
      rpnlSetRangeInputs(rpnlPinFrom, rpnlPinTo, true);
      rpnlPaintBrush();
    });
    layer.addEventListener('pointermove', function (ev) {
      if (!rpnlSelDrag || rpnlSelDrag.id !== ev.pointerId) return;
      ev.preventDefault();
      const t = xToTime(ev.clientX);
      if (t == null) return;
      rpnlPinTo = Number(t);
      rpnlSetRangeInputs(rpnlPinFrom, rpnlPinTo, true);
      rpnlPaintBrush();
    });
    const endDrag = function (ev) {
      if (!rpnlSelDrag || (ev && rpnlSelDrag.id !== ev.pointerId)) return;
      const drag = rpnlSelDrag;
      rpnlSelDrag = null;
      try { layer.releasePointerCapture(drag.id); } catch (e) {}
      const t = ev ? xToTime(ev.clientX) : null;
      if (t != null) rpnlPinTo = Number(t);
      const dist = ev ? Math.abs(ev.clientX - drag.startX) : 0;
      if (dist < 12) {
        rpnlRangePinned = !!drag.prevPinned;
        rpnlPinFrom = drag.prevFrom;
        rpnlPinTo = drag.prevTo;
        rpnlSetRangeInputs(rpnlPinFrom, rpnlPinTo, true);
        rpnlSetRangeMode();
        rpnlPaintBrush();
        return;
      }
      if (rpnlPinFrom != null && rpnlPinTo != null && rpnlPinFrom === rpnlPinTo) {
        rpnlPinTo = rpnlPinFrom + 60;
      }
      rpnlRangePinned = true;
      rpnlSetRangeInputs(rpnlPinFrom, rpnlPinTo, true);
      setRpnlSelectMode(false);
      rpnlPaintBrush();
      if (rpnlLogsOpen()) rpnlKindReload();
    };
    layer.addEventListener('pointerup', endDrag);
    layer.addEventListener('pointercancel', endDrag);
  });
}
function rpnlExportFilters() {
  const r = rpnlActiveRange();
  if (!r) throw new Error('No time range yet — load a chart first');
  const picked = currentRpnlSel();
  if (!picked.contract) throw new Error('Pick a contract pill first');
  const venue = currentRpnlVenue();
  const exchange = venue === 'quote' ? (rpnlMeta.quote_venue || '')
    : venue === 'hedge' ? (rpnlMeta.hedge_venue || '') : '';
  const strat = picked.strategy || (strategyIsAll(currentStrategy) ? '' : currentStrategy);
  return {
    since: String(Math.floor(r.from)),
    until: String(Math.floor(r.to) + 1),
    strategy: strat && !strategyIsAll(strat) ? strat : '',
    contract: picked.contract,
    account: picked.account || '',
    exchange,
  };
}

const RPNL_KIND_META = {
  logs: { label: 'Logs', table: null },
  fills: { label: 'Fills', table: 'fills' },
};
function rpnlFillCols(allCols) {
  if (typeof dbtColsFor === 'function') return dbtColsFor('fills', allCols, true);
  return (allCols || []).filter(function (c) { return c !== 'id' && c !== 'details'; });
}

function rpnlLogsOpen() {
  const page = document.getElementById('rpnl');
  return !!(page && page.classList.contains('logs-open'));
}
function rpnlLogsIsSheet() {
  return window.matchMedia('(max-width: 720px)').matches;
}
function rpnlLogsBackdrop(ev) {
  if (ev && ev.target === ev.currentTarget) closeRpnlKind();
}

function rpnlQs(p) {
  return Object.entries(p).filter(([, v]) => v !== '' && v != null && v !== false)
    .map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
}

function rpnlKindSearchVal() {
  return ((document.getElementById('rpnlKindSearch') || {}).value || '').trim();
}

function rpnlKindScopeVal() {
  if (rpnlHasSelection()) return 'contract';
  const el = document.getElementById('rpnlKindScope');
  return (el && el.value) === 'all' ? 'all' : 'contract';
}

function rpnlLogWindow(liveTail) {
  const sel = rpnlSelectionBounds();
  if (sel) {
    return { since: String(Math.floor(sel.from)), until: String(Math.floor(sel.to) + 1) };
  }
  const v = rpnlCurrentHours != null ? rpnlCurrentHours : rpnlHoursSel();
  const hours = v === 'today' ? 24 : (Number(v) || 24);
  const now = Date.now() / 1000;
  return {
    since: String(Math.floor(now - hours * 3600)),
    until: String(Math.floor(now + 120)),
  };
}

function rpnlLogQs(extra) {
  const picked = currentRpnlSel();
  const all = rpnlKindScopeVal() === 'all';
  const win = rpnlLogWindow();
  const strat = picked.strategy || (strategyIsAll(currentStrategy) ? '' : currentStrategy);
  const p = {
    since: win.since,
    until: win.until,
    search: rpnlKindSearchVal(),
    limit: 400,
  };
  if (!all) {
    if (picked.contract) p.contract = picked.contract;
    if (picked.account) p.account = picked.account;
    if (strat && !strategyIsAll(strat)) p.strategy = strat;
  }
  return rpnlQs(Object.assign(p, extra || {}));
}

function rpnlTableQs(extra) {
  const picked = currentRpnlSel();
  const all = rpnlKindScopeVal() === 'all';
  const live = !rpnlHasSelection() && rpnlKind === 'fills' && rpnlFillsLiveOn();
  const win = rpnlLogWindow(live);
  const strat = picked.strategy || (strategyIsAll(currentStrategy) ? '' : currentStrategy);
  const p = {
    since: win.since,
    until: win.until,
    q: rpnlKindSearchVal(),
    sort: 'created_at',
    dir: 'desc',
    limit: 120,
    offset: 0,
  };
  if (!all) {
    if (picked.contract) p.contract = picked.contract;
    if (picked.account) p.account = picked.account;
    if (strat && !strategyIsAll(strat)) p.strategy = strat;
  }
  return rpnlQs(Object.assign(p, extra || {}));
}

function rpnlFmtLogTime(unixSecs) {
  return new Date(unixSecs * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function rpnlKindRangeBit() {
  const r = rpnlSelectionBounds();
  return r ? rpnlFmtIstRange(r.from, r.to) : '';
}
function rpnlLogsStatus(text) {
  const st = document.getElementById('rpnlLogsStatus');
  if (!st) return;
  const bit = rpnlKindRangeBit();
  if (!text || /error|failed|invalid|Need /i.test(text)) {
    st.textContent = text || '';
    return;
  }
  st.textContent = bit && text.indexOf(bit) < 0 ? text + ' · ' + bit : text;
}

function rpnlTrimLogs(box) {
  while (rpnlLogRows.length > 4000) {
    const drop = rpnlLogRows.shift();
    if (drop && typeof lgPeekId !== 'undefined' && drop.id === lgPeekId &&
        lgPeekSrc === 'rpnl' && typeof lgClosePeek === 'function') lgClosePeek();
    if (typeof lgView !== 'undefined' && lgView === 'raw') {
      if (box && box.firstChild) box.removeChild(box.firstChild);
    } else {
      const tb = box && box.querySelector('tbody');
      if (tb && tb.firstChild) tb.removeChild(tb.firstChild);
    }
  }
  rpnlLogsFirstId = rpnlLogRows.length ? rpnlLogRows[0].id : 0;
}

function rpnlRepaintLogs() {
  if (!rpnlLogsOpen() || rpnlKind !== 'logs') return;
  const box = document.getElementById('rpnlLogsBox');
  if (!box || typeof lgPaintInto !== 'function') return;
  const top = box.scrollTop;
  lgPaintInto(box, rpnlLogRows, 'rpnl', 'No logs for this contract / window.');
  rpnlLogsStatus(rpnlLogRows.length ? rpnlLogRows.length + ' lines' : 'empty');
  box.scrollTop = top;
  if (typeof lgPeekId !== 'undefined' && lgPeekId && lgPeekSrc === 'rpnl' && typeof lgShowPeek === 'function') {
    lgShowPeek(lgPeekId, 'rpnl');
  }
}

function syncRpnlKindButtons() {
  const open = rpnlLogsOpen();
  document.querySelectorAll('[data-rpnl-kind]').forEach(function (el) {
    el.classList.toggle('on', open && el.getAttribute('data-rpnl-kind') === rpnlKind);
  });
  const pinned = rpnlHasSelection();
  const live = document.getElementById('rpnlKindLiveWrap');
  if (live) {
    live.hidden = pinned;
    live.style.display = pinned ? 'none' : ((rpnlKind === 'logs' || rpnlKind === 'fills') ? '' : 'none');
  }
  const scope = document.getElementById('rpnlKindScope');
  if (scope) {
    scope.hidden = pinned;
    if (pinned) scope.value = 'contract';
  }
  const panel = document.getElementById('rpnlLogs');
  if (panel) panel.setAttribute('data-kind', rpnlKind);
  if (rpnlKind !== 'logs') {
    const peek = document.getElementById('rpnlLgPeek');
    if (peek) peek.hidden = true;
  }
  if (typeof lgSyncViewButtons === 'function') lgSyncViewButtons();
}

function rpnlKindTitle() {
  const meta = RPNL_KIND_META[rpnlKind] || { label: rpnlKind };
  const picked = currentRpnlSel();
  const all = !rpnlHasSelection() && rpnlKindScopeVal() === 'all';
  const el = document.getElementById('rpnlLogsTitle');
  if (!el) return;
  if (all) {
    el.textContent = 'All ' + meta.label.toLowerCase();
    return;
  }
  const row = currentRpnlRow();
  const lab = row ? rpnlAccountLabel(row) : (picked.account || '');
  el.textContent = meta.label + ' · ' + (picked.contract || '') + (lab ? ' · ' + lab : '');
}

function bindRpnlLogsScroll() {
  const box = document.getElementById('rpnlLogsBox');
  if (!box || box.dataset.scrollBound) return;
  box.dataset.scrollBound = '1';
  box.addEventListener('scroll', function () {
    if (rpnlKind === 'logs') {
      if (box.scrollTop < 64) loadOlderRpnlLogs();
    } else if (box.scrollHeight - box.scrollTop - box.clientHeight < 80) {
      loadRpnlKindTable(false);
    }
  });
  box.addEventListener('wheel', function (ev) {
    if (rpnlKind === 'logs' && ev.deltaY < 0 && box.scrollTop <= 4) loadOlderRpnlLogs();
    if (rpnlKind !== 'logs' && ev.deltaY > 0 &&
        box.scrollHeight - box.scrollTop - box.clientHeight <= 4) loadRpnlKindTable(false);
  }, { passive: true });
}

function openRpnlKind(kind) {
  if (!RPNL_KIND_META[kind]) kind = 'logs';
  const page = document.getElementById('rpnl');
  if (!page) return;
  if (rpnlLogsOpen() && rpnlKind === kind) {
    closeRpnlKind();
    return;
  }
  const snap = captureRpnlView();
  if (snap) rpnlHoldSnap = snap;
  const wasOpen = rpnlLogsOpen();
  rpnlKind = kind;
  if (kind !== 'logs' && typeof lgClosePeek === 'function' && lgPeekSrc === 'rpnl') lgClosePeek();
  if (kind === 'logs') rpnlFillClosePeek();
  page.classList.add('logs-open');
  const panel = document.getElementById('rpnlLogs');
  if (panel) panel.hidden = false;
  syncRpnlKindButtons();
  bindRpnlLogsScroll();
  rpnlKindReload();
  if (!wasOpen) {
    requestAnimationFrame(function () {
      if (!rpnlLogsIsSheet()) {
        applyRpnlChartSize();
        if (snap) restoreRpnlView(snap);
      }
      rpnlHoldSnap = null;
      if (typeof syncPaneScrollers === 'function') syncPaneScrollers();
    });
  } else {
    rpnlHoldSnap = null;
  }
}

function closeRpnlKind() {
  const page = document.getElementById('rpnl');
  if (!page || !rpnlLogsOpen()) return;
  const snap = captureRpnlView();
  if (snap) rpnlHoldSnap = snap;
  page.classList.remove('logs-open');
  const panel = document.getElementById('rpnlLogs');
  if (panel) panel.hidden = true;
  if (typeof lgClosePeek === 'function' && lgPeekSrc === 'rpnl') lgClosePeek();
  rpnlFillClosePeek();
  syncRpnlKindButtons();
  requestAnimationFrame(function () {
    if (!rpnlLogsIsSheet()) {
      applyRpnlChartSize();
      if (snap) restoreRpnlView(snap);
    }
    rpnlHoldSnap = null;
  });
}

document.addEventListener('keydown', function (ev) {
  if (ev.key === 'Escape' && rpnlSelectMode) {
    setRpnlSelectMode(false);
    ev.preventDefault();
    return;
  }
  if (ev.key !== 'Escape' || !rpnlLogsOpen()) return;
  const peek = document.getElementById('rpnlLgPeek');
  if (peek && !peek.hidden) {
    if (rpnlKind === 'logs' && typeof lgClosePeek === 'function') lgClosePeek();
    else if (typeof rpnlFillClosePeek === 'function') rpnlFillClosePeek();
    return;
  }
  closeRpnlKind();
});

function toggleRpnlLogs() { openRpnlKind('logs'); }

function rpnlKindReload() {
  if (rpnlKind === 'logs') {
    rpnlLogsLastId = 0;
    rpnlLogsNoOlder = false;
    loadRpnlLogs(true);
  } else {
    rpnlKindOffset = 0;
    rpnlKindNoMore = false;
    loadRpnlKindTable(true);
  }
}

function rpnlKindLoadMore() {
  if (rpnlKind === 'logs') loadOlderRpnlLogs();
  else loadRpnlKindTable(false);
}

function exportRpnlOpenKind() {
  exportRpnlKind(rpnlKind);
}

function rpnlFillSelected() {
  return [...rpnlFillSel].filter(function (i) { return i >= 0 && i < rpnlKindRows.length; })
    .sort(function (a, b) { return a - b; })
    .map(function (i) { return rpnlKindRows[i]; });
}
function rpnlFillPaintSel() {
  const box = document.getElementById('rpnlLogsBox');
  if (!box) return;
  box.querySelectorAll('tbody tr').forEach(function (tr) {
    const i = Number(tr.dataset.i);
    const on = rpnlFillSel.has(i);
    tr.classList.toggle('selected', on);
    const cb = tr.querySelector('.dbt-sel input');
    if (cb) cb.checked = on;
  });
  const head = box.querySelector('thead .dbt-sel-h input');
  if (head) {
    const n = rpnlKindRows.length;
    head.checked = n > 0 && rpnlFillSel.size === n;
    head.indeterminate = rpnlFillSel.size > 0 && rpnlFillSel.size < n;
  }
}
function rpnlFillRenderPeek() {
  const peek = document.getElementById('rpnlLgPeek');
  if (!peek || typeof fillPeekHtml !== 'function') return;
  const rows = rpnlFillSelected();
  if (!rows.length) { peek.hidden = true; return; }
  peek.hidden = false;
  peek.innerHTML = fillPeekHtml(rows, {
    close: 'rpnlFillClosePeek()',
    copy: 'rpnlFillCopyPeek()',
    extraActs: '<button class="btn" type="button" onclick="rpnlFillSelPage(true)">All loaded</button>',
    singleLabel: rows.length === 1
      ? 'Fill · ⌘/Ctrl click to add · Shift for a range · Esc to close'
      : '',
  });
  peek.scrollTop = 0;
}
function rpnlFillRowClick(ev, i) {
  if (ev.target && ev.target.closest && ev.target.closest('.dbt-sel')) return;
  if (ev.shiftKey && rpnlFillAnchor >= 0) {
    const a = Math.min(rpnlFillAnchor, i), b = Math.max(rpnlFillAnchor, i);
    rpnlFillSel = new Set();
    for (let k = a; k <= b; k++) rpnlFillSel.add(k);
    rpnlFillAnchor = i;
  } else if (ev.metaKey || ev.ctrlKey) {
    if (rpnlFillSel.has(i)) rpnlFillSel.delete(i);
    else rpnlFillSel.add(i);
    rpnlFillAnchor = i;
  } else {
    rpnlFillSel = new Set([i]);
    rpnlFillAnchor = i;
  }
  if (!rpnlFillSel.size) { rpnlFillClosePeek(); return; }
  rpnlFillPaintSel();
  rpnlFillRenderPeek();
}
function rpnlFillToggle(i, ev) {
  if (ev) ev.stopPropagation();
  if (rpnlFillSel.has(i)) rpnlFillSel.delete(i);
  else rpnlFillSel.add(i);
  rpnlFillAnchor = i;
  if (!rpnlFillSel.size) { rpnlFillClosePeek(); return; }
  rpnlFillPaintSel();
  rpnlFillRenderPeek();
}
function rpnlFillSelPage(on) {
  if (on === false) rpnlFillSel = new Set();
  else rpnlKindRows.forEach(function (_, i) { rpnlFillSel.add(i); });
  rpnlFillAnchor = rpnlFillSel.size ? 0 : -1;
  if (!rpnlFillSel.size) { rpnlFillClosePeek(); return; }
  rpnlFillPaintSel();
  rpnlFillRenderPeek();
}
function rpnlFillClosePeek() {
  rpnlFillSel = new Set();
  rpnlFillAnchor = -1;
  const peek = document.getElementById('rpnlLgPeek');
  if (peek) peek.hidden = true;
  rpnlFillPaintSel();
}
async function rpnlFillCopyPeek() {
  if (typeof fillPeekCopyText !== 'function') return;
  const text = fillPeekCopyText(rpnlFillSelected());
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast(rpnlFillSel.size > 1 ? 'Copied ' + rpnlFillSel.size + ' fills' : 'Copied fill', 'ok');
  } catch { toast('Clipboard blocked', 'err'); }
}

function rpnlKindCell(col, v, row) {
  if (typeof dbtCellHtml === 'function') return dbtCellHtml(col, v, row);
  if (v == null || v === '') return '<span class="muted">—</span>';
  return escHtml(String(v));
}

function rpnlFillsLiveOn() {
  if (rpnlHasSelection()) return false;
  const el = document.getElementById('rpnlLogsLive');
  return !el || el.checked;
}
function rpnlLogsLiveOn() {
  if (rpnlHasSelection()) return false;
  const el = document.getElementById('rpnlLogsLive');
  return !el || el.checked;
}
function onRpnlKindLiveChange() {
  if (rpnlLogsOpen()) rpnlKindReload();
}

function rpnlKindMaxId() {
  let max = 0;
  rpnlKindRows.forEach(function (row) {
    const n = Number(row && row.id);
    if (n > max) max = n;
  });
  return max;
}

function rpnlFillRowHtml(rec, i, fresh) {
  const cols = rpnlKindCols;
  const selTd = '<td class="dbt-sel" onclick="event.stopPropagation()"><input type="checkbox" onclick="rpnlFillToggle(' + i + ', event)"></td>';
  return '<tr class="clickable' + (fresh ? ' fill-new' : '') + '" data-i="' + i + '" onclick="rpnlFillRowClick(event,' + i + ')">' + selTd +
    cols.map(function (c) {
      const v = rec[c];
      const cls = typeof dbtCellClass === 'function' ? dbtCellClass(c, v) : '';
      return '<td' + (cls ? ' class="' + cls + '"' : '') + '>' + rpnlKindCell(c, v, rec) + '</td>';
    }).join('') +
    '</tr>';
}

function rpnlFillReindex() {
  const box = document.getElementById('rpnlLogsBox');
  if (!box) return;
  box.querySelectorAll('tbody tr').forEach(function (tr, i) {
    tr.dataset.i = String(i);
    tr.setAttribute('onclick', 'rpnlFillRowClick(event,' + i + ')');
    const inp = tr.querySelector('input[type="checkbox"]');
    if (inp) inp.setAttribute('onclick', 'rpnlFillToggle(' + i + ', event)');
  });
}

async function loadRpnlKindLive() {
  if (!rpnlLogsOpen() || rpnlKind !== 'fills' || rpnlKindBusy || !rpnlFillsLiveOn()) return;
  if (!rpnlKindRows.length) {
    loadRpnlKindTable(true);
    return;
  }
  const after = rpnlKindMaxId();
  if (!after) {
    loadRpnlKindTable(true);
    return;
  }
  rpnlKindBusy = true;
  try {
    const r = await fetch('/api/db/table/fills?' + rpnlTableQs({ offset: 0, limit: 80, after_id: after }));
    if (!r.ok) return;
    const d = await r.json();
    const allCols = d.columns || [];
    const idx = {};
    allCols.forEach(function (c, i) { idx[c] = i; });
    const incoming = (d.rows || []).map(function (row) {
      const rec = {};
      allCols.forEach(function (c) { rec[c] = row[idx[c]]; });
      return rec;
    }).filter(function (rec) {
      const id = Number(rec.id);
      return id > after && !rpnlKindRows.some(function (x) { return Number(x.id) === id; });
    });
    if (!incoming.length) return;
    incoming.sort(function (a, b) { return Number(b.id) - Number(a.id); });
    const n = incoming.length;
    if (rpnlFillSel.size) {
      const next = new Set();
      rpnlFillSel.forEach(function (i) { next.add(i + n); });
      rpnlFillSel = next;
      if (rpnlFillAnchor >= 0) rpnlFillAnchor += n;
    }
    rpnlKindRows = incoming.concat(rpnlKindRows);
    rpnlKindOffset = rpnlKindRows.length;
    rpnlKindTotal = (d.total || 0) + (rpnlKindTotal || 0);
    const tb = document.querySelector('#rpnlLogsBox tbody');
    if (tb) {
      tb.insertAdjacentHTML('afterbegin', incoming.map(function (rec, i) {
        return rpnlFillRowHtml(rec, i, true);
      }).join(''));
      rpnlFillReindex();
      rpnlFillPaintSel();
    }
    const st = document.getElementById('rpnlLogsStatus');
    if (st) rpnlLogsStatus(rpnlKindOffset + ' of ' + Math.max(rpnlKindTotal, rpnlKindOffset).toLocaleString() + ' · live');
    rpnlKindTitle();
    const box = document.getElementById('rpnlLogsBox');
    if (box && box.scrollTop < 48) box.scrollTop = 0;
  } catch (e) {
  } finally {
    rpnlKindBusy = false;
  }
}

async function loadRpnlKindTable(reset) {
  if (!rpnlLogsOpen() || rpnlKind === 'logs' || rpnlKindBusy) return;
  if (!reset && rpnlKindNoMore) return;
  const box = document.getElementById('rpnlLogsBox');
  const st = document.getElementById('rpnlLogsStatus');
  const meta = RPNL_KIND_META[rpnlKind];
  if (!box || !meta || !meta.table) return;
  rpnlKindBusy = true;
  if (st && !reset) st.textContent = 'loading more…';
  try {
    const offset = reset ? 0 : rpnlKindOffset;
    const r = await fetch('/api/db/table/' + encodeURIComponent(meta.table) + '?' + rpnlTableQs({ offset: offset }));
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    const d = await r.json();
    if (d.usdinr > 0 && typeof dbtUsdInr !== 'undefined') dbtUsdInr = Number(d.usdinr);
    const allCols = d.columns || [];
    const cols = rpnlKind === 'fills' ? rpnlFillCols(allCols) : allCols.filter(function (c) {
      return c !== 'id' && c !== 'details';
    });
    const idx = {};
    allCols.forEach(function (c, i) { idx[c] = i; });
    rpnlKindCols = cols;
    rpnlKindTotal = d.total || 0;
    const rows = d.rows || [];
    if (reset) {
      rpnlKindOffset = 0;
      rpnlKindRows = [];
      rpnlFillClosePeek();
      if (!rows.length) {
        box.innerHTML = '<div style="padding:12px;color:var(--muted);">No ' + escHtml(meta.label.toLowerCase()) +
          ' in this window.</div>';
        rpnlKindNoMore = true;
        rpnlKindTitle();
        rpnlLogsStatus('empty');
        return;
      }
      const selTh = rpnlKind === 'fills'
        ? '<th class="dbt-sel-h"><input type="checkbox" onclick="event.stopPropagation(); rpnlFillSelPage(this.checked)"></th>'
        : '';
      box.innerHTML = '<table class="dtable"><thead><tr>' + selTh +
        cols.map(function (c) {
          return '<th>' + escHtml(typeof dbtColTitle === 'function' ? dbtColTitle(c) : c) + '</th>';
        }).join('') +
        '</tr></thead><tbody></tbody></table>';
    }
    const tb = box.querySelector('tbody');
    if (!tb) return;
    if (!rows.length) {
      rpnlKindNoMore = true;
      rpnlLogsStatus(rpnlKindOffset + ' of ' + rpnlKindTotal.toLocaleString() + ' · end');
      return;
    }
    tb.insertAdjacentHTML('beforeend', rows.map(function (row) {
      const rec = {};
      allCols.forEach(function (c) { rec[c] = row[idx[c]]; });
      const i = rpnlKindRows.length;
      rpnlKindRows.push(rec);
      const selTd = rpnlKind === 'fills'
        ? '<td class="dbt-sel" onclick="event.stopPropagation()"><input type="checkbox" onclick="rpnlFillToggle(' + i + ', event)"></td>'
        : '';
      return '<tr class="clickable" data-i="' + i + '" onclick="rpnlFillRowClick(event,' + i + ')">' + selTd +
        cols.map(function (c) {
          const v = rec[c];
          const cls = typeof dbtCellClass === 'function' ? dbtCellClass(c, v) : '';
          return '<td' + (cls ? ' class="' + cls + '"' : '') + '>' + rpnlKindCell(c, v, rec) + '</td>';
        }).join('') +
        '</tr>';
    }).join(''));
    rpnlKindOffset += rows.length;
    if (rpnlKindOffset >= rpnlKindTotal) rpnlKindNoMore = true;
    rpnlKindTitle();
    rpnlLogsStatus(rpnlKindOffset + ' of ' + rpnlKindTotal.toLocaleString() +
      (rpnlKindNoMore ? '' : ' · scroll for more'));
    if (reset) box.scrollTop = 0;
  } catch (e) {
    rpnlLogsStatus(e.message || 'error');
  } finally {
    rpnlKindBusy = false;
  }
}

async function loadRpnlLogs(reset) {
  if (!rpnlLogsOpen() || rpnlKind !== 'logs' || rpnlLogsBusy) return;
  const box = document.getElementById('rpnlLogsBox');
  if (!box) return;
  const live = rpnlLogsLiveOn();
  if (!reset && !live && rpnlLogsLastId) return;
  rpnlLogsBusy = true;
  try {
    let lines;
    const full = reset || !rpnlLogsLastId;
    if (full) {
      const r = await fetch('/api/logs?' + rpnlLogQs({ limit: 400 }));
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
      lines = (await r.json()).reverse();
      rpnlLogRows = lines;
      rpnlLogsFirstId = lines.length ? lines[0].id : 0;
      rpnlLogsLastId = lines.length ? lines[lines.length - 1].id : 0;
      rpnlLogsNoOlder = false;
      if (typeof lgPeekSrc !== 'undefined' && lgPeekSrc === 'rpnl' && typeof lgClosePeek === 'function') lgClosePeek();
      lgPaintInto(box, rpnlLogRows, 'rpnl', 'No logs for this contract / window.');
    } else {
      const r = await fetch('/api/logs?' + rpnlLogQs({ limit: 200, after_id: rpnlLogsLastId }));
      if (!r.ok) return;
      lines = await r.json();
      if (!lines.length) return;
      rpnlLogRows.push.apply(rpnlLogRows, lines);
      rpnlLogsLastId = Math.max(rpnlLogsLastId, ...lines.map(function (l) { return l.id; }));
      lgAppendInto(box, lines, 'end', 'rpnl');
      rpnlTrimLogs(box);
    }
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    if (full || stick) box.scrollTop = box.scrollHeight;
    rpnlKindTitle();
    rpnlLogsStatus(rpnlLogRows.length ? rpnlLogRows.length + ' lines' : 'empty');
  } catch (e) {
    rpnlLogsStatus(e.message || 'error');
  } finally {
    rpnlLogsBusy = false;
  }
}

async function loadOlderRpnlLogs() {
  if (!rpnlLogsOpen() || rpnlKind !== 'logs' || !rpnlLogsFirstId || rpnlLogsOlderBusy || rpnlLogsNoOlder) return;
  const box = document.getElementById('rpnlLogsBox');
  if (!box) return;
  rpnlLogsOlderBusy = true;
  rpnlLogsStatus('loading older…');
  try {
    const r = await fetch('/api/logs?' + rpnlLogQs({ limit: 400, before_id: rpnlLogsFirstId }));
    if (!r.ok) return;
    const lines = (await r.json()).reverse();
    if (!lines.length) {
      rpnlLogsNoOlder = true;
      rpnlLogsStatus(rpnlLogRows.length + ' lines · start');
      return;
    }
    const prevH = box.scrollHeight;
    const prevTop = box.scrollTop;
    rpnlLogRows.unshift.apply(rpnlLogRows, lines);
    rpnlLogsFirstId = lines[0].id;
    lgAppendInto(box, lines, 'start', 'rpnl');
    box.scrollTop = prevTop + (box.scrollHeight - prevH);
    rpnlLogsStatus(rpnlLogRows.length + ' lines');
  } catch (e) {
    rpnlLogsStatus(e.message || 'error');
  } finally {
    rpnlLogsOlderBusy = false;
  }
}

async function exportRpnlKind(kind) {
  try {
    if (kind !== 'logs' && kind !== 'fills') kind = rpnlKind === 'fills' ? 'fills' : 'logs';
    const f = rpnlExportFilters();
    const all = rpnlKindScopeVal() === 'all';
    const q = rpnlKindSearchVal();
    const params = { since: f.since, until: f.until };
    if (!all) {
      params.contract = f.contract;
      if (f.account) params.account = f.account;
      if (f.strategy) params.strategy = f.strategy;
    }
    if (kind === 'logs') {
      if (q) params.search = q;
    } else if (q) {
      params.q = q;
    }
    const label = all ? 'all ' + kind : kind + ' ' + f.contract;
    await downloadNamedCsv('/api/db/table/' + encodeURIComponent(kind) + '/export?' + rpnlQs(params), kind + '.csv');
    toast('Exported ' + label, 'ok');
  } catch (e) {
    toast('Export failed: ' + e.message, 'err');
  }
}
