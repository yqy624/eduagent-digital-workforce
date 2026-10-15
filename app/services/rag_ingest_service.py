"""附件投递入库：把 edu 的文件交给外部知识库（rag-go）解析。

**为什么走 multipart 而不是官方推荐的 from-object**

``POST /api/v1/documents/from-object`` 的定位是"审核平台对接主路径"，
但它要求文件先在知识库的 MinIO 桶里。edu 目前**没有任何对象存储写入实现**
（附件落在本地磁盘），且两边 bucket 默认不一致（``education-files``
vs ``rag-docs``），照现状直接调会 400。multipart 让 edu 直接传字节，
这两个依赖都省掉；而且**单文件上传允许自定义 doc_id**，
可以带上业务语义，连映射表查询都能省一次。

**两个实测得出的硬约束（文档里没有）**

1. 逻辑库的 Milvus collection **只在 ``POST /libraries/enter`` 时创建**。
   ``POST /libraries`` 只把库名登记进 SQLite，不建向量集合。
   只调 create 的话，入库会在 embedding 阶段报
   ``can't find collection[course_N__text_chunks]``。
2. 入库**强依赖 Elasticsearch**（关键词索引），ES 不可达时整条入库 failed。
   ES 属于 rag-go 的部署前置条件，edu 侧只能如实上报失败原因。

注意：``enter`` 会顺带把该库设为服务端的全局 ``active_library``。
edu 检索时始终显式传 ``selected_libraries``，所以不受影响；
但若同一服务上还有别的调用方依赖 active_library，需知晓这一副作用。
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Optional
from uuid import uuid4

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import PROJECT_ROOT, settings
from app.core.http_client import client_kwargs
from app.models.ai_models import RagDocument
from app.models.models import StoredFile
from ai.rag.indexer import _stored_file_source_type

logger = logging.getLogger(__name__)

DOCUMENTS_PATH = "/api/v1/documents"
LIBRARIES_PATH = "/api/v1/libraries"
ENTER_PATH = "/api/v1/libraries/enter"
_ILLEGAL_DOC_ID_CHARS = re.compile(r"[^A-Za-z0-9_.-]")

# 各类入库终态
_TERMINAL_STATUSES = {"ready", "failed"}


def is_ingest_enabled() -> bool:
    """只有"外置检索开启 + 允许入库"时才投递，避免半接管状态。"""
    return (
        (settings.rag_backend or "").strip().lower() == "http-rag"
        and settings.rag_ingest_enabled
    )


def library_name_for(course_id: int) -> str:
    prefix = (settings.rag_library_prefix or "course_").strip()
    return f"{prefix}{course_id}"


def build_doc_id(course_id: int, file_id: int) -> str:
    """生成带业务语义的 doc_id。

    知识库要求 ``^[A-Za-z0-9_.-]+$`` 且不超过 120 字符。
    带 course/file 便于人工排查，尾部随机段保证重复入库不会撞号
    （同一文件被替换后重新入库应当是新文档，而不是覆盖）。
    """
    candidate = f"c{course_id}-f{file_id}-{uuid4().hex[:8]}"
    return _ILLEGAL_DOC_ID_CHARS.sub("-", candidate)[:120]


def _base_url() -> str:
    return (settings.rag_service_url or "").strip().rstrip("/")


def _timeout() -> httpx.Timeout:
    return httpx.Timeout(settings.rag_service_timeout_ms / 1000.0)


def _client(url: str, timeout: Optional[httpx.Timeout] = None) -> httpx.AsyncClient:
    """构造带 base_url 的客户端。

    路径常量是相对的（``/api/v1/documents``），必须靠 base_url 拼全，
    否则 httpx 会直接抛 "Request URL is missing an 'http://' protocol"。
    """
    return httpx.AsyncClient(
        base_url=url,
        timeout=timeout or _timeout(),
        **client_kwargs(url),
    )


async def _ensure_library(client: httpx.AsyncClient, library_name: str) -> None:
    """保证逻辑库存在，且其向量集合已创建。

    先 create 再 enter：create 幂等（已存在则跳过），enter 负责建集合。
    两者都不可省——见模块开头的约束 1。
    """
    resp = await client.post(LIBRARIES_PATH, json={"library_name": library_name})
    if resp.status_code >= 400:
        raise RuntimeError(_format_error("创建逻辑库", resp))

    resp = await client.post(ENTER_PATH, json={"library_name": library_name})
    if resp.status_code >= 400:
        raise RuntimeError(_format_error("初始化逻辑库", resp))


async def ingest_stored_file(
    db: AsyncSession,
    stored: StoredFile,
    *,
    absolute_path: Optional[str] = None,
) -> Optional[RagDocument]:
    """把已落盘的文件投递给知识库，返回映射记录。

    不抛异常：入库失败只记在 ``RagDocument.ingest_status`` 上，
    上传接口本身不该因为知识库不可用而失败——文件已经存好了。
    """
    if not is_ingest_enabled():
        return None
    if stored.course_id is None:
        # 没有课程归属就无法归档到某位学生/教师可见的库，不做投递
        return None

    if absolute_path is None:
        absolute_path = _resolve_abs_path(stored)
    if not absolute_path:
        logger.warning("附件找不到磁盘文件，跳过投递 file=%s", stored.id)
        return None

    library_name = library_name_for(stored.course_id)
    doc_id = build_doc_id(stored.course_id, stored.id)
    record = RagDocument(
        rag_doc_id=doc_id,
        library_name=library_name,
        course_id=stored.course_id,
        file_id=stored.id,
        submission_id=stored.submission_id,
        assignment_id=stored.assignment_id,
        source=stored.original_name,
        source_type=_stored_file_source_type(stored),
        filename=stored.original_name,
        ingest_status="pending",
        created_at=datetime.now(),
        updated_at=datetime.now(),
    )

    if not _base_url():
        record.ingest_status = "failed"
        record.ingest_error = "RAG_SERVICE_URL 未配置"
        db.add(record)
        await db.flush()
        return record

    try:
        async with _client(_base_url()) as client:
            await _ensure_library(client, library_name)
            with open(absolute_path, "rb") as handle:
                resp = await client.post(
                    DOCUMENTS_PATH,
                    files={"files": (stored.original_name, handle)},
                    data={
                        "library_name": library_name,
                        # 单文件上传才允许自定义 doc_id；不要传多文件
                        "doc_id": doc_id,
                        "chunk_strategy": "paragraph",
                    },
                )
        if resp.status_code >= 400:
            raise RuntimeError(_format_error("上传文档", resp))

        uploaded = (resp.json() or {}).get("uploaded") or []
        first = uploaded[0] if uploaded else {}
        # 以服务端回执为准：它分配/确认的 doc_id 才是知识库认的号
        if first.get("doc_id") and first["doc_id"] != doc_id:
            record.rag_doc_id = first["doc_id"]
        record.ingest_status = first.get("status") or "pending"
    except Exception as exc:  # noqa: BLE001
        logger.warning("投递知识库失败 course=%s file=%s: %s", stored.course_id, stored.id, exc)
        record.ingest_status = "failed"
        record.ingest_error = str(exc)[:1000]

    db.add(record)
    await db.flush()
    return record


async def refresh_ingest_status(db: AsyncSession, record: RagDocument) -> str:
    """把知识库的入库状态同步回映射表。返回最新状态。"""
    if not _base_url() or record.ingest_status in _TERMINAL_STATUSES:
        return record.ingest_status

    try:
        async with _client(_base_url(), timeout=httpx.Timeout(10.0)) as client:
            resp = await client.get(f"{DOCUMENTS_PATH}/{record.rag_doc_id}/status")
        if resp.status_code >= 400:
            return record.ingest_status
        body = resp.json() or {}
        record.ingest_status = body.get("status") or record.ingest_status
        record.ingest_error = body.get("error")
    except Exception as exc:  # noqa: BLE001
        logger.debug("查询入库状态失败 doc=%s: %s", record.rag_doc_id, exc)
    record.updated_at = datetime.now()
    await db.flush()
    return record.ingest_status


async def pending_documents(db: AsyncSession, limit: int = 50) -> list[RagDocument]:
    """取出尚未到终态的映射记录，供后台轮询收敛状态。"""
    result = await db.execute(
        select(RagDocument)
        .where(RagDocument.ingest_status.in_(("pending", "processing")))
        .order_by(RagDocument.id)
        .limit(limit)
    )
    return list(result.scalars().all())


def _format_error(action: str, resp: httpx.Response) -> str:
    """rag-go 的错误统一是 ``{"detail": ...}``，detail 可能是字符串或数组。"""
    try:
        detail = (resp.json() or {}).get("detail")
        if isinstance(detail, list) and detail:
            first = detail[0] or {}
            return f"{action}失败：{first.get('msg') or first}"
        if detail:
            return f"{action}失败：{detail}"
    except Exception:  # noqa: BLE001
        pass
    return f"{action}失败：HTTP {resp.status_code} {resp.text[:200]}"


def _resolve_abs_path(stored: StoredFile) -> Optional[str]:
    """解析附件在磁盘上的绝对路径。

    规则与 ``routers/files.py:_resolve_stored_path`` 一致，但不复用它的
    函数——那边会反过来 import 本模块，直接引用会形成循环导入。
    """
    root = settings.upload_path.resolve()
    key = stored.object_key or ""
    candidate = (
        root / key
        if key and not Path(key).is_absolute()
        else Path(stored.storage_path)
    )
    if not key:
        candidate = PROJECT_ROOT / stored.storage_path
    resolved = candidate.resolve()
    if root != resolved and root not in resolved.parents:
        return None
    return str(resolved) if resolved.is_file() else None


# ------------------------------------------------------------
# 后台投递
# ------------------------------------------------------------
# 上传接口不应该等知识库解析完才返回：解析可能要 OCR 几十页。
# 这里 fire-and-forget，投递结果只体现在 rag_documents.ingest_status 上。

_background_tasks: set[asyncio.Task] = set()

# 投递后跟踪入库进度：知识库是异步解析，不主动收敛状态的话，
# rag_documents.ingest_status 会一直停在 pending。
_POLL_INTERVAL_S = 3.0
_POLL_MAX_ATTEMPTS = 40  # ≈2 分钟，覆盖常规 PDF 的 OCR + 向量化


async def _poll_until_terminal(record_id: int) -> None:
    """轮询入库状态直到终态，超次数后放弃（状态可由补偿任务再收敛）。"""
    from app.database import async_session_factory

    for _ in range(_POLL_MAX_ATTEMPTS):
        await asyncio.sleep(_POLL_INTERVAL_S)
        async with async_session_factory() as session:
            record = await session.get(RagDocument, record_id)
            if record is None:
                return
            status = await refresh_ingest_status(session, record)
            await session.commit()
            if status in _TERMINAL_STATUSES:
                logger.info(
                    "知识库入库完成 doc=%s status=%s", record.rag_doc_id, status
                )
                return
    logger.warning("入库状态轮询超时，doc_id 记录 id=%s 交给补偿任务", record_id)


async def _deliver_by_file_id(file_id: int) -> None:
    """后台任务的实体：自建数据库会话，不依赖请求生命周期。"""
    from app.database import async_session_factory

    try:
        record_id: Optional[int] = None
        async with async_session_factory() as session:
            stored = await session.get(StoredFile, file_id)
            if stored is None:
                return
            record = await ingest_stored_file(session, stored)
            await session.commit()
            if record is not None:
                record_id = record.id
        if record_id is not None:
            await _poll_until_terminal(record_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("后台投递知识库异常 file=%s: %s", file_id, exc)


def schedule_ingest(file_id: int) -> None:
    """把投递排进事件循环。

    任务引用必须自己持有：``asyncio`` 只保留弱引用，
    否则任务可能在完成前被垃圾回收掉。
    """
    if not is_ingest_enabled():
        return
    task = asyncio.create_task(_deliver_by_file_id(file_id))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


__all__ = [
    "build_doc_id",
    "ingest_stored_file",
    "is_ingest_enabled",
    "library_name_for",
    "pending_documents",
    "refresh_ingest_status",
    "schedule_ingest",
]
