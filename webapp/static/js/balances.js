// Balances page
let balTimer;

function initBalances() { loadBalances(); setupBalAuto(); }

async function loadBalances() {
  const empty = document.getElementById('balEmpty');
  const shell = document.getElementById('balShell');
  empty.style.display = 'block';
  empty.textContent = 'Loading balances…';
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
    document.getElementById('balCount').textContent =
      accts.length + ' account' + (accts.length === 1 ? '' : 's') +
      (withBal ? ' · ' + withBal + ' with wallet' : '') +
      ' · ' + (scope === 'all' ? 'all strategies' : (d.strategy || ''));
    if (!accts.length) {
      empty.innerHTML = 'No exchange accounts found in fills.';
      shell.style.display = 'none';
      return;
    }
    empty.style.display = 'none';
    shell.style.display = 'block';
    const asOf = d.as_of ? (' · snapshot ' + fmtIST(d.as_of)) : '';
    const snapNote = d.snapshots
      ? (d.snapshots + ' live wallet' + (d.snapshots === 1 ? '' : 's') + asOf)
      : 'No live subaccount wallets yet — restart belt/stack/lean/touch (and other quote bots) so each reporter writes its wallet. Until then cells stay empty.';
    document.getElementById('balHero').innerHTML =
      '<div class="hero-top"><div><div class="hero-label">Total equity</div>' +
        '<div class="hero-bal">' + (tot.balance == null ? '—' : rptMoney(tot.balance)) + '</div>' +
        '<div class="hero-sub">' + escHtml(snapNote) + '</div></div></div>' +
      '<div class="rpt-kpis"><div class="rpt-kpi"><div class="k">Subaccounts</div><div class="v">' +
        (tot.accounts || accts.length) + '</div></div>' +
        exch.map(function (e) {
          return '<div class="rpt-kpi"><div class="k">' + escHtml(e.label || e.exchange) + '</div>' +
            '<div class="v">' + (e.balance == null ? '—' : rptMoney(e.balance)) + '</div></div>';
        }).join('') + '</div>';
    document.getElementById('balExch').innerHTML = exch.map(function (e) {
      return '<div class="rpt-exchip"><div class="el rpnl-venue ' + rpnlVenueClass(e.exchange) + '">' +
        escHtml(e.label || e.exchange) + '</div><div class="ev">' +
        (e.balance == null ? '—' : rptMoney(e.balance)) + '</div></div>';
    }).join('');
    const head = '<tr><th>Account</th>' + exch.map(function (e) {
      return '<th>' + escHtml(e.label || e.exchange) + '</th>';
    }).join('') + '<th>Total</th><th>Updated</th></tr>';
    const body = accts.map(function (a) {
      const name = a.account_name && a.account_name !== a.account ? a.account_name : (a.account || 'unattributed');
      const tags = (a.strategies || []).join(' · ');
      const idBit = (tags ? '<div class="aid">' + escHtml(tags) + '</div>' : '') +
        (a.account && a.account !== a.account_name ? '<div class="aid">' + escHtml(a.account) + '</div>' : '');
      const contracts = a.contracts || [];
      const shown = contracts.slice(0, 8);
      const extra = contracts.length - shown.length;
      const chips = shown.map(function (c) {
        return '<button type="button" class="bal-cchip" data-contract="' + escHtml(c) +
          '" data-account="' + escHtml(a.account || '') +
          '" onclick="event.stopPropagation(); goToRpnlChart(this.dataset.contract, this.dataset.account)" title="Open rPnL chart">' +
          escHtml(c) + '</button>';
      }).join('') + (extra > 0 ? '<span class="aid">+' + extra + '</span>' : '');
      const cells = exch.map(function (c) {
        const v = (a.venues || {})[c.exchange];
        return (v == null || v === '') ? '<td style="color:var(--muted)">—</td>' : '<td>' + rptMoney(v) + '</td>';
      }).join('');
      return '<tr class="rpt-click" data-account="' + escHtml(a.account || '') +
        '" onclick="goToReportAccount(this.dataset.account)" title="Open in Reports">' +
        '<td><div class="an">' + escHtml(name) + '</div>' + idBit +
        (chips ? '<div class="bal-cchips">' + chips + '</div>' : '') + '</td>' + cells +
        '<td>' + (a.total == null ? '—' : rptMoney(a.total)) + '</td>' +
        '<td>' + (a.time ? fmtIST(a.time) : '—') + '</td></tr>';
    }).join('');
    const foot = '<tr><td>Total</td>' + exch.map(function (e) {
      return '<td>' + (e.balance == null ? '—' : rptMoney(e.balance)) + '</td>';
    }).join('') + '<td>' + (tot.balance == null ? '—' : rptMoney(tot.balance)) + '</td><td></td></tr>';
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
