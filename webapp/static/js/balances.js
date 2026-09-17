// Balances page — live exchange wallets from configured API keys
let balTimer;

function initBalances() { loadBalances(); setupBalAuto(); }

function balMoney(n) {
  if (typeof rptMoney === 'function') return rptMoney(n);
  const v = Number(n) || 0;
  return '₹' + Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

async function loadBalances() {
  const empty = document.getElementById('balEmpty');
  const shell = document.getElementById('balShell');
  empty.style.display = 'block';
  empty.textContent = 'Loading live wallets…';
  try {
    const scope = (document.getElementById('balThisStrategy') || {}).checked ? 'strategy' : 'all';
    const r = await fetch(withStrategy('/api/balances') + '&scope=' + scope);
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      throw new Error(b.detail || r.statusText);
    }
    const d = await r.json();
    const accts = d.accounts || [];
    const exch = d.exchanges || [];
    const tot = d.totals || {};
    const withBal = tot.with_balance || 0;
    const errN = tot.errors || 0;
    document.getElementById('balCount').textContent =
      (d.configured || accts.length) + ' key' + ((d.configured || accts.length) === 1 ? '' : 's') +
      ' · ' + accts.length + ' account' + (accts.length === 1 ? '' : 's') +
      (withBal ? ' · ' + withBal + ' live' : '') +
      (errN ? ' · ' + errN + ' failed' : '');
    if (!accts.length) {
      empty.innerHTML = escHtml(d.hint || 'No wallet API keys configured.') +
        '<div style="margin-top:10px">Add <code>BAL_1_EXCHANGE</code> / <code>BAL_1_KEY</code> / <code>BAL_1_SECRET</code> in the webapp env, or copy <code>config/accounts.example.json</code> to <code>config/accounts.json</code>.</div>';
      shell.style.display = 'none';
      return;
    }
    empty.style.display = 'none';
    shell.style.display = 'block';
    const asOf = d.as_of ? (' · ' + fmtIST(d.as_of)) : '';
    const snapNote = 'Live from exchange APIs' + asOf +
      (errN ? ' · ' + errN + ' key' + (errN === 1 ? '' : 's') + ' failed' : '');
    document.getElementById('balHero').innerHTML =
      '<div class="hero-top"><div><div class="hero-label">Total equity</div>' +
        '<div class="hero-bal">' + (tot.balance == null ? '—' : balMoney(tot.balance)) + '</div>' +
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
    const head = '<tr><th>Account</th>' + exch.map(function (e) {
      return '<th>' + escHtml(e.label || e.exchange) + '</th>';
    }).join('') + '<th>Total</th><th>Updated</th></tr>';
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
      return '<tr>' +
        '<td><div class="an">' + escHtml(name) + '</div>' + idBit + '</td>' + cells +
        '<td>' + (a.total == null ? '—' : balMoney(a.total)) + '</td>' +
        '<td>' + (a.time ? fmtIST(a.time) : '—') + '</td></tr>';
    }).join('');
    const foot = '<tr><td>Total</td>' + exch.map(function (e) {
      return '<td>' + (e.balance == null ? '—' : balMoney(e.balance)) + '</td>';
    }).join('') + '<td>' + (tot.balance == null ? '—' : balMoney(tot.balance)) + '</td><td></td></tr>';
    document.getElementById('balMatrix').innerHTML =
      '<table class="rpt-matrix"><thead>' + head + '</thead><tbody>' + body + '</tbody><tfoot>' + foot + '</tfoot></table>';
  } catch (e) {
    document.getElementById('balCount').textContent = 'Error';
    empty.style.display = 'block';
    empty.innerHTML = '<span style="color:var(--red)">Error: ' + escHtml(e.message) + '</span>';
    shell.style.display = 'none';
  }
}

function setupBalAuto() {
  clearInterval(balTimer);
  if (document.getElementById('balAuto').checked) balTimer = setInterval(loadBalances, 30000);
}
