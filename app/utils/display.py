"""界面显示值：把服务端句柄收敛成可公开的名字。

为什么需要这一层
----------------
`source_ref` / `storage_path` / `file_paths` 这类字段是**服务端自己的句柄**：后端要靠它
重新定位文件，所以历史上什么形态都出现过 —— 相对对象键（`data/samples/lab.jpg`）、
上传目录相对路径（`uploads/2026/10/09/ab12cd.jpg`），甚至整条本机绝对路径
（`C:/Users/<用户名>/Desktop/...`、`/home/<用户名>/...`）。

原样下发给浏览器有三个问题：

1. **泄漏**：用户名、盘符、部署目录结构会进入页面、截图、浏览器缓存与工单；
2. **无用**：使用者要的是「这是哪个文件」，不是「它在我磁盘的哪儿」；
3. **会放大**：前端一旦把它当展示值，路径就跟着进了截图和对外文档。

因此约定：**接口只下发 `public_file_name()` / `public_file_names()` 处理过的名字，
路径本身留在服务端。** 需要下载或预览时走 `file_id`，不要下发路径。
"""

from __future__ import annotations

import json
from typing import Any, List

UNKNOWN = "—"


def _segments(text: str) -> List[str]:
    """把各种写法的引用切成路径片段，丢掉查询串、锚点与 . / .. 。"""
    text = text.strip().strip('"').strip("'")
    text = text.split("?", 1)[0].split("#", 1)[0]
    if "://" in text:
        # http(s)://host/a/b.jpg → a/b.jpg（主机名不当文件名）
        text = text.split("://", 1)[1]
        text = text.split("/", 1)[1] if "/" in text else ""
    text = text.replace("\\", "/").rstrip("/")
    return [seg for seg in text.split("/") if seg not in ("", ".", "..")]


def _parse_list(text: str):
    """把 JSON 数组字符串解析成列表；不是数组则返回 None。"""
    if not text.startswith("["):
        return None
    try:
        parsed = json.loads(text)
    except (ValueError, TypeError):
        return None
    return parsed if isinstance(parsed, list) else None


def _name_from_text(text: str, fallback: str) -> str:
    segments = _segments(text)
    if not segments:
        return fallback
    name = segments[-1]
    # 只有盘符（C: / D:）不算文件名
    if len(name) == 2 and name[1] == ":" and name[0].isalpha():
        return fallback
    return name


def public_file_name(ref: Any, fallback: str = UNKNOWN) -> str:
    """把任意服务端引用收敛成「文件名」级别、可以安全下发的字符串。"""
    if ref is None:
        return fallback
    if isinstance(ref, (list, tuple, set)):
        return public_file_names(ref, fallback)
    text = str(ref).strip()
    if not text:
        return fallback
    parsed = _parse_list(text)
    if parsed is not None:
        # 多附件被误当单值传进来时合并展示，比只留最后一段更诚实
        return public_file_names(parsed, fallback)
    return _name_from_text(text, fallback)


def public_file_names(refs: Any, fallback: str = UNKNOWN) -> str:
    """同 :func:`public_file_name`，但接受列表或 JSON 数组字符串，多个名字用顿号连接。"""
    if refs is None:
        return fallback
    if isinstance(refs, str):
        raw = refs.strip()
        if not raw:
            return fallback
        parsed = _parse_list(raw)
        refs = parsed if parsed is not None else raw
    if isinstance(refs, (list, tuple, set)):
        names = [public_file_name(item, "") for item in refs]
        names = [name for name in names if name]
        return "、".join(names) if names else fallback
    if isinstance(refs, str):
        return _name_from_text(refs, fallback)
    return public_file_name(refs, fallback)
