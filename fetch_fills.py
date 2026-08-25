"""Delta fills → fills_export/ + Postgres.  python fetch_fills.py"""

from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import httpx

from db import close as db_close, connect as db_connect, existing_delta_fill_ids, log_fill
from env import env, env_float, log
from fills import Vwap
from orders import _delta_get

# Keys khali = .env. India keys → india URL; global keys → api.delta.exchange
API_KEY = ""
API_SECRET = ""
REST_URL = ""
DATABASE_URL = ""
NAME = "opa6"

OUT_DIR = Path(__file__).resolve().parent / "fills_export"
PAGE_SIZE = 50
MAX_PAGES = 50


def _clean(val):
    return (val or "").strip().strip('"').strip("'")


def _cfg():
    key = _clean(API_KEY) or env("DELTA_API_KEY")
    secret = _clean(API_SECRET) or env("DELTA_API_SECRET")
    db_url = _clean(DATABASE_URL) or env("DATABASE_URL")
    rest = _clean(REST_URL) or env("DELTA_REST_URL", "https://api.india.delta.exchange")
    if not key or not secret:
        raise SystemExit("paste API_KEY / API_SECRET upar, ya .env me DELTA_API_KEY / DELTA_API_SECRET")
    return {
        "name": NAME,
        "api_key": key,
        "api_secret": secret,
        "rest_url": rest.rstrip("/"),
        "database_url": db_url,
        "usdinr": env_float("USDINR_RATE", 87.0),
        "from_env_keys": not _clean(API_KEY),
    }


def _apply_keys(cfg):
    os.environ["DELTA_API_KEY"] = cfg["api_key"]
    os.environ["DELTA_API_SECRET"] = cfg["api_secret"]
    os.environ["DELTA_REST_URL"] = cfg["rest_url"]


def delta_get(path, params=None):
    try:
        return _delta_get(path, params)
    except httpx.HTTPStatusError as exc:
        body = (exc.response.text or "").replace("\n", " ")[:400]
        log("fetch_fills.py", f"delta {exc.response.status_code} {body}")
        code = ""
        try:
            code = ((exc.response.json() or {}).get("error") or {}).get("code") or ""
        except Exception:
            pass
        if exc.response.status_code == 401:
            if code == "ip_not_whitelisted_for_api_key":
                raise SystemExit(
                    "Delta is IP ko is API key pe allow nahi karta. "
                    "Delta → API keys → is key pe apna IP add karo (ya whitelist hatao), phir dubara chalao."
                ) from exc
            raise SystemExit(
                "Delta 401: key/secret galat, ya REST_URL match nahi "
                "(India: https://api.india.delta.exchange  Global: https://api.delta.exchange)"
            ) from exc
        raise


def _ts(val):
    if val is None:
        return 0.0
    if isinstance(val, (int, float)):
        x = float(val)
        if x > 1e15:
            return x / 1e6
        if x > 1e12:
            return x / 1e3
        return x
    s = str(val).replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(s).timestamp()
    except ValueError:
        return 0.0


def _dt(val):
    ts = _ts(val)
    if not ts:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc)


def fetch_fills():
    rows = []
    after = None
    for page in range(MAX_PAGES):
        params = {"page_size": PAGE_SIZE}
        if after:
            params["after"] = after
        data = delta_get("/v2/fills", params)
        batch = data.get("result") or []
        if not isinstance(batch, list):
            batch = []
        rows.extend(batch)
        after = (data.get("meta") or {}).get("after")
        log("fetch_fills.py", f"page {page + 1} n={len(batch)} total={len(rows)}")
        if not batch or not after:
            break
    else:
        log("fetch_fills.py", f"stopped at MAX_PAGES={MAX_PAGES}")
    return rows


def contract_value(symbol, cache):
    if symbol in cache:
        return cache[symbol]
    try:
        rec = delta_get(f"/v2/products/{symbol}").get("result") or {}
        cv = float(rec.get("contract_value") or 1)
    except Exception:
        cv = 1.0
    cache[symbol] = cv
    return cv


def with_rpnl(fills):
    ordered = sorted(fills, key=lambda f: (_ts(f.get("created_at")), str(f.get("id") or "")))
    books = {}
    cache = {}
    out = []
    for rec in ordered:
        sy = str(rec.get("product_symbol") or "")
        books.setdefault(sy, Vwap(contract_value(sy, cache) if sy else 1.0))
        side = str(rec.get("side") or "").lower()
        qty = float(rec.get("size") or 0)
        px = float(rec.get("price") or 0)
        fee = float(rec.get("commission") or 0)
        cv = books[sy].cv
        rpnl = books[sy].apply(side, qty, px)
        out.append({
            "id": rec.get("id"),
            "created_at": rec.get("created_at"),
            "product_symbol": sy,
            "product_id": rec.get("product_id"),
            "side": side,
            "size": qty,
            "price": px,
            "commission": fee,
            "role": rec.get("role"),
            "fill_type": rec.get("fill_type"),
            "order_id": rec.get("order_id"),
            "contract_value": cv,
            "rpnl": round(rpnl, 8),
            "cost": qty * px * cv,
            "raw": rec,
        })
    return out, {sy: {"size": b.size, "avg": b.avg, "cv": b.cv} for sy, b in books.items()}


async def save_db(cfg, rows):
    if not cfg["database_url"]:
        log("fetch_fills.py", "DATABASE_URL empty — skip postgres")
        return 0, 0
    await db_connect(cfg["database_url"])
    seen = await existing_delta_fill_ids(cfg["name"])
    inserted = skipped = 0
    for row in rows:
        fid = str(row.get("id") or "")
        if not fid or fid in seen:
            skipped += 1
            continue
        await log_fill(
            row["product_symbol"],
            "delta",
            str(row.get("order_id") or ""),
            row["side"],
            row["size"],
            row["price"],
            cost=row.get("cost"),
            fee=row.get("commission"),
            rpnl=row.get("rpnl") or None,
            details={
                "strategy": cfg["name"],
                "source": "fetch_fills",
                "delta_fill_id": fid,
                "role": row.get("role"),
                "fill_type": row.get("fill_type"),
                "product_id": row.get("product_id"),
            },
            strategy=cfg["name"],
            created_at=_dt(row.get("created_at")),
        )
        seen.add(fid)
        inserted += 1
    await db_close()
    return inserted, skipped


def save_files(cfg, fills, rows, open_pos):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    base = OUT_DIR / f"{cfg['name']}_{stamp}"
    payload = {
        "account": cfg["name"],
        "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "rest_url": cfg["rest_url"],
        "n": len(rows),
        "usdinr": cfg["usdinr"],
        "open_pos": open_pos,
        "fills": [{k: v for k, v in r.items() if k != "raw"} for r in rows],
    }
    json_path = base.with_suffix(".json")
    jsonl_path = Path(str(base) + ".jsonl")
    json_path.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    with jsonl_path.open("w", encoding="utf-8") as fh:
        for rec in fills:
            fh.write(json.dumps(rec, default=str) + "\n")
    return json_path, jsonl_path


async def run():
    cfg = _cfg()
    log(
        "fetch_fills.py",
        f"account={cfg['name']} rest={cfg['rest_url']} keys={'env' if cfg['from_env_keys'] else 'script'} "
        f"db={'yes' if cfg['database_url'] else 'no'}",
    )
    _apply_keys(cfg)
    fills = fetch_fills()
    rows, open_pos = with_rpnl(fills)
    json_path, jsonl_path = save_files(cfg, fills, rows, open_pos)
    ins, skip = await save_db(cfg, rows)
    rpnl = sum(float(r.get("rpnl") or 0) for r in rows)
    log("fetch_fills.py", f"wrote {json_path}")
    log("fetch_fills.py", f"wrote {jsonl_path} (raw fills)")
    log(
        "fetch_fills.py",
        f"fills={len(rows)} rpnl_usd={round(rpnl, 4)} rpnl_inr={round(rpnl * cfg['usdinr'], 2)} "
        f"db_insert={ins} db_skip={skip}",
    )


async def run_from_file():
    cfg = _cfg()
    files = sorted(OUT_DIR.glob(f"{cfg['name']}_*.json"))
    if not files:
        raise SystemExit(f"no {cfg['name']}_*.json in {OUT_DIR}")
    path = files[-1]
    data = json.loads(path.read_text(encoding="utf-8"))
    rows = data.get("fills") or []
    log("fetch_fills.py", f"import {path.name} n={len(rows)}")
    ins, skip = await save_db(cfg, rows)
    log("fetch_fills.py", f"db_insert={ins} db_skip={skip}")


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] in ("--from-file", "from-file"):
        asyncio.run(run_from_file())
    else:
        asyncio.run(run())
