"""一次性脚本：把 edu 的 rag_documents 快照与 rag-go 真实状态对齐。

背景（2026-10-15 排查）：
    edu 侧 `RagDocument.ingest_status` 是**从知识库同步过来的快照**，
    但知识库侧的文档被删除时，edu 这边不会自动感知。
    一旦白名单（`_visible_rag_documents`）里混进知识库已不存在的 doc_id，
    `_search_via_external` 会把整批 doc_ids 传给知识库，知识库对任何一个
    未知 doc_id 直接返回 404 → **整单失败 → 全课程回落本地实现**。

    也就是说：一条脏快照就能毒化整个课程的外部检索。

本脚本做的事：
    对每条 ingest_status != 'failed' 的记录，向知识库查一次状态；
    知识库返回 404（文档不存在）就把本地快照标成 failed，
    使其被 `_visible_rag_documents` 排除。

用法：
    .venv/Scripts/python.exe scripts/_fix_rag_doc_status.py            # 只体检
    .venv/Scripts/python.exe scripts/_fix_rag_doc_status.py --apply    # 落库修正
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "platform.db"
RAG_BASE = "http://127.0.0.1:18000"


def probe(doc_id: str) -> str:
    """返回 'ok' / 'missing' / 'error:<reason>'。"""
    try:
        # trust_env=False：绕开本机 http_proxy，否则会打到代理上得到 502 假象
        with httpx.Client(base_url=RAG_BASE, timeout=10.0, trust_env=False) as client:
            resp = client.get(f"/api/v1/documents/{doc_id}/status")
        if resp.status_code == 200:
            return "ok"
        if resp.status_code == 404:
            return "missing"
        return f"error:HTTP {resp.status_code}"
    except Exception as exc:  # noqa: BLE001
        return f"error:{type(exc).__name__}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="落库修正（默认只体检）")
    args = parser.parse_args()

    if not DB_PATH.exists():
        print(f"[FAIL] 找不到数据库：{DB_PATH}")
        return 1

    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        "select id, rag_doc_id, library_name, course_id, ingest_status "
        "from rag_documents order by id"
    ).fetchall()

    print(f"共 {len(rows)} 条快照，逐个向知识库核对…\n")
    stale: list[tuple[int, str, str]] = []
    for row_id, rag_doc_id, library, course_id, status in rows:
        if status == "failed":
            print(f"  {rag_doc_id:<24} [{library}] 本地已 failed，跳过")
            continue
        verdict = probe(rag_doc_id)
        mark = {"ok": "OK  ", "missing": "脏  "}.get(verdict, "ERR ")
        print(f"  {rag_doc_id:<24} [{library}] 本地={status:<10} 知识库={verdict:<14} {mark}")
        if verdict == "missing":
            stale.append((row_id, rag_doc_id, library))

    print()
    if not stale:
        print("无需修正：快照与知识库一致。")
        return 0

    print(f"发现 {len(stale)} 条脏快照（知识库已无此文档）：")
    for _, rag_doc_id, library in stale:
        print(f"  - {rag_doc_id} [{library}]")

    if not args.apply:
        print("\n（体检模式）加 --apply 落库修正。")
        return 0

    for row_id, _, _ in stale:
        conn.execute("update rag_documents set ingest_status='failed' where id=?", (row_id,))
    conn.commit()
    print(f"\n已修正 {len(stale)} 条，全部标记为 failed（将被白名单排除）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
