"""出站 HTTP 调用的公共约定。

**为什么要单独一个模块**：本机与不少开发环境都设了 ``HTTP_PROXY`` /
``HTTPS_PROXY``（本机实测有 ``http_proxy=http://127.0.0.1:<port>``）。
httpx 默认 ``trust_env=True``，会把**发往 127.0.0.1 的请求也塞进代理**，
表现出来是一串与业务无关的怪错：

- 502 Bad Gateway（代理不认识这个后端）
- ``Request URL is missing an 'http://' or 'https://' protocol``（代理拒绝转发）

这类错误很难从堆栈看出根因，所以统一在这里处理：**回环地址直连，
其余地址仍然尊重环境代理**（跨机部署时可能确实需要代理）。
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", "0.0.0.0", "[::1]"}


def is_loopback(url: str) -> bool:
    """判断目标是否为回环地址。解析不出主机名时按"非回环"处理（保守）。"""
    try:
        host = (urlparse(url).hostname or "").strip().lower()
    except Exception:  # noqa: BLE001
        return False
    return host in _LOOPBACK_HOSTS


def client_kwargs(url: str) -> dict[str, Any]:
    """构造 ``httpx.AsyncClient`` 的代理相关参数。"""
    return {"trust_env": not is_loopback(url)}


__all__ = ["client_kwargs", "is_loopback"]
