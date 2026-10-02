// Balances page — live exchange wallets + equity history from snapshots
let balTimer;
let balLastBoard = null;
let balLastHist = { total: [], exchanges: [], accounts: [] };
let balSelected = '';
let balEqChart = null, balAcctChart = null, balSparkChart = null;
let balEqSeries = {};
let balAcctSeries = {};
let balSparkSeries = null;
let balHidden = {};
let balResizeBound = false;
let balActReq = 0;
let balExFilter = 'all';
let balSearchQ = '';

const BAL_EX_COLORS = {
  delta: '#5b8def',
  binance: '#f0b90b',
  kucoin: '#23af91',
  coindcx: '#e85d04',
  aster: '#a78bfa',
  bybit: '#f7a600',
  coinbase: '#1652f0',
};
const BAL_ACCT_PAL = [
  '#7eb8ff', '#80cbc4', '#ce93d8', '#ffcc80', '#90caf9',
  '#ef9a9a', '#c5e1a5', '#b39ddb', '#81d4fa', '#ffab91',
];

function initBalances() {
  loadBalances();
  setupBalAuto();
  if (!balResizeBound) {
    balResizeBound = true;
    window.addEventListener('resize', resizeBalCharts);
  }
}

function balMoney(n) {
  if (typeof rptMoney === 'function') return rptMoney(n);
  const v = Number(n) || 0;
  return '₹' + Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

function balAcctName(a) {
  const name = String((a && a.account_name) || '').trim();
  const id = String((a && a.account) || '').trim();
  if (name) return name;
  return id || 'unnamed';
}

function balStatus(a) {
  if (a && a.live) return { key: 'live', label: 'Live' };
  if (a && a.idle) return { key: 'idle', label: 'Idle' };
  return { key: 'snap', label: 'Snapshot' };
}

function balVenueKeys(a) {
  const venues = (a && a.venues) || {};
  const errs = (a && a.venue_errors) || {};
  const keys = Object.keys(venues).filter(function (ex) {
    return venues[ex] != null || errs[ex];
  });
  Object.keys(errs).forEach(function (ex) {
    if (keys.indexOf(ex) < 0) keys.push(ex);
  });
  return keys.sort();
}

function balPrimaryEx(a) {
  const venues = (a && a.venues) || {};
  let best = '';
  let bestV = -Infinity;
  Object.keys(venues).forEach(function (ex) {
    const v = Number(venues[ex]);
    if (isFinite(v) && v > bestV) {
      bestV = v;
      best = ex;
    }
  });
  if (best) return best;
  const keys = balVenueKeys(a);
  return keys[0] || '';
}

function balMatchesFilter(a) {
  if (balExFilter && balExFilter !== 'all') {
    const keys = balVenueKeys(a);
    if (keys.indexOf(balExFilter) < 0) return false;
  }
  const q = String(balSearchQ || '').trim().toLowerCase();
  if (!q) return true;
  const hay = [
    balAcctName(a),
    a.account,
    (a.strategies || []).join(' '),
    balVenueKeys(a).join(' '),
  ].join(' ').toLowerCase();
  return hay.indexOf(q) >= 0;
}

function onBalFilterChange() {
  const inp = document.getElementById('balSearch');
  balSearchQ = inp ? inp.value : '';
  if (balLastBoard) renderBalBoard(balLastBoard, balLastHist);
}

function setBalExFilter(ex) {
  balExFilter = String(ex || 'all');
  if (balLastBoard) renderBalBoard(balLastBoard, balLastHist);
}

function balUpdatedHtml(a) {
  const t = a.time ? fmtIST(a.time) : '—';
  const st = balStatus(a);
  const extra = st.key === 'live' ? ' · WS'
    : (st.key === 'idle' ? ' · REST/' + balIdleLabel() : '');
  return t + '<div class="aid">' + escHtml(st.label + extra) + '</div>';
}

function balIdleLabel(secs) {
  const n = Number(secs != null ? secs : ((balLastBoard || {}).idle_secs));
  const s = (Number.isFinite(n) && n > 0) ? n : 900;
  if (s % 60 === 0) return Math.round(s / 60) + 'm';
  return Math.round(s) + 's';
}

function balHours() {
  return parseInt((document.getElementById('balHours') || {}).value, 10) || 168;
}

function balAcctColor(id) {
  let h = 0;
  const s = String(id || '');
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return BAL_ACCT_PAL[Math.abs(h) % BAL_ACCT_PAL.length];
}

function balDelta(pts) {
  if (!pts || pts.length < 2) return null;
  const a = Number(pts[0].v);
  const b = Number(pts[pts.length - 1].v);
  if (!isFinite(a) || !isFinite(b)) return null;
  return b - a;
}

function balChartOpts() {
  return {
    autoSize: true,
    layout: { background: { color: '#161a25' }, textColor: '#d1d4dc' },
    grid: { vertLines: { color: '#1c2130' }, horzLines: { color: '#1c2130' } },
    rightPriceScale: { borderColor: '#303647' },
    timeScale: { borderColor: '#303647', timeVisible: true, secondsVisible: false },
    crosshair: { mode: 0 },
  };
}

function balPriceFmt() {
  return {
    type: 'custom', minMove: 1, formatter: function (p) {
      const n = Number(p) || 0;
      return (n < 0 ? '−' : '') + '₹' + Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 });
    },
  };
}

function balToLC(pts) {
  const out = [];
  let lastT = 0;
  (pts || []).forEach(function (p) {
    const t = Number(p.t);
    const v = Number(p.v);
    if (!t || !isFinite(v)) return;
    if (t === lastT) {
      if (out.length) out[out.length - 1].value = v;
      return;
    }
    if (t < lastT) return;
    lastT = t;
    out.push({ time: t, value: v });
  });
  if (out.length === 1) {
    out.unshift({ time: out[0].time - 3600, value: out[0].value });
  }
  return out;
}

function balClearSeries(chart, bag) {
  Object.keys(bag).forEach(function (k) {
    try { chart.removeSeries(bag[k]); } catch (e) { /* gone */ }
    delete bag[k];
  });
}

function resizeBalCharts() {
  [
    [balEqChart, 'balEqChart'],
    [balAcctChart, 'balAcctChart'],
    [balSparkChart, 'balDetailChart'],
  ].forEach(function (pair) {
    const chart = pair[0];
    const el = document.getElementById(pair[1]);
    if (chart && el && el.clientWidth) chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
  });
}

function ensureBalCharts() {
  if (typeof LightweightCharts === 'undefined') return false;
  const eqEl = document.getElementById('balEqChart');
  const acEl = document.getElementById('balAcctChart');
  if (!eqEl || !acEl) return false;
  if (!balEqChart) balEqChart = LightweightCharts.createChart(eqEl, balChartOpts());
  if (!balAcctChart) balAcctChart = LightweightCharts.createChart(acEl, balChartOpts());
  return true;
}

function balStitch(hist, board) {
  const t = Number(board && board.as_of) || Math.floor(Date.now() / 1000);
  const out = {
    total: ((hist && hist.total) || []).map(function (p) { return { t: p.t, v: p.v }; }),
    exchanges: ((hist && hist.exchanges) || []).map(function (e) {
      return { exchange: e.exchange, label: e.label, points: (e.points || []).map(function (p) { return { t: p.t, v: p.v }; }) };
    }),
    accounts: ((hist && hist.accounts) || []).map(function (a) {
      return {
        account: a.account,
        account_name: a.account_name,
        last: a.last,
        points: (a.points || []).map(function (p) { return { t: p.t, v: p.v }; }),
      };
    }),
  };
  function put(series, val) {
    if (val == null || !isFinite(Number(val))) return;
    const v = Number(val);
    if (series.length && series[series.length - 1].t >= t) series[series.length - 1].v = v;
    else series.push({ t: t, v: v });
  }
  if (board && board.totals && board.totals.balance != null) put(out.total, board.totals.balance);
  (board.exchanges || []).forEach(function (e) {
    let row = out.exchanges.find(function (x) { return x.exchange === e.exchange; });
    if (!row) {
      row = { exchange: e.exchange, label: e.label, points: [] };
      out.exchanges.push(row);
    }
    put(row.points, e.balance);
  });
  (board.accounts || []).forEach(function (a) {
    if (!a.account || a.total == null) return;
    let row = out.accounts.find(function (x) { return x.account === a.account; });
    if (!row) {
      row = { account: a.account, account_name: a.account_name, points: [] };
      out.accounts.push(row);
    }
    put(row.points, a.total);
    if (row.points.length) row.last = row.points[row.points.length - 1].v;
  });
  return out;
}

function drawBalEqChart(hist) {
  if (!ensureBalCharts()) return;
  balClearSeries(balEqChart, balEqSeries);
  const tot = balToLC(hist.total);
  if (tot.length) {
    const s = balEqChart.addLineSeries({
      color: '#e8edf7', lineWidth: 2, priceLineVisible: false, lastValueVisible: true,
      title: 'Total', priceFormat: balPriceFmt(),
    });
    s.setData(tot);
    balEqSeries.total = s;
    if (balHidden['eq:total']) s.applyOptions({ visible: false });
  }
  (hist.exchanges || []).forEach(function (e) {
    const pts = balToLC(e.points);
    if (!pts.length) return;
    const hid = 'eq:' + e.exchange;
    const s = balEqChart.addLineSeries({
      color: BAL_EX_COLORS[e.exchange] || '#9aa4b8',
      lineWidth: 1.5, priceLineVisible: false, lastValueVisible: true,
      title: e.label || e.exchange, priceFormat: balPriceFmt(),
    });
    s.setData(pts);
    balEqSeries[e.exchange] = s;
    if (balHidden[hid]) s.applyOptions({ visible: false });
  });
  balEqChart.timeScale().fitContent();
  const legend = document.getElementById('balEqLegend');
  const chips = [{ key: 'total', label: 'Total', color: '#e8edf7' }].concat(
    (hist.exchanges || []).map(function (e) {
      return { key: e.exchange, label: e.label || e.exchange, color: BAL_EX_COLORS[e.exchange] || '#9aa4b8' };
    })
  );
  legend.innerHTML = chips.map(function (c) {
    const on = !balHidden['eq:' + c.key];
    return '<button type="button" class="bal-leg' + (on ? ' on' : ' off') + '" style="--sw:' + c.color + '" onclick="toggleBalSeries(\'eq\',\'' + escHtml(c.key) + '\')">' +
      escHtml(c.label) + '</button>';
  }).join('');
}

function drawBalAcctChart(hist) {
  if (!ensureBalCharts()) return;
  balClearSeries(balAcctChart, balAcctSeries);
  const rows = (hist.accounts || []).slice().sort(function (a, b) {
    return (Number(b.last) || 0) - (Number(a.last) || 0);
  });
  const legend = document.getElementById('balAcctLegend');
  legend.innerHTML = rows.map(function (a) {
    const id = a.account || '';
    const name = a.account_name && a.account_name !== id ? a.account_name : id;
    const on = !balHidden['ac:' + id];
    const color = balAcctColor(id);
    const d = balDelta(a.points);
    const dBit = d == null ? '' : ' <span class="bal-delta ' + (d >= 0 ? 'up' : 'dn') + '">' +
      (typeof rptSigned === 'function' ? rptSigned(d) : balMoney(d)) + '</span>';
    return '<button type="button" class="bal-leg' + (on ? ' on' : ' off') + (balSelected === id ? ' sel' : '') +
      '" style="--sw:' + color + '" data-account="' + escHtml(id) +
      '" onclick="selectBalAccount(this.dataset.account)">' +
      escHtml(name) + dBit + '</button>';
  }).join('');
  rows.forEach(function (a) {
    const id = a.account || '';
    const pts = balToLC(a.points);
    if (!pts.length || !id) return;
    const selected = balSelected === id;
    const s = balAcctChart.addLineSeries({
      color: balAcctColor(id),
      lineWidth: selected ? 2.5 : 1,
      priceLineVisible: false,
      lastValueVisible: selected,
      title: a.account_name || id,
      priceFormat: balPriceFmt(),
    });
    s.setData(pts);
    balAcctSeries[id] = s;
    if (balHidden['ac:' + id]) s.applyOptions({ visible: false });
  });
  balAcctChart.timeScale().fitContent();
}

function toggleBalSeries(kind, key) {
  const hid = kind + ':' + key;
  balHidden[hid] = !balHidden[hid];
  const bag = kind === 'eq' ? balEqSeries : balAcctSeries;
  if (bag[key]) bag[key].applyOptions({ visible: !balHidden[hid] });
  const hist = balLastHist || { exchanges: [], accounts: [] };
  if (kind === 'eq') drawBalEqChart(hist);
  else drawBalAcctChart(hist);
}

function drawBalSpark(pts) {
  const el = document.getElementById('balDetailChart');
  if (!el || typeof LightweightCharts === 'undefined') return;
  const data = balToLC(pts);
  if (!balSparkChart) {
    balSparkChart = LightweightCharts.createChart(el, Object.assign(balChartOpts(), {
      timeScale: { borderColor: '#303647', timeVisible: true, secondsVisible: false, visible: true },
    }));
  }
  if (balSparkSeries) {
    try { balSparkChart.removeSeries(balSparkSeries); } catch (e) { /* gone */ }
    balSparkSeries = null;
  }
  if (!data.length) return;
  balSparkSeries = balSparkChart.addAreaSeries({
    lineColor: '#5b8def', topColor: 'rgba(91,141,239,.28)', bottomColor: 'rgba(91,141,239,0)',
    lineWidth: 2, priceLineVisible: false, priceFormat: balPriceFmt(),
  });
  balSparkSeries.setData(data);
  balSparkChart.timeScale().fitContent();
}

function balUsd(n) {
  const v = Number(n);
  if (!isFinite(v)) return '—';
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function setBalXferMsg(text, err) {
  const el = document.getElementById('balXferMsg');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('err', !!err);
}

let balXferAccts = [];
let balXferUnit = 'usd';
let balXferRate = 85;
let balXferVenue = 'delta';
let balXferHasParent = false;

const BAL_XFER_VENUES = [
  { id: 'delta', label: 'Delta' },
  { id: 'binance', label: 'Binance' },
  { id: 'bybit', label: 'Bybit' },
  { id: 'kucoin', label: 'KuCoin' },
  { id: 'coinbase', label: 'Coinbase' },
  { id: 'aster', label: 'Aster' },
];

function balXferVenueLabel(v) {
  const row = BAL_XFER_VENUES.find(function (x) { return x.id === v; });
  return (row && row.label) || v || 'exchange';
}

function fillBalXferVenues() {
  const sel = document.getElementById('balXferVenue');
  if (!sel) return;
  const keep = sel.value || balXferVenue || 'delta';
  sel.innerHTML = BAL_XFER_VENUES.map(function (v) {
    return '<option value="' + escHtml(v.id) + '">' + escHtml(v.label) + '</option>';
  }).join('');
  if ([...sel.options].some(function (o) { return o.value === keep; })) sel.value = keep;
  else sel.value = 'delta';
  balXferVenue = sel.value || 'delta';
}

function toggleBalXfer(force) {
  const box = document.getElementById('balXfer');
  const btn = document.getElementById('balXferBtn');
  if (!box) return;
  const open = force === true ? true : force === false ? false : box.hidden;
  box.hidden = !open;
  if (btn) btn.classList.toggle('on', open);
  document.body.classList.toggle('modal-open', open);
  if (open) {
    fillBalXferVenues();
    loadBalXfer();
  }
}

function onBalXferVenueChange() {
  const sel = document.getElementById('balXferVenue');
  balXferVenue = ((sel && sel.value) || 'delta').toLowerCase();
  const from = document.getElementById('balXferFrom');
  const to = document.getElementById('balXferTo');
  if (from) from.value = '';
  if (to) to.value = '';
  loadBalXfer();
}

function balXferFx() {
  const n = Number(balXferRate);
  return isFinite(n) && n > 0 ? n : 85;
}

function setBalXferUnit(unit) {
  balXferUnit = unit === 'inr' ? 'inr' : 'usd';
  document.querySelectorAll('#balXferAmtWrap [data-xfer-unit]').forEach(function (b) {
    b.classList.toggle('on', b.getAttribute('data-xfer-unit') === balXferUnit);
  });
  paintBalXferEq();
}

function paintBalXferEq() {
  const el = document.getElementById('balXferEq');
  if (!el) return;
  const amt = Number((document.getElementById('balXferAmt') || {}).value);
  const fx = balXferFx();
  const venue = balXferVenue || 'delta';
  if (venue !== 'delta') {
    el.textContent = balXferVenueLabel(venue) + ' transfers are not wired yet — pick Delta to move funds.';
    return;
  }
  if (!(amt > 0)) {
    el.textContent = 'Delta moves USD. INR uses USDINR ' + fx.toLocaleString('en-IN');
    return;
  }
  if (balXferUnit === 'inr') {
    const usd = amt / fx;
    el.textContent = 'Sends $' + usd.toLocaleString('en-US', { maximumFractionDigits: 2 }) +
      '  ·  rate ₹' + fx.toLocaleString('en-IN') + ' / $';
  } else {
    const inr = amt * fx;
    el.textContent = 'Sends $' + amt.toLocaleString('en-US', { maximumFractionDigits: 2 }) +
      '  ·  ≈ ' + (typeof inrFmt === 'function' ? inrFmt(inr) : ('₹' + Math.round(inr).toLocaleString('en-IN')));
  }
}

function pickBalXfer(role, id) {
  const from = document.getElementById('balXferFrom');
  const to = document.getElementById('balXferTo');
  if (role === 'from' && from) from.value = id;
  if (role === 'to' && to) to.value = id;
  if (from && to && from.value && from.value === to.value) {
    if (role === 'from') to.value = '';
    else from.value = '';
  }
  paintBalXferLists();
  paintBalXferEq();
}

function paintBalXferLists() {
  const fromId = (document.getElementById('balXferFrom') || {}).value || '';
  const toId = (document.getElementById('balXferTo') || {}).value || '';
  const fromBox = document.getElementById('balXferFromList');
  const toBox = document.getElementById('balXferToList');
  const lab = balXferVenueLabel(balXferVenue);
  const html = function (onId, role) {
    if (!balXferAccts.length) {
      return '<div class="rp-ops-empty">No ' + escHtml(lab) + ' subaccounts with keys</div>';
    }
    return balXferAccts.map(function (a) {
      const id = a.id || a.name || '';
      return (typeof opsAcctCardHtml === 'function' ? opsAcctCardHtml : function () { return ''; })
        (a, { on: id === onId || a.name === onId, role: role, avail: true });
    }).join('');
  };
  if (fromBox) fromBox.innerHTML = html(fromId, 'from');
  if (toBox) toBox.innerHTML = html(toId, 'to');
}

function syncBalXferHint(d) {
  const hint = document.getElementById('balXferHint');
  const venue = balXferVenue || 'delta';
  const lab = balXferVenueLabel(venue);
  if (hint) {
    if (venue === 'delta') {
      hint.textContent = 'Move unlocked USD between Delta subaccounts. Amount can be INR or USD — Delta settles USD. Uses the parent / main API key.';
    } else {
      hint.textContent = lab + ' wallets loaded below. In-app transfer currently supports Delta only.';
    }
  }
  balXferHasParent = !!(d && d.has_parent);
  if (venue !== 'delta') {
    setBalXferMsg(lab + ' transfer is not available yet. Switch exchange to Delta to move funds.', true);
  } else if (d && !d.has_parent) {
    setBalXferMsg(d.hint || (
      'Delta will not transfer with a subaccount trading key. Create an API key on the main/parent Delta login (wallet permission), then set PROFIT_SWEEP_API_KEY and PROFIT_SWEEP_API_SECRET in OPADash/.env — or add that account to config/accounts.json with parent: true.'
    ), true);
  } else {
    setBalXferMsg('', false);
  }
}

async function loadBalXfer() {
  const go = document.getElementById('balXferGo');
  const sel = document.getElementById('balXferVenue');
  if (sel && sel.value) balXferVenue = String(sel.value || 'delta').toLowerCase();
  const venue = balXferVenue || 'delta';
  setBalXferMsg('Loading ' + balXferVenueLabel(venue) + '…', false);
  if (go) go.disabled = true;
  paintBalXferLists();
  try {
    const r = await fetch('/api/ops/accounts?venue=' + encodeURIComponent(venue));
    const d = r.ok ? await r.json() : { accounts: [], has_parent: false };
    if ((document.getElementById('balXferVenue') || {}).value &&
        String((document.getElementById('balXferVenue') || {}).value).toLowerCase() !== venue) {
      return;
    }
    balXferAccts = d.accounts || [];
    const rate = Number((balXferAccts[0] || {}).usdinr);
    if (isFinite(rate) && rate > 0) balXferRate = rate;
    syncBalXferHint(d);
    const from = document.getElementById('balXferFrom');
    const to = document.getElementById('balXferTo');
    const ids = balXferAccts.map(function (a) { return a.id || a.name || ''; });
    if (from && from.value && ids.indexOf(from.value) < 0) from.value = '';
    if (to && to.value && ids.indexOf(to.value) < 0) to.value = '';
    if (from && !from.value && balXferAccts[0]) from.value = balXferAccts[0].id || balXferAccts[0].name || '';
    if (to && !to.value && balXferAccts[1]) to.value = balXferAccts[1].id || balXferAccts[1].name || '';
    if (from && to && from.value && from.value === to.value && balXferAccts.length > 1) {
      to.value = balXferAccts[1].id || balXferAccts[1].name || '';
    }
    paintBalXferLists();
    paintBalXferEq();
    if (go) go.disabled = !(venue === 'delta' && balXferHasParent);
  } catch (e) {
    setBalXferMsg(String(e), true);
  }
}

async function submitBalXfer() {
  const venue = balXferVenue || 'delta';
  if (venue !== 'delta') {
    return setBalXferMsg('Only Delta transfers are supported right now', true);
  }
  const src = (document.getElementById('balXferFrom') || {}).value || '';
  const dest = (document.getElementById('balXferTo') || {}).value || '';
  const raw = Number((document.getElementById('balXferAmt') || {}).value);
  if (!src || !dest) return setBalXferMsg('Pick from and to', true);
  if (src === dest) return setBalXferMsg('From and to must differ', true);
  if (!(raw > 0)) return setBalXferMsg('Amount required', true);
  const fx = balXferFx();
  const usd = balXferUnit === 'inr' ? raw / fx : raw;
  if (!(usd > 0)) return setBalXferMsg('Amount too small', true);
  const srcName = ((balXferAccts.find(a => a.id === src || a.name === src) || {}).name) || src;
  const destName = ((balXferAccts.find(a => a.id === dest || a.name === dest) || {}).name) || dest;
  const shown = balXferUnit === 'inr'
    ? (Math.round(raw).toLocaleString('en-IN') + ' INR  ($' + usd.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ')')
    : ('$' + usd.toLocaleString('en-US', { maximumFractionDigits: 2 }));
  if (!confirm('Transfer ' + shown + ' from ' + srcName + ' → ' + destName + '?')) return;
  const btn = document.getElementById('balXferGo');
  if (btn) btn.disabled = true;
  setBalXferMsg('Sending…', false);
  try {
    const r = await fetch('/api/ops/transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ src, dest, amount: usd, asset: 'USD' }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setBalXferMsg((typeof opsErr === 'function' ? opsErr(d, r.status) : (d.detail || 'failed')), true);
      if (btn) btn.disabled = !(venue === 'delta' && balXferHasParent);
      return;
    }
    setBalXferMsg('Moved ' + d.amount + ' ' + d.asset, false);
    toast('transferred ' + d.amount + ' ' + d.asset, 'ok');
    await loadBalXfer();
    if (typeof loadBalances === 'function') loadBalances();
  } catch (e) {
    setBalXferMsg(String(e), true);
    if (btn) btn.disabled = !(venue === 'delta' && balXferHasParent);
  }
}

async function loadBalances() {
  const empty = document.getElementById('balEmpty');
  const shell = document.getElementById('balShell');
  const first = !balLastBoard;
  if (first) {
    empty.style.display = 'block';
    empty.textContent = 'Loading wallets…';
  }
  try {
    const scope = strategyIsAll(currentStrategy) ? 'all' : 'strategy';
    const r = await fetch(withStrategy('/api/balances') + '&scope=' + scope);
    if (!r.ok) {
      const b = await r.json().catch(function () { return {}; });
      throw new Error(b.detail || r.statusText);
    }
    const d = await r.json();
    const accts = d.accounts || [];
    const tot = d.totals || {};
    const withBal = tot.with_balance || 0;
    const errN = tot.errors || 0;
    document.getElementById('balCount').textContent =
      accts.length + ' account' + (accts.length === 1 ? '' : 's') +
      (withBal ? ' · ' + withBal + ' with balance' : '') +
      (tot.live ? ' · ' + tot.live + ' live' : '') +
      (errN ? ' · ' + errN + ' failed' : '') +
      (strategyIsAll(currentStrategy) ? ' · all strategies' : ' · ' + currentStrategy);
    if (!accts.length) {
      const filtered = !strategyIsAll(currentStrategy);
      empty.innerHTML = escHtml(d.hint || (filtered ? 'No wallets tagged ' + currentStrategy + '.' : 'No wallet snapshots yet.'));
      if (!filtered) {
        empty.innerHTML +=
          '<div style="margin-top:10px">Start a bot, or add idle keys (BAL_* / accounts.json). Live wallets come from private WS; idle accounts REST every 15 min. Live keys are not polled.</div>';
      }
      shell.style.display = 'none';
      balLastBoard = null;
      return;
    }
    empty.style.display = 'none';
    shell.style.display = 'block';
    balLastBoard = d;
    if (balSelected && !accts.some(function (a) { return a.account === balSelected; })) closeBalDetail();
    renderBalBoard(d, balLastHist);
    await loadBalHistory();
    requestAnimationFrame(function () {
      resizeBalCharts();
      requestAnimationFrame(resizeBalCharts);
    });
    const xfer = document.getElementById('balXfer');
    if (xfer && !xfer.hidden) loadBalXfer();
  } catch (e) {
    document.getElementById('balCount').textContent = 'Error';
    empty.style.display = 'block';
    empty.innerHTML = '<span style="color:var(--red)">Error: ' + escHtml(e.message) + '</span>';
    if (!balLastBoard) shell.style.display = 'none';
  }
}

function renderBalBoard(d, hist) {
  const accts = d.accounts || [];
  const exch = d.exchanges || [];
  const tot = d.totals || {};
  const errN = tot.errors || 0;
  const asOf = d.as_of ? (' · ' + fmtIST(d.as_of)) : '';
  const liveN = accts.filter(function (a) { return a.live; }).length;
  const idleN = accts.filter(function (a) { return a.idle && !a.live; }).length;
  const src = 'Live bots: private WS'
    + (liveN ? ' · ' + liveN + ' live' : '')
    + (idleN ? ' · ' + idleN + ' idle REST/' + balIdleLabel(d.idle_secs) : '');
  const snapNote = src + asOf +
    (errN ? ' · ' + errN + ' key' + (errN === 1 ? '' : 's') + ' failed' : '');
  const totDelta = balDelta((hist && hist.total) || []);
  const deltaBit = totDelta == null ? '' :
    '<div class="hero-delta ' + (totDelta >= 0 ? 'up' : 'dn') + '">' +
      (typeof rptSigned === 'function' ? rptSigned(totDelta) : balMoney(totDelta)) +
      ' in range</div>';
  document.getElementById('balHero').innerHTML =
    '<div class="hero-top"><div><div class="hero-label">Total equity</div>' +
      '<div class="hero-bal">' + (tot.balance == null ? '—' : balMoney(tot.balance)) + '</div>' +
      deltaBit +
      '<div class="hero-sub">' + escHtml(snapNote) + '</div></div></div>' +
    '<div class="rpt-kpis"><div class="rpt-kpi"><div class="k">Subaccounts</div><div class="v">' +
      (tot.accounts || accts.length) + '</div></div>' +
      exch.map(function (e) {
        return '<div class="rpt-kpi"><div class="k">' + escHtml(e.label || e.exchange) + '</div>' +
          '<div class="v">' + (e.balance == null ? '—' : balMoney(e.balance)) + '</div></div>';
      }).join('') + '</div>';
  document.getElementById('balExch').innerHTML = exch.map(function (e) {
    return '<div class="rpt-exchip"><div class="el rpnl-venue ' + rpnlVenueClass(e.exchange) + '">' +
      escHtml(e.label || e.exchange) + '</div><div class="ev">' +
      (e.balance == null ? '—' : balMoney(e.balance)) + '</div></div>';
  }).join('');

  const filt = document.getElementById('balExFilter');
  if (filt) {
    const opts = [{ exchange: 'all', label: 'All' }].concat(exch.map(function (e) {
      return { exchange: e.exchange, label: e.label || e.exchange };
    }));
    if (!opts.some(function (o) { return o.exchange === balExFilter; })) balExFilter = 'all';
    filt.innerHTML = opts.map(function (o) {
      const on = balExFilter === o.exchange ? ' on' : '';
      return '<button type="button" class="bal-exchip' + on + '" data-ex="' + escHtml(o.exchange) +
        '" onclick="setBalExFilter(this.dataset.ex)">' + escHtml(o.label) + '</button>';
    }).join('');
  }

  const byAcct = {};
  ((hist && hist.accounts) || []).forEach(function (a) { byAcct[a.account] = a; });
  const movers = accts.map(function (a) {
    const dlt = balDelta((byAcct[a.account] || {}).points);
    return { a: a, d: dlt };
  }).filter(function (x) { return x.d != null && Math.abs(x.d) >= 1; })
    .sort(function (x, y) { return Math.abs(y.d) - Math.abs(x.d); })
    .slice(0, 8);
  const moversEl = document.getElementById('balMovers');
  if (!movers.length) {
    moversEl.innerHTML = '';
  } else {
    moversEl.innerHTML = '<div class="bal-movers-h">Biggest moves</div>' + movers.map(function (x) {
      const name = balAcctName(x.a);
      const ex = balPrimaryEx(x.a);
      return '<button type="button" class="bal-mover" data-account="' + escHtml(x.a.account || '') +
        '" onclick="selectBalAccount(this.dataset.account)">' +
        (ex ? '<span class="rpnl-venue ' + rpnlVenueClass(ex) + '">' + escHtml(balExLabel(ex)) + '</span>' : '') +
        '<span class="an">' + escHtml(name) + '</span>' +
        '<span class="bal-delta ' + (x.d >= 0 ? 'up' : 'dn') + '">' +
        (typeof rptSigned === 'function' ? rptSigned(x.d) : balMoney(x.d)) + '</span></button>';
    }).join('');
  }

  const list = document.getElementById('balWallets');
  if (!list) return;
  const shown = accts.filter(balMatchesFilter).slice().sort(function (a, b) {
    const ea = balPrimaryEx(a);
    const eb = balPrimaryEx(b);
    if (ea !== eb) return ea.localeCompare(eb);
    const ta = a.total == null ? -1e18 : Number(a.total);
    const tb = b.total == null ? -1e18 : Number(b.total);
    if (tb !== ta) return tb - ta;
    return balAcctName(a).localeCompare(balAcctName(b));
  });
  if (!shown.length) {
    list.innerHTML = '<div class="bal-empty">No subaccounts match this filter.</div>';
    return;
  }

  let html = '';
  let lastGroup = null;
  shown.forEach(function (a) {
    const ex = balPrimaryEx(a) || 'other';
    if (balExFilter === 'all' && ex !== lastGroup) {
      lastGroup = ex;
      html += '<div class="bal-group">' +
        '<span class="rpnl-venue ' + rpnlVenueClass(ex) + '">' + escHtml(balExLabel(ex === 'other' ? '' : ex) || 'Other') + '</span>' +
        '<span class="bal-group-n"></span></div>';
    }
    html += balWalletCardHtml(a, byAcct[a.account] || {});
  });
  // Fill group counts
  list.innerHTML = html;
  if (balExFilter === 'all') {
    list.querySelectorAll('.bal-group').forEach(function (g) {
      let n = 0;
      let el = g.nextElementSibling;
      while (el && !el.classList.contains('bal-group')) {
        if (el.classList.contains('bal-card')) n += 1;
        el = el.nextElementSibling;
      }
      const bit = g.querySelector('.bal-group-n');
      if (bit) bit.textContent = n + (n === 1 ? ' wallet' : ' wallets');
    });
  }
}

function balWalletCardHtml(a, histRow) {
  const id = a.account || '';
  const name = balAcctName(a);
  const st = balStatus(a);
  const dlt = balDelta((histRow && histRow.points) || []);
  const sel = (balSelected && balSelected === id) ? ' on' : '';
  const venues = a.venues || {};
  const errs = a.venue_errors || {};
  const vKeys = balVenueKeys(a);
  const venueBits = vKeys.map(function (ex) {
    const err = errs[ex];
    const v = venues[ex];
    return '<div class="bal-vrow">' +
      '<span class="rpnl-venue ' + rpnlVenueClass(ex) + '">' + escHtml(balExLabel(ex)) + '</span>' +
      '<span class="bal-vamt' + (err ? ' err' : '') + '" title="' + escHtml(err || '') + '">' +
        (err ? escHtml(err) : (v == null ? '—' : balMoney(v))) +
      '</span></div>';
  }).join('');
  const strat = (a.strategies || []).filter(Boolean);
  const stratBits = strat.length
    ? '<div class="bal-strats">' + strat.map(function (s) {
        return '<span class="bal-strat">' + escHtml(s) + '</span>';
      }).join('') + '</div>'
    : '';
  const deltaBit = dlt == null ? '' :
    '<span class="bal-delta ' + (dlt >= 0 ? 'up' : 'dn') + '">' +
      (typeof rptSigned === 'function' ? rptSigned(dlt) : balMoney(dlt)) +
    '</span>';
  return '<button type="button" class="bal-card' + sel + '" data-account="' + escHtml(id) +
    '" onclick="selectBalAccount(this.dataset.account)">' +
    '<div class="bal-card-top">' +
      '<div class="bal-card-id">' +
        '<div class="bal-card-name">' + escHtml(name) + '</div>' +
        (id ? '<div class="bal-card-uid"><span class="k">UID</span> ' + escHtml(id) + '</div>' : '') +
      '</div>' +
      '<div class="bal-card-tot">' +
        '<div class="bal-card-amt">' + (a.total == null ? '—' : balMoney(a.total)) + '</div>' +
        (deltaBit ? '<div class="bal-card-dlt">' + deltaBit + ' <span class="k">range</span></div>' : '') +
      '</div>' +
    '</div>' +
    '<div class="bal-card-mid">' +
      (venueBits || '<div class="bal-vrow muted">No exchange balance yet</div>') +
    '</div>' +
    '<div class="bal-card-bot">' +
      '<span class="bal-pill ' + st.key + '">' + escHtml(st.label) + '</span>' +
      '<span class="bal-card-when">' + (a.time ? escHtml(fmtIST(a.time)) : '—') + '</span>' +
      stratBits +
    '</div>' +
  '</button>';
}

async function loadBalHistory() {
  const board = balLastBoard;
  if (!board) return;
  const hint = document.getElementById('balEqHint');
  const hours = balHours();
  const ids = (board.accounts || []).map(function (a) { return a.account; }).filter(Boolean);
  let qs = withStrategy('/api/balances/history') + '&hours=' + hours;
  if (ids.length) qs += '&accounts=' + ids.map(encodeURIComponent).join(',');
  let hist = { total: [], exchanges: [], accounts: [] };
  try {
    const r = await fetch(qs);
    if (r.ok) hist = await r.json();
    else if (hint) {
      const b = await r.json().catch(function () { return {}; });
      hint.textContent = b.detail || 'Equity history needs the database. Live wallets above still work.';
    }
  } catch (e) {
    if (hint) hint.textContent = 'Could not load equity history.';
  }
  hist = balStitch(hist, board);
  balLastHist = hist;
  const nPts = (hist.total || []).length;
  if (hint) {
    if (nPts <= 2) {
      hint.textContent = 'Snapshots from bot WS + reporter (5 min). The line fills in as wallets move.';
    } else {
      hint.textContent = 'Total + venue lines from bot WS / reporter snapshots. Toggle a chip to hide a series.';
    }
  }
  renderBalBoard(board, hist);
  drawBalEqChart(hist);
  drawBalAcctChart(hist);
  if (balSelected) {
    paintBalDetail();
    loadBalActivity(balSelected, true);
  }
}

function closeBalDetail() {
  balSelected = '';
  const box = document.getElementById('balDetail');
  if (box) box.style.display = 'none';
  if (balLastBoard) renderBalBoard(balLastBoard, balLastHist);
  drawBalAcctChart(balLastHist || { accounts: [] });
}

function balExLabel(ex) {
  const row = ((balLastBoard || {}).exchanges || []).find(function (e) { return e.exchange === ex; });
  if (row && row.label) return row.label;
  return (ex || '').charAt(0).toUpperCase() + (ex || '').slice(1);
}

function paintBalDetail() {
  const acct = balSelected;
  const box = document.getElementById('balDetail');
  if (!acct || !box) return;
  const board = balLastBoard || { accounts: [] };
  const live = (board.accounts || []).find(function (a) { return a.account === acct; }) || {};
  const histRow = ((balLastHist && balLastHist.accounts) || []).find(function (a) { return a.account === acct; }) || {};
  const name = balAcctName(Object.assign({}, histRow, live, { account: acct }));
  const st = balStatus(live);
  const ex = balPrimaryEx(live);
  box.style.display = 'block';
  document.getElementById('balDetailKicker').textContent = ex
    ? (balExLabel(ex) + ' subaccount')
    : 'Subaccount';
  document.getElementById('balDetailTitle').textContent = name;
  const dlt = balDelta(histRow.points);
  document.getElementById('balDetailSub').innerHTML =
    (live.total != null ? balMoney(live.total) : '—') +
    (dlt == null ? '' : ' · <span class="bal-delta ' + (dlt >= 0 ? 'up' : 'dn') + '">' +
      (typeof rptSigned === 'function' ? rptSigned(dlt) : balMoney(dlt)) + '</span> in range');
  const meta = document.getElementById('balDetailMeta');
  if (meta) {
    const bits = [];
    bits.push('<span class="bal-meta"><span class="k">UID</span> ' + escHtml(acct) + '</span>');
    bits.push('<span class="bal-pill ' + st.key + '">' + escHtml(st.label) + '</span>');
    if (live.time) bits.push('<span class="bal-meta">' + escHtml(fmtIST(live.time)) + '</span>');
    (live.strategies || []).forEach(function (s) {
      if (s) bits.push('<span class="bal-strat">' + escHtml(s) + '</span>');
    });
    meta.innerHTML = bits.join('');
  }
  const venues = live.venues || {};
  const errs = live.venue_errors || {};
  const keys = balVenueKeys(live);
  document.getElementById('balDetailVenues').innerHTML = keys.length ? keys.map(function (exch) {
    const err = errs[exch];
    const v = venues[exch];
    return '<div class="rpt-exchip"><div class="el rpnl-venue ' + rpnlVenueClass(exch) + '">' +
      escHtml(balExLabel(exch)) + '</div><div class="ev">' +
      (err ? '<span class="bal-err">' + escHtml(err) + '</span>' : (v == null ? '—' : balMoney(v))) +
      '</div></div>';
  }).join('') : '<div class="hint">No venue balances on this wallet yet.</div>';
  document.getElementById('balDetailReports').onclick = function () { goToReportAccount(acct); };
  drawBalSpark(histRow.points || []);
}

async function selectBalAccount(id) {
  const acct = String(id || '').trim();
  if (!acct) return;
  if (balSelected === acct) { closeBalDetail(); return; }
  balSelected = acct;
  delete balHidden['ac:' + acct];
  paintBalDetail();
  if (balLastBoard) renderBalBoard(balLastBoard, balLastHist);
  drawBalAcctChart(balLastHist || { accounts: [] });
  const box = document.getElementById('balDetail');
  if (box) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  requestAnimationFrame(resizeBalCharts);
  await loadBalActivity(acct);
}

async function loadBalActivity(acct, quiet) {
  const el = document.getElementById('balDetailFills');
  if (!el || !acct) return;
  const req = ++balActReq;
  if (!quiet || !el.querySelector('table')) el.innerHTML = '<div class="hint">Loading fills…</div>';
  try {
    const r = await fetch('/api/balances/activity?account=' + encodeURIComponent(acct) + '&hours=' + balHours() + '&limit=80');
    if (req !== balActReq || balSelected !== acct) return;
    if (!r.ok) {
      const b = await r.json().catch(function () { return {}; });
      throw new Error(b.detail || r.statusText);
    }
    const d = await r.json();
    if (req !== balActReq || balSelected !== acct) return;
    const fills = d.fills || [];
    if (!fills.length) {
      el.innerHTML = '<div class="hint">No fills for this wallet in the selected range.</div>';
      return;
    }
    const rpnlBit = d.rpnl != null
      ? '<span style="color:' + (typeof rptCol === 'function' ? rptCol(d.rpnl) : '') + '">' +
        (typeof rptSigned === 'function' ? rptSigned(d.rpnl) : balMoney(d.rpnl)) + '</span>'
      : '';
    el.innerHTML = '<div class="hint" style="padding:8px 10px">' + fills.length + ' fills · rPnL ' + rpnlBit +
      ' · click a contract for the rPnL chart</div>' +
      '<table class="dtable"><thead><tr><th>Time</th><th>Venue</th><th>Contract</th><th>Side</th><th class="num">Qty</th><th class="num">Price</th><th class="num">rPnL</th></tr></thead><tbody>' +
      fills.map(function (f) {
        const rp = Number(f.rpnl) || 0;
        return '<tr class="rpt-click" data-contract="' + escHtml(f.contract || '') +
          '" data-account="' + escHtml(f.account || acct) +
          '" onclick="goToRpnlChart(this.dataset.contract, this.dataset.account)">' +
          '<td>' + (f.time ? fmtIST(f.time) : '—') + '</td>' +
          '<td><span class="rpnl-venue ' + rpnlVenueClass(f.exchange) + '">' + escHtml(f.label || f.exchange) + '</span></td>' +
          '<td>' + escHtml(f.contract) + '</td>' +
          '<td>' + escHtml(f.side) + '</td>' +
          '<td class="num">' + (f.quantity == null ? '—' : Number(f.quantity).toLocaleString('en-IN', { maximumFractionDigits: 4 })) + '</td>' +
          '<td class="num">' + (f.price == null ? '—' : Number(f.price).toPrecision(6)) + '</td>' +
          '<td class="num" style="color:' + (typeof rptCol === 'function' ? rptCol(rp) : '') + '">' +
            (typeof rptSigned === 'function' ? rptSigned(rp) : balMoney(rp)) + '</td></tr>';
      }).join('') + '</tbody></table>';
  } catch (e) {
    if (req !== balActReq || balSelected !== acct) return;
    el.innerHTML = '<div class="hint" style="color:var(--red)">Fills: ' + escHtml(e.message) + '</div>';
  }
}

function setupBalAuto() {
  clearInterval(balTimer);
  if (document.getElementById('balAuto') && document.getElementById('balAuto').checked) {
    balTimer = setInterval(loadBalances, 30000);
  }
}

function stopBalAuto() {
  clearInterval(balTimer);
  balTimer = null;
}
