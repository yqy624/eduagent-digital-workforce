"""通用 Pydantic Schema"""
from datetime import datetime
from typing import Any, Generic, List, Optional, TypeVar
from pydantic import BaseModel, ConfigDict, Field

from app.middleware.trace import current_trace_id

T = TypeVar("T")


class ApiResponse(BaseModel, Generic[T]):
    """统一 API 响应格式。

    trace_id 由中间件自动注入，前端可直接拿它来定位后端日志。
    """

    code: int = 200
    message: str = "success"
    data: Optional[T] = None
    trace_id: Optional[str] = Field(default_factory=current_trace_id)

    model_config = ConfigDict(protected_namespaces=())

    @staticmethod
    def ok(data: Any = None, message: str = "success"):
        return ApiResponse(code=200, message=message, data=data)

    @staticmethod
    def error(message: str = "error", code: int = 400):
        return ApiResponse(code=code, message=message, data=None)


class PaginatedResponse(BaseModel, Generic[T]):
    """分页响应"""
    items: List[T]
    total: int
    page: int
    page_size: int
    total_pages: int
