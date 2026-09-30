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
MIN_SPREAD_NET = 0.0012  # 12 bp after taker round trip
MIN_BASIS = 0.0020       # 20 bp vs index
MIN_BOOK_NET = 0.0004    # 4 bp after maker round trip
MAX_DISLOC = 0.12        # wider than this is a different contract, not an arb
MAX_BOOK = 0.015         # a wider Delta book is usually empty, not a quote
MIN_TURN_DELTA = 20_000.0
MIN_TURN_OTHER = 250_000.0
MIN_TURN_TAPE = 80_000.0
MIN_TURN_MOVE = 40_000.0
MIN_MOVE = 0.04          # 4% on the day
MIN_PRINTS = 3           # trades in the last minute

MIN_FAR_BOOK = 0.0012      # 12 bp book before a back quote has room
MAX_FAR_BOOK = 0.03        # past this the book is usually empty
MIN_FAR_COVER = 0.35       # prints must cover this much of the book

_CAPS = {
    "spread": 28, "far": 24, "tape": 24, "move": 24, "book": 24,
    "funding": 18, "basis": 14, "carry": 14,
}
_KINDS = ("spread", "far", "tape", "move", "book", "funding", "basis", "carry")

NOTES = (
    "Sized for a $500 start. Delta contracts are listed first. "
    "Spread is buy-the-ask / sell-the-bid after a 0.10% taker haircut, and a Delta leg wins over a wider pair elsewhere. "
    "Far fill is one Delta contract: the book is wide and prints crossed it, or last-minute prints already traded past the touch, so a quote behind it can still get hit. "
    "The $ figure is that distance after one maker fee, not a locked fill. "
    "Tape is Delta names that are both liquid and printing in the last minute. "
    "Move is the 24h price change on this notional. "
    "Book is one Delta bid-to-ask capture after a 0.04% maker haircut. "
    "Funding and carry are per 8 hours. "
    "Delta funding is published in percent and converted before compare."
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


def _pct(raw) -> float | None:
    """A percent-style change (1.2 means 1.2%) → fraction."""
    v = _num(raw)
    if v is None:
        return None
    return v / 100.0


def _usd_short(n: float) -> str:
    v = abs(float(n or 0))
    if v >= 1e9:
        return f"${v / 1e9:.1f}B"
    if v >= 1e6:
        return f"${v / 1e6:.1f}M"
    if v >= 1e3:
        return f"${v / 1e3:.0f}k"
    return f"${v:.0f}"


def _on_delta(rows) -> bool:
    return any(str(r.get("venue") or "") == "delta" for r in rows)


def _prefer(rows: list[dict]) -> None:
    """Delta legs first, then the kind's own score."""
    def key(row: dict):
        delta = _on_delta(row.get("legs") or [])
        score = row.get("score")
        if score is None:
            score = row.get("edge") or 0
        return (0 if delta else 1, -float(score))
    rows.sort(key=key)


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
        "change": None if row.get("change") is None else round(float(row["change"]), 6),
        "turnover": None if row.get("turnover") is None else round(float(row["turnover"]), 0),
        "trades": None if row.get("trades") is None else int(row["trades"]),
        "walk": None if row.get("print_low") is None or row.get("print_high") is None or mark <= 0
        else round((float(row["print_high"]) - float(row["print_low"])) / mark, 6),
    }


_ARB_VENUES = frozenset({"delta", "aster", "binance", "kucoin", "bybit", "coinbase"})


def _suggest(strategy: str, row: dict, other: dict | None = None) -> dict:
    edge_venue = ""
    arb_symbol = ""
    if other and strategy in ("edge", "arb"):
        edge_venue = other["venue"]
    if other and strategy == "arb":
        arb_symbol = other.get("symbol") or ""
    label = f"{strategy} · {LABELS.get(row['venue'], row['venue'])} {row['symbol']}"
    if edge_venue:
        label += f" vs {LABELS.get(edge_venue, edge_venue)}"
    return {
        "strategy": strategy,
        "venue": row["venue"],
        "contract": row["symbol"],
        "edge_venue": edge_venue,
        "arb_symbol": arb_symbol,
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
        _prefer(rows_k)
        if kind in ("spread", "funding"):
            delta = [r for r in rows_k if _on_delta(r.get("legs") or [])]
            other = [r for r in rows_k if not _on_delta(r.get("legs") or [])]
            rows_k = delta + other[:8]
        out.extend(rows_k[: _CAPS[kind]])
    _attach_running(out, running or [])
    return out


def _turn_ok(row: dict, floor: float) -> bool:
    if row.get("venue") == "delta":
        floor = min(floor, MIN_TURN_DELTA)
    return _liquid(row, floor)


def _quote_leg(prefer: dict, other: dict) -> tuple[dict, dict]:
    """Put the Delta contract on the strategy when one leg is Delta."""
    if other.get("venue") == "delta" and prefer.get("venue") != "delta":
        return other, prefer
    return prefer, other


def _executable(a: dict, b: dict) -> tuple[float, dict, dict] | None:
    if not _same_px(a.get("mark") or 0, b.get("mark") or 0):
        return None
    if not a.get("ask") or not a.get("bid") or not b.get("ask") or not b.get("bid"):
        return None
    if a["ask"] <= b["bid"]:
        cheap, rich = a, b
        gross = (b["bid"] - a["ask"]) / a["ask"]
    elif b["ask"] <= a["bid"]:
        cheap, rich = b, a
        gross = (a["bid"] - b["ask"]) / b["ask"]
    else:
        return None
    return gross, cheap, rich


def _best_pair(cands: list[tuple], min_net: float) -> tuple | None:
    """Prefer a pair that includes Delta. Else only a liquid non-Delta pair."""
    ok = [p for p in cands if p[0] >= min_net]
    delta = [p for p in ok if p[2].get("venue") == "delta" or p[3].get("venue") == "delta"]
    pool = delta
    if not pool:
        pool = [
            p for p in ok
            if (p[2].get("turnover") or 0) >= MIN_TURN_OTHER
            and (p[3].get("turnover") or 0) >= MIN_TURN_OTHER
        ]
    if not pool:
        return None
    return max(pool, key=lambda p: p[0])


def _score_base(base: str, quotes: list[dict], found: dict[str, list[dict]]) -> None:
    funded = [
        q for q in quotes
        if q.get("fund_8h") is not None and _turn_ok(q, MIN_TURN_OTHER) and _tight(q)
    ]
    gaps = []
    for i, a in enumerate(funded):
        for b in funded[i + 1 :]:
            if not _same_px(a["mark"], b["mark"]):
                continue
            gap = abs(a["fund_8h"] - b["fund_8h"])
            long_q, short_q = (a, b) if a["fund_8h"] <= b["fund_8h"] else (b, a)
            gaps.append((gap, gap, long_q, short_q))
    best_fund = _best_pair(gaps, MIN_FUND)
    if best_fund:
        gap, _, long_q, short_q = best_fund
        quote, other = _quote_leg(long_q, short_q)
        venues = "-".join(sorted((long_q["venue"], short_q["venue"])))
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
            "score": gap + (0.01 if _on_delta((long_q, short_q)) else 0),
            "apr": round(gap * 3 * 365, 4),
            "legs": [_leg(long_q, "long"), _leg(short_q, "short")],
            "suggest": _suggest("edge", quote, other),
            "running": [],
        })

    priced = [q for q in quotes if _turn_ok(q, MIN_TURN_OTHER) and _tight(q)]
    spreads = []
    for i, a in enumerate(priced):
        for b in priced[i + 1 :]:
            got = _executable(a, b)
            if not got:
                continue
            gross, cheap, rich = got
            net = gross - FEE_TAKER_RT
            spreads.append((net, gross, cheap, rich))
    best_spread = _best_pair(spreads, MIN_SPREAD_NET)
    if best_spread:
        net, gross, cheap, rich = best_spread
        quote, other = _quote_leg(cheap, rich)
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
            "score": net,
            "apr": None,
            "legs": [_leg(cheap, "buy"), _leg(rich, "sell")],
            "suggest": _suggest("arb", quote, other)
            if cheap.get("venue") in _ARB_VENUES and rich.get("venue") in _ARB_VENUES
            else {
                "strategy": "",
                "venue": quote.get("venue") or "",
                "contract": quote.get("symbol") or "",
                "label": "both venues need a fill stream",
            },
            "running": [],
        })

    delta = next((q for q in quotes if q.get("venue") == "delta"), None)
    if delta and _liquid(delta, MIN_TURN_TAPE):
        width = _width(delta)
        trades = delta.get("trades")
        printing = trades is not None and int(trades) >= MIN_PRINTS
        if printing and (width is None or width <= 0.02):
            turn = float(delta.get("turnover") or 0)
            window = delta.get("trade_window")
            plus = "+" if window is not None and window < 55 and int(trades) >= 40 else ""
            found["tape"].append({
                "id": f"tape:{base}:delta",
                "kind": "tape",
                "base": base,
                "summary": (
                    f"Delta printing · {int(trades)}{plus} trades / min · {_usd_short(turn)} 24h"
                ),
                "period": "flow",
                "edge": round(max((width or 0) - FEE_MAKER_RT, 0), 8),
                "gross": round(width or 0, 8),
                "score": float(trades) * 1_000_000 + turn,
                "apr": None,
                "legs": [_leg(delta, "")],
                "suggest": _suggest("stack", delta),
                "running": [],
            })
        change = delta.get("change")
        if (
            change is not None and abs(change) >= MIN_MOVE
            and _liquid(delta, MIN_TURN_MOVE)
            and (width is None or width <= 0.02)
        ):
            side = "up" if change > 0 else "down"
            found["move"].append({
                "id": f"move:{base}:delta",
                "kind": "move",
                "base": base,
                "summary": (
                    f"Delta {side} {abs(change) * 100:.1f}% · {_usd_short(delta.get('turnover') or 0)} 24h"
                ),
                "period": "24h",
                "edge": round(abs(change), 8),
                "gross": round(abs(change), 8),
                "score": abs(change),
                "apr": None,
                "legs": [_leg(delta, "long" if change > 0 else "short")],
                "suggest": _suggest("surge", delta),
                "running": [],
            })
        far = _far_fill(delta, width)
        if far:
            reach, travel, mode = far
            if mode == "book":
                summary = (
                    f"Delta book {(width or 0) * 100:.2f}%"
                    f" · prints covered {travel * 100:.2f}%"
                    f" · a quote behind the touch can fill"
                )
            else:
                summary = (
                    f"Delta prints walked {travel * 100:.2f}% in the last minute"
                    f" · a quote {(travel * 50):.2f}% behind the touch can still fill"
                )
            found["far"].append({
                "id": f"far:{base}:delta",
                "kind": "far",
                "base": base,
                "summary": summary,
                "period": "trade",
                "edge": round(reach, 8),
                "gross": round(travel, 8),
                "score": reach * max(float(delta.get("turnover") or 0), 1),
                "apr": None,
                "legs": [_leg(delta, "")],
                "suggest": _suggest("stack", delta),
                "running": [],
            })
        if width is not None and MIN_BOOK_NET <= (width - FEE_MAKER_RT) <= MAX_BOOK and _liquid(delta, MIN_TURN_DELTA):
            net = width - FEE_MAKER_RT
            turn = float(delta.get("turnover") or 0)
            found["book"].append({
                "id": f"book:{base}:delta",
                "kind": "book",
                "base": base,
                "summary": f"Delta book {width * 100:.2f}% · {_usd_short(turn)} 24h",
                "period": "trade",
                "edge": round(net, 8),
                "gross": round(width, 8),
                "score": net * max(turn, 1),
                "apr": None,
                "legs": [_leg(delta, "")],
                "suggest": _suggest("stack", delta),
                "running": [],
            })

    for q in quotes:
        if q.get("venue") == "delta":
            continue
        if not _turn_ok(q, MIN_TURN_OTHER):
            continue
        if q.get("turnover") is None and not _tight(q, 0.01):
            continue
        width = _width(q)
        if width is not None and width > 0.02:
            continue
        change = q.get("change")
        if (
            change is not None and abs(change) >= 0.06
            and (q.get("turnover") or 0) >= 1_000_000
            and not any(x.get("venue") == "delta" and x.get("change") is not None for x in quotes)
        ):
            side = "up" if change > 0 else "down"
            found["move"].append({
                "id": f"move:{base}:{q['venue']}",
                "kind": "move",
                "base": base,
                "summary": (
                    f"{LABELS.get(q['venue'], q['venue'])} {side} {abs(change) * 100:.1f}%"
                    f" · {_usd_short(q.get('turnover') or 0)} 24h"
                ),
                "period": "24h",
                "edge": round(abs(change), 8),
                "gross": round(abs(change), 8),
                "score": abs(change) * 0.5,
                "apr": None,
                "legs": [_leg(q, "long" if change > 0 else "short")],
                "suggest": _suggest("surge", q),
                "running": [],
            })
        index = q.get("index")
        mark = q["mark"]
        if index and index > 0 and (q.get("turnover") or 0) >= MIN_TURN_OTHER:
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
                    "score": abs(basis),
                    "apr": None,
                    "legs": [_leg(q, side)],
                    "suggest": _suggest("stack", q),
                    "running": [],
                })
        fund = q.get("fund_8h")
        if fund is not None and abs(fund) >= MIN_CARRY and _tight(q) and (q.get("turnover") or 0) >= MIN_TURN_OTHER:
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
                "score": abs(fund),
                "apr": round(abs(fund) * 3 * 365, 4),
                "legs": [_leg(q, side)],
                "suggest": _suggest("stack", q),
                "running": [],
            })

    if delta:
        width = _width(delta)
        if width is None or width <= 0.02:
            index = delta.get("index")
            mark = delta["mark"]
            if index and index > 0 and _liquid(delta, MIN_TURN_DELTA):
                basis = (mark - index) / index
                if abs(basis) >= MIN_BASIS and abs(basis) <= MAX_DISLOC:
                    side = "short" if basis > 0 else "long"
                    word = "Rich vs index" if basis > 0 else "Cheap vs index"
                    found["basis"].append({
                        "id": f"basis:{base}:delta",
                        "kind": "basis",
                        "base": base,
                        "summary": f"{word} · {side} Delta",
                        "period": "basis",
                        "edge": round(abs(basis), 8),
                        "gross": round(abs(basis), 8),
                        "score": abs(basis) + 0.01,
                        "apr": None,
                        "legs": [_leg(delta, side)],
                        "suggest": _suggest("stack", delta),
                        "running": [],
                    })
            fund = delta.get("fund_8h")
            if fund is not None and abs(fund) >= MIN_CARRY and _tight(delta) and _liquid(delta, MIN_TURN_DELTA):
                side = "short" if fund > 0 else "long"
                found["carry"].append({
                    "id": f"carry:{base}:delta",
                    "kind": "carry",
                    "base": base,
                    "summary": (
                        f"{side.capitalize()} Delta"
                        f" · funding {'pays shorts' if fund > 0 else 'pays longs'}"
                    ),
                    "period": "8h",
                    "edge": round(abs(fund), 8),
                    "gross": round(abs(fund), 8),
                    "score": abs(fund) + 0.01,
                    "apr": round(abs(fund) * 3 * 365, 4),
                    "legs": [_leg(delta, side)],
                    "suggest": _suggest("stack", delta),
                    "running": [],
                })


def _far_fill(row: dict, width: float | None) -> tuple[float, float, str] | None:
    """Single-exchange far fill. Two ways a quote behind the touch still gets hit.

    book: the spread itself is wide and recent prints crossed it.
    path: the touch is tighter, but last-minute prints already traded past it.
    Profit is that distance after one maker fee. Path uses half the print range,
    the distance you can sit back and still be where trades printed.
    """
    if not _liquid(row, MIN_TURN_DELTA):
        return None
    lo, hi = row.get("print_low"), row.get("print_high")
    mark = row.get("mark") or 0
    age = row.get("print_age")
    if not lo or not hi or not mark or hi <= lo or age is None or age > 90:
        return None
    travel = (hi - lo) / mark
    fee = FEE_MAKER_RT / 2

    book_net = None
    covered = 0.0
    if width is not None and MIN_FAR_BOOK <= width <= MAX_FAR_BOOK:
        covered = min(travel, width)
        if covered >= MIN_FAR_COVER * width:
            book_net = covered - fee

    path_net = None
    trades = int(row.get("trades") or 0)
    past_touch = width is None or travel >= width * 1.5
    if trades >= MIN_PRINTS and travel >= 0.002 and past_touch:
        path_net = (travel * 0.5) - fee

    if book_net and book_net > 0 and (path_net is None or book_net >= path_net):
        return book_net, covered, "book"
    if path_net and path_net > 0:
        return path_net, travel, "path"
    return None


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
    trades = _num(kwargs.get("trades"))
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
        "change": kwargs.get("change"),
        "trades": None if trades is None else int(trades),
        "trade_window": kwargs.get("trade_window"),
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
            change=_pct(rec.get("mark_change_24h")),
        )
        if row:
            out.append(row)
    # Top turnover keeps the tape. Extra slots go to wide books further down the list.
    by_turn = sorted(out, key=lambda r: r.get("turnover") or 0, reverse=True)
    hot = list(by_turn[:28])
    seen = {r["symbol"] for r in hot}
    wide = [
        row for row in by_turn
        if row["symbol"] not in seen
        and (_width(row) or 0) >= MIN_FAR_BOOK
        and _liquid(row, MIN_TURN_DELTA)
    ]
    wide.sort(key=lambda r: _width(r) or 0, reverse=True)
    for row in wide[:14]:
        hot.append(row)
    if hot:
        await asyncio.gather(*[_delta_prints(client, base, row) for row in hot])
    return out


def _trade_ts(raw) -> float | None:
    v = _num(raw)
    if v is None or v <= 0:
        return None
    if v > 1e15:
        return v / 1e6
    if v > 1e12:
        return v / 1e3
    return v


async def _delta_prints(client: httpx.AsyncClient, base: str, row: dict) -> None:
    """Recent public prints. Delta timestamps are microseconds."""
    try:
        r = await client.get(f"{base}/v2/trades/{row['symbol']}")
        if r.status_code >= 400:
            return
        data = r.json() if r.content else {}
        trades = data.get("result") if isinstance(data, dict) else None
        if not isinstance(trades, list) or not trades:
            row["trades"] = 0
            return
        now = time.time()
        recent = []
        for rec in trades:
            if not isinstance(rec, dict):
                continue
            ts = _trade_ts(rec.get("timestamp") or rec.get("created_at"))
            px = _num(rec.get("price"))
            if ts is None or not px or px <= 0 or now - ts > 180:
                continue
            recent.append((ts, px))
        minute = [(ts, px) for ts, px in recent if now - ts <= 60]
        row["trades"] = len(minute)
        if minute:
            times = [ts for ts, _px in minute]
            row["trade_window"] = max(1.0, max(times) - min(times))
        # Last minute when it is actually printing; otherwise the last three minutes.
        sample = minute if len(minute) >= 3 else recent
        if len(sample) >= 3:
            prices = [px for _ts, px in sample]
            row["print_low"] = min(prices)
            row["print_high"] = max(prices)
            row["print_age"] = now - max(ts for ts, _px in sample)
    except Exception:
        return


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
    day_map: dict[str, dict] = {}
    if day.status_code < 400:
        for rec in day.json() or []:
            if isinstance(rec, dict) and rec.get("symbol"):
                day_map[str(rec["symbol"])] = rec
    out = []
    for rec in prem.json() or []:
        if not isinstance(rec, dict):
            continue
        sym = str(rec.get("symbol") or "")
        if "_" in sym or not (sym.endswith("USDT") or sym.endswith("USDC")):
            continue
        bk = book.get(sym) or {}
        h = hours.get(sym, 8.0)
        day_row = day_map.get(sym) or {}
        row = _quote(
            venue="binance",
            symbol=sym,
            mark=rec.get("markPrice"),
            index=rec.get("indexPrice"),
            bid=bk.get("bidPrice"),
            ask=bk.get("askPrice"),
            fund_8h=_rate_8h(rec.get("lastFundingRate"), h),
            turnover=_num(day_row.get("quoteVolume")),
            change=_pct(day_row.get("priceChangePercent")),
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
            change=_num(rec.get("price24hPcnt")),
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
            change=_num(bk.get("priceChgPct")),
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
    day_map: dict[str, dict] = {}
    if day.status_code < 400:
        blob = day.json() if day.content else []
        if isinstance(blob, dict):
            blob = [blob]
        for rec in blob or []:
            if isinstance(rec, dict) and rec.get("symbol"):
                day_map[str(rec["symbol"])] = rec
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
        day_row = day_map.get(sym) or {}
        row = _quote(
            venue="aster",
            symbol=sym,
            mark=rec.get("markPrice"),
            index=rec.get("indexPrice"),
            bid=bk.get("bidPrice"),
            ask=bk.get("askPrice"),
            fund_8h=_rate_8h(rec.get("lastFundingRate"), hours.get(sym, 8.0)),
            turnover=_num(day_row.get("quoteVolume")),
            change=_pct(day_row.get("priceChangePercent")),
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
