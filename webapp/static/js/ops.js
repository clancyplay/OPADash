let opsCatalog = null;
let opsAccounts = [];
let opsProducts = [];
let opsBots = [];
let opsReady = false;
let opsEdit = null;
let opsSkipSaved = false;
let opsSavedSeq = 0;

function opsErr(d, status) {
  const det = d && d.detail;
  if (typeof det === 'string' && det) return det;
  if (Array.isArray(det) && det[0]) {
    const first = det[0];
    return first.msg || first.message || JSON.stringify(first);
  }
  return 'failed ' + status;
}

function applyOpsMode() {
  const panel = document.querySelector('#rpOps .rp-ops-panel');
  const title = document.getElementById('rpOpsTitle');
  const btn = document.getElementById('opsLaunchBtn');
  const edit = !!opsEdit;
  if (panel) panel.classList.toggle('edit', edit);
  if (title) title.textContent = edit ? ('Edit ' + (opsEdit.qsym || opsEdit.contract || '')) : 'New contract';
  if (btn) btn.textContent = edit ? 'Apply' : 'Start';
  const kill = document.getElementById('opsRemoveBtn');
  if (kill) {
    const rail = opsCatalog && opsCatalog.launch === 'railway';
    kill.textContent = rail ? 'Remove service' : 'Kill process';
  }
  const meta = document.getElementById('opsEditMeta');
  if (meta) {
    if (!edit) {
      meta.innerHTML = '';
    } else {
      const acct = opsEdit.account_name || opsEdit.account || '';
      meta.innerHTML = '<b>' + escHtml(opsEdit.qsym || opsEdit.contract || '') + '</b> · ' +
        escHtml(opsEdit.strategy || '') +
        (acct ? ' · ' + escHtml(acct) : '') +
        '<div class="aid">Saved to this contract’s env — restart keeps these values</div>';
    }
  }
}

function openRpOps() {
  opsEdit = null;
  const box = document.getElementById('rpOps');
  if (!box) return;
  applyOpsMode();
  box.hidden = false;
  document.body.classList.add('ops-open');
  bootRpOps().then(() => {
    fillOpsStrategies();
    applyOpsLaunchLead();
    renderOpsParams();
    onOpsStrategyChange();
    setOpsMsg('opsLaunchMsg', '', false);
  });
}

function openRpOpsEdit(row) {
  if (!row || !row.live) return;
  if (typeof rpnlIsPairHedge === 'function' && rpnlIsPairHedge(row)) {
    toast('pair hedge is automatic — edit the option contracts', 'err');
    return;
  }
  opsEdit = {
    contract: row.contract,
    account: row.account,
    account_name: row.account_name || '',
    strategy: String(row.strategy || '').toLowerCase(),
    venue: row.quote_venue || '',
    qsym: row.quote_symbol || row.contract,
    settings: row.settings || {},
  };
  const box = document.getElementById('rpOps');
  if (!box) return;
  applyOpsMode();
  box.hidden = false;
  document.body.classList.add('ops-open');
  bootRpOps().then(() => {
    const sel = document.getElementById('opsStrategy');
    if (sel && opsEdit.strategy) {
      if (opsEdit.strategy === 'pair' && ![...sel.options].some(o => o.value === 'pair')) {
        sel.insertAdjacentHTML('beforeend', '<option value="pair">Pair</option>');
      }
      if ([...sel.options].some(o => o.value === opsEdit.strategy)) sel.value = opsEdit.strategy;
    }
    renderOpsParams();
    fillOpsFromSetup(opsEdit.settings);
    setOpsMsg('opsLaunchMsg', '', false);
  });
}

function pickOpsAccount(account, accountName) {
  const sel = document.getElementById('opsAccount');
  if (!sel) return;
  const want = [account, accountName].map(v => String(v || '').trim()).filter(Boolean);
  const hit = [...sel.options].find(o => want.includes(o.value) || want.includes(String(o.textContent || '').trim()));
  if (hit) sel.value = hit.value;
}

async function openRpRestart(row) {
  if (!row || row.live) return;
  if (typeof rpnlIsPairHedge === 'function' && rpnlIsPairHedge(row)) {
    toast('pair hedge is automatic — restart the option contracts', 'err');
    return;
  }
  const venue = String(row.quote_venue || 'delta').toLowerCase();
  const contract = row.quote_symbol || row.contract || '';
  const strategy = String(row.strategy || '').toLowerCase();
  const name = contract || row.contract || '';
  opsEdit = null;
  opsSkipSaved = true;
  const box = document.getElementById('rpOps');
  if (!box) return;
  applyOpsMode();
  box.hidden = false;
  document.body.classList.add('ops-open');
  try {
    await bootRpOps();
    const venueEl = document.getElementById('opsVenue');
    if (venueEl && [...venueEl.options].some(o => o.value === venue)) {
      venueEl.disabled = false;
      venueEl.value = venue;
    }
    await onOpsVenueChange();
    pickOpsAccount(row.account, row.account_name);
    const inp = document.getElementById('opsContract');
    if (inp) inp.value = contract;
    const strat = document.getElementById('opsStrategy');
    if (strat && strategy && [...strat.options].some(o => o.value === strategy)) strat.value = strategy;
    onOpsStrategyChange();
    if (row.settings) fillOpsFromSetup(row.settings);
  } finally {
    opsSkipSaved = false;
  }
  onOpsContractMeta();
  applyOpsLaunchLead();
  const title = document.getElementById('rpOpsTitle');
  if (title) title.textContent = 'Restart ' + name;
  setOpsMsg('opsLaunchMsg', 'Same contract, account, and last saved settings. Press Start to run it again.', false);
}

async function openOppLaunch(spec, note) {
  spec = spec || {};
  if (!spec.venue || !spec.contract) return;
  opsEdit = null;
  opsSkipSaved = true;
  const box = document.getElementById('rpOps');
  if (!box) return;
  applyOpsMode();
  box.hidden = false;
  document.body.classList.add('ops-open');
  try {
    await bootRpOps();
    const venue = document.getElementById('opsVenue');
    if (venue && [...venue.options].some(o => o.value === spec.venue)) {
      venue.disabled = false;
      venue.value = spec.venue;
    }
    await onOpsVenueChange();
    const inp = document.getElementById('opsContract');
    if (inp) inp.value = spec.contract;
    const strat = document.getElementById('opsStrategy');
    if (strat && spec.strategy && [...strat.options].some(o => o.value === spec.strategy)) {
      strat.value = spec.strategy;
    }
    onOpsStrategyChange();
    if (spec.edge_venue) {
      const ev = document.getElementById('opsP_EDGE_VENUE') || document.getElementById('opsP_ARB_VENUE');
      if (ev && [...ev.options].some(o => o.value === spec.edge_venue)) ev.value = spec.edge_venue;
    }
    if (spec.arb_symbol) {
      const sym = document.getElementById('opsP_ARB_SYMBOL');
      if (sym) sym.value = spec.arb_symbol;
    }
    if (spec.max_usd) {
      const maxEl = document.getElementById('opsP_MAX_POSITION');
      if (maxEl) maxEl.value = String(Math.round(Number(spec.max_usd)));
      if (typeof setOpsMaxUnit === 'function') setOpsMaxUnit('usd');
    }
  } finally {
    opsSkipSaved = false;
  }
  onOpsContractMeta();
  applyOpsLaunchLead();
  setOpsMsg('opsLaunchMsg', note || '', false);
}

function closeRpOps() {
  const box = document.getElementById('rpOps');
  if (box) box.hidden = true;
  document.body.classList.remove('ops-open');
  opsEdit = null;
  opsSkipSaved = false;
  applyOpsMode();
  if (opsCatalog) fillOpsStrategies();
}

async function bootRpOps() {
  try {
    if (!opsCatalog) {
      const r = await fetch('/api/ops/strategies');
      opsCatalog = r.ok ? await r.json() : { venues: [], strategies: [] };
      fillOpsVenues();
      fillOpsStrategies();
    }
    applyOpsMode();
    if (opsEdit) {
      await refreshOpsBots();
      return;
    }
    await onOpsVenueChange();
    await refreshOpsBots();
  } catch (e) {
    setOpsMsg('opsLaunchMsg', String(e), true);
  }
}

function applyOpsLaunchLead() {
  const el = document.getElementById('opsLaunchLead');
  if (!el) return;
  const mode = (opsCatalog && opsCatalog.launch) || '';
  if (mode === 'railway') {
    el.textContent = 'Creates a new Railway service from your OPA6 repo with this subaccount’s keys. Same contract + account + strategy cannot run twice.';
  } else if (mode === 'railway-unconfigured') {
    el.textContent = 'On Railway this needs RAILWAY_TOKEN on OPADash and OPA6_RAILWAY_SERVICE (existing OPA6 bot name). It cannot spawn a local process here.';
  } else {
    el.textContent = 'Start an OPA6 process with this subaccount’s keys. Same contract + account + strategy cannot run twice.';
  }
}

function fillOpsVenues() {
  const sel = document.getElementById('opsVenue');
  if (!sel) return;
  const venues = opsCatalog.venues || [];
  const labels = { delta: 'Delta', binance: 'Binance', bybit: 'Bybit', kucoin: 'KuCoin', coinbase: 'Coinbase', aster: 'Aster' };
  sel.innerHTML = venues.map(v => '<option value="' + escHtml(v) + '">' + escHtml(labels[v] || v) + '</option>').join('');
}

function fillOpsStrategies() {
  const sel = document.getElementById('opsStrategy');
  if (!sel) return;
  const rows = opsCatalog.strategies || [];
  sel.innerHTML = rows.map(s => '<option value="' + escHtml(s.id) + '">' + escHtml(s.label || s.id) + '</option>').join('');
  if ([...sel.options].some(o => o.value === 'stack')) sel.value = 'stack';
}

function opsVenue() {
  return (document.getElementById('opsVenue') || {}).value || 'delta';
}

async function onOpsVenueChange() {
  const venue = opsVenue();
  await Promise.all([loadOpsAccounts(venue), loadOpsProducts(venue)]);
  onOpsContractMeta();
}

async function loadOpsAccounts(venue) {
  const sel = document.getElementById('opsAccount');
  if (!sel) return;
  const keep = sel.value;
  const r = await fetch('/api/ops/accounts?venue=' + encodeURIComponent(venue));
  const d = r.ok ? await r.json() : { accounts: [] };
  opsAccounts = d.accounts || [];
  if (!opsAccounts.length) {
    sel.innerHTML = '<option value="">No keys for ' + escHtml(venue) + '</option>';
    renderOpsAccountSnap();
    return;
  }
  sel.innerHTML = opsAccounts.map(a => {
    const id = a.id || a.name || '';
    const lab = a.name || a.id || '';
    return '<option value="' + escHtml(id) + '">' + escHtml(lab) + '</option>';
  }).join('');
  if (keep && [...sel.options].some(o => o.value === keep)) sel.value = keep;
  renderOpsAccountSnap();
}

function opsAccountRow() {
  const id = (document.getElementById('opsAccount') || {}).value || '';
  return (opsAccounts || []).find(a => a.id === id || a.name === id) || null;
}

function onOpsAccountChange() {
  renderOpsAccountSnap();
  loadOpsSavedKnobs();
}

function opsMoney(a, preferAvail) {
  if (!a) return '';
  const asset = String(a.asset || 'USD').toUpperCase();
  let usd = Number(preferAvail && a.available != null ? a.available : a.balance);
  let inr = Number(a.balance_inr);
  const rate = Number(a.usdinr);
  const fx = isFinite(rate) && rate > 0 ? rate : 87;
  if (preferAvail && a.available != null && isFinite(usd)) inr = usd * fx;
  if ((!isFinite(inr) || a.balance_inr == null) && isFinite(usd) && (a.balance != null || a.available != null)) inr = usd * fx;
  if ((!isFinite(usd) || a.balance == null) && isFinite(inr) && a.balance_inr != null) usd = inr / fx;
  const bits = [];
  if (isFinite(inr) && (a.balance_inr != null || a.balance != null || a.available != null)) {
    bits.push(typeof inrFmt === 'function'
      ? inrFmt(inr)
      : ('₹' + Math.abs(inr).toLocaleString('en-IN', { maximumFractionDigits: 0 })));
  }
  if (isFinite(usd) && (a.balance != null || a.balance_inr != null || a.available != null)) {
    const d = Math.abs(usd) >= 100 ? 0 : (Math.abs(usd) >= 10 ? 1 : 2);
    const unit = (asset === 'INR') ? '' : ((asset === 'USD' || asset === 'USDT' || !asset) ? '$' : asset + ' ');
    bits.push(unit + usd.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
  }
  return bits.join(' · ');
}

function opsRunningHtml(a) {
  const rows = (a && a.running) || [];
  if (!rows.length) return '<div class="rp-ops-run idle">idle</div>';
  return '<div class="rp-ops-run-list">' + rows.map(x => {
    const s = String(x.strategy || '').toLowerCase();
    const c = x.contract || '';
    const lab = s ? (c + ' · ' + s) : c;
    return '<span class="rp-ops-run-chip ' + escHtml(s || 'bot') + '">' + escHtml(lab) + '</span>';
  }).filter(Boolean).join('') + '</div>';
}

function opsAcctCardHtml(a, opts) {
  opts = opts || {};
  const id = a.id || a.name || '';
  const name = a.name || a.id || '';
  const on = !!opts.on;
  const mode = String(a.margin_mode || '').trim();
  const bal = opsMoney(a, !!opts.avail);
  const parent = !!a.parent;
  return '<button type="button" class="rp-ops-acct' + (on ? ' on' : '') + (parent ? ' parent' : '') + '" data-ops-acct="' + escHtml(id) + '"' +
    (opts.role ? ' data-xfer-role="' + escHtml(opts.role) + '"' : '') + '>' +
    '<div class="rp-ops-acct-h">' +
      '<b>' + escHtml(name) + '</b>' +
      (parent ? '<span class="rp-ops-mode parent">parent</span>' : '') +
      (mode ? '<span class="rp-ops-mode ' + escHtml(mode) + '">' + escHtml(mode) + '</span>' : '') +
      (bal ? '<span class="rp-ops-bal">' + escHtml(bal) + '</span>' : '') +
    '</div>' +
    opsRunningHtml(a) +
    (a.error ? '<div class="aid">' + escHtml(a.error) + '</div>' : '') +
  '</button>';
}

function renderOpsAccountSnap() {
  const box = document.getElementById('opsAccountSnap');
  if (!box) return;
  if (!opsAccounts.length) {
    box.innerHTML = '<div class="rp-ops-empty">No keys for this exchange</div>';
    return;
  }
  const cur = (document.getElementById('opsAccount') || {}).value || '';
  box.innerHTML = opsAccounts.map(a => {
    const id = a.id || a.name || '';
    return opsAcctCardHtml(a, { on: id === cur || a.name === cur });
  }).join('');
}

async function loadOpsProducts(venue) {
  const list = document.getElementById('opsContractList');
  if (!list) return;
  list.innerHTML = '';
  try {
    const r = await fetch('/api/ops/products?venue=' + encodeURIComponent(venue));
    const d = r.ok ? await r.json() : { products: [] };
    const seen = {};
    opsProducts = (d.products || []).filter(p => {
      const s = String(p.symbol || '').toUpperCase();
      if (!s || seen[s]) return false;
      seen[s] = true;
      return true;
    });
    list.innerHTML = opsProducts.slice(0, 400).map(p =>
      '<option value="' + escHtml(p.symbol) + '">' + escHtml(p.name && p.name !== p.symbol ? p.name : '') + '</option>'
    ).join('');
  } catch (e) {
    opsProducts = [];
  }
  onOpsContractMeta();
}

function onOpsContractMeta() {
  const el = document.getElementById('opsContractMeta');
  const id = opsStrategyId();
  const sy = ((document.getElementById('opsContract') || {}).value || '').trim().toUpperCase();
  const p = (opsProducts || []).find(x => String(x.symbol || '').toUpperCase() === sy);
  if (el) {
    if (!p) {
      el.textContent = id === 'pair' ? 'Option C-/P- symbol, call+put, or crop + expiry (BTC 250926)'
        : id === 'wing' ? 'Crop and expiry. BTC, ETH, or XAU, then the date (250926).'
        : id === 'harvest' ? 'Crop only: BTC, ETH, or XAU. How many fields is set below.'
        : id === 'shop' ? 'Counter symbol. Stockroom below is the CoinDCX cover.'
        : '';
    } else {
      const bits = [];
      if (p.tick != null && Number(p.tick) > 0) bits.push('tick ' + p.tick);
      if (p.cv != null && Number(p.cv) > 0) bits.push('cv ' + p.cv);
      el.textContent = bits.join(' · ');
    }
  }
  loadOpsSavedKnobs();
}

function opsStrategyId() {
  return (opsEdit && opsEdit.strategy) || (document.getElementById('opsStrategy') || {}).value || '';
}

function opsIsPair() {
  return opsStrategyId() === 'pair';
}

function onOpsStrategyChange() {
  renderOpsParams();
  const id = opsStrategyId();
  const lock = (id === 'pair' || id === 'wing' || id === 'harvest') ? 'delta' : '';
  const venue = document.getElementById('opsVenue');
  if (venue && !opsEdit) {
    venue.disabled = !!lock;
    const shopBad = id === 'shop' && venue.value !== 'delta' && venue.value !== 'aster';
    if ((lock && venue.value !== lock) || shopBad) {
      venue.value = lock || 'delta';
      onOpsVenueChange();
    }
  }
  const inp = document.getElementById('opsContract');
  if (inp && !opsEdit) {
    inp.placeholder = id === 'pair' ? 'C-BTC-120000-250926 or BTC 250926'
      : id === 'wing' ? 'BTC 250926'
      : id === 'harvest' ? 'BTC'
      : id === 'shop' ? 'LABUSD'
      : 'EVAAUSD';
  }
  onOpsContractMeta();
}

function loadOpsSavedKnobs() {
  if (opsEdit || opsSkipSaved) return;
  clearTimeout(loadOpsSavedKnobs._t);
  loadOpsSavedKnobs._t = setTimeout(_loadOpsSavedKnobs, 280);
}

async function _loadOpsSavedKnobs() {
  if (opsEdit || opsSkipSaved) return;
  const venue = opsVenue();
  const account = (document.getElementById('opsAccount') || {}).value || '';
  const row = typeof opsAccountRow === 'function' ? opsAccountRow() : null;
  const accountName = (row && (row.name || '')) || '';
  const contract = ((document.getElementById('opsContract') || {}).value || '').trim();
  const strategy = (document.getElementById('opsStrategy') || {}).value || '';
  if (!strategy || !account || contract.length < 3) return;
  const seq = ++opsSavedSeq;
  try {
    const q = new URLSearchParams({ venue, contract, account, strategy });
    if (accountName) q.set('account_name', accountName);
    const r = await fetch('/api/ops/knobs?' + q.toString());
    const d = r.ok ? await r.json() : {};
    if (seq !== opsSavedSeq || opsEdit || opsSkipSaved) return;
    const setup = d && d.setup;
    if (!setup || !Object.keys(setup).length) return;
    fillOpsFromSetup(setup);
    setOpsMsg('opsLaunchMsg', 'Loaded last saved env for this contract', false);
  } catch (e) {}
}

function opsStrategySpec() {
  const id = (opsEdit && opsEdit.strategy) || (document.getElementById('opsStrategy') || {}).value || '';
  if (id === 'pair') {
    const fromCat = ((opsCatalog && opsCatalog.strategies) || []).find(s => s.id === 'pair');
    return fromCat || { id: 'pair', label: 'Pair', params: (opsCatalog && opsCatalog.pair_params) || [] };
  }
  return ((opsCatalog && opsCatalog.strategies) || []).find(s => s.id === id) || { params: [] };
}

function opsGeomParam() {
  return ((opsStrategySpec().params) || []).find(p => p.type === 'geom') || null;
}

function opsGeomLens() {
  const all = (opsCatalog && Array.isArray(opsCatalog.geom)) ? opsCatalog.geom : [];
  const p = opsGeomParam();
  if (!p) return [];
  const want = Array.isArray(p.lenses) && p.lenses.length ? p.lenses : null;
  const extras = p.lens_defaults && typeof p.lens_defaults === 'object' ? p.lens_defaults : {};
  const byId = {};
  all.forEach(g => { byId[g.id] = g; });
  const src = want ? want.map(id => byId[id]).filter(Boolean) : all;
  return src.map(g => Object.assign({}, g, extras[g.id] || {}));
}

function opsGeomDef(id) {
  return opsGeomLens().find(g => g.id === id) || {};
}

function opsGeomHasBounds(g) {
  const row = (typeof g === 'string') ? opsGeomDef(g) : (g || {});
  if (!row || !row.id || row.id === 'k') return false;
  return row.bound !== false;
}

function opsGeomPrefix(g) {
  const id = (typeof g === 'string') ? g : (g && g.id);
  if (id === 'tail') return 'STEP';
  return String(id || '').toUpperCase();
}

function opsGeomAutoKey(g) {
  const prefix = opsGeomPrefix(g);
  return prefix ? prefix + '_AUTO' : '';
}

function opsGeomModeFromVals(a, b) {
  a = String(a == null ? '' : a).trim();
  b = String(b == null ? '' : b).trim();
  if (a === '' && b === '') return 'book';
  if (a !== '' && b !== '' && Number(a) === Number(b)) return 'lock';
  if (a !== '' && b === '') return 'floor';
  if (a === '' && b !== '') return 'cap';
  return 'range';
}

function opsGeomFollows(id) {
  if (!opsGeomHasBounds(id)) return false;
  return opsGeomMode(id) !== 'lock';
}

function opsGeomMode(id) {
  const minEl = document.getElementById('opsG_' + id + '_min');
  const maxEl = document.getElementById('opsG_' + id + '_max');
  return opsGeomModeFromVals(minEl && minEl.value, maxEl && maxEl.value);
}

function opsGeomAutoOn(id) {
  return opsGeomFollows(id);
}

function opsGeomMultLens() {
  const ids = opsGeomLens().map(g => g.id);
  if (ids.indexOf('step') >= 0) return 'step';
  if (ids.indexOf('tail') >= 0) return 'tail';
  return '';
}

function opsMultParam() {
  const hit = ((opsStrategySpec().params) || []).find(p => p.key === 'STEP_MULT');
  if (hit) return hit;
  return {
    key: 'STEP_MULT', default: '1',
    options: [
      { value: '1', label: '1 · equal gaps' },
      { value: '2', label: '2 · double' },
      { value: '3', label: '3 · triple' },
      { value: 'log', label: 'log · ×e' },
      { value: 'log2', label: 'log2 · ×2,×4' },
      { value: 'log10', label: 'log10 · ×10,×100' },
    ],
  };
}

function opsFlagOn(key) {
  const el = document.getElementById('opsP_' + key);
  if (el) {
    if (el.type === 'checkbox') return !!el.checked;
    if (el.type === 'hidden') return el.value === '1' || el.value === 'true';
  }
  if (String(key || '').slice(-5) === '_AUTO') {
    return opsGeomAutoOn(String(key).slice(0, -5).toLowerCase());
  }
  return false;
}

function opsGeomState() {
  try {
    const raw = (typeof lsGet === 'function') ? lsGet('opadash.opsGeom', '{}') : '{}';
    const d = JSON.parse(raw || '{}');
    return d && typeof d === 'object' ? d : {};
  } catch (e) {
    return {};
  }
}

function saveOpsGeomState(state) {
  if (typeof lsSet === 'function') lsSet('opadash.opsGeom', JSON.stringify(state));
}

function opsGeomRowUnit(id) {
  const btn = document.querySelector('#opsGeom [data-geom="' + id + '"] .rp-ops-unit:not(.rp-ops-len-mode) button.on');
  return (btn && btn.getAttribute('data-unit')) || 'pct';
}

function persistOpsGeom() {
  if (opsEdit) return;
  const state = opsGeomState();
  opsGeomLens().forEach(g => {
    const row = document.querySelector('#opsGeom [data-geom="' + g.id + '"]');
    if (!row) return;
    const unit = opsGeomRowUnit(g.id);
    if (opsGeomHasBounds(g)) {
      const minEl = document.getElementById('opsG_' + g.id + '_min');
      const maxEl = document.getElementById('opsG_' + g.id + '_max');
      const minV = minEl ? minEl.value : '';
      const maxV = maxEl ? maxEl.value : '';
      if (unit === 'ticks') {
        row.dataset.minTicks = minV;
        row.dataset.maxTicks = maxV;
      } else {
        row.dataset.minPct = minV;
        row.dataset.maxPct = maxV;
      }
      state[g.id] = {
        unit: unit,
        min_pct: row.dataset.minPct || '',
        max_pct: row.dataset.maxPct || '',
        min_ticks: row.dataset.minTicks || '',
        max_ticks: row.dataset.maxTicks || '',
      };
      return;
    }
    const inp = document.getElementById('opsG_' + g.id);
    if (!inp) return;
    if (unit === 'ticks') row.dataset.ticks = inp.value;
    else row.dataset.pct = inp.value;
    state[g.id] = {
      unit: unit,
      pct: row.dataset.pct || g.pct_default,
      ticks: row.dataset.ticks || g.ticks_default,
    };
  });
  saveOpsGeomState(state);
}

function setOpsGeomUnit(id, unit) {
  const row = document.querySelector('#opsGeom [data-geom="' + id + '"]');
  if (!row) return;
  const prev = opsGeomRowUnit(id);
  const g = opsGeomDef(id);
  const tickMin = g.allow_zero ? '0' : '0';
  row.querySelectorAll('.rp-ops-unit:not(.rp-ops-len-mode) button').forEach(b => {
    b.classList.toggle('on', b.getAttribute('data-unit') === unit);
  });
  if (opsGeomHasBounds(id)) {
    const minEl = document.getElementById('opsG_' + id + '_min');
    const maxEl = document.getElementById('opsG_' + id + '_max');
    if (minEl && maxEl) {
      if (prev === 'ticks') {
        row.dataset.minTicks = minEl.value;
        row.dataset.maxTicks = maxEl.value;
      } else {
        row.dataset.minPct = minEl.value;
        row.dataset.maxPct = maxEl.value;
      }
      const nextMin = unit === 'ticks' ? (row.dataset.minTicks || '') : (row.dataset.minPct || '');
      const nextMax = unit === 'ticks' ? (row.dataset.maxTicks || '') : (row.dataset.maxPct || '');
      minEl.value = nextMin;
      maxEl.value = nextMax;
      minEl.step = maxEl.step = unit === 'ticks' ? '1' : 'any';
      minEl.min = maxEl.min = unit === 'ticks' ? tickMin : '0';
    }
  } else {
    const inp = document.getElementById('opsG_' + id);
    if (inp) {
      if (prev === 'ticks') row.dataset.ticks = inp.value;
      else row.dataset.pct = inp.value;
      inp.step = unit === 'ticks' ? '1' : 'any';
      inp.min = unit === 'ticks' ? (g.allow_zero ? '0' : '1') : '0';
      const next = unit === 'ticks'
        ? (row.dataset.ticks || g.ticks_default || '0')
        : (row.dataset.pct || g.pct_default || '0');
      inp.value = next;
    }
  }
  persistOpsGeom();
  syncOpsDependentFields();
}

function onOpsGeomInput(id) {
  persistOpsGeom();
  syncOpsDependentFields();
  updateOpsGeomSum();
}

function opsGeomBoundBit(g) {
  const name = String(g.label || g.id || '').toLowerCase();
  if (!opsGeomHasBounds(g)) {
    const inp = document.getElementById('opsG_' + g.id);
    const n = inp ? inp.value : '';
    const unit = opsGeomRowUnit(g.id);
    return name + ' ' + n + (unit === 'ticks' ? 't' : '%');
  }
  const minEl = document.getElementById('opsG_' + g.id + '_min');
  const maxEl = document.getElementById('opsG_' + g.id + '_max');
  const a = String((minEl && minEl.value) || '').trim();
  const b = String((maxEl && maxEl.value) || '').trim();
  const unit = opsGeomRowUnit(g.id) === 'ticks' ? 't' : '%';
  if (a === '' && b === '') return name + ' book';
  if (a !== '' && b !== '' && Number(a) === Number(b)) return name + ' ' + a + unit;
  if (a !== '' && b === '') return name + ' ≥' + a + unit;
  if (a === '' && b !== '') return name + ' ≤' + b + unit;
  return name + ' ' + a + '–' + b + unit;
}

function updateOpsGeomSum() {
  const el = document.getElementById('opsGeomSum');
  if (!el) return;
  el.classList.remove('is-note');
  const bits = opsGeomLens().map(opsGeomBoundBit);
  const mult = (document.getElementById('opsP_STEP_MULT') || {}).value;
  if (mult) bits.push('×' + mult);
  el.textContent = bits.join(' · ');
}

function renderOpsGeom() {
  const lens = opsGeomLens();
  if (!lens.length) return '';
  const saved = opsGeomState();
  const spec = opsGeomParam() || {};
  const hint = spec.hint || 'Min and max per edge. Blank follows the book. Same min and max locks that value.';
  const multId = opsGeomMultLens();
  const mult = opsMultParam();
  const rows = lens.map(g => {
    const st = saved[g.id] || {};
    const hasBound = opsGeomHasBounds(g);
    const unit = st.unit === 'ticks' ? 'ticks' : 'pct';
    const hasMult = g.id === multId;
    let extra = '';
    if (hasMult) {
      extra += '<div class="rp-ops-len-mult" title="How the step grows down the ladder">' +
        '<select id="opsP_STEP_MULT" aria-label="Step ×" onchange="updateOpsGeomSum()">' +
        opsSelectOptions(mult) + '</select></div>';
    }
    const tickMin = g.allow_zero ? '0' : '0';
    if (!hasBound) {
      const pct = st.pct != null && st.pct !== '' ? st.pct : g.pct_default;
      const ticks = st.ticks != null && st.ticks !== '' ? st.ticks : g.ticks_default;
      const val = unit === 'ticks' ? ticks : pct;
      return '<div class="rp-ops-len' + (hasMult ? ' has-mult' : '') + '" data-geom="' + escHtml(g.id) +
        '" data-pct="' + escHtml(pct) + '" data-ticks="' + escHtml(ticks) + '">' +
        '<span class="rp-ops-len-lab">' + escHtml(g.label) + '</span>' +
        '<input id="opsG_' + escHtml(g.id) + '" type="number" min="' + (unit === 'ticks' ? (g.allow_zero ? '0' : '1') : '0') +
          '" step="' + (unit === 'ticks' ? '1' : 'any') + '" inputmode="decimal" value="' + escHtml(val) +
          '" oninput="onOpsGeomInput(\'' + escHtml(g.id) + '\')" />' +
        '<div class="rp-ops-unit" role="group" aria-label="' + escHtml(g.label) + ' unit">' +
          '<button type="button" data-unit="pct"' + (unit === 'pct' ? ' class="on"' : '') +
            ' onclick="setOpsGeomUnit(\'' + escHtml(g.id) + '\',\'pct\')">%</button>' +
          '<button type="button" data-unit="ticks"' + (unit === 'ticks' ? ' class="on"' : '') +
            ' onclick="setOpsGeomUnit(\'' + escHtml(g.id) + '\',\'ticks\')">ticks</button>' +
        '</div>' +
        extra +
        '<span class="rp-ops-len-hint">' + escHtml(g.hint || '') + '</span>' +
      '</div>';
    }
    let minPct = st.min_pct != null ? st.min_pct : '';
    let maxPct = st.max_pct != null ? st.max_pct : '';
    let minTicks = st.min_ticks != null ? st.min_ticks : '';
    let maxTicks = st.max_ticks != null ? st.max_ticks : '';
    const minVal = unit === 'ticks' ? minTicks : minPct;
    const maxVal = unit === 'ticks' ? maxTicks : maxPct;
    const mode = opsGeomModeFromVals(minVal, maxVal);
    return '<div class="rp-ops-len has-bound' + (hasMult ? ' has-mult' : '') + '" data-geom="' + escHtml(g.id) +
      '" data-mode="' + mode + '" data-min-pct="' + escHtml(minPct) + '" data-max-pct="' + escHtml(maxPct) +
      '" data-min-ticks="' + escHtml(minTicks) + '" data-max-ticks="' + escHtml(maxTicks) + '">' +
      '<span class="rp-ops-len-lab">' + escHtml(g.label) +
        '<span class="rp-ops-bound-mode">' + mode + '</span></span>' +
      '<label class="rp-ops-bound rp-ops-bound-min">' +
        '<span>min</span>' +
        '<input id="opsG_' + escHtml(g.id) + '_min" type="number" min="' + (unit === 'ticks' ? tickMin : '0') +
          '" step="' + (unit === 'ticks' ? '1' : 'any') + '" inputmode="decimal" placeholder="any" value="' + escHtml(minVal) +
          '" oninput="onOpsGeomInput(\'' + escHtml(g.id) + '\')" />' +
      '</label>' +
      '<label class="rp-ops-bound rp-ops-bound-max">' +
        '<span>max</span>' +
        '<input id="opsG_' + escHtml(g.id) + '_max" type="number" min="' + (unit === 'ticks' ? tickMin : '0') +
          '" step="' + (unit === 'ticks' ? '1' : 'any') + '" inputmode="decimal" placeholder="any" value="' + escHtml(maxVal) +
          '" oninput="onOpsGeomInput(\'' + escHtml(g.id) + '\')" />' +
      '</label>' +
      '<div class="rp-ops-unit" role="group" aria-label="' + escHtml(g.label) + ' unit">' +
        '<button type="button" data-unit="pct"' + (unit === 'pct' ? ' class="on"' : '') +
          ' onclick="setOpsGeomUnit(\'' + escHtml(g.id) + '\',\'pct\')">%</button>' +
        '<button type="button" data-unit="ticks"' + (unit === 'ticks' ? ' class="on"' : '') +
          ' onclick="setOpsGeomUnit(\'' + escHtml(g.id) + '\',\'ticks\')">ticks</button>' +
      '</div>' +
      extra +
      '<span class="rp-ops-len-hint">' + escHtml(g.hint || '') + '</span>' +
    '</div>';
  }).join('');
  return '<div class="rp-ops-geom" id="opsGeom">' +
    '<p class="rp-ops-hint">' + escHtml(hint) + '</p>' +
    rows +
    '<div class="rp-ops-geom-sum" id="opsGeomSum"></div>' +
    '<div class="rp-ops-geom-live" id="opsGeomLive"></div>' +
    '</div>';
}

function opsSelectOptions(p) {
  return (p.options || []).map(o => {
    const val = (o && typeof o === 'object') ? (o.value != null ? o.value : o.id) : o;
    const lab = (o && typeof o === 'object') ? (o.label || o.value || o.id) : o;
    const sel = String(val) === String(p.default) ? ' selected' : '';
    return '<option value="' + escHtml(val) + '"' + sel + '>' + escHtml(lab) + '</option>';
  }).join('');
}

function opsMaxParam() {
  return ((opsStrategySpec().params) || []).find(p => p.type === 'max') || null;
}

function opsMaxUnit() {
  const btn = document.querySelector('#opsMax .rp-ops-unit button.on');
  const p = opsMaxParam();
  return (btn && btn.getAttribute('data-unit')) || (p && p.unit) || 'usd';
}

function setOpsMaxUnit(unit) {
  const row = document.getElementById('opsMax');
  if (!row || !unit) return;
  row.querySelectorAll('.rp-ops-unit button').forEach(b => {
    b.classList.toggle('on', b.getAttribute('data-unit') === unit);
  });
  if (!opsEdit && typeof lsSet === 'function') lsSet('opadash.opsMaxUnit', unit);
}

function applyOpsMaxUnitDefault() {
  if (opsEdit) return;
  const p = opsMaxParam();
  if (!p) return;
  const saved = (typeof lsGet === 'function') ? lsGet('opadash.opsMaxUnit', '') : '';
  const unit = (saved === 'usd' || saved === 'lots') ? saved : (p.unit || 'usd');
  setOpsMaxUnit(unit);
}

function renderOpsMax(p) {
  const unit = p.unit === 'lots' ? 'lots' : 'usd';
  const units = Array.isArray(p.units) && p.units.length
    ? p.units
    : [{ id: 'usd', label: 'USD' }, { id: 'lots', label: 'lots' }];
  const btns = units.map(u => {
    const id = (u && typeof u === 'object') ? (u.id || u.value) : u;
    const lab = (u && typeof u === 'object') ? (u.label || u.id) : u;
    return '<button type="button" data-unit="' + escHtml(id) + '"' +
      (String(id) === unit ? ' class="on"' : '') +
      ' onclick="setOpsMaxUnit(\'' + escHtml(id) + '\')">' + escHtml(lab) + '</button>';
  }).join('');
  return '<label class="rp-ops-max-wrap">' + escHtml(p.label || 'Max') +
    '<div class="rp-ops-max" id="opsMax">' +
      '<input id="opsP_MAX_POSITION" type="number" step="any" min="0" value="' +
        escHtml(p.default == null ? '' : p.default) + '" />' +
      '<div class="rp-ops-unit" role="group" aria-label="Max unit">' + btns + '</div>' +
    '</div></label>';
}

function collectOpsMax(out) {
  const p = opsMaxParam();
  if (!p) return;
  const el = document.getElementById('opsP_MAX_POSITION');
  if (!el || el.value === '' || el.value == null) return;
  const usd = opsMaxUnit() === 'usd';
  out.MAX_POSITION = el.value;
  out.MAX_IN_USD = usd;
  if (opsEdit) {
    if (usd) out.max_usd = el.value;
    else out.max_pos = el.value;
  }
}

function renderOpsParam(p) {
  if (p.embed) return '';
  if (p.launch_only && opsEdit) return '';
  if (p.key === 'STEP_MULT' && opsGeomMultLens()) return '';
  if (p.type === 'geom') return renderOpsGeom();
  if (p.type === 'max') return renderOpsMax(p);
  const id = 'opsP_' + p.key;
  const extraCls = (p.wide ? ' rp-ops-wide' : '');
  const cond = [];
  if (Array.isArray(p.show_if_any) && p.show_if_any.length) {
    cond.push('data-show-if="' + escHtml(p.show_if_any.join(',')) + '"');
  }
  if (Array.isArray(p.hide_if_any) && p.hide_if_any.length) {
    cond.push('data-hide-if="' + escHtml(p.hide_if_any.join(',')) + '"');
  }
  const showIf = cond.length ? ' ' + cond.join(' ') : '';
  const title = p.hint ? ' title="' + escHtml(p.hint) + '"' : '';
  if (p.type === 'bool') {
    const on = p.default === true || p.default === 'true';
    return '<label class="rp-ops-check' + extraCls + '"' + showIf + title + '>' +
      '<input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + ' onchange="syncOpsDependentFields()" /> ' +
      escHtml(p.label) + '</label>';
  }
  const cls = extraCls.trim() ? ' class="' + extraCls.trim() + '"' : '';
  if (p.type === 'select') {
    return '<label' + cls + showIf + title + '>' + escHtml(p.label) +
      '<select id="' + id + '" onchange="updateOpsGeomSum();syncOpsDependentFields()">' +
      opsSelectOptions(p) + '</select></label>';
  }
  if (p.type === 'text') {
    return '<label' + cls + showIf + title + '>' + escHtml(p.label) +
      '<input id="' + id + '" type="text" autocomplete="off" value="' +
      escHtml(p.default == null ? '' : p.default) + '"' + title + ' /></label>';
  }
  const step = p.type === 'int' ? '1' : 'any';
  const min = p.min != null ? ' min="' + escHtml(String(p.min)) + '"' : '';
  return '<label' + cls + showIf + title + '>' + escHtml(p.label) +
    '<input id="' + id + '" type="number" step="' + step + '"' + min + title +
      ' value="' + escHtml(p.default == null ? '' : p.default) + '" /></label>';
}

function syncOpsDependentFields() {
  document.querySelectorAll('#opsParams [data-show-if]').forEach(el => {
    const keys = (el.getAttribute('data-show-if') || '').split(',').map(s => s.trim()).filter(Boolean);
    el.hidden = keys.length ? !keys.some(opsFlagOn) : false;
  });
  document.querySelectorAll('#opsParams [data-hide-if]').forEach(el => {
    const keys = (el.getAttribute('data-hide-if') || '').split(',').map(s => s.trim()).filter(Boolean);
    el.hidden = keys.length ? keys.some(opsFlagOn) : false;
  });
  syncOpsFitLock();
  updateOpsGeomSum();
}

function opsFitAutoOn() {
  return opsGeomLens().some(g => opsGeomHasBounds(g) && opsGeomFollows(g.id));
}

function syncOpsFitLock() {
  opsGeomLens().forEach(g => {
    const row = document.querySelector('#opsGeom [data-geom="' + g.id + '"]');
    if (!row) return;
    const bounded = opsGeomHasBounds(g);
    const mode = bounded ? opsGeomMode(g.id) : '';
    row.classList.toggle('is-follow', bounded && mode !== 'lock');
    row.classList.toggle('is-lock', bounded && mode === 'lock');
    if (mode) row.setAttribute('data-mode', mode);
    else row.removeAttribute('data-mode');
    const badge = row.querySelector('.rp-ops-bound-mode');
    if (badge) badge.textContent = mode || '';
  });
  const geom = document.getElementById('opsGeom');
  if (geom) geom.classList.toggle('is-fit-lock', false);
  paintOpsGeomLive();
}

function opsLiveSetup() {
  if (!opsEdit) return null;
  if (typeof currentRpnlRow === 'function') {
    const row = currentRpnlRow();
    const s = row && row.settings;
    if (s && (!opsEdit.account || !row.account || row.account === opsEdit.account)) {
      const c = opsEdit.contract || opsEdit.qsym;
      const rc = row.contract || row.quote_symbol;
      if (!c || rc === c || row.quote_symbol === opsEdit.qsym) return s;
    }
  }
  return opsEdit.settings || null;
}

function opsFmtKnob(v) {
  const n = Number(v);
  if (!isFinite(n)) return String(v);
  const s = Math.abs(n) >= 10 ? n.toFixed(2) : n.toFixed(4);
  return s.replace(/\.?0+$/, '');
}

function opsGeomLiveBits(s) {
  if (!s) return [];
  if (s.geom) return String(s.geom).split(' · ').map(b => String(b || '').trim()).filter(Boolean);
  return opsGeomLens().map(g => {
    const ticksKey = g.id === 'k' ? 'k_ticks' : (g.id === 'tail' ? 'step_ticks' : g.id + '_ticks');
    const pctKey = g.id === 'k' ? 'k' : (g.id === 'tail' ? 'step' : g.id);
    const ticks = s[ticksKey] != null ? s[ticksKey] : s[g.id + '_ticks'];
    const pct = s[pctKey] != null ? s[pctKey] : s[g.id];
    const useTicks = ticks != null && Number(ticks) > 0;
    const n = useTicks ? ticks : pct;
    if (n == null || n === '') return '';
    return g.label.toLowerCase() + ' ' + opsFmtKnob(n) + (useTicks ? 't' : '%');
  }).filter(Boolean);
}

function applyLiveToGeomInputs(s) {
  if (!s) return;
  updateOpsGeomSum();
}

function paintOpsGeomLive() {
  const el = document.getElementById('opsGeomLive');
  if (!el) return;
  const s = opsLiveSetup();
  const bits = opsGeomLiveBits(s);
  if (opsEdit && bits.length) {
    el.innerHTML = '<b>Current live</b>  ' + escHtml(bits.join(' · '));
    applyLiveToGeomInputs(s);
    updateOpsGeomSum();
    return;
  }
  el.textContent = '';
  updateOpsGeomSum();
}

function refreshOpsLiveGeom() {
  const box = document.getElementById('rpOps');
  if (!box || box.hidden || !opsEdit) return;
  const row = typeof currentRpnlRow === 'function' ? currentRpnlRow() : null;
  if (row && row.settings) opsEdit.settings = row.settings;
  paintOpsGeomLive();
}

const OPS_GLOSS = {
  ORDERS: 'How many quotes hang on each side.',
  HOOK: 'What the ladder hangs off — position, liquidity, bid, or ask.',
  STEP_MULT: 'How the step grows down the ladder. Lives on the Step row.',
  TOUCH_TICKS: 'How far inside the BBO when span follows the book. 0 joins the touch.',
  FATE_USD: 'Pause if rPnL drops this far from the peak.',
  GRIND_USD: 'Pause if window rPnL is this negative.',
  VOL_GATE: 'Only quote while the tape is busy.',
  DRY_RUN: 'Log quotes. Do not send orders.',
  QUOTE_MS: 'Minimum milliseconds between edits of the same order.',
  PLACE_SECS: 'After a full fill, wait this long before quoting that rung again.',
  IGNORE_MIN_SIZE: 'Skip book levels smaller than this USD notional.',
  PAIR_HEDGE: 'Hedge option delta with the perpetual.',
  PAIR_HEDGE_LOT: 'Minimum contracts off-target before a hedge order.',
  PACKET: 'Contracts in each bid and ask.',
  SHELF: 'Largest long or short the counter may hold.',
  COVER_PCT: 'CoinDCX hedge as a percent of the counter. 0 turns it off.',
  STOCKROOM: 'CoinDCX symbol for that hedge. Applied when the bot starts.',
  WINDOW: 'Price off the stockroom, but do not send hedge orders.',
  EXIT_PCT: 'Buy the wing back at least this far under the entry.',
  OTM_PCT: 'Minimum distance from spot when picking the call and put.',
  MAX_COIN: 'Underlying coin shared by the wings. 1 is 1 BTC, ETH, or XAUT.',
  MAX_POSITION: 'Position cap. USD is notional; a plain number on Arb is the shot size.',
  FIELDS: 'How many of the busiest options to bid.',
  BASKET: 'Contracts in each field bid.',
  SILO: 'Most contracts one field may hold. 0 means no cap.',
  FENCE: 'Hedge the option delta with the crop perpetual.',
  FENCE_PCT: 'Share of option delta the perpetual takes.',
  FENCE_LOT: 'Smallest hedge order, in perpetual contracts.',
  BID_TICKS: 'How many ticks above the bid you buy. 0 joins the bid.',
  ASK_TICKS: 'How many ticks under the ask you sell. 0 joins the ask.',
  CHUNKS: 'How many pieces to peel on a green close. 0 uses Orders.',
  EQUAL: 'On makes every rung the same size. Off restores the doubling ladder.',
  COVER_QUOTES: 'Keep maker cover quotes while inventoried. Off means the clip is the exit.',
  CLIP_MIN_PCT: 'Do not clip until the move is at least this percent. 0 is off.',
  CLIP_MIN_USD: 'Do not clip until the gain is at least this many dollars. 0 is off.',
  CLIP_COOL_SECS: 'Wait this long after a clip before the next one.',
  FLOW_SKEW: 'Buy-heavy tape grows buys. Negative fades the crowd.',
  FLOW_MIN: 'Floor on the quiet side, as a fraction of the base size.',
  FLOW_WINDOW_SECS: 'How far back the tape is read for the flow skew.',
  FLOW_MIN_TRADES: 'Prints required in that window before the skew counts.',
  TAKE: 'Market-flatten a green position. Off leaves the exit to the ladder.',
  TAKE_PCT: 'Flatten when profit vs entry is at least this percent. 0 can mean one tick.',
  TAKE_USD: 'Flatten when profit is at least this many dollars. 0 is off.',
  TAKE_COOL_SECS: 'Wait this long after a take before the next one.',
  FLIP: 'Reverse when the position is too red, or take the other side of a burst.',
  FLIP_LOSS_INR: 'Reverse once unrealized loss is at least this many rupees.',
  FLIP_HOLD_SECS: 'Stay in the flipped position at least this long.',
  FLIP_COOL_SECS: 'Wait this long after a flip before another one.',
  MOM_PCT: 'Fast burst, in percent, that starts the ride.',
  MOM_SLOW_PCT: 'Slower move, in percent, that confirms the burst.',
  CLIP_PCT: 'Share of the max size taken on the burst.',
  TRAIL_PCT: 'Give back this percent from the high before exiting.',
  MOM_STOP_PCT: 'Hard stop, in percent, against the entry.',
  MOVE_PCT: 'Price move, in percent, that arms the surge.',
  MOVE_SECS: 'The move must happen inside this many seconds.',
  RISK_REWARD: 'Take-profit distance as a multiple of the stop. 2 is 1:2.',
  EDGE_VENUE: 'Book the quotes are priced against. Orders stay on the selected exchange.',
  EDGE_PCT: 'How far inside the reference book the first quote sits.',
  STEP_AUTO: 'Fit the step from the live spread. Off uses Step % as typed.',
  STEP_PCT: 'Gap between rungs when Fit step is off.',
  ARB_VENUE: 'Second venue. Restart to change it. Uses that venue’s key from this OPADash service or Balances, not this subaccount.',
  ARB_SYMBOL: 'Symbol on the other venue. Blank maps the coin (Coinbase → ROOT-PERP). Restart to change it.',
  ARB_MIN_PCT: 'Fire when the gap, after the fee haircut, is at least this percent.',
  ARB_FEE_PCT: 'Taker haircut taken off the gross gap. 0.10 is both legs.',
  ARB_COOL_SECS: 'Wait after a shot before the next one.',
  LOT: 'CoinDCX units per counter contract.',
  AISLE_PCT: 'Minimum bid–ask gap before a quote.',
  STEP: 'Extra ticks off the counter book.',
  REACH: 'How many ticks a quote may walk to keep its edge.',
  PACE_MS: 'Minimum milliseconds between edits of the same order.',
  DUST: 'Ignore book size below this.',
  FIELD_DUST: 'Ignore option book size below this.',
  K_PCT: 'Percent offset from the touch. 0 joins the book.',
  K_TICKS: 'Tick offset from the touch. Ticks win over percent when both are set.',
};

function renderOpsGlossary() {
  const params = opsStrategySpec().params || [];
  const items = [];
  const seen = new Set();
  const add = (k, t, d) => { if (d && !seen.has(k)) { seen.add(k); items.push([t, d]); } };
  params.forEach(p => {
    if (p.embed) return;
    if (p.type === 'max') {
      add('max', p.label || 'Max', p.hint || (p.label === 'Max coin'
        ? 'Underlying coin cap (2 = 2 of the coin), not USD.'
        : 'Inventory cap. USD is notional; lots are venue contracts.'));
      return;
    }
    if (p.type === 'geom') {
      const lenses = p.lenses || [];
      if (lenses.indexOf('hem') >= 0) add('hem', 'Hem', 'Cover-side edge off the hook. Min/max, or blank to follow the book.');
      if (lenses.indexOf('span') >= 0) add('span', 'Span', 'Far edge, measured from the hem. Min/max, or blank to follow the book.');
      if (lenses.indexOf('step') >= 0 || lenses.indexOf('tail') >= 0) add('step', 'Step', 'First same-side gap behind an edge. Min/max, or blank to follow the book.');
      if (lenses.indexOf('k') >= 0) add('k', 'K', 'Offset from the touch. 0 joins the bid–ask.');
      add('bounds', 'Min / max', 'Blank both follows the live book. Same number locks that edge. Min only is a floor; max can be anything.');
      return;
    }
    add(p.key, p.label || p.key, p.hint || OPS_GLOSS[p.key] || '');
  });
  if (!items.length) return '';
  return '<div class="rp-ops-glossary"><div class="rp-ops-sub">What these mean</div><dl>' +
    items.map(([t, d]) => '<div><dt>' + escHtml(t) + '</dt><dd>' + escHtml(d) + '</dd></div>').join('') +
    '</dl></div>';
}

function renderOpsGroupItems(items) {
  const html = [];
  let bools = [];
  const flushBools = () => {
    if (!bools.length) return;
    html.push('<div class="rp-ops-flags">' + bools.map(renderOpsParam).join('') + '</div>');
    bools = [];
  };
  items.forEach(p => {
    if (p.embed) return;
    if (p.key === 'STEP_MULT' && opsGeomMultLens()) return;
    if (p.type === 'bool') bools.push(p);
    else {
      flushBools();
      html.push(renderOpsParam(p));
    }
  });
  flushBools();
  return html.join('');
}

function renderOpsParams() {
  const box = document.getElementById('opsParams');
  if (!box) return;
  const spec = opsStrategySpec();
  const params = spec.params || [];
    const titles = { size: 'Size', book: 'Book', geometry: 'Geometry', quote: 'Quote', pace: 'Pace', risk: 'Risk', hedge: 'Hedge', cover: 'Cover' };
  const groups = [];
  params.forEach(p => {
    const id = p.group || '';
    const last = groups[groups.length - 1];
    if (!last || last.id !== id) groups.push({ id: id, items: [p] });
    else last.items.push(p);
  });
  const blurb = spec.blurb ? '<p class="rp-ops-hint rp-ops-blurb">' + escHtml(spec.blurb) + '</p>' : '';
  box.innerHTML = blurb + groups.map(g => {
    const h = titles[g.id] ? '<div class="rp-ops-sub">' + titles[g.id] + '</div>' : '';
    return '<div class="rp-ops-group" data-ops-group="' + escHtml(g.id || '') + '">' + h +
      '<div class="rp-ops-params">' + renderOpsGroupItems(g.items) + '</div></div>';
  }).join('');
  const gloss = document.getElementById('opsGlossary');
  if (gloss) gloss.innerHTML = renderOpsGlossary();
  applyOpsMaxUnitDefault();
  updateOpsGeomSum();
  syncOpsDependentFields();
}

function collectOpsGeom(out) {
  if (!document.getElementById('opsGeom')) return;
  persistOpsGeom();
  opsGeomLens().forEach(g => {
    const prefix = opsGeomPrefix(g);
    if (!opsGeomHasBounds(g)) {
      const row = document.querySelector('#opsGeom [data-geom="' + g.id + '"]');
      const inp = document.getElementById('opsG_' + g.id);
      if (!row || !inp) return;
      const unit = opsGeomRowUnit(g.id);
      if (unit === 'ticks') {
        const t = Math.max(0, Math.round(Number(inp.value) || 0));
        out[g.ticks_key] = String(t);
        out[g.pct_key] = row.dataset.pct || g.pct_default || '0';
      } else {
        out[g.pct_key] = inp.value !== '' ? String(inp.value) : (g.pct_default || '0');
        out[g.ticks_key] = '0';
      }
      return;
    }
    const minEl = document.getElementById('opsG_' + g.id + '_min');
    const maxEl = document.getElementById('opsG_' + g.id + '_max');
    if (!minEl || !maxEl) return;
    const unit = opsGeomRowUnit(g.id);
    const minRaw = String(minEl.value || '').trim();
    const maxRaw = String(maxEl.value || '').trim();
    const minN = minRaw === '' ? 0 : Number(minRaw);
    const maxN = maxRaw === '' ? 0 : Number(maxRaw);
    const locked = minRaw !== '' && maxRaw !== '' && Number(minRaw) === Number(maxRaw);
    const autoKey = opsGeomAutoKey(g);
    if (autoKey) out[autoKey] = !locked;
    if (unit === 'ticks') {
      out[prefix + '_MIN_TICKS'] = String(minRaw === '' ? 0 : Math.max(0, Math.round(minN)));
      out[prefix + '_MAX_TICKS'] = String(maxRaw === '' ? 0 : Math.max(0, Math.round(maxN)));
      out[prefix + '_MIN_PCT'] = '0';
      out[prefix + '_MAX_PCT'] = '0';
      out[g.ticks_key] = locked ? String(Math.max(0, Math.round(minN))) : '0';
      out[g.pct_key] = g.pct_default || '0.1';
    } else {
      out[prefix + '_MIN_PCT'] = String(minRaw === '' ? 0 : minN);
      out[prefix + '_MAX_PCT'] = String(maxRaw === '' ? 0 : maxN);
      out[prefix + '_MIN_TICKS'] = '0';
      out[prefix + '_MAX_TICKS'] = '0';
      out[g.ticks_key] = '0';
      out[g.pct_key] = locked ? String(minN) : (g.pct_default || '0.1');
    }
  });
  const ids = opsGeomLens().map(g => g.id);
  if ((ids.indexOf('step') >= 0 || ids.indexOf('tail') >= 0) && out.STEP_TICKS != null) {
    out.TAIL_TICKS = out.STEP_TICKS;
  }
}

function validateOpsGeom() {
  if (!document.getElementById('opsGeom')) return '';
  for (const g of opsGeomLens()) {
    if (!opsGeomHasBounds(g)) {
      const inp = document.getElementById('opsG_' + g.id);
      const n = Number(inp && inp.value);
      const unit = opsGeomRowUnit(g.id);
      if (g.allow_zero) {
        if (!isFinite(n) || n < 0) return g.label + ' must be ≥ 0';
      } else if (!isFinite(n) || !(n > 0)) {
        return g.label + ' must be > 0';
      }
      if (unit === 'ticks' && n !== Math.round(n)) return g.label + ' ticks must be a whole number';
      continue;
    }
    const minEl = document.getElementById('opsG_' + g.id + '_min');
    const maxEl = document.getElementById('opsG_' + g.id + '_max');
    const a = String((minEl && minEl.value) || '').trim();
    const b = String((maxEl && maxEl.value) || '').trim();
    const unit = opsGeomRowUnit(g.id);
    if (a === '' && b === '') continue;
    const minN = a === '' ? null : Number(a);
    const maxN = b === '' ? null : Number(b);
    if (a !== '' && (!isFinite(minN) || minN < 0)) return g.label + ' min is invalid';
    if (b !== '' && (!isFinite(maxN) || maxN < 0)) return g.label + ' max is invalid';
    if (a !== '' && !(minN > 0) && !g.allow_zero) return g.label + ' min must be > 0';
    if (b !== '' && !(maxN > 0) && !g.allow_zero) return g.label + ' max must be > 0';
    if (unit === 'ticks') {
      if (a !== '' && minN !== Math.round(minN)) return g.label + ' min ticks must be a whole number';
      if (b !== '' && maxN !== Math.round(maxN)) return g.label + ' max ticks must be a whole number';
    }
    if (a !== '' && b !== '' && minN > maxN) return g.label + ' min cannot be greater than max';
  }
  return '';
}

function validateOpsParams() {
  const spec = opsStrategySpec();
  for (const p of spec.params || []) {
    if (p.type !== 'int' && p.type !== 'number' && p.type !== 'max') continue;
    const el = document.getElementById('opsP_' + p.key);
    if (!el || el.value === '' || el.value == null) continue;
    const host = el.closest('label');
    if (host && host.hidden) continue;
    const n = Number(el.value);
    if (!isFinite(n)) return p.label + ' is invalid';
    if (p.type === 'int' && n !== Math.round(n)) return p.label + ' must be a whole number';
    if ((p.type === 'max' || p.key === 'MAX_POSITION') && !(n > 0)) return p.label + ' must be > 0';
    if (p.min != null && n < Number(p.min)) return p.label + ' must be ≥ ' + p.min;
  }
  return '';
}

function collectOpsParams() {
  const spec = opsStrategySpec();
  const out = {};
  if (!opsEdit) {
    const extra = (document.getElementById('opsExtra') || {}).value || '';
    extra.split('\n').forEach(line => {
      const s = line.trim();
      if (!s || s.startsWith('#') || s.indexOf('=') < 0) return;
      const i = s.indexOf('=');
      const k = s.slice(0, i).trim().toUpperCase();
      const v = s.slice(i + 1).trim();
      if (k && v) out[k] = v;
    });
  }
  (spec.params || []).forEach(p => {
    if (p.type === 'geom' || p.type === 'max' || p.embed) return;
    const el = document.getElementById('opsP_' + p.key);
    if (!el) return;
    const host = el.closest('label');
    if (host && host.hidden) {
      if (p.type === 'bool') out[p.key] = false;
      return;
    }
    if (p.type === 'bool') out[p.key] = !!el.checked;
    else if (el.value !== '' && el.value != null) out[p.key] = el.value;
  });
  collectOpsMax(out);
  collectOpsGeom(out);
  const mult = document.getElementById('opsP_STEP_MULT');
  if (mult && mult.value) out.STEP_MULT = mult.value;
  return out;
}

function setOpsMsg(id, text, err) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('err', !!err);
}

function opsBool(v) {
  return v === true || v === 'true' || v === 'on' || v === 1 || v === '1';
}

function fillOpsFromSetup(s) {
  s = s || {};
  const setNum = (id, v) => {
    const el = document.getElementById(id);
    if (!el || v == null || v === '') return;
    el.value = String(v);
  };
  const setChk = (id, v, present) => {
    const el = document.getElementById(id);
    if (!el || present === false) return;
    el.checked = opsBool(v);
  };
  const setSel = (id, v) => {
    const el = document.getElementById(id);
    if (!el || v == null || v === '') return;
    const t = String(v);
    if ([...el.options].some(o => o.value === t)) el.value = t;
  };
  if (s.max_usd != null) {
    setNum('opsP_MAX_POSITION', s.max_usd);
    setOpsMaxUnit('usd');
  } else if (s.max_pos != null) {
    setNum('opsP_MAX_POSITION', s.max_pos);
    setOpsMaxUnit('lots');
  }
  setNum('opsP_ORDERS', s.orders);
  setSel('opsP_HOOK', s.hook);
  setSel('opsP_STEP_MULT', s.step_mult);
  if (s.step_auto != null) setChk('opsP_STEP_AUTO', s.step_auto, true);
  else if (s.fit_auto != null) setChk('opsP_STEP_AUTO', s.fit_auto, true);
  if (s.vol_gate != null) setChk('opsP_VOL_GATE', s.vol_gate, true);
  setNum('opsP_FATE_USD', s.fate);
  setNum('opsP_GRIND_USD', s.grind);
  if (s.dry_run != null) setChk('opsP_DRY_RUN', s.dry_run, true);
  setNum('opsP_QUOTE_MS', s.quote_ms);
  setNum('opsP_PLACE_SECS', s.place_secs);
  setNum('opsP_IGNORE_MIN_SIZE', s.ignore);
  setNum('opsP_BID_TICKS', s.bid_ticks);
  setNum('opsP_ASK_TICKS', s.ask_ticks);
  setNum('opsP_STEP_PCT', s.step);
  setNum('opsP_TOUCH_TICKS', s.touch_ticks);
  setNum('opsP_EDGE_PCT', s.edge);
  setSel('opsP_EDGE_VENUE', s.edge_venue);
  setSel('opsP_ARB_VENUE', s.arb_venue);
  setNum('opsP_ARB_MIN_PCT', s.min_edge);
  setNum('opsP_ARB_FEE_PCT', s.fee);
  setNum('opsP_ARB_COOL_SECS', s.cool);
  if (s.arb_symbol) {
    const sym = document.getElementById('opsP_ARB_SYMBOL');
    if (sym) sym.value = String(s.arb_symbol);
  }
  setNum('opsP_MOVE_PCT', s.move_pct);
  setNum('opsP_MOVE_SECS', s.move_secs);
  setNum('opsP_RISK_REWARD', s.risk_reward);
  setNum('opsP_MOM_PCT', s.mom_pct);
  setNum('opsP_MOM_SLOW_PCT', s.mom_slow_pct);
  setNum('opsP_CLIP_PCT', s.clip_pct);
  setNum('opsP_TRAIL_PCT', s.trail_pct);
  setNum('opsP_MOM_STOP_PCT', s.mom_stop_pct);
  if (s.flip != null) setChk('opsP_FLIP', s.flip, true);
  setNum('opsP_CHUNKS', s.chunks);
  if (s.equal != null) setChk('opsP_EQUAL', s.equal, true);
  if (s.cover_quotes != null) setChk('opsP_COVER_QUOTES', s.cover_quotes, true);
  setNum('opsP_CLIP_MIN_PCT', s.clip_min_pct);
  setNum('opsP_CLIP_MIN_USD', s.clip_min_usd);
  setNum('opsP_CLIP_COOL_SECS', s.clip_cool);
  setNum('opsP_FLOW_SKEW', s.flow_skew);
  setNum('opsP_FLOW_MIN', s.flow_min);
  setNum('opsP_FLOW_WINDOW_SECS', s.flow_window);
  setNum('opsP_FLOW_MIN_TRADES', s.flow_prints);
  setNum('opsP_TAKE_PCT', s.take_pct);
  setNum('opsP_TAKE_USD', s.take_usd);
  setNum('opsP_TAKE_COOL_SECS', s.take_cool);
  if (s.take != null) setChk('opsP_TAKE', s.take, true);
  setNum('opsP_FLIP_LOSS_INR', s.flip_loss_inr);
  setNum('opsP_FLIP_HOLD_SECS', s.flip_hold_secs);
  setNum('opsP_FLIP_COOL_SECS', s.flip_cool_secs);
  if (s.tails != null) setNum('opsP_TAILS', s.tails);
  if (s.pair_hedge != null) setChk('opsP_PAIR_HEDGE', s.pair_hedge, true);
  else if (s.hedge_via) setChk('opsP_PAIR_HEDGE', true, true);
  else if (opsEdit && opsEdit.strategy === 'pair') setChk('opsP_PAIR_HEDGE', false, true);
  if (s.hedge_lot != null) setNum('opsP_PAIR_HEDGE_LOT', s.hedge_lot);
  setNum('opsP_PACKET', s.packet);
  setNum('opsP_SHELF', s.shelf);
  setNum('opsP_AISLE_PCT', s.aisle);
  setNum('opsP_COVER_PCT', s.cover);
  setNum('opsP_STEP', s.shop_step);
  setNum('opsP_REACH', s.reach);
  setNum('opsP_PACE_MS', s.pace_ms);
  setNum('opsP_DUST', s.dust);
  setNum('opsP_LOT', s.lot);
  setNum('opsP_EXIT_PCT', s.exit);
  setNum('opsP_OTM_PCT', s.otm);
  setNum('opsP_MAX_COIN', s.max_coin);
  setNum('opsP_FIELDS', s.fields);
  setNum('opsP_BASKET', s.basket);
  setNum('opsP_SILO', s.silo);
  setNum('opsP_FENCE_PCT', s.fence_pct);
  setNum('opsP_FENCE_LOT', s.fence_lot);
  setNum('opsP_FIELD_DUST', s.dust);
  if (s.window != null) setChk('opsP_WINDOW', s.window, true);
  if (s.fence != null) setChk('opsP_FENCE', s.fence, true);
  const setText = (id, v) => {
    const el = document.getElementById(id);
    if (!el || v == null || v === '') return;
    el.value = String(v);
  };
  setText('opsP_STOCKROOM', s.stockroom);
  setText('opsP_CROP', s.crop);
  setText('opsP_EXPIRY', s.expiry);
  fillOpsClock(s);
  opsGeomLens().forEach(g => {
    const ticksKey = g.id === 'k' ? 'k_ticks' : (g.id === 'tail' ? 'step_ticks' : g.id + '_ticks');
    const pctKey = g.id === 'k' ? 'k' : (g.id === 'tail' ? 'step' : g.id);
    const ticks = s[ticksKey] != null ? s[ticksKey] : s[g.id + '_ticks'];
    const pct = s[pctKey] != null ? s[pctKey] : s[g.id];
    const row = document.querySelector('#opsGeom [data-geom="' + g.id + '"]');
    if (!row) return;
    if (!opsGeomHasBounds(g)) {
      const inp = document.getElementById('opsG_' + g.id);
      if (!inp) return;
      if (pct != null && pct !== '') row.dataset.pct = String(pct);
      if (ticks != null && ticks !== '') row.dataset.ticks = String(ticks);
      const useTicks = ticks != null && Number(ticks) > 0;
      row.querySelectorAll('.rp-ops-unit:not(.rp-ops-len-mode) button').forEach(b => {
        b.classList.toggle('on', b.getAttribute('data-unit') === (useTicks ? 'ticks' : 'pct'));
      });
      inp.step = useTicks ? '1' : 'any';
      inp.min = useTicks ? (g.allow_zero ? '0' : '1') : '0';
      inp.value = useTicks ? String(ticks) : (pct != null && pct !== '' ? String(pct) : inp.value);
      return;
    }
    const minEl = document.getElementById('opsG_' + g.id + '_min');
    const maxEl = document.getElementById('opsG_' + g.id + '_max');
    if (!minEl || !maxEl) return;
    const minT = s[g.id + '_min_ticks'];
    const maxT = s[g.id + '_max_ticks'];
    const minP = s[g.id + '_min'];
    const maxP = s[g.id + '_max'];
    const hasNew = minT != null || maxT != null || minP != null || maxP != null;
    let auto = s[g.id + '_auto'];
    if (auto == null && g.id === 'step') auto = s.step_auto != null ? s.step_auto : s.fit_auto;
    if (auto == null && g.id === 'hem') auto = s.hem_auto != null ? s.hem_auto : s.fit_auto;
    if (auto == null && g.id === 'span') auto = s.span_auto != null ? s.span_auto : (s.span_spread != null ? s.span_spread : s.fit_auto);
    const follow = auto == null ? true : opsBool(auto);
    const tickLock = !follow && ticks != null && Number(ticks) > 0;
    const useTicks = (Number(minT) > 0 || Number(maxT) > 0 || tickLock) && !(Number(minP) > 0 || Number(maxP) > 0 && Number(minT) <= 0 && Number(maxT) <= 0 && !tickLock);
    row.querySelectorAll('.rp-ops-unit:not(.rp-ops-len-mode) button').forEach(b => {
      b.classList.toggle('on', b.getAttribute('data-unit') === (useTicks ? 'ticks' : 'pct'));
    });
    minEl.step = maxEl.step = useTicks ? '1' : 'any';
    minEl.min = maxEl.min = '0';
    const blankIfZero = (v) => (v == null || v === '' || Number(v) <= 0) ? '' : String(v);
    if (useTicks) {
      if (hasNew) {
        minEl.value = blankIfZero(minT);
        maxEl.value = blankIfZero(maxT);
      } else if (!follow) {
        minEl.value = String(ticks);
        maxEl.value = String(ticks);
      } else {
        minEl.value = '';
        maxEl.value = '';
      }
      row.dataset.minTicks = minEl.value;
      row.dataset.maxTicks = maxEl.value;
    } else {
      if (hasNew) {
        minEl.value = blankIfZero(minP);
        maxEl.value = blankIfZero(maxP);
      } else if (!follow) {
        minEl.value = pct != null && pct !== '' ? String(pct) : '';
        maxEl.value = minEl.value;
      } else {
        minEl.value = blankIfZero(minP);
        maxEl.value = blankIfZero(maxP);
      }
      row.dataset.minPct = minEl.value;
      row.dataset.maxPct = maxEl.value;
    }
  });
  updateOpsGeomSum();
  syncOpsDependentFields();
}

async function waitForRpnlPill(contract, account, strategy, rail) {
  waitForRpnlPill.saw = false;
  const c = String(contract || '').trim();
  const wants = [c + '::' + account + '::' + strategy, c.toUpperCase() + '::' + account + '::' + strategy];
  const sel = document.getElementById('rpnlSymbol');
  if (sel && wants[1]) {
    if (![...sel.options].some(o => o.value === wants[1])) {
      const opt = document.createElement('option');
      opt.value = wants[1];
      opt.textContent = '● ' + c.toUpperCase() + ' · starting…';
      sel.appendChild(opt);
    }
    sel.value = wants[1];
    if (typeof rpnlForceKeepSel !== 'undefined') rpnlForceKeepSel = true;
  }
  if (typeof loadRpnl === 'function') {
    try { await loadRpnl(true); } catch (e) {}
  }
  const tries = rail ? 50 : 12;
  const gap = rail ? 4000 : 2000;
  for (let i = 0; i < tries; i++) {
    await new Promise(r => setTimeout(r, gap));
    if (typeof loadRpnl === 'function') {
      try { await loadRpnl(true); } catch (e) {}
    }
    const box = document.getElementById('rpnlSymbol');
    if (!box) continue;
    const row = (typeof rpnlSummaryCache !== 'undefined' ? rpnlSummaryCache : []).find(r =>
      (typeof rpnlCanonSym === 'function' ? rpnlCanonSym(r.contract) === rpnlCanonSym(c) : String(r.contract || '').toUpperCase() === c.toUpperCase())
      && String(r.strategy || '').toLowerCase() === String(strategy || '').toLowerCase()
    );
    if (row && typeof rpnlIsBooting === 'function' && rpnlIsBooting(row)) {
      const label = typeof rpnlBootLabel === 'function' ? rpnlBootLabel(row) : 'Queued';
      if (!waitForRpnlPill.saw) {
        waitForRpnlPill.saw = true;
        toast(label.toLowerCase() + ' · ' + strategy + ' ' + c.toUpperCase(), 'ok');
      }
      if (typeof closeRpOps === 'function') closeRpOps();
      setOpsMsg('opsLaunchMsg', 'rPnL pill is up. Railway is still ' + label.toLowerCase() + '.', false);
      continue;
    }
    const hit = [...box.options].find(o =>
      wants.some(w => o.value === w || (typeof rpnlSelMatch === 'function' && rpnlSelMatch(o.value, w)))
    );
    if (row && row.live && hit && (hit.textContent || '').indexOf('starting') < 0) {
      box.value = hit.value;
      if (typeof loadRpnl === 'function') {
        try { await loadRpnl(false); } catch (e) {}
      }
      if (typeof closeRpOps === 'function') closeRpOps();
      toast('live · ' + strategy + ' ' + c.toUpperCase(), 'ok');
      return;
    }
    const left = Math.max(0, Math.round(((tries - i - 1) * gap) / 1000));
    setOpsMsg('opsLaunchMsg', 'Waiting for rPnL pill… Railway deploy can take a minute (' + left + 's left)', false);
  }
  setOpsMsg('opsLaunchMsg', 'Service created. Open rPnL after the Railway deploy goes live if the pill is not here yet.', false);
}

function collectOpsClock() {
  const on = id => !!((document.getElementById(id) || {}).checked);
  const text = id => String((document.getElementById(id) || {}).value || '').trim();
  const num = id => {
    const v = text(id);
    return v === '' ? '0' : v;
  };
  return {
    CLOCK: on('ckOn') ? 'true' : 'false',
    CLOCK_WINDOWS: text('ckWindows'),
    CLOCK_TZ: text('ckTz') || 'Asia/Kolkata',
    CLOCK_WINDDOWN_MINS: num('ckWind'),
    CLOCK_OPEN_DELAY_MINS: num('ckDelay'),
    CLOCK_ORDERS: text('ckOrders') || 'cancel',
    CLOCK_POS: text('ckPos') || 'hold',
    CLOCK_DAY_LOSS_USD: num('ckLoss'),
    CLOCK_DAY_WIN_USD: num('ckWin'),
    CLOCK_DAY_RESET: text('ckReset') || '00:00',
    CLOCK_HOLD_SECS: num('ckHold'),
    CLOCK_ARM: on('ckArm') ? 'true' : 'false',
  };
}

function opsClockError() {
  const raw = String((document.getElementById('ckWindows') || {}).value || '').trim();
  if (!raw) return '';
  const re = /^(?:([0-9][0-9,\-\s]*)\s+)?(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/;
  const timeOk = (h, mi) => (h === 24 && mi === 0) || (h >= 0 && h <= 23 && mi >= 0 && mi <= 59);
  for (const part of raw.split(';')) {
    const bit = part.trim().replace(/\s+/g, ' ');
    if (!bit) continue;
    const m = re.exec(bit);
    if (!m) return 'Window should look like 1-5 05:00-21:00';
    if (!timeOk(+m[2], +m[3]) || !timeOk(+m[4], +m[5])) return 'Clock time is out of range';
    const days = (m[1] || '').trim();
    if (!days) continue;
    for (const piece of days.split(',')) {
      const tok = piece.trim();
      if (!tok) continue;
      const ends = tok.split('-');
      if (ends.length > 2) return 'Clock days are 1-7, Monday is 1';
      for (const n of ends) {
        const d = Number(n);
        if (!Number.isInteger(d) || d < 1 || d > 7) return 'Clock days are 1-7, Monday is 1';
      }
    }
  }
  const reset = String((document.getElementById('ckReset') || {}).value || '').trim();
  if (reset && !/^\d{1,2}:\d{2}$/.test(reset)) return 'Day reset should look like 00:00';
  return '';
}

function fillOpsClock(s) {
  s = s || {};
  const setVal = (id, key, fallback) => {
    const el = document.getElementById(id);
    if (!el || !(key in s) || s[key] == null) return;
    el.value = s[key] === '' && fallback != null ? fallback : String(s[key]);
  };
  const setChk = (id, key) => {
    const el = document.getElementById(id);
    if (!el || !(key in s)) return;
    el.checked = s[key] === true || s[key] === 'true' || s[key] === 'on' || s[key] === 1 || s[key] === '1';
  };
  setChk('ckOn', 'clock_on');
  setChk('ckArm', 'clock_arm');
  setVal('ckWindows', 'clock_windows', '');
  setVal('ckTz', 'clock_tz', 'Asia/Kolkata');
  setVal('ckWind', 'clock_wind', '15');
  setVal('ckDelay', 'clock_delay', '0');
  setVal('ckOrders', 'clock_orders', 'cancel');
  setVal('ckPos', 'clock_pos', 'hold');
  setVal('ckLoss', 'clock_day_loss', '0');
  setVal('ckWin', 'clock_day_win', '0');
  setVal('ckReset', 'clock_day_reset', '00:00');
  setVal('ckHold', 'clock_hold', '0');
  const st = document.getElementById('opsClockStatus');
  if (st) {
    if (opsEdit && typeof rpnlClockStatus === 'function') st.textContent = rpnlClockStatus(s);
    else st.textContent = 'Off until you turn it on. With the clock off, the bot quotes the whole day.';
  }
  const sug = document.getElementById('opsClockSuggest');
  if (!sug) return;
  if (opsEdit && s.clock_suggest) {
    sug.hidden = false;
    sug.innerHTML = '<span>' + escHtml(s.clock_suggest_why || s.clock_suggest) +
      (s.clock_suggest_n ? ' · ' + s.clock_suggest_n + ' days' : '') +
      '</span><button type="button" class="btn" onclick="opsClockCmd(\'accept\')">Accept</button>';
  } else {
    sug.hidden = true;
    sug.innerHTML = '';
  }
}

async function opsPostClock(cmd, payload) {
  if (!opsEdit) return 'open a live contract to change the clock';
  const r = await fetch('/api/bot/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cmd: cmd,
      contract: opsEdit.contract,
      account: opsEdit.account,
      account_name: opsEdit.account_name || '',
      strategy: opsEdit.strategy,
      venue: opsEdit.venue || '',
      payload: payload || {},
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return opsErr(d, r.status);
  return waitOpsCommand(d.id);
}

async function opsClockCmd(kind) {
  if (!opsEdit) return;
  const cmds = {
    arm: ['clock_arm', { CLOCK_ARMED: 'true', armed: true }],
    disarm: ['clock_arm', { CLOCK_ARMED: 'false', armed: false }],
    open: ['clock_force', { CLOCK_OVERRIDE: 'open', override: 'open' }],
    closed: ['clock_force', { CLOCK_OVERRIDE: 'closed', override: 'closed' }],
    auto: ['clock_force', { CLOCK_OVERRIDE: 'auto', override: 'auto' }],
    skip: ['clock_skip', {}],
    accept: ['clock_accept', {}],
  };
  const hit = cmds[kind];
  if (!hit) return;
  setOpsMsg('opsLaunchMsg', 'Sending clock…', false);
  try {
    const err = await opsPostClock(hit[0], hit[1]);
    if (err) return setOpsMsg('opsLaunchMsg', err, true);
    toast('clock ' + kind + ' · ' + (opsEdit.qsym || opsEdit.contract || ''), 'ok');
    setOpsMsg('opsLaunchMsg', 'Clock updated', false);
    if (typeof loadRpnl === 'function') loadRpnl(true);
  } catch (e) {
    setOpsMsg('opsLaunchMsg', String(e), true);
  }
}

async function submitOpsLaunch() {
  if (opsEdit) return submitOpsEdit();
  const venue = opsVenue();
  const account = (document.getElementById('opsAccount') || {}).value || '';
  const contract = ((document.getElementById('opsContract') || {}).value || '').trim();
  const strategy = (document.getElementById('opsStrategy') || {}).value || '';
  if (!account) return setOpsMsg('opsLaunchMsg', 'Pick a subaccount with API keys', true);
  if (!contract) return setOpsMsg('opsLaunchMsg', 'Contract required', true);
  const geomErr = validateOpsGeom() || validateOpsParams() || opsClockError();
  if (geomErr) return setOpsMsg('opsLaunchMsg', geomErr, true);
  if ((strategy === 'pair' || strategy === 'wing' || strategy === 'harvest') && venue !== 'delta') {
    return setOpsMsg('opsLaunchMsg', strategy + ' runs on Delta', true);
  }
  if (strategy === 'shop' && venue !== 'delta' && venue !== 'aster') {
    return setOpsMsg('opsLaunchMsg', 'shop runs on Delta or Aster', true);
  }
  if (strategy === 'edge') {
    const ref = ((document.getElementById('opsP_EDGE_VENUE') || {}).value || '').toLowerCase();
    if (ref && ref === venue) return setOpsMsg('opsLaunchMsg', 'Ref venue must differ from the quoting exchange', true);
  }
  const sum = ((document.getElementById('opsGeomSum') || {}).textContent || '').trim();
  const line = strategy + ' · ' + venue + ':' + contract + (sum ? '\n' + sum : '');
  if (!confirm('Start ' + line + '?')) return;
  const btn = document.getElementById('opsLaunchBtn');
  if (btn) btn.disabled = true;
  setOpsMsg('opsLaunchMsg', 'Starting…', false);
  try {
    const r = await fetch('/api/ops/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ venue, account, contract, strategy, params: Object.assign(collectOpsParams(), collectOpsClock()) }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setOpsMsg('opsLaunchMsg', opsErr(d, r.status), true);
      return;
    }
    const bot = d.bot || {};
    const rail = bot.kind === 'railway' || (opsCatalog && opsCatalog.launch === 'railway');
    setOpsMsg('opsLaunchMsg', rail
      ? ('Railway service ' + (bot.service || bot.id || '') + ' — waiting for the rPnL pill…')
      : ('Started pid ' + (bot.pid || '') + ' — waiting for the rPnL pill…'), false);
    toast('started ' + strategy + ' ' + contract, 'ok');
    await refreshOpsBots();
    waitForRpnlPill(contract, account, strategy, rail);
  } catch (e) {
    setOpsMsg('opsLaunchMsg', String(e), true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function opsRememberEdit(payload) {
  if (!opsEdit || !payload) return;
  const s = Object.assign({}, opsEdit.settings || {});
  const num = (key, dst) => {
    if (payload[key] == null || payload[key] === '') return;
    const n = Number(payload[key]);
    if (isFinite(n)) s[dst] = n;
  };
  const bit = (key, dst) => { if (key in payload) s[dst] = !!payload[key]; };
  bit('HEM_AUTO', 'hem_auto');
  bit('SPAN_AUTO', 'span_auto');
  bit('STEP_AUTO', 'step_auto');
  bit('VOL_GATE', 'vol_gate');
  bit('DRY_RUN', 'dry_run');
  bit('PAIR_HEDGE', 'pair_hedge');
  bit('FLIP', 'flip');
  bit('WINDOW', 'window');
  bit('FENCE', 'fence');
  num('HEM_TICKS', 'hem_ticks');
  num('SPAN_TICKS', 'span_ticks');
  num('STEP_TICKS', 'step_ticks');
  num('K_TICKS', 'k_ticks');
  num('HEM_PCT', 'hem');
  num('SPAN_PCT', 'span');
  num('STEP_PCT', 'step');
  num('K_PCT', 'k');
  num('HEM_MIN_PCT', 'hem_min');
  num('HEM_MAX_PCT', 'hem_max');
  num('SPAN_MIN_PCT', 'span_min');
  num('SPAN_MAX_PCT', 'span_max');
  num('STEP_MIN_PCT', 'step_min');
  num('STEP_MAX_PCT', 'step_max');
  num('HEM_MIN_TICKS', 'hem_min_ticks');
  num('HEM_MAX_TICKS', 'hem_max_ticks');
  num('SPAN_MIN_TICKS', 'span_min_ticks');
  num('SPAN_MAX_TICKS', 'span_max_ticks');
  num('STEP_MIN_TICKS', 'step_min_ticks');
  num('STEP_MAX_TICKS', 'step_max_ticks');
  num('EDGE_PCT', 'edge');
  num('ORDERS', 'orders');
  num('TAILS', 'tails');
  num('TOUCH_TICKS', 'touch_ticks');
  num('BID_TICKS', 'bid_ticks');
  num('ASK_TICKS', 'ask_ticks');
  num('FATE_USD', 'fate');
  num('GRIND_USD', 'grind');
  num('QUOTE_MS', 'quote_ms');
  num('PLACE_SECS', 'place_secs');
  num('IGNORE_MIN_SIZE', 'ignore');
  num('PAIR_HEDGE_LOT', 'hedge_lot');
  num('PACKET', 'packet');
  num('SHELF', 'shelf');
  num('AISLE_PCT', 'aisle');
  num('COVER_PCT', 'cover');
  num('STEP', 'shop_step');
  num('REACH', 'reach');
  num('PACE_MS', 'pace_ms');
  num('DUST', 'dust');
  num('LOT', 'lot');
  num('EXIT_PCT', 'exit');
  num('OTM_PCT', 'otm');
  num('MAX_COIN', 'max_coin');
  num('FIELDS', 'fields');
  num('BASKET', 'basket');
  num('SILO', 'silo');
  num('FENCE_PCT', 'fence_pct');
  num('FENCE_LOT', 'fence_lot');
  num('FIELD_DUST', 'dust');
  if (payload.STOCKROOM) s.stockroom = String(payload.STOCKROOM);
  if (payload.CROP) s.crop = String(payload.CROP);
  if (payload.EXPIRY) s.expiry = String(payload.EXPIRY);
  if (payload.HOOK) s.hook = String(payload.HOOK);
  if (payload.STEP_MULT != null && payload.STEP_MULT !== '') s.step_mult = payload.STEP_MULT;
  if (payload.EDGE_VENUE) s.edge_venue = String(payload.EDGE_VENUE);
  if (payload.ARB_VENUE) s.arb_venue = String(payload.ARB_VENUE);
  if (payload.ARB_SYMBOL) s.arb_symbol = String(payload.ARB_SYMBOL);
  num('ARB_MIN_PCT', 'min_edge');
  num('ARB_FEE_PCT', 'fee');
  num('ARB_COOL_SECS', 'cool');
  if (payload.max_usd != null) {
    s.max_usd = Number(payload.max_usd);
    delete s.max_pos;
  } else if (payload.max_pos != null) {
    s.max_pos = Number(payload.max_pos);
    delete s.max_usd;
  }
  if (Number(s.hem_min_ticks) > 0 && Number(s.hem_max_ticks) > 0 && Number(s.hem_min_ticks) === Number(s.hem_max_ticks)) s.hem_auto = false;
  if (Number(s.span_min_ticks) > 0 && Number(s.span_max_ticks) > 0 && Number(s.span_min_ticks) === Number(s.span_max_ticks)) s.span_auto = false;
  if (Number(s.step_min_ticks) > 0 && Number(s.step_max_ticks) > 0 && Number(s.step_min_ticks) === Number(s.step_max_ticks)) s.step_auto = false;
  opsEdit.settings = s;
  if (typeof currentRpnlRow === 'function') {
    const row = currentRpnlRow();
    if (row) row.settings = Object.assign({}, row.settings || {}, s);
  }
}

async function waitOpsCommand(id) {
  if (!id) return '';
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 300));
    try {
      const r = await fetch('/api/bot/command/' + encodeURIComponent(id));
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return '';
      if (d.status === 'done') return '';
      if (d.status === 'error') return d.error || 'bot rejected the change';
    } catch (e) {
      return '';
    }
  }
  return 'bot has not confirmed yet — reopen edit in a few seconds';
}

async function submitOpsEdit() {
  if (!opsEdit) return;
  const geomErr = validateOpsGeom() || validateOpsParams() || opsClockError();
  if (geomErr) return setOpsMsg('opsLaunchMsg', geomErr, true);
  const payload = collectOpsParams();
  const clock = collectOpsClock();
  const btn = document.getElementById('opsLaunchBtn');
  if (btn) btn.disabled = true;
  setOpsMsg('opsLaunchMsg', 'Applying…', false);
  const name = opsEdit.qsym || opsEdit.contract;
  try {
    const r = await fetch('/api/bot/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cmd: 'setup',
        contract: opsEdit.contract,
        account: opsEdit.account,
        account_name: opsEdit.account_name || '',
        strategy: opsEdit.strategy,
        venue: opsEdit.venue || '',
        payload,
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setOpsMsg('opsLaunchMsg', opsErr(d, r.status), true);
      return;
    }
    setOpsMsg('opsLaunchMsg', 'Waiting for the bot…', false);
    const err = await waitOpsCommand(d.id);
    if (err) {
      setOpsMsg('opsLaunchMsg', err, true);
      return;
    }
    opsRememberEdit(payload);
    setOpsMsg('opsLaunchMsg', 'Applying clock…', false);
    const clockErr = await opsPostClock('clock', clock);
    if (clockErr) {
      setOpsMsg('opsLaunchMsg', clockErr, true);
      return;
    }
    if (d.persist_error) {
      toast('updated ' + name + ' live, env save failed', 'err');
      setOpsMsg('opsLaunchMsg', d.persist_error, true);
      return;
    }
    toast('updated ' + name + ' · saved to env', 'ok');
    closeRpOps();
    if (typeof loadRpnl === 'function') loadRpnl(true);
  } catch (e) {
    setOpsMsg('opsLaunchMsg', String(e), true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function opsBotForEdit() {
  if (!opsEdit) return null;
  const norm = v => String(v || '').toUpperCase().replace(/[-_]/g, '');
  const want = [norm(opsEdit.contract), norm(opsEdit.qsym)].filter(Boolean);
  const strat = String(opsEdit.strategy || '').toLowerCase();
  const tags = [opsEdit.account, opsEdit.account_name].map(v => String(v || '')).filter(Boolean);
  const rows = (opsBots || []).filter(b => String(b.strategy || '').toLowerCase() === strat);
  const sameContract = rows.filter(b => {
    const bc = norm(b.contract);
    return want.some(w => w && bc === w);
  });
  const exact = sameContract.filter(b => {
    const ba = String(b.account || '');
    const bn = String(b.account_name || '');
    return tags.some(tag => tag === ba || tag === bn);
  });
  if (exact.length === 1) return exact[0];
  if (sameContract.length === 1) return sameContract[0];
  return null;
}

async function submitOpsRemove() {
  if (!opsEdit) return;
  const rail = opsCatalog && opsCatalog.launch === 'railway';
  const name = opsEdit.qsym || opsEdit.contract || '';
  if (!confirm(rail
    ? ('Flatten ' + name + ' (cancel every order + close the position), then delete the Railway service? Leftover quotes can take a loss.')
    : ('Flatten ' + name + ' (cancel every order + close the position), then kill the process? Leftover quotes can take a loss.'))) return;
  const btn = document.getElementById('opsRemoveBtn');
  if (btn) btn.disabled = true;
  setOpsMsg('opsLaunchMsg', 'Cancelling orders and flattening… this can take up to a minute', false);
  const known = opsBotForEdit();
  try {
    const r = await fetch('/api/ops/bots/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: (known && known.id) || '',
        contract: opsEdit.contract,
        quote: opsEdit.qsym || '',
        account: opsEdit.account,
        account_name: opsEdit.account_name || '',
        strategy: opsEdit.strategy,
        venue: opsEdit.venue || '',
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setOpsMsg('opsLaunchMsg', opsErr(d, r.status), true);
      return;
    }
    toast((rail ? 'removed ' : 'stopped ') + name, 'ok');
    closeRpOps();
    if (typeof loadRpnl === 'function') loadRpnl(true);
  } catch (e) {
    setOpsMsg('opsLaunchMsg', String(e), true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function refreshOpsBots() {
  const box = document.getElementById('opsBots');
  if (!box) return;
  try {
    const r = await fetch('/api/ops/bots');
    const d = r.ok ? await r.json() : { bots: [] };
    opsBots = d.bots || [];
  } catch (e) {
    opsBots = [];
  }
  if (!opsBots.length) {
    const rail = opsCatalog && opsCatalog.launch === 'railway';
    box.innerHTML = '<div class="rp-ops-empty">' +
      (rail ? 'No dash-started Railway services.' : 'No dash-started processes.') + '</div>';
    return;
  }
  box.innerHTML = opsBots.map(b => {
    const when = b.started_at ? fmtIST(b.started_at) : '';
    const rail = b.kind === 'railway' || b.service;
    return '<div class="rp-ops-bot">' +
      '<div><b>' + escHtml(b.contract) + '</b> · ' + escHtml(b.strategy) +
      ' <span class="rpnl-venue ' + escHtml(b.venue) + '">' + escHtml(b.venue) + '</span>' +
      '<div class="aid">' + escHtml(b.account_name || b.account || b.service || '') +
      (when ? ' · ' + when : '') +
      (b.status ? ' · ' + escHtml(b.status) : '') +
      (b.alive ? '' : ' · dead') + '</div></div>' +
      '<button type="button" class="btn" data-ops-stop="' + escHtml(b.id) + '">' +
      (rail ? 'Delete' : 'Kill') + '</button>' +
      '</div>';
  }).join('');
}

async function stopOpsBot(id) {
  const row = (opsBots || []).find(b => b.id === id) || {};
  const rail = row.kind === 'railway' || !!row.service;
  if (!id || !confirm(rail
    ? 'Flatten this contract (cancel orders + close position), then delete the Railway service?'
    : 'Flatten this contract (cancel orders + close position), then kill the process?')) return;
  try {
    const r = await fetch('/api/ops/bots/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      toast(opsErr(d, r.status), 'err');
      return;
    }
    toast('stopped', 'ok');
    await refreshOpsBots();
  } catch (e) {
    toast(String(e), 'err');
  }
}

document.addEventListener('click', ev => {
  const stop = ev.target.closest('[data-ops-stop]');
  if (stop) {
    ev.preventDefault();
    stopOpsBot(stop.getAttribute('data-ops-stop'));
    return;
  }
  const pick = ev.target.closest('[data-ops-acct]');
  if (pick) {
    ev.preventDefault();
    const role = pick.getAttribute('data-xfer-role');
    const id = pick.getAttribute('data-ops-acct') || '';
    if (role && typeof pickBalXfer === 'function') {
      pickBalXfer(role, id);
      return;
    }
    const sel = document.getElementById('opsAccount');
    if (sel && id && [...sel.options].some(o => o.value === id)) {
      sel.value = id;
      onOpsAccountChange();
    }
    return;
  }
  const box = document.getElementById('rpOps');
  if (box && !box.hidden && ev.target === box) closeRpOps();
});
document.addEventListener('keydown', ev => {
  if (ev.key !== 'Escape') return;
  const box = document.getElementById('rpOps');
  if (box && !box.hidden) closeRpOps();
});
