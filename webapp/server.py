"""OPADash — fills / PnL viewer. No trading.

    uvicorn webapp.server:app --reload --port 8800
    http://127.0.0.1:8800
"""
from __future__ import annotations

import csv
import io
import logging
import os
import re
import secrets
import time
import zipfile
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote

import httpx
from fastapi import Depends, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from config.settings import Settings
from config.symbol import SYMBOL_LAB, SYMBOL_MMT, SYMBOL_VELVET, SYMBOL_AIOT
from config import symbol as _symbol_module
from utils.events_db import EventsDB, canon_contract, contract_aliases, ping_is_live
from utils.logger import start_db_log_forwarder

logger = logging.getLogger("webapp")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

settings = Settings.from_env()

_db: EventsDB | None = None
_db_error: str = ""


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _db, _db_error
    log_task = None
    if settings.database_url:
        logger.info("webapp: connecting to database...")
        _db = EventsDB(settings.database_url, usdinr_rate=settings.usdinr_rate)
        try:
            await _db.connect()
            if _db.pool:
                logger.info("webapp: database connected")
                log_task = start_db_log_forwarder(_db, service="webapp")
            else:
                _db_error = "DB pool not established — check DATABASE_URL"
                logger.warning("webapp: %s", _db_error)
        except Exception as e:
            _db_error = str(e)
            logger.error("webapp: database connection failed: %s", e)
            _db = None
    else:
        _db_error = "DATABASE_URL env var not set"
        logger.warning("webapp: %s", _db_error)
    yield
    if log_task:
        log_task.cancel()
    if _db:
        await _db.close()
        logger.info("webapp: database closed")


_basic_security = HTTPBasic(auto_error=True)

def _verify_auth(credentials: HTTPBasicCredentials = Depends(_basic_security)) -> None:
    expected_pass = os.getenv("DASHBOARD_PASSWORD", "")
    if not expected_pass:
        return  # no password configured — open access (local dev)
    expected_user = os.getenv("DASHBOARD_USERNAME", "admin")
    user_ok = secrets.compare_digest(credentials.username.encode(), expected_user.encode())
    pass_ok = secrets.compare_digest(credentials.password.encode(), expected_pass.encode())
    if not (user_ok and pass_ok):
        raise HTTPException(status_code=401, detail="Unauthorized",
                            headers={"WWW-Authenticate": "Basic"})

# Auth on HTTP routes only — WebSocket handshakes cannot carry Basic auth headers.
# The /ws/* endpoints are read-only and carry no secrets, so they are left open.
app = FastAPI(title="OPADash", lifespan=lifespan)

def _http_auth_middleware(app_):
    """Apply Basic auth to all non-WebSocket requests."""
    from starlette.middleware.base import BaseHTTPMiddleware
    from starlette.responses import Response

    class _AuthMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            expected_pass = os.getenv("DASHBOARD_PASSWORD", "")
            public_paths = {"/api/health", "/healthz"}
            if (
                not expected_pass
                or request.url.path.startswith("/ws/")
                or request.url.path in public_paths
            ):
                return await call_next(request)
            auth = request.headers.get("Authorization", "")
            if not auth.startswith("Basic "):
                return Response(
                    "Unauthorized", status_code=401,
                    headers={"WWW-Authenticate": "Basic realm=\"OPADash\""},
                )
            import base64
            try:
                user, _, pw = base64.b64decode(auth[6:]).decode().partition(":")
            except Exception:
                user = pw = ""
            expected_user = os.getenv("DASHBOARD_USERNAME", "admin")
            if not (secrets.compare_digest(user.encode(), expected_user.encode()) and
                    secrets.compare_digest(pw.encode(), expected_pass.encode())):
                return Response(
                    "Unauthorized", status_code=401,
                    headers={"WWW-Authenticate": "Basic realm=\"OPADash\""},
                )
            return await call_next(request)

    app_.add_middleware(_AuthMiddleware)

_http_auth_middleware(app)

STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

_SYMBOLS = {
    "LAB": SYMBOL_LAB,
    "VELVET": SYMBOL_VELVET,
    "MMT": SYMBOL_MMT,
    "AIOT": SYMBOL_AIOT,
}

# Delta lots -> underlying units conversion per contract (fills/positions store lots for delta)
_CONTRACT_VALUE = {cfg.delta_symbol: float(cfg.contract_value) for cfg in _SYMBOLS.values()}

# Extend with every SymbolConfig defined in config.symbol so rPnL for any
# contract present in the DB (not just the dashboard's 4) converts correctly.
from config.symbol import SymbolConfig as _SymbolConfig, load_symbols as _load_symbols
_ALL_CFGS: list[_SymbolConfig] = [
    _cfg for _cfg in vars(_symbol_module).values() if isinstance(_cfg, _SymbolConfig)
]
try:
    for _cfg in _load_symbols():
        _ALL_CFGS.append(_cfg)
except Exception:
    pass
# Last matching config wins (SYMBOLS_JSON overrides hardcoded).
_by_delta: dict[str, _SymbolConfig] = {}
for _cfg in _ALL_CFGS:
    _by_delta[(_cfg.delta_symbol or "").upper()] = _cfg
_ALL_CFGS = list(_by_delta.values())
for _cfg in _ALL_CFGS:
    _CONTRACT_VALUE.setdefault(_cfg.delta_symbol, float(_cfg.contract_value))


_VENUE_LABEL = {
    "delta": "Delta",
    "binance": "Binance",
    "kucoin": "KuCoin",
    "coindcx": "CoinDCX",
    "aster": "Aster",
    "bybit": "Bybit",
    "coinbase": "Coinbase",
}


def _norm_quote_venue(raw: str | None) -> str:
    v = (raw or "delta").strip().lower()
    aliases = {
        "b": "binance", "binance": "binance",
        "k": "kucoin", "kucoin": "kucoin",
        "c": "coindcx", "coindcx": "coindcx",
        "a": "aster", "aster": "aster",
        "y": "bybit", "bybit": "bybit",
        "g": "coinbase", "cb": "coinbase", "coinbase": "coinbase",
        "d": "delta", "delta": "delta",
    }
    return aliases.get(v, v or "delta")


def _cfg_for_contract(name: str) -> _SymbolConfig | None:
    u = (name or "").upper().strip()
    if not u:
        return None
    canon = canon_contract(u)
    for cfg in _ALL_CFGS:
        names = {
            (cfg.delta_symbol or "").upper(),
            (cfg.binance_symbol or "").upper(),
            (cfg.coindcx_symbol or "").upper(),
            canon_contract(cfg.delta_symbol or ""),
            canon_contract(cfg.binance_symbol or ""),
        }
        names.discard("")
        if u in names or canon in names:
            return cfg
    return None


def _base_asset(name: str) -> str:
    """LISTAUSD / LISTAUSDT / LISTAUSDTM / B-LISTA_USDT / ETH-USD -> LISTA / ETH."""
    u = (name or "").upper().strip()
    if u.startswith("B-") and "_" in u:
        return u[2:].split("_", 1)[0]
    u = u.replace("-", "")
    for suffix in ("USDTM", "PERPINTX", "PERP", "USDT", "USDC", "USD"):
        if u.endswith(suffix) and len(u) > len(suffix):
            return u[: -len(suffix)]
    return u


def _venue_symbol(cfg: _SymbolConfig | None, venue: str, contract: str) -> str:
    """Exchange-native symbol for a venue, from config when available."""
    if cfg is not None:
        by_venue = {
            "delta": cfg.delta_symbol,
            "binance": cfg.binance_symbol,
            "coindcx": cfg.coindcx_symbol,
        }
        named = by_venue.get(venue)
        if named:
            return named
    base = _base_asset(contract)
    if not base:
        return (contract or "").upper()
    if venue in ("binance", "aster", "bybit"):
        return f"{base}USDT"
    if venue == "kucoin":
        return f"{base}USDTM"
    if venue == "coindcx":
        return f"B-{base}_USDT"
    if venue == "coinbase":
        u = (contract or "").upper().replace("-", "").replace("_", "")
        if u.endswith("PERPINTX") or u.endswith("PERP") or "PERP" in u:
            return f"{base}-PERP"
        return f"{base}-USD"
    return (contract or "").upper()


def venue_meta(contract: str, counts: dict[str, int] | None = None) -> dict:
    """Which exchange quotes this contract and which (if any) hedges it.

    `counts` is fills-per-exchange from the DB. Driving every caller off the
    same counts keeps the pills, the dropdown and the chart in agreement, and
    means a contract that was never hedged reports no hedge at all.
    """
    counts = {v: n for v, n in (counts or {}).items() if n}
    cfg = _cfg_for_contract(contract)
    quote = ""
    if cfg is not None:
        cfg_quote = _norm_quote_venue(cfg.quote_venue)
        # Config states the intent; the data wins if that venue never traded.
        if not counts or counts.get(cfg_quote):
            quote = cfg_quote
    if not quote:
        quote = max(counts, key=lambda v: counts[v]) if counts else "delta"
    hedges = {v: n for v, n in counts.items() if v != quote}
    hedge = max(hedges, key=lambda v: hedges[v]) if hedges else ""
    quote_symbol = _venue_symbol(cfg, quote, contract)
    return {
        "contract": canon_contract(contract) or (contract or "").upper(),
        "quote_venue": quote,
        "quote_label": _VENUE_LABEL.get(quote, quote.title()),
        "quote_symbol": quote_symbol,
        "hedge_venue": hedge,
        "hedge_label": _VENUE_LABEL.get(hedge, hedge.title()) if hedge else "",
        "hedge_symbol": _venue_symbol(cfg, hedge, contract) if hedge else "",
        "has_hedge": bool(hedge),
        "venue_fills": counts,
        "label": f"{quote_symbol} · {_VENUE_LABEL.get(quote, quote.title())}",
    }


async def resolve_venues(
    contract: str, strategy: str = "opa3", account: str | None = None,
) -> dict:
    """`venue_meta` with the fill counts read from the DB."""
    counts: dict[str, int] = {}
    if _db is not None and _db.pool:
        counts = await _db.get_contract_venue_stats(
            contract, strategy=strategy, account=account,
        )
    return venue_meta(contract, counts)


def _venue_side(exchange: str | None) -> str:
    """Normalise the UI's venue filter. Legacy names kept working."""
    e = (exchange or "both").strip().lower()
    if e in ("quote", "delta"):
        return "quote"
    if e in ("hedge", "coindcx", "binance", "kucoin", "aster", "bybit", "coinbase", "not_quote"):
        return "hedge"
    return "both"


def _hedge_venue_label(raw: str | None) -> str:
    v = (raw or "").strip()
    codes = {
        "B": "Binance", "C": "CoinDCX", "K": "KuCoin", "A": "Aster",
        "Y": "Bybit", "G": "Coinbase", "D": "Delta",
        "binance": "Binance", "coindcx": "CoinDCX", "kucoin": "KuCoin",
        "aster": "Aster", "bybit": "Bybit", "coinbase": "Coinbase", "delta": "Delta",
    }
    return codes.get(v, codes.get(v.lower(), v))


_SETUP_KEYS = (
    "hem", "span", "step", "fit_auto", "vol_gate", "vol_stable",
    "orders", "live_orders", "max_pos", "max_usd", "ignore", "ignore_usd",
    "stop_pause", "fate", "k", "k_ticks", "flatten", "flow_gate", "edge",
)
_SYMBOL_STRATS = {"opa3", "opa4"}


def _cfg_public(cfg: _SymbolConfig | None) -> dict | None:
    """SymbolConfig fields the user set in SYMBOLS_JSON / ACTIVE_SYMBOLS — no secrets."""
    if cfg is None:
        return None
    from dataclasses import asdict
    d = asdict(cfg)
    d["kind"] = "symbol"
    d["quote_venue"] = _norm_quote_venue(d.get("quote_venue"))
    d["hedge_venue_label"] = _hedge_venue_label(d.get("hedge_venue"))
    return d


def _setup_public(setup: dict | None) -> dict | None:
    """OPA6 live knobs (hem/span/FIT_AUTO/MAX_POSITION) — same payload Telegram uses."""
    if not isinstance(setup, dict) or not setup:
        return None
    out: dict = {"kind": "setup"}
    for key in _SETUP_KEYS:
        if key not in setup or setup[key] is None:
            continue
        val = setup[key]
        if isinstance(val, bool):
            out[key] = val
        elif isinstance(val, (int, float)):
            out[key] = int(val) if isinstance(val, int) or (isinstance(val, float) and val.is_integer()) else float(val)
        elif isinstance(val, str) and val.lower() in ("true", "false", "on", "off", "1", "0"):
            out[key] = val.lower() in ("true", "on", "1")
        elif isinstance(val, str):
            try:
                out[key] = float(val) if "." in val else int(val)
            except ValueError:
                continue
    if "max_usd" in out:
        out.pop("max_pos", None)
    return out if len(out) > 1 else None


def _lookup_setup(
    setups: dict[tuple[str, str], dict], contract: str, account: str,
) -> dict | None:
    c = canon_contract(contract)
    a = account or ""
    if (c, a) in setups:
        return setups[(c, a)]
    if a and (c, "") in setups:
        return setups[(c, "")]
    return None


def _annotate_rpnl_row(
    row: dict,
    setups: dict[tuple[str, str], dict] | None = None,
    strategy: str = "",
) -> dict:
    """Split a summary row into quote-venue vs hedge-venue rPnL."""
    counts_all = dict(row.get("venue_fills_all") or row.get("venue_fills") or {})
    counts = dict(row.get("venue_fills") or {})
    rpnls = dict(row.get("venue_rpnl") or {})
    meta = venue_meta(row.get("contract") or "", counts_all)
    qv = meta["quote_venue"]
    row = dict(row)
    row.update(meta)
    row["rpnl"] = round(rpnls.get(qv, 0.0), 2)
    row["fills"] = counts.get(qv, 0)
    row["hedge_rpnl"] = round(sum(v for k, v in rpnls.items() if k != qv), 2)
    row["hedge_fills"] = sum(n for k, n in counts.items() if k != qv)
    acct = row.get("account") or ""
    row["label"] = meta["label"] + (f" · {acct}" if acct else "")
    row["live"] = bool(row.get("live"))
    setup = _setup_public(_lookup_setup(setups or {}, row.get("contract") or "", acct))
    if setup:
        row["settings"] = setup
    elif (strategy or "").strip().lower() in _SYMBOL_STRATS:
        row["settings"] = _cfg_public(_cfg_for_contract(row.get("contract") or ""))
    else:
        row["settings"] = None
    return row

# Delta candle resolution -> seconds per candle, used to size the start/end window
_RESOLUTION_SECONDS = {
    "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200,
    "4h": 14400, "1d": 86400,
}


def _ist_midnight_utc() -> datetime:
    now = datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return start - timedelta(hours=5, minutes=30)


def _window_since(hours: int | None, today: bool = False) -> datetime | None:
    if today:
        return _ist_midnight_utc()
    if hours:
        return datetime.now(timezone.utc) - timedelta(hours=hours)
    return None


def _window_lookback_secs(hours: int | None, today: bool = False) -> int:
    if today:
        return max(60, int((datetime.now(timezone.utc) - _ist_midnight_utc()).total_seconds()))
    return max(60, int(hours or 24) * 3600)


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
async def health() -> dict:
    """DB connection status — used by frontend + platform health checks."""
    if _db and _db.pool:
        try:
            async with _db.pool.acquire() as conn:
                count = await conn.fetchval("SELECT COUNT(*) FROM fills")
            return {"status": "ok", "db": "ok", "fills_count": int(count)}
        except Exception as e:
            return {"status": "degraded", "db": "error", "detail": str(e)}
    return {"status": "degraded", "db": "disconnected", "detail": _db_error or "no pool"}


@app.get("/healthz")
async def healthz() -> dict:
    """Unauthenticated liveness endpoint for Railway health checks."""
    return {"status": "ok"}


@app.get("/api/symbols")
async def list_symbols() -> list[dict]:
    return [
        {"key": key, "delta_symbol": cfg.delta_symbol, "binance_symbol": cfg.binance_symbol}
        for key, cfg in _SYMBOLS.items()
    ]


async def _fetch_delta_history(symbol: str, resolution: str, lookback_secs: int) -> list[dict]:
    """Public candle history — no auth required. MARK: prefix gets mark price (not trade price)."""
    end = int(time.time())
    start = end - lookback_secs
    async with httpx.AsyncClient(base_url=settings.delta_rest_url, timeout=10, verify=False) as client:
        resp = await client.get(
            "/v2/history/candles",
            params={"resolution": resolution, "symbol": f"MARK:{symbol}", "start": start, "end": end},
        )
        resp.raise_for_status()
        result = resp.json().get("result", []) or []
    points = [{"time": int(c["time"]), "value": float(c["close"])} for c in result]
    points.sort(key=lambda p: p["time"])
    return points


async def _fetch_binance_mark_history(symbol: str, interval: str, limit: int) -> list[dict]:
    """Public mark-price kline history — no auth required."""
    async with httpx.AsyncClient(base_url=settings.binance_rest_url, timeout=10) as client:
        resp = await client.get(
            "/fapi/v1/markPriceKlines",
            params={"symbol": symbol.upper(), "interval": interval, "limit": limit},
        )
        resp.raise_for_status()
        raw = resp.json()
    points = [{"time": int(row[0] // 1000), "value": float(row[4])} for row in raw]
    points.sort(key=lambda p: p["time"])
    return points


@app.get("/api/history")
async def history(
    symbol: str = Query(..., description="Symbol key: LAB, VELVET, MMT"),
    interval: str = Query("1m"),
    limit: int = Query(500, ge=10, le=1500),
) -> dict:
    cfg = _SYMBOLS.get(symbol.upper())
    if cfg is None:
        raise HTTPException(status_code=404, detail=f"unknown symbol '{symbol}'")

    lookback_secs = _RESOLUTION_SECONDS.get(interval, 60) * limit

    try:
        delta_points = await _fetch_delta_history(cfg.delta_symbol, interval, lookback_secs)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"delta history failed: {exc}") from exc

    try:
        binance_points = await _fetch_binance_mark_history(cfg.binance_symbol, interval, limit)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"binance history failed: {exc}") from exc

    return {
        "delta_symbol": cfg.delta_symbol,
        "binance_symbol": cfg.binance_symbol,
        "delta": delta_points,
        "binance": binance_points,
    }


@app.get("/api/strategies")
async def list_strategies() -> list[str]:
    """Distinct strategy tags present in the DB (for the dashboard dropdown).
    'opa3' is always first so the default view is unchanged."""
    if _db is None or not _db.pool:
        return ["opa3"]
    return await _db.get_strategies()


@app.get("/api/positions/symbols")
async def position_symbols(
    strategy: str = Query("opa3", description="strategy tag, e.g. opa3 | opa4"),
) -> list[str]:
    """Distinct contracts that have position snapshots in the DB."""
    if _db is None or not _db.pool:
        return []
    return await _db.get_position_symbols(strategy=strategy)


@app.get("/api/positions")
async def position_history(
    symbol: str = Query(..., description="Contract name e.g. LABUSD"),
    hours: int = Query(24, ge=1, le=168),
    strategy: str = Query("opa3", description="strategy tag, e.g. opa3 | opa4"),
) -> dict:
    """Position size history for a contract over the last `hours` hours."""
    if _db is None or not _db.pool:
        raise HTTPException(status_code=503, detail=f"Database not connected: {_db_error or 'no pool'}")
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    points = await _db.get_position_history(symbol.upper(), since, strategy=strategy)
    logger.info("webapp: positions %s %dh -> %d points", symbol.upper(), hours, len(points))
    return {"contract": symbol.upper(), "points": points}


@app.get("/api/rpnl/symbols")
async def rpnl_symbols(
    strategy: str = Query("opa3", description="strategy tag, e.g. opa3 | opa4"),
) -> list[dict]:
    """Distinct contract+account pairs that have fills in the DB."""
    if _db is None or not _db.pool:
        return []
    try:
        async with _db.pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT contract,
                       COALESCE(account::text, '') AS account,
                       LOWER(exchange) AS exchange,
                       COUNT(*)::int AS n
                FROM fills
                WHERE strategy::text = $1
                GROUP BY contract, COALESCE(account::text, ''), LOWER(exchange)
                ORDER BY contract, account
                """,
                strategy,
            )
        # Keyed on the account id, exactly like /api/rpnl/summary, so every pill
        # has one matching dropdown entry and the account filter resolves.
        merged: dict[tuple[str, str], dict] = {}
        for r in rows:
            account = r["account"] or ""
            contract = canon_contract(r["contract"])
            entry = merged.setdefault((contract, account), {
                "contract": contract,
                "account": account,
                "counts": {},
            })
            venue = (r["exchange"] or "delta").lower()
            entry["counts"][venue] = entry["counts"].get(venue, 0) + int(r["n"] or 0)
        out = []
        for entry in merged.values():
            counts = entry["counts"]
            if not entry["account"] and counts.get("delta"):
                continue
            meta = venue_meta(entry["contract"], entry.pop("counts"))
            name = entry["account"]
            out.append({
                **entry,
                **{k: meta[k] for k in (
                    "quote_venue", "quote_label", "quote_symbol",
                    "hedge_venue", "hedge_label", "hedge_symbol", "has_hedge",
                )},
                "label": meta["label"] + (f" · {name}" if name else ""),
            })
        if _db is not None:
            keys = await _db.get_live_ping_keys(strategy)
            for entry in out:
                entry["live"] = ping_is_live(entry["contract"], entry["account"], keys)
            out.sort(key=lambda e: (0 if e.get("live") else 1, e["contract"], e["account"]))
        return out
    except Exception as e:
        logger.warning("webapp: rpnl_symbols failed: %s", e)
        return []


@app.get("/api/rpnl")
async def rpnl_chart(
    symbol: str = Query(..., description="Contract name (e.g. LABUSD) or symbol key (e.g. LAB)"),
    hours: int = Query(24, ge=1, le=2160, description="Lookback window in hours"),
    today: bool = Query(False, description="Restrict to IST calendar day"),
    bucket: int = Query(5, ge=1, le=60, description="Bucket size in minutes"),
    strategy: str = Query("opa3", description="strategy tag, e.g. opa3 | opa4"),
    account: str | None = Query(None, description="Delta account id; omit to merge all"),
    exchange: str = Query("both", description="quote | hedge | both"),
) -> dict:
    """Cumulative rPnL timeseries for a contract, bucketed by `bucket` minutes."""
    cfg = _SYMBOLS.get(symbol.upper())
    contract = cfg.delta_symbol if cfg else symbol.upper()
    if _db is None or not _db.pool:
        raise HTTPException(status_code=503, detail=f"Database not connected: {_db_error or 'no pool'}")
    meta = await resolve_venues(contract, strategy=strategy, account=account)
    qv = meta["quote_venue"]
    want = _venue_side(exchange)
    since = _window_since(hours, today)
    try:
        points: list[dict] = []
        hedge_points: list[dict] = []
        if want in ("quote", "both"):
            points = await _db.get_rpnl_timeseries(
                contract, since, bucket_minutes=bucket, strategy=strategy,
                account=account, exchange="quote", quote_venue=qv,
            )
        # Never draw a hedge series for a contract that was never hedged.
        if want in ("hedge", "both") and meta["has_hedge"]:
            hedge_points = await _db.get_rpnl_timeseries(
                contract, since, bucket_minutes=bucket, strategy=strategy,
                account=None, exchange="not_quote", quote_venue=qv,
            )
    except Exception as e:
        logger.error("webapp: rpnl query failed for %s: %s", contract, e)
        raise HTTPException(status_code=500, detail=f"query failed: {e}") from e
    logger.info(
        "webapp: rpnl %s quote=%s account=%s exch=%s %s -> %d points hedge=%d",
        contract, qv, account or "-", exchange, "today" if today else f"{hours}h",
        len(points), len(hedge_points),
    )
    return {
        "contract": contract,
        "account": account or "",
        "exchange": exchange,
        **meta,
        "points": points,
        "hedge_points": hedge_points,
    }


@app.get("/api/rpnl/summary")
async def rpnl_summary(
    strategy: str = Query("opa3"),
    hours: int | None = Query(None, ge=1, le=2160, description="lookback window; omit for all-time"),
    today: bool = Query(False, description="Restrict to IST calendar day"),
) -> list[dict]:
    """Per-contract realized PnL from fills (for the rPnL page pills)."""
    if _db is None or not _db.pool:
        raise HTTPException(status_code=503, detail=f"Database not connected: {_db_error or 'no pool'}")
    since = _window_since(hours, today)
    rows = await _db.get_contract_rpnl_summary(strategy=strategy, since=since)
    setups = await _db.get_bot_setups(strategy)
    return [_annotate_rpnl_row(r, setups, strategy) for r in rows]


@app.get("/api/rpnl/rollup")
async def rpnl_rollup(
    strategy: str = Query("opa3"),
    hours: int | None = Query(None, ge=1, le=8760, description="omit for all time"),
    today: bool = Query(False, description="Restrict to IST calendar day"),
) -> dict:
    """Quote vs hedge rPnL totals, per symbol and per IST day."""
    if _db is None or not _db.pool:
        raise HTTPException(status_code=503, detail=f"Database not connected: {_db_error or 'no pool'}")
    since = _window_since(hours, today)
    rows = await _db.get_rpnl_rollup(strategy=strategy, since=since)

    # Decide each contract's quote venue once, from its fills across the window.
    counts: dict[str, dict[str, int]] = {}
    for r in rows:
        counts.setdefault(r["contract"], {})
        counts[r["contract"]][r["exchange"]] = (
            counts[r["contract"]].get(r["exchange"], 0) + r["fills"]
        )
    metas = {c: venue_meta(c, n) for c, n in counts.items()}

    def blank() -> dict:
        return {"quote": 0.0, "hedge": 0.0, "total": 0.0, "fills": 0}

    totals, by_symbol, by_day = blank(), {}, {}
    for r in rows:
        meta = metas[r["contract"]]
        side = "quote" if r["exchange"] == meta["quote_venue"] else "hedge"
        sym = by_symbol.setdefault(r["contract"], {**blank(), "contract": r["contract"],
                                                  "quote_label": meta["quote_label"]})
        day = by_day.setdefault(r["date"], {**blank(), "date": r["date"]})
        for bucket in (totals, sym, day):
            bucket[side] += r["rpnl"]
            bucket["total"] += r["rpnl"]
            bucket["fills"] += r["fills"]

    def rounded(d: dict) -> dict:
        return {k: (round(v, 2) if isinstance(v, float) else v) for k, v in d.items()}

    return {
        "strategy": strategy,
        "hours": hours,
        "totals": rounded(totals),
        "by_symbol": sorted(
            (rounded(s) for s in by_symbol.values()),
            key=lambda s: abs(s["total"]), reverse=True,
        ),
        "by_day": sorted(
            (rounded(d) for d in by_day.values()),
            key=lambda d: d["date"], reverse=True,
        ),
    }


@app.get("/api/rpnl/fills")
async def rpnl_fills(
    symbol: str = Query(...),
    hours: int = Query(24, ge=1, le=2160),
    today: bool = Query(False, description="Restrict to IST calendar day"),
    strategy: str = Query("opa3"),
    account: str | None = Query(None),
    exchange: str = Query("quote", description="quote | hedge"),
    bucket: int = Query(5, ge=1, le=1440),
) -> dict:
    """Fills in the window — overlay on OHLC. One side per request."""
    cfg = _SYMBOLS.get(symbol.upper())
    contract = cfg.delta_symbol if cfg else symbol.upper()
    if _db is None or not _db.pool:
        raise HTTPException(status_code=503, detail=f"Database not connected: {_db_error or 'no pool'}")
    meta = await resolve_venues(contract, strategy=strategy, account=account)
    side = _venue_side(exchange)
    since = _window_since(hours, today)
    fills: list[dict] = []
    if side != "hedge" or meta["has_hedge"]:
        fills = await _db.get_fill_markers(
            contract, since, strategy=strategy, account=account,
            exchange="not_quote" if side == "hedge" else "quote",
            bucket_seconds=max(60, int(bucket) * 60), quote_venue=meta["quote_venue"],
        )
    return {
        "contract": contract,
        "account": account or "",
        "exchange": side,
        **meta,
        "fills": fills,
    }


def _num(v, default: float = 0.0) -> float:
    try:
        return float(v) if v is not None else default
    except (TypeError, ValueError):
        return default


def _candle_volume(c: dict) -> float:
    """Delta candles use `volume`; some payloads only have turnover."""
    for key in ("volume", "turnover"):
        if c.get(key) is not None:
            return _num(c.get(key))
    return 0.0


async def _fetch_delta_ohlc(symbol: str, resolution: str, lookback_secs: int) -> list[dict]:
    """Trade OHLC candles (not MARK:). Chunked so long windows still fill."""
    end = int(time.time())
    start = end - lookback_secs
    step = _RESOLUTION_SECONDS.get(resolution, 60) * 1500
    by_t: dict[int, dict] = {}
    t0 = start
    async with httpx.AsyncClient(base_url=settings.delta_rest_url, timeout=20, verify=False) as client:
        while t0 < end:
            t1 = min(t0 + step, end)
            resp = await client.get(
                "/v2/history/candles",
                params={"resolution": resolution, "symbol": symbol, "start": t0, "end": t1},
            )
            resp.raise_for_status()
            for c in resp.json().get("result", []) or []:
                ts = int(c["time"])
                by_t[ts] = {
                    "time": ts,
                    "open": _num(c["open"]),
                    "high": _num(c["high"]),
                    "low": _num(c["low"]),
                    "close": _num(c["close"]),
                    "volume": _candle_volume(c),
                }
            if t1 >= end:
                break
            t0 = t1
    return sorted(by_t.values(), key=lambda p: p["time"])


_BINANCE_INTERVAL = {
    "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
    "1h": "1h", "2h": "2h", "4h": "4h", "1d": "1d",
}


async def _fetch_binance_ohlc(
    symbol: str, interval: str, lookback_secs: int, base_url: str | None = None,
) -> list[dict]:
    """USDT-M futures trade klines. Aster serves the same /fapi/v1 shape."""
    end_ms = int(time.time() * 1000)
    start_ms = (int(time.time()) - lookback_secs) * 1000
    ivl = _BINANCE_INTERVAL.get(interval, "5m")
    by_t: dict[int, dict] = {}
    t0 = start_ms
    async with httpx.AsyncClient(base_url=base_url or settings.binance_rest_url, timeout=20) as client:
        while t0 < end_ms:
            resp = await client.get(
                "/fapi/v1/klines",
                params={
                    "symbol": symbol.upper(),
                    "interval": ivl,
                    "startTime": t0,
                    "endTime": end_ms,
                    "limit": 1500,
                },
            )
            resp.raise_for_status()
            rows = resp.json() or []
            if not rows:
                break
            for row in rows:
                ts = int(row[0] // 1000)
                by_t[ts] = {
                    "time": ts,
                    "open": _num(row[1]),
                    "high": _num(row[2]),
                    "low": _num(row[3]),
                    "close": _num(row[4]),
                    "volume": _num(row[5] if len(row) > 5 else 0),
                }
            last_open = int(rows[-1][0])
            nxt = last_open + 1
            if nxt <= t0:
                break
            t0 = nxt
            if len(rows) < 1500:
                break
    return sorted(by_t.values(), key=lambda p: p["time"])


_KUCOIN_GRANULARITY = {
    "1m": 1, "3m": 5, "5m": 5, "15m": 15, "30m": 30,
    "1h": 60, "2h": 120, "4h": 240, "1d": 1440,
}
_kucoin_symbols_cache: dict[str, tuple[float, dict[str, str]]] = {}


async def _kucoin_symbol_map() -> dict[str, str]:
    """base asset -> KuCoin futures symbol (e.g. 2U2 -> 2U2USDTM), cached 1h."""
    cached = _kucoin_symbols_cache.get("map")
    if cached and time.time() - cached[0] < 3600:
        return cached[1]
    out: dict[str, str] = {}
    try:
        async with httpx.AsyncClient(base_url=settings.kucoin_rest_url, timeout=20) as client:
            resp = await client.get("/api/v1/contracts/active")
            resp.raise_for_status()
            for c in resp.json().get("data") or []:
                sym = (c.get("symbol") or "").upper()
                base = (c.get("baseCurrency") or "").upper()
                quote = (c.get("quoteCurrency") or "").upper()
                if sym and base and quote == "USDT":
                    out.setdefault(base, sym)
    except Exception as exc:
        logger.warning("webapp: kucoin contract list failed: %s", exc)
        return cached[1] if cached else {}
    _kucoin_symbols_cache["map"] = (time.time(), out)
    return out


async def _fetch_kucoin_ohlc(symbol: str, interval: str, lookback_secs: int) -> list[dict]:
    """KuCoin USDT-M futures klines: [time_ms, open, high, low, close, vol]."""
    gran = _KUCOIN_GRANULARITY.get(interval, 5)
    end_ms = int(time.time() * 1000)
    start_ms = (int(time.time()) - lookback_secs) * 1000
    step_ms = gran * 60 * 1000 * 190  # KuCoin returns at most 200 candles per call
    by_t: dict[int, dict] = {}
    async with httpx.AsyncClient(base_url=settings.kucoin_rest_url, timeout=20) as client:
        t0 = start_ms
        for _ in range(60):  # bound the walk for very long windows
            if t0 >= end_ms:
                break
            t1 = min(t0 + step_ms, end_ms)
            resp = await client.get(
                "/api/v1/kline/query",
                params={"symbol": symbol.upper(), "granularity": gran, "from": t0, "to": t1},
            )
            resp.raise_for_status()
            for row in resp.json().get("data") or []:
                ts = int(row[0]) // 1000
                by_t[ts] = {
                    "time": ts,
                    "open": _num(row[1]),
                    "high": _num(row[2]),
                    "low": _num(row[3]),
                    "close": _num(row[4]),
                    "volume": _num(row[5] if len(row) > 5 else 0),
                }
            if t1 >= end_ms:
                break
            t0 = t1
    return sorted(by_t.values(), key=lambda p: p["time"])


_BYBIT_INTERVAL = {
    "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30",
    "1h": "60", "2h": "120", "4h": "240", "1d": "D",
}


async def _fetch_bybit_ohlc(symbol: str, interval: str, lookback_secs: int) -> list[dict]:
    """Bybit v5 klines. Linear USDT-M first, inverse USD if that is empty."""
    ivl = _BYBIT_INTERVAL.get(interval, "5")
    window_end = int(time.time() * 1000)
    window_start = (int(time.time()) - lookback_secs) * 1000
    raw = (symbol or "").upper()
    linear = raw if raw.endswith("USDT") else (
        raw + "T" if raw.endswith("USD") else raw + "USDT"
    )
    inverse = raw[:-1] if raw.endswith("USDT") else raw
    async with httpx.AsyncClient(base_url=settings.bybit_rest_url, timeout=20) as client:
        for category, sym in (("linear", linear), ("inverse", inverse)):
            bars = await _bybit_kline_range(
                client, category, sym, ivl, window_start, window_end,
            )
            if bars:
                return bars
    return []


async def _bybit_kline_range(
    client: httpx.AsyncClient, category: str, symbol: str,
    interval: str, start_ms: int, end_ms: int,
) -> list[dict]:
    by_t: dict[int, dict] = {}
    end = end_ms
    for _ in range(40):
        if end <= start_ms:
            break
        resp = await client.get(
            "/v5/market/kline",
            params={
                "category": category,
                "symbol": symbol,
                "interval": interval,
                "start": start_ms,
                "end": end,
                "limit": 1000,
            },
        )
        resp.raise_for_status()
        payload = resp.json() or {}
        if int(payload.get("retCode") or 0) != 0:
            return []
        rows = (payload.get("result") or {}).get("list") or []
        if not rows:
            break
        for row in rows:
            ts = int(row[0]) // 1000
            by_t[ts] = {
                "time": ts,
                "open": _num(row[1]),
                "high": _num(row[2]),
                "low": _num(row[3]),
                "close": _num(row[4]),
                "volume": _num(row[5] if len(row) > 5 else 0),
            }
        oldest = min(int(r[0]) for r in rows)
        if oldest <= start_ms or len(rows) < 1000:
            break
        end = oldest - 1
    return sorted(by_t.values(), key=lambda p: p["time"])


_COINBASE_GRANULARITY = {
    "1m": "ONE_MINUTE", "3m": "FIVE_MINUTE", "5m": "FIVE_MINUTE",
    "15m": "FIFTEEN_MINUTE", "30m": "THIRTY_MINUTE",
    "1h": "ONE_HOUR", "2h": "TWO_HOUR", "4h": "ONE_HOUR",
    "6h": "SIX_HOUR", "1d": "ONE_DAY",
}
_COINBASE_GRAN_SECS = {
    "ONE_MINUTE": 60, "FIVE_MINUTE": 300, "FIFTEEN_MINUTE": 900,
    "THIRTY_MINUTE": 1800, "ONE_HOUR": 3600, "TWO_HOUR": 7200,
    "SIX_HOUR": 21600, "ONE_DAY": 86400,
}


def _coinbase_product(symbol: str) -> str:
    s = (symbol or "").strip().upper().replace("_", "-")
    if s.endswith("-PERP-INTX"):
        return s[: -len("-INTX")]
    if "-" in s:
        return s
    if s.endswith("PERPINTX") and len(s) > 8:
        return f"{s[:-8]}-PERP"
    if s.endswith("PERP") and len(s) > 4:
        return f"{s[:-4]}-PERP"
    for quote in ("USDC", "USDT", "USD", "EUR", "GBP"):
        if s.endswith(quote) and len(s) > len(quote):
            return f"{s[:-len(quote)]}-{quote}"
    return s


def _coinbase_product_candidates(symbol: str) -> list[str]:
    primary = _coinbase_product(symbol)
    base = _base_asset(symbol)
    out = [primary]
    u = (symbol or "").upper().replace("-", "").replace("_", "")
    perp = "PERP" in u or u.endswith("INTX")
    if base:
        if perp:
            out.extend([f"{base}-PERP", f"{base}-PERP-INTX"])
        else:
            out.extend([f"{base}-USD", f"{base}-USDC", f"{base}-USDT"])
    seen, ordered = set(), []
    for pid in out:
        p = (pid or "").strip().upper()
        if p and p not in seen:
            seen.add(p)
            ordered.append(p)
    return ordered


def _unix_from_any(v) -> int:
    if v is None:
        return 0
    if isinstance(v, datetime):
        return int(v.timestamp())
    if isinstance(v, (int, float)):
        n = int(v)
        return n // 1000 if n > 10_000_000_000 else n
    s = str(v).strip()
    if not s:
        return 0
    try:
        if s.replace(".", "", 1).isdigit():
            return _unix_from_any(float(s))
    except ValueError:
        pass
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return int(datetime.fromisoformat(s).timestamp())
    except ValueError:
        return 0


def _iso_utc(ts: int) -> str:
    return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _ohlc_bar(ts: int, open_: float, high: float, low: float, close: float, volume: float) -> dict | None:
    if ts <= 0 or close <= 0:
        return None
    return {"time": ts, "open": open_, "high": high, "low": low, "close": close, "volume": volume}


def _resample_ohlc(bars: list[dict], bucket_secs: int) -> list[dict]:
    if bucket_secs <= 0:
        return bars
    buckets: dict[int, dict] = {}
    for b in bars:
        t = (int(b["time"]) // bucket_secs) * bucket_secs
        slot = buckets.get(t)
        if slot is None:
            buckets[t] = {
                "time": t, "open": b["open"], "high": b["high"], "low": b["low"],
                "close": b["close"], "volume": _num(b.get("volume")),
            }
        else:
            slot["high"] = max(slot["high"], b["high"])
            slot["low"] = min(slot["low"], b["low"])
            slot["close"] = b["close"]
            slot["volume"] = _num(slot.get("volume")) + _num(b.get("volume"))
    return sorted(buckets.values(), key=lambda x: x["time"])


def _parse_coinbase_rows(rows: list) -> dict[int, dict]:
    bars: dict[int, dict] = {}
    for row in rows or []:
        if isinstance(row, dict):
            ts = _unix_from_any(row.get("start") or row.get("time") or row.get("timestamp"))
            bar = _ohlc_bar(
                ts, _num(row.get("open")), _num(row.get("high")),
                _num(row.get("low")), _num(row.get("close")), _num(row.get("volume")),
            )
        elif isinstance(row, (list, tuple)) and len(row) >= 5:
            ts = _unix_from_any(row[0])
            bar = _ohlc_bar(ts, _num(row[1]), _num(row[2]), _num(row[3]), _num(row[4]),
                            _num(row[5] if len(row) > 5 else 0))
        else:
            bar = None
        if bar:
            bars[bar["time"]] = bar
    return bars


async def _fetch_coinbase_adv_ohlc(pid: str, gran: str, start: int, end: int) -> list[dict]:
    bars: dict[int, dict] = {}
    t1 = end
    async with httpx.AsyncClient(base_url=settings.coinbase_rest_url, timeout=20) as client:
        for _ in range(16):
            if t1 <= start:
                break
            resp = await client.get(
                f"/api/v3/brokerage/market/products/{quote(pid, safe='-')}/candles",
                params={"start": str(start), "end": str(t1), "granularity": gran},
            )
            if resp.status_code >= 400:
                raise RuntimeError(f"{pid} adv {resp.status_code} {resp.text[:180]}")
            payload = resp.json() or {}
            rows = payload.get("candles") or payload.get("data") or []
            if not rows:
                break
            chunk = _parse_coinbase_rows(rows)
            if not chunk:
                break
            bars.update(chunk)
            oldest = min(chunk)
            if oldest <= start or len(rows) < 80:
                break
            t1 = oldest - 1
    return sorted(bars.values(), key=lambda p: p["time"])


async def _fetch_coinbase_intx_ohlc(pid: str, gran: str, start: int, end: int) -> list[dict]:
    """Coinbase International perps (ETH-PERP), ISO timestamps."""
    bars: dict[int, dict] = {}
    t0 = start
    step = _COINBASE_GRAN_SECS.get(gran, 300) * 300
    async with httpx.AsyncClient(base_url=settings.coinbase_intx_url, timeout=20) as client:
        for _ in range(16):
            if t0 >= end:
                break
            t1 = min(end, t0 + step)
            resp = await client.get(
                f"/api/v1/instruments/{quote(pid, safe='-')}/candles",
                params={"granularity": gran, "start": _iso_utc(t0), "end": _iso_utc(t1)},
            )
            if resp.status_code >= 400:
                raise RuntimeError(f"{pid} intx {resp.status_code} {resp.text[:180]}")
            payload = resp.json() or {}
            if isinstance(payload, list):
                rows = payload
            else:
                rows = payload.get("aggregations") or payload.get("candles") or payload.get("data") or []
            chunk = _parse_coinbase_rows(rows)
            bars.update(chunk)
            if t1 >= end:
                break
            t0 = t1
    return sorted(bars.values(), key=lambda p: p["time"])


async def _fetch_coinbase_ohlc(symbol: str, interval: str, lookback_secs: int) -> list[dict]:
    """Advanced Trade spot/perps, then International Exchange (INTX) perps."""
    gran = _COINBASE_GRANULARITY.get(interval, "FIVE_MINUTE")
    end = int(time.time())
    start = end - int(lookback_secs)
    u = (symbol or "").upper().replace("-", "").replace("_", "")
    perp = "PERP" in u or u.endswith("INTX")
    errors: list[str] = []
    for pid in _coinbase_product_candidates(symbol):
        fetchers = (
            (_fetch_coinbase_intx_ohlc, _fetch_coinbase_adv_ohlc)
            if perp else
            (_fetch_coinbase_adv_ohlc, _fetch_coinbase_intx_ohlc)
        )
        for fetch in fetchers:
            try:
                bars = await fetch(pid, gran, start, end)
            except Exception as exc:
                errors.append(f"{pid}:{exc}")
                continue
            if bars:
                if interval == "4h":
                    bars = _resample_ohlc(bars, 14400)
                return bars
    detail = "; ".join(errors[-6:]) if errors else "no rows"
    raise RuntimeError(f"no Coinbase candles for {symbol}: {detail}")


@app.get("/api/candles")
async def candles(
    symbol: str = Query(..., description="Contract name e.g. LABUSD"),
    interval: str = Query("5m"),
    hours: int = Query(24, ge=1, le=2160),
    today: bool = Query(False, description="Restrict to IST calendar day"),
    strategy: str = Query("opa3"),
    account: str | None = Query(None),
) -> dict:
    """OHLC for the quote venue — used under the fill overlay on the rPnL page."""
    cfg_dash = _SYMBOLS.get(symbol.upper())
    contract = cfg_dash.delta_symbol if cfg_dash else symbol.upper()
    if interval not in _RESOLUTION_SECONDS:
        raise HTTPException(status_code=400, detail=f"unknown interval '{interval}'")
    meta = await resolve_venues(contract, strategy=strategy, account=account)
    lookback = _window_lookback_secs(hours, today)
    qv = meta["quote_venue"]
    quote_symbol = meta.get("quote_symbol") or contract
    try:
        if qv == "binance":
            bars = await _fetch_binance_ohlc(quote_symbol, interval, lookback)
        elif qv == "aster":
            bars = await _fetch_binance_ohlc(
                quote_symbol, interval, lookback, base_url=settings.aster_rest_url,
            )
        elif qv == "kucoin":
            resolved = (await _kucoin_symbol_map()).get(_base_asset(contract)) or quote_symbol
            quote_symbol = resolved
            bars = await _fetch_kucoin_ohlc(resolved, interval, lookback)
        elif qv == "bybit":
            bars = await _fetch_bybit_ohlc(quote_symbol, interval, lookback)
        elif qv == "coinbase":
            bars = await _fetch_coinbase_ohlc(quote_symbol, interval, lookback)
        else:
            bars = await _fetch_delta_ohlc(quote_symbol, interval, lookback)
    except Exception as exc:
        logger.warning("webapp: %s candles failed for %s: %s", qv, quote_symbol, exc)
        raise HTTPException(
            status_code=502, detail=f"{meta['quote_label']} candles failed for {quote_symbol}: {exc}"
        ) from exc
    return {
        "contract": contract,
        "interval": interval,
        "venue": qv,
        **meta,
        "quote_symbol": quote_symbol,
        "candles": bars,
    }


# ── Bot status & controls ─────────────────────────────────────────────────────

class BotControlRequest(BaseModel):
    action: str  # "start" | "stop"
    note: str = ""


@app.get("/api/bot/status")
async def bot_status(
    strategy: str = Query("opa3", description="strategy tag, e.g. opa3 | opa4"),
) -> dict:
    """Live bot status derived from DB activity + the desired control state."""
    if _db is None or not _db.pool:
        raise HTTPException(status_code=503, detail=f"Database not connected: {_db_error or 'no pool'}")
    snapshot = await _db.get_status_snapshot(strategy=strategy)
    control  = await _db.get_bot_control()

    # Liveness: the bot writes a balance/position snapshot every report cycle.
    interval = int(settings.report_interval_seconds or 300)
    threshold = interval * 2 + 120
    online = False
    age_secs = None
    if snapshot.get("last_seen"):
        last = datetime.fromisoformat(snapshot["last_seen"])
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        age_secs = (datetime.now(timezone.utc) - last).total_seconds()
        online = age_secs <= threshold

    return {
        "online":            online,
        "age_secs":          age_secs,
        "threshold_secs":    threshold,
        "report_interval":   interval,
        "desired_state":     control.get("desired_state", "running"),
        "control":           control,
        "last_seen":         snapshot.get("last_seen"),
        "balance":           snapshot.get("balance"),
        "positions":         snapshot.get("positions", []),
    }


@app.post("/api/bot/control")
async def bot_control(req: BotControlRequest) -> dict:
    """Ask the bot to pause or resume quoting (honored by the bot's control poller)."""
    if _db is None or not _db.pool:
        raise HTTPException(status_code=503, detail=f"Database not connected: {_db_error or 'no pool'}")
    action = req.action.lower().strip()
    if action in ("start", "resume", "run", "running"):
        state = "running"
    elif action in ("stop", "pause", "paused", "halt"):
        state = "paused"
    else:
        raise HTTPException(status_code=400, detail=f"unknown action '{req.action}'")
    await _db.set_bot_control(state, note=req.note, updated_by="dashboard")
    logger.info("webapp: bot control set to %s", state)
    return {"ok": True, "desired_state": state}


class DepositWithdrawalRequest(BaseModel):
    amount: float   # positive = deposit, negative = withdrawal
    note: str = ""
    at: str = ""   # optional IST datetime string: "YYYY-MM-DD HH:MM" — leave empty for now


@app.post("/api/deposits")
async def log_deposit(req: DepositWithdrawalRequest) -> dict:
    """Log a deposit (positive amount) or withdrawal (negative amount) so balance
    change calculations in reports exclude it from shown profit/loss.
    Use 'at' to back-date a past entry, e.g. \"2026-08-10 14:30\" (IST)."""
    if _db is None or not _db.pool:
        raise HTTPException(status_code=503, detail=f"Database not connected: {_db_error or 'no pool'}")
    if req.amount == 0:
        raise HTTPException(status_code=400, detail="amount must be non-zero")
    # Parse optional back-date (IST input → UTC)
    custom_at = None
    if req.at.strip():
        try:
            from datetime import timedelta
            naive = datetime.strptime(req.at.strip(), "%Y-%m-%d %H:%M")
            custom_at = (naive - timedelta(hours=5, minutes=30)).replace(tzinfo=timezone.utc)
        except ValueError:
            raise HTTPException(status_code=400, detail="'at' must be 'YYYY-MM-DD HH:MM' (IST)")
    row_id = await _db.log_deposit_withdrawal(req.amount, note=req.note, recorded_by="dashboard", at=custom_at)
    kind = "deposit" if req.amount > 0 else "withdrawal"
    logger.info("webapp: logged %s $%.2f (note=%s)", kind, abs(req.amount), req.note or "-")
    return {"ok": True, "id": row_id, "kind": kind, "amount": req.amount}


@app.get("/api/deposits")
async def list_deposits(limit: int = Query(50, ge=1, le=200)) -> list[dict]:
    """List recent deposits/withdrawals (newest first)."""
    if _db is None or not _db.pool:
        raise HTTPException(status_code=503, detail=f"Database not connected: {_db_error or 'no pool'}")
    rows = await _db.get_deposits_withdrawals(limit=limit)
    return [
        {**r, "created_at": r["created_at"].isoformat() if hasattr(r.get("created_at"), "isoformat") else str(r.get("created_at"))}
        for r in rows
    ]


@app.websocket("/ws/live")
async def ws_live(websocket: WebSocket):
    """WebSocket: pushes latest live_state from DB every 2s. No auth — data is read-only."""
    import asyncio as _asyncio
    import json as _json
    await websocket.accept()
    try:
        while True:
            try:
                rows = await _db.get_live_state() if (_db and _db.pool) else []
                await websocket.send_text(_json.dumps(rows))
            except Exception:
                await websocket.send_text(_json.dumps([]))
            await _asyncio.sleep(2)
    except (WebSocketDisconnect, Exception):
        pass


@app.get("/api/events")
async def recent_events(
    limit: int = Query(60, ge=1, le=300),
    contract: str | None = Query(None),
    strategy: str = Query("opa3", description="strategy tag, e.g. opa3 | opa4"),
) -> list[dict]:
    """Recent bot events for the live activity feed."""
    if _db is None or not _db.pool:
        raise HTTPException(status_code=503, detail=f"Database not connected: {_db_error or 'no pool'}")
    return await _db.get_recent_events(limit=limit, contract=contract, strategy=strategy)


# ── Reports ───────────────────────────────────────────────────────────────────

def _touch_range(dst: dict, first: int | None, last: int | None) -> None:
    if first and (not dst.get("first_at") or first < dst["first_at"]):
        dst["first_at"] = first
    if last and (not dst.get("last_at") or last > dst["last_at"]):
        dst["last_at"] = last


def _blank_acct(account: str, name: str = "") -> dict:
    return {
        "account": account,
        "account_name": name or account or "unattributed",
        "rpnl": 0.0,
        "fees": 0.0,
        "fills": 0,
        "upnl": 0.0,
        "balance": None,
        "positions": [],
        "exchanges": {},
        "contracts": {},
        "first_at": None,
        "last_at": None,
    }


def _add_fill_row(acct: dict, row: dict) -> None:
    acct["rpnl"] += row["rpnl"]
    acct["fees"] += row["fee"]
    acct["fills"] += row["fills"]
    _touch_range(acct, row.get("first_at"), row.get("last_at"))
    if row.get("account_name") and (
        not acct["account_name"] or acct["account_name"] in (acct["account"], "unattributed")
    ):
        acct["account_name"] = row["account_name"]
    exch = row["exchange"]
    slot = acct["exchanges"].setdefault(exch, {
        "exchange": exch, "fills": 0, "rpnl": 0.0, "fees": 0.0,
    })
    slot["fills"] += row["fills"]
    slot["rpnl"] += row["rpnl"]
    slot["fees"] += row["fee"]
    con = acct["contracts"].setdefault(row["contract"], {
        "contract": row["contract"],
        "venue_fills": {},
        "venue_rpnl": {},
        "fills": 0,
        "rpnl": 0.0,
        "fees": 0.0,
    })
    con["venue_fills"][exch] = con["venue_fills"].get(exch, 0) + row["fills"]
    con["venue_rpnl"][exch] = con["venue_rpnl"].get(exch, 0.0) + row["rpnl"]
    con["fills"] += row["fills"]
    con["rpnl"] += row["rpnl"]
    con["fees"] += row["fee"]


def _finish_account(acct: dict) -> dict:
    exchanges = []
    for exch, slot in acct["exchanges"].items():
        slot["label"] = _VENUE_LABEL.get(exch, exch.title())
        slot["rpnl"] = round(slot["rpnl"], 2)
        slot["fees"] = round(slot["fees"], 2)
        exchanges.append(slot)
    exchanges.sort(key=lambda e: abs(e["rpnl"]), reverse=True)
    contracts = []
    for con in acct["contracts"].values():
        meta = venue_meta(con["contract"], con["venue_fills"])
        qv = meta["quote_venue"]
        quote_rpnl = con["venue_rpnl"].get(qv, 0.0)
        hedge_rpnl = sum(v for k, v in con["venue_rpnl"].items() if k != qv)
        venues = []
        for exch, n in con["venue_fills"].items():
            venues.append({
                "exchange": exch,
                "label": _VENUE_LABEL.get(exch, exch.title()),
                "fills": n,
                "rpnl": round(con["venue_rpnl"].get(exch, 0.0), 2),
            })
        venues.sort(key=lambda v: abs(v["rpnl"]), reverse=True)
        contracts.append({
            "contract": con["contract"],
            "quote_venue": qv,
            "quote_label": meta["quote_label"],
            "quote_symbol": meta["quote_symbol"],
            "has_hedge": meta["has_hedge"],
            "hedge_label": meta["hedge_label"],
            "rpnl": round(quote_rpnl, 2),
            "hedge_rpnl": round(hedge_rpnl, 2),
            "net": round(quote_rpnl + hedge_rpnl, 2),
            "fills": con["venue_fills"].get(qv, 0),
            "hedge_fills": sum(n for k, n in con["venue_fills"].items() if k != qv),
            "fees": round(con["fees"], 2),
            "venues": venues,
        })
    contracts.sort(key=lambda c: abs(c["net"]), reverse=True)
    acct["exchanges"] = exchanges
    acct["contracts"] = contracts
    acct["rpnl"] = round(acct["rpnl"], 2)
    acct["fees"] = round(acct["fees"], 2)
    acct["upnl"] = round(acct["upnl"], 2)
    return acct


def _assemble_reports_overview(
    raw: dict, usdinr: float = 87.0, live_keys: set | None = None,
) -> dict:
    accounts: dict[str, dict] = {}
    orphans: list[dict] = []
    for row in raw.get("rows") or []:
        aid = row.get("account") or ""
        if aid:
            accounts.setdefault(aid, _blank_acct(aid, row.get("account_name") or ""))
            _add_fill_row(accounts[aid], row)
        else:
            orphans.append(row)

    by_contract: dict[str, list[str]] = {}
    for aid, acct in accounts.items():
        for contract in acct["contracts"]:
            by_contract.setdefault(contract, []).append(aid)
    for row in orphans:
        cands = by_contract.get(row["contract"]) or []
        if len(cands) == 1:
            target = cands[0]
        elif cands:
            target = max(cands, key=lambda i: accounts[i]["contracts"][row["contract"]]["fills"])
        else:
            target = ""
            accounts.setdefault("", _blank_acct("", "unattributed"))
        _add_fill_row(accounts[target], row)

    shared_balances: list[dict] = []
    for bal in raw.get("balances") or []:
        aid = str(bal.get("account") or "")
        cleaned = {
            k: v for k, v in bal.items()
            if k not in ("id", "strategy") and v not in (None, "")
        }
        if aid and aid in accounts:
            accounts[aid]["balance"] = cleaned
        else:
            shared_balances.append(cleaned)

    shared_positions: list[dict] = []
    for pos in raw.get("positions") or []:
        aid = str(pos.get("account") or "")
        cleaned = {
            k: v for k, v in pos.items()
            if k not in ("id", "strategy") and v not in (None, "")
        }
        upnl = pos.get("net_upnl")
        try:
            upnl_f = float(upnl) if upnl is not None else None
        except (TypeError, ValueError):
            upnl_f = None
        if upnl_f is not None:
            cleaned["net_upnl"] = round(upnl_f * usdinr, 2)
        if aid and aid in accounts:
            if upnl_f is not None:
                accounts[aid]["upnl"] += upnl_f * usdinr
            accounts[aid].setdefault("positions", []).append(cleaned)
        else:
            shared_positions.append(cleaned)

    live_keys = live_keys or set()
    finished = [_finish_account(a) for a in accounts.values()]
    for acct in finished:
        aid = acct.get("account") or ""
        acct["live"] = any(
            ping_is_live(c["contract"], aid, live_keys) for c in acct["contracts"]
        )
        acct.setdefault("positions", [])
    finished.sort(key=lambda a: (not a["live"], -abs(a["rpnl"])))

    by_exchange: dict[str, dict] = {}
    totals = {
        "rpnl": 0.0, "fees": 0.0, "fills": 0, "upnl": 0.0,
        "accounts": len(finished), "balance": None, "live": 0,
    }
    equity = 0.0
    equity_n = 0
    for acct in finished:
        totals["rpnl"] += acct["rpnl"]
        totals["fees"] += acct["fees"]
        totals["fills"] += acct["fills"]
        totals["upnl"] += acct["upnl"]
        if acct.get("live"):
            totals["live"] += 1
        bal = (acct.get("balance") or {}).get("total_balance")
        if bal is not None:
            try:
                equity += float(bal)
                equity_n += 1
            except (TypeError, ValueError):
                pass
        for slot in acct["exchanges"]:
            agg = by_exchange.setdefault(slot["exchange"], {
                "exchange": slot["exchange"], "label": slot["label"],
                "fills": 0, "rpnl": 0.0, "fees": 0.0,
            })
            agg["fills"] += slot["fills"]
            agg["rpnl"] += slot["rpnl"]
            agg["fees"] += slot["fees"]
    for agg in by_exchange.values():
        agg["rpnl"] = round(agg["rpnl"], 2)
        agg["fees"] = round(agg["fees"], 2)
    if equity_n:
        totals["balance"] = round(equity, 2)
    elif shared_balances:
        t = shared_balances[0].get("total_balance")
        try:
            totals["balance"] = round(float(t), 2) if t is not None else None
        except (TypeError, ValueError):
            totals["balance"] = None
    totals["rpnl"] = round(totals["rpnl"], 2)
    totals["fees"] = round(totals["fees"], 2)
    totals["upnl"] = round(totals["upnl"], 2)
    return {
        "totals": totals,
        "by_exchange": sorted(by_exchange.values(), key=lambda e: abs(e["rpnl"]), reverse=True),
        "accounts": finished,
        "shared_balances": shared_balances,
        "shared_positions": shared_positions,
        "snapshot": shared_balances[0] if shared_balances else None,
    }


@app.get("/api/reports/overview")
async def reports_overview(
    strategy: str = Query("opa3"),
    hours: int | None = Query(None, ge=1, le=8760),
    today: bool = Query(False, description="Restrict to IST calendar day"),
) -> dict:
    """Per-account, per-exchange realized PnL plus latest balances/positions."""
    if _db is None or not _db.pool:
        raise HTTPException(status_code=503, detail=f"Database not connected: {_db_error or 'no pool'}")
    since = _window_since(hours, today)
    if today:
        window = "today"
    elif hours:
        window = f"{hours}h"
    else:
        window = "all"
    raw = await _db.get_accounts_overview(strategy=strategy, since=since)
    live_keys = await _db.get_live_ping_keys(strategy)
    out = _assemble_reports_overview(raw, usdinr=_db.usdinr_rate, live_keys=live_keys)
    out.update({
        "strategy": strategy,
        "window": window,
        "hours": hours,
        "generated_at": int(datetime.now(timezone.utc).timestamp()),
    })
    return out


@app.get("/api/balances")
async def balances_board(
    strategy: str = Query("opa3"),
    scope: str = Query("all", description="all | strategy"),
) -> dict:
    """Latest wallet snapshot for every exchange subaccount."""
    if _db is None or not _db.pool:
        raise HTTPException(status_code=503, detail=f"Database not connected: {_db_error or 'no pool'}")
    out = await _db.get_balances_board(strategy=strategy, scope=scope)
    out["strategy"] = strategy
    out["generated_at"] = int(datetime.now(timezone.utc).timestamp())
    return out


@app.get("/api/reports")
async def list_reports(
    limit: int = Query(50, ge=1, le=200),
    before_id: int | None = Query(None),
) -> list[dict]:
    """Metadata for past reports (newest first)."""
    if _db is None or not _db.pool:
        raise HTTPException(status_code=503, detail=f"Database not connected: {_db_error or 'no pool'}")
    return await _db.get_reports(limit=limit, before_id=before_id)


@app.get("/api/reports/{report_id}")
async def get_report(report_id: int) -> dict:
    """Full rendered report by id."""
    if _db is None or not _db.pool:
        raise HTTPException(status_code=503, detail=f"Database not connected: {_db_error or 'no pool'}")
    report = await _db.get_report(report_id)
    if report is None:
        raise HTTPException(status_code=404, detail=f"report {report_id} not found")
    return report


# ── Data explorer ────────────────────────────────────────────────────────────────

def _require_db() -> None:
    if _db is None or not _db.pool:
        raise HTTPException(status_code=503, detail=f"Database not connected: {_db_error or 'no pool'}")


def _jsonable(v):
    """Convert asyncpg cell values to JSON-friendly types."""
    import decimal
    if isinstance(v, datetime):
        return int(v.timestamp())  # frontend formats to IST
    if isinstance(v, decimal.Decimal):
        return float(v)
    if isinstance(v, (dict, list)):
        import json as _json
        return _json.dumps(v, default=str)
    return v


_IST = timezone(timedelta(hours=5, minutes=30))
_IDENT_RE = re.compile(r"^[a-z_][a-z0-9_]*$")
_TEXT_TYPES = {
    "text", "character varying", "character", "citext", "name",
    "json", "jsonb", "uuid",
}
_EXPORT_MAX = 100_000


def _qi(name: str) -> str:
    if not _IDENT_RE.fullmatch(name):
        raise HTTPException(status_code=400, detail=f"invalid identifier '{name}'")
    return f'"{name}"'


def _parse_bound(value: str | None, *, end: bool = False) -> datetime | None:
    """Unix seconds, ISO datetime, or YYYY-MM-DD as an IST calendar day.

    Naive datetimes are IST. `end=True` is exclusive:
    date-only `until=2026-09-11` includes that whole day; a minute-precision
    datetime includes that whole minute.
    """
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    if s.isdigit():
        ts = int(s)
        if ts > 10_000_000_000:
            ts //= 1000
        return datetime.fromtimestamp(ts, tz=timezone.utc)
    try:
        if len(s) == 10 and s[4] == "-" and s[7] == "-":
            ist = datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=_IST)
            if end:
                ist = ist + timedelta(days=1)
            return ist.astimezone(timezone.utc)
        iso = s.replace("Z", "+00:00").replace(" ", "T", 1)
        dt = datetime.fromisoformat(iso)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=_IST)
        if end and dt.second == 0 and dt.microsecond == 0:
            dt = dt + timedelta(minutes=1)
        elif end:
            dt = dt + timedelta(seconds=1)
        return dt.astimezone(timezone.utc)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"invalid timestamp '{value}'")


_LOG_COL_ORDER = (
    "id", "created_at", "strategy", "account", "contract", "exchange",
    "service", "level", "name", "message",
)


def _ordered_cols(name: str, col_names: list[str]) -> list[str]:
    if name != "logs":
        return col_names
    head = [c for c in _LOG_COL_ORDER if c in col_names]
    rest = [c for c in col_names if c not in _LOG_COL_ORDER]
    return head + rest


async def _public_tables(conn) -> list[str]:
    rows = await conn.fetch(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
    )
    return [r["tablename"] for r in rows]


async def _table_meta(conn, name: str) -> tuple[list[str], dict[str, str]]:
    cols = await conn.fetch(
        "SELECT column_name, data_type FROM information_schema.columns "
        "WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position",
        name,
    )
    names = [c["column_name"] for c in cols]
    types = {c["column_name"]: c["data_type"] for c in cols}
    return names, types


def _build_table_filters(
    col_names: list[str],
    col_types: dict[str, str],
    *,
    q: str | None = None,
    since: str | None = None,
    until: str | None = None,
    contract: str | None = None,
    account: str | None = None,
    exchange: str | None = None,
    strategy: str | None = None,
    side: str | None = None,
    service: str | None = None,
    level: str | None = None,
    pair: str | None = None,
    status: str | None = None,
    order_id: str | None = None,
) -> tuple[str, list]:
    """Return SQL `WHERE ...` (or empty) plus bound parameters."""
    wheres: list[str] = []
    params: list = []
    cols = set(col_names)

    time_col = "created_at" if "created_at" in cols else ("updated_at" if "updated_at" in cols else None)
    start = _parse_bound(since, end=False)
    stop = _parse_bound(until, end=True)
    if time_col and start:
        params.append(start)
        wheres.append(f"{_qi(time_col)} >= ${len(params)}")
    if time_col and stop:
        params.append(stop)
        wheres.append(f"{_qi(time_col)} < ${len(params)}")

    raw = {
        "contract": contract, "account": account, "exchange": exchange,
        "strategy": strategy, "side": side, "service": service, "level": level,
        "pair": pair, "status": status, "order_id": order_id,
    }
    for key, val in raw.items():
        if val is None or key not in cols:
            continue
        text = str(val).strip()
        if text == "":
            continue
        ident = _qi(key)
        if key == "contract":
            aliases = contract_aliases(text)
            params.append(aliases)
            wheres.append(f"UPPER({ident}::text) = ANY(${len(params)}::text[])")
        elif key == "account":
            if text in ("__blank__", "(blank)"):
                wheres.append(f"COALESCE(TRIM({ident}::text), '') = ''")
            else:
                params.append(text)
                wheres.append(f"COALESCE({ident}::text, '') = ${len(params)}")
        elif key in ("exchange", "side", "level", "service", "status"):
            params.append(text.lower() if key != "level" else text.upper())
            if key == "level":
                wheres.append(f"UPPER({ident}::text) = ${len(params)}")
            else:
                wheres.append(f"LOWER({ident}::text) = ${len(params)}")
        elif key == "order_id":
            params.append(f"%{text}%")
            wheres.append(f"{ident}::text ILIKE ${len(params)}")
        else:
            params.append(text)
            wheres.append(f"{ident}::text = ${len(params)}")

    needle = (q or "").strip()
    if needle:
        search_cols = [
            c for c in col_names
            if col_types.get(c) in _TEXT_TYPES or col_types.get(c) == "USER-DEFINED"
        ][:8]
        if search_cols:
            params.append(f"%{needle}%")
            idx = len(params)
            parts = [f"{_qi(c)}::text ILIKE ${idx}" for c in search_cols]
            wheres.append("(" + " OR ".join(parts) + ")")

    if not wheres:
        return "", params
    return "WHERE " + " AND ".join(wheres), params


def _order_sql(col_names: list[str], sort: str | None, direction: str | None) -> tuple[str, str, str]:
    cols = set(col_names)
    default = "id" if "id" in cols else ("created_at" if "created_at" in cols else (col_names[0] if col_names else None))
    col = sort if sort in cols else default
    if not col:
        return "", "id", "desc"
    d = "ASC" if str(direction or "desc").lower() == "asc" else "DESC"
    return f"ORDER BY {_qi(col)} {d} NULLS LAST", col, d.lower()


def _csvable(v) -> str:
    import decimal
    import json as _json
    if v is None:
        return ""
    if isinstance(v, datetime):
        return v.astimezone(_IST).strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(v, decimal.Decimal):
        return format(v, "f")
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, (dict, list)):
        s = _json.dumps(v, default=str)
    elif isinstance(v, bytes):
        s = v.decode("utf-8", "replace")
    else:
        s = str(v)
    if s[:1] in ("=", "+", "@"):
        return "'" + s
    return s


async def _prepare_table(
    name: str,
    *,
    sort: str | None = None,
    direction: str | None = None,
    q: str | None = None,
    since: str | None = None,
    until: str | None = None,
    contract: str | None = None,
    account: str | None = None,
    exchange: str | None = None,
    strategy: str | None = None,
    side: str | None = None,
    service: str | None = None,
    level: str | None = None,
    pair: str | None = None,
    status: str | None = None,
    order_id: str | None = None,
):
    _require_db()
    if not _IDENT_RE.fullmatch(name):
        raise HTTPException(status_code=404, detail=f"unknown table '{name}'")
    async with _db.pool.acquire() as conn:
        names = await _public_tables(conn)
        if name not in names:
            raise HTTPException(status_code=404, detail=f"unknown table '{name}'")
        col_names, col_types = await _table_meta(conn, name)
    where_sql, params = _build_table_filters(
        col_names, col_types,
        q=q, since=since, until=until, contract=contract, account=account,
        exchange=exchange, strategy=strategy, side=side, service=service,
        level=level, pair=pair, status=status, order_id=order_id,
    )
    order_sql, sort_col, sort_dir = _order_sql(col_names, sort, direction)
    return _ordered_cols(name, col_names), col_types, where_sql, params, order_sql, sort_col, sort_dir


def _export_filename(name: str, since: str | None, until: str | None, contract: str | None, ext: str = "csv") -> str:
    stamp = datetime.now(_IST).strftime("%Y%m%d_%H%M")
    bits = [name]
    if since:
        bits.append("from" + re.sub(r"[^\d]", "", str(since))[:12])
    if until:
        bits.append("to" + re.sub(r"[^\d]", "", str(until))[:12])
    if contract:
        bits.append(re.sub(r"[^\w.\-]+", "", contract)[:24])
    bits.append(stamp)
    return "_".join(b for b in bits if b) + "." + ext


async def _table_csv_text(
    name: str,
    *,
    sort: str | None = "created_at",
    direction: str = "desc",
    q: str | None = None,
    since: str | None = None,
    until: str | None = None,
    contract: str | None = None,
    account: str | None = None,
    exchange: str | None = None,
    strategy: str | None = None,
    side: str | None = None,
    service: str | None = None,
    level: str | None = None,
    pair: str | None = None,
    status: str | None = None,
    order_id: str | None = None,
    limit: int = _EXPORT_MAX,
) -> tuple[str, str]:
    col_names, _types, where_sql, params, order_sql, _sc, _sd = await _prepare_table(
        name, sort=sort, direction=direction, q=q, since=since, until=until,
        contract=contract, account=account, exchange=exchange, strategy=strategy,
        side=side, service=service, level=level, pair=pair, status=status, order_id=order_id,
    )
    params = list(params)
    params.append(limit)
    sql = f"SELECT * FROM {_qi(name)} {where_sql} {order_sql} LIMIT ${len(params)}"
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(col_names)
    async with _db.pool.acquire() as conn:
        rows = await conn.fetch(sql, *params)
    for rec in rows:
        writer.writerow([_csvable(rec[c]) for c in col_names])
    return _export_filename(name, since, until, contract), buf.getvalue()


async def _csv_streaming_response(
    name: str,
    *,
    sort: str | None = None,
    direction: str = "desc",
    q: str | None = None,
    since: str | None = None,
    until: str | None = None,
    contract: str | None = None,
    account: str | None = None,
    exchange: str | None = None,
    strategy: str | None = None,
    side: str | None = None,
    service: str | None = None,
    level: str | None = None,
    pair: str | None = None,
    status: str | None = None,
    order_id: str | None = None,
    limit: int = _EXPORT_MAX,
) -> StreamingResponse:
    col_names, _types, where_sql, params, order_sql, _sc, _sd = await _prepare_table(
        name, sort=sort, direction=direction, q=q, since=since, until=until,
        contract=contract, account=account, exchange=exchange, strategy=strategy,
        side=side, service=service, level=level, pair=pair, status=status, order_id=order_id,
    )
    params = list(params)
    params.append(limit)
    sql = f"SELECT * FROM {_qi(name)} {where_sql} {order_sql} LIMIT ${len(params)}"
    filename = _export_filename(name, since, until, contract)

    async def generate():
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(col_names)
        yield buf.getvalue()
        buf.seek(0)
        buf.truncate(0)
        async with _db.pool.acquire() as conn:
            async with conn.transaction():
                n = 0
                async for rec in conn.cursor(sql, *params):
                    writer.writerow([_csvable(rec[c]) for c in col_names])
                    n += 1
                    if n % 250 == 0:
                        yield buf.getvalue()
                        buf.seek(0)
                        buf.truncate(0)
                leftover = buf.getvalue()
                if leftover:
                    yield leftover

    return StreamingResponse(
        generate(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/db/tables")
async def db_tables() -> list[dict]:
    """All public tables with row counts."""
    _require_db()
    async with _db.pool.acquire() as conn:
        names = await _public_tables(conn)
        out = []
        for tname in names:
            count = await conn.fetchval(f"SELECT COUNT(*) FROM {_qi(tname)}")
            out.append({"name": tname, "rows": int(count)})
    return out


@app.get("/api/db/table/{name}/facets")
async def db_table_facets(name: str) -> dict:
    """Distinct values for filter dropdowns (capped)."""
    _require_db()
    if not _IDENT_RE.fullmatch(name):
        raise HTTPException(status_code=404, detail=f"unknown table '{name}'")
    async with _db.pool.acquire() as conn:
        names = await _public_tables(conn)
        if name not in names:
            raise HTTPException(status_code=404, detail=f"unknown table '{name}'")
        col_names, _types = await _table_meta(conn, name)
        cols = set(col_names)
        out: dict[str, list[str]] = {}
        for col in ("contract", "exchange", "strategy", "account", "side", "service", "level", "pair", "status"):
            if col not in cols:
                continue
            ident = _qi(col)
            time_clip = ""
            if name in ("fills", "orders", "logs", "events", "positions") and "created_at" in cols:
                time_clip = "AND created_at > NOW() - INTERVAL '365 days'"
            rows = await conn.fetch(
                f"SELECT DISTINCT TRIM({ident}::text) AS v FROM {_qi(name)} "
                f"WHERE {ident} IS NOT NULL AND TRIM({ident}::text) <> '' {time_clip} "
                f"ORDER BY 1 LIMIT 400"
            )
            vals = [r["v"] for r in rows if r["v"]]
            if col == "account":
                blank = await conn.fetchval(
                    f"SELECT EXISTS(SELECT 1 FROM {_qi(name)} "
                    f"WHERE COALESCE(TRIM({ident}::text), '') = '' {time_clip})"
                )
                if blank:
                    vals = ["(blank)"] + vals
            out[col] = vals
    return {"table": name, "facets": out}


@app.get("/api/db/table/{name}/export")
async def db_table_export(
    name: str,
    sort: str | None = Query(None),
    dir: str = Query("desc"),
    q: str | None = Query(None),
    since: str | None = Query(None, description="unix, ISO, or YYYY-MM-DD (IST)"),
    until: str | None = Query(None, description="unix, ISO, or YYYY-MM-DD (IST, inclusive)"),
    contract: str | None = Query(None),
    account: str | None = Query(None),
    exchange: str | None = Query(None),
    strategy: str | None = Query(None, description="omit for all strategies"),
    side: str | None = Query(None),
    service: str | None = Query(None),
    level: str | None = Query(None),
    pair: str | None = Query(None),
    status: str | None = Query(None),
    order_id: str | None = Query(None),
    limit: int = Query(_EXPORT_MAX, ge=1, le=_EXPORT_MAX),
):
    """CSV of the filtered table. Times are IST. Capped at 100k rows."""
    return await _csv_streaming_response(
        name, sort=sort, direction=dir, q=q, since=since, until=until,
        contract=contract, account=account, exchange=exchange, strategy=strategy,
        side=side, service=service, level=level, pair=pair, status=status,
        order_id=order_id, limit=limit,
    )


_RPNL_PACK_KINDS = (
    "fills", "logs", "orders", "events", "positions", "account_balances", "reports",
)


@app.get("/api/rpnl/export-pack")
async def rpnl_export_pack(
    since: str = Query(..., description="unix or IST ISO start"),
    until: str = Query(..., description="unix or IST ISO end"),
    strategy: str = Query("opa3"),
    contract: str | None = Query(None),
    account: str | None = Query(None),
    exchange: str | None = Query(None),
    kinds: str = Query("fills,logs,orders,events,positions,account_balances"),
):
    """ZIP of CSVs for the rPnL chart selection (same filters as the table browser)."""
    _require_db()
    wanted = [k.strip().lower() for k in (kinds or "").split(",") if k.strip()]
    wanted = [k for k in wanted if k in _RPNL_PACK_KINDS]
    if not wanted:
        raise HTTPException(status_code=400, detail="no known export kinds")
    buf = io.BytesIO()
    note = [
        f"strategy={strategy}",
        f"contract={contract or '-'}",
        f"account={account or '-'}",
        f"exchange={exchange or '-'}",
        f"since={since}",
        f"until={until}",
        f"kinds={','.join(wanted)}",
    ]
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("README.txt", "\n".join(note) + "\n")
        for kind in wanted:
            filt = {
                "since": since,
                "until": until,
                "strategy": strategy,
                "account": account or None,
                "exchange": exchange or None,
            }
            if kind in ("fills", "orders", "events", "positions"):
                filt["contract"] = contract
            elif kind == "logs":
                filt = {
                    "since": since,
                    "until": until,
                    "service": "bot",
                    "strategy": strategy,
                    "account": account or None,
                    "contract": contract,
                }
            try:
                fname, text = await _table_csv_text(kind, **filt)
            except HTTPException as exc:
                zf.writestr(f"{kind}_ERROR.txt", str(exc.detail))
                continue
            zf.writestr(fname, text)
    pack_name = _export_filename("rpnl_pack", since, until, contract, ext="zip")
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{pack_name}"'},
    )


@app.get("/api/db/table/{name}")
async def db_table(
    name: str,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    sort: str | None = Query(None),
    dir: str = Query("desc"),
    q: str | None = Query(None, description="ILIKE across text columns"),
    since: str | None = Query(None, description="unix, ISO, or YYYY-MM-DD (IST)"),
    until: str | None = Query(None, description="unix, ISO, or YYYY-MM-DD (IST, inclusive)"),
    contract: str | None = Query(None),
    account: str | None = Query(None),
    exchange: str | None = Query(None),
    strategy: str | None = Query(None, description="omit for all strategies"),
    side: str | None = Query(None),
    service: str | None = Query(None),
    level: str | None = Query(None),
    pair: str | None = Query(None),
    status: str | None = Query(None),
    order_id: str | None = Query(None),
) -> dict:
    """Paginated read-only table view with sort + filters. Newest first by default."""
    col_names, col_types, where_sql, params, order_sql, sort_col, sort_dir = await _prepare_table(
        name, sort=sort, direction=dir, q=q, since=since, until=until,
        contract=contract, account=account, exchange=exchange, strategy=strategy,
        side=side, service=service, level=level, pair=pair, status=status, order_id=order_id,
    )
    tbl = _qi(name)
    count_sql = f"SELECT COUNT(*) FROM {tbl} {where_sql}"
    data_params = list(params)
    data_params.extend([limit, offset])
    data_sql = (
        f"SELECT * FROM {tbl} {where_sql} {order_sql} "
        f"LIMIT ${len(params) + 1} OFFSET ${len(params) + 2}"
    )
    stats = None
    cols = set(col_names)
    async with _db.pool.acquire() as conn:
        total = int(await conn.fetchval(count_sql, *params) or 0)
        rows = await conn.fetch(data_sql, *data_params)
        if where_sql and {"rpnl", "fee", "cost"} <= cols:
            agg = await conn.fetchrow(
                f"SELECT COALESCE(SUM(rpnl), 0)::float AS rpnl, "
                f"COALESCE(SUM(fee), 0)::float AS fee, "
                f"COALESCE(SUM(cost), 0)::float AS cost "
                f"FROM {tbl} {where_sql}",
                *params,
            )
            stats = {
                "rpnl": float(agg["rpnl"] or 0),
                "fee": float(agg["fee"] or 0),
                "cost": float(agg["cost"] or 0),
            }
    return {
        "table":   name,
        "columns": col_names,
        "types":   col_types,
        "total":   total,
        "offset":  offset,
        "sort":    sort_col,
        "dir":     sort_dir,
        "stats":   stats,
        "rows":    [[_jsonable(r[c]) for c in col_names] for r in rows],
    }


@app.get("/api/fills")
async def fills_list(
    contract: str | None = Query(None),
    exchange: str | None = Query(None, description="delta | binance | coindcx | hedge"),
    hours: int = Query(24, ge=1, le=720),
    limit: int = Query(500, ge=1, le=2000),
    strategy: str = Query("opa3", description="strategy tag, e.g. opa3 | opa4"),
) -> list[dict]:
    """Fills for the cross-match view. exchange='hedge' means any non-delta venue."""
    _require_db()
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    wheres, params = ["created_at >= $1"], [since]
    if contract:
        aliases = contract_aliases(contract)
        params.append(aliases)
        wheres.append(f"UPPER(contract) = ANY(${len(params)}::text[])")
    if exchange == "hedge":
        wheres.append("exchange <> 'delta'")
    elif exchange:
        params.append(exchange.lower())
        wheres.append(f"exchange = ${len(params)}")
    params.append(strategy)
    wheres.append(f"strategy::text = ${len(params)}")
    params.append(limit)
    async with _db.pool.acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT id, created_at, contract, exchange, order_id, side,
                   quantity::float AS quantity, price::float AS price,
                   cost::float AS cost, fee::float AS fee, rpnl::float AS rpnl,
                   COALESCE(account::text, '') AS account
            FROM fills WHERE {' AND '.join(wheres)}
            ORDER BY created_at DESC LIMIT ${len(params)}
            """,
            *params,
        )
    return [
        {
            "id":       r["id"],
            "time":     int(r["created_at"].timestamp()),
            "contract": r["contract"],
            "exchange": r["exchange"],
            "order_id": r["order_id"],
            "side":     r["side"],
            "quantity": r["quantity"],
            # delta rows store lots; hedge rows already store units
            "units":    r["quantity"] * _CONTRACT_VALUE.get(r["contract"], 1.0) if r["exchange"] == "delta" else r["quantity"],
            "price":    r["price"],
            # cost/fee/rpnl are USD-native for delta/binance → convert to ₹; coindcx is already INR
            "cost":     (r["cost"] * _db.usdinr_rate) if (r["cost"] is not None and r["exchange"] in ("delta", "binance")) else r["cost"],
            "fee":      (r["fee"] * _db.usdinr_rate) if (r["fee"] is not None and r["exchange"] in ("delta", "binance")) else r["fee"],
            "rpnl":     (r["rpnl"] * _db.usdinr_rate) if (r["rpnl"] is not None and r["exchange"] in ("delta", "binance")) else r["rpnl"],
            "account":  r["account"] or "",
        }
        for r in rows
    ]


@app.get("/api/orders")
async def orders_list(
    contract: str | None = Query(None),
    exchange: str | None = Query(None, description="delta | binance | coindcx | hedge"),
    hours: int = Query(24, ge=1, le=720),
    limit: int = Query(500, ge=1, le=2000),
    strategy: str = Query("opa3", description="strategy tag, e.g. opa3 | opa4"),
) -> list[dict]:
    """Order history (incl. partially-filled-then-cancelled orders)."""
    _require_db()
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    rows = await _db.get_orders(contract=contract, exchange=exchange, since=since, limit=limit, strategy=strategy)
    out = []
    for r in rows:
        is_delta = r["exchange"] == "delta"
        cv = _CONTRACT_VALUE.get(r["contract"], 1.0) if is_delta else 1.0
        out.append({
            "time":           int(r["created_at"].timestamp()),
            "contract":       r["contract"],
            "exchange":       r["exchange"],
            "order_id":       r["order_id"],
            "side":           r["side"],
            "order_type":     r["order_type"],
            "price":          r["price"],
            "avg_fill_price": r["avg_fill_price"],
            "size":           r["size"],
            "filled_size":    r["filled_size"],
            "filled_units":   (r["filled_size"] or 0) * cv,
            "fee":            r.get("fee"),
            "status":         r["status"],
        })
    return out


@app.get("/api/rpnl/summary")
async def rpnl_summary(
    hours: int | None = Query(None, ge=1, le=8760, description="lookback window; omit for all-time"),
    strategy: str = Query("opa3", description="strategy tag, e.g. opa3 | opa4"),
) -> dict:
    """Authoritative realized-PnL summary computed via VWAP over the orders table."""
    _require_db()
    since = datetime.now(timezone.utc) - timedelta(hours=hours) if hours else None
    return await _db.get_rpnl_summary(_CONTRACT_VALUE, since=since, strategy=strategy)


@app.get("/api/coindcx/transactions")
async def coindcx_transactions(
    pair: str | None = Query(None, description="e.g. B-LAB_USDT"),
    hours: int = Query(168, ge=1, le=8760),
    limit: int = Query(500, ge=1, le=2000),
) -> list[dict]:
    """CoinDCX authoritative transaction history (PnL + fees per closed trade)."""
    _require_db()
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    rows = await _db.get_coindcx_transactions(pair=pair, since=since, limit=limit)
    out = []
    for r in rows:
        out.append({
            "time":             int(r["created_at"].timestamp()) if r["created_at"] else None,
            "pair":             r["pair"],
            "stage":            r["stage"],
            "amount":           r["amount"],
            "fee_amount":       r["fee_amount"],
            "net_pnl":          round((r["amount"] or 0) - abs(r["fee_amount"] or 0), 4),
            "price_in_usdt":    r["price_in_usdt"],
            "source":           r["source"],
            "parent_id":        r["parent_id"],
            "margin_ccy":       r["margin_ccy"],
        })
    return out


@app.get("/api/logs")
async def logs_list(
    limit: int = Query(200, ge=1, le=5000),
    service: str | None = Query(None, description="bot | webapp"),
    level: str | None = Query(None),
    search: str | None = Query(None),
    after_id: int | None = Query(None, description="tail mode: only rows with id > after_id"),
    before_id: int | None = Query(None, description="load-older mode: only rows with id < before_id"),
    since: str | None = Query(None, description="unix, ISO, or YYYY-MM-DD (IST)"),
    until: str | None = Query(None, description="unix, ISO, or YYYY-MM-DD (IST, inclusive)"),
    strategy: str | None = Query(None),
    account: str | None = Query(None),
    contract: str | None = Query(None),
    exchange: str | None = Query(None),
) -> list[dict]:
    """Live service logs streamed to the DB by bot and webapp."""
    _require_db()
    return await _db.get_logs(
        limit=limit, service=service, level=level, search=search,
        after_id=after_id, before_id=before_id,
        since=_parse_bound(since, end=False),
        until=_parse_bound(until, end=True),
        strategy=strategy, account=account, contract=contract, exchange=exchange,
    )


@app.get("/api/logs/export")
async def logs_export(
    service: str | None = Query(None),
    level: str | None = Query(None),
    search: str | None = Query(None),
    since: str | None = Query(None),
    until: str | None = Query(None),
    strategy: str | None = Query(None),
    account: str | None = Query(None),
    contract: str | None = Query(None),
    exchange: str | None = Query(None),
    limit: int = Query(50_000, ge=1, le=_EXPORT_MAX),
):
    """CSV export of filtered service logs. Times are IST."""
    return await _csv_streaming_response(
        "logs", sort="id", direction="desc", q=search,
        since=since, until=until, service=service, level=level,
        strategy=strategy, account=account, contract=contract, exchange=exchange,
        limit=limit,
    )


@app.get("/api/positions/latest")
async def positions_latest(
    strategy: str = Query("opa3", description="strategy tag, e.g. opa3 | opa4"),
) -> list[dict]:
    """Latest position snapshot per contract, plus 24h snapshot count."""
    _require_db()
    async with _db.pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT DISTINCT ON (contract)
                   contract, created_at,
                   delta_size::float    AS delta_size,
                   delta_entry::float   AS delta_entry,
                   binance_size::float  AS binance_size,
                   binance_entry::float AS binance_entry,
                   mark_price::float    AS mark_price,
                   net_upnl::float      AS net_upnl
            FROM positions
            WHERE strategy = $1
            ORDER BY contract, created_at DESC
            """,
            strategy,
        )
    return [
        {
            "contract":      r["contract"],
            "time":          int(r["created_at"].timestamp()),
            "delta_size":    r["delta_size"],
            "delta_units":   (r["delta_size"] or 0) * _CONTRACT_VALUE.get(r["contract"], 1.0),
            "delta_entry":   r["delta_entry"],
            "binance_size":  r["binance_size"],
            "binance_entry": r["binance_entry"],
            "mark_price":    r["mark_price"],
            "net_upnl":      r["net_upnl"],
        }
        for r in rows
    ]


@app.get("/api/positions/snapshots")
async def positions_snapshots(
    contract: str = Query(...),
    limit: int = Query(100, ge=1, le=1000),
    strategy: str = Query("opa3", description="strategy tag, e.g. opa3 | opa4"),
) -> list[dict]:
    """Recent raw position snapshots for one contract, newest first."""
    _require_db()
    async with _db.pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT created_at,
                   delta_size::float    AS delta_size,
                   delta_entry::float   AS delta_entry,
                   binance_size::float  AS binance_size,
                   binance_entry::float AS binance_entry,
                   mark_price::float    AS mark_price,
                   net_upnl::float      AS net_upnl
            FROM positions WHERE contract = $1 AND strategy = $2
            ORDER BY created_at DESC LIMIT $3
            """,
            contract.upper(), strategy, limit,
        )
    cv = _CONTRACT_VALUE.get(contract.upper(), 1.0)
    return [
        {
            "time":          int(r["created_at"].timestamp()),
            "delta_size":    r["delta_size"],
            "delta_units":   (r["delta_size"] or 0) * cv,
            "delta_entry":   r["delta_entry"],
            "binance_size":  r["binance_size"],
            "binance_entry": r["binance_entry"],
            "mark_price":    r["mark_price"],
            "net_upnl":      r["net_upnl"],
        }
        for r in rows
    ]


if __name__ == "__main__":
    import uvicorn

    # Railway injects PORT — fall back to 8800 for local runs
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8800")))
