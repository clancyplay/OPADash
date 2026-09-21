// ══════════════════════════════════════════════════════════
// Data explorer page
// ══════════════════════════════════════════════════════════
let dataTab = 'fills';
let fxTimer, evTimer, pxTimer, lgTimer, odTimer, rsTimer;

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function fmtISTs(unixSecs) {
  return new Date(unixSecs * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

async function initData() {
  // contract selects share the fills-contract list
  try {
    const r = await fetch(withStrategy('/api/rpnl/symbols'));
    const rows = await r.json();
    const contracts = [...new Set((Array.isArray(rows) ? rows : []).map(c => typeof c === 'string' ? c : c.contract).filter(Boolean))];
    document.getElementById('fxContract').innerHTML = contracts.map(c => '<option>' + c + '</option>').join('');
    document.getElementById('evContract').innerHTML = '<option value="">All</option>' + contracts.map(c => '<option>' + c + '</option>').join('');
    document.getElementById('pxContract').innerHTML = contracts.map(c => '<option>' + c + '</option>').join('');
    document.getElementById('odContract').innerHTML = '<option value="">All</option>' + contracts.map(c => '<option>' + c + '</option>').join('');
  } catch {}
  showDataTab('fills');
}

function showDataTab(name) {
  dataTab = name;
  ['fills', 'orders', 'rsum', 'events', 'positions', 'tables', 'logs'].forEach(t => {
    document.getElementById('dpanel-' + t).classList.toggle('visible', t === name);
    document.getElementById('dtab-' + t).classList.toggle('active', t === name);
  });
  clearInterval(fxTimer); clearInterval(evTimer); clearInterval(pxTimer); clearInterval(lgTimer);
  clearInterval(odTimer); clearInterval(rsTimer);
  if (name === 'fills')     { loadFillsX(); setupFxAuto(); }
  if (name === 'orders')    { loadOrdersX(); setupOdAuto(); }
  if (name === 'rsum')      { loadRsum(); setupRsAuto(); }
  if (name === 'events')    { loadEventsX(); setupEvAuto(); }
  if (name === 'positions') { loadPosX(); loadPosSnaps(); setupPxAuto(); }
  if (name === 'tables')    { loadDbTables(); }
  if (name === 'logs')      { loadLogsX(true); setupLgAuto(); }
}

// ── Fills cross-match ─────────────────────────────────────
let fxDelta = [], fxHedge = [];

async function loadFillsX() {
  const contract = document.getElementById('fxContract').value;
  const hours    = document.getElementById('fxHours').value;
  if (!contract) { document.getElementById('fxStatus').textContent = 'No contracts in DB yet'; return; }
  document.getElementById('fxStatus').textContent = 'Loading...';
  try {
    const [dr, hr] = await Promise.all([
      fetch(withStrategy('/api/fills?contract=' + contract + '&exchange=delta&hours=' + hours + '&limit=1000')),
      fetch(withStrategy('/api/fills?contract=' + contract + '&exchange=hedge&hours=' + hours + '&limit=1000')),
    ]);
    if (!dr.ok || !hr.ok) throw new Error('fetch failed');
    fxDelta = await dr.json();
    fxHedge = await hr.json();
    renderFillsX();
    document.getElementById('fxStatus').textContent = 'Updated ' + new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
  } catch(e) {
    document.getElementById('fxStatus').innerHTML = '<span style="color:var(--red)">Error: ' + esc(e.message) + '</span>';
  }
}

function renderFillsX() {
  const side = document.getElementById('fxSide').value;
  const df = side ? fxDelta.filter(f => f.side === side) : fxDelta;
  const hf = side ? fxHedge.filter(f => f.side === side) : fxHedge;

  const stats = (fills) => {
    let bq = 0, sq = 0, bcost = 0, scost = 0, rpnl = 0;
    for (const f of fills) {
      const u = f.units ?? f.quantity;
      if (f.side === 'buy') { bq += u; bcost += u * f.price; }
      else { sq += u; scost += u * f.price; }
      rpnl += f.rpnl || 0;
    }
    return { n: fills.length, bq, sq, net: bq - sq, bvwap: bq ? bcost / bq : 0, svwap: sq ? scost / sq : 0, rpnl };
  };
  const d = stats(df), h = stats(hf);
  const gap = d.net + h.net;
  const cell = (k, v, cls) => '<div class="ins-cell"><div class="k">' + k + '</div><div class="v' + (cls ? ' ' + cls : '') + '">' + v + '</div></div>';
  const pnlCls = (v) => v >= 0 ? 'pos-pos' : 'pos-neg';
  document.getElementById('fxInsights').innerHTML =
    cell('Δ fills', d.n) +
    cell('Δ net qty', (d.net >= 0 ? '+' : '') + d.net.toFixed(0), d.net ? '' : 'pos-pos') +
    cell('Δ vwap b/s', d.bvwap.toFixed(4) + ' / ' + d.svwap.toFixed(4)) +
    cell('Δ rPnL', (d.rpnl >= 0 ? '+' : '') + '₹' + d.rpnl.toFixed(2), pnlCls(d.rpnl)) +
    cell('H fills', h.n) +
    cell('H net qty', (h.net >= 0 ? '+' : '') + h.net.toFixed(0), h.net ? '' : 'pos-pos') +
    cell('H vwap b/s', h.bvwap.toFixed(4) + ' / ' + h.svwap.toFixed(4)) +
    cell('H rPnL', (h.rpnl >= 0 ? '+' : '') + '₹' + h.rpnl.toFixed(2), pnlCls(h.rpnl)) +
    cell('Net exposure gap', (gap >= 0 ? '+' : '') + gap.toFixed(0), Math.abs(gap) < 1 ? 'gap-ok' : 'gap-bad') +
    cell('Combined rPnL', ((d.rpnl + h.rpnl) >= 0 ? '+' : '') + '₹' + (d.rpnl + h.rpnl).toFixed(2), pnlCls(d.rpnl + h.rpnl));

  document.getElementById('fxDeltaSub').textContent = df.length + ' fills';
  document.getElementById('fxHedgeSub').textContent = hf.length + ' fills';
  document.getElementById('fxDeltaScroll').innerHTML = fillsTable(df, 'd');
  document.getElementById('fxHedgeScroll').innerHTML = fillsTable(hf, 'h');
}

function fillsTable(fills, tag) {
  if (!fills.length) return '<div style="padding:16px;color:var(--muted);">No fills in this window.</div>';
  const showExch = tag === 'h';
  return '<table class="dtable"><thead><tr>' +
    '<th>Time IST</th>' + (showExch ? '<th>Exch</th>' : '') +
    '<th>Acct</th><th>Side</th><th>Qty</th><th>Units</th><th>Price</th><th>Fee</th><th>rPnL</th></tr></thead><tbody>' +
    fills.map((f, i) =>
      '<tr class="clickable" id="fx' + tag + '-' + i + '" onclick="crossMatch(\'' + tag + '\',' + i + ')">' +
        '<td>' + fmtISTs(f.time) + '</td>' +
        (showExch ? '<td>' + esc(f.exchange) + '</td>' : '') +
        '<td>' + esc(f.account || '—') + '</td>' +
        '<td class="side-' + f.side + '">' + f.side.toUpperCase() + '</td>' +
        '<td>' + f.quantity + '</td>' +
        '<td>' + (f.units ?? f.quantity) + '</td>' +
        '<td>' + f.price + '</td>' +
        '<td class="pos-neg">' + (f.fee == null ? '—' : '-₹' + f.fee.toFixed(4)) + '</td>' +
        '<td class="' + (f.rpnl == null ? '' : (f.rpnl >= 0 ? 'pos-pos' : 'pos-neg')) + '">' + (f.rpnl == null ? '—' : (f.rpnl >= 0 ? '+' : '') + f.rpnl.toFixed(2)) + '</td>' +
      '</tr>'
    ).join('') + '</tbody></table>';
}

function crossMatch(tag, idx) {
  const side = document.getElementById('fxSide').value;
  const src = tag === 'd' ? fxDelta : fxHedge;
  const dst = tag === 'd' ? fxHedge : fxDelta;
  const srcF = side ? src.filter(f => f.side === side) : src;
  const dstF = side ? dst.filter(f => f.side === side) : dst;
  const t = srcF[idx]?.time; if (t == null || !dstF.length) return;
  let best = 0, bestD = Infinity;
  dstF.forEach((f, i) => { const dd = Math.abs(f.time - t); if (dd < bestD) { bestD = dd; best = i; } });
  document.querySelectorAll('#dpanel-fills tr.matched').forEach(el => el.classList.remove('matched'));
  const srcEl = document.getElementById('fx' + tag + '-' + idx);
  const dstEl = document.getElementById('fx' + (tag === 'd' ? 'h' : 'd') + '-' + best);
  if (srcEl) srcEl.classList.add('matched');
  if (dstEl) { dstEl.classList.add('matched'); dstEl.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
}

function setupFxAuto() {
  clearInterval(fxTimer);
  if (document.getElementById('fxAuto').checked && dataTab === 'fills') fxTimer = setInterval(loadFillsX, 15000);
}
document.addEventListener('change', (e) => {
  if (e.target.id === 'fxContract' || e.target.id === 'fxHours') loadFillsX();
  if (e.target.id === 'fxSide') renderFillsX();
});

// ── Order history ─────────────────────────────────────────
let odData = [];

async function loadOrdersX() {
  const contract = document.getElementById('odContract').value;
  const exchange = document.getElementById('odExchange').value;
  const hours    = document.getElementById('odHours').value;
  document.getElementById('odStatusMsg').textContent = 'Loading...';
  try {
    const qs = '?hours=' + hours + '&limit=1000'
      + (contract ? '&contract=' + encodeURIComponent(contract) : '')
      + (exchange ? '&exchange=' + exchange : '');
    const r = await fetch(withStrategy('/api/orders' + qs));
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    odData = await r.json();
    renderOrdersX();
    document.getElementById('odStatusMsg').textContent = 'Updated ' + new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
  } catch(e) {
    document.getElementById('odStatusMsg').innerHTML = '<span style="color:var(--red)">Error: ' + esc(e.message) + '</span>';
  }
}

function orderStatusClass(o) {
  const s = (o.status || '').toLowerCase();
  const partial = (o.filled_size > 0) && (o.size && o.filled_size < o.size);
  if (s.includes('cancel')) return partial ? 'ord-partcancel' : 'ord-cancel';
  if (partial) return 'ord-partial';
  return 'ord-filled';
}

function orderMatchesStatusFilter(o, f) {
  if (!f) return true;
  const s = (o.status || '').toLowerCase();
  const partial = (o.filled_size > 0) && (o.size && o.filled_size < o.size);
  if (f === 'filled')    return !s.includes('cancel') && !partial && o.filled_size > 0;
  if (f === 'partial')   return partial;
  if (f === 'cancelled') return s.includes('cancel');
  return true;
}

function renderOrdersX() {
  const f = document.getElementById('odStatus').value;
  const rows = odData.filter(o => orderMatchesStatusFilter(o, f));
  let filledOrders = 0, cancelledFilled = 0, execUnits = 0;
  for (const o of rows) {
    if (o.filled_size > 0) filledOrders++;
    if ((o.status || '').toLowerCase().includes('cancel') && o.filled_size > 0) cancelledFilled++;
    execUnits += o.filled_units || 0;
  }
  const cell = (k, v, cls) => '<div class="ins-cell"><div class="k">' + k + '</div><div class="v' + (cls ? ' ' + cls : '') + '">' + v + '</div></div>';
  document.getElementById('odInsights').innerHTML =
    cell('Orders shown', rows.length) +
    cell('With fills', filledOrders) +
    cell('Cancelled w/ partial fill', cancelledFilled, cancelledFilled ? 'pos-neg' : 'pos-pos') +
    cell('Executed units', execUnits.toFixed(0));

  document.getElementById('odGrid').innerHTML = !rows.length
    ? '<div style="padding:16px;color:var(--muted);">No orders in this window.</div>'
    : '<table class="dtable"><thead><tr><th>Time IST</th><th>Venue</th><th>Contract</th><th>Type</th><th>Side</th>'
      + '<th>Limit</th><th>Avg fill</th><th>Size</th><th>Filled</th><th>Units</th><th>Fee</th><th>Status</th></tr></thead><tbody>'
      + rows.map(o =>
        '<tr class="' + orderStatusClass(o) + '">'
        + '<td>' + fmtISTs(o.time) + '</td>'
        + '<td>' + esc(o.exchange) + '</td>'
        + '<td>' + esc(o.contract) + '</td>'
        + '<td>' + esc((o.order_type || '').replace('_order', '')) + '</td>'
        + '<td class="side-' + o.side + '">' + esc((o.side || '').toUpperCase()) + '</td>'
        + '<td>' + (o.price ?? '—') + '</td>'
        + '<td>' + (o.avg_fill_price ?? '—') + '</td>'
        + '<td>' + (o.size ?? '—') + '</td>'
        + '<td>' + (o.filled_size ?? 0) + '</td>'
        + '<td>' + (o.filled_units != null ? o.filled_units.toFixed(0) : '—') + '</td>'
        + '<td class="pos-neg">' + (o.fee == null ? '—' : '-₹' + o.fee.toFixed(4)) + '</td>'
        + '<td>' + esc(o.status || '—') + '</td></tr>'
      ).join('') + '</tbody></table>';
}

function setupOdAuto() {
  clearInterval(odTimer);
  if (document.getElementById('odAuto').checked && dataTab === 'orders') odTimer = setInterval(loadOrdersX, 15000);
}
document.addEventListener('change', (e) => {
  if (['odContract', 'odExchange', 'odHours'].includes(e.target.id)) loadOrdersX();
  if (e.target.id === 'odStatus') renderOrdersX();
});

// ── rPnL summary ──────────────────────────────────────────
async function loadRsum() {
  const hours = document.getElementById('rsHours').value;
  document.getElementById('rsStatusMsg').textContent = 'Loading...';
  try {
    const r = await fetch(withStrategy('/api/rpnl/rollup' + (hours ? '?hours=' + hours : '')));
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    const d = await r.json();
    renderRsum(d);
    document.getElementById('rsStatusMsg').textContent = 'Updated ' + new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
  } catch(e) {
    document.getElementById('rsStatusMsg').innerHTML = '<span style="color:var(--red)">Error: ' + esc(e.message) + '</span>';
  }
}

function pnlStr(v) { return (v >= 0 ? '+' : '') + '₹' + (v || 0).toFixed(2); }
function pnlCls(v) { return v >= 0 ? 'pos-pos' : 'pos-neg'; }

function renderRsum(d) {
  const t = d.totals || { quote: 0, hedge: 0, total: 0, fills: 0 };
  const cell = (k, v, cls) => '<div class="ins-cell"><div class="k">' + k + '</div><div class="v' + (cls ? ' ' + cls : '') + '">' + v + '</div></div>';
  document.getElementById('rsTotals').innerHTML =
    cell('Quote rPnL', pnlStr(t.quote), pnlCls(t.quote)) +
    cell('Hedge rPnL', pnlStr(t.hedge), pnlCls(t.hedge)) +
    cell('TOTAL rPnL', pnlStr(t.total), pnlCls(t.total)) +
    cell('Fills', (t.fills || 0).toLocaleString('en-IN'));

  const sym = d.by_symbol || [];
  document.getElementById('rsSymGrid').innerHTML = !sym.length
    ? '<div style="padding:16px;color:var(--muted);">No fills in this window.</div>'
    : '<table class="dtable"><thead><tr><th>Contract</th><th>Venue</th><th>Quote</th><th>Hedge</th><th>Total</th><th>Fills</th></tr></thead><tbody>'
      + sym.map(s =>
        '<tr><td>' + esc(s.contract) + '</td>'
        + '<td>' + esc(s.quote_label || '') + '</td>'
        + '<td class="' + pnlCls(s.quote) + '">' + pnlStr(s.quote) + '</td>'
        + '<td class="' + pnlCls(s.hedge) + '">' + pnlStr(s.hedge) + '</td>'
        + '<td class="' + pnlCls(s.total) + '">' + pnlStr(s.total) + '</td>'
        + '<td>' + (s.fills || 0) + '</td></tr>'
      ).join('')
      + '<tr style="font-weight:700;border-top:2px solid var(--border2);"><td>TOTAL</td><td></td>'
      + '<td class="' + pnlCls(t.quote) + '">' + pnlStr(t.quote) + '</td>'
      + '<td class="' + pnlCls(t.hedge) + '">' + pnlStr(t.hedge) + '</td>'
      + '<td class="' + pnlCls(t.total) + '">' + pnlStr(t.total) + '</td>'
      + '<td>' + (t.fills || 0) + '</td></tr>'
      + '</tbody></table>';

  const day = d.by_day || [];
  document.getElementById('rsDayGrid').innerHTML = !day.length
    ? '<div style="padding:16px;color:var(--muted);">No fills in this window.</div>'
    : '<table class="dtable"><thead><tr><th>Date</th><th>Quote</th><th>Hedge</th><th>Total</th><th>Fills</th></tr></thead><tbody>'
      + day.map(x =>
        '<tr><td>' + esc(x.date) + '</td>'
        + '<td class="' + pnlCls(x.quote) + '">' + pnlStr(x.quote) + '</td>'
        + '<td class="' + pnlCls(x.hedge) + '">' + pnlStr(x.hedge) + '</td>'
        + '<td class="' + pnlCls(x.total) + '">' + pnlStr(x.total) + '</td>'
        + '<td>' + (x.fills || 0) + '</td></tr>'
      ).join('') + '</tbody></table>';
}

function setupRsAuto() {
  clearInterval(rsTimer);
  if (document.getElementById('rsAuto').checked && dataTab === 'rsum') rsTimer = setInterval(loadRsum, 30000);
}
document.addEventListener('change', (e) => {
  if (e.target.id === 'rsHours') loadRsum();
});

// ── Events ────────────────────────────────────────────────
let evData = [];

async function loadEventsX() {
  const contract = document.getElementById('evContract').value;
  const limit    = document.getElementById('evLimit').value;
  document.getElementById('evStatus').textContent = 'Loading...';
  try {
    const r = await fetch(withStrategy('/api/events?limit=' + limit + (contract ? '&contract=' + contract : '')));
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    evData = await r.json();
    renderEventsX();
    document.getElementById('evStatus').textContent = evData.length + ' events';
  } catch(e) {
    document.getElementById('evStatus').innerHTML = '<span style="color:var(--red)">Error: ' + esc(e.message) + '</span>';
  }
}

function renderEventsX() {
  const q = (document.getElementById('evFilter').value || '').toLowerCase();
  const rows = q ? evData.filter(ev => JSON.stringify(ev).toLowerCase().includes(q)) : evData;
  document.getElementById('evGrid').innerHTML = !rows.length
    ? '<div style="padding:16px;color:var(--muted);">No events.</div>'
    : '<table class="dtable"><thead><tr><th>Time IST</th><th>Contract</th><th>Type</th><th>Side</th><th>Price</th><th>Qty</th><th>Status</th></tr></thead><tbody>' +
      rows.map(ev =>
        '<tr><td>' + fmtISTs(ev.time) + '</td>' +
        '<td>' + esc(ev.contract) + '</td>' +
        '<td>' + esc(ev.event_type) + '</td>' +
        '<td class="' + (ev.side ? 'side-' + ev.side : '') + '">' + esc(ev.side || '—') + '</td>' +
        '<td>' + (ev.price ?? '—') + '</td>' +
        '<td>' + (ev.quantity ?? '—') + '</td>' +
        '<td>' + esc(ev.status || '—') + '</td></tr>'
      ).join('') + '</tbody></table>';
}

function setupEvAuto() {
  clearInterval(evTimer);
  if (document.getElementById('evAuto').checked && dataTab === 'events') evTimer = setInterval(loadEventsX, 10000);
}
document.addEventListener('change', (e) => {
  if (e.target.id === 'evContract' || e.target.id === 'evLimit') loadEventsX();
});

// ── Positions ─────────────────────────────────────────────
async function loadPosX() {
  document.getElementById('pxStatus').textContent = 'Loading...';
  try {
    const r = await fetch(withStrategy('/api/positions/latest'));
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    const rows = await r.json();
    const now = Date.now() / 1000;
    document.getElementById('pxCards').innerHTML = !rows.length
      ? '<div style="color:var(--muted);">No position snapshots yet.</div>'
      : rows.map(p => {
          const gap = (p.delta_units ?? p.delta_size ?? 0) + (p.binance_size || 0);
          const gapCls = Math.abs(gap) < 1 ? 'gap-ok' : 'gap-bad';
          const upnlCls = (p.net_upnl || 0) >= 0 ? 'pos-pos' : 'pos-neg';
          const row = (k, v) => '<div class="pc-row"><span class="k">' + k + '</span><span>' + v + '</span></div>';
          return '<div class="pos-card"><h4>' + esc(p.contract) + '<span class="ago">' + fmtAgo(now - p.time) + '</span></h4>' +
            row('Delta size', (p.delta_size ?? 0) + ' lots (' + (p.delta_units ?? 0) + ' u) @ ' + (p.delta_entry ?? 0)) +
            row('Hedge size', (p.binance_size ?? 0) + ' @ ' + (p.binance_entry ?? 0)) +
            row('Mark price', p.mark_price ?? '—') +
            '<div class="pc-row"><span class="k">Exposure gap</span><span class="' + gapCls + '">' + (gap >= 0 ? '+' : '') + gap.toFixed(1) + '</span></div>' +
            '<div class="pc-row"><span class="k">Net uPnL</span><span class="' + upnlCls + '">' + ((p.net_upnl || 0) >= 0 ? '+' : '') + '₹' + (p.net_upnl || 0).toFixed(2) + '</span></div>' +
          '</div>';
        }).join('');
    document.getElementById('pxStatus').textContent = rows.length + ' contract' + (rows.length === 1 ? '' : 's');
  } catch(e) {
    document.getElementById('pxStatus').innerHTML = '<span style="color:var(--red)">Error: ' + esc(e.message) + '</span>';
  }
}

async function loadPosSnaps() {
  const contract = document.getElementById('pxContract').value;
  if (!contract) return;
  const limit = document.getElementById('pxLimit').value;
  try {
    const r = await fetch(withStrategy('/api/positions/snapshots?contract=' + contract + '&limit=' + limit));
    if (!r.ok) throw new Error('fetch failed');
    const rows = await r.json();
    document.getElementById('pxGrid').innerHTML = !rows.length
      ? '<div style="padding:16px;color:var(--muted);">No snapshots.</div>'
      : '<table class="dtable"><thead><tr><th>Time IST</th><th>Δ lots</th><th>Δ units</th><th>Δ entry</th><th>Hedge size</th><th>Hedge entry</th><th>Mark</th><th>Gap</th><th>Net uPnL</th></tr></thead><tbody>' +
        rows.map(p => {
          const gap = (p.delta_units ?? p.delta_size ?? 0) + (p.binance_size || 0);
          return '<tr><td>' + fmtISTs(p.time) + '</td>' +
            '<td>' + (p.delta_size ?? '—') + '</td><td>' + (p.delta_units ?? '—') + '</td><td>' + (p.delta_entry ?? '—') + '</td>' +
            '<td>' + (p.binance_size ?? '—') + '</td><td>' + (p.binance_entry ?? '—') + '</td>' +
            '<td>' + (p.mark_price ?? '—') + '</td>' +
            '<td class="' + (Math.abs(gap) < 1 ? 'gap-ok' : 'gap-bad') + '">' + gap.toFixed(1) + '</td>' +
            '<td class="' + ((p.net_upnl || 0) >= 0 ? 'pos-pos' : 'pos-neg') + '">' + ((p.net_upnl || 0) >= 0 ? '+' : '') + (p.net_upnl || 0).toFixed(2) + '</td></tr>';
        }).join('') + '</tbody></table>';
  } catch(e) {
    document.getElementById('pxGrid').innerHTML = '<div style="padding:16px;color:var(--red)">Error: ' + esc(e.message) + '</div>';
  }
}

function setupPxAuto() {
  clearInterval(pxTimer);
  if (document.getElementById('pxAuto').checked && dataTab === 'positions')
    pxTimer = setInterval(() => { loadPosX(); loadPosSnaps(); }, 15000);
}

// ── Generic table browser ─────────────────────────────────
let dbtName = null, dbtOffset = 0, dbtTotal = 0;
let dbtSort = '', dbtDir = 'desc';
let dbtColumns = [];
let dbtTypes = {};
let dbtPageRows = [];
let dbtPeekIdx = -1;
const dbtFacetsCache = {};
const DBT_COL_HINTS = {
  fills: ['created_at','contract','account','exchange','side','strategy','order_id','fill_id','rpnl','fee','upnl','bid','ask','position'],
  orders: ['created_at','contract','account','exchange','side','strategy','status','order_id'],
  logs: ['created_at','strategy','account','contract','exchange','service','level'],
  events: ['created_at','contract','strategy'],
  positions: ['created_at','contract','strategy'],
  account_balances: ['created_at','account','exchange','strategy'],
  coindcx_transactions: ['created_at','pair'],
};

function qsObj(p) {
  return Object.entries(p).filter(([, v]) => v !== '' && v != null && v !== false)
    .map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
}
function istYMD(offsetDays) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const today = fmt.format(new Date());
  if (!offsetDays) return today;
  const [y, m, d] = today.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + offsetDays));
  return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0');
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

async function loadDbTables() {
  document.getElementById('dbtStatus').textContent = 'Loading...';
  try {
    const r = await fetch('/api/db/tables');
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    const tables = await r.json();
    document.getElementById('dbtList').innerHTML = tables.map(t =>
      '<div class="tbl-item' + (t.name === dbtName ? ' active' : '') + '" id="dbt-' + t.name + '" onclick="openDbTable(\'' + t.name + '\')">' +
        '<span>' + esc(t.name) + '</span><span class="cnt">' + t.rows.toLocaleString() + '</span></div>'
    ).join('');
    document.getElementById('dbtStatus').textContent = tables.length + ' tables';
  } catch(e) {
    document.getElementById('dbtStatus').innerHTML = '<span style="color:var(--red)">Error: ' + esc(e.message) + '</span>';
  }
}

function dbtClearFilterInputs() {
  ['dbtFrom','dbtFromTime','dbtTo','dbtToTime','dbtContract','dbtAccount','dbtExchange','dbtStrategy','dbtService','dbtPair','dbtStatusCol','dbtOrderId','dbtQ'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const side = document.getElementById('dbtSide'); if (side) side.value = '';
  const level = document.getElementById('dbtLevel'); if (level) level.value = '';
  const preset = document.getElementById('dbtPreset'); if (preset) preset.value = '';
}

function openDbTable(name) {
  dbtName = name;
  dbtOffset = 0;
  dbtSort = '';
  dbtDir = 'desc';
  dbtPeekIdx = -1;
  dbtClearFilterInputs();
  document.getElementById('dbtPeek').style.display = 'none';
  dbtSyncFilterVisibility(DBT_COL_HINTS[name] || dbtColumns);
  document.getElementById('dbtExportBtn').disabled = false;
  document.getElementById('dbtExportPageBtn').disabled = false;
  document.getElementById('dbtCopyBtn').disabled = false;
  loadDbFacets(name);
  renderDbTable();
}
function dbtPage(dir) {
  const limit = parseInt(document.getElementById('dbtLimit').value);
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
  else if (p === '7d') from.value = istYMD(-6);
  else if (p === '30d') from.value = istYMD(-29);
  else if (p === '90d') from.value = istYMD(-89);
  dbtApply();
}
function dbtSortBy(col) {
  if (dbtSort === col) dbtDir = dbtDir === 'desc' ? 'asc' : 'desc';
  else {
    dbtSort = col;
    dbtDir = (col === 'id' || col === 'created_at' || col === 'updated_at') ? 'desc' : 'asc';
  }
  dbtOffset = 0;
  renderDbTable();
}
function dbtSyncFilterVisibility(cols) {
  const set = new Set(cols || []);
  const hasTime = set.has('created_at') || set.has('updated_at') || set.has('time');
  document.getElementById('dbtFilters').style.display = dbtName ? 'flex' : 'none';
  document.querySelectorAll('#dbtFilters [data-need]').forEach(el => {
    const need = el.getAttribute('data-need');
    el.style.display = (need === 'time' ? hasTime : set.has(need)) ? '' : 'none';
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
function dbtShowPeek(i) {
  dbtPeekIdx = i;
  document.querySelectorAll('#dbtGrid tbody tr').forEach((tr, idx) => tr.classList.toggle('selected', idx === i));
  const row = dbtPageRows[i];
  const peek = document.getElementById('dbtPeek');
  if (!row) { peek.style.display = 'none'; return; }
  const lines = Object.entries(row).map(([k, v]) => {
    let shown = v;
    if (v == null) shown = '∅';
    else if ((k === 'created_at' || k === 'updated_at') && typeof v === 'number') shown = fmtISTs(v);
    else if (typeof v === 'string' && (v.startsWith('{') || v.startsWith('['))) {
      try { shown = JSON.stringify(JSON.parse(v), null, 2); } catch {}
    }
    return esc(k) + ': ' + esc(String(shown));
  });
  peek.style.display = 'block';
  peek.innerHTML = '<div class="peek-h"><span>Row ' + (dbtOffset + i + 1) + ' of ' + dbtTotal.toLocaleString() + '</span>' +
    '<button class="btn" onclick="document.getElementById(\'dbtPeek\').style.display=\'none\'">Close</button></div>' +
    lines.join('\n');
}

async function renderDbTable() {
  if (!dbtName) return;
  document.querySelectorAll('.tbl-item').forEach(el => el.classList.toggle('active', el.id === 'dbt-' + dbtName));
  const limit = parseInt(document.getElementById('dbtLimit').value);
  const grid = document.getElementById('dbtGrid');
  const filters = dbtFilterParams();
  grid.innerHTML = '<div style="padding:16px;color:var(--muted);">Loading ' + esc(dbtName) + '…</div>';
  document.getElementById('dbtStatus').textContent = 'Loading ' + dbtName + '…';
  try {
    const r = await fetch('/api/db/table/' + encodeURIComponent(dbtName) + '?' + qsObj({ limit, offset: dbtOffset, ...filters }));
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    const d = await r.json();
    dbtTotal = d.total;
    dbtColumns = d.columns || [];
    dbtTypes = d.types || {};
    dbtSort = d.sort || dbtSort;
    dbtDir = d.dir || dbtDir;
    dbtSyncFilterVisibility(dbtColumns);
    const timeCols = new Set(['created_at', 'updated_at']);
    dbtPageRows = (d.rows || []).map(row => {
      const o = {};
      dbtColumns.forEach((c, i) => { o[c] = row[i]; });
      return o;
    });
    if (!d.rows.length) {
      grid.innerHTML = '<div style="padding:16px;color:var(--muted);">No rows match these filters.</div>';
    } else {
      grid.innerHTML = '<table class="dtable"><thead><tr>' + d.columns.map(c => {
        const on = dbtSort === c;
        const arrow = on ? (dbtDir === 'asc' ? '▲' : '▼') : '↕';
        return '<th class="sortable' + (on ? ' sorted' : '') + '" onclick="dbtSortBy(\'' + c + '\')">' +
          esc(c) + '<span class="sa">' + arrow + '</span></th>';
      }).join('') + '</tr></thead><tbody>' +
        d.rows.map((row, ri) => '<tr class="clickable' + (ri === dbtPeekIdx ? ' selected' : '') + '" onclick="dbtShowPeek(' + ri + ')">' + row.map((v, ci) => {
          const col = d.columns[ci];
          let s, extra = dbtIsNum(col, d.types) ? ' class="num"' : '';
          if (v == null) s = '<span style="color:var(--muted)">∅</span>';
          else if (timeCols.has(col) && typeof v === 'number') s = fmtISTs(v);
          else if (col === 'side') {
            const sl = String(v).toLowerCase();
            extra = ' class="' + (sl === 'buy' ? 'side-buy' : sl === 'sell' ? 'side-sell' : '') + '"';
            s = esc(String(v));
          } else {
            s = esc(String(v));
            if (s.length > 120) s = '<span title="' + s.replace(/"/g, '&quot;') + '">' + s.slice(0, 120) + '…</span>';
          }
          return '<td' + extra + '>' + s + '</td>';
        }).join('') + '</tr>').join('') + '</tbody></table>';
    }
    const pager = document.getElementById('dbtPager');
    pager.style.display = 'flex';
    const from = dbtTotal ? (dbtOffset + 1) : 0;
    document.getElementById('dbtPageInfo').textContent =
      from + '–' + Math.min(dbtOffset + limit, dbtTotal) + ' of ' + dbtTotal.toLocaleString();
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
    const stats = document.getElementById('dbtStats');
    if (d.stats && dbtTotal) {
      stats.style.display = 'grid';
      const n = (x) => (x == null ? '—' : Number(x).toLocaleString(undefined, { maximumFractionDigits: 4 }));
      stats.innerHTML =
        '<div class="ins-cell"><div class="k">Filtered rows</div><div class="v">' + dbtTotal.toLocaleString() + '</div></div>' +
        '<div class="ins-cell"><div class="k">Sum rPnL (stored)</div><div class="v">' + n(d.stats.rpnl) + '</div></div>' +
        '<div class="ins-cell"><div class="k">Sum fee (stored)</div><div class="v">' + n(d.stats.fee) + '</div></div>' +
        '<div class="ins-cell"><div class="k">Sum cost (stored)</div><div class="v">' + n(d.stats.cost) + '</div></div>';
    } else {
      stats.style.display = 'none';
      stats.innerHTML = '';
    }
    document.getElementById('dbtStatus').textContent =
      dbtTotal.toLocaleString() + ' rows' + (dbtSort ? ' · ' + dbtSort + ' ' + dbtDir : '');
    if (dbtPeekIdx >= 0 && dbtPeekIdx < dbtPageRows.length) dbtShowPeek(dbtPeekIdx);
    else document.getElementById('dbtPeek').style.display = 'none';
  } catch(e) {
    grid.innerHTML = '<div style="padding:16px;color:var(--red)">Error: ' + esc(e.message) + '</div>';
    document.getElementById('dbtStatus').innerHTML = '<span style="color:var(--red)">Error: ' + esc(e.message) + '</span>';
  }
}

async function exportDbTable() {
  if (!dbtName) return;
  const n = Math.min(Math.max(dbtTotal, 1), 100000);
  if (dbtTotal > 100000) toast('Exporting first 100,000 of ' + dbtTotal.toLocaleString() + ' matching rows', '');
  document.getElementById('dbtStatus').textContent = 'Exporting ' + n.toLocaleString() + ' matching rows…';
  try {
    const params = { ...dbtFilterParams(), limit: n };
    await downloadNamedCsv(
      '/api/db/table/' + encodeURIComponent(dbtName) + '/export?' + qsObj(params),
      dbtExportFilename(false)
    );
    document.getElementById('dbtStatus').textContent = 'Exported ' + n.toLocaleString() + ' matching rows';
    toast('Exported ' + n.toLocaleString() + ' rows', 'ok');
  } catch(e) {
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
function dbtCellText(col, v) {
  if (v == null) return '';
  if ((col === 'created_at' || col === 'updated_at') && typeof v === 'number') return fmtISTs(v);
  return String(v);
}
function dbtRowsCsv(rows) {
  const cols = dbtColumns;
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
  const cols = dbtColumns;
  const lines = [cols.join('\t')].concat(dbtPageRows.map(row => cols.map(c => {
    const v = row[c];
    if (v == null) return '';
    if ((c === 'created_at' || c === 'updated_at') && typeof v === 'number') return fmtISTs(v);
    return String(v).replace(/\t/g, ' ').replace(/\n/g, ' ');
  }).join('\t')));
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    toast('Copied ' + dbtPageRows.length + ' rows', 'ok');
  } catch {
    toast('Clipboard blocked', 'err');
  }
}

// ── Live logs ─────────────────────────────────────────────
let lgLastId = 0;
let lgFirstId = 0;   // oldest id currently shown (for "load older")

function lgMeta(l) {
  const bits = [l.strategy, l.contract, l.account, l.exchange].filter(Boolean);
  if (!bits.length) return '';
  return bits.map(b => '<span class="lchip">' + esc(b) + '</span>').join('');
}

function lgRenderLine(l) {
  const lv = String(l.level || '').trim();
  const lvCls = logLevelCls(lv);
  return '<div class="log-line"><span class="lt">' + fmtISTs(l.time) + '</span> ' +
    '<span class="lsvc">[' + esc(l.service) + ']</span> ' +
    '<span class="' + lvCls + '">' + esc(lv) + '</span> ' +
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
  const box     = document.getElementById('lgBox');
  try {
    let lines;
    if (reset || !lgLastId) {
      const r = await fetch('/api/logs?' + qsObj(lgFilterParams({ limit: initLim })));
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
      lines = (await r.json()).reverse(); // oldest first for display
      box.innerHTML = '';
      lgFirstId = lines.length ? lines[0].id : 0;
    } else {
      const r = await fetch('/api/logs?' + qsObj(lgFilterParams({ limit: 500, after_id: lgLastId })));
      if (!r.ok) return;
      lines = await r.json(); // already ascending in tail mode
      if (!lines.length) return;
    }
    if (!lines.length) { box.innerHTML = '<div style="padding:12px;color:var(--muted);">No logs yet. Bot service ko redeploy karne ke baad logs yahan stream honge.</div>'; lgLastId = 0; return; }
    box.insertAdjacentHTML('beforeend', lines.map(lgRenderLine).join(''));
    lgLastId = Math.max(lgLastId, ...lines.map(l => l.id));
    // Trim DOM to last ~8000 lines to keep the page responsive.
    while (box.children.length > 8000) box.removeChild(box.firstChild);
    if (document.getElementById('lgScroll').checked) box.scrollTop = box.scrollHeight;
    document.getElementById('lgStatus').textContent = box.children.length + ' shown · last id ' + lgLastId;
  } catch(e) {
    document.getElementById('lgStatus').innerHTML = '<span style="color:var(--red)">Error: ' + esc(e.message) + '</span>';
  }
}

async function loadOlderLogs() {
  if (!lgFirstId) return;
  const chunk   = parseInt(document.getElementById('lgLimit').value) || 1000;
  const box     = document.getElementById('lgBox');
  try {
    const r = await fetch('/api/logs?' + qsObj(lgFilterParams({ limit: chunk, before_id: lgFirstId })));
    if (!r.ok) return;
    const lines = (await r.json()).reverse(); // oldest first
    if (!lines.length) { document.getElementById('lgStatus').textContent = 'no older logs'; return; }
    const prevH = box.scrollHeight;
    box.insertAdjacentHTML('afterbegin', lines.map(lgRenderLine).join(''));
    lgFirstId = lines[0].id;
    box.scrollTop = box.scrollHeight - prevH; // keep viewport anchored
    document.getElementById('lgStatus').textContent = box.children.length + ' shown · from id ' + lgFirstId;
  } catch(e) { /* ignore */ }
}

async function exportLogsCsv() {
  document.getElementById('lgStatus').textContent = 'Exporting…';
  try {
    await downloadNamedCsv('/api/logs/export?' + qsObj(lgFilterParams({ limit: 50000 })), 'logs.csv');
    document.getElementById('lgStatus').textContent = 'Exported logs';
  } catch(e) {
    document.getElementById('lgStatus').innerHTML = '<span style="color:var(--red)">Export: ' + esc(e.message) + '</span>';
  }
}

function setupLgAuto() {
  clearInterval(lgTimer);
  if (document.getElementById('lgAuto').checked && dataTab === 'logs') lgTimer = setInterval(() => loadLogsX(false), 3000);
}
