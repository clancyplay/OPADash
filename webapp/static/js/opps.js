const OPP_KINDS = [
  { id: 'all', label: 'All' },
  { id: 'funding', label: 'Funding arb' },
  { id: 'spread', label: 'Spread arb' },
  { id: 'basis', label: 'Basis' },
  { id: 'book', label: 'Book spread' },
  { id: 'carry', label: 'Funding carry' },
];
const OPP_KIND_LABEL = {
  funding: 'Funding',
  spread: 'Spread',
  basis: 'Basis',
  book: 'Book',
  carry: 'Carry',
};
const OPP_PERIOD = { '8h': '/ 8h', trade: '/ trade', basis: 'to index' };
const LS_OPP_KIND = 'opadash.oppKind';
const LS_OPP_NOTIONAL = 'opadash.oppNotional';
const LS_OPP_AUTO = 'opadash.oppAuto';

let oppReady = false;
let oppRows = [];
let oppVenues = [];
let oppNotes = '';
let oppAsOf = 0;
let oppKind = 'all';
let oppTimer = null;
let oppLoading = false;

function oppNotional() {
  const n = Number((document.getElementById('oppNotional') || {}).value);
  if (!isFinite(n) || n < 100) return 10000;
  return Math.min(n, 5000000);
}

function oppMoney(n) {
  const v = Number(n) || 0;
  const sign = v < 0 ? '−' : '+';
  const a = Math.abs(v);
  const d = a >= 100 ? 0 : (a >= 10 ? 1 : 2);
  return sign + '$' + a.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function oppPct(frac, digits) {
  const v = Number(frac);
  if (!isFinite(v)) return '—';
  const p = v * 100;
  const d = digits != null ? digits : (Math.abs(p) >= 1 ? 2 : 3);
  const sign = p > 0 ? '+' : '';
  return sign + p.toFixed(d) + '%';
}

function oppPx(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return '—';
  const d = n >= 1000 ? 2 : (n >= 1 ? 4 : 6);
  return n.toLocaleString('en-US', { maximumFractionDigits: d });
}

function initOpps() {
  oppKind = lsGet(LS_OPP_KIND, 'all');
  if (!OPP_KINDS.some(k => k.id === oppKind)) oppKind = 'all';
  const notional = document.getElementById('oppNotional');
  if (notional) notional.value = lsGet(LS_OPP_NOTIONAL, '10000');
  const auto = document.getElementById('oppAuto');
  if (auto) auto.checked = lsGet(LS_OPP_AUTO, '1') !== '0';
  renderOppKinds();
  loadOpps(false);
  setupOppAuto();
}

function renderOppKinds() {
  const box = document.getElementById('oppKinds');
  if (!box) return;
  const counts = { all: oppRows.length };
  oppRows.forEach(r => { counts[r.kind] = (counts[r.kind] || 0) + 1; });
  box.innerHTML = OPP_KINDS.map(k => {
    const n = counts[k.id] || 0;
    const on = k.id === oppKind ? ' on' : '';
    return '<button type="button" class="opp-kind-btn' + on + '" data-opp-kind="' + k.id + '">' +
      escHtml(k.label) + (oppRows.length ? ' ' + n : '') + '</button>';
  }).join('');
  box.querySelectorAll('[data-opp-kind]').forEach(btn => {
    btn.onclick = function () {
      oppKind = btn.getAttribute('data-opp-kind') || 'all';
      lsSet(LS_OPP_KIND, oppKind);
      renderOppKinds();
      renderOpps();
    };
  });
}

function onOppNotional() {
  lsSet(LS_OPP_NOTIONAL, String(oppNotional()));
  renderOpps();
}

function setupOppAuto() {
  if (oppTimer) { clearInterval(oppTimer); oppTimer = null; }
  const box = document.getElementById('oppAuto');
  const on = !!(box && box.checked);
  lsSet(LS_OPP_AUTO, on ? '1' : '0');
  if (on) oppTimer = setInterval(() => loadOpps(false), 30000);
}

function stopOppAuto() {
  if (oppTimer) { clearInterval(oppTimer); oppTimer = null; }
}

async function loadOpps(fresh) {
  if (oppLoading) return;
  oppLoading = true;
  const status = document.getElementById('oppStatus');
  if (status && !oppRows.length) setLoading('oppStatus', 'Scanning exchanges…');
  try {
    const r = await fetch('/api/opps' + (fresh ? '?fresh=1' : ''));
    const d = r.ok ? await r.json() : null;
    if (!r.ok) {
      const msg = (d && d.detail) ? (typeof d.detail === 'string' ? d.detail : 'scan failed') : ('scan failed ' + r.status);
      setStatus('oppStatus', escHtml(msg), 'error');
      return;
    }
    oppRows = d.opps || [];
    oppVenues = d.venues || [];
    oppNotes = d.notes || '';
    oppAsOf = d.as_of ? Date.parse(d.as_of) : Date.now();
    renderOppKinds();
    renderOpps();
    paintOppMeta();
  } catch (e) {
    setStatus('oppStatus', escHtml(String(e.message || e)), 'error');
  } finally {
    oppLoading = false;
  }
}

function paintOppMeta() {
  const meta = document.getElementById('oppMeta');
  const notes = document.getElementById('oppNotes');
  if (notes) notes.textContent = oppNotes || '';
  if (!meta) return;
  const ago = oppAsOf ? fmtAgo(Math.max(0, (Date.now() - oppAsOf) / 1000)) : '';
  const bits = oppVenues.map(v => {
    if (v.ok) return escHtml(v.label) + ' ' + (v.n || 0);
    return '<span class="opp-venue-err">' + escHtml(v.label) + ' down</span>';
  });
  meta.innerHTML = (ago ? ago + ' · ' : '') + bits.join(' · ');
}

function oppFiltered() {
  const q = ((document.getElementById('oppSearch') || {}).value || '').trim().toLowerCase();
  const hideRun = !!((document.getElementById('oppHideRun') || {}).checked);
  return oppRows.filter(r => {
    if (oppKind !== 'all' && r.kind !== oppKind) return false;
    if (hideRun && (r.running || []).length) return false;
    if (!q) return true;
    const blob = [
      r.base, r.kind, r.summary, (r.suggest || {}).label,
      ...(r.legs || []).map(l => l.venue + ' ' + l.symbol + ' ' + l.side),
      ...(r.running || []).map(x => (x.strategy || '') + ' ' + (x.account_name || '') + ' ' + (x.account || '') + ' ' + (x.contract || '')),
    ].join(' ').toLowerCase();
    return blob.indexOf(q) >= 0;
  });
}

function oppRunHtml(rows) {
  if (!rows || !rows.length) return '';
  return '<div class="opp-run">' + rows.map(r => {
    const who = r.account_name || r.account || 'sub';
    const where = r.venue ? (r.venue + ' ') : '';
    const text = (r.strategy || 'bot') + ' · ' + who + (r.contract ? ' · ' + where + r.contract : '');
    return '<span class="opp-chip">' + escHtml(text) + '</span>';
  }).join('') + '</div>';
}

function oppLegHtml(leg) {
  const bits = [];
  if (leg.side) bits.push('<span class="side ' + escHtml(leg.side) + '">' + escHtml(leg.side) + '</span>');
  bits.push('<span class="sym">' + escHtml((leg.venue_label || leg.venue) + ' ' + leg.symbol) + '</span>');
  const meta = [];
  if (leg.mark) meta.push(oppPx(leg.mark));
  if (leg.fund_8h != null) meta.push('fund ' + oppPct(leg.fund_8h));
  if (leg.basis != null && Math.abs(leg.basis) >= 0.00005) meta.push('basis ' + oppPct(leg.basis));
  if (leg.spread != null && leg.spread > 0) meta.push('book ' + oppPct(leg.spread, 3));
  if (meta.length) bits.push('<span>' + meta.join(' · ') + '</span>');
  return '<div class="opp-leg">' + bits.join('') + '</div>';
}

function oppCard(r) {
  const n = oppNotional();
  const profit = (Number(r.edge) || 0) * n;
  const period = OPP_PERIOD[r.period] || '';
  const apr = r.apr != null ? '<span class="apr"> · ' + (Number(r.apr) * 100).toFixed(0) + '% APR</span>' : '';
  const run = r.running || [];
  const suggest = (r.suggest || {}).label || '';
  return '<article class="opp' + (run.length ? ' is-run' : '') + '">' +
    '<div class="opp-top">' +
      '<span class="opp-tag ' + escHtml(r.kind) + '">' + escHtml(OPP_KIND_LABEL[r.kind] || r.kind) + '</span>' +
      '<b>' + escHtml(r.base) + '</b>' +
      '<div class="opp-profit">' + oppMoney(profit) + '<small>' + escHtml(period) + '</small></div>' +
    '</div>' +
    '<p class="opp-sum">' + escHtml(r.summary || '') + apr + '</p>' +
    '<div class="opp-legs">' + (r.legs || []).map(oppLegHtml).join('') + '</div>' +
    oppRunHtml(run) +
    '<div class="opp-foot">' +
      '<span class="opp-suggest">' + escHtml(suggest) + '</span>' +
      '<button type="button" class="btn" data-opp-start="' + escHtml(r.id) + '">Start</button>' +
    '</div>' +
  '</article>';
}

function renderOpps() {
  const box = document.getElementById('oppList');
  if (!box) return;
  const rows = oppFiltered();
  const bad = oppVenues.filter(v => !v.ok);
  const statusBits = [rows.length + ' shown'];
  if (bad.length) statusBits.push(bad.map(v => v.label + ': ' + (v.error || 'failed')).join(' · '));
  setStatus('oppStatus', escHtml(statusBits.join(' · ')), bad.length && !rows.length ? 'error' : '');
  if (!rows.length) {
    box.innerHTML = '<div class="opp-empty">No opportunities for this filter. Refresh, or lower the search.</div>';
    return;
  }
  if (oppKind !== 'all') {
    box.innerHTML = rows.map(oppCard).join('');
  } else {
    const chunks = [];
    OPP_KINDS.forEach(k => {
      if (k.id === 'all') return;
      const part = rows.filter(r => r.kind === k.id);
      if (!part.length) return;
      chunks.push('<div class="opp-sec">' + escHtml(k.label) + ' · ' + part.length + '</div>');
      chunks.push(part.map(oppCard).join(''));
    });
    box.innerHTML = chunks.join('');
  }
  const byId = {};
  oppRows.forEach(r => { byId[r.id] = r; });
  box.querySelectorAll('[data-opp-start]').forEach(btn => {
    btn.onclick = function () {
      const row = byId[btn.getAttribute('data-opp-start')];
      if (!row || typeof openOppLaunch !== 'function') return;
      const run = (row.running || []).map(x => (x.strategy || 'bot') + ' on ' + (x.account_name || x.account || 'sub')).join(', ');
      const note = (row.summary || '') + (run ? ' · already ' + run : '');
      openOppLaunch(row.suggest || {}, note);
    };
  });
}
