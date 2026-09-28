let opsCatalog = null;
let opsAccounts = [];
let opsProducts = [];
let opsBots = [];
let opsReady = false;
let opsEdit = null;

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
  const meta = document.getElementById('opsEditMeta');
  if (meta) {
    if (!edit) {
      meta.innerHTML = '';
    } else {
      const acct = opsEdit.account_name || opsEdit.account || '';
      meta.innerHTML = '<b>' + escHtml(opsEdit.qsym || opsEdit.contract || '') + '</b> · ' +
        escHtml(opsEdit.strategy || '') +
        (acct ? ' · ' + escHtml(acct) : '') +
        '<div class="aid">Live until this process restarts — does not write .env</div>';
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

function closeRpOps() {
  const box = document.getElementById('rpOps');
  if (box) box.hidden = true;
  document.body.classList.remove('ops-open');
  opsEdit = null;
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
    if (opsEdit) return;
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
}

function opsMoney(a) {
  if (!a) return '';
  const asset = String(a.asset || 'USD').toUpperCase();
  let usd = Number(a.balance);
  let inr = Number(a.balance_inr);
  const rate = Number(a.usdinr);
  const fx = isFinite(rate) && rate > 0 ? rate : 87;
  if ((!isFinite(inr) || a.balance_inr == null) && isFinite(usd) && a.balance != null) inr = usd * fx;
  if ((!isFinite(usd) || a.balance == null) && isFinite(inr) && a.balance_inr != null) usd = inr / fx;
  const bits = [];
  if (isFinite(inr) && (a.balance_inr != null || a.balance != null)) {
    bits.push(typeof inrFmt === 'function'
      ? inrFmt(inr)
      : ('₹' + Math.abs(inr).toLocaleString('en-IN', { maximumFractionDigits: 0 })));
  }
  if (isFinite(usd) && (a.balance != null || a.balance_inr != null)) {
    const d = Math.abs(usd) >= 100 ? 0 : (Math.abs(usd) >= 10 ? 1 : 2);
    const unit = (asset === 'INR') ? '' : ((asset === 'USD' || asset === 'USDT' || !asset) ? '$' : asset + ' ');
    bits.push(unit + usd.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
  }
  return bits.join(' · ');
}

function opsRunningLine(a) {
  const rows = (a && a.running) || [];
  if (!rows.length) return 'idle';
  return rows.map(x => {
    const c = x.contract || '';
    const s = x.strategy || '';
    return s ? (c + ' · ' + s) : c;
  }).filter(Boolean).join('  ·  ');
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
    const name = a.name || a.id || '';
    const on = id === cur || a.name === cur;
    const mode = String(a.margin_mode || '').trim();
    const bal = opsMoney(a);
    const run = opsRunningLine(a);
    const idle = run === 'idle';
    return '<button type="button" class="rp-ops-acct' + (on ? ' on' : '') + '" data-ops-acct="' + escHtml(id) + '">' +
      '<div class="rp-ops-acct-h">' +
        '<b>' + escHtml(name) + '</b>' +
        (mode ? '<span class="rp-ops-mode ' + escHtml(mode) + '">' + escHtml(mode) + '</span>' : '') +
        (bal ? '<span class="rp-ops-bal">' + escHtml(bal) + '</span>' : '') +
      '</div>' +
      '<div class="rp-ops-run' + (idle ? ' idle' : '') + '">' + escHtml(run) + '</div>' +
      (a.error ? '<div class="aid">' + escHtml(a.error) + '</div>' : '') +
    '</button>';
  }).join('');
}

async function loadOpsProducts(venue) {
  const list = document.getElementById('opsContractList');
  if (!list) return;
  list.innerHTML = '';
  try {
    const r = await fetch('/api/ops/products?venue=' + encodeURIComponent(venue));
    const d = r.ok ? await r.json() : { products: [] };
    opsProducts = d.products || [];
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
  if (!el) return;
  const pair = opsIsPair();
  const sy = ((document.getElementById('opsContract') || {}).value || '').trim().toUpperCase();
  const p = (opsProducts || []).find(x => String(x.symbol || '').toUpperCase() === sy);
  if (!p) {
    el.textContent = pair ? 'Option C-/P- symbol, call+put, or crop + expiry (BTC 250926)' : '';
    return;
  }
  const bits = [];
  if (p.tick != null && Number(p.tick) > 0) bits.push('tick ' + p.tick);
  if (p.cv != null && Number(p.cv) > 0) bits.push('cv ' + p.cv);
  el.textContent = bits.join(' · ');
}

function opsIsPair() {
  const id = (opsEdit && opsEdit.strategy) || (document.getElementById('opsStrategy') || {}).value || '';
  return id === 'pair';
}

function onOpsStrategyChange() {
  renderOpsParams();
  const pair = opsIsPair();
  const venue = document.getElementById('opsVenue');
  if (venue && !opsEdit) {
    venue.disabled = pair;
    if (pair && venue.value !== 'delta') {
      venue.value = 'delta';
      onOpsVenueChange();
    }
  }
  const inp = document.getElementById('opsContract');
  if (inp && !opsEdit) inp.placeholder = pair ? 'C-BTC-120000-250926 or BTC 250926' : 'EVAAUSD';
  onOpsContractMeta();
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
  return all.filter(g => !want || want.indexOf(g.id) >= 0).map(g => Object.assign({}, g, extras[g.id] || {}));
}

function opsGeomDef(id) {
  return opsGeomLens().find(g => g.id === id) || {};
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
  const btn = document.querySelector('#opsGeom [data-geom="' + id + '"] .rp-ops-unit button.on');
  return (btn && btn.getAttribute('data-unit')) || 'pct';
}

function persistOpsGeom() {
  if (opsEdit) return;
  const state = opsGeomState();
  opsGeomLens().forEach(g => {
    const row = document.querySelector('#opsGeom [data-geom="' + g.id + '"]');
    const inp = document.getElementById('opsG_' + g.id);
    if (!row || !inp) return;
    const unit = opsGeomRowUnit(g.id);
    if (unit === 'ticks') row.dataset.ticks = inp.value;
    else row.dataset.pct = inp.value;
    state[g.id] = { unit: unit, pct: row.dataset.pct || g.pct_default, ticks: row.dataset.ticks || g.ticks_default };
  });
  saveOpsGeomState(state);
}

function setOpsGeomUnit(id, unit) {
  if (opsFitAutoOn()) return;
  const row = document.querySelector('#opsGeom [data-geom="' + id + '"]');
  const inp = document.getElementById('opsG_' + id);
  if (!row || !inp) return;
  const prev = opsGeomRowUnit(id);
  if (prev === 'ticks') row.dataset.ticks = inp.value;
  else row.dataset.pct = inp.value;
  row.querySelectorAll('.rp-ops-unit button').forEach(b => {
    b.classList.toggle('on', b.getAttribute('data-unit') === unit);
  });
  inp.step = unit === 'ticks' ? '1' : 'any';
  const g = opsGeomDef(id);
  const tickMin = g.allow_zero ? '0' : '1';
  inp.min = unit === 'ticks' ? tickMin : '0';
  const next = unit === 'ticks'
    ? (row.dataset.ticks || g.ticks_default || '4')
    : (row.dataset.pct || g.pct_default || '0.1');
  inp.value = next;
  persistOpsGeom();
  updateOpsGeomSum();
}

function onOpsGeomInput(id) {
  persistOpsGeom();
  updateOpsGeomSum();
}

function updateOpsGeomSum() {
  const el = document.getElementById('opsGeomSum');
  if (!el) return;
  const bits = opsGeomLens().map(g => {
    const inp = document.getElementById('opsG_' + g.id);
    const n = inp ? inp.value : '';
    const unit = opsGeomRowUnit(g.id);
    return g.label.toLowerCase() + ' ' + n + (unit === 'ticks' ? 't' : '%');
  });
  const mult = (document.getElementById('opsP_STEP_MULT') || {}).value;
  if (mult) bits.push('×' + mult);
  el.textContent = bits.join(' · ');
}

function renderOpsGeom() {
  const lens = opsGeomLens();
  if (!lens.length) return '';
  const saved = opsGeomState();
  const spec = opsGeomParam() || {};
  const hint = spec.hint || 'Each edge is % of price, or whole ticks. Ticks win.';
  const rows = lens.map(g => {
    const st = saved[g.id] || {};
    const unit = st.unit === 'ticks' ? 'ticks' : 'pct';
    const pct = st.pct != null && st.pct !== '' ? st.pct : g.pct_default;
    const ticks = st.ticks != null && st.ticks !== '' ? st.ticks : g.ticks_default;
    const val = unit === 'ticks' ? ticks : pct;
    const tickMin = g.allow_zero ? '0' : '1';
    return '<div class="rp-ops-len" data-geom="' + escHtml(g.id) + '" data-pct="' + escHtml(pct) + '" data-ticks="' + escHtml(ticks) + '">' +
      '<span class="rp-ops-len-lab">' + escHtml(g.label) + '</span>' +
      '<input id="opsG_' + escHtml(g.id) + '" type="number" min="' + (unit === 'ticks' ? tickMin : '0') +
        '" step="' + (unit === 'ticks' ? '1' : 'any') + '" inputmode="decimal" value="' + escHtml(val) +
        '" oninput="onOpsGeomInput(\'' + escHtml(g.id) + '\')" />' +
      '<div class="rp-ops-unit" role="group" aria-label="' + escHtml(g.label) + ' unit">' +
        '<button type="button" data-unit="pct"' + (unit === 'pct' ? ' class="on"' : '') +
          ' onclick="setOpsGeomUnit(\'' + escHtml(g.id) + '\',\'pct\')">%</button>' +
        '<button type="button" data-unit="ticks"' + (unit === 'ticks' ? ' class="on"' : '') +
          ' onclick="setOpsGeomUnit(\'' + escHtml(g.id) + '\',\'ticks\')">ticks</button>' +
      '</div>' +
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
  if (p.type === 'geom') return renderOpsGeom();
  if (p.type === 'max') return renderOpsMax(p);
  const id = 'opsP_' + p.key;
  const extraCls = (p.wide ? ' rp-ops-wide' : '');
  const showIf = Array.isArray(p.show_if_any) && p.show_if_any.length
    ? ' data-show-if="' + escHtml(p.show_if_any.join(',')) + '"'
    : '';
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
  const step = p.type === 'int' ? '1' : 'any';
  const min = p.min != null ? ' min="' + escHtml(String(p.min)) + '"' : '';
  return '<label' + cls + showIf + title + '>' + escHtml(p.label) +
    '<input id="' + id + '" type="number" step="' + step + '"' + min + title +
      ' value="' + escHtml(p.default == null ? '' : p.default) + '" /></label>';
}

function syncOpsDependentFields() {
  document.querySelectorAll('#opsParams [data-show-if]').forEach(el => {
    const keys = (el.getAttribute('data-show-if') || '').split(',').map(s => s.trim()).filter(Boolean);
    const boxes = keys.map(k => document.getElementById('opsP_' + k)).filter(Boolean);
    el.hidden = boxes.length ? !boxes.some(b => b.checked) : false;
  });
  syncOpsFitLock();
}

function opsFitAutoOn() {
  const fit = document.getElementById('opsP_FIT_AUTO');
  const step = document.getElementById('opsP_STEP_AUTO');
  return !!(fit && fit.checked) || !!(step && step.checked);
}

function syncOpsFitLock() {
  const on = opsFitAutoOn();
  const geom = document.getElementById('opsGeom');
  if (geom) {
    geom.classList.toggle('is-fit-lock', on);
    geom.querySelectorAll('input, button').forEach(el => { el.disabled = on; });
  }
  const stepPct = document.getElementById('opsP_STEP_PCT');
  if (stepPct) stepPct.disabled = on;
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
  if (!s || !opsFitAutoOn()) return;
  opsGeomLens().forEach(g => {
    const ticksKey = g.id === 'k' ? 'k_ticks' : (g.id === 'tail' ? 'step_ticks' : g.id + '_ticks');
    const pctKey = g.id === 'k' ? 'k' : (g.id === 'tail' ? 'step' : g.id);
    const ticks = s[ticksKey] != null ? s[ticksKey] : s[g.id + '_ticks'];
    const pct = s[pctKey] != null ? s[pctKey] : s[g.id];
    const row = document.querySelector('#opsGeom [data-geom="' + g.id + '"]');
    const inp = document.getElementById('opsG_' + g.id);
    if (!row || !inp) return;
    if (pct != null && pct !== '') row.dataset.pct = String(pct);
    if (ticks != null && ticks !== '') row.dataset.ticks = String(ticks);
    const useTicks = ticks != null && Number(ticks) > 0;
    row.querySelectorAll('.rp-ops-unit button').forEach(b => {
      b.classList.toggle('on', b.getAttribute('data-unit') === (useTicks ? 'ticks' : 'pct'));
    });
    inp.step = useTicks ? '1' : 'any';
    inp.min = useTicks ? (g.allow_zero ? '0' : '1') : '0';
    if (useTicks) inp.value = String(ticks);
    else if (pct != null && pct !== '') inp.value = String(pct);
  });
  const stepPct = document.getElementById('opsP_STEP_PCT');
  if (stepPct && s.step != null) stepPct.value = String(s.step);
  updateOpsGeomSum();
}

function paintOpsGeomLive() {
  const el = document.getElementById('opsGeomLive');
  if (!el) return;
  const s = opsLiveSetup();
  const bits = opsGeomLiveBits(s);
  if (bits.length) {
    el.innerHTML = '<b>Current live</b>  ' + escHtml(bits.join(' · '));
    applyLiveToGeomInputs(s);
    return;
  }
  el.textContent = opsFitAutoOn()
    ? 'Fit auto will keep hem / span / step from the live book after start.'
    : '';
}

function refreshOpsLiveGeom() {
  const box = document.getElementById('rpOps');
  if (!box || box.hidden || !opsEdit) return;
  const row = typeof currentRpnlRow === 'function' ? currentRpnlRow() : null;
  if (row && row.settings) opsEdit.settings = row.settings;
  paintOpsGeomLive();
}

function renderOpsGlossary() {
  const params = opsStrategySpec().params || [];
  const items = [];
  const seen = new Set();
  const add = (k, t, d) => { if (!seen.has(k)) { seen.add(k); items.push([t, d]); } };
  params.forEach(p => {
    if (p.type === 'max') {
      add('max', p.label || 'Max', p.label === 'Max coin'
        ? 'Underlying coin cap (2 = 2 of the coin), not USD.'
        : 'Inventory cap. USD is notional; lots are venue contracts.');
    } else if (p.type === 'geom') {
      const lenses = p.lenses || [];
      if (lenses.indexOf('hem') >= 0) add('hem', 'Hem', 'Cover-side edge off the hook.');
      if (lenses.indexOf('span') >= 0) add('span', 'Span', 'Far edge, measured from the hem.');
      if (lenses.indexOf('step') >= 0 || lenses.indexOf('tail') >= 0) add('step', 'Step', 'First same-side gap behind an edge.');
      if (lenses.indexOf('k') >= 0) add('k', 'K', 'Offset from the touch. 0 joins the bid–ask.');
    } else if (p.key === 'ORDERS') add('orders', 'Orders / side', 'How many quotes hang on each side.');
    else if (p.key === 'HOOK') add('hook', 'Hook', 'What the ladder hangs off — mid, inventory, or last.');
    else if (p.key === 'STEP_MULT') add('sm', 'Step ×', 'How the step grows down the ladder.');
    else if (p.key === 'FIT_AUTO') add('fit', 'Fit auto', 'Keeps hem and step matched to the live book. You cannot type them while this is on.');
    else if (p.key === 'STEP_AUTO') add('fstep', 'Fit step', 'Keeps step matched to the live book.');
    else if (p.key === 'SPAN_SPREAD') add('ss', 'Span spread', 'If the live bid–ask is wider than span, inner quotes sit on the spread.');
    else if (p.key === 'TOUCH_TICKS') add('touch', 'Touch ticks', 'How far inside the BBO when span follows the spread. 0 joins the touch.');
    else if (p.key === 'FATE_USD') add('fate', 'Fate $', 'Pause if rPnL drops this far from the peak.');
    else if (p.key === 'GRIND_USD') add('grind', 'Grind $', 'Pause if window rPnL is this negative.');
    else if (p.key === 'VOL_GATE') add('vol', 'Vol gate', 'Only quote while the tape is busy.');
    else if (p.key === 'DRY_RUN') add('dry', 'Dry run', 'Log quotes. Do not send orders.');
    else if (p.key === 'QUOTE_MS') add('qms', 'Quote ms', 'Min milliseconds between edits of the same order.');
    else if (p.key === 'PLACE_SECS') add('place', 'Place secs', 'After a full fill, wait this long before quoting that rung again.');
    else if (p.key === 'PAIR_HEDGE') add('ph', 'Hedge', 'Hedge option delta with the perpetual.');
    else if (p.key === 'PAIR_HEDGE_LOT') add('hl', 'Hedge lot', 'Min contracts off-target before a hedge order.');
    else if (p.key === 'BID_TICKS') add('bt', 'Bid +ticks', 'How many ticks above the bid you buy.');
    else if (p.key === 'ASK_TICKS') add('at', 'Ask −ticks', 'How many ticks under the ask you sell.');
  });
  if (!items.length) return '';
  return '<div class="rp-ops-glossary"><div class="rp-ops-sub">What these mean</div><dl>' +
    items.map(([t, d]) => '<div><dt>' + escHtml(t) + '</dt><dd>' + escHtml(d) + '</dd></div>').join('') +
    '</dl></div>';
}

function renderOpsParams() {
  const box = document.getElementById('opsParams');
  if (!box) return;
  const spec = opsStrategySpec();
  const params = spec.params || [];
    const titles = { size: 'Size', book: 'Book', geometry: 'Geometry', quote: 'Quote', pace: 'Pace', risk: 'Risk', hedge: 'Hedge' };
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
      '<div class="rp-ops-params">' + g.items.map(renderOpsParam).join('') + '</div></div>';
  }).join('') + renderOpsGlossary();
  applyOpsMaxUnitDefault();
  updateOpsGeomSum();
  syncOpsDependentFields();
}

function collectOpsGeom(out) {
  if (!document.getElementById('opsGeom')) return;
  if (opsEdit && opsFitAutoOn()) return;
  persistOpsGeom();
  opsGeomLens().forEach(g => {
    const row = document.querySelector('#opsGeom [data-geom="' + g.id + '"]');
    const inp = document.getElementById('opsG_' + g.id);
    if (!row || !inp) return;
    const unit = opsGeomRowUnit(g.id);
    if (unit === 'ticks') {
      const t = Math.max(0, Math.round(Number(inp.value) || 0));
      out[g.ticks_key] = String(t);
      out[g.pct_key] = row.dataset.pct || g.pct_default;
    } else {
      out[g.pct_key] = inp.value !== '' ? String(inp.value) : g.pct_default;
      out[g.ticks_key] = '0';
    }
  });
  const ids = opsGeomLens().map(g => g.id);
  if (ids.indexOf('step') >= 0 || ids.indexOf('tail') >= 0) out.TAIL_TICKS = out.STEP_TICKS || '0';
}

function validateOpsGeom() {
  if (!document.getElementById('opsGeom')) return '';
  if (opsFitAutoOn()) return '';
  for (const g of opsGeomLens()) {
    const inp = document.getElementById('opsG_' + g.id);
    const n = Number(inp && inp.value);
    const unit = opsGeomRowUnit(g.id);
    if (g.allow_zero) {
      if (!isFinite(n) || n < 0) return g.label + ' must be ≥ 0';
    } else if (!isFinite(n) || !(n > 0)) {
      return g.label + ' must be > 0';
    }
    if (unit === 'ticks' && n !== Math.round(n)) return g.label + ' ticks must be a whole number';
  }
  return '';
}

function validateOpsParams() {
  const spec = opsStrategySpec();
  for (const p of spec.params || []) {
    if (p.type !== 'int' && p.type !== 'number' && p.type !== 'max') continue;
    const el = document.getElementById('opsP_' + p.key);
    if (!el || el.value === '' || el.value == null) continue;
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
    if (p.type === 'geom' || p.type === 'max') return;
    const el = document.getElementById('opsP_' + p.key);
    if (!el) return;
    if (p.type === 'bool') out[p.key] = !!el.checked;
    else if (el.value !== '' && el.value != null) out[p.key] = el.value;
  });
  collectOpsMax(out);
  collectOpsGeom(out);
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
  if (s.fit_auto != null) setChk('opsP_FIT_AUTO', s.fit_auto, true);
  if (s.fit_auto != null || s.step_auto != null) setChk('opsP_STEP_AUTO', s.fit_auto != null ? s.fit_auto : s.step_auto, true);
  if (s.span_spread != null) setChk('opsP_SPAN_SPREAD', s.span_spread, true);
  if (s.vol_gate != null) setChk('opsP_VOL_GATE', s.vol_gate, true);
  setNum('opsP_FATE_USD', s.fate);
  setNum('opsP_GRIND_USD', s.grind);
  if (s.dry_run != null) setChk('opsP_DRY_RUN', s.dry_run, true);
  setNum('opsP_QUOTE_MS', s.quote_ms);
  setNum('opsP_PLACE_SECS', s.place_secs);
  setNum('opsP_BID_TICKS', s.bid_ticks);
  setNum('opsP_ASK_TICKS', s.ask_ticks);
  setNum('opsP_STEP_PCT', s.step);
  setNum('opsP_TOUCH_TICKS', s.touch_ticks);
  setNum('opsP_EDGE_PCT', s.edge);
  setSel('opsP_EDGE_VENUE', s.edge_venue);
  setNum('opsP_MOVE_PCT', s.move_pct);
  setNum('opsP_MOVE_SECS', s.move_secs);
  setNum('opsP_RISK_REWARD', s.risk_reward);
  setNum('opsP_MOM_PCT', s.mom_pct);
  setNum('opsP_MOM_SLOW_PCT', s.mom_slow_pct);
  setNum('opsP_CLIP_PCT', s.clip_pct);
  setNum('opsP_TRAIL_PCT', s.trail_pct);
  setNum('opsP_MOM_STOP_PCT', s.mom_stop_pct);
  if (s.flip != null) setChk('opsP_FLIP', s.flip, true);
  if (s.tails != null) setNum('opsP_TAILS', s.tails);
  else if (opsEdit && opsEdit.strategy === 'belt' && s.orders != null) {
    setNum('opsP_TAILS', Math.max(0, Number(s.orders) - 1));
  }
  if (s.pair_hedge != null) setChk('opsP_PAIR_HEDGE', s.pair_hedge, true);
  else if (s.hedge_via) setChk('opsP_PAIR_HEDGE', true, true);
  else if (opsEdit && opsEdit.strategy === 'pair') setChk('opsP_PAIR_HEDGE', false, true);
  if (s.hedge_lot != null) setNum('opsP_PAIR_HEDGE_LOT', s.hedge_lot);
  opsGeomLens().forEach(g => {
    const ticksKey = g.id === 'k' ? 'k_ticks' : (g.id === 'tail' ? 'step_ticks' : g.id + '_ticks');
    const pctKey = g.id === 'k' ? 'k' : (g.id === 'tail' ? 'step' : g.id);
    const ticks = s[ticksKey] != null ? s[ticksKey] : s[g.id + '_ticks'];
    const pct = s[pctKey] != null ? s[pctKey] : s[g.id];
    const row = document.querySelector('#opsGeom [data-geom="' + g.id + '"]');
    const inp = document.getElementById('opsG_' + g.id);
    if (!row || !inp) return;
    if (pct != null && pct !== '') row.dataset.pct = String(pct);
    if (ticks != null && ticks !== '') row.dataset.ticks = String(ticks);
    const useTicks = ticks != null && Number(ticks) > 0;
    row.querySelectorAll('.rp-ops-unit button').forEach(b => {
      b.classList.toggle('on', b.getAttribute('data-unit') === (useTicks ? 'ticks' : 'pct'));
    });
    inp.step = useTicks ? '1' : 'any';
    inp.min = useTicks ? (g.allow_zero ? '0' : '1') : '0';
    inp.value = useTicks ? String(ticks) : (pct != null && pct !== '' ? String(pct) : inp.value);
  });
  updateOpsGeomSum();
  syncOpsDependentFields();
}

async function submitOpsLaunch() {
  if (opsEdit) return submitOpsEdit();
  const venue = opsVenue();
  const account = (document.getElementById('opsAccount') || {}).value || '';
  const contract = ((document.getElementById('opsContract') || {}).value || '').trim();
  const strategy = (document.getElementById('opsStrategy') || {}).value || '';
  if (!account) return setOpsMsg('opsLaunchMsg', 'Pick a subaccount with API keys', true);
  if (!contract) return setOpsMsg('opsLaunchMsg', 'Contract required', true);
  const geomErr = validateOpsGeom() || validateOpsParams();
  if (geomErr) return setOpsMsg('opsLaunchMsg', geomErr, true);
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
      body: JSON.stringify({ venue, account, contract, strategy, params: collectOpsParams() }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setOpsMsg('opsLaunchMsg', opsErr(d, r.status), true);
      return;
    }
    const bot = d.bot || {};
    setOpsMsg('opsLaunchMsg', 'Started pid ' + (bot.pid || '') + ' — watch the rPnL pill', false);
    toast('started ' + strategy + ' ' + contract, 'ok');
    await refreshOpsBots();
    setTimeout(() => { if (typeof loadRpnl === 'function') loadRpnl(true); }, 2500);
  } catch (e) {
    setOpsMsg('opsLaunchMsg', String(e), true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function submitOpsEdit() {
  if (!opsEdit) return;
  const geomErr = validateOpsGeom() || validateOpsParams();
  if (geomErr) return setOpsMsg('opsLaunchMsg', geomErr, true);
  const payload = collectOpsParams();
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
        strategy: opsEdit.strategy,
        payload,
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setOpsMsg('opsLaunchMsg', opsErr(d, r.status), true);
      return;
    }
    toast('updated ' + name, 'ok');
    closeRpOps();
    setTimeout(() => { if (typeof loadRpnl === 'function') loadRpnl(true); }, 1200);
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
    ? 'Delete this Railway service? Open quotes cancel on shutdown.'
    : 'Kill this process? Open quotes cancel on shutdown.')) return;
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
    const sel = document.getElementById('opsAccount');
    const id = pick.getAttribute('data-ops-acct') || '';
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
