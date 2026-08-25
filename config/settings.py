import os
from dataclasses import dataclass
from pathlib import Path


def load_env_file() -> None:
    """OPADash/.env wins. Fallback: sibling OPA3 then OPA6 .env (same Railway DB)."""
    here = Path(__file__).resolve().parent.parent
    for path in (here.parent / "OPA3" / ".env", here.parent / "OPA6" / ".env", here / ".env"):
        if not path.exists():
            continue
        overwrite = path.resolve().parent == here
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, value = line.split("=", 1)
            name, value = name.strip(), value.strip()
            if value and value[0] not in ('"', "'"):
                value = value.split("#")[0].strip()
            else:
                value = value.strip('"').strip("'")
            if overwrite:
                os.environ[name] = value
            else:
                os.environ.setdefault(name, value)


def _bool_env(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


@dataclass(frozen=True)
class Settings:
    database_url: str
    usdinr_rate: float
    delta_rest_url: str
    binance_rest_url: str
    report_interval_seconds: float

    @classmethod
    def from_env(cls) -> "Settings":
        load_env_file()
        return cls(
            database_url=os.getenv("DATABASE_URL", ""),
            usdinr_rate=float(os.getenv("USDINR_RATE", "87")),
            delta_rest_url=os.getenv("DELTA_REST_URL", "https://api.india.delta.exchange"),
            binance_rest_url=os.getenv("BINANCE_REST_URL", "https://fapi.binance.com"),
            report_interval_seconds=float(os.getenv("REPORT_INTERVAL_SECONDS", "300")),
        )
