# OPADash

Shared PnL / fills dashboard (was inside OPA3). Reads the same Postgres `fills` table the bots write to. No trading.

```
cd D:\WORK\TradingBots\OPADash
pip install -r requirements.txt
uvicorn webapp.server:app --reload --port 8800
```

Open http://127.0.0.1:8800 — top-right **strategy** (`opa3`, `opa6`, …). rPnL page: contract table, OHLC + fill overlay, cumulative rPnL.

`DATABASE_URL` from this folder’s `.env`, else sibling `OPA3/.env` / `OPA6/.env`. Copy `.env.example` if you want a local file.
