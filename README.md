# OPADash

Shared PnL / fills dashboard (was inside OPA3). Reads the same Postgres `fills` table the bots write to. No trading.

```
cd D:\WORK\TradingBots\OPADash
pip install -r requirements.txt
uvicorn webapp.server:app --reload --port 8800
```

Open http://127.0.0.1:8800 — top-right **strategy** (`opa3`, `opa6`, …). rPnL page: contract table, OHLC + fill overlay, cumulative rPnL.

**rPnL New / Cash.** Toolbar **New** starts an OPA6 process (sibling `../OPA6`, or `OPA6_ROOT`) with the selected exchange, subaccount keys, contract, strategy, and knobs. **Cash** moves unlocked Delta USD between configured subs. Transfers need the **parent/main** API key (`PROFIT_SWEEP_API_KEY` + `PROFIT_SWEEP_API_SECRET`, or `"parent": true` on that `accounts.json` row). Dash-started PIDs can be killed from the same sheet; quote Stop on a pill is unchanged.

**Balances** are live from exchange APIs, not fills. Add one key block per subaccount (`BAL_1_EXCHANGE` / `BAL_1_KEY` / `BAL_1_SECRET`, then `BAL_2_*`…) or copy `config/accounts.example.json` to `config/accounts.json`. Same `id` on Delta + CoinDCX shares a row. USD wallets convert with `USDINR_RATE`.

`DATABASE_URL` from this folder’s `.env`, else sibling `OPA3/.env` / `OPA6/.env`. Copy `.env.example` if you want a local file.
