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
          '<div style="margin-top:10px">Start a bot on the account. Private WS publishes the wallet; reporter also writes it every 5 min. Dash does not hit the exchange.</div>';
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
  const src = (d.source === 'ws')
    ? ('Bot WS' + (liveN ? ' · ' + liveN + ' live' : '') + ' · reporter every 5 min')
    : 'Wallet snapshots';
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
    moversEl.innerHTML = movers.map(function (x) {
      const name = x.a.account_name && x.a.account_name !== x.a.account ? x.a.account_name : (x.a.account || 'unnamed');
      return '<button type="button" class="bal-mover" data-account="' + escHtml(x.a.account || '') +
        '" onclick="selectBalAccount(this.dataset.account)"><span class="an">' + escHtml(name) + '</span>' +
        '<span class="bal-delta ' + (x.d >= 0 ? 'up' : 'dn') + '">' +
        (typeof rptSigned === 'function' ? rptSigned(x.d) : balMoney(x.d)) + '</span></button>';
    }).join('');
  }

  const head = '<tr><th>Account</th>' + exch.map(function (e) {
    return '<th>' + escHtml(e.label || e.exchange) + '</th>';
  }).join('') + '<th>Total</th><th>Δ range</th><th>Updated</th></tr>';
  const body = accts.map(function (a) {
    const name = a.account_name && a.account_name !== a.account ? a.account_name : (a.account || 'unnamed');
    const tags = (a.strategies || []).join(' · ');
    const idBit = (tags ? '<div class="aid">' + escHtml(tags) + '</div>' : '') +
      (a.account && a.account !== a.account_name ? '<div class="aid">' + escHtml(a.account) + '</div>' : '');
    const errs = a.venue_errors || {};
    const cells = exch.map(function (c) {
      const v = (a.venues || {})[c.exchange];
      const err = errs[c.exchange];
      if (err) {
        return '<td class="bal-err" title="' + escHtml(err) + '">' + escHtml(err) + '</td>';
      }
      return (v == null || v === '') ? '<td style="color:var(--muted)">—</td>' : '<td>' + balMoney(v) + '</td>';
    }).join('');
    const dlt = balDelta((byAcct[a.account] || {}).points);
    const dCell = dlt == null
      ? '<td style="color:var(--muted)">—</td>'
      : '<td class="bal-delta ' + (dlt >= 0 ? 'up' : 'dn') + '">' +
        (typeof rptSigned === 'function' ? rptSigned(dlt) : balMoney(dlt)) + '</td>';
    const sel = (balSelected && balSelected === a.account) ? ' bal-sel' : '';
    return '<tr class="rpt-click' + sel + '" data-account="' + escHtml(a.account || '') +
      '" onclick="selectBalAccount(this.dataset.account)">' +
      '<td><div class="an">' + escHtml(name) + '</div>' + idBit + '</td>' + cells +
      '<td>' + (a.total == null ? '—' : balMoney(a.total)) + '</td>' +
      dCell +
      '<td>' + (a.time ? fmtIST(a.time) : '—') + '</td></tr>';
  }).join('');
  const foot = '<tr><td>Total</td>' + exch.map(function (e) {
    return '<td>' + (e.balance == null ? '—' : balMoney(e.balance)) + '</td>';
  }).join('') + '<td>' + (tot.balance == null ? '—' : balMoney(tot.balance)) + '</td><td>' +
    (totDelta == null ? '' : '<span class="bal-delta ' + (totDelta >= 0 ? 'up' : 'dn') + '">' +
      (typeof rptSigned === 'function' ? rptSigned(totDelta) : balMoney(totDelta)) + '</span>') +
    '</td><td></td></tr>';
  document.getElementById('balMatrix').innerHTML =
    '<table class="rpt-matrix"><thead>' + head + '</thead><tbody>' + body + '</tbody><tfoot>' + foot + '</tfoot></table>';
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
  const name = live.account_name && live.account_name !== acct ? live.account_name : (histRow.account_name || acct);
  box.style.display = 'block';
  document.getElementById('balDetailTitle').textContent = name;
  const dlt = balDelta(histRow.points);
  document.getElementById('balDetailSub').innerHTML =
    escHtml(acct !== name ? acct : '') +
    (live.total != null ? (acct !== name ? ' · ' : '') + balMoney(live.total) : '') +
    (dlt == null ? '' : ' · <span class="bal-delta ' + (dlt >= 0 ? 'up' : 'dn') + '">' +
      (typeof rptSigned === 'function' ? rptSigned(dlt) : balMoney(dlt)) + '</span> in range');
  const venues = live.venues || {};
  const errs = live.venue_errors || {};
  const keys = Object.keys(venues);
  document.getElementById('balDetailVenues').innerHTML = keys.length ? keys.map(function (ex) {
    const err = errs[ex];
    const v = venues[ex];
    return '<div class="rpt-exchip"><div class="el rpnl-venue ' + rpnlVenueClass(ex) + '">' +
      escHtml(balExLabel(ex)) + '</div><div class="ev">' +
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
