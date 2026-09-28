"""Spawn / track OPA6 strategy processes from OPADash.

Dash does not trade. It starts `python3 stack.py SYMBOL` (etc.) in the sibling
OPA6 tree with the selected subaccount keys and env knobs.
"""
from __future__ import annotations

import json
import os
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

BOTS = {
    "belt": "belt.py",
    "chop": "chop.py",
    "clip": "clip.py",
    "edge": "edge.py",
    "fade": "fade.py",
    "flip": "flip.py",
    "lean": "lean.py",
    "momentum": "momentum.py",
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


def opa6_root() -> Path:
    load_env_file()
    raw = (os.getenv("OPA6_ROOT") or "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return (_ROOT.parent / "OPA6").resolve()


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
    """Ticks win over %. Unused *_TICKS must be 0 so a parent .env cannot leak."""
    if not any(k.startswith(("HEM_", "SPAN_", "STEP_", "TAIL_")) for k in knobs):
        return knobs
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
    if not contract or len(contract) > 40:
        raise ValueError("contract required")
    keys = VENUE_ENV[venue]
    if not (account.get("api_key") and account.get("api_secret")):
        raise ValueError("account has no API keys")
    if venue == "kucoin" and not (account.get("passphrase") or os.getenv("KUCOIN_API_PASSPHRASE")):
        raise ValueError("KuCoin needs an API passphrase on the account")

    root = opa6_root()
    if not root.is_dir():
        raise FileNotFoundError(f"OPA6 folder missing: {root} (set OPA6_ROOT)")
    path = root / script
    if not path.is_file():
        raise FileNotFoundError(f"OPA6 bot missing: {path}")

    acct_id = str(account.get("id") or account.get("name") or "").strip()
    rows = _load()
    for rec in rows:
        if _same(rec, venue, contract, acct_id, strategy):
            raise ValueError(f"{strategy} {venue}:{contract} already running (pid {rec.get('pid')})")

    knobs = _pin_geom(_scrub_params(params))
    env = os.environ.copy()
    env["QUOTE_VENUE"] = venue
    env["STRATEGY"] = strategy
    env["PYTHONUNBUFFERED"] = "1"
    env[keys[0]] = account["api_key"]
    env[keys[1]] = account["api_secret"]
    env[keys[2]] = contract
    extra_pw = keys[3]
    if extra_pw:
        phrase = account.get("passphrase") or env.get(extra_pw) or ""
        if phrase:
            env[extra_pw] = phrase
    for name, val in knobs.items():
        env[name] = val

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
        [py, str(path), contract],
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
        deadline = time.time() + 4
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
