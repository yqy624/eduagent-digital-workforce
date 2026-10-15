"""日志配置。

统一格式 + trace_id 注入：一条日志能直接对应到一次接口请求，
排查模型调用失败时不用在日志海里捞。
"""

from __future__ import annotations

import logging
import sys

from app.middleware.trace import current_trace_id

_LOG_FORMAT = (
    "%(asctime)s | %(levelname)-7s | trace=%(trace_id)s | "
    "%(name)s:%(lineno)d | %(message)s"
)
_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"


class TraceIdFilter(logging.Filter):
    """把当前请求的 trace_id 注入日志记录。"""

    def filter(self, record: logging.LogRecord) -> bool:
        if not hasattr(record, "trace_id"):
            record.trace_id = current_trace_id() or "-"
        return True


def setup_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter(_LOG_FORMAT, datefmt=_DATE_FORMAT))
    handler.addFilter(TraceIdFilter())

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(getattr(logging, level.upper(), logging.INFO))

    # 第三方库太吵，压到 WARNING
    for noisy in ("uvicorn.access", "sqlalchemy.engine", "httpx"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
