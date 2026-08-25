import logging
import os
import sys
import io
from datetime import datetime, timedelta, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path

IST = timezone(timedelta(hours=5, minutes=30))


class _ISTFormatter(logging.Formatter):
    """Logging formatter that emits timestamps in IST (UTC+5:30)."""
    def formatTime(self, record: logging.LogRecord, datefmt: str | None = None) -> str:
        dt = datetime.fromtimestamp(record.created, tz=IST)
        if datefmt:
            return dt.strftime(datefmt)
        return dt.strftime("%Y-%m-%d %H:%M:%S,%f")[:-3]  # milliseconds, no tz suffix


class _SafeStreamHandler(logging.StreamHandler):
    """StreamHandler that replaces unencodable chars instead of crashing (Windows cp1252)."""
    def emit(self, record: logging.LogRecord) -> None:
        try:
            super().emit(record)
        except UnicodeEncodeError:
            try:
                msg = self.format(record) + self.terminator
                enc = getattr(self.stream, "encoding", "utf-8") or "utf-8"
                self.stream.write(msg.encode(enc, errors="replace").decode(enc))
                self.flush()
            except Exception:
                self.handleError(record)


def setup_logging() -> None:
    Path("logs").mkdir(exist_ok=True)
    timestamp = datetime.now(IST).strftime("%Y%m%d_%H%M%S")
    log_file = f"logs/bot_{timestamp}.log"
    formatter = _ISTFormatter("%(asctime)s %(levelname)s %(name)s %(message)s")

    file_handler = RotatingFileHandler(log_file, maxBytes=50_000_000, backupCount=0)
    file_handler.setFormatter(formatter)

    console_handler = _SafeStreamHandler(stream=sys.stdout)
    console_handler.setFormatter(formatter)

    log_level = os.getenv("LOG_LEVEL", "INFO")
    logging.basicConfig(level=getattr(logging, log_level), handlers=[file_handler, console_handler])

    logging.getLogger("websockets").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)


class DBLogHandler(logging.Handler):
    """Buffers log records in memory; a background task flushes them to Postgres."""

    _SKIP_NAMES = ("utils.events_db", "asyncpg")

    def __init__(self, service: str, maxlen: int = 2000) -> None:
        super().__init__(level=logging.INFO)
        from collections import deque
        self.service = service
        self.buf = deque(maxlen=maxlen)

    def emit(self, record: logging.LogRecord) -> None:
        if any(record.name.startswith(n) for n in self._SKIP_NAMES):
            return  # avoid feedback loop from the DB writer itself
        try:
            msg = record.getMessage()
            if record.exc_info and record.exc_info[0] is not None:
                import traceback
                msg += "\n" + "".join(traceback.format_exception(*record.exc_info)).rstrip()
            self.buf.append((
                datetime.fromtimestamp(record.created, tz=timezone.utc),
                self.service,
                record.levelname[:10],
                record.name[:120],
                msg[:4000],
            ))
        except Exception:
            pass


def start_db_log_forwarder(events_db, service: str, interval: float = 2.0):
    """Attach a DBLogHandler to the root logger and return an asyncio flush task."""
    import asyncio

    handler = DBLogHandler(service)
    logging.getLogger().addHandler(handler)

    async def _flusher() -> None:
        while True:
            try:
                await asyncio.sleep(interval)
                if handler.buf:
                    rows = []
                    while handler.buf and len(rows) < 500:
                        rows.append(handler.buf.popleft())
                    await events_db.insert_log_rows(rows)
            except asyncio.CancelledError:
                if handler.buf:  # final drain on shutdown
                    await events_db.insert_log_rows(list(handler.buf))
                raise
            except Exception:
                pass

    return asyncio.create_task(_flusher(), name=f"db_log_forwarder_{service}")
