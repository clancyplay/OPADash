let opsCatalog = null;
let opsAccounts = [];
let opsProducts = [];
let opsBots = [];
let opsReady = false;

function opsErr(d, status) {
  const det = d && d.detail;
  if (typeof det === 'string' && det) return det;
  if (Array.isArray(det) && det[0]) {
    const first = det[0];
    return first.msg || first.message || JSON.stringify(first);
  }
  return 'failed ' + status;
}

function openRpOps() {
  const box = document.getElementById('rpOps');
  if (!box) return;
  box.hidden = false;
  document.body.classList.add('ops-open');
  bootRpOps();
}

function closeRpOps() {
  const box = document.getElementById('rpOps');
  if (box) box.hidden = true;
  document.body.classList.remove('ops-open');
}

async function bootRpOps() {
  try {
    if (!opsCatalog) {
      const r = await fetch('/api/ops/strategies');
      opsCatalog = r.ok ? await r.json() : { venues: [], strategies: [] };
      fillOpsVenues();
      fillOpsStrategies();
      renderOpsParams();
    }
    await onOpsVenueChange();
    await refreshOpsBots();
  } catch (e) {
    setOpsMsg('opsLaunchMsg', String(e), true);
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
  const r = await fetch('/api/ops/accounts?venue=' + encodeURIComponent(venue));
  const d = r.ok ? await r.json() : { accounts: [] };
  opsAccounts = d.accounts || [];
  if (!opsAccounts.length) {
    sel.innerHTML = '<option value="">No keys for ' + escHtml(venue) + '</option>';
    return;
  }
  sel.innerHTML = opsAccounts.map(a => {
    const lab = (a.name || a.id) + (a.id && a.name && a.name !== a.id ? ' · ' + a.id : '');
    return '<option value="' + escHtml(a.id || a.name) + '">' + escHtml(lab) + '</option>';
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
  const sy = ((document.getElementById('opsContract') || {}).value || '').trim().toUpperCase();
  const p = (opsProducts || []).find(x => String(x.symbol || '').toUpperCase() === sy);
  if (!p) {
    el.textContent = '';
    return;
  }
  const bits = [];
  if (p.tick != null && Number(p.tick) > 0) bits.push('tick ' + p.tick);
  if (p.cv != null && Number(p.cv) > 0) bits.push('cv ' + p.cv);
  el.textContent = bits.join(' · ');
}

function opsStrategySpec() {
  const id = (document.getElementById('opsStrategy') || {}).value || '';
  return ((opsCatalog && opsCatalog.strategies) || []).find(s => s.id === id) || { params: [] };
}

function opsGeomLens() {
  return (opsCatalog && Array.isArray(opsCatalog.geom)) ? opsCatalog.geom : [];
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
  inp.min = unit === 'ticks' ? '1' : '0';
  const next = unit === 'ticks' ? (row.dataset.ticks || '4') : (row.dataset.pct || '0.1');
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
  const rows = lens.map(g => {
    const st = saved[g.id] || {};
    const unit = st.unit === 'ticks' ? 'ticks' : 'pct';
    const pct = st.pct != null && st.pct !== '' ? st.pct : g.pct_default;
    const ticks = st.ticks != null && st.ticks !== '' ? st.ticks : g.ticks_default;
    const val = unit === 'ticks' ? ticks : pct;
    return '<div class="rp-ops-len" data-geom="' + escHtml(g.id) + '" data-pct="' + escHtml(pct) + '" data-ticks="' + escHtml(ticks) + '">' +
      '<span class="rp-ops-len-lab">' + escHtml(g.label) + '</span>' +
      '<input id="opsG_' + escHtml(g.id) + '" type="number" min="' + (unit === 'ticks' ? '1' : '0') +
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
    '<div class="rp-ops-sub">Geometry</div>' +
    '<p class="rp-ops-hint">Each edge is % of price, or whole ticks. Ticks win. Fit auto will not overwrite a tick lock.</p>' +
    rows +
    '<div class="rp-ops-geom-sum" id="opsGeomSum"></div>' +
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

function renderOpsParam(p) {
  if (p.type === 'geom') return renderOpsGeom();
  const id = 'opsP_' + p.key;
  if (p.type === 'bool') {
    const on = p.default === true || p.default === 'true';
    return '<label class="rp-ops-check"><input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + ' /> ' +
      escHtml(p.label) + '</label>';
  }
  if (p.type === 'select') {
    return '<label>' + escHtml(p.label) + '<select id="' + id + '" onchange="updateOpsGeomSum()">' +
      opsSelectOptions(p) + '</select></label>';
  }
  const step = p.type === 'int' ? '1' : 'any';
  return '<label>' + escHtml(p.label) +
    '<input id="' + id + '" type="number" step="' + step + '" value="' + escHtml(p.default == null ? '' : p.default) + '" /></label>';
}

function renderOpsParams() {
  const box = document.getElementById('opsParams');
  if (!box) return;
  const spec = opsStrategySpec();
  box.innerHTML = (spec.params || []).map(renderOpsParam).join('');
  updateOpsGeomSum();
}

function collectOpsGeom(out) {
  if (!document.getElementById('opsGeom')) return;
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
  out.TAIL_TICKS = '0';
}

function validateOpsGeom() {
  if (!document.getElementById('opsGeom')) return '';
  for (const g of opsGeomLens()) {
    const inp = document.getElementById('opsG_' + g.id);
    const n = Number(inp && inp.value);
    const unit = opsGeomRowUnit(g.id);
    if (!isFinite(n) || !(n > 0)) return g.label + ' must be > 0';
    if (unit === 'ticks' && n !== Math.round(n)) return g.label + ' ticks must be a whole number';
  }
  return '';
}

function collectOpsParams() {
  const spec = opsStrategySpec();
  const out = {};
  const extra = (document.getElementById('opsExtra') || {}).value || '';
  extra.split('\n').forEach(line => {
    const s = line.trim();
    if (!s || s.startsWith('#') || s.indexOf('=') < 0) return;
    const i = s.indexOf('=');
    const k = s.slice(0, i).trim().toUpperCase();
    const v = s.slice(i + 1).trim();
    if (k && v) out[k] = v;
  });
  (spec.params || []).forEach(p => {
    if (p.type === 'geom') return;
    const el = document.getElementById('opsP_' + p.key);
    if (!el) return;
    if (p.type === 'bool') out[p.key] = !!el.checked;
    else if (el.value !== '' && el.value != null) out[p.key] = el.value;
  });
  collectOpsGeom(out);
  return out;
}

function setOpsMsg(id, text, err) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('err', !!err);
}

async function submitOpsLaunch() {
  const venue = opsVenue();
  const account = (document.getElementById('opsAccount') || {}).value || '';
  const contract = ((document.getElementById('opsContract') || {}).value || '').trim();
  const strategy = (document.getElementById('opsStrategy') || {}).value || '';
  if (!account) return setOpsMsg('opsLaunchMsg', 'Pick a subaccount with API keys', true);
  if (!contract) return setOpsMsg('opsLaunchMsg', 'Contract required', true);
  const geomErr = validateOpsGeom();
  if (geomErr) return setOpsMsg('opsLaunchMsg', geomErr, true);
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
    box.innerHTML = '<div class="rp-ops-empty">No dash-started processes.</div>';
    return;
  }
  box.innerHTML = opsBots.map(b => {
    const when = b.started_at ? fmtIST(b.started_at) : '';
    return '<div class="rp-ops-bot">' +
      '<div><b>' + escHtml(b.contract) + '</b> · ' + escHtml(b.strategy) +
      ' <span class="rpnl-venue ' + escHtml(b.venue) + '">' + escHtml(b.venue) + '</span>' +
      '<div class="aid">' + escHtml(b.account_name || b.account) + (when ? ' · ' + when : '') +
      (b.alive ? '' : ' · dead') + '</div></div>' +
      '<button type="button" class="btn" data-ops-stop="' + escHtml(b.id) + '">Kill</button>' +
      '</div>';
  }).join('');
}

async function stopOpsBot(id) {
  if (!id || !confirm('Kill this process? Open quotes cancel on shutdown.')) return;
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
  const box = document.getElementById('rpOps');
  if (box && !box.hidden && ev.target === box) closeRpOps();
});
document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape') closeRpOps();
});
