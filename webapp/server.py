"""OPADash — fills / PnL viewer. No trading.

    uvicorn webapp.server:app --reload --port 8800
    http://127.0.0.1:8800
"""
from __future__ import annotations

import logging
import os
import secrets
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from config.settings import Settings
from config.symbol import SYMBOL_LAB, SYMBOL_MMT, SYMBOL_VELVET, SYMBOL_AIOT
from config import symbol as _symbol_module
from utils.events_db import EventsDB, canon_contract, contract_aliases
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


_VENUE_LABEL = {"delta": "Delta", "binance": "Binance", "coindcx": "CoinDCX"}


def _norm_quote_venue(raw: str | None) -> str:
    v = (raw or "delta").strip().lower()
    if v in ("b", "binance"):
        return "binance"
    if v in ("c", "coindcx"):
        return "coindcx"
    return "delta"


def _hedge_venue_name(cfg: _SymbolConfig | None) -> str:
    if cfg is None:
        return ""
    hv = (cfg.hedge_venue or "").strip().upper()
    if hv == "B":
        return "binance"
    if hv == "C":
        return "coindcx"
    qv = _norm_quote_venue(cfg.quote_venue)
    if qv == "delta":
        return "coindcx"
    return "delta"


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


def contract_meta(name: str) -> dict:
    """Display names + quote/hedge venues for a fills contract."""
    cfg = _cfg_for_contract(name)
    raw = (name or "").upper()
    if cfg is None:
        return {
            "contract": canon_contract(raw) or raw,
            "quote_venue": "delta",
            "quote_label": "Delta",
            "quote_symbol": raw,
            "hedge_venue": "coindcx",
            "hedge_label": "CoinDCX",
            "hedge_symbol": "",
            "label": raw,
        }
    qv = _norm_quote_venue(cfg.quote_venue)
    hv = _hedge_venue_name(cfg)
    if qv == "binance":
        quote_symbol = cfg.binance_symbol or cfg.delta_symbol
    elif qv == "coindcx":
        quote_symbol = cfg.coindcx_symbol or cfg.delta_symbol
    else:
        quote_symbol = cfg.delta_symbol
    if hv == "binance":
        hedge_symbol = cfg.binance_symbol
    elif hv == "coindcx":
        hedge_symbol = cfg.coindcx_symbol
    else:
        hedge_symbol = cfg.delta_symbol
    qlab = _VENUE_LABEL.get(qv, qv)
    hlab = _VENUE_LABEL.get(hv, hv)
    return {
        "contract": canon_contract(cfg.delta_symbol) or cfg.delta_symbol,
        "quote_venue": qv,
        "quote_label": qlab,
        "quote_symbol": quote_symbol,
        "hedge_venue": hv,
        "hedge_label": hlab,
        "hedge_symbol": hedge_symbol or "",
        "label": f"{quote_symbol} · {qlab}",
    }


def _annotate_rpnl_row(row: dict) -> dict:
    meta = contract_meta(row.get("contract") or "")
    qv = meta["quote_venue"]
    delta_rpnl = float(row.get("rpnl") or 0)
    binance_rpnl = float(row.get("binance_rpnl") or 0)
    cdcx_rpnl = float(row.get("cdcx_rpnl") or 0)
    delta_fills = int(row.get("fills") or 0)
    binance_fills = int(row.get("binance_fills") or 0)
    cdcx_fills = int(row.get("cdcx_fills") or 0)
    if qv == "binance":
        quote_rpnl, quote_fills = binance_rpnl, binance_fills
        hedge_rpnl = delta_rpnl + cdcx_rpnl
        hedge_fills = delta_fills + cdcx_fills
    elif qv == "coindcx":
        quote_rpnl, quote_fills = cdcx_rpnl, cdcx_fills
        hedge_rpnl = delta_rpnl + binance_rpnl
        hedge_fills = delta_fills + binance_fills
    else:
        quote_rpnl, quote_fills = delta_rpnl, delta_fills
        hedge_rpnl = binance_rpnl + cdcx_rpnl
        hedge_fills = binance_fills + cdcx_fills
    row = dict(row)
    row.update(meta)
    row["rpnl"] = round(quote_rpnl, 2)
    row["fills"] = quote_fills
    row["hedge_rpnl"] = round(hedge_rpnl, 2)
    row["hedge_fills"] = hedge_fills
    acct = row.get("account_name") or row.get("account") or ""
    row["label"] = meta["label"] + (f" · {acct}" if acct else "")
    return row

# Delta candle resolution -> seconds per candle, used to size the start/end window
_RESOLUTION_SECONDS = {
    "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200,
    "4h": 14400, "1d": 86400,
}


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
                       COALESCE(account, '') AS account,
                       COALESCE(MAX(details->>'account_name'), '') AS account_name
                FROM fills
                WHERE strategy = $1
                GROUP BY contract, COALESCE(account, '')
                ORDER BY contract, account
                """,
                strategy,
            )
        merged: dict[tuple[str, str], dict] = {}
        for r in rows:
            account = r["account"] or ""
            name = r["account_name"] or account
            contract = canon_contract(r["contract"])
            key = (contract, account)
            if key in merged:
                continue
            meta = contract_meta(contract)
            acct_bit = f" · {name}" if name else ""
            merged[key] = {
                "contract": contract,
                "account": account,
                "account_name": name,
                **{k: meta[k] for k in (
                    "quote_venue", "quote_label", "quote_symbol",
                    "hedge_venue", "hedge_label", "hedge_symbol",
                )},
                "label": meta["label"] + acct_bit,
            }
        return list(merged.values())
    except Exception as e:
        logger.warning("webapp: rpnl_symbols failed: %s", e)
        return []


@app.get("/api/rpnl")
async def rpnl_chart(
    symbol: str = Query(..., description="Contract name (e.g. LABUSD) or symbol key (e.g. LAB)"),
    hours: int = Query(24, ge=1, le=2160, description="Lookback window in hours"),
    bucket: int = Query(5, ge=1, le=60, description="Bucket size in minutes"),
    strategy: str = Query("opa3", description="strategy tag, e.g. opa3 | opa4"),
    account: str | None = Query(None, description="Delta account id; omit to merge all"),
    exchange: str = Query("delta", description="delta | coindcx | hedge"),
) -> dict:
    """Cumulative rPnL timeseries for a contract, bucketed by `bucket` minutes."""
    cfg = _SYMBOLS.get(symbol.upper())
    contract = cfg.delta_symbol if cfg else symbol.upper()
    meta = contract_meta(contract)
    qv = meta["quote_venue"]
    if _db is None or not _db.pool:
        raise HTTPException(status_code=503, detail=f"Database not connected: {_db_error or 'no pool'}")
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    try:
        if exchange in ("coindcx", "hedge"):
            points = await _db.get_rpnl_timeseries(
                contract, since, bucket_minutes=bucket, strategy=strategy,
                account=None, exchange="not_quote", quote_venue=qv,
            )
            hedge_points = []
        elif exchange == "delta":
            # UI "Delta only" = quote venue only (may be Binance when quote_venue=binance)
            points = await _db.get_rpnl_timeseries(
                contract, since, bucket_minutes=bucket, strategy=strategy,
                account=account, exchange="quote", quote_venue=qv,
            )
            hedge_points = []
        else:
            points = await _db.get_rpnl_timeseries(
                contract, since, bucket_minutes=bucket, strategy=strategy,
                account=account, exchange="quote", quote_venue=qv,
            )
            hedge_points = await _db.get_rpnl_timeseries(
                contract, since, bucket_minutes=bucket, strategy=strategy,
                account=None, exchange="not_quote", quote_venue=qv,
            )
    except Exception as e:
        logger.error("webapp: rpnl query failed for %s: %s", contract, e)
        raise HTTPException(status_code=500, detail=f"query failed: {e}") from e
    logger.info(
        "webapp: rpnl %s quote=%s account=%s exch=%s %dh -> %d points hedge=%d",
        contract, qv, account or "-", exchange, hours, len(points), len(hedge_points),
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
) -> list[dict]:
    """Per-contract realized PnL from fills (for the rPnL page table)."""
    if _db is None or not _db.pool:
        raise HTTPException(status_code=503, detail=f"Database not connected: {_db_error or 'no pool'}")
    rows = await _db.get_contract_rpnl_summary(strategy=strategy)
    return [_annotate_rpnl_row(r) for r in rows]


@app.get("/api/rpnl/fills")
async def rpnl_fills(
    symbol: str = Query(...),
    hours: int = Query(24, ge=1, le=2160),
    strategy: str = Query("opa3"),
    account: str | None = Query(None),
    exchange: str = Query("delta"),
    bucket: int = Query(5, ge=1, le=1440),
) -> dict:
    """Fills in the window — overlay on OHLC."""
    cfg = _SYMBOLS.get(symbol.upper())
    contract = cfg.delta_symbol if cfg else symbol.upper()
    meta = contract_meta(contract)
    qv = meta["quote_venue"]
    if _db is None or not _db.pool:
        raise HTTPException(status_code=503, detail=f"Database not connected: {_db_error or 'no pool'}")
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    exch = exchange
    if exchange == "delta":
        exch = "quote"
    elif exchange in ("hedge", "both"):
        exch = "not_quote"
    fills = await _db.get_fill_markers(
        contract, since, strategy=strategy, account=account, exchange=exch,
        bucket_seconds=max(60, int(bucket) * 60), quote_venue=qv,
    )
    return {"contract": contract, "account": account or "", "exchange": exchange, **meta, "fills": fills}


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
                    "open": float(c["open"]),
                    "high": float(c["high"]),
                    "low": float(c["low"]),
                    "close": float(c["close"]),
                }
            if t1 >= end:
                break
            t0 = t1
    return sorted(by_t.values(), key=lambda p: p["time"])


_BINANCE_INTERVAL = {
    "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
    "1h": "1h", "2h": "2h", "4h": "4h", "1d": "1d",
}


async def _fetch_binance_ohlc(symbol: str, interval: str, lookback_secs: int) -> list[dict]:
    """USDT-M futures trade klines."""
    end_ms = int(time.time() * 1000)
    start_ms = (int(time.time()) - lookback_secs) * 1000
    ivl = _BINANCE_INTERVAL.get(interval, "5m")
    by_t: dict[int, dict] = {}
    t0 = start_ms
    async with httpx.AsyncClient(base_url=settings.binance_rest_url, timeout=20) as client:
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
                    "open": float(row[1]),
                    "high": float(row[2]),
                    "low": float(row[3]),
                    "close": float(row[4]),
                }
            last_open = int(rows[-1][0])
            nxt = last_open + 1
            if nxt <= t0:
                break
            t0 = nxt
            if len(rows) < 1500:
                break
    return sorted(by_t.values(), key=lambda p: p["time"])


@app.get("/api/candles")
async def candles(
    symbol: str = Query(..., description="Delta product symbol e.g. LABUSD"),
    interval: str = Query("5m"),
    hours: int = Query(24, ge=1, le=2160),
) -> dict:
    """OHLC for the quote venue — used under fill overlay on the rPnL page."""
    cfg_dash = _SYMBOLS.get(symbol.upper())
    contract = cfg_dash.delta_symbol if cfg_dash else symbol.upper()
    meta = contract_meta(contract)
    if interval not in _RESOLUTION_SECONDS:
        raise HTTPException(status_code=400, detail=f"unknown interval '{interval}'")
    lookback = hours * 3600
    qv = meta["quote_venue"]
    try:
        if qv == "binance" and meta.get("quote_symbol"):
            bars = await _fetch_binance_ohlc(meta["quote_symbol"], interval, lookback)
        else:
            bars = await _fetch_delta_ohlc(meta.get("quote_symbol") or contract, interval, lookback)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"{qv} candles failed: {exc}") from exc
    return {"contract": contract, "interval": interval, "venue": qv, **meta, "candles": bars}


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


async def _public_tables(conn) -> list[str]:
    rows = await conn.fetch(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
    )
    return [r["tablename"] for r in rows]


@app.get("/api/db/tables")
async def db_tables() -> list[dict]:
    """All public tables with row counts."""
    _require_db()
    async with _db.pool.acquire() as conn:
        names = await _public_tables(conn)
        out = []
        for name in names:
            count = await conn.fetchval(f'SELECT COUNT(*) FROM "{name}"')
            out.append({"name": name, "rows": int(count)})
    return out


@app.get("/api/db/table/{name}")
async def db_table(
    name: str,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> dict:
    """Generic paginated read-only view of one table, newest rows first."""
    _require_db()
    async with _db.pool.acquire() as conn:
        names = await _public_tables(conn)
        if name not in names:
            raise HTTPException(status_code=404, detail=f"unknown table '{name}'")
        cols = await conn.fetch(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position",
            name,
        )
        col_names = [c["column_name"] for c in cols]
        order = 'ORDER BY "id" DESC' if "id" in col_names else ""
        total = await conn.fetchval(f'SELECT COUNT(*) FROM "{name}"')
        rows = await conn.fetch(f'SELECT * FROM "{name}" {order} LIMIT $1 OFFSET $2', limit, offset)
    return {
        "table":   name,
        "columns": col_names,
        "total":   int(total),
        "offset":  offset,
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
    wheres.append(f"strategy = ${len(params)}")
    params.append(limit)
    async with _db.pool.acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT id, created_at, contract, exchange, order_id, side,
                   quantity::float AS quantity, price::float AS price,
                   cost::float AS cost, fee::float AS fee, rpnl::float AS rpnl,
                   COALESCE(account, '') AS account
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
) -> list[dict]:
    """Live service logs streamed to the DB by bot and webapp."""
    _require_db()
    return await _db.get_logs(
        limit=limit, service=service, level=level, search=search,
        after_id=after_id, before_id=before_id,
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
