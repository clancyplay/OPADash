from dataclasses import dataclass, fields
import json
import math
import os
from typing import List

from config.settings import load_env_file


@dataclass(frozen=True)
class SymbolConfig:
    delta_symbol: str        # e.g. "LABUSD"
    binance_symbol: str      # e.g. "LABUSDT" (Binance Futures pair — active hedge)
    quantity: float          # lots per order on Delta
    tick_size: float         # minimum price increment on Delta
    quote_offset_ticks: int  # place orders this many ticks away from best bid/ask
    contract_value: float    # underlying units per Delta lot (used to size hedge)
    max_position: float      # max net long/short position (lots) before that side stops quoting
    stop_loss_pct: float = 0.075   # bracket stop-loss distance as a fraction of order price (7.5%)
    stop_loss_enabled: bool = True  # master switch for code-managed SL; False = never place a stop-loss
    min_spread_pct: float = 0.003  # min spread: skip/cancel when raw market spread < this AND min gap between our own quotes
    min_profit_pct: float = 0.0015  # sell floor = entry * (1 + this); fees + edge cover
    hedge_ratio: float = 0.8       # fraction of Delta fill to hedge (0.8 = 80%)
    min_book_size: float = 0.0     # skip bid/ask levels with size below this; 0 = disabled
    delta_leverage: int = 10       # leverage to set on Delta for this symbol
    hedge_leverage: int = 5        # leverage to use on the hedge venue (CoinDCX / Binance)
    coindcx_symbol: str = ""
    hedge_venue: str = ""              # "B" = Binance, "C" = CoinDCX, "" = use global HEDGE_VENUE
    max_mark_divergence_pct: float = 0.0  # max allowed (delta_mark - hedge_mark)/hedge_mark before biasing a side; 0 = disabled
    min_volume_24h: float = 0.0          # minimum 24-hr volume (lots); 0 = disabled
    min_oi: float = 0.0                  # minimum open interest (lots); 0 = disabled
    hedge_edge_check: bool = False       # enable cross-exchange hedge-price viability gate
    min_hedge_edge_pct: float = 0.001    # min required edge over hedge best ask/bid (default 0.1%)
    coindcx_sl_tick: float | None = None  # CoinDCX SL price tick (if different from Delta tick_size)
    wide_offset_enabled: bool = False    # when True, place orders wide_offset_pct away from calc'd top bid/ask (ignores quote_offset_ticks)
    wide_offset_pct: float = 0.008       # order distance as a fraction of price when wide_offset_enabled (default 0.8%)
    spread_gate_enabled: bool = True     # when False, skip the min_spread_pct hard gate check (allow quoting on tight spreads)
    quote_venue: str = "delta"           # where resting maker orders are placed: "delta" (default) or "binance"
    # ── Ladder mode (optional) ─────────────────────────────────────────────────
    # Place multiple resting orders per side, stepping further out and growing in size.
    ladder_enabled: bool = False         # when True, place `ladder_levels` orders per side instead of one
    ladder_levels: int = 1               # number of orders per side (1 = single order, same as before)
    ladder_step_pct: float = 0.0         # extra distance between successive levels as a fraction of price
    ladder_size_mult: float = 1.0        # size multiplier per level: L0=quantity, L1=quantity×m, L2=quantity×m²…

    @property
    def sl_active(self) -> bool:
        """True when the bot should place/maintain a code-managed stop-loss.
        Disabled when turned off explicitly (stop_loss_enabled=False), when the
        distance is non-positive, or in wide-offset mode."""
        return self.stop_loss_enabled and self.stop_loss_pct > 0 and not self.wide_offset_enabled

    @property
    def price_decimals(self) -> int:
        return max(0, round(-math.log10(self.tick_size)))

    @property
    def coindcx_sl_decimals(self) -> int:
        tick = self.coindcx_sl_tick if self.coindcx_sl_tick is not None else self.tick_size
        return max(0, round(-math.log10(tick)))


# ── Active symbols ────────────────────────────────────────────────────────────

SYMBOL_LAB = SymbolConfig(
    delta_symbol="LABUSD",
    binance_symbol="LABUSDT",
    coindcx_symbol="B-LAB_USDT",
    quantity=770,
    tick_size=0.0001,
    quote_offset_ticks=0,
    contract_value=10.0,
    stop_loss_pct=0.30,
    max_position=2310,
    min_spread_pct=0.003,
    hedge_ratio=0.83,
    min_book_size=100.0,
    delta_leverage=3,
    hedge_leverage=3,
    hedge_venue="C",
    max_mark_divergence_pct=0.5,
    min_volume_24h=10000.0,
    min_oi=10000.0,
    hedge_edge_check=True,
    min_hedge_edge_pct=0.001,
    spread_gate_enabled=True,
    quote_venue = "delta",
)

SYMBOL_VELVET = SymbolConfig(
    delta_symbol="VELVETUSD",
    binance_symbol="VELVETUSDT",
    coindcx_symbol="B-VELVET_USDT",
    quantity=60,
    tick_size=0.0001,
    quote_offset_ticks=1,
    contract_value=10.0,
    stop_loss_pct=0.150,
    max_position=1000,
    min_spread_pct=0.0015,
    hedge_ratio=0,
    min_book_size=5.0,
    delta_leverage=5,
    hedge_leverage=3,
    hedge_venue="C",
    max_mark_divergence_pct=0.5,
    min_volume_24h=25000.0,
    min_oi=5000.0,
    hedge_edge_check=False,
    min_hedge_edge_pct=0.001,
    wide_offset_enabled=True,
    wide_offset_pct=0.0008,
    spread_gate_enabled=False,
    quote_venue="delta",
)

SYMBOL_MMT = SymbolConfig(
    delta_symbol="MMTUSD",
    binance_symbol="MMTUSDT",
    coindcx_symbol="B-MMT_USDT",
    quantity=25,
    tick_size=0.0001,
    quote_offset_ticks=1,
    contract_value=10.0,
    stop_loss_pct=0.150,
    max_position=500,
    min_spread_pct=0.003,
    hedge_ratio=0.83,
    min_book_size=5.0,
    delta_leverage=5,
    hedge_leverage=3,
    hedge_venue="C",
    max_mark_divergence_pct=0.2,
    min_volume_24h=25000.0,
    min_oi=25000.0,
    spread_gate_enabled=True,
    quote_venue = "delta",
)


SYMBOL_AIOT = SymbolConfig(
    delta_symbol="AIOTUSD",
    binance_symbol="AIOTUSDT",
    coindcx_symbol="B-AIOT_USDT",
    quantity=25,
    tick_size=0.00001,
    quote_offset_ticks=1,
    contract_value=100.0,
    stop_loss_pct=0.150,
    max_position=100,
    min_spread_pct=0.003,
    hedge_ratio=0.83,
    min_book_size=10.0,
    delta_leverage=5,
    hedge_leverage=3,
    hedge_venue="C",
    max_mark_divergence_pct=0.2,
    min_volume_24h=25000.0,
    min_oi=25000.0,
    spread_gate_enabled=True,
    quote_venue = "delta",
)


SYMBOL_ENA = SymbolConfig(
    delta_symbol="ENAUSD",
    binance_symbol="ENAUSDT",
    coindcx_symbol="B-ENA_USDT",
    quantity=5000,
    tick_size=0.00001,
    quote_offset_ticks=1,
    contract_value=1.0,
    stop_loss_pct=0.150,
    max_position=10000,
    min_spread_pct=0.002,
    hedge_ratio=0.83,
    min_book_size=1000.0,
    delta_leverage=5,
    hedge_leverage=3,
    hedge_venue="C",
    max_mark_divergence_pct=0.2,
    min_volume_24h=25000.0,
    min_oi=25000.0,
    spread_gate_enabled=True,
    quote_venue = "delta",
)

SYMBOL_SOLV = SymbolConfig(
    delta_symbol="SOLVUSD",
    binance_symbol="SOLVUSDT",
    coindcx_symbol="B-SOLV_USDT",
    quantity=200,
    tick_size=0.000001,
    quote_offset_ticks=0,
    contract_value=100.0,
    stop_loss_pct=0.150,
    max_position=500,
    min_spread_pct=0.003,
    hedge_ratio=0.83,
    min_book_size=2500.0,
    delta_leverage=5,
    hedge_leverage=3,
    hedge_venue="C",
    max_mark_divergence_pct=0.2,
    min_volume_24h=25000.0,
    min_oi=25000.0,
    spread_gate_enabled=True,
    quote_venue = "delta",
)

SYMBOL_ARIA = SymbolConfig(
    delta_symbol="ARIAUSD",
    binance_symbol="ARIAUSDT",
    coindcx_symbol="B-ARIA_USDT",
    quantity=1000,
    tick_size=0.0001,
    quote_offset_ticks=0,
    contract_value=10.0,
    stop_loss_pct=0.150,
    max_position=3000,
    min_spread_pct=0.005,
    hedge_ratio=0.83,
    min_book_size=500.0,
    delta_leverage=5,
    hedge_leverage=3,
    hedge_venue="C",
    max_mark_divergence_pct=0.5,
    min_volume_24h=5000.0,
    min_oi=25000.0,
    hedge_edge_check=True,
    min_hedge_edge_pct=0.005,
    spread_gate_enabled=True,
    quote_venue = "delta",
)

SYMBOL_SKL = SymbolConfig(
    delta_symbol="SKLUSD",
    binance_symbol="SKLUSDT",
    coindcx_symbol="B-SKL_USDT",
    quantity=20000, #in lots (1 lot = 1 underlying unit)
    tick_size=0.00001,
    quote_offset_ticks=0,
    contract_value=100.0,
    stop_loss_pct=0.150,
    max_position=100000,
    min_spread_pct=0.005,
    hedge_ratio=0.83,
    min_book_size=1000.0,   # In Lots (1 lot = min_book_size underlying units)
    delta_leverage=5,
    hedge_leverage=3,
    hedge_venue="C",
    max_mark_divergence_pct=0.2,
    min_volume_24h=25000.0,
    min_oi=25000.0,
    spread_gate_enabled=True,
    quote_venue = "delta",
)

SYMBOL_BEAT = SymbolConfig(
    delta_symbol="BEATUSD",
    binance_symbol="BEATUSDT",
    coindcx_symbol="B-BEAT_USDT",
    quantity=100, #in lots (1 lot = 1 underlying unit)
    tick_size=0.0001,
    coindcx_sl_tick=0.001,  # CoinDCX requires SL divisible by 0.001
    quote_offset_ticks=0,
    contract_value=10.0,
    stop_loss_pct=0.150,
    max_position=1000,
    min_spread_pct=0.004,
    hedge_ratio=0.83,
    min_book_size=500.0,   # In Lots (1 lot = min_book_size underlying units)
    delta_leverage=5,
    hedge_leverage=3,
    hedge_venue="C",
    max_mark_divergence_pct=0.5,
    min_volume_24h=25000.0,
    min_oi=25000.0,
    hedge_edge_check=True,
    min_hedge_edge_pct=0.002,
    spread_gate_enabled=True,
    quote_venue = "delta",
)

SYMBOL_ZORA = SymbolConfig(
    delta_symbol="ZORAUSD",
    binance_symbol="ZORAUSDT",
    quantity=150,
    tick_size=0.00001,
    quote_offset_ticks=0,
    contract_value=100.0,
    stop_loss_pct=0.15,
    max_position=2000,
    min_spread_pct=0.003,
    hedge_ratio=0,
    min_book_size=10.0,
    quote_venue="binance",
)


# Symbols to trade — add/remove entries to enable/disable a symbol
# ── Registry of all predefined symbols (keyed by delta_symbol) ─────────────────
# Used by ACTIVE_SYMBOLS in .env to pick which ones to run without editing code.
_REGISTRY: dict[str, SymbolConfig] = {
    s.delta_symbol.upper(): s
    for s in (
        SYMBOL_LAB,
        SYMBOL_VELVET,
        SYMBOL_MMT,
        SYMBOL_AIOT,
        SYMBOL_ENA,
        SYMBOL_SOLV,
        SYMBOL_ARIA,
        SYMBOL_SKL,
        SYMBOL_BEAT,
        SYMBOL_ZORA,
    )
}

# Default active list when neither SYMBOLS_JSON nor ACTIVE_SYMBOLS is set in .env
_DEFAULT_ACTIVE: List[SymbolConfig] = [
    SYMBOL_VELVET,
]


def _valid_field_names() -> set[str]:
    return {f.name for f in fields(SymbolConfig)}


def _symbol_from_dict(entry: dict) -> SymbolConfig:
    """Build a SymbolConfig from a plain dict (from SYMBOLS_JSON). Unknown keys are
    rejected; unspecified optional fields fall back to the dataclass defaults."""
    valid = _valid_field_names()
    unknown = set(entry) - valid
    if unknown:
        raise ValueError(
            f"SYMBOLS_JSON entry has unknown field(s): {sorted(unknown)}. "
            f"Valid fields: {sorted(valid)}"
        )
    return SymbolConfig(**entry)


def load_symbols() -> List[SymbolConfig]:
    """
    Resolve the active symbol list, controlled entirely from the environment (.env):

      1. SYMBOLS_JSON  — a single-line JSON array of symbol objects. Each object
         needs the required fields (delta_symbol, binance_symbol, quantity,
         tick_size, quote_offset_ticks, contract_value, max_position); every other
         field is optional and falls back to the SymbolConfig default. This lets you
         define ALL symbols and ALL parameters from .env, no code edits needed.

         Example (one line in .env):
           SYMBOLS_JSON=[{"delta_symbol":"VELVETUSD","binance_symbol":"VELVETUSDT","coindcx_symbol":"B-VELVET_USDT","quantity":60,"tick_size":0.0001,"quote_offset_ticks":1,"contract_value":10.0,"max_position":1000,"quote_venue":"binance","hedge_ratio":0}]

      2. ACTIVE_SYMBOLS — a comma-separated list of predefined symbol names to run,
         e.g. ACTIVE_SYMBOLS=VELVETUSD,LABUSD  (picks from the code registry above).

      3. Neither set → the built-in default list (_DEFAULT_ACTIVE).
    """
    # symbol.py is imported before main() calls load_env_file(), so load it here too.
    load_env_file()

    raw_json = os.getenv("SYMBOLS_JSON", "").strip()
    if raw_json:
        try:
            data = json.loads(raw_json)
        except json.JSONDecodeError as exc:
            raise ValueError(f"SYMBOLS_JSON is not valid JSON: {exc}") from exc
        if not isinstance(data, list) or not data:
            raise ValueError("SYMBOLS_JSON must be a non-empty JSON array of symbol objects")
        return [_symbol_from_dict(e) for e in data]

    active = os.getenv("ACTIVE_SYMBOLS", "").strip()
    if active:
        names = [n.strip().upper() for n in active.split(",") if n.strip()]
        result: List[SymbolConfig] = []
        for name in names:
            if name not in _REGISTRY:
                raise ValueError(
                    f"ACTIVE_SYMBOLS: unknown symbol '{name}'. "
                    f"Known: {sorted(_REGISTRY)}"
                )
            result.append(_REGISTRY[name])
        if not result:
            raise ValueError("ACTIVE_SYMBOLS was set but resolved to no valid symbols")
        return result

    return list(_DEFAULT_ACTIVE)


SYMBOLS: List[SymbolConfig] = load_symbols()

# Backward-compatible alias (used by any code that still imports SYMBOL directly)
SYMBOL = SYMBOL_LAB
