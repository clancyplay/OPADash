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
}

function opsStrategySpec() {
  const id = (document.getElementById('opsStrategy') || {}).value || '';
  return ((opsCatalog && opsCatalog.strategies) || []).find(s => s.id === id) || { params: [] };
}

function renderOpsParams() {
  const box = document.getElementById('opsParams');
  if (!box) return;
  const spec = opsStrategySpec();
  box.innerHTML = (spec.params || []).map(p => {
    const id = 'opsP_' + p.key;
    if (p.type === 'bool') {
      const on = p.default === true || p.default === 'true';
      return '<label class="rp-ops-check"><input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + ' /> ' +
        escHtml(p.label) + '</label>';
    }
    if (p.type === 'select') {
      const opts = (p.options || []).map(o => {
        const sel = String(o) === String(p.default) ? ' selected' : '';
        return '<option value="' + escHtml(o) + '"' + sel + '>' + escHtml(o) + '</option>';
      }).join('');
      return '<label>' + escHtml(p.label) + '<select id="' + id + '">' + opts + '</select></label>';
    }
    const step = p.type === 'int' ? '1' : 'any';
    return '<label>' + escHtml(p.label) +
      '<input id="' + id + '" type="number" step="' + step + '" value="' + escHtml(p.default == null ? '' : p.default) + '" /></label>';
  }).join('');
}

function collectOpsParams() {
  const spec = opsStrategySpec();
  const out = {};
  (spec.params || []).forEach(p => {
    const el = document.getElementById('opsP_' + p.key);
    if (!el) return;
    if (p.type === 'bool') out[p.key] = !!el.checked;
    else if (el.value !== '' && el.value != null) out[p.key] = el.value;
  });
  const extra = (document.getElementById('opsExtra') || {}).value || '';
  extra.split('\n').forEach(line => {
    const s = line.trim();
    if (!s || s.startsWith('#') || s.indexOf('=') < 0) return;
    const i = s.indexOf('=');
    const k = s.slice(0, i).trim().toUpperCase();
    const v = s.slice(i + 1).trim();
    if (k && v) out[k] = v;
  });
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
  if (!confirm('Start ' + strategy + ' on ' + venue + ':' + contract + '?')) return;
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
