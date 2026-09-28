"""rPnL ops: accounts, products, strategy knobs, Delta sub-account transfers."""
from __future__ import annotations

import json
import os
import time
from typing import Any

import httpx

from config.settings import load_env_file
from webapp.wallets import _LABELS, _delta_headers, _num, load_wallet_accounts

GEOM_LENS = [
    {
        "id": "hem", "label": "Hem",
        "hint": "Cover-side edge off the hook",
        "pct_key": "HEM_PCT", "ticks_key": "HEM_TICKS",
        "pct_default": "0.1", "ticks_default": "4",
    },
    {
        "id": "span", "label": "Span",
        "hint": "Other edge, measured from the hem",
        "pct_key": "SPAN_PCT", "ticks_key": "SPAN_TICKS",
        "pct_default": "0.5", "ticks_default": "10",
    },
    {
        "id": "step", "label": "Step",
        "hint": "First same-side gap behind an edge",
        "pct_key": "STEP_PCT", "ticks_key": "STEP_TICKS",
        "pct_default": "0.1", "ticks_default": "4",
    },
    {
        "id": "tail", "label": "Tail",
        "hint": "Same-side gaps behind both edges",
        "pct_key": "TAIL_PCT", "ticks_key": "STEP_TICKS",
        "pct_default": "0.1", "ticks_default": "4",
    },
    {
        "id": "k", "label": "K",
        "hint": "Offset from the touch. 0 joins BBO",
        "pct_key": "K_PCT", "ticks_key": "K_TICKS",
        "pct_default": "0", "ticks_default": "0",
        "allow_zero": True,
    },
]

_HOOK = {
    "key": "HOOK", "label": "Hook", "type": "select", "default": "position", "group": "book",
    "wide": True,
    "options": [
        {"value": "position", "label": "position · inventory"},
        {"value": "liquidity", "label": "liquidity · heavier book"},
        {"value": "bid", "label": "bid"},
        {"value": "ask", "label": "ask"},
    ],
}
_MULT = {
    "key": "STEP_MULT", "label": "Step ×", "type": "select", "default": "1", "group": "geometry",
    "options": [
        {"value": "1", "label": "1 · equal gaps"},
        {"value": "2", "label": "2 · double"},
        {"value": "3", "label": "3 · triple"},
        {"value": "log", "label": "log · ×e"},
        {"value": "log2", "label": "log2 · ×2,×4"},
        {"value": "log10", "label": "log10 · ×10,×100"},
    ],
}
_ORDERS = {"key": "ORDERS", "label": "Orders / side", "type": "int", "default": "3", "group": "size"}
_DRY = {"key": "DRY_RUN", "label": "Dry run", "type": "bool", "default": False, "group": "risk"}


def _max(label="Max", default="10000"):
    """Max number + USD/lots unit. Pair stays coin-only and does not use this."""
    return [{
        "key": "MAX_POSITION",
        "label": label,
        "type": "max",
        "default": default,
        "group": "size",
        "unit": "usd",
        "units": [
            {"id": "usd", "label": "USD"},
            {"id": "lots", "label": "lots"},
        ],
    }]


def _geom(lenses, hint="", defaults=None):
    row = {"key": "GEOM", "type": "geom", "lenses": list(lenses), "group": "geometry", "hint": hint}
    if defaults:
        row["lens_defaults"] = defaults
    return row


def _fate():
    return [
        {"key": "FATE_USD", "label": "Fate $", "type": "number", "default": "10", "group": "risk"},
        {"key": "GRIND_USD", "label": "Grind $", "type": "number", "default": "10", "group": "risk"},
    ]


def _ladder(*, fit=True, fit_default=False, span_spread=False, touch=False, vol=False, fate=True, hook=True):
    """Hem/span/step makers: stack, clip, chop, fade, flip."""
    rows = _max() + [_ORDERS]
    if hook:
        rows.append(_HOOK)
    rows.append(_geom(
        ["hem", "span", "step"],
        "Each edge is % of price, or whole ticks. Ticks win. Fit auto will not overwrite a tick lock.",
    ))
    rows.append(_MULT)
    if fit:
        rows.append({"key": "FIT_AUTO", "label": "Fit auto", "type": "bool", "default": fit_default, "group": "geometry"})
    if span_spread:
        rows.append({
            "key": "SPAN_SPREAD", "label": "Span spread", "type": "bool", "default": True, "group": "geometry",
            "hint": "When the live bid–ask is wider than span, hang inner quotes on the spread.",
        })
    if touch:
        rows.append({
            "key": "TOUCH_TICKS", "label": "Touch ticks", "type": "int", "default": "1", "group": "geometry",
            "min": 0,
            "show_if_any": ["SPAN_SPREAD", "FIT_AUTO"],
            "hint": "How far inside the BBO when span follows the spread. 0 joins the touch.",
        })
    if fate:
        rows.extend(_fate())
    rows.append({"key": "VOL_GATE", "label": "Vol gate", "type": "bool", "default": vol, "group": "risk"})
    rows.append(_DRY)
    return rows


def _touch_like(*, k_default="0", step_default="0.05"):
    """Join BBO (touch / lean): k + step, no hem/span."""
    return _max() + [
        _ORDERS,
        _geom(
            ["k"],
            "Offset from the touch. 0 joins BBO. Ticks win over %.",
            defaults={"k": {"pct_default": k_default}},
        ),
        {"key": "STEP_AUTO", "label": "Fit step", "type": "bool", "default": True, "group": "geometry"},
        {"key": "STEP_PCT", "label": "Step %", "type": "number", "default": step_default, "group": "geometry"},
        _MULT,
        *_fate(),
        {"key": "VOL_GATE", "label": "Vol gate", "type": "bool", "default": True, "group": "risk"},
        _DRY,
    ]


PAIR_PARAMS = [
    {"key": "MAX_POSITION", "label": "Max coin", "type": "number", "default": "2", "group": "size"},
    {"key": "PAIR_HEDGE", "label": "Hedge with perpetual", "type": "bool", "default": True, "group": "hedge"},
    {
        "key": "PAIR_HEDGE_LOT", "label": "Hedge lot", "type": "int", "default": "1", "group": "hedge",
        "min": 1, "hint": "Min contracts off-target before a hedge order.",
    },
    {"key": "BID_TICKS", "label": "Bid +ticks", "type": "int", "default": "1", "group": "quote"},
    {"key": "ASK_TICKS", "label": "Ask −ticks", "type": "int", "default": "1", "group": "quote"},
]

STRATEGIES = [
    {
        "id": "stack", "label": "Stack",
        "blurb": "Hem/span ladder hung off the hook.",
        "params": _ladder(span_spread=True, touch=True, vol=False),
    },
    {
        "id": "pair", "label": "Pair",
        "blurb": "Delta options: buy above bid, sell under ask. Optional perp hedge.",
        "params": PAIR_PARAMS,
    },
    {
        "id": "clip", "label": "Clip",
        "blurb": "Hem/span ladder with clip-sized rungs.",
        "params": _ladder(vol=True),
    },
    {
        "id": "chop", "label": "Chop",
        "blurb": "Hem/span ladder; span stays at env width.",
        "params": _ladder(vol=True),
    },
    {
        "id": "fade", "label": "Fade",
        "blurb": "Hem/span ladder that fades tape bursts.",
        "params": _ladder(vol=True),
    },
    {
        "id": "flip", "label": "Flip",
        "blurb": "Hem/span ladder; fit auto and touch clamp on.",
        "params": _ladder(fit_default=True, touch=True, vol=True),
    },
    {
        "id": "plain", "label": "Plain",
        "blurb": "Hem/span/step only — no vol, fate, or fit auto.",
        "params": _max() + [
            {**_ORDERS, "default": "4"},
            _HOOK,
            _geom(["hem", "span", "step"], "Each edge is % of price, or whole ticks. Ticks win."),
            _MULT,
            _DRY,
        ],
    },
    {
        "id": "lean", "label": "Lean",
        "blurb": "Join the touch when flat; cover-only with inventory. No hem/span.",
        "params": _touch_like(k_default="0.05"),
    },
    {
        "id": "belt", "label": "Belt",
        "blurb": "Two edges off the hook, tails behind both. No step ladder.",
        "params": _max() + [
            {"key": "TAILS", "label": "Tails / side", "type": "int", "default": "2", "group": "size"},
            _HOOK,
            _geom(["hem", "span", "tail"], "Hem and span are the two edges. Tail is the stack behind them."),
            _MULT,
            *_fate(),
            {"key": "VOL_GATE", "label": "Vol gate", "type": "bool", "default": True, "group": "risk"},
            _DRY,
        ],
    },
    {
        "id": "touch", "label": "Touch",
        "blurb": "Join best bid/ask. No hem/span.",
        "params": _touch_like(),
    },
    {
        "id": "momentum", "label": "Momentum",
        "blurb": "Ride a one-way tape, trail out. No maker ladder.",
        "params": _max() + [
            {"key": "MOM_PCT", "label": "Burst %", "type": "number", "default": "0.18", "group": "quote"},
            {"key": "MOM_SLOW_PCT", "label": "Slow %", "type": "number", "default": "0.40", "group": "quote"},
            {"key": "CLIP_PCT", "label": "Clip %", "type": "number", "default": "25", "group": "size"},
            {"key": "TRAIL_PCT", "label": "Trail %", "type": "number", "default": "0.35", "group": "quote"},
            {"key": "MOM_STOP_PCT", "label": "Stop %", "type": "number", "default": "0.50", "group": "risk"},
            *_fate(),
            {"key": "VOL_GATE", "label": "Vol gate", "type": "bool", "default": True, "group": "risk"},
            _DRY,
        ],
    },
    {
        "id": "surge", "label": "Surge",
        "blurb": "Burst clip with 1:2 stop/take. No maker ladder.",
        "params": _max() + [
            {"key": "MOVE_PCT", "label": "Move %", "type": "number", "default": "0.5", "group": "quote"},
            {"key": "MOVE_SECS", "label": "Move secs", "type": "number", "default": "30", "group": "quote"},
            {"key": "RISK_REWARD", "label": "Risk:reward", "type": "number", "default": "2", "group": "risk"},
            {"key": "FLIP", "label": "Flip side", "type": "bool", "default": False, "group": "quote"},
            _DRY,
        ],
    },
    {
        "id": "edge", "label": "Edge",
        "blurb": "Quote vs a second venue’s book. No hem/span.",
        "params": _max() + [
            _ORDERS,
            {
                "key": "EDGE_VENUE", "label": "Ref venue", "type": "select", "default": "binance", "group": "quote",
                "options": ["delta", "binance", "bybit", "kucoin", "coinbase", "aster"],
            },
            {"key": "EDGE_PCT", "label": "Edge %", "type": "number", "default": "0.1", "group": "geometry"},
            {"key": "STEP_AUTO", "label": "Fit step", "type": "bool", "default": True, "group": "geometry"},
            {"key": "STEP_PCT", "label": "Step %", "type": "number", "default": "0.1", "group": "geometry"},
            _MULT,
            *_fate(),
            {"key": "VOL_GATE", "label": "Vol gate", "type": "bool", "default": True, "group": "risk"},
            _DRY,
        ],
    },
]

QUOTE_VENUES = ("delta", "binance", "bybit", "kucoin", "coinbase", "aster")

_prod_cache: dict[str, tuple[float, list[dict]]] = {}


def strategy_catalog() -> list[dict]:
    return STRATEGIES


def public_accounts(venue: str = "") -> list[dict]:
    want = str(venue or "").strip().lower()
    rows = []
    for i, acct in enumerate(load_wallet_accounts()):
        exch = acct.get("exchange") or ""
        if want and exch != want:
            continue
        aid = acct.get("id") or acct.get("name") or f"{exch}-{i + 1}"
        rows.append({
            "key": f"{exch}:{aid}",
            "exchange": exch,
            "label": _LABELS.get(exch, exch.title()),
            "id": acct.get("id") or "",
            "name": acct.get("name") or aid,
            "asset": acct.get("asset") or "",
            "parent": bool(acct.get("parent")),
        })
    return rows


def find_account(venue: str, account: str) -> dict | None:
    venue = str(venue or "").strip().lower()
    want = str(account or "").strip()
    if want.lower().startswith(venue + ":"):
        want = want.split(":", 1)[1]
    if not venue or not want:
        return None
    for acct in load_wallet_accounts():
        if acct.get("exchange") != venue:
            continue
        tags = {acct.get("id") or "", acct.get("name") or ""}
        if want in tags:
            return acct
    return None


def parent_delta_keys() -> tuple[str, str]:
    load_env_file()
    key = (
        os.getenv("PROFIT_SWEEP_API_KEY")
        or os.getenv("PROFIT_SWEEP_DELTA_API_KEY")
        or os.getenv("DELTA_PARENT_API_KEY")
        or ""
    ).strip()
    secret = (
        os.getenv("PROFIT_SWEEP_API_SECRET")
        or os.getenv("PROFIT_SWEEP_DELTA_API_SECRET")
        or os.getenv("DELTA_PARENT_API_SECRET")
        or ""
    ).strip()
    if key and secret:
        return key, secret
    for acct in load_wallet_accounts():
        if acct.get("exchange") == "delta" and acct.get("parent"):
            return acct.get("api_key") or "", acct.get("api_secret") or ""
    return "", ""


PARENT_HINT = (
    "Delta will not transfer with a subaccount trading key. "
    "Log into the main/parent Delta account, create an API key with wallet permission, "
    "then set PROFIT_SWEEP_API_KEY and PROFIT_SWEEP_API_SECRET in OPADash/.env "
    "(or add that account to config/accounts.json with parent: true, or BAL_n_PARENT=true)."
)


def parent_status() -> dict:
    key, secret = parent_delta_keys()
    ok = bool(key and secret)
    return {"has_parent": ok, "hint": "" if ok else PARENT_HINT}


async def list_products(venue: str) -> list[dict]:
    venue = str(venue or "delta").strip().lower()
    cached = _prod_cache.get(venue)
    if cached and time.time() - cached[0] < 300:
        return cached[1]
    rows: list[dict] = []
    try:
        if venue == "delta":
            rows = await _delta_products()
        elif venue == "binance":
            rows = await _binance_products()
        elif venue == "bybit":
            rows = await _bybit_products()
        elif venue == "kucoin":
            rows = await _kucoin_products()
        elif venue == "aster":
            rows = await _aster_products()
        elif venue == "coinbase":
            rows = await _coinbase_products()
    except Exception:
        rows = cached[1] if cached else []
        if not rows:
            raise
    _prod_cache[venue] = (time.time(), rows)
    return rows


async def _delta_products() -> list[dict]:
    base = os.getenv("DELTA_REST_URL", "https://api.india.delta.exchange").rstrip("/")
    out: list[dict] = []
    async with httpx.AsyncClient(timeout=20.0, verify=False) as client:
        page = 1
        while page <= 6:
            r = await client.get(
                base + "/v2/products",
                params={"page_size": 200, "page": page, "contract_types": "perpetual_futures"},
            )
            r.raise_for_status()
            data = r.json() if r.content else {}
            rows = data.get("result") if isinstance(data, dict) else None
            if not isinstance(rows, list) or not rows:
                break
            for rec in rows:
                if not isinstance(rec, dict):
                    continue
                state = str(rec.get("state") or rec.get("trading_status") or "").lower()
                if state and state not in ("live", "trading", "active"):
                    continue
                sym = str(rec.get("symbol") or "").strip()
                if not sym:
                    continue
                desc = rec.get("description")
                und = rec.get("underlying_asset")
                if isinstance(desc, str) and desc.strip():
                    name = desc.strip()
                elif isinstance(und, dict):
                    name = str(und.get("symbol") or sym)
                else:
                    name = sym
                out.append({
                    "symbol": sym,
                    "name": name,
                    "tick": rec.get("tick_size"),
                    "cv": rec.get("contract_value"),
                })
            if len(rows) < 200:
                break
            page += 1
    out.sort(key=lambda r: r["symbol"])
    return out


async def _binance_products() -> list[dict]:
    base = os.getenv("BINANCE_REST_URL", "https://fapi.binance.com").rstrip("/")
    async with httpx.AsyncClient(timeout=20.0, verify=False) as client:
        r = await client.get(base + "/fapi/v1/exchangeInfo")
        r.raise_for_status()
        data = r.json() if r.content else {}
    out = []
    for rec in data.get("symbols") or []:
        if not isinstance(rec, dict):
            continue
        if str(rec.get("status") or "").upper() != "TRADING":
            continue
        if str(rec.get("contractType") or "").upper() not in ("PERPETUAL", ""):
            continue
        sym = str(rec.get("symbol") or "")
        if not sym.endswith("USDT"):
            continue
        out.append({"symbol": sym, "name": sym})
    out.sort(key=lambda r: r["symbol"])
    return out


async def _bybit_products() -> list[dict]:
    base = os.getenv("BYBIT_REST_URL", "https://api.bybit.com").rstrip("/")
    async with httpx.AsyncClient(timeout=20.0, verify=False) as client:
        r = await client.get(base + "/v5/market/instruments-info", params={"category": "linear", "limit": 1000})
        r.raise_for_status()
        data = r.json() if r.content else {}
    rows = ((data.get("result") or {}) if isinstance(data, dict) else {}).get("list") or []
    out = []
    for rec in rows:
        if not isinstance(rec, dict):
            continue
        if str(rec.get("status") or "").lower() not in ("trading", ""):
            continue
        sym = str(rec.get("symbol") or "")
        if not sym.endswith("USDT"):
            continue
        out.append({"symbol": sym, "name": sym})
    out.sort(key=lambda r: r["symbol"])
    return out


async def _kucoin_products() -> list[dict]:
    base = os.getenv("KUCOIN_REST_URL", "https://api-futures.kucoin.com").rstrip("/")
    async with httpx.AsyncClient(timeout=20.0, verify=False) as client:
        r = await client.get(base + "/api/v1/contracts/active")
        r.raise_for_status()
        data = r.json() if r.content else {}
    out = []
    for rec in data.get("data") or []:
        if not isinstance(rec, dict):
            continue
        if str(rec.get("quoteCurrency") or "").upper() != "USDT":
            continue
        sym = str(rec.get("symbol") or "")
        if not sym:
            continue
        out.append({"symbol": sym, "name": str(rec.get("baseCurrency") or sym)})
    out.sort(key=lambda r: r["symbol"])
    return out


async def _aster_products() -> list[dict]:
    base = os.getenv("ASTER_REST_URL", "https://fapi.asterdex.com").rstrip("/")
    async with httpx.AsyncClient(timeout=20.0, verify=False) as client:
        r = await client.get(base + "/fapi/v1/exchangeInfo")
        r.raise_for_status()
        data = r.json() if r.content else {}
    out = []
    for rec in data.get("symbols") or []:
        if not isinstance(rec, dict):
            continue
        if str(rec.get("status") or "").upper() not in ("TRADING", ""):
            continue
        sym = str(rec.get("symbol") or "")
        if not sym:
            continue
        out.append({"symbol": sym, "name": sym})
    out.sort(key=lambda r: r["symbol"])
    return out


async def _coinbase_products() -> list[dict]:
    base = os.getenv("COINBASE_INTX_URL", "https://api.international.coinbase.com").rstrip("/")
    out = []
    async with httpx.AsyncClient(timeout=20.0, verify=False) as client:
        r = await client.get(base + "/api/v1/instruments")
        if r.status_code >= 400:
            return out
        data = r.json() if r.content else None
    rows = data if isinstance(data, list) else (data or {}).get("instruments") or (data or {}).get("result") or []
    for rec in rows:
        if not isinstance(rec, dict):
            continue
        sym = str(rec.get("symbol") or rec.get("instrument_id") or rec.get("name") or "")
        if not sym:
            continue
        out.append({"symbol": sym, "name": str(rec.get("display_name") or sym)})
    out.sort(key=lambda r: r["symbol"])
    return out


async def delta_wallet_rows() -> list[dict]:
    """Configured Delta subs with live available USD (no secrets)."""
    accts = [a for a in load_wallet_accounts() if a.get("exchange") == "delta"]
    if not accts:
        return []
    rate = float(os.getenv("USDINR_RATE", "87") or 87)
    timeout = httpx.Timeout(12.0, connect=6.0)
    from webapp.wallets import _delta_wallet
    async with httpx.AsyncClient(timeout=timeout, verify=False) as client:
        rows = []
        for acct in accts:
            item = {
                "id": acct.get("id") or "",
                "name": acct.get("name") or acct.get("id") or "",
                "parent": bool(acct.get("parent")),
                "available": None,
                "balance": None,
                "asset": acct.get("asset") or "USD",
                "error": "",
            }
            try:
                snap = await _delta_wallet(client, acct, rate)
                item["id"] = str(snap.get("uid") or item["id"])
                item["available"] = _num(snap.get("available"))
                item["balance"] = _num(snap.get("native"))
                item["asset"] = str(snap.get("asset") or item["asset"])
            except Exception as exc:
                item["error"] = str(exc)[:160]
            rows.append(item)
        return rows


async def transfer_delta(src: str, dest: str, amount: float, asset: str = "USD") -> dict:
    src = str(src or "").strip()
    dest = str(dest or "").strip()
    asset = str(asset or "USD").strip().upper() or "USD"
    try:
        amt = float(amount)
    except (TypeError, ValueError):
        raise ValueError("amount required")
    if not src or not dest:
        raise ValueError("from and to required")
    if src == dest:
        raise ValueError("from and to must differ")
    if not (amt == amt) or amt <= 0 or amt > 5_000_000:
        raise ValueError("amount must be > 0 and ≤ 5,000,000")
    key, secret = parent_delta_keys()
    if not key or not secret:
        raise PermissionError(PARENT_HINT)
    known = {str(a.get("id") or "") for a in load_wallet_accounts() if a.get("exchange") == "delta"}
    known.discard("")
    if known and (src not in known or dest not in known):
        raise ValueError("both accounts must be configured Delta subs")
    try:
        src_i, dest_i = int(src), int(dest)
    except ValueError as exc:
        raise ValueError("Delta user ids must be numeric") from exc

    body = {
        "transferrer_user_id": src_i,
        "transferee_user_id": dest_i,
        "asset_symbol": asset,
        "amount": float(f"{amt:.8f}".rstrip("0").rstrip(".") or amt),
    }
    payload = json.dumps(body, separators=(",", ":"))
    path = "/v2/wallets/sub_account_balance_transfer"
    base = os.getenv("DELTA_REST_URL", "https://api.india.delta.exchange").rstrip("/")
    async with httpx.AsyncClient(timeout=20.0, verify=False) as client:
        headers = _delta_headers("POST", path, payload, key, secret)
        r = await client.post(base + path, headers=headers, content=payload)
        data: Any = r.json() if r.content else {}
    if r.status_code == 401:
        async with httpx.AsyncClient(timeout=20.0, verify=False) as client:
            headers = _delta_headers("POST", path, payload, key, secret)
            r = await client.post(base + path, headers=headers, content=payload)
            data = r.json() if r.content else {}
    ok = bool(isinstance(data, dict) and data.get("success") is True)
    err = ""
    if not ok:
        fail = (data.get("error") if isinstance(data, dict) else None) or {}
        if isinstance(fail, dict):
            err = str(fail.get("code") or fail.get("message") or fail)
        else:
            err = str(fail or (data.get("message") if isinstance(data, dict) else "") or r.text[:180] or "transfer failed")
        if "transfer_not_allowed_from_sub_account" in err.lower():
            err += " — parent key is still a sub-account login; use the main Delta account API key"
        raise RuntimeError(err)
    return {"ok": True, "from": src, "to": dest, "amount": amt, "asset": asset}
