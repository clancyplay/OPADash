"""Delta + CoinDCX + Binance fills → fills_export/ (Delta) + Postgres.

  python fetch_fills.py              # all exchanges
  python fetch_fills.py --delta      # Delta only
  python fetch_fills.py --coindcx    # CoinDCX hedge only
  python fetch_fills.py --binance    # Binance hedge only
  python fetch_fills.py --from-file  # import last Delta JSON export

Needs PYTHONPATH to OPA6 (db, fills, orders, env). Keys from OPADash/.env.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import hmac
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

from config.settings import load_env_file
from config.symbol import _REGISTRY

load_env_file()

from db import (
    close as db_close,
    connect as db_connect,
    existing_binance_fill_ids,
    existing_coindcx_fill_ids,
    existing_delta_fill_ids,
    log_fill,
    log_fills_bulk,
)
from env import env, env_float, env_int, log
from fills import Vwap
from orders import _binance, _delta_get

TAG = "fetch_fills.py"

# Delta script overrides (empty = .env)
API_KEY = ""
API_SECRET = ""
REST_URL = ""
DATABASE_URL = ""
NAME = "opa6"

OUT_DIR = Path(__file__).resolve().parent / "fills_export"
DELTA_PAGE_SIZE = 50
DELTA_MAX_PAGES = 50

CDCX_PAGE_SIZE = 100
CDCX_ORDER_MAX_PAGES = 3
CDCX_TRADE_MAX_PAGES = 100
CDCX_WINDOW_DAYS = 7
CDCX_LOOKBACK_DAYS = 90

BINANCE_PAGE_SIZE = 1000
BINANCE_WINDOW_DAYS = 7
BINANCE_LOOKBACK_DAYS = 90


def _clean(val):
    return (val or "").strip().strip('"').strip("'")


def _strategy_name():
    return env("STRATEGY_NAME", NAME)


# ── Delta ─────────────────────────────────────────────────────────────────────

def delta_cfg():
    key = _clean(API_KEY) or env("DELTA_API_KEY")
    secret = _clean(API_SECRET) or env("DELTA_API_SECRET")
    db_url = _clean(DATABASE_URL) or env("DATABASE_URL")
    rest = _clean(REST_URL) or env("DELTA_REST_URL", "https://api.india.delta.exchange")
    if not key or not secret:
        raise SystemExit("set DELTA_API_KEY / DELTA_API_SECRET in .env (or paste in script)")
    return {
        "name": _strategy_name(),
        "api_key": key,
        "api_secret": secret,
        "rest_url": rest.rstrip("/"),
        "database_url": db_url,
        "usdinr": env_float("USDINR_RATE", 87.0),
        "from_env_keys": not _clean(API_KEY),
    }


def _apply_delta_keys(cfg):
    os.environ["DELTA_API_KEY"] = cfg["api_key"]
    os.environ["DELTA_API_SECRET"] = cfg["api_secret"]
    os.environ["DELTA_REST_URL"] = cfg["rest_url"]


def delta_get(path, params=None):
    try:
        return _delta_get(path, params)
    except httpx.HTTPStatusError as exc:
        body = (exc.response.text or "").replace("\n", " ")[:400]
        log(TAG, f"delta {exc.response.status_code} {body}")
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


def _ts_delta(val):
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


def _dt_delta(val):
    ts = _ts_delta(val)
    if not ts:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc)


def fetch_delta_raw():
    rows = []
    after = None
    for page in range(DELTA_MAX_PAGES):
        params = {"page_size": DELTA_PAGE_SIZE}
        if after:
            params["after"] = after
        data = delta_get("/v2/fills", params)
        batch = data.get("result") or []
        if not isinstance(batch, list):
            batch = []
        rows.extend(batch)
        after = (data.get("meta") or {}).get("after")
        log(TAG, f"delta page {page + 1} n={len(batch)} total={len(rows)}")
        if not batch or not after:
            break
    else:
        log(TAG, f"delta stopped at MAX_PAGES={DELTA_MAX_PAGES}")
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


def delta_with_rpnl(fills):
    ordered = sorted(fills, key=lambda f: (_ts_delta(f.get("created_at")), str(f.get("id") or "")))
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


async def save_delta_db(cfg, rows):
    if not cfg["database_url"]:
        log(TAG, "DATABASE_URL empty — skip delta postgres")
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
            created_at=_dt_delta(row.get("created_at")),
        )
        seen.add(fid)
        inserted += 1
    await db_close()
    return inserted, skipped


def save_delta_files(cfg, fills, rows, open_pos):
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


async def run_delta():
    cfg = delta_cfg()
    log(
        TAG,
        f"delta account={cfg['name']} rest={cfg['rest_url']} "
        f"keys={'env' if cfg['from_env_keys'] else 'script'} db={'yes' if cfg['database_url'] else 'no'}",
    )
    _apply_delta_keys(cfg)
    fills = fetch_delta_raw()
    rows, open_pos = delta_with_rpnl(fills)
    json_path, jsonl_path = save_delta_files(cfg, fills, rows, open_pos)
    ins, skip = await save_delta_db(cfg, rows)
    rpnl = sum(float(r.get("rpnl") or 0) for r in rows)
    log(TAG, f"delta wrote {json_path}")
    log(TAG, f"delta wrote {jsonl_path} (raw)")
    log(
        TAG,
        f"delta fills={len(rows)} rpnl_usd={round(rpnl, 4)} rpnl_inr={round(rpnl * cfg['usdinr'], 2)} "
        f"db_insert={ins} db_skip={skip}",
    )


async def run_from_file():
    cfg = delta_cfg()
    files = sorted(OUT_DIR.glob(f"{cfg['name']}_*.json"))
    if not files:
        raise SystemExit(f"no {cfg['name']}_*.json in {OUT_DIR}")
    path = files[-1]
    data = json.loads(path.read_text(encoding="utf-8"))
    rows = data.get("fills") or []
    log(TAG, f"delta import {path.name} n={len(rows)}")
    ins, skip = await save_delta_db(cfg, rows)
    log(TAG, f"delta db_insert={ins} db_skip={skip}")


# ── CoinDCX ───────────────────────────────────────────────────────────────────

def coindcx_cfg():
    key = _clean(env("COINDCX_API_KEY"))
    secret = _clean(env("COINDCX_API_SECRET"))
    db_url = _clean(env("DATABASE_URL"))
    rest = _clean(env("COINDCX_REST_URL", "https://api.coindcx.com")).rstrip("/")
    if not key or not secret:
        raise SystemExit("set COINDCX_API_KEY / COINDCX_API_SECRET in .env")
    if not db_url:
        raise SystemExit("set DATABASE_URL in .env")
    extra = [_clean(p) for p in env("COINDCX_PAIRS", "").split(",") if _clean(p)]
    return {
        "name": _strategy_name(),
        "api_key": key,
        "api_secret": secret,
        "rest_url": rest,
        "database_url": db_url,
        "ccy": env("COINDCX_FUTURES_MARGIN_CCY", "INR").upper() or "INR",
        "lookback_days": env_int("COINDCX_FILLS_LOOKBACK_DAYS", CDCX_LOOKBACK_DAYS),
        "extra_pairs": extra,
    }


def _pair_map():
    out = {}
    for rec in _REGISTRY.values():
        pair = (rec.coindcx_symbol or "").upper()
        if pair:
            out[pair] = rec.delta_symbol.upper()
    return out


def pair_to_contract(pair, mapping):
    p = (pair or "").upper()
    if p in mapping:
        return mapping[p]
    if p.startswith("B-") and p.endswith("_USDT"):
        return p[2:-5] + "USD"
    return p


def _ts_ms(val):
    if val is None:
        return 0.0
    if isinstance(val, (int, float)):
        x = float(val)
        if x > 1e12:
            return x
        if x > 1e9:
            return x * 1000.0
        return x
    return 0.0


def _dt_coindcx(val):
    ms = _ts_ms(val)
    if not ms:
        return None
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc)


def coindcx_fill_id(rec):
    return "|".join([
        str(rec.get("order_id") or ""),
        str(rec.get("timestamp") or ""),
        str(rec.get("side") or ""),
        str(rec.get("price") or ""),
        str(rec.get("quantity") or ""),
        str(rec.get("pair") or ""),
    ])


def _coindcx_post(cfg, path, body):
    payload = json.dumps(body, separators=(",", ":"))
    sig = hmac.new(cfg["api_secret"].encode(), payload.encode(), hashlib.sha256).hexdigest()
    r = httpx.post(
        cfg["rest_url"] + path,
        headers={
            "Content-Type": "application/json",
            "X-AUTH-APIKEY": cfg["api_key"],
            "X-AUTH-SIGNATURE": sig,
            "Accept-Encoding": "identity",
        },
        content=payload,
        timeout=30,
    )
    if r.status_code >= 400:
        brief = (r.text or "").replace("\n", " ")[:400]
        log(TAG, f"coindcx {r.status_code} {path} {brief}")
        r.raise_for_status()
    data = r.json() if r.content else []
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("trades", "data", "orders", "result"):
            val = data.get(key)
            if isinstance(val, list):
                return val
    return []


def fetch_coindcx_pairs(cfg):
    pairs = set()
    for status in ("filled", "partially_filled"):
        for page in range(1, CDCX_ORDER_MAX_PAGES + 1):
            body = {
                "timestamp": int(time.time() * 1000),
                "status": status,
                "page": str(page),
                "size": str(CDCX_PAGE_SIZE),
                "margin_currency_short_name": [cfg["ccy"]],
            }
            try:
                batch = _coindcx_post(cfg, "/exchange/v1/derivatives/futures/orders", body)
            except httpx.HTTPStatusError:
                break
            for rec in batch:
                if isinstance(rec, dict) and rec.get("pair"):
                    pairs.add(str(rec["pair"]).upper())
            log(TAG, f"coindcx orders {status} page {page} n={len(batch)} pairs={len(pairs)}")
            if len(batch) < CDCX_PAGE_SIZE:
                break
    return pairs


def fetch_coindcx_trades(cfg, pair, from_date, to_date):
    rows = []
    for page in range(1, CDCX_TRADE_MAX_PAGES + 1):
        body = {
            "timestamp": int(time.time() * 1000),
            "pair": pair,
            "from_date": from_date,
            "to_date": to_date,
            "page": str(page),
            "size": str(CDCX_PAGE_SIZE),
            "margin_currency_short_name": [cfg["ccy"]],
        }
        try:
            batch = _coindcx_post(cfg, "/exchange/v1/derivatives/futures/trades", body)
        except httpx.HTTPStatusError:
            return rows
        rows.extend(rec for rec in batch if isinstance(rec, dict))
        if len(batch) < CDCX_PAGE_SIZE:
            break
    return rows


def coindcx_date_windows(lookback_days):
    end = datetime.now(timezone.utc).date()
    start = end - timedelta(days=lookback_days)
    windows = []
    cur = start
    while cur <= end:
        nxt = min(cur + timedelta(days=CDCX_WINDOW_DAYS - 1), end)
        windows.append((cur.isoformat(), nxt.isoformat()))
        cur = nxt + timedelta(days=1)
    return windows


def coindcx_with_rpnl(fills):
    ordered = sorted(fills, key=lambda f: (_ts_ms(f.get("timestamp")), coindcx_fill_id(f)))
    books = {}
    out = []
    for rec in ordered:
        pair = str(rec.get("pair") or "")
        books.setdefault(pair, Vwap(1.0))
        side = str(rec.get("side") or "").lower()
        qty = float(rec.get("quantity") or 0)
        px = float(rec.get("price") or 0)
        fee = float(rec.get("fee_amount") or 0)
        rpnl = books[pair].apply(side, qty, px)
        out.append({
            "id": coindcx_fill_id(rec),
            "created_at": rec.get("timestamp"),
            "pair": pair,
            "side": side,
            "size": qty,
            "price": px,
            "commission": fee,
            "order_id": rec.get("order_id"),
            "is_maker": rec.get("is_maker"),
            "margin_ccy": rec.get("margin_currency_short_name"),
            "settlement_px": rec.get("settlement_currency_conversion_price"),
            "rpnl": round(rpnl, 8),
            "cost": qty * px,
            "raw": rec,
        })
    return out, {p: {"size": b.size, "avg": b.avg} for p, b in books.items()}


async def save_coindcx_db(cfg, rows, mapping):
    await db_connect(cfg["database_url"])
    seen = await existing_coindcx_fill_ids(cfg["name"])
    inserted = skipped = 0
    pending = []
    for row in rows:
        fid = str(row.get("id") or "")
        if not fid or fid in seen:
            skipped += 1
            continue
        contract = pair_to_contract(row.get("pair"), mapping)
        pending.append({
            "contract": contract,
            "exchange": "coindcx",
            "order_id": str(row.get("order_id") or ""),
            "side": row["side"],
            "quantity": row["size"],
            "price": row["price"],
            "cost": row.get("cost"),
            "fee": row.get("commission"),
            "rpnl": row.get("rpnl") or None,
            "details": {
                "strategy": cfg["name"],
                "source": "fetch_fills",
                "coindcx_fill_id": fid,
                "pair": row.get("pair"),
                "is_maker": row.get("is_maker"),
                "margin_ccy": row.get("margin_ccy"),
                "settlement_px": row.get("settlement_px"),
            },
            "strategy": cfg["name"],
            "created_at": _dt_coindcx(row.get("created_at")),
        })
        seen.add(fid)
        if len(pending) >= 500:
            inserted += await log_fills_bulk(pending)
            log(TAG, f"coindcx db flushed n={inserted}")
            pending = []
    if pending:
        inserted += await log_fills_bulk(pending)
    await db_close()
    return inserted, skipped


async def run_coindcx():
    cfg = coindcx_cfg()
    mapping = _pair_map()
    log(
        TAG,
        f"coindcx account={cfg['name']} rest={cfg['rest_url']} ccy={cfg['ccy']} "
        f"lookback={cfg['lookback_days']}d db=yes",
    )
    pairs = set(mapping) | {p.upper() for p in cfg["extra_pairs"]}
    discovered = fetch_coindcx_pairs(cfg)
    pairs |= {
        p for p in discovered
        if p in mapping or (p.startswith("B-") and p.endswith("_USDT") and len(p) > 8)
    }
    log(TAG, f"coindcx pairs={sorted(pairs)}")
    fills = []
    for pair in sorted(pairs):
        n_pair = 0
        for from_date, to_date in coindcx_date_windows(cfg["lookback_days"]):
            batch = fetch_coindcx_trades(cfg, pair, from_date, to_date)
            if batch:
                log(TAG, f"coindcx {pair} {from_date}..{to_date} n={len(batch)}")
            fills.extend(batch)
            n_pair += len(batch)
        log(TAG, f"coindcx {pair} total={n_pair}")
    rows, open_pos = coindcx_with_rpnl(fills)
    ins, skip = await save_coindcx_db(cfg, rows, mapping)
    rpnl = sum(float(r.get("rpnl") or 0) for r in rows)
    log(TAG, f"coindcx open_pos={open_pos}")
    log(
        TAG,
        f"coindcx fills={len(rows)} rpnl={round(rpnl, 4)} db_insert={ins} db_skip={skip}",
    )


# ── Binance ───────────────────────────────────────────────────────────────────

def binance_cfg(*, required: bool = True):
    key = _clean(env("BINANCE_API_KEY"))
    secret = _clean(env("BINANCE_API_SECRET"))
    db_url = _clean(env("DATABASE_URL"))
    if not key or not secret:
        if required:
            raise SystemExit("set BINANCE_API_KEY / BINANCE_API_SECRET in .env")
        return None
    if not db_url:
        raise SystemExit("set DATABASE_URL in .env")
    extra = [_clean(s) for s in env("BINANCE_SYMBOLS", "").split(",") if _clean(s)]
    return {
        "name": _strategy_name(),
        "database_url": db_url,
        "lookback_days": env_int("BINANCE_FILLS_LOOKBACK_DAYS", BINANCE_LOOKBACK_DAYS),
        "extra_symbols": [s.upper() for s in extra],
    }


def _binance_symbol_map():
    out = {}
    for rec in _REGISTRY.values():
        sym = (rec.binance_symbol or "").upper()
        if sym:
            out[sym] = rec.delta_symbol.upper()
    return out


def binance_to_contract(symbol, mapping):
    return mapping.get((symbol or "").upper(), (symbol or "").upper())


def binance_time_windows(lookback_days):
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=lookback_days)
    windows = []
    cur = start
    while cur < end:
        nxt = min(cur + timedelta(days=BINANCE_WINDOW_DAYS), end)
        windows.append((int(cur.timestamp() * 1000), int(nxt.timestamp() * 1000)))
        cur = nxt
    return windows


def fetch_binance_user_trades(symbol, start_ms, end_ms):
    rows = []
    from_id = None
    while True:
        if from_id is None:
            params = {
                "symbol": symbol,
                "limit": BINANCE_PAGE_SIZE,
                "startTime": start_ms,
                "endTime": end_ms,
            }
        else:
            # Binance rejects startTime/endTime together with fromId
            params = {"symbol": symbol, "limit": BINANCE_PAGE_SIZE, "fromId": from_id}
        try:
            batch = _binance("GET", "/fapi/v1/userTrades", params)
        except httpx.HTTPStatusError:
            return rows
        if not isinstance(batch, list) or not batch:
            break
        for rec in batch:
            t = int(rec.get("time") or 0)
            if t < start_ms:
                continue
            if t > end_ms:
                return rows
            rows.append(rec)
        if len(batch) < BINANCE_PAGE_SIZE:
            break
        from_id = int(batch[-1]["id"]) + 1
    return rows


def binance_normalize(fills):
    out = []
    for rec in fills:
        if not isinstance(rec, dict):
            continue
        fid = rec.get("id")
        if fid is None:
            continue
        side = str(rec.get("side") or "").lower()
        qty = float(rec.get("qty") or 0)
        px = float(rec.get("price") or 0)
        if qty <= 0 or px <= 0 or side not in ("buy", "sell"):
            continue
        rpnl = float(rec.get("realizedPnl") or 0)
        out.append({
            "id": str(fid),
            "created_at": rec.get("time"),
            "symbol": str(rec.get("symbol") or "").upper(),
            "side": side,
            "size": qty,
            "price": px,
            "commission": float(rec.get("commission") or 0),
            "order_id": str(rec.get("orderId") or ""),
            "rpnl": round(rpnl, 8) if abs(rpnl) > 1e-12 else None,
            "cost": float(rec.get("quoteQty") or qty * px),
            "maker": rec.get("maker"),
            "commission_asset": rec.get("commissionAsset"),
            "raw": rec,
        })
    return out


async def save_binance_db(cfg, rows, mapping):
    await db_connect(cfg["database_url"])
    seen = await existing_binance_fill_ids(cfg["name"])
    inserted = skipped = 0
    pending = []
    for row in rows:
        fid = str(row.get("id") or "")
        if not fid or fid in seen:
            skipped += 1
            continue
        contract = binance_to_contract(row.get("symbol"), mapping)
        pending.append({
            "contract": contract,
            "exchange": "binance",
            "order_id": str(row.get("order_id") or ""),
            "side": row["side"],
            "quantity": row["size"],
            "price": row["price"],
            "cost": row.get("cost"),
            "fee": row.get("commission"),
            "rpnl": row.get("rpnl"),
            "details": {
                "strategy": cfg["name"],
                "source": "fetch_fills",
                "binance_fill_id": fid,
                "symbol": row.get("symbol"),
                "maker": row.get("maker"),
                "commission_asset": row.get("commission_asset"),
            },
            "strategy": cfg["name"],
            "created_at": _dt_coindcx(row.get("created_at")),
        })
        seen.add(fid)
        if len(pending) >= 500:
            inserted += await log_fills_bulk(pending)
            log(TAG, f"binance db flushed n={inserted}")
            pending = []
    if pending:
        inserted += await log_fills_bulk(pending)
    await db_close()
    return inserted, skipped


async def run_binance(*, required: bool = True):
    cfg = binance_cfg(required=required)
    if not cfg:
        log(TAG, "binance skip — BINANCE_API_KEY/SECRET not set")
        return
    mapping = _binance_symbol_map()
    symbols = set(mapping) | set(cfg["extra_symbols"])
    log(
        TAG,
        f"binance account={cfg['name']} lookback={cfg['lookback_days']}d "
        f"symbols={sorted(symbols)} db=yes",
    )
    fills = []
    for symbol in sorted(symbols):
        n_sym = 0
        for start_ms, end_ms in binance_time_windows(cfg["lookback_days"]):
            batch = fetch_binance_user_trades(symbol, start_ms, end_ms)
            if batch:
                log(TAG, f"binance {symbol} {start_ms}..{end_ms} n={len(batch)}")
            fills.extend(batch)
            n_sym += len(batch)
        log(TAG, f"binance {symbol} total={n_sym}")
    rows = binance_normalize(fills)
    ins, skip = await save_binance_db(cfg, rows, mapping)
    rpnl = sum(float(r.get("rpnl") or 0) for r in rows)
    log(
        TAG,
        f"binance fills={len(rows)} rpnl_usd={round(rpnl, 4)} db_insert={ins} db_skip={skip}",
    )


# ── CLI ───────────────────────────────────────────────────────────────────────

def _parse_args(argv):
    p = argparse.ArgumentParser(description="Fetch Delta / CoinDCX / Binance fills into Postgres")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--delta", action="store_true", help="Delta fills only")
    g.add_argument("--coindcx", action="store_true", help="CoinDCX hedge fills only")
    g.add_argument("--binance", action="store_true", help="Binance hedge fills only")
    g.add_argument("--from-file", action="store_true", help="import last Delta JSON from fills_export/")
    return p.parse_args(argv)


async def _main(args):
    if args.from_file:
        await run_from_file()
        return
    if args.delta:
        await run_delta()
        return
    if args.coindcx:
        await run_coindcx()
        return
    if args.binance:
        await run_binance(required=True)
        return
    await run_delta()
    await run_coindcx()
    await run_binance(required=False)


if __name__ == "__main__":
    asyncio.run(_main(_parse_args(sys.argv[1:])))
