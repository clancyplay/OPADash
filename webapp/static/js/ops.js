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
    renderOpsParams();
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
  const id = (opsEdit && opsEdit.strategy) || (document.getElementById('opsStrategy') || {}).value || '';
  if (id === 'pair') {
    return { id: 'pair', label: 'Pair', params: (opsCatalog && opsCatalog.pair_params) || [] };
  }
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
    setChk('opsP_MAX_IN_USD', true, true);
  } else if (s.max_pos != null) {
    setNum('opsP_MAX_POSITION', s.max_pos);
    setChk('opsP_MAX_IN_USD', false, true);
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
  setNum('opsP_BID_TICKS', s.bid_ticks);
  setNum('opsP_ASK_TICKS', s.ask_ticks);
  setNum('opsP_STEP_PCT', s.step);
  opsGeomLens().forEach(g => {
    const ticks = s[g.id + '_ticks'];
    const pct = s[g.id];
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
    inp.min = useTicks ? '1' : '0';
    inp.value = useTicks ? String(ticks) : (pct != null && pct !== '' ? String(pct) : inp.value);
  });
  updateOpsGeomSum();
}

async function submitOpsLaunch() {
  if (opsEdit) return submitOpsEdit();
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

async function submitOpsEdit() {
  if (!opsEdit) return;
  const geomErr = validateOpsGeom();
  if (geomErr) return setOpsMsg('opsLaunchMsg', geomErr, true);
  const payload = collectOpsParams();
  if (payload.MAX_POSITION != null && payload.max_usd == null && payload.max_pos == null) {
    const usd = payload.MAX_IN_USD;
    if (usd === false || usd === 'false') payload.max_pos = payload.MAX_POSITION;
    else if (usd === true || usd === 'true' || (opsEdit.settings && opsEdit.settings.max_usd != null)) {
      payload.max_usd = payload.MAX_POSITION;
    } else if (opsEdit.settings && opsEdit.settings.max_pos != null) {
      payload.max_pos = payload.MAX_POSITION;
    } else {
      payload.max_usd = payload.MAX_POSITION;
    }
  }
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
  if (ev.key !== 'Escape') return;
  const box = document.getElementById('rpOps');
  if (box && !box.hidden) closeRpOps();
});
