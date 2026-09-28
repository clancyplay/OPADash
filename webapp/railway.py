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

_SKIP_COPY = {
    "RAILWAY_TOKEN", "RAILWAY_API_TOKEN", "DASHBOARD_PASSWORD", "DASHBOARD_USERNAME",
    "DASHBOARD_SECRET", "DASHBOARD_COOKIE_DAYS", "PORT", "OPA6_ROOT", "OPA6_RAILWAY_SERVICE",
    "OPA6_GITHUB_REPO", "PATH", "PYTHONPATH", "PYTHONHOME", "HOME", "USER",
}
_SKIP_PREFIX = ("RAILWAY_", "BAL_")


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


def _keep_var(name: str) -> bool:
    n = name.upper()
    if n in _SKIP_COPY or n.startswith(_SKIP_PREFIX):
        return False
    if n.endswith("_API_KEY") or n.endswith("_API_SECRET") or n.endswith("_PASSPHRASE"):
        return False
    if "PASSWORD" in n or "SECRET" in n or "TOKEN" in n:
        return False
    return True


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


def _svc_name(strategy: str, contract: str, account: str) -> str:
    bits = ["dash", strategy, contract, account]
    raw = "-".join(str(b or "").strip() for b in bits if str(b or "").strip())
    safe = re.sub(r"[^a-zA-Z0-9-]+", "-", raw).strip("-")
    return (safe or "dash-bot")[:48].rstrip("-")


def _upsert_vars(service_id: str, knobs: dict[str, str]) -> None:
    pid, eid = _project_id(), _env_id()
    try:
        _gql(
            """
            mutation ($input: VariableCollectionUpsertInput!) {
              variableCollectionUpsert(input: $input)
            }
            """,
            {"input": {
                "projectId": pid,
                "environmentId": eid,
                "serviceId": service_id,
                "variables": knobs,
            }},
        )
        return
    except RuntimeError:
        pass
    for name, val in knobs.items():
        _gql(
            """
            mutation ($input: VariableUpsertInput!) {
              variableUpsert(input: $input)
            }
            """,
            {"input": {
                "projectId": pid,
                "environmentId": eid,
                "serviceId": service_id,
                "name": name,
                "value": val,
            }},
        )


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
    payload = {"repo": repo}
    try:
        _gql(
            """
            mutation ($id: String!, $input: ServiceSourceInput!) {
              serviceConnect(id: $id, input: $input) { id }
            }
            """,
            {"id": service_id, "input": payload},
        )
    except RuntimeError:
        payload["branch"] = source.get("branch") or "main"
        _gql(
            """
            mutation ($id: String!, $input: ServiceSourceInput!) {
              serviceConnect(id: $id, input: $input) { id }
            }
            """,
            {"id": service_id, "input": payload},
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
        "PYTHONUNBUFFERED": "1",
        "DASH_KIND": "opadash",
        "DASH_STRATEGY": strategy,
        "DASH_VENUE": venue,
        "DASH_CONTRACT": contract,
        "DASH_ACCOUNT": str(account.get("id") or account.get("name") or ""),
    }
    env[keys[0]] = account["api_key"]
    env[keys[1]] = account["api_secret"]
    env[keys[2]] = argv_tail[0] if strategy == "pair" else contract
    extra_pw = keys[3]
    if extra_pw:
        phrase = account.get("passphrase") or os.getenv(extra_pw) or ""
        if phrase:
            env[extra_pw] = phrase
    if strategy == "pair":
        opts = [t for t in argv_tail if t[:2] in ("C-", "P-")]
        env["PAIR_SYMBOL"] = ",".join(opts)
        if argv_tail and argv_tail[0][:2] not in ("C-", "P-"):
            env["CROP"] = argv_tail[0]
            if len(argv_tail) > 1:
                env["EXPIRY"] = argv_tail[1]
    for name, val in knobs.items():
        env[name] = val
    db = (os.getenv("DATABASE_URL") or "").strip()
    if db:
        env.setdefault("DATABASE_URL", db)
    rate = (os.getenv("USDINR_RATE") or "").strip()
    if rate:
        env.setdefault("USDINR_RATE", rate)
    return env


def _merge_template_vars(template_id: str, overlay: dict[str, str]) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        copied = _variables(template_id)
    except RuntimeError:
        copied = {}
    for name, val in copied.items():
        if _keep_var(name) and val != "":
            out[name] = val
    out.update(overlay)
    return out


def launch(
    *,
    venue: str,
    contract: str,
    strategy: str,
    account: dict,
    params: dict | None = None,
) -> dict:
    from webapp.launch import BOTS, VENUE_ENV, _pair_argv, _pin_geom, _scrub_params

    if strategy not in BOTS:
        raise ValueError(f"unknown strategy '{strategy}'")
    if not ready():
        raise RuntimeError(
            "On Railway, New contract creates a new OPA6 service. "
            "Set RAILWAY_TOKEN on OPADash (project token from railway.com/account/tokens)."
        )
    if not _env_id():
        raise RuntimeError("RAILWAY_ENVIRONMENT_ID is missing on this service")

    argv_tail = _pair_argv(contract) if strategy == "pair" else [contract]
    knobs = _pin_geom(_scrub_params(params))
    if strategy == "pair":
        if knobs.get("MAX_POSITION"):
            knobs.setdefault("PAIR_MAX", knobs["MAX_POSITION"])
        knobs.setdefault("PAIR_HEDGE", "true")

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
    env = _merge_template_vars(str(tmpl["id"]), overlay) if tmpl else overlay

    created = None
    try:
        created = _create_empty(name)
        sid = str(created["id"])
        _upsert_vars(sid, env)
        _set_start(sid, "python3 run.py")
        _connect(sid, source)
        try:
            _deploy(sid)
        except RuntimeError:
            pass
    except Exception:
        if created and created.get("id"):
            try:
                _delete(str(created["id"]))
            except Exception:
                pass
        raise

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
    }


def list_bots() -> list[dict]:
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
        if not name.lower().startswith("dash-"):
            continue
        inst = _instance_for_env(svc, eid)
        status = ""
        dep = inst.get("latestDeployment")
        if isinstance(dep, dict):
            status = str(dep.get("status") or "")
        alive = status.upper() not in ("CRASHED", "FAILED", "REMOVED", "SKIPPED")
        parts = name.split("-")
        strategy = parts[1] if len(parts) > 1 else ""
        contract = "-".join(parts[2:-1]) if len(parts) > 3 else ("-".join(parts[2:]) if len(parts) > 2 else "")
        account = parts[-1] if len(parts) > 3 else ""
        out.append({
            "id": str(svc.get("id") or ""),
            "pid": 0,
            "alive": alive,
            "kind": "railway",
            "strategy": strategy,
            "venue": "",
            "contract": contract,
            "account": account,
            "account_name": account,
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
