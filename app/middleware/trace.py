"""链路追踪中间件。

给每个请求分配 trace_id，用于串联日志与接口返回。
排查"某个视觉任务为什么失败"时，前端拿到 trace_id 就能直接定位后端日志。
"""

from __future__ import annotations

import time
import uuid
from contextvars import ContextVar

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

TRACE_ID_HEADER = "X-Trace-Id"

trace_id_var: ContextVar[str] = ContextVar("trace_id", default="")


def current_trace_id() -> str:
    value = trace_id_var.get()
    return value or ""


class TraceMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        incoming = request.headers.get(TRACE_ID_HEADER, "").strip()
        token = incoming or uuid.uuid4().hex
        trace_id_var.set(token)

        started = time.perf_counter()
        try:
            response = await call_next(request)
        finally:
            elapsed_ms = (time.perf_counter() - started) * 1000
            request.state.trace_id = token
            request.state.elapsed_ms = elapsed_ms
        response.headers[TRACE_ID_HEADER] = token
        return response
