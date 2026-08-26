"""Course document indexing helpers."""
from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

from langchain_core.documents import Document
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import PROJECT_ROOT, settings
from app.models.ai_models import AiDocumentChunk, AiIndexJob
from app.models.models import Assignment, StoredFile, Submission, User
from ai.rag.loader import DocumentLoader, TextSplitter
from ai.rag.vector_store import VectorStoreManager


def resolve_material_path(file: StoredFile) -> Optional[Path]:
    raw = Path(file.storage_path)
    candidates = []
    if raw.is_absolute():
        candidates.append(raw)
    else:
        candidates.append(PROJECT_ROOT / raw)
        if file.object_key:
            candidates.append(settings.upload_path / file.object_key)
    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved.exists() and resolved.is_file():
            return resolved
    return None


def assignment_material_text(assignment: Assignment) -> str:
    due_date = assignment.due_date.isoformat() if assignment.due_date else "未设置"
    total_points = assignment.total_points if assignment.total_points is not None else "未设置"
    description = (assignment.description or "暂无要求").strip()
    detail = (assignment.detail or "暂无详情").strip()
    return (
        f"作业标题：{assignment.title}\n"
        f"作业要求：{description}\n"
        f"作业详情：{detail}\n"
        f"截止时间：{due_date}\n"
        f"总分：{total_points}"
    )


def _stored_file_source_type(file: StoredFile) -> str:
    if file.category == "ASSIGNMENT_ATTACHMENT":
        return "assignment_attachment"
    if file.category == "SUBMISSION_ATTACHMENT":
        return "submission_attachment"
    return "course_material"


def _stored_file_vector_id(course_id: int, file: StoredFile, chunk_index: int) -> str:
    if file.submission_id:
        return f"course:{course_id}:submission:{file.submission_id}:file:{file.id}:chunk:{chunk_index}"
    if file.assignment_id:
        return f"course:{course_id}:assignment:{file.assignment_id}:file:{file.id}:chunk:{chunk_index}"
    return f"course:{course_id}:file:{file.id}:chunk:{chunk_index}"


def _doc_metadata(course_id: int, chunk: AiDocumentChunk, extra: Dict[str, Any]) -> Dict[str, Any]:
    metadata = {
        "course_id": course_id,
        "document_id": chunk.file_id,
        "file_id": chunk.file_id,
        "chunk_index": chunk.chunk_index,
        "source": chunk.source,
        "source_type": chunk.source_type,
    }
    metadata.update({key: value for key, value in extra.items() if value is not None})
    return metadata


async def reindex_course_documents(db: AsyncSession, course_id: int) -> Dict[str, Any]:
    """Rebuild DB chunks and the FAISS collection for a course."""
    file_result = await db.execute(
        select(StoredFile)
        .where(StoredFile.course_id == course_id)
        .order_by(StoredFile.created_at.desc(), StoredFile.id.desc())
    )
    files = list(file_result.scalars().all())

    assignment_result = await db.execute(
        select(Assignment)
        .where(Assignment.course_id == course_id)
        .order_by(Assignment.created_at.desc(), Assignment.id.desc())
    )
    assignments = list(assignment_result.scalars().all())

    submission_result = await db.execute(
        select(Submission, Assignment, User)
        .join(Assignment, Assignment.id == Submission.assignment_id)
        .join(User, User.id == Submission.student_id)
        .where(Assignment.course_id == course_id, Submission.content.isnot(None))
        .order_by(Submission.submitted_at.desc(), Submission.id.desc())
    )
    submissions = list(submission_result.all())

    loader = DocumentLoader()
    splitter = TextSplitter(chunk_size=700, chunk_overlap=80)
    vector_store = VectorStoreManager()
    vector_store.delete_collection(f"course_{course_id}")
    await db.execute(delete(AiDocumentChunk).where(AiDocumentChunk.course_id == course_id))

    indexed_items = []
    total_chunks = 0

    for file in files:
        job = AiIndexJob(
            file_id=file.id,
            course_id=course_id,
            status="RUNNING",
            created_at=datetime.now(),
        )
        db.add(job)
        await db.flush()

        path = resolve_material_path(file)
        if path is None:
            job.status = "FAILED"
            job.error_message = "文件不存在"
            job.finished_at = datetime.now()
            indexed_items.append({"file_id": file.id, "name": file.original_name, "status": "FAILED", "error": job.error_message})
            continue

        text = loader.load(str(path))
        if not text:
            job.status = "FAILED"
            job.error_message = "无法解析文件内容"
            job.finished_at = datetime.now()
            indexed_items.append({"file_id": file.id, "name": file.original_name, "status": "FAILED", "error": job.error_message})
            continue

        source_type = _stored_file_source_type(file)
        chunks = [chunk.strip() for chunk in splitter.split_text(text) if chunk and chunk.strip()]
        doc_chunks = []
        for index, content in enumerate(chunks):
            chunk = AiDocumentChunk(
                course_id=course_id,
                file_id=file.id,
                chunk_index=index,
                content=content,
                content_hash=VectorStoreManager.compute_content_hash(content),
                source=file.original_name,
                source_type=source_type,
                char_count=len(content),
                vector_id=_stored_file_vector_id(course_id, file, index),
                created_at=datetime.now(),
            )
            db.add(chunk)
            doc_chunks.append(chunk)

        vector_status = "SKIPPED"
        vector_error = None
        if doc_chunks:
            docs = [
                Document(
                    page_content=chunk.content or "",
                    metadata=_doc_metadata(
                        course_id,
                        chunk,
                        {
                            "assignment_id": file.assignment_id,
                            "submission_id": file.submission_id,
                            "category": file.category,
                        },
                    ),
                )
                for chunk in doc_chunks
            ]
            try:
                vector_store.add_documents(docs, collection_name=f"course_{course_id}")
                vector_status = "INDEXED"
            except Exception as exc:
                vector_error = str(exc)

        job.status = "COMPLETED"
        job.total_chunks = len(doc_chunks)
        job.finished_at = datetime.now()
        total_chunks += len(doc_chunks)
        indexed_items.append({
            "file_id": file.id,
            "assignment_id": file.assignment_id,
            "submission_id": file.submission_id,
            "name": file.original_name,
            "source_type": source_type,
            "status": "COMPLETED",
            "chunk_count": len(doc_chunks),
            "vector_status": vector_status,
            "vector_error": vector_error,
        })

    for assignment in assignments:
        text = assignment_material_text(assignment)
        chunks = [chunk.strip() for chunk in splitter.split_text(text) if chunk and chunk.strip()]
        doc_chunks = []
        document_id = -assignment.id
        for index, content in enumerate(chunks):
            chunk = AiDocumentChunk(
                course_id=course_id,
                file_id=document_id,
                chunk_index=index,
                content=content,
                content_hash=VectorStoreManager.compute_content_hash(content),
                source=f"作业：{assignment.title}",
                source_type="assignment",
                char_count=len(content),
                vector_id=f"course:{course_id}:assignment:{assignment.id}:chunk:{index}",
                created_at=datetime.now(),
            )
            db.add(chunk)
            doc_chunks.append(chunk)

        vector_status = "SKIPPED"
        vector_error = None
        if doc_chunks:
            docs = [
                Document(
                    page_content=chunk.content or "",
                    metadata=_doc_metadata(
                        course_id,
                        chunk,
                        {
                            "assignment_id": assignment.id,
                            "source_type": "assignment",
                        },
                    ),
                )
                for chunk in doc_chunks
            ]
            try:
                vector_store.add_documents(docs, collection_name=f"course_{course_id}")
                vector_status = "INDEXED"
            except Exception as exc:
                vector_error = str(exc)

        total_chunks += len(doc_chunks)
        indexed_items.append({
            "file_id": document_id,
            "assignment_id": assignment.id,
            "name": f"作业：{assignment.title}",
            "source_type": "assignment",
            "status": "COMPLETED",
            "chunk_count": len(doc_chunks),
            "vector_status": vector_status,
            "vector_error": vector_error,
        })

    for submission, assignment, student in submissions:
        text = (submission.content or "").strip()
        if not text:
            continue
        chunks = [chunk.strip() for chunk in splitter.split_text(text) if chunk and chunk.strip()]
        doc_chunks = []
        document_id = -1_000_000 - submission.id
        source = f"提交：{assignment.title} / {student.display_name or student.username}"
        for index, content in enumerate(chunks):
            chunk = AiDocumentChunk(
                course_id=course_id,
                file_id=document_id,
                chunk_index=index,
                content=content,
                content_hash=VectorStoreManager.compute_content_hash(content),
                source=source,
                source_type="submission_text",
                char_count=len(content),
                vector_id=f"course:{course_id}:submission:{submission.id}:text:chunk:{index}",
                created_at=datetime.now(),
            )
            db.add(chunk)
            doc_chunks.append(chunk)

        vector_status = "SKIPPED"
        vector_error = None
        if doc_chunks:
            docs = [
                Document(
                    page_content=chunk.content or "",
                    metadata=_doc_metadata(
                        course_id,
                        chunk,
                        {
                            "assignment_id": assignment.id,
                            "submission_id": submission.id,
                            "student_id": submission.student_id,
                            "source_type": "submission_text",
                        },
                    ),
                )
                for chunk in doc_chunks
            ]
            try:
                vector_store.add_documents(docs, collection_name=f"course_{course_id}")
                vector_status = "INDEXED"
            except Exception as exc:
                vector_error = str(exc)

        total_chunks += len(doc_chunks)
        indexed_items.append({
            "file_id": document_id,
            "assignment_id": assignment.id,
            "submission_id": submission.id,
            "name": source,
            "source_type": "submission_text",
            "status": "COMPLETED",
            "chunk_count": len(doc_chunks),
            "vector_status": vector_status,
            "vector_error": vector_error,
        })

    return {
        "course_id": course_id,
        "file_count": len(files),
        "assignment_count": len(assignments),
        "submission_count": len(submissions),
        "chunk_count": total_chunks,
        "indexed_files": indexed_items,
        "message": None if indexed_items else "该课程暂无可索引的上传资料、作业内容或提交内容",
    }
