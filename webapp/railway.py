"""Create / stop OPA6 bots as Railway services.

OPADash on Railway cannot `Popen(stack.py)` — that tree is not in this container.
New contract clones an existing OPA6 service (repo + shared env), overlays knobs
and the chosen subaccount keys, and deploys it.
"""
from __future__ import annotations

import json
import os
import re
import time

import httpx

from config.settings import load_env_file

GQL_URLS = (
    "https://backboard.railway.com/graphql/v2",
    "https://backboard.railway.app/graphql/v2",
)

_INFRA_KEYS = (
    "DATABASE_URL", "USDINR_RATE",
    "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_ALERT_CHAT_ID", "ALERT_RPNL_INR",
    "REPORT_SECS", "MAX_AGE_DELTA_MS",
)
_VENUE_INFRA = {
    "delta": ("DELTA_REST_URL", "DELTA_WS_URL", "DELTA_PRIVATE_WS_URL", "DELTA_WALLET_ASSET"),
    "binance": ("BINANCE_REST_URL", "BINANCE_WS_URL", "BINANCE_WALLET_ASSET"),
    "bybit": ("BYBIT_REST_URL", "BYBIT_WS_URL"),
    "kucoin": ("KUCOIN_REST_URL", "KUCOIN_WS_URL"),
    "coinbase": ("COINBASE_REST_URL", "COINBASE_INTX_URL"),
    "aster": ("ASTER_REST_URL",),
}
_INFRA_VAR_NAMES = frozenset(k for keys in _VENUE_INFRA.values() for k in keys)
_arb_ok: set[str] = set()


def _token() -> str:
    load_env_file()
    return (os.getenv("RAILWAY_TOKEN") or os.getenv("RAILWAY_API_TOKEN") or "").strip()


def _project_id() -> str:
    load_env_file()
    return (os.getenv("RAILWAY_PROJECT_ID") or os.getenv("OPA6_RAILWAY_PROJECT") or "").strip()


def _env_id() -> str:
    load_env_file()
    return (os.getenv("RAILWAY_ENVIRONMENT_ID") or os.getenv("OPA6_RAILWAY_ENVIRONMENT") or "").strip()


def ready() -> bool:
    return bool(_token() and _project_id())


def _gql(query: str, variables: dict | None = None) -> dict:
    token = _token()
    if not token:
        raise RuntimeError("RAILWAY_TOKEN is missing")
    payload = {"query": query, "variables": variables or {}}
    headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json"}
    last = None
    for url in GQL_URLS:
        try:
            with httpx.Client(timeout=45.0) as client:
                r = client.post(url, json=payload, headers=headers)
        except httpx.HTTPError as extra:
            last = extra
            continue
        try:
            body = r.json()
        except Exception:
            last = RuntimeError(f"Railway HTTP {r.status_code}")
            continue
        errs = body.get("errors") or []
        if errs:
            msg = errs[0].get("message") if isinstance(errs[0], dict) else str(errs[0])
            raise RuntimeError(str(msg or "Railway API error")[:240])
        if r.status_code >= 400:
            last = RuntimeError(f"Railway HTTP {r.status_code}")
            continue
        data = body.get("data")
        if data is None:
            last = RuntimeError("Railway returned no data")
            continue
        return data
    raise RuntimeError(str(last)[:240] if last else "Railway API unreachable")


def _svc_edges(project: dict) -> list[dict]:
    raw = ((project or {}).get("services") or {}).get("edges") or []
    out = []
    for edge in raw:
        node = (edge or {}).get("node") or edge
        if isinstance(node, dict) and node.get("id"):
            out.append(node)
    return out


def _instance_for_env(svc: dict, env_id: str) -> dict:
    edges = ((svc.get("serviceInstances") or {}).get("edges")) or []
    nodes = []
    for edge in edges:
        node = (edge or {}).get("node") or edge
        if isinstance(node, dict):
            nodes.append(node)
    if env_id:
        for node in nodes:
            if str(node.get("environmentId") or "") == env_id:
                return node
    return nodes[0] if nodes else {}


def _project() -> dict:
    pid = _project_id()
    data = _gql(
        """
        query ($id: String!) {
          project(id: $id) {
            id
            name
            services {
              edges {
                node {
                  id
                  name
                  serviceInstances {
                    edges {
                      node {
                        environmentId
                        startCommand
                        source { repo }
                        latestDeployment { status }
                      }
                    }
                  }
                }
              }
            }
          }
        }
        """,
        {"id": pid},
    )
    proj = data.get("project")
    if not isinstance(proj, dict):
        raise RuntimeError("Railway project not found")
    return proj


def _variables(service_id: str) -> dict[str, str]:
    pid, eid = _project_id(), _env_id()
    if not eid:
        raise RuntimeError("RAILWAY_ENVIRONMENT_ID is missing")
    data = _gql(
        """
        query ($projectId: String!, $environmentId: String!, $serviceId: String!) {
          variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
        }
        """,
        {"projectId": pid, "environmentId": eid, "serviceId": service_id},
    )
    raw = data.get("variables")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            raw = {}
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for key, val in raw.items():
        name = str(key or "").strip()
        if not name or val is None:
            continue
        out[name] = str(val)
    return out


def _pick_infra(name: str, template: dict[str, str]) -> str:
    val = (os.getenv(name) or "").strip()
    if val:
        return val
    return str(template.get(name) or "").strip()


def _infra_env(venue: str, template: dict[str, str]) -> dict[str, str]:
    out: dict[str, str] = {}
    names = list(_INFRA_KEYS) + list(_VENUE_INFRA.get(venue, ()))
    for name in names:
        val = _pick_infra(name, template)
        if val:
            out[name] = val
    return out


def _fill_arb_other_leg(env: dict[str, str], copied: dict[str, str] | None = None, quote_sym: str = "") -> dict[str, str]:
    """Template keys first, then OPADash / Balances keys (those win)."""
    from webapp.launch import VENUE_ENV, apply_arb_other_keys

    copied = copied or {}
    other = str(env.get("ARB_VENUE") or "").strip().lower()
    quote = str(env.get("QUOTE_VENUE") or "").strip().lower()
    spec = VENUE_ENV.get(other) if other and other != quote else None
    if spec:
        for key in spec:
            if key and copied.get(key) and not str(env.get(key) or "").strip():
                env[key] = str(copied[key])
        env.update(_infra_env(other, copied))
    apply_arb_other_keys(env, quote, quote_sym)
    return env


def _symbol_from_env(env: dict[str, str]) -> str:
    from webapp.launch import VENUE_ENV

    quote = str(env.get("QUOTE_VENUE") or "").strip().lower()
    spec = VENUE_ENV.get(quote)
    if spec and env.get(spec[2]):
        return str(env[spec[2]]).strip()
    for row in VENUE_ENV.values():
        if env.get(row[2]):
            return str(env[row[2]]).strip()
    return ""


def _slim_knobs(knobs: dict[str, str]) -> dict[str, str]:
    """Keep form knobs. Ticks win — drop the unused % (or unused 0 ticks)."""
    out = dict(knobs)
    for ticks, pct in (
        ("HEM_TICKS", "HEM_PCT"),
        ("SPAN_TICKS", "SPAN_PCT"),
        ("STEP_TICKS", "STEP_PCT"),
        ("K_TICKS", "K_PCT"),
        ("TAIL_TICKS", "TAIL_PCT"),
    ):
        raw = out.get(ticks)
        try:
            n = int(float(raw)) if raw not in (None, "") else 0
        except (TypeError, ValueError):
            n = 0
        if n > 0:
            out.pop(pct, None)
        else:
            out.pop(ticks, None)
    return {k: v for k, v in out.items() if v is not None and str(v) != ""}


def _template_service(proj: dict) -> dict | None:
    want = (os.getenv("OPA6_RAILWAY_SERVICE") or "").strip()
    me = (os.getenv("RAILWAY_SERVICE_ID") or "").strip()
    rows = _svc_edges(proj)
    eid = _env_id()

    def skip(svc: dict) -> bool:
        return bool(me) and str(svc.get("id") or "") == me

    if want:
        for svc in rows:
            if skip(svc):
                continue
            if str(svc.get("id") or "") == want or str(svc.get("name") or "").lower() == want.lower():
                return svc
        raise RuntimeError(f"OPA6_RAILWAY_SERVICE={want} not found in this Railway project")

    ranked: list[tuple[int, dict]] = []
    for svc in rows:
        if skip(svc):
            continue
        name = str(svc.get("name") or "").lower()
        inst = _instance_for_env(svc, eid)
        start = str(inst.get("startCommand") or "").lower()
        repo = str(((inst.get("source") or {}) if isinstance(inst.get("source"), dict) else {}).get("repo") or "").lower()
        score = 0
        if name in ("opa6", "opa-6"):
            score += 50
        if "opa6" in name:
            score += 20
        if "run.py" in start or "stack.py" in start or "pair.py" in start:
            score += 15
        if "opa6" in repo:
            score += 10
        if name.startswith("dash-"):
            score -= 30
        if score > 0:
            ranked.append((score, svc))
    ranked.sort(key=lambda x: -x[0])
    return ranked[0][1] if ranked else None


def _source_of(svc: dict) -> dict:
    inst = _instance_for_env(svc, _env_id())
    src = inst.get("source") if isinstance(inst.get("source"), dict) else {}
    repo = str(src.get("repo") or "").strip()
    if not repo:
        repo = (os.getenv("OPA6_GITHUB_REPO") or "").strip()
    if not repo:
        raise RuntimeError(
            "Could not read the OPA6 GitHub repo off the template service. "
            "Set OPA6_GITHUB_REPO=owner/OPA6 (the GitHub repo Railway already deploys)."
        )
    if repo.startswith("https://github.com/"):
        repo = repo[len("https://github.com/"):]
        if repo.endswith(".git"):
            repo = repo[:-4]
    branch = (os.getenv("OPA6_GITHUB_BRANCH") or "").strip() or "main"
    return {"repo": repo, "branch": branch}


def _split_svc(name: str) -> tuple[str, str, str]:
    """dash-strategy-contract-account. Account names may contain hyphens."""
    parts = [p for p in str(name or "").split("-") if p]
    strategy = parts[1] if len(parts) > 1 else ""
    tail = "-".join(parts[2:]) if len(parts) > 2 else ""
    known: list[str] = []
    try:
        from webapp.ops import load_wallet_accounts
        for acct in load_wallet_accounts():
            for tag in (acct.get("name"), acct.get("id")):
                text = str(tag or "").strip()
                if text and text not in known:
                    known.append(text)
    except Exception:
        known = []
    known.sort(key=len, reverse=True)
    low = tail.lower()
    for tag in known:
        suffix = "-" + tag
        if low.endswith(suffix.lower()) and len(tail) > len(suffix):
            return strategy, tail[: -len(suffix)], tag
    if len(parts) > 3:
        return strategy, "-".join(parts[2:-1]), parts[-1]
    if len(parts) > 2:
        return strategy, tail, ""
    return strategy, "", ""


def _svc_name(strategy: str, contract: str, account: str) -> str:
    bits = ["dash", strategy, contract, account]
    raw = "-".join(str(b or "").strip() for b in bits if str(b or "").strip())
    safe = re.sub(r"[^a-zA-Z0-9-]+", "-", raw).strip("-")
    return (safe or "dash-bot")[:48].rstrip("-")


def update_knobs(service_id: str, knobs: dict[str, str]) -> None:
    """Patch this bot's Railway env. Next restart uses these values; live Apply already patched the process."""
    sid = str(service_id or "").strip()
    if not sid:
        raise ValueError("service id required")
    cleaned = {str(k): str(v) for k, v in (knobs or {}).items() if k is not None and v is not None}
    if not cleaned:
        return
    # Live Apply already pushed knobs into the process; don't bounce the replica.
    _upsert_vars(sid, cleaned, skip_deploys=True)


def _upsert_vars(service_id: str, knobs: dict[str, str], *, skip_deploys: bool = False) -> None:
    pid, eid = _project_id(), _env_id()
    try:
        payload: dict = {
            "projectId": pid,
            "environmentId": eid,
            "serviceId": service_id,
            "variables": knobs,
        }
        if skip_deploys:
            payload["skipDeploys"] = True
        _gql(
            """
            mutation ($input: VariableCollectionUpsertInput!) {
              variableCollectionUpsert(input: $input)
            }
            """,
            {"input": payload},
        )
        return
    except RuntimeError:
        pass
    for name, val in knobs.items():
        one: dict = {
            "projectId": pid,
            "environmentId": eid,
            "serviceId": service_id,
            "name": name,
            "value": val,
        }
        if skip_deploys:
            one["skipDeploys"] = True
        _gql(
            """
            mutation ($input: VariableUpsertInput!) {
              variableUpsert(input: $input)
            }
            """,
            {"input": one},
        )


def _enable_static_ip(service_id: str) -> str:
    """Turn on Railway static outbound IP. Empty string if the plan/API refuses."""
    try:
        data = _gql(
            """
            mutation ($input: EgressGatewayCreateInput!) {
              egressGatewayAssociationCreate(input: $input) { ipv4 region }
            }
            """,
            {"input": {"environmentId": _env_id(), "serviceId": service_id}},
        )
        rows = data.get("egressGatewayAssociationCreate") or []
        if isinstance(rows, list) and rows:
            ip = str((rows[0] or {}).get("ipv4") or "").strip()
            return ip
    except RuntimeError:
        pass
    return ""


def _set_start(service_id: str, cmd: str) -> None:
    _gql(
        """
        mutation ($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
          serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
        }
        """,
        {"serviceId": service_id, "environmentId": _env_id(), "input": {"startCommand": cmd}},
    )


def _connect(service_id: str, source: dict) -> None:
    repo = source["repo"]
    branch = source.get("branch") or "main"
    _gql(
        """
        mutation ($id: String!, $input: ServiceConnectInput!) {
          serviceConnect(id: $id, input: $input) { id }
        }
        """,
        {"id": service_id, "input": {"repo": repo, "branch": branch}},
    )


def _deploy(service_id: str) -> None:
    try:
        _gql(
            """
            mutation ($serviceId: String!, $environmentId: String!) {
              serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
            }
            """,
            {"serviceId": service_id, "environmentId": _env_id()},
        )
    except RuntimeError:
        _gql(
            """
            mutation ($serviceId: String!, $environmentId: String!) {
              serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
            }
            """,
            {"serviceId": service_id, "environmentId": _env_id()},
        )


def _delete(service_id: str) -> None:
    try:
        _gql(
            """
            mutation ($id: String!, $environmentId: String) {
              serviceDelete(id: $id, environmentId: $environmentId)
            }
            """,
            {"id": service_id, "environmentId": _env_id() or None},
        )
    except RuntimeError:
        _gql(
            """
            mutation ($id: String!) {
              serviceDelete(id: $id)
            }
            """,
            {"id": service_id},
        )


def _rename(service_id: str, name: str) -> None:
    _gql(
        """
        mutation ($id: String!, $input: ServiceUpdateInput!) {
          serviceUpdate(id: $id, input: $input) { id name }
        }
        """,
        {"id": service_id, "input": {"name": name}},
    )


def _create_empty(name: str) -> dict:
    pid, eid = _project_id(), _env_id()
    try:
        data = _gql(
            """
            mutation ($input: ServiceCreateInput!) {
              serviceCreate(input: $input) { id name }
            }
            """,
            {"input": {"projectId": pid, "name": name, "environmentId": eid} if eid else {"projectId": pid, "name": name}},
        )
    except RuntimeError:
        data = _gql(
            """
            mutation ($input: ServiceCreateInput!) {
              serviceCreate(input: $input) { id name }
            }
            """,
            {"input": {"projectId": pid, "name": name}},
        )
    rec = data.get("serviceCreate") or {}
    if not rec.get("id"):
        raise RuntimeError("Railway did not return a service id")
    return rec


def _bot_env(venue: str, contract: str, strategy: str, account: dict, knobs: dict[str, str], argv_tail: list[str]) -> dict[str, str]:
    from webapp.launch import VENUE_ENV

    keys = VENUE_ENV[venue]
    env: dict[str, str] = {
        "STRATEGY": strategy,
        "QUOTE_VENUE": venue,
    }
    env[keys[0]] = account["api_key"]
    env[keys[1]] = account["api_secret"]
    symbol = argv_tail[0] if strategy == "pair" else contract
    env[keys[2]] = symbol.upper() if strategy != "pair" or symbol[:2] not in ("C-", "P-") else symbol
    extra_pw = keys[3]
    if extra_pw:
        phrase = account.get("passphrase") or os.getenv(extra_pw) or ""
        if phrase:
            env[extra_pw] = phrase
    if strategy == "pair":
        opts = [t for t in argv_tail if t[:2] in ("C-", "P-")]
        if opts:
            env["PAIR_SYMBOL"] = ",".join(opts)
        if argv_tail and argv_tail[0][:2] not in ("C-", "P-"):
            env["CROP"] = argv_tail[0]
            if len(argv_tail) > 1:
                env["EXPIRY"] = argv_tail[1]
    elif strategy == "wing" and argv_tail and "-" in argv_tail[0]:
        env["CROP"], env["EXPIRY"] = argv_tail[0].split("-", 1)
        env[keys[2]] = argv_tail[0]
    elif strategy == "shop":
        env["COUNTER_VENUE"] = venue
        env["COUNTER"] = argv_tail[0] if argv_tail else contract
        if len(argv_tail) > 1:
            env["STOCKROOM"] = argv_tail[1]
    elif strategy == "harvest" and argv_tail:
        env["CROP"] = argv_tail[0]
    env.update(_slim_knobs(knobs))
    acct_id = str(account.get("id") or account.get("name") or "").strip()
    if acct_id:
        env["DASH_ACCOUNT"] = acct_id
    return env


def launch(
    *,
    venue: str,
    contract: str,
    strategy: str,
    account: dict,
    params: dict | None = None,
) -> dict:
    from webapp.launch import (
        BOTS, _alias_knobs, _bot_argv, _launch_contract, _pin_geom, _scrub_params,
    )

    if strategy not in BOTS:
        raise ValueError(f"unknown strategy '{strategy}'")
    if strategy in ("pair", "wing", "harvest") and str(venue or "").strip().lower() != "delta":
        raise ValueError(f"{strategy} quotes Delta")
    if strategy == "shop" and str(venue or "").strip().lower() not in ("delta", "aster"):
        raise ValueError("shop quotes Delta or Aster")
    if not ready():
        raise RuntimeError(
            "On Railway, New contract creates a new OPA6 service. "
            "Set RAILWAY_TOKEN on OPADash (project token from railway.com/account/tokens)."
        )
    if not _env_id():
        raise RuntimeError("RAILWAY_ENVIRONMENT_ID is missing on this service")

    knobs = _alias_knobs(strategy, _pin_geom(_scrub_params(params)))
    if strategy == "pair":
        if knobs.get("MAX_POSITION"):
            knobs.setdefault("PAIR_MAX", knobs["MAX_POSITION"])
        knobs.setdefault("PAIR_HEDGE", "true")
    argv_tail = _bot_argv(strategy, contract, knobs)
    contract = _launch_contract(strategy, contract, argv_tail)

    acct_id = str(account.get("id") or account.get("name") or "").strip()
    name = _svc_name(strategy, contract, account.get("name") or acct_id)
    proj = _project()
    for svc in _svc_edges(proj):
        if str(svc.get("name") or "") == name:
            raise ValueError(f"{strategy} {venue}:{contract} already has Railway service {name}")

    tmpl = _template_service(proj)
    source = _source_of(tmpl) if tmpl else None
    if source is None:
        repo = (os.getenv("OPA6_GITHUB_REPO") or "").strip()
        if not repo:
            raise RuntimeError(
                "No OPA6 service found to copy. Set OPA6_RAILWAY_SERVICE to an existing bot "
                "service name in this project, or OPA6_GITHUB_REPO=owner/OPA6."
            )
        if repo.startswith("https://github.com/"):
            repo = repo[len("https://github.com/"):]
            if repo.endswith(".git"):
                repo = repo[:-4]
        source = {"repo": repo, "branch": "main"}

    overlay = _bot_env(venue, contract, strategy, account, knobs, argv_tail)
    try:
        from webapp.launch import _write_overlays
        _write_overlays(strategy, venue, contract, acct_id, knobs)
    except Exception:
        pass
    copied = {}
    if tmpl:
        try:
            copied = _variables(str(tmpl["id"]))
        except RuntimeError:
            copied = {}
    env = _infra_env(venue, copied)
    env.update(overlay)
    if strategy == "arb":
        _fill_arb_other_leg(env, copied, contract)

    created = None
    static_ip = ""
    try:
        created = _create_empty(name)
        sid = str(created["id"])
        # One GitHub deploy from serviceConnect. Skip auto-redeploys on vars/start.
        _upsert_vars(sid, env, skip_deploys=True)
        _set_start(sid, "python3 run.py")
        static_ip = _enable_static_ip(sid)
        _connect(sid, source)
        if not static_ip:
            static_ip = _enable_static_ip(sid)
        _arb_ok.add(sid)
    except Exception:
        if created and created.get("id"):
            try:
                _delete(str(created["id"]))
            except Exception:
                pass
        raise

    _drop_bots_cache()
    return {
        "id": str(created["id"]),
        "pid": 0,
        "alive": True,
        "kind": "railway",
        "strategy": strategy,
        "venue": venue,
        "contract": contract,
        "account": acct_id,
        "account_name": account.get("name") or acct_id,
        "started_at": int(time.time()),
        "log": "",
        "params": knobs,
        "service": created.get("name") or name,
        "static_ip": static_ip,
    }


_stale_acct_cache: dict[str, tuple[float, tuple[str, str, str]]] = {}


def _ensure_arb_other_keys(service_id: str, svc_name: str) -> tuple[dict[str, str], str]:
    """Patch a running arb bot that launched without the other-leg key, and fix leaked names."""
    from webapp.launch import VENUE_ENV, venue_key_env

    sid = str(service_id or "").strip()
    name = str(svc_name or "")
    if not sid:
        return {}, name
    skip_patch = sid in _arb_ok
    if skip_patch and name not in _INFRA_VAR_NAMES:
        return {}, name
    try:
        env = _variables(sid)
    except Exception:
        return {}, name
    if str(env.get("STRATEGY") or "").strip().lower() != "arb":
        _arb_ok.add(sid)
        return env, name
    if not skip_patch:
        other = str(env.get("ARB_VENUE") or "").strip().lower()
        quote = str(env.get("QUOTE_VENUE") or "").strip().lower()
        spec = VENUE_ENV.get(other) if other and other != quote else None
        patch: dict[str, str] = {}
        if spec:
            need = [spec[0], spec[1]] + ([spec[3]] if spec[3] else [])
            missing = [k for k in need if k and not str(env.get(k) or "").strip()]
            if missing:
                extra = venue_key_env(other)
                for key in need:
                    if key and not str(env.get(key) or "").strip() and extra.get(key):
                        patch[key] = extra[key]
                        env[key] = extra[key]
        if patch:
            try:
                _upsert_vars(sid, patch, skip_deploys=True)
            except Exception:
                return env, name
            try:
                _deploy(sid)
            except RuntimeError:
                pass
            _drop_bots_cache()
        if spec and str(env.get(spec[0]) or "").strip() and str(env.get(spec[1]) or "").strip():
            _arb_ok.add(sid)
    if name in _INFRA_VAR_NAMES:
        wanted = _svc_name(
            "arb",
            _symbol_from_env(env),
            str(env.get("DASH_ACCOUNT") or "").strip(),
        )
        if wanted and wanted != name:
            try:
                _rename(sid, wanted)
                name = wanted
                _drop_bots_cache()
            except RuntimeError:
                pass
    return env, name


def _wallet_by_tag() -> dict[str, dict]:
    out: dict[str, dict] = {}
    try:
        from webapp.ops import load_wallet_accounts
        for acct in load_wallet_accounts():
            for tag in (acct.get("name"), acct.get("id")):
                text = str(tag or "").strip().lower()
                if text:
                    out[text] = acct
    except Exception:
        return out
    return out


def _resolve_listed_account(service_id: str, slug: str) -> tuple[str, str, str]:
    """Map a service-name account onto the current wallet.

    Renaming MainAccount → MA leaves the Railway service on the old slug.
    DASH_ACCOUNT on the service is the stable id, so the chip follows the new name.
    """
    known = _wallet_by_tag()
    hit = known.get(str(slug or "").strip().lower())
    if hit:
        return (
            str(hit.get("id") or slug),
            str(hit.get("name") or slug),
            str(hit.get("exchange") or "").strip().lower(),
        )
    sid = str(service_id or "").strip()
    now = time.time()
    cached = _stale_acct_cache.get(sid)
    if sid and cached and now - cached[0] < 45:
        return cached[1]
    env: dict[str, str] = {}
    if sid:
        try:
            env = _variables(sid)
        except Exception:
            env = {}
    aid = str(env.get("DASH_ACCOUNT") or "").strip()
    venue = str(env.get("QUOTE_VENUE") or "").strip().lower()
    hit = known.get(aid.lower()) if aid else None
    if hit:
        resolved = (
            str(hit.get("id") or aid),
            str(hit.get("name") or aid),
            venue or str(hit.get("exchange") or "").strip().lower(),
        )
    elif aid:
        resolved = (aid, aid, venue)
    else:
        resolved = (slug, slug, venue)
    if sid:
        _stale_acct_cache[sid] = (now, resolved)
    return resolved


_bots_cache: tuple[float, list[dict]] | None = None
_BOTS_TTL = 12.0


def _drop_bots_cache() -> None:
    global _bots_cache
    _bots_cache = None


def list_bots() -> list[dict]:
    global _bots_cache
    now = time.time()
    if _bots_cache is not None and now - _bots_cache[0] < _BOTS_TTL:
        return list(_bots_cache[1])
    rows = _list_bots()
    _bots_cache = (now, rows)
    return list(rows)


def _list_bots() -> list[dict]:
    if not ready():
        return []
    try:
        proj = _project()
    except RuntimeError:
        return []
    eid = _env_id()
    out = []
    for svc in _svc_edges(proj):
        name = str(svc.get("name") or "")
        botched = name in _INFRA_VAR_NAMES
        if not name.lower().startswith("dash-") and not botched:
            continue
        sid = str(svc.get("id") or "")
        env_hint: dict[str, str] = {}
        if botched or name.lower().startswith("dash-arb-"):
            try:
                env_hint, name = _ensure_arb_other_keys(sid, name)
            except Exception:
                env_hint = {}
        inst = _instance_for_env(svc, eid)
        status = ""
        dep = inst.get("latestDeployment")
        if isinstance(dep, dict):
            status = str(dep.get("status") or "")
        alive = status.upper() not in ("CRASHED", "FAILED", "REMOVED", "SKIPPED")
        strategy, contract, account = _split_svc(name)
        if env_hint.get("STRATEGY"):
            strategy = str(env_hint.get("STRATEGY") or "").strip().lower()
        hint_sym = _symbol_from_env(env_hint) if env_hint else ""
        if hint_sym:
            contract = hint_sym
        if env_hint.get("DASH_ACCOUNT"):
            account = str(env_hint.get("DASH_ACCOUNT") or "").strip()
        account, account_name, venue = _resolve_listed_account(sid, account)
        out.append({
            "id": sid,
            "pid": 0,
            "alive": alive,
            "kind": "railway",
            "strategy": strategy,
            "venue": venue,
            "contract": contract,
            "account": account,
            "account_name": account_name,
            "started_at": 0,
            "log": "",
            "params": {},
            "service": name,
            "status": status,
        })
    return out


def stop(bot_id: str) -> dict:
    sid = str(bot_id or "").strip()
    if not sid:
        raise ValueError("id required")
    name = ""
    for rec in list_bots():
        if rec.get("id") == sid:
            name = rec.get("service") or ""
            break
    _delete(sid)
    _drop_bots_cache()
    return {
        "id": sid,
        "pid": 0,
        "alive": False,
        "kind": "railway",
        "service": name,
        "strategy": "",
        "venue": "",
        "contract": "",
        "account": "",
        "account_name": "",
        "started_at": 0,
        "log": "",
        "params": {},
    }
