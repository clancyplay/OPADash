// rPnL symbol list — fetched from DB fills table
async function fetchRpnlSymbols() {
  try {
    const r = await fetch(withStrategy('/api/rpnl/symbols'));
    const rows = await r.json();
    const sel = document.getElementById('rpnlSymbol');
    const list = (Array.isArray(rows) ? rows : []).map(c => typeof c === 'string'
      ? { contract: c, account: '', label: c }
      : c);
    if (list.length === 0) {
      sel.innerHTML = '<option value="">No data in DB</option>';
    } else {
      const keep = sel.value;
      list.sort((a, b) => Number(!!b.live) - Number(!!a.live));
      sel.innerHTML = list.map(c =>
        '<option value="' + escHtml(rpnlOptionValue(c)) + '">' +
          escHtml((c.live ? '● ' : '') + (c.label || c.contract)) + '</option>'
      ).join('');
      if (keep && [...sel.options].some(o => o.value === keep)) sel.value = keep;
      else {
        const hit = keep && [...sel.options].find(o => rpnlSelMatch(o.value, keep));
        if (hit) sel.value = hit.value;
      }
    }
  } catch {
    const sel = document.getElementById('rpnlSymbol');
    if (sel) sel.innerHTML = '<option value="">Error</option>';
  }
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
  return r.account || '';
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
let ohlcChart, ohlcSeries, ohlcHedgeMarkerSeries, ohlcVolSeries;
let ohlcBarSeries, ohlcLineSeries, ohlcAreaSeries, ohlcQuoteMarkerSeries;
let ohlcMaSeries = { 7: null, 25: null, 99: null };
let ohlcMaCache = { 7: [], 25: [], 99: [] };
let ohlcOrderLines = [];
let ohlcOrderSig = '';
let ohlcOrderOwner = null;
let ohlcHiLine = null, ohlcLoLine = null, ohlcHiLoOwner = null;
let ohlcMarkerSig = '';
let rpnlMarkerSig = '';
let ohlcHoverTime = null;
let ohlcStyle = 'candle';
let ohlcMaOn = { 7: true, 25: true, 99: false };
let ohlcShowVol = true;
let ohlcShowFills = true;
let ohlcLogScale = false;
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
let rpnlSummaryCache = [];
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

function rpnlModeText(s, brief) {
  if (!s) return '';
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
    let t = mode;
    if (left > 0) t += ' ' + Math.round(left) + 's';
    else if (rest > 0) t += ' ' + Math.round(rest) + 's';
    if (why && !skipWhy) t += ' · ' + why;
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

function ohlcLastPx() {
  if (!ohlcBarsCache.length) return 0;
  const b = ohlcBarsCache[ohlcBarsCache.length - 1];
  const px = Number(b && (b.close != null ? b.close : b.value));
  return isFinite(px) && px > 0 ? px : 0;
}

function liveUsdInr(s) {
  const rate = Number(s && s.usdinr);
  return isFinite(rate) && rate > 0 ? rate : 87;
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

function rpnlPosHtml(s, cls, venue) {
  if (!s || s.pos == null) return '';
  const n = Number(s.pos);
  if (!isFinite(n)) return '';
  cls = cls || 'p-pos';
  if (Math.abs(n) < 1e-12) return '<div class="' + cls + '">pos 0</div>';
  const side = n > 0 ? 'long' : 'short';
  let t = side + ' ' + fmtG(Math.abs(n));
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
  return '<div class="' + cls + ' ' + side + '">' + escHtml(t) + extra + '</div>';
}

function rpnlWalletHtml(s) {
  if (!s || s.wallet_inr == null) return '';
  const n = Number(s.wallet_inr);
  if (!isFinite(n)) return '';
  return '<span class="ri-chip">wallet ' + inrFmt(n) + '</span>';
}

function rpnlActsHtml(r) {
  if (!r.live) return '';
  const s = r.settings || {};
  const held = !!(s.hold || s.mode === 'stopped' || s.mode === 'flattening');
  const flattening = s.mode === 'flattening';
  return '<div class="p-acts">' +
    '<button type="button" data-bot-cmd="stop"' + (held ? ' class="on"' : '') + '>Stop</button>' +
    '<button type="button" data-bot-cmd="resume">Resume</button>' +
    '<button type="button" data-bot-cmd="cancel">Cancel</button>' +
    '<button type="button" data-bot-cmd="clear" title="Cancel pause, size-cool, and all limit orders — keep quoting">Clear</button>' +
    '<button type="button" class="danger' + (flattening ? ' on' : '') + '" data-bot-cmd="flatten">Close</button>' +
    '</div>';
}

function rpnlMaxHtml(r) {
  if (!r.live) return '';
  const s = r.settings || {};
  const usd = s.max_usd != null;
  const cur = usd ? s.max_usd : s.max_pos;
  const label = usd ? 'max $' : 'max lots';
  const val = (cur != null && isFinite(Number(cur)) && Number(cur) > 0) ? fmtG(cur) : '';
  return '<div class="ri-max">' +
    '<label for="rpnlMaxInput">' + escHtml(label) + '</label>' +
    '<input type="number" id="rpnlMaxInput" min="1" step="any" inputmode="decimal" autocomplete="off" data-usd="' + (usd ? '1' : '0') +
      '" value="' + escHtml(val) +
      '" title="Live until bot restart. Does not write .env. Shrinking below |pos| drops add quotes; does not flatten." />' +
    '<button type="button" data-bot-cmd="max">Set</button>' +
    '</div>';
}

async function sendBotCmd(pill, cmd) {
  const contract = pill.dataset.contract || '';
  const account = pill.dataset.account || '';
  const name = pill.dataset.qsym || contract;
  if (!contract || !cmd) return;
  if (cmd === 'flatten' && !confirm('Close ' + name + ' with a market flatten and stop quoting?')) return;
  if (cmd === 'stop' && !confirm('Stop quoting ' + name + '? Open orders cancel; position stays.')) return;
  const body = {
    cmd: cmd, contract: contract, account: account,
    strategy: pill.dataset.strategy || currentRpnlSel().strategy || (strategyIsAll(currentStrategy) ? '' : currentStrategy),
  };
  if (cmd === 'max') {
    const inp = document.getElementById('rpnlMaxInput');
    const n = Number(inp && inp.value);
    if (!isFinite(n) || n <= 0) { toast('max must be > 0', 'err'); return; }
    const usd = !inp || inp.getAttribute('data-usd') !== '0';
    body.payload = usd ? { max_usd: n } : { max_pos: n };
  }
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
    const msg = cmd === 'flatten' ? 'closing '
      : cmd === 'clear' ? 'clearing pause + limits '
      : cmd === 'max' ? ('max ' + (body.payload.max_usd != null ? '$' + body.payload.max_usd : body.payload.max_pos) + ' ')
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

function rpnlSetupBits(s) {
  const bits = [];
  const on = v => v === true || v === 'true' || v === 'on' || v === 1 || v === '1';
  if (s.edge != null) bits.push('edge ' + fmtG(s.edge) + '%');
  if (s.k_ticks != null && Number(s.k_ticks) !== 0) bits.push('k ' + fmtG(s.k_ticks) + 't');
  else if (s.k != null) bits.push('k ' + fmtG(s.k) + '%');
  if (s.hook) bits.push('hook ' + s.hook);
  const hem = rpnlGeomBit('hem', s.hem_ticks, s.hem);
  const span = rpnlGeomBit('span', s.span_ticks, s.span);
  let stepExtra = '';
  if (s.step_mult != null && s.step_mult !== 1 && s.step_mult !== '1' && Number(s.step_mult) !== 1) {
    const t = String(s.step_mult);
    stepExtra = '×' + (isFinite(Number(t)) ? fmtG(Number(t)) : t);
  }
  const step = rpnlGeomBit('step', s.step_ticks, s.step, stepExtra);
  if (hem) bits.push(hem);
  if (span) bits.push(span);
  if (step) bits.push(step);
  if (s.min_spread != null && Number(s.min_spread) > 0) bits.push('min spread ' + fmtG(s.min_spread) + '%');
  if (s.spread_pad != null && Number(s.spread_pad) > 0) bits.push('pad ' + fmtG(s.spread_pad) + '%');
  if (s.fit_auto != null) bits.push('fit auto ' + (on(s.fit_auto) ? 'on' : 'off'));
  if (s.span_spread != null) bits.push('span spread ' + (on(s.span_spread) ? 'on' : 'off'));
  if (s.vol_gate != null) bits.push('vol gate ' + (on(s.vol_gate) ? 'on' : 'off'));
  if (s.flow_gate != null) bits.push('flow gate ' + (on(s.flow_gate) ? 'on' : 'off'));
  if (s.flatten != null) bits.push('flatten ' + fmtG(s.flatten) + '%');
  if (s.stop_pause != null) bits.push('pause ' + fmtG(s.stop_pause) + 's');
  if (s.grind != null) bits.push('grind $' + fmtG(s.grind) + (s.grind_window != null ? '/' + (fmtWinSecs(s.grind_window) || (s.grind_window + 's')) : ''));
  if (s.fate != null) bits.push('fate $' + fmtG(s.fate));
  if (s.live_orders != null && s.orders != null) bits.push('orders ' + s.live_orders + '/' + s.orders);
  else if (s.orders != null) bits.push('orders ' + s.orders);
  if (s.bid_ticks != null) bits.push('bid +' + fmtG(s.bid_ticks) + 't');
  if (s.ask_ticks != null) bits.push('ask −' + fmtG(s.ask_ticks) + 't');
  if (s.max_usd != null) bits.push('max $' + fmtG(s.max_usd));
  else if (s.max_pos != null) bits.push('max ' + fmtG(s.max_pos));
  if (s.ignore != null) bits.push((s.ignore_usd ? 'ignore $' : 'ignore ') + fmtG(s.ignore));
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

function rpnlCfgBits(s) {
  if (!s) return [];
  if (s.kind === 'setup' || s.hem != null || s.fit_auto != null || s.max_usd != null || s.k != null || s.edge != null || s.mode != null) {
    return rpnlSetupBits(s);
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

function rpnlCfgHtml(s) {
  const bits = rpnlCfgBits(s);
  const mode = rpnlModeText(s);
  if (!bits.length && !mode) return '<div class="p-cfg none">no bot setup yet</div>';
  const spans = [];
  if (mode) spans.push('<span>' + escHtml(mode) + '</span>');
  bits.forEach(function (b) { spans.push('<span>' + escHtml(b) + '</span>'); });
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
  return (Array.isArray(rows) ? rows : []).filter(r => r.live || rpnlWindowFillCount(r) > 0);
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
  const sorted = rows.slice().sort((a, b) => Number(!!b.live) - Number(!!a.live));
  sel.innerHTML = sorted.map(c =>
    '<option value="' + escHtml(rpnlOptionValue(c)) + '">' +
      escHtml((c.live ? '● ' : '') + (c.label || pillOptionLabel(c))) + '</option>'
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

function quotesForCurrentRpnl(rows) {
  const row = currentRpnlRow(rows);
  if (!row || !row.live || !row.settings || !Array.isArray(row.settings.quotes)) return [];
  return row.settings.quotes;
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
    const qty = q.qty != null ? fmtG(q.qty) : '';
    const title = qty || (buy ? 'B' : 'S');
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
  updateRpnlPaneLabels();
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
  if (rpnlLogsOpen() && rpnlKind === 'logs') loadRpnlLogs(false);
}

function renderRpnlInspect(row) {
  const box = document.getElementById('rpnlInspect');
  if (!box) return;
  if (!row) {
    box.className = 'rpnl-inspect';
    box.innerHTML = '';
    box.dataset.sig = '';
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
  const cfgSig = s ? rpnlCfgBits(s).join(',') : '';
  const sig = [
    row.contract, row.account, Number(!!row.live), quote, hedge, row.fills, row.hedge_fills,
    s && s.pos, s && s.entry, s && s.upnl, s && s.upnl_usd, s && s.mark, s && s.cv, s && s.usdinr, s && s.wallet_inr, s && s.mode, s && s.hold, s && s.pause_left,
    s && s.win_rpnl, s && s.burst_rpnl, s && s.probing, s && s.rest_left,
    s && s.trip_why, s && s.probe_hold, s && s.probe_lock_left, s && s.probe_n_have,
    s && s.probe_win_ok, s && s.fate_peak, s && s.grind_rpnl, s && s.pause_clock,
    s && s.probe_rpnl_ready, s && s.probe_chop_ok,
    s && s.max_usd, s && s.max_pos,
    cfgSig, modeTxt,
  ].join('|');
  const wasOpen = box.classList.contains('open');
  const wasFolded = box.classList.contains('folded');
  box.className = 'rpnl-inspect open' + ((wasFolded || !wasOpen) ? ' folded' : '');
  box.dataset.contract = row.contract || '';
  box.dataset.account = row.account || '';
  box.dataset.strategy = row.strategy || '';
  box.dataset.qsym = qsym;
  const maxInp = document.getElementById('rpnlMaxInput');
  const keepMax = (document.activeElement === maxInp) ? {
    value: maxInp.value,
    start: maxInp.selectionStart,
    end: maxInp.selectionEnd,
  } : null;
  if (box.dataset.sig === sig && box.innerHTML) return;
  box.dataset.sig = sig;
  box.innerHTML =
    '<div class="ri-bar">' +
      '<button type="button" class="ri-fold" title="Contract setup" onclick="toggleRpnlInspectFold()">▾</button>' +
      '<div class="ri-stats">' +
        rpnlPosHtml(s, 'ri-pos', row.quote_venue) +
        // rpnlWalletHtml(s) +
        '<span class="ri-chip">' + escHtml(qlab) + ' ' + (row.fills || 0) + ' fills' +
          (hedged ? ' · ' + escHtml(hlab) + ' ' + (row.hedge_fills || 0) : '') + '</span>' +
        // (row.strategy ? '<span class="ri-chip">' + escHtml(row.strategy) + '</span>' : '') +
        // (row.live && modeTxt ? '<span class="ri-chip">' + escHtml(modeTxt) + '</span>' : '') +
      '</div>' +
      '<div class="ri-col">' +
        rpnlActsHtml(row) +
        rpnlMaxHtml(row) +
      '</div>' +
    '</div>' +
    '<div class="ri-extra">' +
    '<div class="ri-setup">' +
      '<div class="ri-setup-h">Contract setup</div>' +
      (hedged
        ? '<div class="ri-split"><span style="color:#26a69a">' + escHtml(qlab) + ' ' + inrFmt(quote) +
          '</span><span style="color:#ff9800">' + escHtml(hlab) + ' ' + inrFmt(hedge) + '</span></div>'
        : '') +
      rpnlCfgHtml(s) +
    '</div>' +
    rpnlGatesHtml(s) +
    '</div>';
  if (keepMax) {
    const el = document.getElementById('rpnlMaxInput');
    if (el) {
      el.value = keepMax.value;
      el.focus();
      try { el.setSelectionRange(keepMax.start, keepMax.end); } catch (e) {}
    }
  }
  if (!box.dataset.bound) {
    box.dataset.bound = '1';
    box.addEventListener('click', ev => {
      const act = ev.target.closest('[data-bot-cmd]');
      if (!act) return;
      ev.preventDefault();
      ev.stopPropagation();
      sendBotCmd(act.closest('.rpnl-inspect') || box, act.getAttribute('data-bot-cmd'));
    });
    box.addEventListener('keydown', ev => {
      if (ev.key !== 'Enter' || !ev.target || ev.target.id !== 'rpnlMaxInput') return;
      ev.preventDefault();
      sendBotCmd(box, 'max');
    });
  }
}

function rpnlPillMode(r) {
  return rpnlModeText(r && r.settings, true) || '';
}

function rpnlPillMax(r) {
  const s = r && r.settings || {};
  if (s.max_usd != null && isFinite(Number(s.max_usd))) return 'max $' + fmtG(s.max_usd);
  if (s.max_pos != null && isFinite(Number(s.max_pos))) return 'max ' + fmtG(s.max_pos);
  if (s.max_position != null && isFinite(Number(s.max_position))) return 'max ' + fmtG(s.max_position);
  return '';
}

function rpnlPillWallet(r) {
  const n = Number(r && r.settings && r.settings.wallet_inr);
  if (!isFinite(n) || n <= 0) return '';
  return 'bal ' + inrFmt(n);
}

function rpnlPillHtml(r, cur, nameCount) {
  const key = rpnlOptionValue(r);
  const active = key === cur ? ' active' : '';
  const liveCls = r.live ? ' live' : '';
  const acct = rpnlAccountLabel(r);
  const qv = r.quote_venue || 'delta';
  const qlab = r.quote_label || 'Delta';
  const qsym = r.quote_symbol || r.contract;
  const dupe = nameCount[qsym + '|' + acct] > 1 && r.account && r.account !== acct;
  const name = qsym + (acct ? ' · ' + acct : '') + (dupe ? ' #' + r.account : '');
  const main = rpnlPillMain(r);
  const mainCol = main >= 0 ? 'var(--green)' : 'var(--red)';
  const mode = rpnlPillMode(r);
  const maxBit = rpnlPillMax(r);
  const walletBit = rpnlPillWallet(r);
  const strat = r.strategy || '';
  return '<button type="button" class="rpnl-pill' + active + liveCls + '" data-rpnl-key="' + escHtml(key) + '">' +
    '<div class="p-name">' + (r.live ? '<span class="p-live" title="live"></span>' : '') +
      '<span class="p-sym">' + escHtml(name) + '</span>' +
      (strat ? '<span class="rpnl-strat">' + escHtml(strat) + '</span>' : '') +
      '<span class="rpnl-venue ' + rpnlVenueClass(qv) + '">' + escHtml(qlab) + '</span></div>' +
    '<div class="p-val" style="color:' + mainCol + '">' + rpnlPillValInner(r) + '</div>' +
    (maxBit ? '<div class="p-max">' + escHtml(maxBit) + '</div>' : '') +
    (walletBit ? '<div class="p-bal">' + escHtml(walletBit) + '</div>' : '') +
    (mode ? '<div class="p-mode">' + escHtml(mode) + '</div>' : '') +
    '</button>';
}

function rpnlPillMain(r) {
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
  const main = rpnlPillMain(r);
  return inrFmt(main) + '<span class="p-usd">' + rpnlPillUsdText(r, main) + '</span>';
}

function renderRpnlSummary(rows, hours) {
  const wrap = document.getElementById('rpnlSummaryWrap');
  if (!wrap) return;
  rows = filterRpnlWindowRows(rows);
  if (!rows.length) {
    wrap.dataset.keys = '';
    wrap.innerHTML = '<div class="rpnl-empty">No live bots or fills in this window.</div>';
    rpnlSummaryCache = [];
    renderRpnlInspect(null);
    applyOhlcOrderLines([]);
    return;
  }
  rpnlSummaryCache = rows;
  const cur = (document.getElementById('rpnlSymbol') || {}).value || '';
  const nameCount = {};
  rows.forEach(r => {
    const n = (r.quote_symbol || r.contract) + '|' + rpnlAccountLabel(r);
    nameCount[n] = (nameCount[n] || 0) + 1;
  });
  const sorted = rows.slice().sort((a, b) => Number(!!b.live) - Number(!!a.live));
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
      const val = el.querySelector('.p-val');
      const main = rpnlPillMain(r);
      if (val) {
        val.innerHTML = rpnlPillValInner(r);
        val.style.color = main >= 0 ? 'var(--green)' : 'var(--red)';
      }
      const mode = rpnlPillMode(r);
      let modeEl = el.querySelector('.p-mode');
      if (mode) {
        if (!modeEl) {
          modeEl = document.createElement('div');
          modeEl.className = 'p-mode';
          el.appendChild(modeEl);
        }
        modeEl.textContent = mode;
      } else if (modeEl) {
        modeEl.remove();
      }
      const maxBit = rpnlPillMax(r);
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
      const nameEl = el.querySelector('.p-name');
      if (nameEl) {
        const dot = nameEl.querySelector('.p-live');
        if (r.live && !dot) nameEl.insertAdjacentHTML('afterbegin', '<span class="p-live" title="live"></span>');
        if (!r.live && dot) dot.remove();
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
      }
    });
  }
  if (!wrap.dataset.bound) {
    wrap.dataset.bound = '1';
    wrap.addEventListener('click', ev => {
      const btn = ev.target.closest('[data-rpnl-key]');
      if (btn) pickRpnlContract(btn.dataset.rpnlKey);
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

function pickRpnlContract(key) {
  const sel = document.getElementById('rpnlSymbol');
  if (!sel) return;
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
    if (rpnlRangeIsEcho(chartId, range)) return;
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
  rpnlResumeLiveFollow();
  applyRpnlChartSize();
  rpnlBeginSync();
  try {
    rpnlApplyLiveEdgePad();
    ohlcChart.timeScale().fitContent();
    rpnlChart.timeScale().fitContent();
  } catch (e) {}
  syncOhlcGoLive();
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
function rpnlZoomPriceScale(chart, dy, h) {
  if (!chart || !dy) return;
  const scale = chart.priceScale('right');
  let top = 0.1;
  let bot = chart === rpnlChart ? 0.08 : (ohlcShowVol ? 0.18 : 0.05);
  try {
    const m = scale.options() && scale.options().scaleMargins;
    if (m) { top = m.top; bot = m.bottom; }
  } catch (e) {}
  const k = dy / Math.max(120, h || 240) * 0.45;
  const clamp = (v) => Math.max(0.02, Math.min(0.42, v));
  try {
    scale.applyOptions({
      autoScale: false,
      scaleMargins: { top: clamp(top - k), bottom: clamp(bot - k) },
    });
  } catch (e) {}
  if (chart === rpnlChart && rpnlAutoY) {
    rpnlAutoY = false;
    syncRpnlViewButtons();
  }
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
      if (!rpnlMobileYAxis()) return;
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
}

function saveOhlcPrefs() {
  lsSet(LS_OHLC_STYLE, ohlcStyle);
  lsSet(LS_OHLC_MA, JSON.stringify(ohlcMaOn));
  lsSet(LS_OHLC_VOL, ohlcShowVol ? '1' : '0');
  lsSet(LS_OHLC_FILLS, ohlcShowFills ? '1' : '0');
  lsSet(LS_OHLC_LOG, ohlcLogScale ? '1' : '0');
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
  if (vol) vol.classList.toggle('on', ohlcShowVol);
  if (fills) fills.classList.toggle('on', ohlcShowFills);
  if (log) log.classList.toggle('on', ohlcLogScale);
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

function updateOhlcHiLo() {
  const series = ohlcActiveSeries();
  if (!series || !ohlcChart || !ohlcBarsCache.length) return;
  let from = 0, to = ohlcBarsCache.length - 1;
  try {
    const vr = ohlcChart.timeScale().getVisibleLogicalRange();
    if (vr) {
      from = Math.max(0, Math.floor(vr.from));
      to = Math.min(ohlcBarsCache.length - 1, Math.ceil(vr.to));
    }
  } catch (e) {}
  let hi = -Infinity, lo = Infinity;
  for (let i = from; i <= to; i++) {
    const b = ohlcBarsCache[i];
    if (!b) continue;
    if (b.high > hi) hi = b.high;
    if (b.low < lo) lo = b.low;
  }
  if (!isFinite(hi) || !isFinite(lo)) return;
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
    '<span>H <b>' + fmtPxFull(d.high) + '</b></span>' +
    '<span>L <b>' + fmtPxFull(d.low) + '</b></span>' +
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
  const next = {
    time: last.time,
    open: last.open,
    high: Math.max(last.high, mark),
    low: Math.min(last.low, mark),
    close: mark,
    volume: last.volume,
  };
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
  rpnlNeedsFit = false;
  if (!rpnlRangePinned) rpnlSyncRangeFromView();
  rpnlPaintBrush();
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
  if (rpnlChart) rpnlChart.priceScale('right').applyOptions({ autoScale: rpnlAutoY });
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
      axisPressedMouseMove: { time: true, price: true },
      axisDoubleClickReset: true,
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
  rpnlHedgeSeries.applyOptions({ visible: false });
  rpnlNetSeries.applyOptions({ visible: false });
  setRpnlView('cumul');

  ohlcChart.timeScale().subscribeVisibleLogicalRangeChange(onRpnlLogicalRange('ohlc'));
  rpnlChart.timeScale().subscribeVisibleLogicalRangeChange(onRpnlLogicalRange('rpnl'));
  ohlcChart.subscribeCrosshairMove((param) => syncCrosshair('ohlc', param));
  rpnlChart.subscribeCrosshairMove((param) => syncCrosshair('rpnl', param));
  bindRpnlSelectLayer();
  bindRpnlUserCamera();

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

function toggleRpnlMore() {
  const page = document.getElementById('rpnl');
  if (!page) return;
  const open = page.classList.toggle('more-open');
  const btn = document.getElementById('rpnlMoreBtn');
  if (btn) {
    btn.textContent = open ? 'Less' : 'More';
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  if (open) {
    const foot = document.getElementById('rpnlTools');
    if (foot) foot.classList.remove('export-open');
    const ex = document.getElementById('rpnlExportBtn');
    if (ex) ex.classList.remove('on');
    closeOhlcTools();
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
  if (open) {
    const page = document.getElementById('rpnl');
    if (page && page.classList.contains('more-open')) toggleRpnlMore();
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
  if (open) {
    const page = document.getElementById('rpnl');
    if (page && page.classList.contains('more-open')) toggleRpnlMore();
  }
}
function toggleRpnlInspectFold() {
  const box = document.getElementById('rpnlInspect');
  if (!box || !box.classList.contains('open')) return;
  box.classList.toggle('folded');
  requestAnimationFrame(resizeRpnlCharts);
}
function closeRpnlPopovers(ev) {
  const page = document.getElementById('rpnl');
  if (!page || !page.classList.contains('visible')) return;
  if (page.classList.contains('more-open') && !(ev && ev.target && ev.target.closest('.rp-bar'))) {
    toggleRpnlMore();
  }
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
    const key = syncRpnlSymbolSelect(rows);
    renderRpnlSummary(rows, hoursArg);
    if (!key) {
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
    const url = '/api/rpnl?symbol=' + encodeURIComponent(sym) + winQ + '&bucket=' + bucket + acctBit + '&exchange=' + venue + stratQ;
    const fillUrl = '/api/rpnl/fills?symbol=' + encodeURIComponent(sym) + winQ + '&bucket=' + bucket + acctBit + stratQ;
    const candleUrl = '/api/candles?symbol=' + encodeURIComponent(sym) + '&interval=' + candleIvl + winQ + acctBit + stratQ;
    const settled = await Promise.allSettled([
      fetch(url),
      fetch(candleUrl),
      fetch(fillUrl + '&exchange=quote'),
      venue === 'quote' ? Promise.resolve(null) : fetch(fillUrl + '&exchange=hedge'),
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
        bars = dedupeTimes((cd.candles || []).map(b => ({
          time: b.time,
          open: Number(b.open), high: Number(b.high), low: Number(b.low), close: Number(b.close),
          volume: Number(b.volume) || 0,
        })).filter(b => [b.open, b.high, b.low, b.close].every(isFinite)));
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
      ohlcBarsCache = rpnlMergeByTime(prevBars, bars);
      savedView = rpnlShiftLogical(savedView, prevBars, ohlcBarsCache);
      if (savedView) rpnlHoldSnap = savedView;
    } else {
      ohlcBarsCache = bars;
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
      toast('No fills for ' + (d.contract || sym) + ' in this window.');
      if (!keepRange && rpnlNeedsFit) scheduleRpnlFit();
      return;
    }

    if (!rpnlRangePinned) rpnlSyncRangeFromView();
    rpnlPaintBrush();
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
  if (!el) return;
  el.className = 'range-mode' + (rpnlSelectMode ? ' sel' : rpnlRangePinned ? ' pin' : '');
  el.textContent = rpnlSelectMode ? 'drag to select' : (rpnlRangePinned ? 'pinned' : 'chart view');
}
function rpnlSyncRangeFromView() {
  const r = rpnlVisibleUnixRange();
  if (!r) return;
  rpnlSetRangeInputs(r.from, r.to, true);
  rpnlSetRangeMode();
}
function rpnlFollowView() {
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
  rpnlSetRangeMode();
  rpnlPaintBrush();
  if (rpnlLogsOpen()) rpnlKindReload();
}
function rpnlJumpChartToRange() {
  const r = rpnlActiveRange();
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
function setRpnlSelectMode(on) {
  rpnlSelectMode = !!on;
  const layer = document.getElementById('rpnlSelectLayer');
  const btn = document.getElementById('rpnlSelectBtn');
  if (layer) layer.hidden = !rpnlSelectMode;
  if (btn) {
    btn.style.borderColor = rpnlSelectMode ? 'var(--accent)' : '';
    btn.style.color = rpnlSelectMode ? '#fff' : '';
  }
  if (rpnlChart) {
    rpnlChart.applyOptions({
      handleScroll: { mouseWheel: true, pressedMouseMove: !rpnlSelectMode, horzTouchDrag: !rpnlSelectMode, vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: { time: !rpnlSelectMode, price: !rpnlSelectMode }, mouseWheel: !rpnlSelectMode, pinch: !rpnlSelectMode },
    });
  }
  rpnlSetRangeMode();
}
function toggleRpnlSelect() {
  setRpnlSelectMode(!rpnlSelectMode);
  if (rpnlSelectMode) toast('Drag across the rPnL chart to pin a window', '');
}
function rpnlPaintBrush() {
  const box = document.getElementById('rpnlBrush');
  if (!box || !rpnlChart) return;
  if (!rpnlRangePinned || rpnlPinFrom == null || rpnlPinTo == null) {
    box.hidden = true;
    return;
  }
  const ts = rpnlChart.timeScale();
  let x1, x2;
  try {
    x1 = ts.timeToCoordinate(Math.min(rpnlPinFrom, rpnlPinTo));
    x2 = ts.timeToCoordinate(Math.max(rpnlPinFrom, rpnlPinTo));
  } catch (e) { box.hidden = true; return; }
  if (x1 == null || x2 == null) { box.hidden = true; return; }
  const left = Math.min(x1, x2);
  const width = Math.max(2, Math.abs(x2 - x1));
  box.hidden = false;
  box.style.left = left + 'px';
  box.style.width = width + 'px';
}
function bindRpnlSelectLayer() {
  const layer = document.getElementById('rpnlSelectLayer');
  if (!layer || layer.dataset.bound) return;
  layer.dataset.bound = '1';
  let startX = null;
  const xToTime = (clientX) => {
    const rect = (document.getElementById('rpnlChart') || layer).getBoundingClientRect();
    const x = clientX - rect.left;
    try { return rpnlChart.timeScale().coordinateToTime(x); } catch (e) { return null; }
  };
  layer.addEventListener('mousedown', (ev) => {
    if (!rpnlSelectMode) return;
    ev.preventDefault();
    startX = ev.clientX;
    const t = xToTime(ev.clientX);
    if (t == null) return;
    rpnlRangePinned = true;
    rpnlPinFrom = rpnlPinTo = Number(t);
    rpnlPaintBrush();
  });
  layer.addEventListener('mousemove', (ev) => {
    if (startX == null) return;
    const t = xToTime(ev.clientX);
    if (t == null) return;
    rpnlPinTo = Number(t);
    rpnlSetRangeInputs(rpnlPinFrom, rpnlPinTo, true);
    rpnlPaintBrush();
  });
  const endDrag = (ev) => {
    if (startX == null) return;
    startX = null;
    const t = xToTime(ev.clientX);
    if (t != null) rpnlPinTo = Number(t);
    if (rpnlPinFrom != null && rpnlPinTo != null && rpnlPinFrom === rpnlPinTo) {
      rpnlPinTo = rpnlPinFrom + 60;
    }
    rpnlSetRangeInputs(rpnlPinFrom, rpnlPinTo, true);
    rpnlSetRangeMode();
    rpnlPaintBrush();
    setRpnlSelectMode(false);
    if (rpnlLogsOpen()) rpnlKindReload();
  };
  layer.addEventListener('mouseup', endDrag);
  layer.addEventListener('mouseleave', (ev) => { if (startX != null) endDrag(ev); });
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

function rpnlQs(p) {
  return Object.entries(p).filter(([, v]) => v !== '' && v != null && v !== false)
    .map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
}

function rpnlKindSearchVal() {
  return ((document.getElementById('rpnlKindSearch') || {}).value || '').trim();
}

function rpnlKindScopeVal() {
  const el = document.getElementById('rpnlKindScope');
  return (el && el.value) === 'all' ? 'all' : 'contract';
}

function rpnlLogWindow() {
  if (rpnlRangePinned && rpnlPinFrom != null && rpnlPinTo != null) {
    const a = Math.min(rpnlPinFrom, rpnlPinTo);
    const b = Math.max(rpnlPinFrom, rpnlPinTo);
    if (b - a > 120) return { since: String(Math.floor(a)), until: String(Math.floor(b) + 1) };
  }
  const v = rpnlCurrentHours != null ? rpnlCurrentHours : rpnlHoursSel();
  const hours = v === 'today' ? 24 : (Number(v) || 24);
  const now = Date.now() / 1000;
  return {
    since: String(Math.floor(now - hours * 3600)),
    until: String(Math.floor(now + 60)),
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
  const win = rpnlLogWindow();
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

function rpnlLogsStatus(text) {
  const st = document.getElementById('rpnlLogsStatus');
  if (st) st.textContent = text;
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
  const live = document.getElementById('rpnlKindLiveWrap');
  if (live) live.style.display = rpnlKind === 'logs' ? '' : 'none';
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
  const all = rpnlKindScopeVal() === 'all';
  const el = document.getElementById('rpnlLogsTitle');
  if (!el) return;
  if (all) el.textContent = 'All ' + meta.label.toLowerCase();
  else {
    el.textContent = meta.label + ' · ' + (picked.contract || '') +
      (picked.account ? ' · ' + picked.account : '');
  }
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
  page.classList.add('logs-open');
  const panel = document.getElementById('rpnlLogs');
  if (panel) panel.hidden = false;
  syncRpnlKindButtons();
  bindRpnlLogsScroll();
  rpnlKindReload();
  if (!wasOpen) {
    requestAnimationFrame(function () {
      applyRpnlChartSize();
      if (snap) restoreRpnlView(snap);
      rpnlHoldSnap = null;
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
  syncRpnlKindButtons();
  requestAnimationFrame(function () {
    applyRpnlChartSize();
    if (snap) restoreRpnlView(snap);
    rpnlHoldSnap = null;
  });
}

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

function rpnlKindCell(col, v) {
  if (typeof dbtCellHtml === 'function') return dbtCellHtml(col, v);
  if (v == null || v === '') return '<span class="muted">—</span>';
  return escHtml(String(v));
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
      if (!rows.length) {
        box.innerHTML = '<div style="padding:12px;color:var(--muted);">No ' + escHtml(meta.label.toLowerCase()) +
          ' in this window.</div>';
        rpnlKindNoMore = true;
        rpnlKindTitle();
        if (st) st.textContent = 'empty';
        return;
      }
      box.innerHTML = '<table class="dtable"><thead><tr>' +
        cols.map(function (c) { return '<th>' + escHtml(c) + '</th>'; }).join('') +
        '</tr></thead><tbody></tbody></table>';
    }
    const tb = box.querySelector('tbody');
    if (!tb) return;
    if (!rows.length) {
      rpnlKindNoMore = true;
      if (st) st.textContent = rpnlKindOffset + ' of ' + rpnlKindTotal.toLocaleString() + ' · end';
      return;
    }
    tb.insertAdjacentHTML('beforeend', rows.map(function (row) {
      return '<tr>' +
        cols.map(function (c) {
          const v = row[idx[c]];
          const cls = typeof dbtCellClass === 'function' ? dbtCellClass(c, v) : '';
          return '<td' + (cls ? ' class="' + cls + '"' : '') + '>' + rpnlKindCell(c, v) + '</td>';
        }).join('') +
        '</tr>';
    }).join(''));
    rpnlKindOffset += rows.length;
    if (rpnlKindOffset >= rpnlKindTotal) rpnlKindNoMore = true;
    rpnlKindTitle();
    if (st) {
      st.textContent = rpnlKindOffset + ' of ' + rpnlKindTotal.toLocaleString() +
        (rpnlKindNoMore ? '' : ' · scroll for more');
    }
    if (reset) box.scrollTop = 0;
  } catch (e) {
    if (st) st.textContent = e.message || 'error';
  } finally {
    rpnlKindBusy = false;
  }
}

async function loadRpnlLogs(reset) {
  if (!rpnlLogsOpen() || rpnlKind !== 'logs' || rpnlLogsBusy) return;
  const box = document.getElementById('rpnlLogsBox');
  if (!box) return;
  const liveEl = document.getElementById('rpnlLogsLive');
  const live = !liveEl || liveEl.checked;
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
