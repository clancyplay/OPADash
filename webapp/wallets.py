"""Live exchange wallets for the Balances page — one API key per subaccount.

Not derived from fills. Configure keys via:
  config/accounts.json
  BALANCE_ACCOUNTS_FILE=/path/to/accounts.json
  BALANCE_ACCOUNTS='[{...}]'
  BAL_1_EXCHANGE=delta  BAL_1_NAME=ARB  BAL_1_ID=123  BAL_1_KEY=...  BAL_1_SECRET=...
  (repeat BAL_2_*, BAL_3_*, …)
KuCoin also needs BAL_N_PASSPHRASE. Optional BAL_N_ASSET / BAL_N_STRATEGY.
Coinbase uses a CDP key from portal.cdp.coinbase.com:
  BAL_N_KEY=organizations/.../apiKeys/...
  BAL_N_SECRET=<private key, PEM or base64>
No passphrase. That key covers Advanced Trade spot and INTX perps.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import hmac
import json
import logging
import os
import secrets
import time
from pathlib import Path
from urllib.parse import urlencode

import httpx

from config.settings import load_env_file

logger = logging.getLogger("webapp.wallets")

_LABELS = {
    "delta": "Delta",
    "binance": "Binance",
    "kucoin": "KuCoin",
    "coindcx": "CoinDCX",
    "aster": "Aster",
    "bybit": "Bybit",
    "coinbase": "Coinbase",
}
_SUPPORTED = {"delta", "binance", "coindcx", "kucoin", "bybit", "coinbase"}
_ROOT = Path(__file__).resolve().parent.parent


def _clean(v) -> str:
    s = str(v or "").strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in ('"', "'"):
        s = s[1:-1].strip()
    return s


def _num(v, default: float = 0.0) -> float:
    try:
        if v in (None, ""):
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def _fingerprint(key: str) -> str:
    raw = (key or "").encode()
    return hashlib.sha256(raw).hexdigest()[:12] if raw else ""


def load_wallet_accounts() -> list[dict]:
    """All configured subaccount keys. Secrets stay on the object; never log them."""
    load_env_file()
    rows: list[dict] = []
    seen: set[str] = set()

    def add(item: dict) -> None:
        exch = _clean(item.get("exchange") or item.get("venue")).lower()
        key = _clean(item.get("api_key") or item.get("key"))
        secret = _clean(item.get("api_secret") or item.get("secret"))
        if exch not in _LABELS or not key or not secret:
            return
        fp = f"{exch}:{_fingerprint(key)}"
        if fp in seen:
            return
        seen.add(fp)
        role = _clean(item.get("role")).lower()
        parent = item.get("parent") is True or role == "parent" or str(item.get("parent") or "").lower() in ("1", "true", "yes", "on")
        aliases: list[str] = []
        raw_aliases = item.get("aliases") or item.get("aka") or item.get("old_names")
        if isinstance(raw_aliases, str):
            raw_aliases = [p.strip() for p in raw_aliases.split(",")]
        if isinstance(raw_aliases, (list, tuple)):
            for bit in raw_aliases:
                text = _clean(bit)
                if text and text not in aliases:
                    aliases.append(text)
        rows.append({
            "exchange": exch,
            "id": _clean(item.get("id") or item.get("account") or item.get("uid")),
            "name": _clean(item.get("name") or item.get("account_name") or item.get("label")),
            "aliases": aliases,
            "api_key": key,
            "api_secret": secret,
            "passphrase": _clean(item.get("passphrase") or item.get("api_passphrase")),
            "asset": _clean(item.get("asset")).upper(),
            "strategy": _clean(item.get("strategy")),
            "parent": parent,
        })

    raw = _clean(os.getenv("BALANCE_ACCOUNTS"))
    if raw:
        try:
            data = json.loads(raw)
            if isinstance(data, list):
                for rec in data:
                    if isinstance(rec, dict):
                        add(rec)
        except json.JSONDecodeError:
            logger.warning("wallets: BALANCE_ACCOUNTS is not valid JSON")

    paths = []
    extra = _clean(os.getenv("BALANCE_ACCOUNTS_FILE"))
    if extra:
        paths.append(Path(extra).expanduser())
    paths.append(_ROOT / "config" / "accounts.json")
    for path in paths:
        if not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("wallets: cannot read %s (%s)", path, exc)
            continue
        if isinstance(data, dict):
            data = data.get("accounts") or data.get("wallets") or []
        if isinstance(data, list):
            for rec in data:
                if isinstance(rec, dict):
                    add(rec)

    for i in range(1, 80):
        p = f"BAL_{i}_"
        exch = _clean(os.getenv(p + "EXCHANGE") or os.getenv(p + "VENUE"))
        key = _clean(os.getenv(p + "KEY") or os.getenv(p + "API_KEY"))
        secret = _clean(os.getenv(p + "SECRET") or os.getenv(p + "API_SECRET"))
        if not exch and not key:
            continue
        add({
            "exchange": exch,
            "id": os.getenv(p + "ID") or os.getenv(p + "ACCOUNT") or os.getenv(p + "UID"),
            "name": os.getenv(p + "NAME") or os.getenv(p + "LABEL"),
            "aliases": os.getenv(p + "ALIASES") or os.getenv(p + "AKA"),
            "api_key": key,
            "api_secret": secret,
            "passphrase": os.getenv(p + "PASSPHRASE") or os.getenv(p + "API_PASSPHRASE"),
            "asset": os.getenv(p + "ASSET"),
            "strategy": os.getenv(p + "STRATEGY"),
            "parent": os.getenv(p + "PARENT"),
            "role": os.getenv(p + "ROLE"),
        })

    # Single leftover keys from .env when nobody listed numbered accounts.
    if not rows:
        fallbacks = [
            ("delta", "DELTA_API_KEY", "DELTA_API_SECRET", os.getenv("ACCOUNT") or os.getenv("DELTA_ACCOUNT"), "DELTA_WALLET_ASSET"),
            ("binance", "BINANCE_API_KEY", "BINANCE_API_SECRET", os.getenv("BINANCE_ACCOUNT"), "BINANCE_WALLET_ASSET"),
            ("coindcx", "COINDCX_API_KEY", "COINDCX_API_SECRET", os.getenv("COINDCX_ACCOUNT"), ""),
            ("kucoin", "KUCOIN_API_KEY", "KUCOIN_API_SECRET", os.getenv("KUCOIN_ACCOUNT"), "KUCOIN_WALLET_ASSET"),
            ("bybit", "BYBIT_API_KEY", "BYBIT_API_SECRET", os.getenv("BYBIT_ACCOUNT"), "BYBIT_WALLET_ASSET"),
            ("coinbase", "COINBASE_API_KEY", "COINBASE_API_SECRET", os.getenv("COINBASE_ACCOUNT"), "COINBASE_WALLET_ASSET"),
        ]
        for exch, k_env, s_env, name, asset_env in fallbacks:
            rec = {
                "exchange": exch,
                "name": name,
                "api_key": os.getenv(k_env),
                "api_secret": os.getenv(s_env),
                "asset": os.getenv(asset_env) if asset_env else "",
            }
            if exch == "kucoin":
                rec["passphrase"] = os.getenv("KUCOIN_API_PASSPHRASE")
            add(rec)

    # Bybit/Coinbase wallet fetchers echo back the configured id as their uid
    # (no real exchange uid available) — same id on two exchanges silently
    # merges two unrelated accounts into one Balances row.
    by_id: dict[str, set[str]] = {}
    for r in rows:
        if r["id"]:
            by_id.setdefault(r["id"], set()).add(r["exchange"])
    for aid, exs in by_id.items():
        if len(exs) > 1:
            logger.warning(
                "wallets: id %r reused across exchanges %s — their balances will merge "
                "into one Balances row; give each real account its own BAL_n_ID",
                aid, sorted(exs),
            )
    return rows


def _delta_headers(method: str, path: str, payload: str, key: str, secret: str) -> dict:
    ts = str(int(time.time()))
    sig = hmac.new(secret.encode(), f"{method}{ts}{path}{payload}".encode(), hashlib.sha256).hexdigest()
    return {
        "api-key": key,
        "timestamp": ts,
        "signature": sig,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


async def _delta_wallet(client: httpx.AsyncClient, acct: dict, rate: float) -> dict:
    path = "/v2/wallet/balances"
    base = os.getenv("DELTA_REST_URL", "https://api.india.delta.exchange").rstrip("/")
    want = (acct.get("asset") or os.getenv("DELTA_WALLET_ASSET", "USD") or "USD").upper()
    headers = _delta_headers("GET", path, "", acct["api_key"], acct["api_secret"])
    r = await client.get(base + path, headers=headers)
    if r.status_code == 401:
        headers = _delta_headers("GET", path, "", acct["api_key"], acct["api_secret"])
        r = await client.get(base + path, headers=headers)
    data = r.json() if r.content else {}
    if r.status_code >= 400:
        err = ((data.get("error") or {}) if isinstance(data, dict) else {}) or {}
        raise RuntimeError(err.get("code") or err.get("message") or r.text[:180] or f"HTTP {r.status_code}")
    uid = acct.get("id") or ""
    pick = None
    for entry in (data.get("result") if isinstance(data, dict) else None) or []:
        if not isinstance(entry, dict):
            continue
        if not uid:
            uid = str(entry.get("user_id") or "")
        if str(entry.get("asset_symbol") or "").upper() == want:
            pick = entry
            break
    if pick is None:
        rows = (data.get("result") if isinstance(data, dict) else None) or []
        pick = rows[0] if rows else {}
    inr = pick.get("balance_inr") if isinstance(pick, dict) else None
    native = _num((pick or {}).get("balance"))
    balance = _num(inr) if inr is not None else native * rate
    return {
        "balance": balance,
        "native": native,
        "asset": str((pick or {}).get("asset_symbol") or want).upper(),
        "uid": str(uid or ""),
        "available": _num((pick or {}).get("available_balance")),
        "portfolio_margin": _num((pick or {}).get("portfolio_margin")),
        "position_margin": _num((pick or {}).get("position_margin")),
    }


async def _binance_wallet(client: httpx.AsyncClient, acct: dict, rate: float) -> dict:
    base = os.getenv("BINANCE_REST_URL", "https://fapi.binance.com").rstrip("/")
    want = (acct.get("asset") or os.getenv("BINANCE_WALLET_ASSET", "USDT") or "USDT").upper()
    try:
        t = await client.get(base + "/fapi/v1/time")
        ts = int(t.json().get("serverTime") or time.time() * 1000)
    except Exception:
        ts = int(time.time() * 1000)
    params = {"timestamp": ts, "recvWindow": 5000}
    query = urlencode(params)
    sig = hmac.new(acct["api_secret"].encode(), query.encode(), hashlib.sha256).hexdigest()
    r = await client.get(
        f"{base}/fapi/v2/balance?{query}&signature={sig}",
        headers={"X-MBX-APIKEY": acct["api_key"]},
    )
    data = r.json() if r.content else None
    if r.status_code >= 400:
        rec = data if isinstance(data, dict) else {}
        raise RuntimeError(rec.get("msg") or rec.get("message") or r.text[:180] or f"HTTP {r.status_code}")
    rows = data if isinstance(data, list) else []
    for rec in rows:
        if not isinstance(rec, dict):
            continue
        if str(rec.get("asset") or "").upper() != want:
            continue
        native = _num(rec.get("balance") or rec.get("crossWalletBalance"))
        return {
            "balance": native * rate,
            "native": native,
            "asset": want,
            "uid": str(rec.get("accountAlias") or acct.get("id") or ""),
            "available": _num(rec.get("availableBalance") or rec.get("maxWithdrawAmount")),
        }
    raise RuntimeError(f"no {want} wallet")


async def _coindcx_wallet(client: httpx.AsyncClient, acct: dict, rate: float) -> dict:
    _ = rate
    base = os.getenv("COINDCX_REST_URL", "https://api.coindcx.com").rstrip("/")
    want = (acct.get("asset") or os.getenv("COINDCX_FUTURES_MARGIN_CCY", "INR") or "INR").upper()
    body = json.dumps({"timestamp": int(time.time() * 1000)}, separators=(",", ":"))
    sig = hmac.new(acct["api_secret"].encode(), body.encode(), hashlib.sha256).hexdigest()
    r = await client.request(
        "GET",
        base + "/exchange/v1/derivatives/futures/wallets",
        headers={
            "Content-Type": "application/json",
            "X-AUTH-APIKEY": acct["api_key"],
            "X-AUTH-SIGNATURE": sig,
            "Accept-Encoding": "identity",
        },
        content=body,
    )
    data = r.json() if r.content else None
    if r.status_code >= 400:
        rec = data if isinstance(data, dict) else {}
        raise RuntimeError(rec.get("message") or rec.get("code") or r.text[:180] or f"HTTP {r.status_code}")
    rows = data if isinstance(data, list) else ((data or {}).get("data") or (data or {}).get("wallets") or [])
    for w in rows:
        if not isinstance(w, dict):
            continue
        if str(w.get("currency_short_name") or "").upper() != want:
            continue
        native = _num(w.get("balance")) + _num(w.get("locked_balance"))
        return {
            "balance": native,
            "native": native,
            "asset": want,
            "uid": str(acct.get("id") or ""),
            "available": _num(w.get("balance")),
        }
    raise RuntimeError(f"no {want} wallet")


async def _kucoin_wallet(client: httpx.AsyncClient, acct: dict, rate: float) -> dict:
    base = os.getenv("KUCOIN_REST_URL", "https://api-futures.kucoin.com").rstrip("/")
    want = (acct.get("asset") or os.getenv("KUCOIN_WALLET_ASSET", "USDT") or "USDT").upper()
    method = "GET"
    path = "/api/v1/account-overview"
    qs = urlencode({"currency": want})
    endpoint = f"{path}?{qs}"
    ts = str(int(time.time() * 1000))
    secret = acct["api_secret"]
    sign = base64.b64encode(
        hmac.new(secret.encode(), f"{ts}{method}{endpoint}".encode(), hashlib.sha256).digest()
    ).decode()
    passphrase = acct.get("passphrase") or ""
    passphrase = base64.b64encode(
        hmac.new(secret.encode(), passphrase.encode(), hashlib.sha256).digest()
    ).decode()
    r = await client.get(
        base + endpoint,
        headers={
            "KC-API-KEY": acct["api_key"],
            "KC-API-SIGN": sign,
            "KC-API-TIMESTAMP": ts,
            "KC-API-PASSPHRASE": passphrase,
            "KC-API-KEY-VERSION": "2",
            "Content-Type": "application/json",
        },
    )
    data = r.json() if r.content else {}
    if r.status_code >= 400 or str((data or {}).get("code") or "") not in ("200000", "200", "0", ""):
        rec = data if isinstance(data, dict) else {}
        raise RuntimeError(rec.get("msg") or rec.get("message") or r.text[:180] or f"HTTP {r.status_code}")
    rec = data.get("data") if isinstance(data.get("data"), dict) else {}
    native = _num(rec.get("accountEquity") or rec.get("marginBalance"))
    return {
        "balance": native * rate,
        "native": native,
        "asset": want,
        "uid": str(acct.get("id") or ""),
        "available": _num(rec.get("availableBalance") or rec.get("availableMargin")),
    }


async def _bybit_signed_get(
    client: httpx.AsyncClient,
    acct: dict,
    path: str,
    params: dict,
) -> dict:
    base = os.getenv("BYBIT_REST_URL", "https://api.bybit.com").rstrip("/")
    qs = urlencode(sorted((k, v) for k, v in params.items() if v is not None and v != ""))
    ts = str(int(time.time() * 1000))
    recv = "5000"
    sign = hmac.new(
        acct["api_secret"].encode(),
        f"{ts}{acct['api_key']}{recv}{qs}".encode(),
        hashlib.sha256,
    ).hexdigest()
    r = await client.get(
        f"{base}{path}" + (f"?{qs}" if qs else ""),
        headers={
            "X-BAPI-API-KEY": acct["api_key"],
            "X-BAPI-SIGN": sign,
            "X-BAPI-TIMESTAMP": ts,
            "X-BAPI-RECV-WINDOW": recv,
            "Content-Type": "application/json",
        },
    )
    rec = r.json() if r.content else {}
    if not isinstance(rec, dict):
        raise RuntimeError(r.text[:180] or f"HTTP {r.status_code}")
    return rec


def _bybit_pick_num(*vals, default: float = 0.0) -> float:
    """First present numeric field — keeps real zeros (unlike `a or b`)."""
    for v in vals:
        if v is None or v == "":
            continue
        return _num(v, default)
    return default


async def _bybit_key_info(client: httpx.AsyncClient, acct: dict) -> dict:
    """Who this API key belongs to (master vs sub, UID)."""
    rec = await _bybit_signed_get(client, acct, "/v5/user/query-api", {})
    ret = rec.get("retCode")
    if ret not in (None, 0, "0"):
        raise RuntimeError(rec.get("retMsg") or rec.get("msg") or f"retCode {ret}")
    result = rec.get("result") if isinstance(rec.get("result"), dict) else {}
    return result or {}


async def _bybit_member_coin(
    client: httpx.AsyncClient,
    acct: dict,
    member_id: str,
    coin: str,
    account_type: str,
) -> float | None:
    """Master-key lookup of a sub UID balance. None = endpoint refused / missing."""
    rec = await _bybit_signed_get(
        client,
        acct,
        "/v5/asset/transfer/query-account-coin-balance",
        {
            "memberId": member_id,
            "accountType": account_type,
            "coin": coin,
        },
    )
    ret = rec.get("retCode")
    if ret not in (None, 0, "0"):
        return None
    result = rec.get("result") if isinstance(rec.get("result"), dict) else {}
    bal = result.get("balance") if isinstance(result, dict) else None
    if isinstance(bal, dict):
        return _bybit_pick_num(bal.get("walletBalance"), bal.get("transferBalance"), bal.get("equity"))
    if isinstance(bal, list):
        for row in bal:
            if not isinstance(row, dict):
                continue
            if str(row.get("coin") or "").upper() != coin:
                continue
            return _bybit_pick_num(row.get("walletBalance"), row.get("transferBalance"), row.get("equity"))
    return None


async def _bybit_wallet(client: httpx.AsyncClient, acct: dict, rate: float) -> dict:
    want = (acct.get("asset") or os.getenv("BYBIT_WALLET_ASSET", "USDT") or "USDT").upper()
    kind = (os.getenv("BYBIT_ACCOUNT_TYPE", "UNIFIED") or "UNIFIED").strip().upper() or "UNIFIED"
    cfg_uid = _clean(acct.get("id"))
    key_uid = ""
    is_master = False
    try:
        info = await _bybit_key_info(client, acct)
        key_uid = _clean(info.get("userID") or info.get("userId") or info.get("uid"))
        is_master = info.get("isMaster") is True or str(info.get("isMaster") or "").lower() in ("1", "true")
    except Exception as exc:
        logger.debug("wallets: bybit query-api failed — %s", exc)

    # Config id is the Bybit member UID. When this key is the master and the
    # configured UID is a different subaccount, wallet-balance would wrongly
    # return the master's equity — query the sub via memberId instead.
    target = cfg_uid or key_uid
    if is_master and cfg_uid and key_uid and cfg_uid != key_uid:
        last_err = "no wallet"
        for acct_type in (kind, "UNIFIED", "CONTRACT", "FUND"):
            got = await _bybit_member_coin(client, acct, cfg_uid, want, acct_type)
            if got is None:
                last_err = f"member {cfg_uid} {acct_type} unavailable"
                continue
            return {
                "balance": got * rate,
                "native": got,
                "asset": want,
                "uid": cfg_uid,
                "available": got,
            }
        raise RuntimeError(
            f"Bybit sub {cfg_uid} balance failed ({last_err}). "
            "Use a master key with SubMember transfer read, or BBSA1's own API key."
        )

    last_err = "no wallet"
    for acct_type in (kind, "UNIFIED", "CONTRACT"):
        rec = await _bybit_signed_get(
            client,
            acct,
            "/v5/account/wallet-balance",
            {"accountType": acct_type, "coin": want},
        )
        ret = rec.get("retCode")
        if ret not in (None, 0, "0"):
            last_err = rec.get("retMsg") or rec.get("msg") or f"retCode {ret}"
            continue
        result = rec.get("result") if isinstance(rec.get("result"), dict) else {}
        rows = result.get("list") if isinstance(result, dict) else []
        for item in rows or []:
            if not isinstance(item, dict):
                continue
            coins = item.get("coin") or []
            total = item.get("totalEquity") or item.get("totalWalletBalance")
            for coin in coins if isinstance(coins, list) else []:
                if str((coin or {}).get("coin") or "").upper() != want:
                    continue
                native = _bybit_pick_num(
                    coin.get("equity"),
                    coin.get("walletBalance"),
                    coin.get("usdValue"),
                    total,
                )
                return {
                    "balance": native * rate,
                    "native": native,
                    "asset": want,
                    "uid": target or cfg_uid or key_uid,
                    "available": _bybit_pick_num(
                        coin.get("availableToWithdraw"),
                        coin.get("walletBalance"),
                        native,
                    ),
                }
            if total not in (None, ""):
                native = _bybit_pick_num(total)
                return {
                    "balance": native * rate,
                    "native": native,
                    "asset": want,
                    "uid": target or cfg_uid or key_uid,
                    "available": native,
                }
    raise RuntimeError(last_err)


def _cb_host(url: str) -> str:
    u = (url or "").strip()
    if "://" in u:
        u = u.split("://", 1)[1]
    return u.split("/")[0] or "api.coinbase.com"


def _cb_amount(v) -> float:
    if isinstance(v, dict):
        return _num(v.get("value") or v.get("amount") or v.get("quantity"))
    return _num(v)


def _cb_err(status: int, data, raw: str = "") -> str:
    if isinstance(data, dict):
        err = data.get("message") or data.get("error") or data.get("error_details")
        if isinstance(err, dict):
            err = err.get("message") or err.get("error")
        if err:
            return str(err)[:180]
    return (raw or "")[:180] or f"HTTP {status}"


def _coinbase_private_key(secret: str):
    try:
        import jwt  # noqa: F401
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ed25519
    except ImportError as exc:
        raise RuntimeError("Coinbase wallets need PyJWT and cryptography (pip install -r requirements.txt)") from exc
    text = (secret or "").replace("\\n", "\n").strip()
    if text.lstrip().startswith("-----BEGIN"):
        return serialization.load_pem_private_key(text.encode(), password=None)
    try:
        raw = base64.b64decode("".join(text.split()), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise RuntimeError("Coinbase secret is not PEM or base64") from exc
    if len(raw) in (32, 64):
        return ed25519.Ed25519PrivateKey.from_private_bytes(raw[:32])
    try:
        return serialization.load_der_private_key(raw, password=None)
    except Exception as exc:
        raise RuntimeError("Coinbase secret is not a CDP EC/Ed25519 private key") from exc


def _coinbase_jwt(key: str, secret: str, method: str, host: str, path: str) -> str:
    import jwt
    from cryptography.hazmat.primitives.asymmetric import ec, ed25519
    pk = _coinbase_private_key(secret)
    if isinstance(pk, ed25519.Ed25519PrivateKey):
        alg = "EdDSA"
    elif isinstance(pk, ec.EllipticCurvePrivateKey):
        alg = "ES256"
    else:
        raise RuntimeError("unsupported Coinbase key type")
    now = int(time.time())
    return jwt.encode(
        {
            "sub": key,
            "iss": "cdp",
            "nbf": now,
            "exp": now + 120,
            "uri": f"{method.upper()} {host}{path}",
        },
        pk,
        algorithm=alg,
        headers={"kid": key, "nonce": secrets.token_hex(), "typ": "JWT"},
    )


async def _coinbase_adv_get(client: httpx.AsyncClient, acct: dict, path: str) -> dict:
    base = os.getenv("COINBASE_REST_URL", "https://api.coinbase.com").rstrip("/")
    host = _cb_host(base)
    token = _coinbase_jwt(acct["api_key"], acct["api_secret"], "GET", host, path)
    r = await client.get(
        base + path,
        headers={"Authorization": "Bearer " + token, "Accept": "application/json"},
    )
    data = r.json() if r.content else {}
    if r.status_code >= 400:
        raise RuntimeError(_cb_err(r.status_code, data, r.text))
    return data if isinstance(data, dict) else {}


def _cb_intx_equity(snap: dict) -> tuple[float, float, str]:
    summary = snap.get("summary") if isinstance(snap.get("summary"), dict) else {}
    rows = snap.get("portfolios") if isinstance(snap.get("portfolios"), list) else []
    total = summary.get("total_balance")
    avail = summary.get("max_withdrawal_amount") or summary.get("buying_power")
    asset = ""
    if isinstance(total, dict):
        asset = str(total.get("currency") or "").upper()
    native = _cb_amount(total)
    if native <= 0 and rows:
        row = rows[0] if isinstance(rows[0], dict) else {}
        total = row.get("total_balance") or row.get("collateral")
        native = _cb_amount(total)
        if isinstance(total, dict):
            asset = str(total.get("currency") or asset).upper()
        elif isinstance(row.get("collateral"), str) or _num(row.get("collateral")):
            native = max(native, _num(row.get("collateral")))
    return native, (_cb_amount(avail) or native), (asset or "USD")


async def _coinbase_wallet(client: httpx.AsyncClient, acct: dict, rate: float) -> dict:
    """CDP JWT against Advanced Trade — covers INTX perps and spot USD/USDC."""
    want = (acct.get("asset") or "").upper()
    fiat = {want} if want else {"USD", "USDC", "USDT"}
    native = 0.0
    available = 0.0
    asset = want or "USD"
    uid = acct.get("id") or ""
    errors: list[str] = []
    authed = False
    intx_got = False

    try:
        listed = await _coinbase_adv_get(client, acct, "/api/v3/brokerage/portfolios")
        authed = True
        ports = [p for p in (listed.get("portfolios") or []) if isinstance(p, dict) and p.get("uuid") and not p.get("deleted")]
        intx_ids = [p["uuid"] for p in ports if str(p.get("type") or "").upper() == "INTX"]
        for pid in intx_ids or [p["uuid"] for p in ports]:
            try:
                snap = await _coinbase_adv_get(client, acct, f"/api/v3/brokerage/intx/portfolio/{pid}")
            except Exception as exc:
                if intx_ids:
                    errors.append(str(exc)[:120])
                continue
            n, a, ccy = _cb_intx_equity(snap)
            if n <= 0 and a <= 0:
                intx_got = True
                uid = uid or str(pid)
                continue
            native += n
            available += a
            if ccy:
                asset = ccy
            uid = uid or str(pid)
            intx_got = True
            if intx_ids:
                break
    except Exception as exc:
        errors.append(str(exc)[:160])

    try:
        data = await _coinbase_adv_get(client, acct, "/api/v3/brokerage/accounts")
        authed = True
        for acc in data.get("accounts") or []:
            if not isinstance(acc, dict):
                continue
            plat = str(acc.get("platform") or "").upper()
            if intx_got and "INTX" in plat:
                continue
            ccy = str(acc.get("currency") or "").upper()
            if ccy not in fiat:
                continue
            avail = _cb_amount(acc.get("available_balance"))
            hold = _cb_amount(acc.get("hold"))
            native += avail + hold
            available += avail
            asset = ccy or asset
            uid = uid or str(acc.get("uuid") or "")
    except Exception as exc:
        errors.append(str(exc)[:160])

    if not authed:
        raise RuntimeError(errors[0] if errors else "Coinbase auth failed")
    return {
        "balance": native * rate,
        "native": native,
        "asset": asset or "USD",
        "uid": str(uid or acct.get("name") or ""),
        "available": available,
    }


_idle_lock = asyncio.Lock()
_idle_cache: dict = {"t": 0.0, "skip": frozenset(), "rows": []}


def _acct_tags(acct: dict) -> set[str]:
    return {v for v in (
        _clean(acct.get("id")),
        _clean(acct.get("name")),
        _clean(acct.get("uid")),
    ) if v}


async def fetch_idle_wallets(
    skip_ids: set[str] | None = None,
    usdinr_rate: float = 87.0,
    min_age_sec: float = 900.0,
) -> list[dict]:
    """REST wallet GET for configured keys that are not running a bot.

    Cached so the balances Auto timer does not hit the exchange every 30s.
    Live bot accounts are skipped — those already publish from private WS.
    """
    skip = frozenset(str(x or "").strip() for x in (skip_ids or []) if str(x or "").strip())
    accts = []
    for acct in load_wallet_accounts():
        if _acct_tags(acct) & skip:
            continue
        accts.append(acct)
    if not accts:
        return []
    age = max(30.0, float(min_age_sec or 900.0))
    async with _idle_lock:
        now = time.time()
        if (
            _idle_cache["t"]
            and now - float(_idle_cache["t"] or 0) < age
            and _idle_cache["skip"] == skip
        ):
            return list(_idle_cache["rows"])
        timeout = httpx.Timeout(12.0, connect=6.0)
        async with httpx.AsyncClient(timeout=timeout, verify=False) as client:
            fetched = await asyncio.gather(
                *[_fetch_one(client, a, float(usdinr_rate or 87)) for a in accts]
            )
        rows = []
        for rec in fetched:
            cfg = rec.get("cfg") or {}
            aid = _clean(rec.get("uid") or cfg.get("id") or cfg.get("name"))
            if aid and aid in skip:
                continue
            rec["uid"] = aid
            rows.append(rec)
        _idle_cache["t"] = now
        _idle_cache["skip"] = skip
        _idle_cache["rows"] = rows
        logger.info("wallets: idle REST %s keys skip=%s", len(rows), len(skip))
        return list(rows)


_FETCHERS = {
    "delta": _delta_wallet,
    "binance": _binance_wallet,
    "coindcx": _coindcx_wallet,
    "kucoin": _kucoin_wallet,
    "bybit": _bybit_wallet,
    "coinbase": _coinbase_wallet,
}


async def _fetch_one(client: httpx.AsyncClient, acct: dict, rate: float) -> dict:
    exch = acct["exchange"]
    fn = _FETCHERS.get(exch)
    if fn is None:
        return {
            "ok": False,
            "exchange": exch,
            "error": f"{exch} live wallet not wired yet",
            "cfg": acct,
        }
    try:
        out = await fn(client, acct, rate)
        out["ok"] = True
        out["exchange"] = exch
        out["cfg"] = acct
        out["error"] = ""
        return out
    except Exception as exc:
        logger.warning("wallets: %s %s failed — %s", exch, acct.get("name") or acct.get("id") or "key", exc)
        return {
            "ok": False,
            "exchange": exch,
            "error": str(exc)[:180],
            "cfg": acct,
        }


def _empty(configured: int = 0) -> dict:
    return {
        "source": "live",
        "accounts": [],
        "exchanges": [],
        "totals": {"balance": None, "accounts": 0, "with_balance": 0, "errors": 0},
        "snapshots": 0,
        "as_of": None,
        "configured": configured,
    }


def _strategy_is_all(strategy: str = "") -> bool:
    return (strategy or "").strip().lower() in ("", "all", "*", "any")


def filter_balances_scope(board: dict, strategy: str = "", scope: str = "all") -> dict:
    """Subset a live board to one strategy. `all` keeps every wallet."""
    accounts = list(board.get("accounts") or [])
    if (scope or "all").lower() != "strategy" or _strategy_is_all(strategy):
        out = dict(board)
        out["scope"] = "all"
        return out
    keep = [a for a in accounts if strategy in (a.get("strategies") or [])]
    if not keep:
        out = dict(board)
        out["accounts"] = []
        out["exchanges"] = []
        out["totals"] = {"balance": None, "accounts": 0, "with_balance": 0, "errors": 0}
        out["snapshots"] = 0
        out["scope"] = "strategy"
        out["hint"] = f"No wallets tagged {strategy}."
        return out
    exchanges: dict[str, float] = {}
    equity = 0.0
    with_bal = 0
    errors = 0
    for acct in keep:
        known = {k: v for k, v in (acct.get("venues") or {}).items() if v is not None}
        if acct.get("total") is not None:
            equity += acct["total"]
            with_bal += 1
        errors += len(acct.get("venue_errors") or {})
        for k, v in known.items():
            exchanges[k] = exchanges.get(k, 0.0) + v
        for k in (acct.get("venues") or {}):
            exchanges.setdefault(k, 0.0)
    exch_list = sorted(exchanges, key=lambda e: (-abs(exchanges[e]), e))
    out = dict(board)
    out["accounts"] = keep
    out["exchanges"] = [
        {
            "exchange": e,
            "label": _LABELS.get(e, e.title()),
            "balance": round(exchanges[e], 4) if any(
                (a.get("venues") or {}).get(e) is not None for a in keep
            ) else None,
        }
        for e in exch_list
    ]
    out["totals"] = {
        "balance": round(equity, 4) if with_bal else None,
        "accounts": len(keep),
        "with_balance": with_bal,
        "errors": errors,
    }
    out["snapshots"] = with_bal
    out["scope"] = "strategy"
    return out


async def live_balances_board(usdinr_rate: float = 87.0, strategy: str = "", scope: str = "all") -> dict:
    """Fetch every configured subaccount in parallel. Values are INR."""
    accts = load_wallet_accounts()
    if not accts:
        out = _empty(0)
        out["hint"] = (
            "Add subaccount API keys: config/accounts.json, or BAL_1_EXCHANGE / BAL_1_KEY / BAL_1_SECRET "
            "in the webapp env (repeat BAL_2_*, …)."
        )
        return out
    timeout = httpx.Timeout(12.0, connect=6.0)
    async with httpx.AsyncClient(timeout=timeout, verify=False) as client:
        fetched = await asyncio.gather(*[_fetch_one(client, a, float(usdinr_rate or 87)) for a in accts])

    now = int(time.time())
    by_acct: dict[str, dict] = {}
    errors = 0

    def slot(aid: str, name: str) -> dict:
        row = by_acct.get(aid)
        if row is None:
            row = {
                "account": aid,
                "account_name": name or aid,
                "strategies": [],
                "venues": {},
                "venue_errors": {},
                "time": now,
                "total": None,
            }
            by_acct[aid] = row
        return row

    for i, rec in enumerate(fetched):
        cfg = rec.get("cfg") or accts[i]
        exch = rec.get("exchange") or cfg.get("exchange")
        aid = _clean(rec.get("uid") or cfg.get("id") or cfg.get("name")) or f"{exch}-{i+1}"
        name = cfg.get("name") or aid
        row = slot(aid, name)
        if cfg.get("name") and (not row["account_name"] or row["account_name"] == row["account"]):
            row["account_name"] = cfg["name"]
        st = cfg.get("strategy")
        if st and st not in row["strategies"]:
            row["strategies"].append(st)
        if rec.get("ok"):
            row["venues"][exch] = round(float(rec["balance"] or 0), 4)
        else:
            errors += 1
            row["venues"].setdefault(exch, None)
            row["venue_errors"][exch] = rec.get("error") or "failed"

    if (scope or "all").lower() == "strategy" and not _strategy_is_all(strategy):
        keep = {
            k: v for k, v in by_acct.items()
            if strategy in (v.get("strategies") or [])
        }
        by_acct = keep

    accounts = []
    exchanges: dict[str, float] = {}
    equity = 0.0
    with_bal = 0
    for acct in by_acct.values():
        known = {k: v for k, v in acct["venues"].items() if v is not None}
        acct["total"] = round(sum(known.values()), 4) if known else None
        if acct["total"] is not None:
            equity += acct["total"]
            with_bal += 1
        if not acct["account_name"]:
            acct["account_name"] = acct["account"]
        acct["strategies"] = sorted(acct["strategies"])
        for k, v in known.items():
            exchanges[k] = exchanges.get(k, 0.0) + v
        for k in acct["venues"]:
            exchanges.setdefault(k, 0.0)
        accounts.append(acct)
    accounts.sort(key=lambda a: (-(a.get("total") if a.get("total") is not None else -1e18), a.get("account") or ""))
    exch_list = sorted(exchanges, key=lambda e: (-abs(exchanges[e]), e))
    return {
        "source": "live",
        "accounts": accounts,
        "exchanges": [
            {
                "exchange": e,
                "label": _LABELS.get(e, e.title()),
                "balance": round(exchanges[e], 4) if any(
                    (a.get("venues") or {}).get(e) is not None for a in accounts
                ) else None,
            }
            for e in exch_list
        ],
        "totals": {
            "balance": round(equity, 4) if with_bal else None,
            "accounts": len(accounts),
            "with_balance": with_bal,
            "errors": errors,
        },
        "snapshots": with_bal,
        "as_of": now,
        "configured": len(accts),
        "scope": (scope or "all").lower(),
    }
