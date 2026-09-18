// Reports page
let reportsTimer;
let rptDayChart = null, rptDaySeries = null;
let rptCache = { accounts: [], exchanges: [] };
const rptOpenAccts = new Set();

function initReports() { loadReports(); setupReportsAuto(); }

function rptHoursQuery() {
  const v = (document.getElementById('rptHours') || {}).value;
  if (v === 'today') return '&today=true';
  if (v) return '&hours=' + encodeURIComponent(v);
  return '';
}

function rptSigned(n) {
  const v = Number(n) || 0;
  const sign = v < 0 ? '−' : (v > 0 ? '+' : '');
  return sign + '₹' + Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}
function rptMoney(n) {
  const v = Number(n) || 0;
  return '₹' + Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}
function rptCol(n) { return (Number(n) || 0) >= 0 ? 'var(--green)' : 'var(--red)'; }
function rptAcctKey(a, i) { return encodeURIComponent(a.account || ('x' + i)); }
function rptAcctName(a) {
  if (a.account_name && a.account_name !== a.account) return a.account_name;
  return a.account || 'unattributed';
}

function fmtBalanceCards(bal) {
  if (!bal || typeof bal !== 'object') return '';
  const skip = new Set(['account', 'account_name', 'time', 'created_at']);
  const cards = [];
  for (const [k, v] of Object.entries(bal)) {
    if (skip.has(k) || v == null || v === '') continue;
    const label = k.replace(/_balance$/,' ').replace(/_/g,' ').trim();
    if (typeof v === 'number') cards.push('<div class="bb">' + escHtml(label) + '<b>' + rptMoney(v) + '</b></div>');
    else if (typeof v === 'string' && v.length < 48) cards.push('<div class="bb">' + escHtml(label) + '<b>' + escHtml(v) + '</b></div>');
  }
  if (bal.time) cards.push('<div class="bb">snapshot <b>' + fmtIST(bal.time) + '</b></div>');
  return cards.length ? '<div class="rpt-bal">' + cards.join('') + '</div>' : '';
}

async function loadReports() {
  const empty = document.getElementById('reportEmpty');
  const shell = document.getElementById('reportShell');
  empty.style.display = 'block';
  empty.textContent = 'Loading accounts…';
  try {
    const qs = rptHoursQuery();
    const [oR, dR] = await Promise.all([
      fetch(withStrategy('/api/reports/overview') + qs),
      fetch(withStrategy('/api/rpnl/rollup') + qs),
    ]);
    if (!oR.ok) {
      const b = await oR.json().catch(() => ({}));
      throw new Error(b.detail || oR.statusText);
    }
    const d = await oR.json();
    let roll = { by_day: [] };
    if (dR.ok) roll = await dR.json();
    const accts = d.accounts || [];
    rptCache = { accounts: accts, exchanges: d.by_exchange || [], snapshot: d.snapshot, shared_positions: d.shared_positions || [] };
    const liveN = (d.totals && d.totals.live) || 0;
    document.getElementById('reportsCount').textContent =
      accts.length + ' account' + (accts.length === 1 ? '' : 's') +
      (liveN ? ' · ' + liveN + ' live' : '') +
      ' · ' + (d.window || '') + (d.strategy && d.strategy !== 'all' ? ' · ' + d.strategy : ' · all strategies');
    if (!accts.length) {
      empty.innerHTML = 'No fills in the selected window.';
      shell.style.display = 'none';
      return;
    }
    empty.style.display = 'none';
    shell.style.display = 'block';
    if (!rptOpenAccts.size && accts.length <= 8) {
      accts.forEach((a, i) => rptOpenAccts.add(rptAcctKey(a, i)));
    }
    renderReportHero(d);
    renderReportExchanges(d.by_exchange || []);
    renderReportMatrix(accts, d.by_exchange || []);
    renderReportAccounts(accts, d.snapshot, d.shared_positions || []);
    drawReportDays(roll.by_day || []);
    filterReportAccts();
    requestAnimationFrame(resizeReportChart);
    if (pendingReportAcct) {
      const id = pendingReportAcct;
      if (focusReportAccount(id)) {
        pendingReportAcct = null;
        pendingReportWiden = false;
      } else if (!pendingReportWiden) {
        pendingReportWiden = true;
        const hours = document.getElementById('rptHours');
        if (hours) hours.value = '';
        loadReports();
      } else {
        pendingReportAcct = null;
        pendingReportWiden = false;
        toast('No report for account ' + id + ' in this window', 'err');
      }
    }
  } catch (e) {
    document.getElementById('reportsCount').textContent = 'Error';
    empty.style.display = 'block';
    empty.innerHTML = '<span style="color:var(--red)">Error: ' + escHtml(e.message) + '</span>';
    shell.style.display = 'none';
  }
}

function renderReportHero(d) {
  const t = d.totals || {};
  const kpis = [
    ['Equity', t.balance == null ? '—' : rptMoney(t.balance), ''],
    ['Accounts', String(t.accounts || 0) + (t.live ? ' · ' + t.live + ' live' : ''), ''],
    ['Fills', (t.fills || 0).toLocaleString('en-IN'), ''],
    ['Fees', rptMoney(t.fees), ''],
    ['Open uPnL', rptSigned(t.upnl), rptCol(t.upnl)],
  ];
  document.getElementById('rptHero').innerHTML =
    '<div class="hero-top">' +
      '<div><div class="hero-label">Net realized PnL</div>' +
        '<div class="hero-bal" style="color:' + rptCol(t.rpnl) + '">' + rptSigned(t.rpnl) + '</div>' +
        '<div class="hero-sub">' + escHtml((d.strategy && d.strategy !== 'all' ? d.strategy : 'all strategies') + ' · ' + (d.window || '') +
          ' · IST ' + new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })) + '</div></div>' +
    '</div>' +
    '<div class="rpt-kpis">' + kpis.map(function (x) {
      return '<div class="rpt-kpi"><div class="k">' + x[0] + '</div><div class="v"' +
        (x[2] ? ' style="color:' + x[2] + '"' : '') + '>' + x[1] + '</div></div>';
    }).join('') + '</div>';
}

function renderReportExchanges(rows) {
  const wrap = document.getElementById('rptExch');
  wrap.innerHTML = rows.map(function (e) {
    return '<div class="rpt-exchip">' +
      '<div class="el rpnl-venue ' + rpnlVenueClass(e.exchange) + '">' + escHtml(e.label || e.exchange) + '</div>' +
      '<div class="ev" style="color:' + rptCol(e.rpnl) + '">' + rptSigned(e.rpnl) + '</div>' +
      '<div class="em">' + (e.fills || 0) + ' fills · fees ' + rptMoney(e.fees) + '</div></div>';
  }).join('');
}

function renderReportMatrix(accts, exchanges) {
  const wrap = document.getElementById('rptMatrix');
  if (!wrap) return;
  const cols = exchanges.slice();
  const head = '<tr><th>Account</th>' + cols.map(function (e) {
    return '<th>' + escHtml(e.label || e.exchange) + '</th>';
  }).join('') + '<th>Net</th><th>Fills</th><th>uPnL</th></tr>';
  const body = accts.map(function (a, i) {
    const key = rptAcctKey(a, i);
    const byEx = {};
    (a.exchanges || []).forEach(function (e) { byEx[e.exchange] = e; });
    const cells = cols.map(function (c) {
      const e = byEx[c.exchange];
      if (!e) return '<td style="color:var(--muted)">—</td>';
      return '<td style="color:' + rptCol(e.rpnl) + '" title="' + (e.fills || 0) + ' fills">' + rptSigned(e.rpnl) + '</td>';
    }).join('');
    return '<tr class="rpt-click" data-acct-key="' + escHtml(key) + '" onclick="jumpReportAcct(\'' + key + '\')">' +
      '<td><div class="an">' + (a.live ? '<span class="rpt-live" title="live"></span> ' : '') + escHtml(rptAcctName(a)) + '</div>' +
        (a.account && a.account !== a.account_name ? '<div class="aid">' + escHtml(a.account) + '</div>' : '') +
      '</td>' + cells +
      '<td style="color:' + rptCol(a.rpnl) + '">' + rptSigned(a.rpnl) + '</td>' +
      '<td>' + (a.fills || 0) + '</td>' +
      '<td style="color:' + rptCol(a.upnl) + '">' + (a.upnl ? rptSigned(a.upnl) : '—') + '</td></tr>';
  }).join('');
  const footCells = cols.map(function (c) {
    return '<td style="color:' + rptCol(c.rpnl) + '">' + rptSigned(c.rpnl) + '</td>';
  }).join('');
  const totFills = accts.reduce(function (s, a) { return s + (a.fills || 0); }, 0);
  const totRpnl = accts.reduce(function (s, a) { return s + (Number(a.rpnl) || 0); }, 0);
  const totUpnl = accts.reduce(function (s, a) { return s + (Number(a.upnl) || 0); }, 0);
  wrap.innerHTML = '<table class="rpt-matrix"><thead>' + head + '</thead><tbody>' + body + '</tbody>' +
    '<tfoot><tr><td>Total</td>' + footCells +
    '<td style="color:' + rptCol(totRpnl) + '">' + rptSigned(totRpnl) + '</td>' +
    '<td>' + totFills + '</td>' +
    '<td style="color:' + rptCol(totUpnl) + '">' + rptSigned(totUpnl) + '</td></tr></tfoot></table>';
}

function jumpReportAcct(key) {
  rptOpenAccts.add(key);
  const el = document.getElementById('acct-' + key);
  if (el) {
    el.classList.add('open');
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function toggleReportAcct(id) {
  const el = document.getElementById('acct-' + id);
  if (!el) return;
  el.classList.toggle('open');
  if (el.classList.contains('open')) rptOpenAccts.add(id); else rptOpenAccts.delete(id);
}

function setReportAcctsOpen(open) {
  document.querySelectorAll('.rpt-acct').forEach(function (el) {
    const key = (el.id || '').replace(/^acct-/, '');
    el.classList.toggle('open', open);
    if (open) rptOpenAccts.add(key); else rptOpenAccts.delete(key);
  });
}

function filterReportAccts() {
  const q = ((document.getElementById('rptSearch') || {}).value || '').trim().toLowerCase();
  document.querySelectorAll('.rpt-acct').forEach(function (el) {
    const hay = (el.getAttribute('data-filter') || '').toLowerCase();
    el.classList.toggle('hidden', q && hay.indexOf(q) < 0);
  });
}

function renderReportAccounts(accts, snapshot, sharedPos) {
  const snapHtml = snapshot ? '<div class="rpt-sec">Strategy balance snapshot</div>' + fmtBalanceCards(snapshot) : '';
  const sharedPosHtml = (sharedPos && sharedPos.length)
    ? '<div class="rpt-sec">Open positions (no account on snapshot)</div>' + posTable(sharedPos)
    : '';
  document.getElementById('rptAccts').innerHTML = snapHtml + sharedPosHtml + accts.map(function (a, i) {
    const key = rptAcctKey(a, i);
    const open = rptOpenAccts.has(key) ? ' open' : '';
    const name = escHtml(rptAcctName(a));
    const idBit = a.account && a.account !== a.account_name
      ? '<div class="aid">' + escHtml(a.account) + '</div>' : '';
    const hay = [a.account, a.account_name].concat(
      a.strategies || [],
      (a.contracts || []).map(function (c) { return (c.quote_symbol || c.contract) + ' ' + (c.strategy || ''); }),
      (a.exchanges || []).map(function (e) { return e.exchange + ' ' + (e.label || ''); })
    ).join(' ');
    const chips = (a.exchanges || []).map(function (e) {
      return '<span class="rpt-vchip"><span class="rpnl-venue ' + rpnlVenueClass(e.exchange) + '">' +
        escHtml(e.label || e.exchange) + '</span> <span style="color:' + rptCol(e.rpnl) + '">' +
        rptSigned(e.rpnl) + '</span></span>';
    }).join('');
    const exchRows = (a.exchanges || []).map(function (e) {
      return '<tr><td><span class="rpnl-venue ' + rpnlVenueClass(e.exchange) + '">' +
        escHtml(e.label || e.exchange) + '</span></td>' +
        '<td class="num" style="color:' + rptCol(e.rpnl) + '">' + rptSigned(e.rpnl) + '</td>' +
        '<td class="num">' + rptMoney(e.fees) + '</td><td class="num">' + (e.fills || 0) + '</td></tr>';
    }).join('');
    const conRows = (a.contracts || []).map(function (c) {
      const venueBits = (c.venues || []).map(function (v) {
        return '<span class="rpnl-venue ' + rpnlVenueClass(v.exchange) + '">' + escHtml(v.label) + '</span> ' +
          '<span style="color:' + rptCol(v.rpnl) + '">' + rptSigned(v.rpnl) + '</span>';
      }).join(' · ');
      return '<tr class="rpt-click" data-contract="' + escHtml(c.contract || c.quote_symbol || '') +
        '" data-account="' + escHtml(a.account || '') +
        '" data-strategy="' + escHtml(c.strategy || '') +
        '" onclick="goToRpnlChart(this.dataset.contract, this.dataset.account, this.dataset.strategy)" title="Open rPnL chart">' +
        '<td>' + escHtml(c.quote_symbol || c.contract) +
        (c.strategy ? ' <span class="rpnl-strat">' + escHtml(c.strategy) + '</span>' : '') +
        (c.has_hedge ? ' <span style="color:var(--muted);font-size:11px">hedged</span>' : '') +
        '<div style="font-size:11px;color:var(--muted);margin-top:2px">' + venueBits + '</div></td>' +
        '<td class="num" style="color:' + rptCol(c.rpnl) + '">' + rptSigned(c.rpnl) + '</td>' +
        '<td class="num" style="color:#ff9800">' + (c.has_hedge ? rptSigned(c.hedge_rpnl) : '—') + '</td>' +
        '<td class="num" style="color:' + rptCol(c.net) + '">' + rptSigned(c.net) + '</td>' +
        '<td class="num">' + (c.fills || 0) + (c.hedge_fills ? ' + ' + c.hedge_fills : '') + '</td></tr>';
    }).join('');
    const stratBits = (a.strategies || []).map(function (s) {
      return '<span class="rpnl-strat">' + escHtml(s) + '</span>';
    }).join(' ');
    return '<div class="rpt-acct' + open + '" id="acct-' + key + '" data-filter="' + escHtml(hay) + '">' +
      '<div class="rpt-acct-h" onclick="toggleReportAcct(\'' + key + '\')">' +
        '<div><div class="aname">' + (a.live ? '<span class="rpt-live" title="live"></span>' : '') + name +
          (stratBits ? ' ' + stratBits : '') + '</div>' + idBit + '</div>' +
        '<div class="rpt-vchips">' + chips + '</div>' +
        '<div class="ameta">' + (a.fills || 0) + ' fills' +
          (a.last_at ? ' · last ' + fmtIST(a.last_at) : '') +
          (a.upnl ? '<br>uPnL ' + rptSigned(a.upnl) : '') + '</div>' +
        '<div class="anet" style="color:' + rptCol(a.rpnl) + '">' + rptSigned(a.rpnl) + '</div>' +
      '</div>' +
      '<div class="rpt-acct-b">' +
        fmtBalanceCards(a.balance) +
        '<div class="rpt-sec">Exchanges</div>' +
        '<table class="rpt-xtable"><thead><tr><th>Exchange</th><th class="num">rPnL</th><th class="num">Fees</th><th class="num">Fills</th></tr></thead><tbody>' +
          exchRows + '</tbody></table>' +
        '<div class="rpt-sec">Contracts <span style="font-weight:400;text-transform:none;letter-spacing:0">· click to open rPnL</span></div>' +
        '<table class="rpt-xtable"><thead><tr><th>Contract</th><th class="num">Quote</th><th class="num">Hedge</th><th class="num">Net</th><th class="num">Fills</th></tr></thead><tbody>' +
          conRows + '</tbody></table>' +
        ((a.positions && a.positions.length) ? '<div class="rpt-sec">Open positions</div>' + posTable(a.positions) : '') +
      '</div></div>';
  }).join('');
}

function posTable(rows) {
  return '<table class="rpt-xtable"><thead><tr><th>Contract</th><th class="num">Quote</th><th class="num">Hedge</th><th class="num">Mark</th><th class="num">uPnL</th></tr></thead><tbody>' +
    rows.map(function (p) {
      const q = p.delta_size != null ? p.delta_size : p.size;
      const h = p.binance_size != null ? p.binance_size : p.hedge_size;
      const mark = p.mark_price != null ? Number(p.mark_price).toPrecision(6) : '—';
      const upnl = p.net_upnl;
      return '<tr><td>' + escHtml(p.contract || '') + '</td>' +
        '<td class="num">' + (q == null ? '—' : Number(q).toFixed(3)) + '</td>' +
        '<td class="num">' + (h == null ? '—' : Number(h).toFixed(3)) + '</td>' +
        '<td class="num">' + mark + '</td>' +
        '<td class="num" style="color:' + rptCol(upnl) + '">' + (upnl == null ? '—' : rptSigned(upnl)) + '</td></tr>';
    }).join('') + '</tbody></table>';
}

function resizeReportChart() {
  if (!rptDayChart) return;
  const el = document.getElementById('rptDayChart');
  if (el && el.clientWidth) rptDayChart.applyOptions({ width: el.clientWidth });
}

function drawReportDays(days) {
  const el = document.getElementById('rptDayChart');
  if (!el) return;
  const pts = (days || []).slice().reverse().map(function (d) {
    return {
      time: d.date,
      value: Number(d.total) || 0,
      color: (Number(d.total) || 0) >= 0 ? 'rgba(38,166,154,0.85)' : 'rgba(239,83,80,0.85)',
    };
  }).filter(function (p) { return p.time; });
  if (!rptDayChart) {
    rptDayChart = LightweightCharts.createChart(el, {
      autoSize: true,
      layout: { background: { color: '#161a25' }, textColor: '#d1d4dc' },
      grid: { vertLines: { color: '#1c2130' }, horzLines: { color: '#1c2130' } },
      rightPriceScale: { borderColor: '#303647' },
      timeScale: { borderColor: '#303647', timeVisible: false },
    });
    rptDaySeries = rptDayChart.addHistogramSeries({
      priceFormat: { type: 'custom', minMove: 1, formatter: function (p) {
        const n = Number(p) || 0;
        return (n < 0 ? '−' : '') + '₹' + Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 });
      } },
    });
  }
  rptDaySeries.setData(pts);
  rptDayChart.timeScale().fitContent();
}

function setupReportsAuto() {
  clearInterval(reportsTimer);
  if (document.getElementById('reportsAuto').checked) reportsTimer = setInterval(loadReports, 30000);
}
