"""
Event logging to PostgreSQL — records all fills, orders, and position changes.
Tables are auto-created on first connect. Safe to disable by leaving DATABASE_URL empty.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Optional

import asyncpg

from utils.logger import get_logger


# Exchanges that appear in fills.exchange. Add a venue here and the rPnL
# queries, filters and currency conversion pick it up.
KNOWN_VENUES = ("delta", "binance", "kucoin", "coindcx", "aster")
# Venues whose rpnl/fee columns are already in INR; the rest are USD.
INR_VENUES = ("coindcx",)


def contract_aliases(contract: str) -> list[str]:
    """ZORAUSD ↔ ZORAUSDT so Binance fills show on the Delta rPnL series."""
    raw = (contract or "").strip()
    if not raw:
        return []
    upper = raw.upper()
    out = [upper]
    if upper.endswith("USDT"):
        out.append(upper[:-1])
    elif upper.endswith("USD"):
        out.append(upper + "T")
    seen, aliases = set(), []
    for name in out:
        if name not in seen:
            seen.add(name)
            aliases.append(name)
    return aliases


def canon_contract(contract: str) -> str:
    name = (contract or "").upper()
    if name.endswith("USDT"):
        return name[:-1]
    return name


class EventsDB:
    def __init__(self, database_url: str, usdinr_rate: float = 1.0) -> None:
        self.database_url = database_url
        self.usdinr_rate = usdinr_rate  # USD/USDT→INR factor applied to money values on read
        self.pool: Optional[asyncpg.Pool] = None
        self.logger = get_logger(__name__)
        self._session_start: datetime = datetime.now(timezone.utc)

    async def connect(self) -> None:
        if not self.database_url:
            self.logger.warning("events_db: DATABASE_URL not set — event logging disabled")
            return
        try:
            self.pool = await asyncpg.create_pool(
                self.database_url,
                min_size=2,
                max_size=10,
                command_timeout=60,
            )
            await self._create_tables()
            self._session_start = datetime.now(timezone.utc)
            self.logger.info("events_db: PostgreSQL connected, session_start=%s", self._session_start.isoformat())
        except Exception as e:
            self.logger.error("events_db: failed to connect — %s", e)
            self.pool = None

    async def close(self) -> None:
        if self.pool:
            await self.pool.close()

    async def _create_tables(self) -> None:
        if not self.pool:
            return
        async with self.pool.acquire() as conn:
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS events (
                    id          BIGSERIAL PRIMARY KEY,
                    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    contract    VARCHAR(30)  NOT NULL,
                    event_type  VARCHAR(50)  NOT NULL,
                    order_id    VARCHAR(100),
                    side        VARCHAR(10),
                    price       NUMERIC(22, 8),
                    quantity    NUMERIC(22, 4),
                    status      VARCHAR(50),
                    details     JSONB
                );
                CREATE INDEX IF NOT EXISTS idx_events_contract   ON events(contract);
                CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC);
            """)
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS fills (
                    id          BIGSERIAL PRIMARY KEY,
                    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    contract    VARCHAR(30)  NOT NULL,
                    exchange    VARCHAR(20)  NOT NULL,
                    order_id    VARCHAR(100),
                    side        VARCHAR(10)  NOT NULL,
                    quantity    NUMERIC(22, 4) NOT NULL,
                    price       NUMERIC(22, 8) NOT NULL,
                    cost        NUMERIC(22, 2),
                    fee         NUMERIC(22, 8),
                    upnl        NUMERIC(22, 2),
                    rpnl        NUMERIC(22, 2),
                    details     JSONB
                );
                CREATE INDEX IF NOT EXISTS idx_fills_contract   ON fills(contract);
                CREATE INDEX IF NOT EXISTS idx_fills_exchange   ON fills(exchange);
                CREATE INDEX IF NOT EXISTS idx_fills_created_at ON fills(created_at DESC);
            """)
            # Migrate existing DBs that pre-date the fee column
            await conn.execute("""
                ALTER TABLE fills ADD COLUMN IF NOT EXISTS fee NUMERIC(22, 8);
            """)
            await conn.execute("""
                ALTER TABLE fills ADD COLUMN IF NOT EXISTS account VARCHAR(40);
            """)
            await conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_fills_account
                ON fills(strategy, account, contract);
            """)
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS orders (
                    id              BIGSERIAL PRIMARY KEY,
                    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    contract        VARCHAR(30)  NOT NULL,
                    exchange        VARCHAR(20)  NOT NULL,
                    order_id        VARCHAR(100) NOT NULL,
                    side            VARCHAR(10)  NOT NULL,
                    order_type      VARCHAR(30),
                    price           NUMERIC(22, 8),
                    avg_fill_price  NUMERIC(22, 8),
                    size            NUMERIC(22, 4),
                    filled_size     NUMERIC(22, 4) NOT NULL DEFAULT 0,
                    status          VARCHAR(30),
                    rpnl            NUMERIC(22, 2),
                    source          VARCHAR(10)  NOT NULL DEFAULT 'live',
                    details         JSONB,
                    UNIQUE (exchange, order_id)
                );
                CREATE INDEX IF NOT EXISTS idx_orders_contract   ON orders(contract);
                CREATE INDEX IF NOT EXISTS idx_orders_exchange   ON orders(exchange);
                CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
            """)
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS positions (
                    id            BIGSERIAL PRIMARY KEY,
                    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    contract      VARCHAR(30)  NOT NULL,
                    delta_size    NUMERIC(22, 4),
                    delta_entry   NUMERIC(22, 8),
                    binance_size  NUMERIC(22, 4),
                    binance_entry NUMERIC(22, 8),
                    mark_price    NUMERIC(22, 8),
                    net_upnl      NUMERIC(22, 4)
                );
                CREATE INDEX IF NOT EXISTS idx_positions_contract   ON positions(contract);
                CREATE INDEX IF NOT EXISTS idx_positions_created_at ON positions(created_at DESC);
            """)
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS balances (
                    id              BIGSERIAL PRIMARY KEY,
                    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    delta_balance   NUMERIC(22, 4),
                    binance_balance NUMERIC(22, 4),
                    total_balance   NUMERIC(22, 4)
                );
                CREATE INDEX IF NOT EXISTS idx_balances_created_at ON balances(created_at DESC);
            """)
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS reports (
                    id          BIGSERIAL PRIMARY KEY,
                    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    kind        VARCHAR(20)  NOT NULL DEFAULT 'periodic',
                    message     TEXT         NOT NULL,
                    summary     JSONB
                );
                CREATE INDEX IF NOT EXISTS idx_reports_created_at ON reports(created_at DESC);
            """)
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS logs (
                    id          BIGSERIAL PRIMARY KEY,
                    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    service     VARCHAR(20)  NOT NULL,
                    level       VARCHAR(10)  NOT NULL,
                    name        VARCHAR(120),
                    message     TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_logs_id      ON logs(id DESC);
                CREATE INDEX IF NOT EXISTS idx_logs_service ON logs(service);
            """)
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS bot_control (
                    id             INT PRIMARY KEY DEFAULT 1,
                    desired_state  VARCHAR(20) NOT NULL DEFAULT 'running',
                    note           TEXT,
                    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_by     VARCHAR(40),
                    CONSTRAINT bot_control_singleton CHECK (id = 1)
                );
                INSERT INTO bot_control (id, desired_state)
                VALUES (1, 'running')
                ON CONFLICT (id) DO NOTHING;
            """)
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS coindcx_transactions (
                    id              BIGSERIAL PRIMARY KEY,
                    synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    created_at      TIMESTAMPTZ,
                    pair            VARCHAR(30),
                    stage           VARCHAR(30),
                    amount          NUMERIC(22, 8),
                    fee_amount      NUMERIC(22, 8),
                    price_in_usdt   NUMERIC(22, 8),
                    source          VARCHAR(20),
                    parent_type     VARCHAR(80),
                    parent_id       VARCHAR(100),
                    position_id     VARCHAR(100),
                    settlement_amount NUMERIC(22, 8),
                    margin_ccy      VARCHAR(10),
                    UNIQUE (parent_id, stage)
                );
                CREATE INDEX IF NOT EXISTS idx_cdxtx_created_at ON coindcx_transactions(created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_cdxtx_pair       ON coindcx_transactions(pair);
            """)
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS deposits_withdrawals (
                    id          BIGSERIAL PRIMARY KEY,
                    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    amount      NUMERIC(22, 4) NOT NULL,
                    note        TEXT,
                    recorded_by VARCHAR(40)
                );
                CREATE INDEX IF NOT EXISTS idx_dw_created_at ON deposits_withdrawals(created_at DESC);
            """)
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS live_state (
                    symbol       VARCHAR(30) PRIMARY KEY,
                    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    data         JSONB NOT NULL DEFAULT '{}'
                );
            """)

    async def update_live_state(self, symbol: str, data: dict) -> None:
        """Upsert per-symbol live state (positions, orders, book). Called by quoter every sync."""
        if not self.pool:
            return
        try:
            async with self.pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO live_state (symbol, updated_at, data)
                    VALUES ($1, NOW(), $2::jsonb)
                    ON CONFLICT (symbol) DO UPDATE
                      SET updated_at = NOW(), data = $2::jsonb
                    """,
                    symbol, json.dumps(data),
                )
        except Exception as e:
            self.logger.warning("events_db: update_live_state failed — %s", e)

    async def get_live_state(self) -> list[dict]:
        """Return latest live state for all symbols, newest first."""
        if not self.pool:
            return []
        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT symbol, updated_at, data FROM live_state ORDER BY symbol"
                )
            return [
                {
                    "symbol":     r["symbol"],
                    "updated_at": r["updated_at"].isoformat(),
                    "data":       dict(r["data"]),
                }
                for r in rows
            ]
        except Exception as e:
            self.logger.debug("events_db: get_live_state failed — %s", e)
            return []

    async def get_live_heartbeats(self, max_age_secs: int = 45) -> list[dict]:
        """Contracts the quoter is currently writing to `live_state`.

        A row older than `max_age_secs` is treated as dead — the bot stopped or
        crashed without deleting it. Account is read from the JSON payload when
        the bot puts it there; otherwise the heartbeat is contract-wide.
        """
        rows = await self.get_live_state()
        now = datetime.now(timezone.utc)
        out: list[dict] = []
        for r in rows:
            raw_ts = r.get("updated_at")
            try:
                ts = datetime.fromisoformat(str(raw_ts).replace("Z", "+00:00"))
            except (TypeError, ValueError):
                continue
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            age = (now - ts).total_seconds()
            data = r.get("data") or {}
            if not isinstance(data, dict):
                data = {}
            acct = str(
                data.get("account")
                or data.get("account_id")
                or data.get("delta_account")
                or ""
            )
            out.append({
                "symbol": (r.get("symbol") or "").upper(),
                "account": acct,
                "age_secs": round(age, 1),
                "fresh": age <= max_age_secs,
                "paused": bool(data.get("paused")),
                "halted": bool(data.get("halted")),
            })
        return out

    async def log_deposit_withdrawal(self, amount: float, note: str = "", recorded_by: str = "webapp", at: "datetime | None" = None) -> int | None:
        """Log a deposit (positive) or withdrawal (negative). Returns new row id.
        Pass `at` (UTC datetime) to back-date a historical entry."""
        if not self.pool:
            return None
        try:
            async with self.pool.acquire() as conn:
                if at is not None:
                    row = await conn.fetchrow(
                        "INSERT INTO deposits_withdrawals (created_at, amount, note, recorded_by) VALUES ($1,$2,$3,$4) RETURNING id",
                        at, float(amount), note or None, recorded_by,
                    )
                else:
                    row = await conn.fetchrow(
                        "INSERT INTO deposits_withdrawals (amount, note, recorded_by) VALUES ($1,$2,$3) RETURNING id",
                        float(amount), note or None, recorded_by,
                    )
                return int(row["id"])
        except Exception as e:
            self.logger.warning("events_db: log_deposit_withdrawal failed — %s", e)
            return None

    async def get_net_deposits_since(self, since: "datetime") -> float:
        """Sum of deposit/withdrawal amounts since a UTC datetime (positive = net deposit)."""
        if not self.pool:
            return 0.0
        try:
            async with self.pool.acquire() as conn:
                row = await conn.fetchrow(
                    "SELECT COALESCE(SUM(amount), 0.0) AS total FROM deposits_withdrawals WHERE created_at >= $1",
                    since,
                )
                return float(row["total"] or 0.0)
        except Exception as e:
            self.logger.warning("events_db: get_net_deposits_since failed — %s", e)
            return 0.0

    async def get_deposits_withdrawals(self, limit: int = 50) -> list[dict]:
        """Return most recent deposit/withdrawal rows."""
        if not self.pool:
            return []
        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT id, created_at, amount, note, recorded_by FROM deposits_withdrawals ORDER BY created_at DESC LIMIT $1",
                    limit,
                )
            return [dict(r) for r in rows]
        except Exception as e:
            self.logger.warning("events_db: get_deposits_withdrawals failed — %s", e)
            return []

    async def log_event(
        self,
        contract: str,
        event_type: str,
        order_id: Optional[str] = None,
        side: Optional[str] = None,
        price: Optional[float] = None,
        quantity: Optional[float] = None,
        status: Optional[str] = None,
        details: Optional[dict] = None,
    ) -> None:
        if not self.pool:
            return
        try:
            async with self.pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO events (contract, event_type, order_id, side, price, quantity, status, details)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    """,
                    contract, event_type, order_id, side, price, quantity, status,
                    json.dumps(details or {}),
                )
        except Exception as e:
            self.logger.warning("events_db: log_event failed — %s", e)

    async def log_fill(
        self,
        contract: str,
        exchange: str,
        order_id: str,
        side: str,
        quantity: float,
        price: float,
        cost: Optional[float] = None,
        fee: Optional[float] = None,
        upnl: Optional[float] = None,
        rpnl: Optional[float] = None,
        details: Optional[dict] = None,
    ) -> None:
        if not self.pool:
            return
        try:
            async with self.pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO fills (contract, exchange, order_id, side, quantity, price, cost, fee, upnl, rpnl, details)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                    """,
                    contract, exchange, order_id, side, quantity, price, cost, fee, upnl, rpnl,
                    json.dumps(details or {}),
                )
        except Exception as e:
            self.logger.warning("events_db: log_fill failed — %s", e)

    async def upsert_order(
        self,
        contract: str,
        exchange: str,
        order_id: str,
        side: str,
        *,
        order_type: Optional[str] = None,
        price: Optional[float] = None,
        avg_fill_price: Optional[float] = None,
        size: Optional[float] = None,
        filled_size: float = 0.0,
        status: Optional[str] = None,
        created_at: Optional[datetime] = None,
        source: str = "live",
        details: Optional[dict] = None,
    ) -> None:
        """Insert or update an order row, keyed by (exchange, order_id).

        Used by both live logging (hedge market orders) and the periodic REST
        reconciliation (Delta order history). On conflict the newer, non-null
        values win so a partial live row is upgraded by the authoritative sync.
        """
        if not self.pool:
            return
        try:
            async with self.pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO orders (contract, exchange, order_id, side, order_type,
                                        price, avg_fill_price, size, filled_size, status,
                                        source, details, created_at, updated_at)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                            COALESCE($13, NOW()), NOW())
                    ON CONFLICT (exchange, order_id) DO UPDATE SET
                        side           = EXCLUDED.side,
                        order_type     = COALESCE(EXCLUDED.order_type, orders.order_type),
                        price          = COALESCE(EXCLUDED.price, orders.price),
                        avg_fill_price = COALESCE(EXCLUDED.avg_fill_price, orders.avg_fill_price),
                        size           = COALESCE(EXCLUDED.size, orders.size),
                        filled_size    = GREATEST(EXCLUDED.filled_size, orders.filled_size),
                        status         = COALESCE(EXCLUDED.status, orders.status),
                        source         = EXCLUDED.source,
                        details        = COALESCE(EXCLUDED.details, orders.details),
                        created_at     = COALESCE(EXCLUDED.created_at, orders.created_at),
                        updated_at     = NOW()
                    """,
                    contract, exchange, str(order_id), side, order_type,
                    price, avg_fill_price, size, filled_size, status,
                    source, json.dumps(details or {}), created_at,
                )
        except Exception as e:
            self.logger.warning("events_db: upsert_order failed — %s", e)

    async def get_orders(
        self,
        contract: Optional[str] = None,
        exchange: Optional[str] = None,
        since: Optional[datetime] = None,
        limit: int = 500,
        strategy: str = "opa3",
    ) -> list[dict]:
        """Order-history rows for the UI, newest first."""
        if not self.pool:
            return []
        wheres: list[str] = []
        params: list = []
        if since is not None:
            params.append(since)
            wheres.append(f"o.created_at >= ${len(params)}")
        if contract:
            params.append(contract.upper())
            wheres.append(f"o.contract = ${len(params)}")
        if exchange == "hedge":
            wheres.append("o.exchange <> 'delta'")
        elif exchange:
            params.append(exchange.lower())
            wheres.append(f"o.exchange = ${len(params)}")
        params.append(strategy)
        strat_idx = len(params)
        wheres.append(f"o.strategy = ${strat_idx}")
        where_sql = ("WHERE " + " AND ".join(wheres)) if wheres else ""
        params.append(limit)
        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    f"""
                    SELECT o.created_at, o.contract, o.exchange, o.order_id, o.side, o.order_type,
                           o.price::float          AS price,
                           o.avg_fill_price::float AS avg_fill_price,
                           o.size::float           AS size,
                           o.filled_size::float    AS filled_size,
                           o.status,
                           o.rpnl::float           AS rpnl,
                           f.total_fee::float      AS fee
                    FROM orders o
                    LEFT JOIN (
                        SELECT exchange, order_id, SUM(fee) AS total_fee
                        FROM fills
                        WHERE fee IS NOT NULL AND strategy = ${strat_idx}
                        GROUP BY exchange, order_id
                    ) f ON f.exchange = o.exchange AND f.order_id = o.order_id
                    {where_sql}
                    ORDER BY o.created_at DESC LIMIT ${len(params)}
                    """,
                    *params,
                )
            out = []
            for r in rows:
                d = dict(r)
                # Delta/Binance fees are USD-native → convert to ₹; CoinDCX fees are already INR.
                if d.get("fee") is not None and d.get("exchange") in ("delta", "binance"):
                    d["fee"] = d["fee"] * self.usdinr_rate
                out.append(d)
            return out
        except Exception as e:
            self.logger.warning("events_db: get_orders failed — %s", e)
            return []

    @staticmethod
    def _vwap_realized(orders: list[dict], unit_mult: float) -> list[float]:
        """Return per-order realized PnL by running a VWAP position over the
        chronologically-ordered filled portions of `orders`.

        `unit_mult` converts the stored quantity into price-native units
        (contract_value for Delta lots, 1.0 for hedge units)."""
        lots = 0.0
        avg = 0.0
        out: list[float] = []
        for o in orders:
            qty = float(o.get("filled_size") or 0.0) * unit_mult
            price = float(o.get("avg_fill_price") or 0.0)
            side = (o.get("side") or "").lower()
            if qty <= 0 or price <= 0:
                out.append(0.0)
                continue
            is_buy = side == "buy"
            is_long = lots > 0
            is_short = lots < 0
            rpnl = 0.0
            if lots == 0:
                lots = qty if is_buy else -qty
                avg = price
            elif (is_buy and is_long) or (not is_buy and is_short):
                existing = abs(lots)
                new_total = existing + qty
                avg = (avg * existing + price * qty) / new_total
                lots = new_total if is_long else -new_total
            else:
                existing = abs(lots)
                reduce = min(qty, existing)
                direction = 1.0 if is_long else -1.0
                rpnl = direction * (price - avg) * reduce
                remaining = existing - reduce
                if remaining == 0:
                    lots = 0.0
                    avg = 0.0
                else:
                    lots = remaining if is_long else -remaining
                flip = qty - existing
                if flip > 0:
                    lots = flip if is_buy else -flip
                    avg = price
            out.append(rpnl)
        return out

    async def get_rpnl_summary(
        self,
        contract_values: dict[str, float],
        since: Optional[datetime] = None,
        strategy: str = "opa3",
    ) -> dict:
        """Authoritative realized-PnL summary computed from the orders table.

        Runs a VWAP position per (contract, exchange) over every order that has
        a filled portion — including orders that were partially filled and then
        cancelled — so nothing is missed. Returns per-symbol, per-day and grand
        totals split by Delta vs hedge.
        """
        empty = {"by_symbol": [], "by_day": [], "totals": {"delta": 0.0, "hedge": 0.0, "total": 0.0}}
        if not self.pool:
            return empty
        try:
            wheres = ["filled_size > 0"]
            params: list = []
            if since is not None:
                params.append(since)
                wheres.append(f"created_at >= ${len(params)}")
            params.append(strategy)
            wheres.append(f"strategy = ${len(params)}")
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    f"""
                    SELECT created_at, contract, exchange, side,
                           avg_fill_price::float AS avg_fill_price,
                           filled_size::float    AS filled_size
                    FROM orders
                    WHERE {' AND '.join(wheres)}
                    ORDER BY created_at ASC
                    """,
                    *params,
                )
        except Exception as e:
            self.logger.warning("events_db: get_rpnl_summary failed — %s", e)
            return empty

        from datetime import timedelta
        IST = timezone(timedelta(hours=5, minutes=30))

        # Group chronologically by (contract, exchange)
        groups: dict[tuple[str, str], list[dict]] = {}
        for r in rows:
            groups.setdefault((r["contract"], r["exchange"]), []).append(dict(r))

        by_symbol: dict[str, dict] = {}
        by_day: dict[str, dict] = {}
        tot_delta = tot_hedge = 0.0

        for (contract, exchange), olist in groups.items():
            is_delta = exchange == "delta"
            mult = contract_values.get(contract, 1.0) if is_delta else 1.0
            realized = self._vwap_realized(olist, mult)
            leg = "delta" if is_delta else "hedge"
            sym = by_symbol.setdefault(
                contract,
                {"contract": contract, "delta": 0.0, "hedge": 0.0,
                 "delta_orders": 0, "hedge_orders": 0},
            )
            for o, rp in zip(olist, realized):
                sym[leg] += rp
                sym[f"{leg}_orders"] += 1
                day = o["created_at"].astimezone(IST).strftime("%Y-%m-%d")
                d = by_day.setdefault(day, {"date": day, "delta": 0.0, "hedge": 0.0})
                d[leg] += rp
                if is_delta:
                    tot_delta += rp
                else:
                    tot_hedge += rp

        sym_list = []
        for s in by_symbol.values():
            s["total"] = s["delta"] + s["hedge"]
            sym_list.append(s)
        sym_list.sort(key=lambda x: x["total"])

        day_list = []
        for d in by_day.values():
            d["total"] = d["delta"] + d["hedge"]
            day_list.append(d)
        day_list.sort(key=lambda x: x["date"], reverse=True)

        R = self.usdinr_rate
        for s in sym_list:
            s["delta"] *= R
            s["hedge"] *= R
            s["total"] *= R
        for d in day_list:
            d["delta"] *= R
            d["hedge"] *= R
            d["total"] *= R
        return {
            "by_symbol": sym_list,
            "by_day": day_list,
            "totals": {"delta": tot_delta * R, "hedge": tot_hedge * R, "total": (tot_delta + tot_hedge) * R},
        }

    async def get_session_rpnl(self, contract: str, exchange: str) -> float:
        """Sum of rpnl for fills since this bot session started."""
        if not self.pool:
            return 0.0
        try:
            async with self.pool.acquire() as conn:
                row = await conn.fetchrow(
                    """
                    SELECT COALESCE(SUM(rpnl), 0.0) AS total
                    FROM fills
                    WHERE contract = $1
                      AND exchange = $2
                      AND rpnl IS NOT NULL
                      AND created_at >= $3
                    """,
                    contract, exchange, self._session_start,
                )
                return float(row["total"] or 0.0) * self.usdinr_rate
        except Exception as e:
            self.logger.warning("events_db: get_session_rpnl failed — %s", e)
            return 0.0

    async def upsert_coindcx_transaction(self, row: dict) -> None:
        """Insert or ignore a CoinDCX transaction row, keyed by (parent_id, stage)."""
        if not self.pool:
            return
        import decimal
        def _f(v):
            try: return float(v) if v is not None else None
            except Exception: return None
        try:
            created_at = None
            ts = row.get("created_at")
            if ts:
                try:
                    created_at = datetime.fromtimestamp(float(ts) / 1000, tz=timezone.utc)
                except Exception:
                    pass
            async with self.pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO coindcx_transactions
                        (created_at, pair, stage, amount, fee_amount, price_in_usdt,
                         source, parent_type, parent_id, position_id,
                         settlement_amount, margin_ccy)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                    ON CONFLICT (parent_id, stage) DO NOTHING
                    """,
                    created_at,
                    row.get("pair"),
                    row.get("stage"),
                    _f(row.get("amount")),
                    _f(row.get("fee_amount")),
                    _f(row.get("price_in_usdt")),
                    row.get("source"),
                    row.get("parent_type"),
                    str(row.get("parent_id") or ""),
                    str(row.get("position_id") or ""),
                    _f(row.get("settlement_amount")),
                    row.get("margin_currency_short_name"),
                )
        except Exception as e:
            self.logger.warning("events_db: upsert_coindcx_transaction failed — %s", e)

    async def get_coindcx_transactions(
        self,
        pair: Optional[str] = None,
        since: Optional[datetime] = None,
        limit: int = 500,
    ) -> list[dict]:
        """Fetch stored CoinDCX transactions ordered by created_at desc."""
        if not self.pool:
            return []
        wheres, params = [], []
        if since:
            params.append(since); wheres.append(f"created_at >= ${len(params)}")
        if pair:
            params.append(pair.upper()); wheres.append(f"pair = ${len(params)}")
        where_sql = ("WHERE " + " AND ".join(wheres)) if wheres else ""
        params.append(limit)
        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    f"""
                    SELECT created_at, pair, stage,
                           amount::float        AS amount,
                           fee_amount::float    AS fee_amount,
                           price_in_usdt::float AS price_in_usdt,
                           source, parent_type, parent_id, position_id,
                           settlement_amount::float AS settlement_amount,
                           margin_ccy
                    FROM coindcx_transactions {where_sql}
                    ORDER BY created_at DESC NULLS LAST LIMIT ${len(params)}
                    """,
                    *params,
                )
            return [dict(r) for r in rows]
        except Exception as e:
            self.logger.warning("events_db: get_coindcx_transactions failed — %s", e)
            return []

    async def get_daily_rpnl(self, date_ist: "datetime") -> float:
        """Total rpnl for all fills on a given calendar date (IST midnight-to-midnight)."""
        if not self.pool:
            return 0.0
        try:
            from datetime import timedelta
            IST = timezone(timedelta(hours=5, minutes=30))
            day_start = date_ist.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)
            day_end   = day_start + timedelta(days=1)
            async with self.pool.acquire() as conn:
                row = await conn.fetchrow(
                    """
                    SELECT COALESCE(SUM(rpnl), 0.0) AS total
                    FROM fills
                    WHERE rpnl IS NOT NULL
                      AND created_at >= $1 AND created_at < $2
                    """,
                    day_start, day_end,
                )
                return float(row["total"] or 0.0) * self.usdinr_rate
        except Exception as e:
            self.logger.warning("events_db: get_daily_rpnl failed — %s", e)
            return 0.0

    async def get_session_rpnl_by_side(self, contract: str, exchange: str) -> dict[str, float]:
        """Buy/sell rpnl sum for fills since this bot session started."""
        if not self.pool:
            return {"buy": 0.0, "sell": 0.0}
        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    """
                    SELECT side, COALESCE(SUM(rpnl), 0.0) AS total
                    FROM fills
                    WHERE contract = $1 AND exchange = $2
                      AND rpnl IS NOT NULL AND created_at >= $3
                    GROUP BY side
                    """,
                    contract, exchange, self._session_start,
                )
            result: dict[str, float] = {"buy": 0.0, "sell": 0.0}
            for row in rows:
                result[row["side"]] = float(row["total"] or 0.0) * self.usdinr_rate
            return result
        except Exception as e:
            self.logger.warning("events_db: get_session_rpnl_by_side failed — %s", e)
            return {"buy": 0.0, "sell": 0.0}

    async def get_rpnl_since(self, contract: str, exchange: str, since: "datetime") -> float:
        """Total rpnl for a symbol/exchange since an arbitrary UTC datetime."""
        if not self.pool:
            return 0.0
        try:
            async with self.pool.acquire() as conn:
                row = await conn.fetchrow(
                    """
                    SELECT COALESCE(SUM(rpnl), 0.0) AS total
                    FROM fills
                    WHERE contract = $1 AND exchange = $2
                      AND rpnl IS NOT NULL AND created_at >= $3
                    """,
                    contract, exchange, since,
                )
                return float(row["total"] or 0.0) * self.usdinr_rate
        except Exception as e:
            self.logger.warning("events_db: get_rpnl_since failed — %s", e)
            return 0.0

    async def get_rpnl_since_by_side(self, contract: str, exchange: str, since: "datetime") -> dict[str, float]:
        """Buy/sell rpnl for a symbol/exchange since an arbitrary UTC datetime."""
        if not self.pool:
            return {"buy": 0.0, "sell": 0.0}
        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    """
                    SELECT side, COALESCE(SUM(rpnl), 0.0) AS total
                    FROM fills
                    WHERE contract = $1 AND exchange = $2
                      AND rpnl IS NOT NULL AND created_at >= $3
                    GROUP BY side
                    """,
                    contract, exchange, since,
                )
            result: dict[str, float] = {"buy": 0.0, "sell": 0.0}
            for row in rows:
                result[row["side"]] = float(row["total"] or 0.0) * self.usdinr_rate
            return result
        except Exception as e:
            self.logger.warning("events_db: get_rpnl_since_by_side failed — %s", e)
            return {"buy": 0.0, "sell": 0.0}

    async def get_fills_count_since(self, contract: str, since: "datetime") -> dict:
        """Fill counts and lot volume (both exchanges combined) since an arbitrary UTC datetime."""
        if not self.pool:
            return {"buy": 0, "sell": 0, "volume": 0.0}
        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    """
                    SELECT side,
                           COUNT(*)                   AS cnt,
                           COALESCE(SUM(quantity), 0) AS vol
                    FROM fills
                    WHERE contract = $1 AND created_at >= $2
                    GROUP BY side
                    """,
                    contract, since,
                )
            result: dict = {"buy": 0, "sell": 0, "volume": 0.0}
            for row in rows:
                result[row["side"]]  = int(row["cnt"])
                result["volume"]    += float(row["vol"] or 0.0)
            return result
        except Exception as e:
            self.logger.warning("events_db: get_fills_count_since failed — %s", e)
            return {"buy": 0, "sell": 0, "volume": 0.0}

    async def log_position_snapshot(
        self,
        contract: str,
        delta_size: float,
        delta_entry: float,
        binance_size: float,
        binance_entry: float,
        mark_price: float,
        net_upnl: float,
    ) -> None:
        """Record the current position sizes and unrealized PnL for charting."""
        if not self.pool:
            return
        try:
            async with self.pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO positions
                        (contract, delta_size, delta_entry, binance_size, binance_entry, mark_price, net_upnl)
                    VALUES ($1,$2,$3,$4,$5,$6,$7)
                    """,
                    contract,
                    delta_size   or None,
                    delta_entry  or None,
                    binance_size  or None,
                    binance_entry or None,
                    mark_price   or None,
                    net_upnl     or None,
                )
        except Exception as e:
            self.logger.warning("events_db: log_position_snapshot failed — %s", e)

    async def log_balance_snapshot(
        self,
        delta_balance: float,
        binance_balance: float,
    ) -> None:
        """Record exchange balances for equity-curve charting."""
        if not self.pool:
            return
        try:
            total = (delta_balance or 0.0) + (binance_balance or 0.0)
            async with self.pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO balances (delta_balance, binance_balance, total_balance)
                    VALUES ($1, $2, $3)
                    """,
                    delta_balance or None,
                    binance_balance or None,
                    total or None,
                )
        except Exception as e:
            self.logger.warning("events_db: log_balance_snapshot failed — %s", e)

    async def get_balance_at(self, ts: "datetime", strategy: str = "opa3") -> float:
        """Return total_balance from the row closest to ts (UTC). 0.0 if none found."""
        if not self.pool:
            return 0.0
        try:
            async with self.pool.acquire() as conn:
                row = await conn.fetchrow(
                    """
                    SELECT total_balance
                    FROM balances
                    WHERE strategy = $2
                    ORDER BY ABS(EXTRACT(EPOCH FROM (created_at - $1::timestamptz)))
                    LIMIT 1
                    """,
                    ts, strategy,
                )
            return float(row["total_balance"]) if row and row["total_balance"] else 0.0
        except Exception as e:
            self.logger.warning("events_db: get_balance_at failed — %s", e)
            return 0.0

    async def get_latest_balance(self, strategy: str = "opa3") -> float:
        """Return the most recent total_balance snapshot, 0.0 if none."""
        if not self.pool:
            return 0.0
        try:
            async with self.pool.acquire() as conn:
                row = await conn.fetchrow(
                    "SELECT total_balance FROM balances WHERE strategy = $1 ORDER BY id DESC LIMIT 1",
                    strategy,
                )
            return float(row["total_balance"]) if row and row["total_balance"] else 0.0
        except Exception as e:
            self.logger.warning("events_db: get_latest_balance failed — %s", e)
            return 0.0

    async def get_position_history(self, contract: str, since: "datetime", strategy: str = "opa3") -> list[dict]:
        """Return position snapshots for a contract since a UTC datetime."""
        if not self.pool:
            return []
        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    """
                    SELECT created_at,
                           COALESCE(delta_size,   0)::float AS delta_size,
                           COALESCE(binance_size, 0)::float AS binance_size,
                           COALESCE(mark_price,   0)::float AS mark_price,
                           COALESCE(net_upnl,     0)::float AS net_upnl
                    FROM positions
                    WHERE contract = $1 AND created_at >= $2 AND strategy = $3
                    ORDER BY created_at
                    """,
                    contract, since, strategy,
                )
            return [
                {
                    "time":         int(r["created_at"].timestamp()),
                    "delta_size":   r["delta_size"],
                    "binance_size": r["binance_size"],
                    "mark_price":   r["mark_price"],
                    "net_upnl":     r["net_upnl"] * self.usdinr_rate,
                }
                for r in rows
            ]
        except Exception as e:
            self.logger.warning("events_db: get_position_history failed — %s", e)
            return []

    async def get_position_symbols(self, strategy: str = "opa3") -> list[str]:
        """Distinct contracts that have position snapshots."""
        if not self.pool:
            return []
        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT DISTINCT contract FROM positions WHERE strategy = $1 ORDER BY contract",
                    strategy,
                )
            return [r["contract"] for r in rows]
        except Exception as e:
            self.logger.warning("events_db: get_position_symbols failed — %s", e)
            return []

    async def get_strategies(self) -> list[str]:
        """Distinct strategy tags present across the strategy-tagged tables.

        Feeds the dashboard strategy dropdown. 'opa3' is always returned first so
        the default view is unchanged. Future strategies (e.g. 'opa5') appear
        automatically with no code change.
        """
        if not self.pool:
            return ["opa3"]
        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    """
                    SELECT DISTINCT strategy FROM (
                        SELECT strategy::text AS strategy FROM fills
                        UNION SELECT strategy::text FROM orders
                        UNION SELECT strategy::text FROM positions
                        UNION SELECT strategy::text FROM events
                    ) s
                    WHERE strategy IS NOT NULL AND strategy <> ''
                    ORDER BY strategy
                    """
                )
            vals = [r["strategy"] for r in rows]
            out = (["opa3"] if "opa3" in vals else []) + [v for v in vals if v != "opa3"]
            return out or ["opa3"]
        except Exception as e:
            self.logger.warning("events_db: get_strategies failed — %s", e)
            return ["opa3"]

    async def get_negative_buckets(
        self,
        since: "datetime",
        until: "datetime",
        bucket_minutes: int = 5,
        min_loss: float = -1.0,
    ) -> list[dict]:
        """Return time buckets where net rPnL < min_loss, grouped by contract.

        Returns list of {contract, bucket_time (UTC datetime), bucket_rpnl, fills_count}.
        """
        if not self.pool:
            return []
        bucket_secs = bucket_minutes * 60
        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    """
                    SELECT
                        contract,
                        to_timestamp(floor(extract(epoch from created_at) / $1) * $1) AS bucket_time,
                        COALESCE(SUM(rpnl), 0)::float  AS bucket_rpnl,
                        COUNT(*)::int                  AS fills_count
                    FROM fills
                    WHERE created_at >= $2 AND created_at < $3
                    GROUP BY contract, bucket_time
                    HAVING COALESCE(SUM(rpnl), 0) < $4
                    ORDER BY contract, bucket_rpnl
                    """,
                    float(bucket_secs), since, until, min_loss / self.usdinr_rate,
                )
            return [
                {**dict(r), "bucket_rpnl": float(dict(r).get("bucket_rpnl") or 0.0) * self.usdinr_rate}
                for r in rows
            ]
        except Exception as e:
            self.logger.warning("events_db: get_negative_buckets failed — %s", e)
            return []

    # ── Bot control (shared between webapp and bot process) ───────────────────

    async def insert_log_rows(self, rows: list[tuple]) -> None:
        """Batch-insert log lines: (created_at, service, level, name, message). Silent on failure."""
        if not self.pool or not rows:
            return
        try:
            async with self.pool.acquire() as conn:
                await conn.executemany(
                    "INSERT INTO logs (created_at, service, level, name, message) VALUES ($1, $2, $3, $4, $5)",
                    rows,
                )
        except Exception:
            pass  # never let log persistence crash or spam-log the app

    async def get_logs(
        self,
        limit: int = 200,
        service: Optional[str] = None,
        level: Optional[str] = None,
        search: Optional[str] = None,
        after_id: Optional[int] = None,
        before_id: Optional[int] = None,
    ) -> list[dict]:
        """Recent log lines, newest first (or oldest-first after `after_id` for tailing).

        `before_id` pages backwards (older): returns rows with id < before_id,
        newest-first, for a "load older" control.
        """
        if not self.pool:
            return []
        try:
            wheres, params = ["1=1"], []
            if service:
                params.append(service)
                wheres.append(f"service = ${len(params)}")
            if level:
                params.append(level.upper())
                wheres.append(f"level = ${len(params)}")
            if search:
                params.append(f"%{search}%")
                wheres.append(f"(message ILIKE ${len(params)} OR name ILIKE ${len(params)})")
            if after_id:
                params.append(after_id)
                wheres.append(f"id > ${len(params)}")
            if before_id:
                params.append(before_id)
                wheres.append(f"id < ${len(params)}")
            params.append(limit)
            order = "ASC" if after_id else "DESC"
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    f"SELECT id, created_at, service, level, name, message FROM logs "
                    f"WHERE {' AND '.join(wheres)} ORDER BY id {order} LIMIT ${len(params)}",
                    *params,
                )
            return [
                {
                    "id":      r["id"],
                    "time":    int(r["created_at"].timestamp()),
                    "service": r["service"],
                    "level":   r["level"],
                    "name":    r["name"],
                    "message": r["message"],
                }
                for r in rows
            ]
        except Exception as e:
            self.logger.warning("events_db: get_logs failed — %s", e)
            return []

    async def set_bot_control(self, desired_state: str, note: str = "", updated_by: str = "webapp") -> None:
        """Persist the desired bot state ('running' or 'paused'). Polled by the bot."""
        if not self.pool:
            return
        try:
            async with self.pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO bot_control (id, desired_state, note, updated_at, updated_by)
                    VALUES (1, $1, $2, NOW(), $3)
                    ON CONFLICT (id) DO UPDATE
                    SET desired_state = EXCLUDED.desired_state,
                        note          = EXCLUDED.note,
                        updated_at    = EXCLUDED.updated_at,
                        updated_by    = EXCLUDED.updated_by
                    """,
                    desired_state, note or None, updated_by,
                )
        except Exception as e:
            self.logger.warning("events_db: set_bot_control failed — %s", e)

    async def get_bot_control(self) -> dict:
        """Return the current desired bot state. Defaults to 'running' if unset."""
        default = {"desired_state": "running", "note": None, "updated_at": None, "updated_by": None}
        if not self.pool:
            return default
        try:
            async with self.pool.acquire() as conn:
                row = await conn.fetchrow(
                    "SELECT desired_state, note, updated_at, updated_by FROM bot_control WHERE id = 1"
                )
            if not row:
                return default
            return {
                "desired_state": row["desired_state"],
                "note":          row["note"],
                "updated_at":    row["updated_at"].isoformat() if row["updated_at"] else None,
                "updated_by":    row["updated_by"],
            }
        except Exception as e:
            self.logger.warning("events_db: get_bot_control failed — %s", e)
            return default

    # ── Reports history ───────────────────────────────────────────────────────

    async def save_report(self, message: str, summary: Optional[dict] = None, kind: str = "periodic") -> None:
        """Store a rendered report so it can be viewed later in the dashboard."""
        if not self.pool:
            return
        try:
            async with self.pool.acquire() as conn:
                await conn.execute(
                    "INSERT INTO reports (kind, message, summary) VALUES ($1, $2, $3)",
                    kind, message, json.dumps(summary or {}),
                )
        except Exception as e:
            self.logger.warning("events_db: save_report failed — %s", e)

    async def get_reports(self, limit: int = 50, before_id: Optional[int] = None) -> list[dict]:
        """Return report metadata (no full message) for the history list, newest first."""
        if not self.pool:
            return []
        try:
            async with self.pool.acquire() as conn:
                if before_id:
                    rows = await conn.fetch(
                        """
                        SELECT id, created_at, kind, summary
                        FROM reports WHERE id < $2
                        ORDER BY id DESC LIMIT $1
                        """,
                        limit, before_id,
                    )
                else:
                    rows = await conn.fetch(
                        """
                        SELECT id, created_at, kind, summary
                        FROM reports ORDER BY id DESC LIMIT $1
                        """,
                        limit,
                    )
            return [
                {
                    "id":         int(r["id"]),
                    "created_at": r["created_at"].isoformat(),
                    "time":       int(r["created_at"].timestamp()),
                    "kind":       r["kind"],
                    "summary":    json.loads(r["summary"]) if r["summary"] else {},
                }
                for r in rows
            ]
        except Exception as e:
            self.logger.warning("events_db: get_reports failed — %s", e)
            return []

    async def get_report(self, report_id: int) -> Optional[dict]:
        """Return a single full report by id."""
        if not self.pool:
            return None
        try:
            async with self.pool.acquire() as conn:
                row = await conn.fetchrow(
                    "SELECT id, created_at, kind, message, summary FROM reports WHERE id = $1",
                    report_id,
                )
            if not row:
                return None
            return {
                "id":         int(row["id"]),
                "created_at": row["created_at"].isoformat(),
                "time":       int(row["created_at"].timestamp()),
                "kind":       row["kind"],
                "message":    row["message"],
                "summary":    json.loads(row["summary"]) if row["summary"] else {},
            }
        except Exception as e:
            self.logger.warning("events_db: get_report failed — %s", e)
            return None

    # ── Status feed ───────────────────────────────────────────────────────────

    async def get_recent_events(self, limit: int = 50, contract: Optional[str] = None, strategy: str = "opa3") -> list[dict]:
        """Recent events for the live activity feed, newest first."""
        if not self.pool:
            return []
        try:
            async with self.pool.acquire() as conn:
                if contract:
                    rows = await conn.fetch(
                        """
                        SELECT created_at, contract, event_type, side, price, quantity, status
                        FROM events WHERE contract = $2 AND strategy = $3
                        ORDER BY id DESC LIMIT $1
                        """,
                        limit, contract.upper(), strategy,
                    )
                else:
                    rows = await conn.fetch(
                        """
                        SELECT created_at, contract, event_type, side, price, quantity, status
                        FROM events WHERE strategy = $2 ORDER BY id DESC LIMIT $1
                        """,
                        limit, strategy,
                    )
            return [
                {
                    "time":       int(r["created_at"].timestamp()),
                    "created_at": r["created_at"].isoformat(),
                    "contract":   r["contract"],
                    "event_type": r["event_type"],
                    "side":       r["side"],
                    "price":      float(r["price"]) if r["price"] is not None else None,
                    "quantity":   float(r["quantity"]) if r["quantity"] is not None else None,
                    "status":     r["status"],
                }
                for r in rows
            ]
        except Exception as e:
            self.logger.warning("events_db: get_recent_events failed — %s", e)
            return []

    async def get_status_snapshot(self, strategy: str = "opa3") -> dict:
        """Aggregate for the Bot status page: latest balance, latest position per
        contract, and the timestamp of the most recent activity (liveness)."""
        empty = {"last_seen": None, "balance": None, "positions": []}
        if not self.pool:
            return empty
        try:
            async with self.pool.acquire() as conn:
                bal = await conn.fetchrow(
                    """
                    SELECT created_at,
                           COALESCE(delta_balance,   0)::float AS delta_balance,
                           COALESCE(binance_balance, 0)::float AS binance_balance,
                           COALESCE(total_balance,   0)::float AS total_balance
                    FROM balances WHERE strategy = $1 ORDER BY id DESC LIMIT 1
                    """,
                    strategy,
                )
                positions = await conn.fetch(
                    """
                    SELECT DISTINCT ON (contract)
                           contract, created_at,
                           COALESCE(delta_size,   0)::float AS delta_size,
                           COALESCE(delta_entry,  0)::float AS delta_entry,
                           COALESCE(binance_size, 0)::float AS binance_size,
                           COALESCE(mark_price,   0)::float AS mark_price,
                           COALESCE(net_upnl,     0)::float AS net_upnl
                    FROM positions
                    WHERE strategy = $1
                    ORDER BY contract, created_at DESC
                    """,
                    strategy,
                )
                last_event = await conn.fetchval(
                    "SELECT MAX(created_at) FROM events WHERE strategy = $1", strategy
                )

            last_times = [t for t in (
                bal["created_at"] if bal else None,
                positions[0]["created_at"] if positions else None,
                last_event,
            ) if t is not None]
            last_seen = max(last_times) if last_times else None

            return {
                "last_seen": last_seen.isoformat() if last_seen else None,
                "balance": {
                    "time":            int(bal["created_at"].timestamp()),
                    "delta_balance":   bal["delta_balance"],
                    "binance_balance": bal["binance_balance"],
                    "total_balance":   bal["total_balance"],
                } if bal else None,
                "positions": [
                    {
                        "contract":     p["contract"],
                        "time":         int(p["created_at"].timestamp()),
                        "delta_size":   p["delta_size"],
                        "delta_entry":  p["delta_entry"],
                        "binance_size": p["binance_size"],
                        "mark_price":   p["mark_price"],
                        "net_upnl":     p["net_upnl"],
                    }
                    for p in positions
                ],
            }
        except Exception as e:
            self.logger.warning("events_db: get_status_snapshot failed — %s", e)
            return empty

    async def get_latest_position_snapshot(self, contract: str) -> dict:
        """Most recent position snapshot row for a contract."""
        if not self.pool:
            return {}
        try:
            async with self.pool.acquire() as conn:
                row = await conn.fetchrow(
                    """
                    SELECT delta_size, delta_entry, mark_price, net_upnl
                    FROM positions
                    WHERE contract = $1
                    ORDER BY created_at DESC LIMIT 1
                    """,
                    contract,
                )
            if row:
                d = {k: float(row[k] or 0.0) for k in row.keys()}
                if "net_upnl" in d:
                    d["net_upnl"] *= self.usdinr_rate
                return d
            return {}
        except Exception as e:
            self.logger.warning("events_db: get_latest_position_snapshot failed — %s", e)
            return {}

    async def get_window_stats(self, contract: str, since: "datetime") -> dict:
        """rPnL + fill counts + volume for a contract since a UTC datetime (all exchanges)."""
        if not self.pool:
            return {"rpnl": 0.0, "fills_buy": 0, "fills_sell": 0, "volume": 0.0}
        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    """
                    SELECT side,
                           COUNT(*)                        AS cnt,
                           COALESCE(SUM(quantity), 0)      AS vol,
                           COALESCE(SUM(rpnl),     0)      AS pnl
                    FROM fills
                    WHERE contract = $1 AND created_at >= $2 AND rpnl IS NOT NULL
                    GROUP BY side
                    """,
                    contract, since,
                )
            result: dict = {"rpnl": 0.0, "fills_buy": 0, "fills_sell": 0, "volume": 0.0}
            for row in rows:
                side = row["side"]
                result["rpnl"]   += float(row["pnl"] or 0.0) * self.usdinr_rate
                result["volume"] += float(row["vol"] or 0.0)
                if side == "buy":
                    result["fills_buy"]  = int(row["cnt"])
                else:
                    result["fills_sell"] = int(row["cnt"])
            return result
        except Exception as e:
            self.logger.warning("events_db: get_window_stats failed — %s", e)
            return {"rpnl": 0.0, "fills_buy": 0, "fills_sell": 0, "volume": 0.0}

    async def get_contract_rpnl_summary(self, strategy: str = "opa3") -> list[dict]:
        """Per-contract+account fill count + realized PnL (₹) for the dashboard.

        Aggregated per exchange in Python rather than with a fixed set of SQL
        FILTERs, so a venue that shows up in the fills table later (aster did)
        is picked up without a code change.
        """
        if not self.pool:
            return []
        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    """
                    SELECT contract,
                           COALESCE(account::text, '') AS account,
                           LOWER(exchange) AS exchange,
                           COUNT(*)::int AS n,
                           COALESCE(SUM(rpnl), 0)::float AS rpnl,
                           COALESCE(SUM(fee), 0)::float AS fee,
                           MIN(created_at) AS first_at,
                           MAX(created_at) AS last_at
                    FROM fills
                    WHERE strategy::text = $1
                    GROUP BY contract, COALESCE(account::text, ''), LOWER(exchange)
                    """,
                    strategy,
                )
            # Keyed on the account id — the id is what the fills queries filter
            # on, so it has to be what the dashboard round-trips.
            grouped: dict[tuple[str, str], dict] = {}
            for r in rows:
                account = r["account"] or ""
                contract = canon_contract(r["contract"])
                item = grouped.setdefault((contract, account), {
                    "contract": contract,
                    "account": account,
                    "venue_fills": {},
                    "venue_rpnl": {},
                    "venue_fees": {},
                    "first_at": None,
                    "last_at": None,
                })
                venue = (r["exchange"] or "delta").lower()
                item["venue_fills"][venue] = item["venue_fills"].get(venue, 0) + int(r["n"] or 0)
                item["venue_rpnl"][venue] = round(
                    item["venue_rpnl"].get(venue, 0.0)
                    + self._rpnl_inr(float(r["rpnl"] or 0), venue), 4,
                )
                item["venue_fees"][venue] = round(
                    item["venue_fees"].get(venue, 0.0)
                    + self._rpnl_inr(float(r["fee"] or 0), venue), 4,
                )
                first = int(r["first_at"].timestamp()) if r["first_at"] else None
                last = int(r["last_at"].timestamp()) if r["last_at"] else None
                if first and (not item["first_at"] or first < item["first_at"]):
                    item["first_at"] = first
                if last and (not item["last_at"] or last > item["last_at"]):
                    item["last_at"] = last

            out: list[dict] = []
            venue_only: dict[str, dict] = {}
            for item in grouped.values():
                # Hedge fills are logged without the quote venue's account id —
                # hold them aside so they can be folded onto the real pill.
                if not item["account"] and not item["venue_fills"].get("delta"):
                    venue_only[item["contract"]] = item
                else:
                    out.append(item)
            used = set()
            for item in out:
                h = venue_only.get(item["contract"])
                if h and set(item["venue_fills"]) <= {"delta"}:
                    for field in ("venue_fills", "venue_rpnl", "venue_fees"):
                        for venue, val in h[field].items():
                            if venue != "delta":
                                item[field][venue] = val
                    used.add(item["contract"])
            for contract, h in venue_only.items():
                if contract not in used and not any(m["contract"] == contract for m in out):
                    out.append(h)
            for item in out:
                self._add_legacy_rpnl_fields(item)
            out.sort(key=lambda i: i["venue_rpnl"].get("delta", 0.0), reverse=True)
            return out
        except Exception as e:
            self.logger.warning("events_db: get_contract_rpnl_summary failed — %s", e)
            return []

    async def get_rpnl_rollup(
        self, strategy: str = "opa3", since: "datetime | None" = None,
    ) -> list[dict]:
        """Realized PnL (₹) per IST day / contract / exchange.

        Raw enough that the caller can roll it up by day or by symbol and still
        decide which exchange is the quote venue.
        """
        if not self.pool:
            return []
        try:
            params: list = [strategy]
            sql = """
                SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date AS day,
                       contract,
                       LOWER(exchange) AS exchange,
                       COUNT(*)::int AS fills,
                       COALESCE(SUM(rpnl), 0)::float AS rpnl,
                       COALESCE(SUM(fee), 0)::float AS fee
                FROM fills
                WHERE strategy::text = $1
            """
            if since is not None:
                params.append(since)
                sql += f" AND created_at >= ${len(params)}"
            sql += " GROUP BY 1, 2, 3 ORDER BY 1 DESC"
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(sql, *params)
            return [
                {
                    "date": r["day"].isoformat(),
                    "contract": canon_contract(r["contract"]),
                    "exchange": (r["exchange"] or "delta").lower(),
                    "fills": int(r["fills"] or 0),
                    "rpnl": round(self._rpnl_inr(float(r["rpnl"] or 0), r["exchange"]), 4),
                    "fee": round(self._rpnl_inr(float(r["fee"] or 0), r["exchange"]), 4),
                }
                for r in rows
            ]
        except Exception as e:
            self.logger.warning("events_db: get_rpnl_rollup failed — %s", e)
            return []

    @staticmethod
    def _add_legacy_rpnl_fields(item: dict) -> None:
        """Per-venue named keys the dashboard and Data page still read."""
        fills, rpnl, fees = item["venue_fills"], item["venue_rpnl"], item["venue_fees"]
        for key, venue in (
            ("fills", "delta"), ("binance_fills", "binance"),
            ("kucoin_fills", "kucoin"), ("cdcx_fills", "coindcx"),
            ("aster_fills", "aster"),
        ):
            item[key] = fills.get(venue, 0)
        for key, venue in (
            ("rpnl", "delta"), ("binance_rpnl", "binance"),
            ("kucoin_rpnl", "kucoin"), ("cdcx_rpnl", "coindcx"),
            ("aster_rpnl", "aster"),
        ):
            item[key] = round(rpnl.get(venue, 0.0), 2)
        item["fees"] = round(fees.get("delta", 0.0), 2)
        item["hedge_fills"] = sum(n for v, n in fills.items() if v != "delta")
        item["hedge_rpnl"] = round(sum(x for v, x in rpnl.items() if v != "delta"), 2)
        item["hedge_fees"] = round(sum(x for v, x in fees.items() if v != "delta"), 2)

    def _exchange_filter(
        self, exchange: str | None, start_idx: int, quote_venue: str = "delta",
    ) -> tuple[str, list]:
        exch = (exchange or "delta").lower()
        qv = (quote_venue or "delta").lower()
        if qv in ("c",):
            qv = "coindcx"
        if qv not in KNOWN_VENUES:
            qv = "delta"
        if exch == "quote":
            return f" AND exchange = ${start_idx}", [qv]
        if exch == "not_quote":
            return f" AND exchange <> ${start_idx}", [qv]
        if exch == "hedge":
            return " AND exchange <> 'delta'", []
        if exch in KNOWN_VENUES and exch != "delta":
            return f" AND exchange = ${start_idx}", [exch]
        return f" AND exchange = ${start_idx}", ["delta"]

    def _rpnl_inr(self, value: float, exchange: str) -> float:
        """CoinDCX books rPnL in INR already; every other venue is USD."""
        if (exchange or "delta").lower() in INR_VENUES:
            return float(value or 0)
        return float(value or 0) * self.usdinr_rate

    def _skip_account_filter(self, exchange: str | None) -> bool:
        """Hedge-side fills are logged without the quote venue's account id."""
        exch = (exchange or "").lower()
        return exch in ("not_quote", "hedge") or (exch in KNOWN_VENUES and exch != "delta")

    async def get_contract_venue_stats(
        self, contract: str, strategy: str = "opa3", account: str | None = None,
        since: "datetime | None" = None,
    ) -> dict[str, int]:
        """Fill count per exchange for a contract, so the venue can be read from
        the data instead of guessed from config. Account-scoped when given."""
        if not self.pool:
            return {}
        try:
            aliases = contract_aliases(contract)
            params: list = [aliases, strategy]
            sql = (
                "SELECT LOWER(exchange) AS exchange, COUNT(*)::int AS n FROM fills "
                "WHERE UPPER(contract) = ANY($1::text[]) AND strategy::text = $2"
            )
            if since is not None:
                params.append(since)
                sql += f" AND created_at >= ${len(params)}"
            if account:
                params.append(account)
                sql += (
                    f" AND (account::text = ${len(params)}"
                    " OR account IS NULL OR account::text = '')"
                )
            sql += " GROUP BY LOWER(exchange)"
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(sql, *params)
            return {(r["exchange"] or "delta"): int(r["n"] or 0) for r in rows if r["n"]}
        except Exception as e:
            self.logger.warning("events_db: get_contract_venue_stats failed — %s", e)
            return {}

    async def get_fill_markers(
        self, contract: str, since: "datetime", strategy: str = "opa3",
        limit: int = 2000, account: str | None = None, exchange: str = "delta",
        bucket_seconds: int = 300, quote_venue: str = "delta",
    ) -> list[dict]:
        """One fill per candle-bucket per side (largest |rPnL|) for OHLC overlay."""
        if not self.pool:
            return []
        try:
            step = max(60, int(bucket_seconds or 300))
            aliases = contract_aliases(contract)
            exch_sql, exch_args = self._exchange_filter(exchange, 5, quote_venue=quote_venue)
            if self._skip_account_filter(exchange):
                acct_sql, acct_args = "", []
            else:
                acct_sql, acct_args = self._account_filter(account, 5 + len(exch_args))
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    f"""
                    WITH src AS (
                      SELECT created_at, side, price::float AS price,
                             quantity::float AS quantity, rpnl::float AS rpnl,
                             COALESCE(account::text, '') AS account, exchange
                      FROM fills
                      WHERE UPPER(contract) = ANY($1::text[]) AND strategy::text = $2
                        AND created_at >= $3{exch_sql}{acct_sql}
                    ),
                    ranked AS (
                      SELECT *,
                        ROW_NUMBER() OVER (
                          PARTITION BY (FLOOR(EXTRACT(EPOCH FROM created_at) / $4)::bigint), side
                          ORDER BY ABS(COALESCE(rpnl, 0)) DESC, created_at
                        ) AS rn
                      FROM src
                    )
                    SELECT created_at, side, price, quantity, rpnl, account, exchange
                    FROM ranked
                    WHERE rn = 1 AND ABS(COALESCE(rpnl, 0)) > 1e-9
                    ORDER BY created_at
                    LIMIT ${5 + len(exch_args) + len(acct_args)}
                    """,
                    aliases, strategy, since, step, *exch_args, *acct_args, limit,
                )
            return [
                {
                    "time": int(r["created_at"].timestamp()),
                    "side": r["side"],
                    "price": r["price"],
                    "quantity": r["quantity"],
                    "rpnl": round(self._rpnl_inr(r["rpnl"] or 0, r["exchange"]), 4),
                    "account": r["account"] or "",
                    "exchange": r["exchange"] or "",
                }
                for r in rows
            ]
        except Exception as e:
            self.logger.warning("events_db: get_fill_markers failed — %s", e)
            return []

    def _account_filter(self, account: str | None, start_idx: int) -> tuple[str, list]:
        # account is cast to text so the queries survive the column being a
        # varchar, an integer or anything else id-shaped.
        if account is None:
            return "", []
        if account == "":
            return " AND (account IS NULL OR account::text = '')", []
        return f" AND account::text = ${start_idx}", [account]

    async def get_rpnl_timeseries(
        self, contract: str, since: "datetime", bucket_minutes: int = 5, strategy: str = "opa3",
        account: str | None = None, exchange: str = "delta", quote_venue: str = "delta",
    ) -> list[dict]:
        """Cumulative rPnL timeseries bucketed by `bucket_minutes` since a UTC datetime.

        Returns list of {"time": unix_ts, "rpnl": cumulative_float} in ₹.
        CoinDCX rpnl is already INR; Delta/Binance is converted with usdinr_rate.
        """
        if not self.pool:
            return []
        try:
            bucket_secs = bucket_minutes * 60
            aliases = contract_aliases(contract)
            params: list = [aliases, since, float(bucket_secs), strategy]
            exch_sql, exch_args = self._exchange_filter(exchange, len(params) + 1, quote_venue=quote_venue)
            params.extend(exch_args)
            if self._skip_account_filter(exchange):
                acct_sql, acct_args = "", []
            else:
                acct_sql, acct_args = self._account_filter(account, len(params) + 1)
            params.extend(acct_args)
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    f"""
                    SELECT to_timestamp(
                               floor(extract(epoch from created_at) / $3) * $3
                           )                          AS bucket,
                           exchange,
                           COALESCE(SUM(rpnl), 0)    AS bucket_pnl
                    FROM fills
                    WHERE UPPER(contract) = ANY($1::text[]) AND created_at >= $2 AND strategy::text = $4
                      {exch_sql}{acct_sql}
                    GROUP BY bucket, exchange
                    ORDER BY bucket
                    """,
                    *params,
                )
            by_time: dict[int, float] = {}
            for row in rows:
                t = int(row["bucket"].timestamp())
                by_time[t] = by_time.get(t, 0.0) + self._rpnl_inr(
                    float(row["bucket_pnl"] or 0.0), row["exchange"],
                )
            cumulative = 0.0
            result = []
            for t in sorted(by_time):
                cumulative += by_time[t]
                result.append({"time": t, "rpnl": round(cumulative, 4)})
            return result
        except Exception as e:
            self.logger.warning("events_db: get_rpnl_timeseries failed — %s", e)
            return []

    async def get_recent_rpnl(
        self, contract: str, exchange: str, secs: int = 300
    ) -> dict[str, float]:
        """Buy/sell rpnl sum for fills in the last `secs` seconds."""
        if not self.pool:
            return {"buy": 0.0, "sell": 0.0}
        try:
            from datetime import timedelta
            since = datetime.now(timezone.utc) - timedelta(seconds=secs)
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    """
                    SELECT side, COALESCE(SUM(rpnl), 0.0) AS total
                    FROM fills
                    WHERE contract = $1 AND exchange = $2
                      AND rpnl IS NOT NULL AND created_at >= $3
                    GROUP BY side
                    """,
                    contract, exchange, since,
                )
            result: dict[str, float] = {"buy": 0.0, "sell": 0.0}
            for row in rows:
                result[row["side"]] = float(row["total"] or 0.0) * self.usdinr_rate
            return result
        except Exception as e:
            self.logger.warning("events_db: get_recent_rpnl failed — %s", e)
            return {"buy": 0.0, "sell": 0.0}

    async def get_fills(
        self,
        contract: Optional[str] = None,
        exchange: Optional[str] = None,
        limit: int = 100,
        strategy: str = "opa3",
    ) -> list[dict]:
        if not self.pool:
            return []
        try:
            async with self.pool.acquire() as conn:
                wheres, params = ["1=1"], []
                if contract:
                    params.append(contract)
                    wheres.append(f"contract = ${len(params)}")
                if exchange:
                    params.append(exchange)
                    wheres.append(f"exchange = ${len(params)}")
                params.append(strategy)
                wheres.append(f"strategy = ${len(params)}")
                params.append(limit)
                rows = await conn.fetch(
                    f"SELECT * FROM fills WHERE {' AND '.join(wheres)} ORDER BY created_at DESC LIMIT ${len(params)}",
                    *params,
                )
                return [dict(r) for r in rows]
        except Exception as e:
            self.logger.warning("events_db: get_fills failed — %s", e)
            return []

    async def get_events(
        self,
        contract: Optional[str] = None,
        event_type: Optional[str] = None,
        limit: int = 100,
        strategy: str = "opa3",
    ) -> list[dict]:
        if not self.pool:
            return []
        try:
            async with self.pool.acquire() as conn:
                wheres, params = ["1=1"], []
                if contract:
                    params.append(contract)
                    wheres.append(f"contract = ${len(params)}")
                if event_type:
                    params.append(event_type)
                    wheres.append(f"event_type = ${len(params)}")
                params.append(strategy)
                wheres.append(f"strategy = ${len(params)}")
                params.append(limit)
                rows = await conn.fetch(
                    f"SELECT * FROM events WHERE {' AND '.join(wheres)} ORDER BY created_at DESC LIMIT ${len(params)}",
                    *params,
                )
                return [dict(r) for r in rows]
        except Exception as e:
            self.logger.warning("events_db: get_events failed — %s", e)
            return []
