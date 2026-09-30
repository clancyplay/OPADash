"""Start OPA6 bots from OPADash.

Local: `python3 stack.py SYMBOL` in the sibling OPA6 tree (or OPA6_ROOT).
Railway: create a new service in this project from the OPA6 GitHub repo.
"""
from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path

from config.settings import load_env_file

_ROOT = Path(__file__).resolve().parent.parent
_STATE = _ROOT / "config" / "launches.json"
_LOCK = _ROOT / "config" / "launches.lock"
_BOT_ENV = _ROOT / "config" / "bots"

BOTS = {
    "belt": "belt.py",
    "chop": "chop.py",
    "clip": "clip.py",
    "edge": "edge.py",
    "fade": "fade.py",
    "flip": "flip.py",
    "lean": "lean.py",
    "momentum": "momentum.py",
    "pair": "pair.py",
    "plain": "plain.py",
    "stack": "stack.py",
    "surge": "surge.py",
    "touch": "touch.py",
}

VENUE_ENV = {
    "delta": ("DELTA_API_KEY", "DELTA_API_SECRET", "DELTA_SYMBOL", ""),
    "binance": ("BINANCE_API_KEY", "BINANCE_API_SECRET", "BINANCE_SYMBOL", ""),
    "bybit": ("BYBIT_API_KEY", "BYBIT_API_SECRET", "BYBIT_SYMBOL", ""),
    "kucoin": ("KUCOIN_API_KEY", "KUCOIN_API_SECRET", "KUCOIN_SYMBOL", "KUCOIN_API_PASSPHRASE"),
    "coinbase": ("COINBASE_API_KEY", "COINBASE_API_SECRET", "COINBASE_SYMBOL", ""),
    "aster": ("ASTER_API_KEY", "ASTER_API_SECRET", "ASTER_SYMBOL", ""),
}

_DENY = (
    "DATABASE_URL", "DASHBOARD_PASSWORD", "DASHBOARD_USERNAME", "DASHBOARD_SECRET",
    "PATH", "PYTHONPATH", "PYTHONHOME", "HOME", "USER",
)


def on_railway() -> bool:
    return bool(os.getenv("RAILWAY_ENVIRONMENT") or os.getenv("RAILWAY_PROJECT_ID"))


def launch_mode() -> str:
    """railway | railway-unconfigured | local | missing"""
    load_env_file()
    try:
        from webapp import railway as rw
        rail_ok = rw.ready()
    except Exception:
        rail_ok = False
    if on_railway():
        return "railway" if rail_ok else "railway-unconfigured"
    if _is_opa6_tree(opa6_root()):
        return "local"
    if rail_ok:
        return "railway"
    return "missing"


def _railway_missing_msg() -> str:
    return (
        "On Railway, New contract creates a new OPA6 service — it cannot spawn a local process. "
        "Set RAILWAY_TOKEN on this OPADash service (project token: railway.com/account/tokens) "
        "and OPA6_RAILWAY_SERVICE to an existing OPA6 bot's service name so the repo can be copied."
    )


def _is_opa6_tree(path: Path) -> bool:
    try:
        return path.is_dir() and (path / "stack.py").is_file()
    except OSError:
        return False


def opa6_root() -> Path:
    """Folder that contains stack.py. OPA6_ROOT wins if it exists; else sibling OPA6."""
    load_env_file()
    tried: list[Path] = []

    def add(raw: Path | str) -> None:
        p = Path(raw).expanduser()
        if not p.is_absolute():
            tried.append((_ROOT / p).resolve())
            tried.append((Path.cwd() / p).resolve())
        else:
            tried.append(p.resolve())

    env = (os.getenv("OPA6_ROOT") or os.getenv("opa6_root") or "").strip()
    if env:
        add(env)
    parent = _ROOT.parent
    for name in ("OPA6", "opa6"):
        add(parent / name)
        add(_ROOT / name)
    here = _ROOT
    for _ in range(4):
        here = here.parent
        add(here / "OPA6")
        add(here / "opa6")

    seen: set[Path] = set()
    ordered: list[Path] = []
    for p in tried:
        if p in seen:
            continue
        seen.add(p)
        ordered.append(p)
        if _is_opa6_tree(p):
            return p
    return ordered[0] if ordered else (parent / "OPA6").resolve()


def _python(root: Path) -> str:
    for cand in (
        root / ".venv" / "bin" / "python3",
        root / "venv" / "bin" / "python3",
        Path(sys.executable),
    ):
        if cand.is_file() and os.access(cand, os.X_OK):
            return str(cand)
    return "python3"


def _alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _load() -> list[dict]:
    if not _STATE.is_file():
        return []
    try:
        data = json.loads(_STATE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    rows = data.get("bots") if isinstance(data, dict) else data
    return [r for r in (rows or []) if isinstance(r, dict)]


def _save(rows: list[dict]) -> None:
    _STATE.parent.mkdir(parents=True, exist_ok=True)
    tmp = _STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps({"bots": rows}, indent=2), encoding="utf-8")
    tmp.replace(_STATE)


def list_bots(reap: bool = True) -> list[dict]:
    mode = launch_mode()
    if mode == "railway":
        from webapp import railway as rw
        return rw.list_bots()
    rows = _load()
    out = []
    changed = False
    for rec in rows:
        try:
            pid = int(rec.get("pid") or 0)
        except (TypeError, ValueError):
            pid = 0
        live = _alive(pid)
        if live != bool(rec.get("alive")):
            rec["alive"] = live
            changed = True
        if live or not reap:
            out.append(_public(rec))
        else:
            changed = True
    if reap and changed:
        keep = [r for r in rows if _alive(int(r.get("pid") or 0))]
        _save(keep)
        out = [_public(r) for r in keep]
    return out


def _norm_contract(value: str) -> str:
    return str(value or "").strip().upper().replace("-", "").replace("_", "")


def find_bot(
    *,
    bot_id: str = "",
    contract: str = "",
    account: str = "",
    strategy: str = "",
    aliases: list[str] | None = None,
    contracts: list[str] | None = None,
) -> dict | None:
    """Match a dash-started process / Railway service.

    The rPnL card knows the exchange account id. The Railway service is named
    with the configured account name. `aliases` bridges those.
    """
    rows = list_bots(reap=False)
    want_id = str(bot_id or "").strip()
    if want_id:
        for rec in rows:
            if str(rec.get("id") or "") == want_id:
                return rec
        return None
    wanted = []
    for raw in [contract, *(contracts or [])]:
        text = str(raw or "").strip()
        if text and text not in wanted:
            wanted.append(text)
    a = str(account or "").strip()
    s = str(strategy or "").strip().lower()
    if not wanted or not s:
        return None
    acct_aliases = {a} if a else set()
    for extra in aliases or []:
        text = str(extra or "").strip()
        if text:
            acct_aliases.add(text)
    try:
        from webapp.ops import account_names
        named = account_names()
        for tag in list(acct_aliases):
            if tag in named and named[tag]:
                acct_aliases.add(named[tag])
        for aid, nm in named.items():
            if a and a in (aid, nm):
                if aid:
                    acct_aliases.add(aid)
                if nm:
                    acct_aliases.add(nm)
    except Exception:
        pass
    names: set[str] = set()
    try:
        from webapp.railway import _svc_name
        for variant in wanted:
            for tag in acct_aliases:
                names.add(_svc_name(s, variant, tag))
                names.add(_svc_name(s, variant.upper(), tag))
    except Exception:
        pass
    norms = {_norm_contract(v) for v in wanted}

    def _contract_hit(rec: dict) -> bool:
        rc = str(rec.get("contract") or "")
        if rc and (rc in wanted or rc.upper() in {v.upper() for v in wanted} or _norm_contract(rc) in norms):
            return True
        svc = str(rec.get("service") or "")
        return bool(svc and svc in names)

    def _account_hit(rec: dict) -> bool:
        if not acct_aliases:
            return True
        ra = str(rec.get("account") or "")
        rn = str(rec.get("account_name") or "")
        return ra in acct_aliases or rn in acct_aliases or (not ra and not rn)

    same = [
        rec for rec in rows
        if str(rec.get("strategy") or "").lower() == s and _contract_hit(rec)
    ]
    if not same:
        return None
    exact = [rec for rec in same if _account_hit(rec)]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        return exact[0]
    if len(same) == 1:
        return same[0]
    return None


def _public(rec: dict) -> dict:
    return {
        "id": rec.get("id") or "",
        "pid": int(rec.get("pid") or 0),
        "alive": bool(rec.get("alive", _alive(int(rec.get("pid") or 0)))),
        "strategy": rec.get("strategy") or "",
        "venue": rec.get("venue") or "",
        "contract": rec.get("contract") or "",
        "account": rec.get("account") or "",
        "account_name": rec.get("account_name") or "",
        "started_at": int(rec.get("started_at") or 0),
        "log": rec.get("log") or "",
        "params": rec.get("params") if isinstance(rec.get("params"), dict) else {},
        "kind": rec.get("kind") or "local",
        "service": rec.get("service") or "",
        "status": rec.get("status") or "",
    }


def _same(rec: dict, venue: str, contract: str, account: str, strategy: str) -> bool:
    return (
        str(rec.get("venue") or "").lower() == venue
        and str(rec.get("contract") or "").upper() == contract.upper()
        and str(rec.get("account") or "") == str(account or "")
        and str(rec.get("strategy") or "").lower() == strategy
        and _alive(int(rec.get("pid") or 0))
    )


def _pin_geom(knobs: dict[str, str]) -> dict[str, str]:
    """Ticks win over %. Unused *_TICKS must be 0 so a parent .env cannot leak.

    Dash always sends *_MIN_TICKS / *_MAX_TICKS (0 if blank) so the bot
    uses the min/max contract: blank = book, same = lock, min only = floor.
    """
    if not any(k.startswith(("HEM_", "SPAN_", "STEP_", "TAIL_")) for k in knobs):
        return knobs

    def _auto_on(name: str) -> bool:
        return str(knobs.get(name) or "").strip().lower() in ("1", "true", "yes", "on")

    def _int0(name: str) -> int:
        raw = knobs.get(name)
        try:
            return int(float(raw)) if raw not in (None, "") else 0
        except (TypeError, ValueError):
            return 0

    for prefix in ("HEM", "SPAN", "STEP"):
        knobs.setdefault(f"{prefix}_MIN_TICKS", "0")
        knobs.setdefault(f"{prefix}_MAX_TICKS", "0")
        knobs.setdefault(f"{prefix}_MIN_PCT", "0")
        knobs.setdefault(f"{prefix}_MAX_PCT", "0")
        lo_t, hi_t = _int0(f"{prefix}_MIN_TICKS"), _int0(f"{prefix}_MAX_TICKS")
        if lo_t > 0 and hi_t > 0 and lo_t == hi_t:
            knobs[f"{prefix}_TICKS"] = str(lo_t)
            knobs[f"{prefix}_AUTO"] = "false"
        elif _auto_on(f"{prefix}_AUTO"):
            knobs[f"{prefix}_TICKS"] = "0"
    knobs.setdefault("TAIL_TICKS", knobs.get("STEP_TICKS") or "0")
    for ticks, alias in (("HEM_TICKS", None), ("SPAN_TICKS", None), ("STEP_TICKS", "TAIL_TICKS")):
        raw = knobs.get(ticks)
        try:
            n = int(float(raw)) if raw not in (None, "") else 0
        except (TypeError, ValueError):
            n = 0
        if n > 0:
            knobs[ticks] = str(n)
            if alias:
                knobs.pop(alias, None)
        else:
            knobs[ticks] = "0"
            if alias:
                knobs[alias] = "0"
    return knobs


def _pair_argv(contract: str) -> list[str]:
    """`C-BTC-…`, `C-…,P-…`, or `BTC 250926` → pair.py argv."""
    out = []
    for part in str(contract or "").replace(",", " ").split():
        tok = part.strip()
        if tok:
            out.append(tok.upper() if tok[:2].upper() in ("C-", "P-") else tok.upper() if tok.isalpha() else tok)
    if not out:
        raise ValueError("pair needs an option symbol or crop + expiry, e.g. C-BTC-120000-250926 or BTC 250926")
    joined = " ".join(out)
    if len(joined) > 96:
        raise ValueError("pair contract too long")
    return out


def _scrub_params(raw: dict | None) -> dict[str, str]:
    out: dict[str, str] = {}
    if not isinstance(raw, dict):
        return out
    for key, val in raw.items():
        name = str(key or "").strip().upper()
        if not name or name == "GEOM" or not name.replace("_", "").isalnum() or len(name) > 48:
            continue
        if name in _DENY or name.endswith("_API_KEY") or name.endswith("_API_SECRET") or name.endswith("_PASSPHRASE"):
            continue
        if "PASSWORD" in name or "SECRET" in name or "TOKEN" in name:
            continue
        if val is None:
            continue
        if isinstance(val, bool):
            text = "true" if val else "false"
        else:
            text = str(val).strip()
        if not text or len(text) > 200:
            continue
        out[name] = text
    return out


_DROP_KNOBS = frozenset({"MAX_USD", "MAX_POS", "GEOM"})

_KNOB_SETUP = (
    ("HEM_PCT", "hem", "float"),
    ("SPAN_PCT", "span", "float"),
    ("STEP_PCT", "step", "float"),
    ("TAIL_PCT", "step", "float"),
    ("K_PCT", "k", "float"),
    ("EDGE_PCT", "edge", "float"),
    ("HEM_TICKS", "hem_ticks", "int"),
    ("SPAN_TICKS", "span_ticks", "int"),
    ("STEP_TICKS", "step_ticks", "int"),
    ("K_TICKS", "k_ticks", "int"),
    ("HEM_MIN_PCT", "hem_min", "float"),
    ("HEM_MAX_PCT", "hem_max", "float"),
    ("SPAN_MIN_PCT", "span_min", "float"),
    ("SPAN_MAX_PCT", "span_max", "float"),
    ("STEP_MIN_PCT", "step_min", "float"),
    ("STEP_MAX_PCT", "step_max", "float"),
    ("HEM_MIN_TICKS", "hem_min_ticks", "int"),
    ("HEM_MAX_TICKS", "hem_max_ticks", "int"),
    ("SPAN_MIN_TICKS", "span_min_ticks", "int"),
    ("SPAN_MAX_TICKS", "span_max_ticks", "int"),
    ("STEP_MIN_TICKS", "step_min_ticks", "int"),
    ("STEP_MAX_TICKS", "step_max_ticks", "int"),
    ("ORDERS", "orders", "int"),
    ("TAILS", "tails", "int"),
    ("TOUCH_TICKS", "touch_ticks", "int"),
    ("BID_TICKS", "bid_ticks", "int"),
    ("ASK_TICKS", "ask_ticks", "int"),
    ("FATE_USD", "fate", "float"),
    ("GRIND_USD", "grind", "float"),
    ("QUOTE_MS", "quote_ms", "int"),
    ("PLACE_SECS", "place_secs", "float"),
    ("IGNORE_MIN_SIZE", "ignore", "float"),
    ("PAIR_HEDGE_LOT", "hedge_lot", "int"),
    ("MOVE_PCT", "move_pct", "float"),
    ("MOVE_SECS", "move_secs", "float"),
    ("RISK_REWARD", "risk_reward", "float"),
    ("MOM_PCT", "mom_pct", "float"),
    ("MOM_SLOW_PCT", "mom_slow_pct", "float"),
    ("CLIP_PCT", "clip_pct", "float"),
    ("TRAIL_PCT", "trail_pct", "float"),
    ("MOM_STOP_PCT", "mom_stop_pct", "float"),
    ("HEM_AUTO", "hem_auto", "bool"),
    ("SPAN_AUTO", "span_auto", "bool"),
    ("STEP_AUTO", "step_auto", "bool"),
    ("VOL_GATE", "vol_gate", "bool"),
    ("DRY_RUN", "dry_run", "bool"),
    ("PAIR_HEDGE", "pair_hedge", "bool"),
    ("FLIP", "flip", "bool"),
    ("HOOK", "hook", "str"),
    ("STEP_MULT", "step_mult", "str"),
    ("EDGE_VENUE", "edge_venue", "str"),
)


def _dash_slug(text: str) -> str:
    safe = re.sub(r"[^a-zA-Z0-9._-]+", "-", str(text or "").strip())
    return safe.strip("-.")[:48]


def _knobs_from_payload(params: dict | None, strategy: str = "") -> dict[str, str]:
    raw: dict = {}
    if isinstance(params, dict):
        raw = dict(params)
    upper = {str(k).upper(): v for k, v in raw.items()}
    if upper.get("MAX_POSITION") in (None, "") and upper.get("MAX_USD") not in (None, ""):
        raw["MAX_POSITION"] = upper["MAX_USD"]
        raw.setdefault("MAX_IN_USD", True)
    elif upper.get("MAX_POSITION") in (None, "") and upper.get("MAX_POS") not in (None, ""):
        raw["MAX_POSITION"] = upper["MAX_POS"]
        raw.setdefault("MAX_IN_USD", False)
    knobs = _pin_geom(_scrub_params(raw))
    for name in _DROP_KNOBS:
        knobs.pop(name, None)
    if str(strategy or "").strip().lower() == "pair" and knobs.get("MAX_POSITION"):
        knobs.setdefault("PAIR_MAX", knobs["MAX_POSITION"])
    return knobs


def knobs_as_setup(knobs: dict[str, str] | None) -> dict:
    raw = knobs if isinstance(knobs, dict) else {}
    out: dict = {}

    def _bool(val) -> bool:
        return str(val or "").strip().lower() in ("1", "true", "yes", "on")

    def _num(val, kind: str):
        try:
            n = float(val)
        except (TypeError, ValueError):
            return None
        return int(n) if kind == "int" else n

    for env_name, setup_key, kind in _KNOB_SETUP:
        if env_name not in raw or setup_key in out:
            continue
        val = raw.get(env_name)
        if kind == "bool":
            out[setup_key] = _bool(val)
        elif kind == "str":
            text = str(val or "").strip()
            if text:
                out[setup_key] = text
        else:
            n = _num(val, kind)
            if n is not None:
                out[setup_key] = n
    max_v = raw.get("MAX_POSITION")
    if max_v not in (None, ""):
        n = _num(max_v, "float")
        if n is not None:
            if _bool(raw.get("MAX_IN_USD", "true")):
                out["max_usd"] = n
            else:
                out["max_pos"] = n
    return out


def _overlay_name(strategy: str, venue: str, contract: str, account: str = "") -> str:
    sy = _dash_slug(str(strategy or "").strip().lower())
    ve = _dash_slug(str(venue or "").strip().lower())
    ct = _dash_slug(str(contract or "").strip().upper())
    ac = _dash_slug(str(account or "").strip())
    parts = [p for p in (sy, ve, ct, ac) if p]
    return ".".join(parts) + ".env" if parts else ""


def _overlay_names(strategy: str, venue: str, contract: str, accounts: list[str]) -> list[str]:
    names: list[str] = []
    seen: set[str] = set()
    tags = [a for a in accounts if str(a or "").strip()] or [""]
    for acct in tags:
        for cand in (
            _overlay_name(strategy, venue, contract, acct),
            _overlay_name(strategy, venue, contract, ""),
            _overlay_name(strategy, "", contract, ""),
        ):
            if cand and cand not in seen:
                seen.add(cand)
                names.append(cand)
    return names


def _account_aliases(account: str, account_name: str = "") -> list[str]:
    tags: list[str] = []
    for raw in (account, account_name):
        text = str(raw or "").strip()
        if text and text not in tags:
            tags.append(text)
    try:
        from webapp.ops import account_names
        named = account_names()
    except Exception:
        named = {}
    for tag in list(tags):
        mapped = named.get(tag)
        if mapped and mapped not in tags:
            tags.append(mapped)
    for aid, nm in named.items():
        if tags and (aid in tags or nm in tags):
            if aid and aid not in tags:
                tags.append(aid)
            if nm and nm not in tags:
                tags.append(nm)
    return tags


def _format_env(knobs: dict[str, str], header: str) -> str:
    lines = [f"# {header}", f"# updated {time.strftime('%Y-%m-%d %H:%M:%S')}"]
    for name in sorted(knobs):
        val = str(knobs[name])
        if any(ch in val for ch in ' \t#"\''):
            val = json.dumps(val, ensure_ascii=False)
        lines.append(f"{name}={val}")
    return "\n".join(lines) + "\n"


def _parse_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return out
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name = name.strip().upper()
        value = value.strip()
        if value[:1] in ('"', "'") and value[-1:] == value[:1] and len(value) >= 2:
            value = value[1:-1]
        if name and name not in _DROP_KNOBS:
            out[name] = value
    return out


def _write_env_file(path: Path, knobs: dict[str, str], header: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(_format_env(knobs, header), encoding="utf-8")
    tmp.replace(path)


def _overlay_dirs() -> list[Path]:
    dirs = [_BOT_ENV]
    try:
        root = opa6_root()
        if _is_opa6_tree(root):
            dirs.append(root / "env.d")
    except Exception:
        pass
    return dirs


def _write_overlays(
    strategy: str,
    venue: str,
    contract: str,
    account: str,
    knobs: dict[str, str],
) -> list[str]:
    if not knobs:
        return []
    header = f"dash {strategy} {venue}:{contract} account={account}".strip()
    names = []
    specific = _overlay_name(strategy, venue, contract, account)
    loose = _overlay_name(strategy, venue, contract, "")
    if specific:
        names.append(specific)
    if loose and loose != specific:
        names.append(loose)
    written: list[str] = []
    for folder in _overlay_dirs():
        for name in names:
            path = folder / name
            _write_env_file(path, knobs, header)
            written.append(str(path))
    return written


def _read_overlay(
    strategy: str,
    venue: str,
    contract: str,
    account: str = "",
    account_name: str = "",
) -> tuple[dict[str, str], str]:
    names = _overlay_names(strategy, venue, contract, _account_aliases(account, account_name))
    for folder in _overlay_dirs():
        for name in names:
            path = folder / name
            if not path.is_file():
                continue
            knobs = _parse_env_file(path)
            if knobs:
                return knobs, str(path)
    sy = _dash_slug(str(strategy or "").strip().lower())
    ct = _dash_slug(str(contract or "").strip().upper())
    if sy and ct:
        rx = re.compile(rf"^{re.escape(sy)}\.[^.]+\.{re.escape(ct)}(?:\.[^.]+)?\.env$", re.I)
        hits: list[Path] = []
        for folder in _overlay_dirs():
            if not folder.is_dir():
                continue
            hits.extend(p for p in folder.iterdir() if p.is_file() and rx.match(p.name))
        hits.sort(key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True)
        for path in hits:
            knobs = _parse_env_file(path)
            if knobs:
                return knobs, str(path)
    return {}, ""


def _guess_venue(strategy: str, contract: str, account: str = "") -> str:
    knobs, path = _read_overlay(strategy, "", contract, account)
    if not path:
        return ""
    name = Path(path).name
    if name.endswith(".env"):
        name = name[:-4]
    parts = name.split(".")
    if len(parts) >= 3:
        return str(parts[1] or "").lower()
    return ""


def _merge_rec_params(bot_id: str, knobs: dict[str, str]) -> None:
    want = str(bot_id or "").strip()
    if not want or not knobs:
        return
    rows = _load()
    changed = False
    for rec in rows:
        if str(rec.get("id") or "") != want:
            continue
        old = rec.get("params") if isinstance(rec.get("params"), dict) else {}
        rec["params"] = {**{str(k): str(v) for k, v in old.items()}, **knobs}
        changed = True
        break
    if changed:
        _save(rows)


def persist_knobs(
    *,
    venue: str = "",
    contract: str = "",
    account: str = "",
    account_name: str = "",
    strategy: str = "",
    params: dict | None = None,
    merge: bool = True,
    bot_id: str = "",
) -> dict:
    """Write Apply/Start knobs to this contract's env so a restart keeps them."""
    strategy = str(strategy or "").strip().lower()
    venue = str(venue or "").strip().lower()
    contract = str(contract or "").strip()
    account = str(account or "").strip()
    account_name = str(account_name or "").strip()
    rec = find_bot(
        bot_id=bot_id,
        contract=contract,
        account=account,
        strategy=strategy,
        aliases=_account_aliases(account, account_name),
    )
    if rec:
        strategy = strategy or str(rec.get("strategy") or "").lower()
        contract = contract or str(rec.get("contract") or "")
        venue = venue or str(rec.get("venue") or "").lower()
        account = account or str(rec.get("account") or "")
        account_name = account_name or str(rec.get("account_name") or "")
    if not venue:
        venue = _guess_venue(strategy, contract, account or account_name)
    incoming = _knobs_from_payload(params, strategy)
    if not incoming:
        return {"ok": False, "error": "no knobs to save"}
    existing, prev = _read_overlay(strategy, venue, contract, account, account_name) if merge else ({}, "")
    knobs = {**existing, **incoming} if merge else incoming
    files = _write_overlays(strategy, venue, contract, account or account_name, knobs)
    if rec and str(rec.get("kind") or "") != "railway":
        _merge_rec_params(str(rec.get("id") or ""), knobs)
    rail_err = ""
    railway = False
    if rec and (str(rec.get("kind") or "") == "railway" or rec.get("service")):
        try:
            from webapp import railway as rw
            rw.update_knobs(str(rec.get("id") or ""), knobs)
            railway = True
        except Exception as extra:
            rail_err = str(extra)[:240]
    ok = (bool(files) or railway) and not rail_err
    return {
        "ok": ok,
        "files": files,
        "file": files[0] if files else prev,
        "railway": railway,
        "error": rail_err,
        "knobs": knobs,
        "setup": knobs_as_setup(knobs),
    }


def read_knobs(
    *,
    venue: str = "",
    contract: str = "",
    account: str = "",
    account_name: str = "",
    strategy: str = "",
) -> dict:
    knobs, path = _read_overlay(strategy, venue, contract, account, account_name)
    return {
        "ok": True,
        "file": path,
        "knobs": knobs,
        "setup": knobs_as_setup(knobs) if knobs else {},
    }


def launch(
    *,
    venue: str,
    contract: str,
    strategy: str,
    account: dict,
    params: dict | None = None,
) -> dict:
    venue = str(venue or "").strip().lower()
    strategy = str(strategy or "").strip().lower()
    contract = str(contract or "").strip()
    script = BOTS.get(strategy)
    if not script:
        raise ValueError(f"unknown strategy '{strategy}'")
    if venue not in VENUE_ENV:
        raise ValueError(f"unsupported venue '{venue}'")
    if strategy == "pair" and venue != "delta":
        raise ValueError("pair quotes Delta options")
    argv_tail = _pair_argv(contract) if strategy == "pair" else [contract]
    if strategy != "pair" and (not contract or len(contract) > 40):
        raise ValueError("contract required")
    if not argv_tail:
        raise ValueError("contract required")
    keys = VENUE_ENV[venue]
    if not (account.get("api_key") and account.get("api_secret")):
        raise ValueError("account has no API keys")
    if venue == "kucoin" and not (account.get("passphrase") or os.getenv("KUCOIN_API_PASSPHRASE")):
        raise ValueError("KuCoin needs an API passphrase on the account")

    mode = launch_mode()
    if mode == "railway":
        from webapp import railway as rw
        return rw.launch(
            venue=venue, contract=contract, strategy=strategy, account=account, params=params,
        )
    if mode == "railway-unconfigured":
        raise ValueError(_railway_missing_msg())
    if mode == "missing":
        root = opa6_root()
        raise FileNotFoundError(
            f"OPA6 folder missing: {root} (set OPA6_ROOT to the folder that contains stack.py)"
        )

    root = opa6_root()
    path = root / script
    if not path.is_file():
        raise FileNotFoundError(f"OPA6 bot missing: {path}")

    acct_id = str(account.get("id") or account.get("name") or "").strip()
    rows = _load()
    for rec in rows:
        if _same(rec, venue, contract, acct_id, strategy):
            raise ValueError(f"{strategy} {venue}:{contract} already running (pid {rec.get('pid')})")

    knobs = _pin_geom(_scrub_params(params))
    if strategy == "pair":
        if knobs.get("MAX_POSITION"):
            knobs.setdefault("PAIR_MAX", knobs["MAX_POSITION"])
        knobs.setdefault("PAIR_HEDGE", "true")
    env = os.environ.copy()
    env["QUOTE_VENUE"] = venue
    env["STRATEGY"] = strategy
    env["PYTHONUNBUFFERED"] = "1"
    env[keys[0]] = account["api_key"]
    env[keys[1]] = account["api_secret"]
    env[keys[2]] = argv_tail[0] if strategy == "pair" else contract
    extra_pw = keys[3]
    if extra_pw:
        phrase = account.get("passphrase") or env.get(extra_pw) or ""
        if phrase:
            env[extra_pw] = phrase
    for name, val in knobs.items():
        env[name] = val
    if acct_id:
        env["DASH_ACCOUNT"] = acct_id
    if strategy == "pair":
        env["PAIR_SYMBOL"] = ",".join(t for t in argv_tail if t[:2] in ("C-", "P-")) or env.get("PAIR_SYMBOL", "")
    try:
        _write_overlays(strategy, venue, contract, acct_id, knobs)
    except Exception:
        pass

    logs = root / "logs"
    logs.mkdir(exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    safe = "".join(ch for ch in contract.upper() if ch.isalnum() or ch in "-_")[:24]
    log_path = logs / f"dash_{strategy}_{safe}_{stamp}.log"
    log_fh = open(log_path, "a", encoding="utf-8")
    log_fh.write(f"# dash launch {strategy} {venue}:{contract} account={acct_id}\n")
    log_fh.flush()

    py = _python(root)
    proc = subprocess.Popen(
        [py, str(path), *argv_tail],
        cwd=str(root),
        env=env,
        stdout=log_fh,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
        close_fds=True,
    )
    rec = {
        "id": uuid.uuid4().hex[:12],
        "pid": proc.pid,
        "alive": True,
        "strategy": strategy,
        "venue": venue,
        "contract": contract,
        "account": acct_id,
        "account_name": account.get("name") or acct_id,
        "started_at": int(time.time()),
        "log": str(log_path),
        "params": knobs,
    }
    rows.append(rec)
    _save(rows)
    return _public(rec)


def stop(bot_id: str) -> dict:
    want = str(bot_id or "").strip()
    if not want:
        raise ValueError("id required")
    if launch_mode() == "railway":
        from webapp import railway as rw
        return rw.stop(want)
    rows = _load()
    hit = None
    keep = []
    for rec in rows:
        if str(rec.get("id") or "") == want:
            hit = rec
        else:
            keep.append(rec)
    if hit is None:
        raise KeyError("bot not found")
    pid = int(hit.get("pid") or 0)
    if pid > 0 and _alive(pid):
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        except PermissionError as exc:
            raise RuntimeError(f"cannot signal pid {pid}: {exc}") from exc
        deadline = time.time() + 12
        while time.time() < deadline and _alive(pid):
            time.sleep(0.15)
        if _alive(pid):
            try:
                os.killpg(pid, signal.SIGKILL)
            except OSError:
                pass
    _save(keep)
    hit["alive"] = False
    return _public(hit)
