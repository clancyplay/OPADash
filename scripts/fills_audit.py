"""Inspect and clean up the `fills` table.

Report (safe, read-only):
    python -m scripts.fills_audit
    python -m scripts.fills_audit --contract LISTAUSD

Delete one contract+account group (destructive, needs --yes):
    python -m scripts.fills_audit --delete --contract LISTAUSD --account 12345 --yes

Every rPnL pill on the dashboard is one (contract, account) group, so deleting a
group removes exactly one pill.
"""
from __future__ import annotations

import argparse
import asyncio
import sys

import asyncpg

from config.settings import Settings


def canon_contract(contract: str) -> str:
    """LISTAUSDT -> LISTAUSD, matching the dashboard's grouping."""
    name = (contract or "").upper()
    return name[:-1] if name.endswith("USDT") else name


GROUPS_SQL = """
SELECT contract,
       COALESCE(account, '')                            AS account,
       strategy,
       STRING_AGG(DISTINCT LOWER(exchange), ',')        AS exchanges,
       COUNT(*)::int                                    AS fills,
       COALESCE(SUM(rpnl), 0)::float                    AS rpnl,
       MIN(created_at)                                  AS first_at,
       MAX(created_at)                                  AS last_at
FROM fills
{where}
GROUP BY contract, COALESCE(account, ''), strategy
ORDER BY contract, account
"""

# Same venue, order and execution logged more than once.
EXACT_DUPES_SQL = """
SELECT contract, LOWER(exchange) AS exchange, order_id, side,
       quantity, price, created_at, COUNT(*)::int AS copies
FROM fills
{where}
GROUP BY contract, LOWER(exchange), order_id, side, quantity, price, created_at
HAVING COUNT(*) > 1
ORDER BY copies DESC
LIMIT 25
"""


async def show_schema(conn: asyncpg.Connection) -> None:
    cols = await conn.fetch(
        """
        SELECT column_name, data_type, is_nullable, character_maximum_length
        FROM information_schema.columns
        WHERE table_name = 'fills'
        ORDER BY ordinal_position
        """
    )
    if not cols:
        print("no 'fills' table found")
        return
    print(f"\nfills columns ({len(cols)}):")
    for c in cols:
        width = f"({c['character_maximum_length']})" if c["character_maximum_length"] else ""
        null = "" if c["is_nullable"] == "YES" else " NOT NULL"
        print(f"  {c['column_name']:<16} {c['data_type']}{width}{null}")

    names = {c["column_name"] for c in cols}
    for col in ("account", "strategy", "exchange"):
        if col not in names:
            print(f"\n!! the dashboard expects a '{col}' column and it is missing")
            continue
        vals = await conn.fetch(
            f"SELECT {col}::text AS v, COUNT(*)::int AS n FROM fills "
            f"GROUP BY {col}::text ORDER BY n DESC LIMIT 12"
        )
        print(f"\ndistinct {col}:")
        for v in vals:
            print(f"  {str(v['v']):<28} {v['n']} fills")

    sample = await conn.fetchrow("SELECT * FROM fills ORDER BY id DESC LIMIT 1")
    if sample:
        print("\nmost recent row:")
        for k, v in dict(sample).items():
            print(f"  {k:<16} {v!r}")


def _where(contract: str | None, strategy: str | None) -> tuple[str, list]:
    clauses, args = [], []
    if contract:
        args.append([contract.upper(), canon_contract(contract), f"{canon_contract(contract)}T"])
        clauses.append(f"UPPER(contract) = ANY(${len(args)}::text[])")
    if strategy:
        args.append(strategy)
        clauses.append(f"strategy = ${len(args)}")
    return ("WHERE " + " AND ".join(clauses)) if clauses else "", args


async def report(conn: asyncpg.Connection, contract: str | None, strategy: str | None) -> None:
    where, args = _where(contract, strategy)
    rows = await conn.fetch(GROUPS_SQL.format(where=where), *args)
    if not rows:
        print("no fills matched")
        return

    print(f"\n{'contract':<14} {'account':<14} {'strategy':<8} "
          f"{'exchanges':<18} {'fills':>7} {'rpnl':>12}  window")
    print("-" * 118)
    by_label: dict[tuple[str, str, str], list] = {}
    for r in rows:
        label = (canon_contract(r["contract"]), r["account"], r["strategy"])
        by_label.setdefault(label, []).append(r)
        print(
            f"{r['contract']:<14} {r['account'] or '-':<14} "
            f"{r['strategy']:<8} {r['exchanges'] or '-':<18} {r['fills']:>7} "
            f"{r['rpnl']:>12.4f}  {r['first_at']:%Y-%m-%d %H:%M} -> {r['last_at']:%Y-%m-%d %H:%M}"
        )

    clashes = {k: v for k, v in by_label.items() if len(v) > 1}
    if clashes:
        print("\nDuplicate pills — same contract + account, different rows:")
        for (contract_name, name, strat), group in clashes.items():
            print(f"\n  {contract_name} · {name or '(no account)'} · {strat}")
            for r in group:
                print(
                    f"    account={r['account'] or '(empty)':<14} fills={r['fills']:<7} "
                    f"rpnl={r['rpnl']:<14.4f} last={r['last_at']:%Y-%m-%d %H:%M}"
                )
            print("    delete one with:")
            for r in group:
                print(
                    f"      python -m scripts.fills_audit --delete --contract {r['contract']} "
                    f"--account '{r['account']}' --strategy {r['strategy']} --yes"
                )
    else:
        print("\nNo duplicate contract+account pills.")

    dupes = await conn.fetch(EXACT_DUPES_SQL.format(where=where), *args)
    if dupes:
        total = sum(r["copies"] - 1 for r in dupes)
        print(f"\nRe-ingested fills (identical venue/order/time), {total}+ extra rows:")
        for r in dupes:
            print(
                f"  {r['contract']:<12} {r['exchange']:<9} order={r['order_id']:<22} "
                f"{r['side']:<5} qty={r['quantity']} px={r['price']} "
                f"{r['created_at']:%Y-%m-%d %H:%M:%S} x{r['copies']}"
            )
        print("  remove the extra copies with: --dedupe-exact --yes")
    else:
        print("No re-ingested duplicate fills.")


async def delete_group(
    conn: asyncpg.Connection, contract: str, account: str, strategy: str | None, yes: bool,
) -> None:
    args: list = [contract.upper()]
    sql = "FROM fills WHERE UPPER(contract) = $1"
    if account:
        args.append(account)
        sql += f" AND account = ${len(args)}"
    else:
        sql += " AND (account IS NULL OR account = '')"
    if strategy:
        args.append(strategy)
        sql += f" AND strategy = ${len(args)}"

    row = await conn.fetchrow(
        f"SELECT COUNT(*)::int AS n, COALESCE(SUM(rpnl), 0)::float AS rpnl {sql}", *args
    )
    n = row["n"]
    print(
        f"{contract.upper()} account={account or '(empty)'} strategy={strategy or 'any'}"
        f" -> {n} fills, rpnl={row['rpnl']:.4f}"
    )
    if not n:
        print("nothing to delete")
        return
    if not yes:
        print("dry run — re-run with --yes to delete")
        return
    deleted = await conn.execute(f"DELETE {sql}", *args)
    print(f"deleted: {deleted}")


async def dedupe_exact(
    conn: asyncpg.Connection, contract: str | None, strategy: str | None, yes: bool,
) -> None:
    where, args = _where(contract, strategy)
    sql = f"""
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (
               PARTITION BY contract, LOWER(exchange), order_id, side, quantity, price, created_at
               ORDER BY id
             ) AS rn
      FROM fills
      {where}
    )
    SELECT id FROM ranked WHERE rn > 1
    """
    extra = [r["id"] for r in await conn.fetch(sql, *args)]
    print(f"{len(extra)} duplicate row(s) beyond the first copy")
    if not extra:
        return
    if not yes:
        print("dry run — re-run with --yes to delete")
        return
    deleted = await conn.execute("DELETE FROM fills WHERE id = ANY($1::bigint[])", extra)
    print(f"deleted: {deleted}")


async def main() -> int:
    ap = argparse.ArgumentParser(description="Audit / clean the fills table")
    ap.add_argument("--contract", help="limit to one contract, e.g. LISTAUSD")
    ap.add_argument("--account", default="", help="account id for --delete ('' = the empty-account group)")
    ap.add_argument("--strategy", help="limit to one strategy tag, e.g. opa3")
    ap.add_argument("--schema", action="store_true", help="dump the fills columns and their values")
    ap.add_argument("--delete", action="store_true", help="delete one contract+account group")
    ap.add_argument("--dedupe-exact", action="store_true", help="drop re-ingested identical fills")
    ap.add_argument("--yes", action="store_true", help="actually write (otherwise dry run)")
    args = ap.parse_args()

    url = Settings.from_env().database_url
    if not url:
        print("DATABASE_URL is not set", file=sys.stderr)
        return 2

    conn = await asyncpg.connect(url)
    try:
        if args.schema:
            await show_schema(conn)
        elif args.delete:
            if not args.contract:
                print("--delete needs --contract", file=sys.stderr)
                return 2
            await delete_group(conn, args.contract, args.account, args.strategy, args.yes)
        elif args.dedupe_exact:
            await dedupe_exact(conn, args.contract, args.strategy, args.yes)
        else:
            await report(conn, args.contract, args.strategy)
    finally:
        await conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
