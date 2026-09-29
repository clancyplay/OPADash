"""Public-market opportunity scan for the Opps page.

No keys. One bulk read per venue, then funding arb, cross-venue spread,
perp-vs-index basis, wide book (maker), and single-venue funding carry.
Expected profit is a fraction of notional (`edge`), so the page can rescale it.
"""
from __future__ import annotations

import asyncio
import os
import time
from datetime import datetime, timezone

import httpx

from utils.events_db import canon_contract

LABELS = {
    "delta": "Delta",
    "binance": "Binance",
    "bybit": "Bybit",
    "kucoin": "KuCoin",
    "aster": "Aster",
    "coinbase": "Coinbase",
}

# Spread arb crosses the spread once on each venue (taker).
# Book quotes pay the maker fee twice (buy the bid, sell the ask).
FEE_TAKER_RT = 0.0010
FEE_MAKER_RT = 0.0004

MIN_FUND = 0.00015       # 1.5 bp / 8h
MIN_CARRY = 0.00030      # 3 bp / 8h
MIN_SPREAD_NET = 0.0015  # 15 bp after taker round trip
MIN_BASIS = 0.0020       # 20 bp vs index
MIN_BOOK_NET = 0.0008    # 8 bp after maker round trip
MAX_DISLOC = 0.12        # wider than this is a different contract, not an arb
MAX_BOOK = 0.05
MIN_TURN_CROSS = 100_000.0
MIN_TURN_SINGLE = 50_000.0

_CAPS = {"funding": 40, "spread": 40, "basis": 30, "book": 35, "carry": 35}
_KINDS = ("funding", "spread", "basis", "book", "carry")

NOTES = (
    "Expected $ is edge × the notional on this page. "
    "Funding and carry are per 8 hours (APR = that edge × 3 × 365). "
    "Spread is buy-the-ask / sell-the-bid, after a 0.10% taker haircut. "
    "Book is one bid-to-ask capture after a 0.04% maker haircut. "
    "A book wider than 2% is ignored for arb and carry. "
    "Basis is the gap to the index if it closes. "
    "Delta publishes funding in percent; it is converted before compare. "
    "Pairs whose marks differ by more than 12% are dropped."
)

_STABLES = frozenset({
    "USDT", "USDC", "USD", "DAI", "FDUSD", "TUSD", "USDE", "USD1", "BUSD",
})

_cache: dict = {"t": 0.0, "data": None}
_inflight: asyncio.Task | None = None
_TTL = 20.0


def _num(val):
    try:
        if val is None or val == "":
            return None
        return float(val)
    except (TypeError, ValueError):
        return None


def _hours(raw, default: float = 8.0) -> float:
    """Funding interval → hours. Accepts hours, seconds, ms, or ns."""
    v = _num(raw)
    if v is None or v <= 0:
        return default
    if v > 1e11:
        secs = v / 1e9
    elif v > 1000:
        secs = v / 1e3
    elif v > 48:
        secs = v
    else:
        return v
    h = secs / 3600.0
    return h if h >= 0.25 else default


def _rate_8h(rate, interval_h: float) -> float | None:
    r = _num(rate)
    if r is None:
        return None
    h = interval_h if interval_h and interval_h > 0 else 8.0
    return r * (8.0 / h)


def base_of(symbol: str) -> str:
    s = str(symbol or "").upper().replace("-", "").replace("_", "")
    if s.endswith("PERPINTX") and len(s) > 8:
        s = s[:-8]
    elif s.endswith("PERP") and len(s) > 4:
        s = s[:-4]
    base = ""
    for quote in ("USDTM", "USDT", "USDC", "USD"):
        if s.endswith(quote) and len(s) > len(quote):
            base = s[: -len(quote)]
            break
    if not base:
        base = s
    if base == "XBT":
        base = "BTC"
    if base in _STABLES or len(base) < 2 or len(base) > 15:
        return ""
    if base[-1].isdigit() and not (base.startswith("1000") or base.startswith("1000000")):
        tail = base.rstrip("0123456789")
        if tail != base and len(base) - len(tail) >= 4:
            return ""
    return base


def _px(val) -> float | None:
    v = _num(val)
    if v is None or v <= 0:
        return None
    if v >= 1000:
        return round(v, 2)
    if v >= 1:
        return round(v, 4)
    return round(v, 8)


def _width(row: dict) -> float | None:
    bid, ask = row.get("bid"), row.get("ask")
    mark = row.get("mark") or 0
    if not bid or not ask or ask < bid or mark <= 0:
        return None
    return (ask - bid) / mark


def _tight(row: dict, limit: float = 0.02) -> bool:
    """A quote you can actually trade. A 50% book is an empty market, not an edge."""
    width = _width(row)
    return width is not None and width <= limit


def _liquid(row: dict, floor: float) -> bool:
    turn = row.get("turnover")
    if turn is None:
        return True
    return float(turn) >= floor


def _same_px(a: float, b: float) -> bool:
    if a <= 0 or b <= 0:
        return False
    hi, lo = (a, b) if a >= b else (b, a)
    return (hi - lo) / lo <= MAX_DISLOC


def _canon_sym(symbol: str) -> str:
    raw = str(symbol or "").upper().replace("-", "").replace("_", "")
    if raw.startswith("XBT"):
        raw = "BTC" + raw[3:]
    return canon_contract(raw)


def _leg(row: dict, side: str = "") -> dict:
    mark = row.get("mark") or 0.0
    index = row.get("index")
    bid, ask = row.get("bid"), row.get("ask")
    spread = None
    if bid and ask and bid > 0 and ask >= bid and mark > 0:
        spread = (ask - bid) / mark
    basis = None
    if index and index > 0 and mark > 0:
        basis = (mark - index) / index
    return {
        "venue": row["venue"],
        "venue_label": LABELS.get(row["venue"], row["venue"].title()),
        "symbol": row["symbol"],
        "side": side,
        "mark": _px(mark),
        "fund_8h": None if row.get("fund_8h") is None else round(float(row["fund_8h"]), 8),
        "spread": None if spread is None else round(spread, 6),
        "basis": None if basis is None else round(basis, 6),
    }


def _suggest(strategy: str, row: dict, other: dict | None = None) -> dict:
    edge_venue = ""
    if other and strategy == "edge":
        edge_venue = other["venue"]
    label = f"{strategy} · {LABELS.get(row['venue'], row['venue'])} {row['symbol']}"
    if edge_venue:
        label += f" vs {LABELS.get(edge_venue, edge_venue)}"
    return {
        "strategy": strategy,
        "venue": row["venue"],
        "contract": row["symbol"],
        "edge_venue": edge_venue,
        "label": label,
    }


def _best_by_venue(rows: list[dict]) -> list[dict]:
    best: dict[str, dict] = {}
    for row in rows:
        cur = best.get(row["venue"])
        if cur is None:
            best[row["venue"]] = row
            continue
        cur_t = cur.get("turnover") or 0
        new_t = row.get("turnover") or 0
        if new_t > cur_t:
            best[row["venue"]] = row
    return list(best.values())


def build(rows: list[dict], running: list[dict] | None = None) -> list[dict]:
    """Score normalized quotes. `running` is live bots: contract, account, strategy, venue."""
    grouped: dict[str, list[dict]] = {}
    for row in rows:
        base = row.get("base") or ""
        mark = row.get("mark") or 0
        if not base or mark <= 0:
            continue
        grouped.setdefault(base, []).append(row)

    found: dict[str, list[dict]] = {k: [] for k in _KINDS}
    for base, raw in grouped.items():
        quotes = _best_by_venue(raw)
        _score_base(base, quotes, found)

    out: list[dict] = []
    for kind in _KINDS:
        rows_k = found[kind]
        rows_k.sort(key=lambda r: r["edge"], reverse=True)
        out.extend(rows_k[: _CAPS[kind]])
    _attach_running(out, running or [])
    return out


def _score_base(base: str, quotes: list[dict], found: dict[str, list[dict]]) -> None:
    funded = [
        q for q in quotes
        if q.get("fund_8h") is not None and _liquid(q, MIN_TURN_CROSS) and _tight(q)
    ]
    if len(funded) >= 2:
        best = None
        for i, a in enumerate(funded):
            for b in funded[i + 1 :]:
                if not _same_px(a["mark"], b["mark"]):
                    continue
                gap = abs(a["fund_8h"] - b["fund_8h"])
                if best is None or gap > best[0]:
                    best = (gap, a, b)
        if best and best[0] >= MIN_FUND:
            gap, a, b = best
            long_q, short_q = (a, b) if a["fund_8h"] <= b["fund_8h"] else (b, a)
            venues = "-".join(sorted((a["venue"], b["venue"])))
            found["funding"].append({
                "id": f"funding:{base}:{venues}",
                "kind": "funding",
                "base": base,
                "summary": (
                    f"Long {LABELS.get(long_q['venue'], long_q['venue'])}"
                    f" · short {LABELS.get(short_q['venue'], short_q['venue'])}"
                ),
                "period": "8h",
                "edge": round(gap, 8),
                "gross": round(gap, 8),
                "apr": round(gap * 3 * 365, 4),
                "legs": [_leg(long_q, "long"), _leg(short_q, "short")],
                "suggest": _suggest("edge", long_q, short_q),
                "running": [],
            })

    priced = [q for q in quotes if _liquid(q, MIN_TURN_CROSS) and _tight(q)]
    if len(priced) >= 2:
        best = None
        for i, a in enumerate(priced):
            for b in priced[i + 1 :]:
                if not _same_px(a["mark"], b["mark"]):
                    continue
                # Buy the ask on the cheap venue, sell the bid on the rich one.
                if a["ask"] <= b["bid"]:
                    cheap, rich = a, b
                    gross = (b["bid"] - a["ask"]) / a["ask"]
                elif b["ask"] <= a["bid"]:
                    cheap, rich = b, a
                    gross = (a["bid"] - b["ask"]) / b["ask"]
                else:
                    continue
                net = gross - FEE_TAKER_RT
                if best is None or net > best[0]:
                    best = (net, gross, cheap, rich)
        if best and best[0] >= MIN_SPREAD_NET:
            net, gross, cheap, rich = best
            venues = "-".join(sorted((cheap["venue"], rich["venue"])))
            found["spread"].append({
                "id": f"spread:{base}:{venues}",
                "kind": "spread",
                "base": base,
                "summary": (
                    f"Buy {LABELS.get(cheap['venue'], cheap['venue'])}"
                    f" · sell {LABELS.get(rich['venue'], rich['venue'])}"
                ),
                "period": "trade",
                "edge": round(net, 8),
                "gross": round(gross, 8),
                "apr": None,
                "legs": [_leg(cheap, "buy"), _leg(rich, "sell")],
                "suggest": _suggest("edge", cheap, rich),
                "running": [],
            })

    for q in quotes:
        if not _liquid(q, MIN_TURN_SINGLE):
            continue
        # Missing turnover (no 24h print) only counts when the book itself is real.
        if q.get("turnover") is None and not _tight(q, 0.01):
            continue
        width = _width(q)
        if width is not None and q.get("turnover") and width <= MAX_BOOK:
            net = width - FEE_MAKER_RT
            if net >= MIN_BOOK_NET:
                found["book"].append({
                    "id": f"book:{base}:{q['venue']}",
                    "kind": "book",
                    "base": base,
                    "summary": f"Wide book on {LABELS.get(q['venue'], q['venue'])}",
                    "period": "trade",
                    "edge": round(net, 8),
                    "gross": round(width, 8),
                    "apr": None,
                    "legs": [_leg(q, "")],
                    "suggest": _suggest("stack", q),
                    "running": [],
                })
        if width is not None and width > 0.03:
            continue
        index = q.get("index")
        mark = q["mark"]
        if index and index > 0:
            basis = (mark - index) / index
            if abs(basis) >= MIN_BASIS and abs(basis) <= MAX_DISLOC:
                side = "short" if basis > 0 else "long"
                word = "Rich vs index" if basis > 0 else "Cheap vs index"
                found["basis"].append({
                    "id": f"basis:{base}:{q['venue']}",
                    "kind": "basis",
                    "base": base,
                    "summary": f"{word} · {side} {LABELS.get(q['venue'], q['venue'])}",
                    "period": "basis",
                    "edge": round(abs(basis), 8),
                    "gross": round(abs(basis), 8),
                    "apr": None,
                    "legs": [_leg(q, side)],
                    "suggest": _suggest("stack", q),
                    "running": [],
                })
        fund = q.get("fund_8h")
        if fund is not None and abs(fund) >= MIN_CARRY and _tight(q):
            side = "short" if fund > 0 else "long"
            found["carry"].append({
                "id": f"carry:{base}:{q['venue']}",
                "kind": "carry",
                "base": base,
                "summary": (
                    f"{side.capitalize()} {LABELS.get(q['venue'], q['venue'])}"
                    f" · funding {'pays shorts' if fund > 0 else 'pays longs'}"
                ),
                "period": "8h",
                "edge": round(abs(fund), 8),
                "gross": round(abs(fund), 8),
                "apr": round(abs(fund) * 3 * 365, 4),
                "legs": [_leg(q, side)],
                "suggest": _suggest("stack", q),
                "running": [],
            })


def _bot_matches(bot: dict, leg: dict) -> bool:
    bv = str(bot.get("venue") or "").strip().lower()
    if bv and bv != leg["venue"]:
        return False
    bs = str(bot.get("contract") or "")
    ls = str(leg.get("symbol") or "")
    if not bs or not ls:
        return False
    if bs.upper() == ls.upper():
        return True
    return bool(_canon_sym(bs) and _canon_sym(bs) == _canon_sym(ls))


def _attach_running(opps: list[dict], running: list[dict]) -> None:
    for opp in opps:
        hits = []
        seen = set()
        base = str(opp.get("base") or "")
        for bot in running:
            bot_base = base_of(str(bot.get("contract") or ""))
            same_base = bool(base) and bot_base == base
            same_leg = any(_bot_matches(bot, leg) for leg in opp["legs"])
            if not same_base and not same_leg:
                continue
            key = (
                str(bot.get("contract") or "").upper(),
                str(bot.get("account") or ""),
                str(bot.get("strategy") or "").lower(),
                str(bot.get("venue") or "").lower(),
            )
            if key in seen:
                continue
            seen.add(key)
            hits.append({
                "contract": bot.get("contract") or "",
                "account": bot.get("account") or "",
                "account_name": bot.get("account_name") or "",
                "strategy": bot.get("strategy") or "",
                "venue": str(bot.get("venue") or "").lower(),
            })
        opp["running"] = hits


async def load(force: bool = False) -> dict:
    global _inflight
    now = time.time()
    cached = _cache.get("data")
    if not force and cached and now - float(_cache.get("t") or 0) < _TTL:
        return cached
    if _inflight is not None and not _inflight.done() and not force:
        return await _inflight
    _inflight = asyncio.create_task(_fetch_all())
    try:
        data = await _inflight
    finally:
        _inflight = None
    _cache["t"] = time.time()
    _cache["data"] = data
    return data


async def _fetch_all() -> dict:
    timeout = httpx.Timeout(18.0, connect=6.0)
    async with httpx.AsyncClient(timeout=timeout, verify=False, headers={"User-Agent": "opadash"}) as client:
        parts = await asyncio.gather(
            _safe("delta", _delta(client)),
            _safe("binance", _binance(client)),
            _safe("bybit", _bybit(client)),
            _safe("kucoin", _kucoin(client)),
            _safe("aster", _aster(client)),
            _safe("coinbase", _coinbase(client)),
        )
    rows: list[dict] = []
    venues = []
    for name, got, err in parts:
        venues.append({
            "id": name,
            "label": LABELS.get(name, name.title()),
            "ok": err == "",
            "n": len(got),
            "error": err,
        })
        rows.extend(got)
    return {
        "as_of": datetime.now(timezone.utc).isoformat(),
        "venues": venues,
        "rows": rows,
    }


async def _safe(name: str, coro):
    try:
        rows = await coro
        return name, rows or [], ""
    except Exception as extra:
        return name, [], str(extra)[:180]


def _quote(**kwargs) -> dict | None:
    symbol = str(kwargs.get("symbol") or "").strip()
    venue = str(kwargs.get("venue") or "")
    base = kwargs.get("base") or base_of(symbol)
    mark = _num(kwargs.get("mark"))
    if not symbol or not venue or not base or not mark or mark <= 0:
        return None
    bid = _num(kwargs.get("bid"))
    ask = _num(kwargs.get("ask"))
    if bid is not None and bid <= 0:
        bid = None
    if ask is not None and ask <= 0:
        ask = None
    turn = _num(kwargs.get("turnover"))
    if turn is not None and turn < 0:
        turn = None
    return {
        "venue": venue,
        "symbol": symbol,
        "base": base,
        "mark": mark,
        "index": _num(kwargs.get("index")),
        "bid": bid,
        "ask": ask,
        "fund_8h": kwargs.get("fund_8h"),
        "turnover": turn,
    }


async def _delta(client: httpx.AsyncClient) -> list[dict]:
    """Delta `funding_rate` is percent per 8h (ETH 0.01 == Binance 0.0001)."""
    base = os.getenv("DELTA_REST_URL", "https://api.india.delta.exchange").rstrip("/")
    r = await client.get(base + "/v2/tickers", params={"contract_types": "perpetual_futures"})
    r.raise_for_status()
    data = r.json() if r.content else {}
    out = []
    for rec in data.get("result") or []:
        if not isinstance(rec, dict):
            continue
        if str(rec.get("contract_type") or "") not in ("perpetual_futures", ""):
            continue
        sym = str(rec.get("symbol") or "")
        quotes = rec.get("quotes") if isinstance(rec.get("quotes"), dict) else {}
        fund = _num(rec.get("funding_rate"))
        row = _quote(
            venue="delta",
            symbol=sym,
            mark=rec.get("mark_price"),
            index=rec.get("spot_price"),
            bid=quotes.get("best_bid"),
            ask=quotes.get("best_ask"),
            fund_8h=None if fund is None else fund / 100.0,
            turnover=rec.get("turnover_usd"),
        )
        if row:
            out.append(row)
    return out


async def _binance(client: httpx.AsyncClient) -> list[dict]:
    base = os.getenv("BINANCE_REST_URL", "https://fapi.binance.com").rstrip("/")
    prem, books, info, day = await asyncio.gather(
        client.get(base + "/fapi/v1/premiumIndex"),
        client.get(base + "/fapi/v1/ticker/bookTicker"),
        client.get(base + "/fapi/v1/fundingInfo"),
        client.get(base + "/fapi/v1/ticker/24hr"),
    )
    prem.raise_for_status()
    books.raise_for_status()
    hours = {}
    if info.status_code < 400:
        for rec in info.json() or []:
            if isinstance(rec, dict) and rec.get("symbol"):
                hours[str(rec["symbol"])] = _hours(rec.get("fundingIntervalHours"), 8.0)
    book = {}
    for rec in books.json() or []:
        if isinstance(rec, dict) and rec.get("symbol"):
            book[str(rec["symbol"])] = rec
    turn = {}
    if day.status_code < 400:
        for rec in day.json() or []:
            if isinstance(rec, dict) and rec.get("symbol"):
                turn[str(rec["symbol"])] = _num(rec.get("quoteVolume"))
    out = []
    for rec in prem.json() or []:
        if not isinstance(rec, dict):
            continue
        sym = str(rec.get("symbol") or "")
        if "_" in sym or not (sym.endswith("USDT") or sym.endswith("USDC")):
            continue
        bk = book.get(sym) or {}
        h = hours.get(sym, 8.0)
        row = _quote(
            venue="binance",
            symbol=sym,
            mark=rec.get("markPrice"),
            index=rec.get("indexPrice"),
            bid=bk.get("bidPrice"),
            ask=bk.get("askPrice"),
            fund_8h=_rate_8h(rec.get("lastFundingRate"), h),
            turnover=turn.get(sym),
        )
        if row:
            out.append(row)
    return out


async def _bybit(client: httpx.AsyncClient) -> list[dict]:
    base = os.getenv("BYBIT_REST_URL", "https://api.bybit.com").rstrip("/")
    r = await client.get(base + "/v5/market/tickers", params={"category": "linear"})
    r.raise_for_status()
    data = r.json() if r.content else {}
    rows = ((data.get("result") or {}) if isinstance(data, dict) else {}).get("list") or []
    out = []
    for rec in rows:
        if not isinstance(rec, dict):
            continue
        sym = str(rec.get("symbol") or "")
        if "-" in sym or not (sym.endswith("USDT") or sym.endswith("USDC")):
            continue
        h = _hours(rec.get("fundingIntervalHour"), 8.0)
        row = _quote(
            venue="bybit",
            symbol=sym,
            mark=rec.get("markPrice"),
            index=rec.get("indexPrice"),
            bid=rec.get("bid1Price"),
            ask=rec.get("ask1Price"),
            fund_8h=_rate_8h(rec.get("fundingRate"), h),
            turnover=rec.get("turnover24h"),
        )
        if row:
            out.append(row)
    return out


async def _kucoin(client: httpx.AsyncClient) -> list[dict]:
    base = os.getenv("KUCOIN_REST_URL", "https://api-futures.kucoin.com").rstrip("/")
    contracts, ticks = await asyncio.gather(
        client.get(base + "/api/v1/contracts/active"),
        client.get(base + "/api/v1/allTickers"),
    )
    contracts.raise_for_status()
    book = {}
    if ticks.status_code < 400:
        payload = ticks.json() if ticks.content else {}
        for rec in (payload.get("data") or []) if isinstance(payload, dict) else []:
            if isinstance(rec, dict) and rec.get("symbol"):
                book[str(rec["symbol"])] = rec
    data = contracts.json() if contracts.content else {}
    out = []
    for rec in (data.get("data") or []) if isinstance(data, dict) else []:
        if not isinstance(rec, dict):
            continue
        if str(rec.get("quoteCurrency") or "").upper() not in ("USDT", "USD", ""):
            continue
        status = str(rec.get("status") or "").lower()
        if status and status not in ("open", "trading", "active"):
            continue
        if rec.get("expireDate"):
            continue
        sym = str(rec.get("symbol") or "")
        bk = book.get(sym) or {}
        h = _hours(rec.get("currentFundingRateGranularity") or rec.get("fundingRateGranularity"), 8.0)
        mark = _num(rec.get("markPrice"))
        vol = _num(rec.get("turnoverOf24h"))
        if vol is None and mark:
            lots = _num(rec.get("volumeOf24h"))
            if lots:
                vol = lots * mark
        base_name = str(rec.get("baseCurrency") or "")
        if base_name.upper() == "XBT":
            base_name = "BTC"
        row = _quote(
            venue="kucoin",
            symbol=sym,
            base=base_name or None,
            mark=mark,
            index=rec.get("indexPrice"),
            bid=bk.get("bestBidPrice"),
            ask=bk.get("bestAskPrice"),
            fund_8h=_rate_8h(rec.get("fundingFeeRate"), h),
            turnover=vol,
        )
        if row:
            out.append(row)
    return out


async def _aster(client: httpx.AsyncClient) -> list[dict]:
    base = os.getenv("ASTER_REST_URL", "https://fapi.asterdex.com").rstrip("/")
    prem, books, info, day = await asyncio.gather(
        client.get(base + "/fapi/v1/premiumIndex"),
        client.get(base + "/fapi/v1/ticker/bookTicker"),
        client.get(base + "/fapi/v1/fundingInfo"),
        client.get(base + "/fapi/v1/ticker/24hr"),
    )
    prem.raise_for_status()
    hours = {}
    if info.status_code < 400:
        blob = info.json() if info.content else []
        for rec in blob or []:
            if isinstance(rec, dict) and rec.get("symbol"):
                hours[str(rec["symbol"])] = _hours(rec.get("fundingIntervalHours"), 8.0)
    book = {}
    if books.status_code < 400:
        for rec in books.json() or []:
            if isinstance(rec, dict) and rec.get("symbol"):
                book[str(rec["symbol"])] = rec
    turn = {}
    if day.status_code < 400:
        blob = day.json() if day.content else []
        if isinstance(blob, dict):
            blob = [blob]
        for rec in blob or []:
            if isinstance(rec, dict) and rec.get("symbol"):
                turn[str(rec["symbol"])] = _num(rec.get("quoteVolume"))
    raw = prem.json() if prem.content else []
    if isinstance(raw, dict):
        raw = [raw]
    out = []
    for rec in raw or []:
        if not isinstance(rec, dict):
            continue
        sym = str(rec.get("symbol") or "")
        if "_" in sym or not (sym.endswith("USDT") or sym.endswith("USDC") or sym.endswith("USD")):
            continue
        bk = book.get(sym) or {}
        row = _quote(
            venue="aster",
            symbol=sym,
            mark=rec.get("markPrice"),
            index=rec.get("indexPrice"),
            bid=bk.get("bidPrice"),
            ask=bk.get("askPrice"),
            fund_8h=_rate_8h(rec.get("lastFundingRate"), hours.get(sym, 8.0)),
            turnover=turn.get(sym),
        )
        if row:
            out.append(row)
    return out


async def _coinbase(client: httpx.AsyncClient) -> list[dict]:
    base = os.getenv("COINBASE_INTX_URL", "https://api.international.coinbase.com").rstrip("/")
    r = await client.get(base + "/api/v1/instruments")
    if r.status_code >= 400:
        return []
    data = r.json() if r.content else None
    rows = data if isinstance(data, list) else (data or {}).get("instruments") or []
    out = []
    for rec in rows:
        if not isinstance(rec, dict):
            continue
        if str(rec.get("type") or "").upper() != "PERP":
            continue
        state = str(rec.get("trading_state") or rec.get("mode") or "").upper()
        if state and state not in ("TRADING", "OPEN", "STANDARD", ""):
            continue
        quote = rec.get("quote") if isinstance(rec.get("quote"), dict) else {}
        base_name = str(rec.get("base_asset_name") or "")
        if base_name.upper() == "XBT":
            base_name = "BTC"
        h = _hours(rec.get("funding_interval"), 1.0)
        row = _quote(
            venue="coinbase",
            symbol=str(rec.get("symbol") or ""),
            base=base_name or None,
            mark=quote.get("mark_price"),
            index=quote.get("index_price"),
            bid=quote.get("best_bid_price"),
            ask=quote.get("best_ask_price"),
            fund_8h=_rate_8h(quote.get("predicted_funding"), h),
            turnover=rec.get("notional_24hr") or rec.get("avg_daily_notional"),
        )
        if row:
            out.append(row)
    return out
