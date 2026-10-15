"""AI 路由 — RAG 问答、学情诊断、学习计划、批改建议"""
import json
import logging
import re
import time
from uuid import uuid4
from datetime import datetime
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.config import settings
from app.core.models.contracts import RetrievalRequest
from app.core.models.registry import get_retrieval_provider
from app.middleware.auth import get_current_user, require_teacher
from app.models.models import Assignment, Course, Enrollment, Notification, PeerReview, Submission, User
from app.models.ai_models import (
    AiDocumentChunk,
    AiGradingSuggestion,
    AiQaLog,
    RagDocument,
)
from app.schemas.assignment import GradeRequest
from app.schemas.ai import (
    AgentChatRequest,
    AgentChatResponse,
    DiagnosisResponse,
    FeedbackUpdateRequest,
    GradingSuggestionResponse,
    LearningPlanResponse,
    QAResponse,
    QARequest,
)
from app.schemas.common import ApiResponse
from app.services.teacher_service import TeacherService
from app.services.ai_tool_service import AiToolService
from ai.llm import get_llm
from ai.agents.runtime import AgentRuntime
from ai.rag.vector_store import VectorStoreManager
from ai.rag.indexer import reindex_course_documents
from ai.workflows.learning_plan_chain import build_learning_plan_chain, LearningPlanState
from ai.workflows.grading_chain import build_grading_chain, GradingState

router = APIRouter(prefix="/api/ai", tags=["AI 智能助手"])

logger = logging.getLogger(__name__)


async def _ensure_course_access(db: AsyncSession, course_id: int, user: User) -> Course:
    result = await db.execute(select(Course).where(Course.id == course_id))
    course = result.scalar_one_or_none()
    if course is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Course not found")
    if user.role == "ADMIN":
        return course
    if user.role == "TEACHER" and course.teacher_id == user.id:
        return course
    if user.role == "STUDENT":
        enrolled = await db.execute(
            select(Enrollment.id).where(
                Enrollment.course_id == course_id,
                Enrollment.student_id == user.id,
            )
        )
        if enrolled.scalar_one_or_none() is not None:
            return course
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No permission for this course")


async def _ensure_student_ai_access(
    db: AsyncSession,
    student_id: int,
    user: User,
    course_id: Optional[int] = None,
) -> None:
    student_result = await db.execute(
        select(User.id).where(User.id == student_id, User.role == "STUDENT")
    )
    if student_result.scalar_one_or_none() is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student not found")
    if user.role == "ADMIN":
        return
    if user.role == "STUDENT":
        if student_id != user.id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No permission for this student")
        if course_id is not None:
            await _ensure_course_access(db, course_id, user)
        return
    if user.role == "TEACHER":
        if course_id is not None:
            course = await _ensure_course_access(db, course_id, user)
            enrolled = await db.execute(
                select(Enrollment.id).where(
                    Enrollment.course_id == course.id,
                    Enrollment.student_id == student_id,
                )
            )
        else:
            enrolled = await db.execute(
                select(Enrollment.id)
                .join(Course, Course.id == Enrollment.course_id)
                .where(Enrollment.student_id == student_id, Course.teacher_id == user.id)
                .limit(1)
            )
        if enrolled.scalar_one_or_none() is not None:
            return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No permission for this student")


async def _ensure_teacher_submission_access(
    db: AsyncSession,
    submission_id: int,
    user: User,
) -> None:
    result = await db.execute(
        select(Submission, Assignment, Course)
        .join(Assignment, Assignment.id == Submission.assignment_id)
        .join(Course, Course.id == Assignment.course_id)
        .where(Submission.id == submission_id)
    )
    row = result.first()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Submission not found")
    _, _, course = row
    if user.role != "ADMIN" and course.teacher_id != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No permission for this submission")


async def _ensure_teacher_feedback_access(
    db: AsyncSession,
    suggestion_id: int,
    user: User,
) -> AiGradingSuggestion:
    result = await db.execute(
        select(AiGradingSuggestion)
        .where(AiGradingSuggestion.id == suggestion_id)
    )
    suggestion = result.scalar_one_or_none()
    if suggestion is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Feedback not found")
    await _ensure_teacher_submission_access(db, suggestion.submission_id, user)
    return suggestion


# ============================================================
# 检索：外部知识库优先，本地实现兜底
# ============================================================
#
# 分工：外部知识库（rag-go）负责解析/切块/embedding/召回/重排，
# edu 只负责「权限判定」与「业务语义还原」。
#
# 权限必须**前置收窄**：先在本课程可见文档里算出白名单，
# 再把 doc_ids 传过去，而不是等结果回来再过滤——
# 后者会让召回数量被动缩水，且越权内容已经在网络上流转过了。


def _external_retrieval_enabled() -> bool:
    return (settings.rag_backend or "").strip().lower() == "http-rag"


def _library_name_for(course_id: int) -> str:
    """课程到逻辑库的映射。需与知识库侧约定一致（默认 course_{id}）。"""
    prefix = (settings.rag_library_prefix or "course_").strip()
    return f"{prefix}{course_id}"


async def _visible_rag_documents(
    db: AsyncSession,
    course_id: int,
    user: Optional[User],
) -> List[RagDocument]:
    """算出该用户在本课程可见的知识库文档白名单。

    规则与本地实现保持一致，但判定依据从 ``vector_id`` 正则
    （``re.search(r":submission:(\\d+):", ...)``）换成了结构化的
    ``submission_id`` 列——同样语义，但不再依赖字符串格式。
    """
    result = await db.execute(
        select(RagDocument).where(
            RagDocument.course_id == course_id,
            # 只排除确定失败的；pending/processing 也要放行。
            # 理由：知识库侧才是"哪些 chunk 已索引"的权威，edu 这里的状态
            # 只是同步过来的快照，可能滞后。若只认 ready，新上传的文件在
            # 状态同步完成前会整段时间检索不到，甚至永久检索不到。
            RagDocument.ingest_status != "failed",
        )
    )
    documents = list(result.scalars().all())

    if user is None or user.role != "STUDENT":
        # 教师（课程 owner）与 ADMIN 可见本课程全部资料
        return documents

    own_submission_ids = set(
        (
            await db.execute(
                select(Submission.id)
                .join(Assignment, Assignment.id == Submission.assignment_id)
                .where(
                    Assignment.course_id == course_id,
                    Submission.student_id == user.id,
                )
            )
        ).scalars().all()
    )
    review_submission_ids = set(
        (
            await db.execute(
                select(PeerReview.target_submission_id)
                .join(Submission, Submission.id == PeerReview.target_submission_id)
                .join(Assignment, Assignment.id == Submission.assignment_id)
                .where(
                    Assignment.course_id == course_id,
                    PeerReview.reviewer_id == user.id,
                )
            )
        ).scalars().all()
    )
    allowed_submission_ids = own_submission_ids | review_submission_ids

    return [
        doc
        for doc in documents
        # submission_id 为空 = 课程资料/作业附件，全班可见；
        # 非空 = 学生提交，仅提交者与互评人可见
        if doc.submission_id is None or doc.submission_id in allowed_submission_ids
    ]


async def _search_via_external(
    db: AsyncSession,
    course_id: int,
    question: str,
    user: Optional[User],
    max_citations: int,
) -> tuple[Optional[List[Dict[str, Any]]], str]:
    """走外部知识库检索。

    返回值语义（调用方据此决定是否回落本地）：
    - ``(None, 原因)``  外置不可用／本课程尚未入库 → 应回落本地
    - ``(列表, "")``    外置正常回答，列表可能为空（确实没有相关材料）
    """
    documents = await _visible_rag_documents(db, course_id, user)
    if not documents:
        # 该课程还没往知识库投递过 → 说明还没迁移，交给本地实现，
        # 这样外置可以按课程逐步灰度，而不是一刀切
        return None, "no-documents-in-library"

    by_doc_id = {doc.rag_doc_id: doc for doc in documents}

    provider = get_retrieval_provider("http-rag")
    request = RetrievalRequest(
        query=question,
        libraries=[_library_name_for(course_id)],
        doc_ids=list(by_doc_id),
        text_top_k=min(20, max(1, max_citations * 3)),
    )
    result = await provider.invoke(request)
    if not result.ok or result.data is None:
        error = result.error
        return None, f"{error.kind.value}: {error.message}" if error else "unknown-error"

    # 图片按文档归组，挂到对应引用上，供图文回答与 PPT 插图消费
    images_by_doc: Dict[str, List[Dict[str, Any]]] = {}
    for image in result.data.images:
        images_by_doc.setdefault(image.doc_id, []).append(
            {
                "image_id": image.image_id,
                "url": image.image_url,
                "caption": image.caption,
                "score": image.score,
            }
        )

    citations: List[Dict[str, Any]] = []
    for index, hit in enumerate(result.data.hits):
        if len(citations) >= max_citations:
            break
        document = by_doc_id.get(hit.doc_id)
        if document is None:
            # 返回了白名单之外的文档：直接丢弃，不做"事后过滤后的兜底"
            continue
        citations.append(
            {
                # document_id 语义是"edu 侧文件 id"，知识库的 doc_id 另放
                # rag_doc_id —— 两者不是一回事，混用会让前端跳转失效
                "document_id": document.file_id,
                "rag_doc_id": hit.doc_id,
                # 外置检索不再有本地 chunk 序号，按召回顺序编号，
                # 保证下游 prompt 拼装与前端的 chunk_index 字段不缺失
                "chunk_index": index,
                "content": (hit.snippet or "")[:800],
                # score 语义随底层向量库与检索模式变化，**这里不做阈值过滤**，
                # 只用它排序（外部已排序），避免把本地标定的 0.18 误用过来
                "score": hit.score,
                "similarity": hit.score,
                "source": document.source,
                "file_name": document.filename or document.source,
                "source_type": document.source_type,
                "page_start": hit.page_start,
                "page_end": hit.page_end,
                "locator_status": hit.locator_status,
                "images": images_by_doc.get(hit.doc_id, []),
            }
        )
    return citations, ""


async def _search_course_chunks(
    db: AsyncSession,
    course_id: int,
    question: str,
    user: Optional[User] = None,
    max_citations: int = 5,
    threshold: float = 0.18,
) -> List[Dict[str, Any]]:
    """检索课程材料，返回引用列表。

    ``RAG_BACKEND=http-rag`` 时优先走外部知识库；外部不可用或该课程尚未
    入库时按 ``rag_fallback_to_local`` 决定是否回落到本地实现。

    ``threshold`` 只对本地实现生效：外置检索的 score 语义由底层向量库决定，
    不可跨库比较，因此外部路径只用它排序、不套阈值。
    """
    if _external_retrieval_enabled():
        citations, reason = await _search_via_external(
            db, course_id, question, user, max_citations
        )
        if citations is not None:
            return citations
        if not settings.rag_fallback_to_local:
            # 明确不允许降级：宁可返回空，也不要静默换一套检索口径
            return []
        logger.warning(
            "外部检索不可用（%s），课程 %s 回落到本地实现", reason, course_id
        )

    result = await db.execute(
        select(AiDocumentChunk)
        .where(AiDocumentChunk.course_id == course_id, AiDocumentChunk.content.isnot(None))
        .order_by(AiDocumentChunk.file_id, AiDocumentChunk.chunk_index)
    )
    chunks = list(result.scalars().all())

    if user is not None and user.role == "STUDENT":
        own_submission_ids = set(
            (
                await db.execute(
                    select(Submission.id)
                    .join(Assignment, Assignment.id == Submission.assignment_id)
                    .where(
                        Assignment.course_id == course_id,
                        Submission.student_id == user.id,
                    )
                )
            ).scalars().all()
        )
        review_submission_ids = set(
            (
                await db.execute(
                    select(PeerReview.target_submission_id)
                    .join(Submission, Submission.id == PeerReview.target_submission_id)
                    .join(Assignment, Assignment.id == Submission.assignment_id)
                    .where(
                        Assignment.course_id == course_id,
                        PeerReview.reviewer_id == user.id,
                    )
                )
            ).scalars().all()
        )
        allowed_submission_ids = own_submission_ids | review_submission_ids

        def can_access_chunk(chunk: AiDocumentChunk) -> bool:
            if chunk.source_type not in {"submission_attachment", "submission_text"}:
                return True
            match = re.search(r":submission:(\d+):", chunk.vector_id or "")
            return bool(match and int(match.group(1)) in allowed_submission_ids)

        chunks = [chunk for chunk in chunks if can_access_chunk(chunk)]

    chunk_lookup = {
        (chunk.file_id, chunk.chunk_index): chunk
        for chunk in chunks
    }

    def citation_from_chunk(chunk: AiDocumentChunk, similarity: float) -> Dict[str, Any]:
        return {
            "document_id": chunk.file_id,
            "chunk_index": chunk.chunk_index,
            "content": (chunk.content or "")[:800],
            "score": similarity,
            "similarity": similarity,
            "source": chunk.source or "课程资料",
            "file_name": chunk.source or None,
            "source_type": chunk.source_type,
        }

    try:
        vector_hits = VectorStoreManager().similarity_search(
            question,
            k=max_citations * 3,
            collection_name=f"course_{course_id}",
            filter={"course_id": course_id},
        )
    except Exception:
        vector_hits = []

    vector_scored = []
    for doc, distance in vector_hits:
        metadata = doc.metadata or {}
        if metadata.get("course_id") != course_id:
            continue
        key = (
            metadata.get("file_id") or metadata.get("document_id"),
            metadata.get("chunk_index"),
        )
        chunk = chunk_lookup.get(key)
        if chunk is None:
            continue
        similarity = round(1 / (1 + max(float(distance or 0), 0)), 4)
        similarity = _boost_course_material_similarity(question, chunk, similarity)
        if similarity >= threshold:
            vector_scored.append((similarity, chunk))

    if vector_scored:
        vector_scored.sort(key=lambda item: item[0], reverse=True)
        return [
            citation_from_chunk(chunk, similarity)
            for similarity, chunk in vector_scored[:max_citations]
        ]

    scored = []
    for chunk in chunks:
        similarity = VectorStoreManager.lexical_similarity(question, chunk.content or "")
        similarity = _boost_course_material_similarity(question, chunk, similarity)
        if similarity >= threshold:
            scored.append((similarity, chunk))
    scored.sort(key=lambda item: item[0], reverse=True)
    return [
        citation_from_chunk(chunk, similarity)
        for similarity, chunk in scored[:max_citations]
    ]


def _build_rag_context(citations: List[Dict[str, Any]]) -> str:
    return "\n\n".join(
        f"[{idx}. {item['source']} / chunk {item['chunk_index']} / similarity {item['similarity']:.2f}]\n{item['content']}"
        for idx, item in enumerate(citations, 1)
    )


def _boost_course_material_similarity(question: str, chunk: AiDocumentChunk, similarity: float) -> float:
    question_text = (question or "").strip()
    if not question_text:
        return similarity
    assignment_intents = ("作业", "任务", "提交", "截止", "截止时间", "总分", "分数", "要求", "附件", "文件")
    if chunk.source_type in {"assignment", "assignment_attachment"} and any(keyword in question_text for keyword in assignment_intents):
        return max(similarity, 0.82)
    submission_intents = ("提交", "学生", "答案", "作答", "附件", "文件", "批改")
    if chunk.source_type in {"submission_text", "submission_attachment"} and any(keyword in question_text for keyword in submission_intents):
        return max(similarity, 0.82)
    return similarity


def _classify_agent_mode(question: str, course_id: Optional[int]) -> str:
    text = (question or "").strip().lower()
    material_keywords = (
        "资料", "课件", "文档", "讲义", "教材", "知识点", "概念", "原理", "解释",
        "根据材料", "课程内容", "索引", "rag",
    )
    business_keywords = (
        "我的", "个人", "我", "作业", "成绩", "分数", "通知", "待办",
        "提交", "截止", "批改", "评语", "互评", "学生", "选课", "未读", "班级",
        "待批改", "已批改", "未提交", "已提交",
    )
    advice_keywords = (
        "建议", "计划", "怎么学", "如何学", "复习", "安排", "薄弱", "提升", "总结",
        "规划", "优先",
    )
    wants_rag = bool(course_id) and any(keyword in text for keyword in material_keywords)
    wants_business = any(keyword in text for keyword in business_keywords)
    wants_advice = any(keyword in text for keyword in advice_keywords)
    if wants_advice and course_id:
        return "hybrid"
    if wants_rag and wants_business:
        return "hybrid"
    if wants_rag:
        return "rag"
    if wants_business:
        return "business"
    return "general"


def _json_context(data: Dict[str, Any], max_chars: int = 9000) -> str:
    text = json.dumps(data, ensure_ascii=False, default=str, indent=2)
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "\n...（上下文过长，已截断）"


async def _collect_agent_memory(
    db: AsyncSession,
    user: User,
    course_id: Optional[int],
    limit: int = 8,
) -> List[Dict[str, Any]]:
    """读取当前用户最近的对话，作为跨请求的长期记忆。"""
    filters = [AiQaLog.user_id == user.id]
    if course_id is not None:
        filters.append(AiQaLog.course_id == course_id)
    else:
        filters.append(AiQaLog.course_id == 0)
    result = await db.execute(
        select(AiQaLog)
        .where(*filters)
        .order_by(AiQaLog.created_at.desc(), AiQaLog.id.desc())
        .limit(limit)
    )
    rows = list(result.scalars().all())
    rows.reverse()
    return [
        {
            "question": item.question,
            "answer": item.answer,
            "course_id": item.course_id,
            "created_at": item.created_at.isoformat() if item.created_at else None,
        }
        for item in rows
    ]


def _build_agent_memory_context(memory: List[Dict[str, Any]]) -> str:
    if not memory:
        return "暂无历史对话。"
    return "\n\n".join(
        f"用户：{item['question']}\n助手：{item.get('answer') or ''}"
        for item in memory
    )


async def _collect_recent_notifications(db: AsyncSession, user: User) -> List[Dict[str, Any]]:
    result = await db.execute(
        select(Notification)
        .where(Notification.recipient == user.username)
        .order_by(Notification.created_at.desc(), Notification.id.desc())
        .limit(8)
    )
    return [
        {
            "id": item.id,
            "title": item.title,
            "content": item.content,
            "category": item.category,
            "is_read": item.is_read,
            "created_at": item.created_at.isoformat() if item.created_at else None,
        }
        for item in result.scalars().all()
    ]


async def _collect_student_agent_context(
    db: AsyncSession,
    user: User,
    course_id: Optional[int],
) -> Dict[str, Any]:
    course_filter = [Enrollment.student_id == user.id]
    if course_id:
        course_filter.append(Enrollment.course_id == course_id)
    course_rows = await db.execute(
        select(Course)
        .join(Enrollment, Enrollment.course_id == Course.id)
        .where(*course_filter)
        .order_by(Course.created_at.desc(), Course.id.desc())
    )
    courses = list(course_rows.scalars().all())
    course_ids = [course.id for course in courses]

    assignments: List[Dict[str, Any]] = []
    if course_ids:
        assignment_rows = await db.execute(
            select(Assignment, Course, Submission)
            .join(Course, Course.id == Assignment.course_id)
            .outerjoin(
                Submission,
                (Submission.assignment_id == Assignment.id)
                & (Submission.student_id == user.id),
            )
            .where(Assignment.course_id.in_(course_ids))
            .order_by(Assignment.due_date.asc(), Assignment.created_at.desc())
            .limit(12)
        )
        for assignment, course, submission in assignment_rows:
            assignments.append({
                "id": assignment.id,
                "course_id": course.id,
                "course_name": course.name,
                "title": assignment.title,
                "description": assignment.description,
                "detail": assignment.detail,
                "due_date": assignment.due_date.isoformat() if assignment.due_date else None,
                "total_points": assignment.total_points,
                "submission_status": submission.status if submission else "NOT_SUBMITTED",
                "score": submission.score if submission else None,
                "teacher_comment": submission.teacher_comment if submission else None,
            })

    grade_filters = [Submission.student_id == user.id, Submission.score.isnot(None)]
    if course_id:
        grade_filters.append(Course.id == course_id)
    grade_rows = await db.execute(
        select(Submission, Assignment, Course)
        .join(Assignment, Assignment.id == Submission.assignment_id)
        .join(Course, Course.id == Assignment.course_id)
        .where(*grade_filters)
        .order_by(Submission.graded_at.desc(), Submission.id.desc())
        .limit(10)
    )
    grades = [
        {
            "course_name": course.name,
            "assignment_title": assignment.title,
            "score": submission.score,
            "total_points": assignment.total_points,
            "teacher_comment": submission.teacher_comment,
            "graded_at": submission.graded_at.isoformat() if submission.graded_at else None,
        }
        for submission, assignment, course in grade_rows
    ]

    return {
        "role": "STUDENT",
        "user": {"id": user.id, "username": user.username, "display_name": user.display_name},
        "courses": [
            {
                "id": course.id,
                "name": course.name,
                "description": course.description,
                "schedule": course.schedule,
                "credits": course.credits,
                "category": course.category,
            }
            for course in courses
        ],
        "assignments": assignments,
        "grades": grades,
        "notifications": await _collect_recent_notifications(db, user),
    }


async def _collect_teacher_agent_context(
    db: AsyncSession,
    user: User,
    course_id: Optional[int],
) -> Dict[str, Any]:
    course_filter = []
    if user.role != "ADMIN":
        course_filter.append(Course.teacher_id == user.id)
    if course_id:
        course_filter.append(Course.id == course_id)
    course_rows = await db.execute(
        select(Course)
        .where(*course_filter)
        .order_by(Course.created_at.desc(), Course.id.desc())
    )
    courses = list(course_rows.scalars().all())
    course_ids = [course.id for course in courses]

    assignments: List[Dict[str, Any]] = []
    teaching_summary: Dict[str, Any] = {"student_count": 0, "pending_grading": 0, "graded_count": 0, "average_score": None}
    recent_submissions: List[Dict[str, Any]] = []
    if course_ids:
        student_count = await db.execute(
            select(func.count(func.distinct(Enrollment.student_id)))
            .where(Enrollment.course_id.in_(course_ids))
        )
        pending_grading = await db.execute(
            select(func.count(Submission.id))
            .join(Assignment, Assignment.id == Submission.assignment_id)
            .where(Assignment.course_id.in_(course_ids), Submission.status == "SUBMITTED")
        )
        graded_count = await db.execute(
            select(func.count(Submission.id))
            .join(Assignment, Assignment.id == Submission.assignment_id)
            .where(Assignment.course_id.in_(course_ids), Submission.status == "GRADED")
        )
        average_score = await db.execute(
            select(func.avg(Submission.score))
            .join(Assignment, Assignment.id == Submission.assignment_id)
            .where(Assignment.course_id.in_(course_ids), Submission.score.isnot(None))
        )
        average_value = average_score.scalar()
        teaching_summary = {
            "student_count": student_count.scalar() or 0,
            "pending_grading": pending_grading.scalar() or 0,
            "graded_count": graded_count.scalar() or 0,
            "average_score": float(average_value) if average_value is not None else None,
        }

        assignment_rows = await db.execute(
            select(Assignment, Course)
            .join(Course, Course.id == Assignment.course_id)
            .where(Assignment.course_id.in_(course_ids))
            .order_by(Assignment.created_at.desc(), Assignment.id.desc())
            .limit(12)
        )
        for assignment, course in assignment_rows:
            submit_count = await db.execute(
                select(func.count(Submission.id)).where(Submission.assignment_id == assignment.id)
            )
            graded = await db.execute(
                select(func.count(Submission.id)).where(
                    Submission.assignment_id == assignment.id,
                    Submission.status == "GRADED",
                )
            )
            assignments.append({
                "id": assignment.id,
                "course_id": course.id,
                "course_name": course.name,
                "title": assignment.title,
                "description": assignment.description,
                "detail": assignment.detail,
                "due_date": assignment.due_date.isoformat() if assignment.due_date else None,
                "total_points": assignment.total_points,
                "submission_count": submit_count.scalar() or 0,
                "graded_count": graded.scalar() or 0,
            })

        submission_rows = await db.execute(
            select(Submission, Assignment, Course, User)
            .join(Assignment, Assignment.id == Submission.assignment_id)
            .join(Course, Course.id == Assignment.course_id)
            .join(User, User.id == Submission.student_id)
            .where(Assignment.course_id.in_(course_ids))
            .order_by(Submission.submitted_at.desc(), Submission.id.desc())
            .limit(10)
        )
        recent_submissions = [
            {
                "course_name": course.name,
                "assignment_title": assignment.title,
                "student_name": student.display_name or student.username,
                "status": submission.status,
                "score": submission.score,
                "submitted_at": submission.submitted_at.isoformat() if submission.submitted_at else None,
            }
            for submission, assignment, course, student in submission_rows
        ]

    return {
        "role": user.role,
        "user": {"id": user.id, "username": user.username, "display_name": user.display_name},
        "courses": [
            {
                "id": course.id,
                "name": course.name,
                "description": course.description,
                "schedule": course.schedule,
                "credits": course.credits,
                "category": course.category,
                "enrolled_count": course.enrolled_count,
            }
            for course in courses
        ],
        "teaching_summary": teaching_summary,
        "assignments": assignments,
        "recent_submissions": recent_submissions,
        "notifications": await _collect_recent_notifications(db, user),
    }


async def _collect_agent_business_context(
    db: AsyncSession,
    user: User,
    course_id: Optional[int],
) -> Dict[str, Any]:
    if course_id:
        await _ensure_course_access(db, course_id, user)
    if user.role == "STUDENT":
        return await _collect_student_agent_context(db, user, course_id)
    return await _collect_teacher_agent_context(db, user, course_id)


def _fallback_agent_answer(
    question: str,
    business_context: Optional[Dict[str, Any]],
    citations: List[Dict[str, Any]],
) -> str:
    parts: List[str] = []
    if business_context:
        courses = business_context.get("courses") or []
        assignments = business_context.get("assignments") or []
        grades = business_context.get("grades") or []
        notifications = business_context.get("notifications") or []
        summary = business_context.get("teaching_summary") or {}
        if courses:
            parts.append("课程：" + "、".join(str(item.get("name")) for item in courses[:5]))
        if assignments:
            parts.append("近期作业：" + "；".join(
                f"{item.get('course_name', '')}/{item.get('title', '')}（{item.get('submission_status') or item.get('submission_count', '-') }）"
                for item in assignments[:5]
            ))
        if grades:
            parts.append("近期成绩：" + "；".join(
                f"{item.get('course_name', '')}/{item.get('assignment_title', '')}: {item.get('score')}"
                for item in grades[:5]
            ))
        if summary:
            parts.append(
                f"教学概览：学生 {summary.get('student_count', 0)} 人，待批改 {summary.get('pending_grading', 0)} 份，已评分 {summary.get('graded_count', 0)} 份。"
            )
        if notifications:
            parts.append("近期通知：" + "；".join(item.get("title") or "" for item in notifications[:5]))
    if citations:
        parts.append("课程资料引用：" + "；".join(
            f"{item.get('source', '课程资料')} chunk {item.get('chunk_index', 0)}"
            for item in citations[:3]
        ))
    if parts:
        return "我先根据系统里能查到的数据整理如下：\n" + "\n".join(f"- {part}" for part in parts)
    return "我是校园学习助手，可以回答学习方法、课程安排建议、作业推进思路等问题；我不能实时联网查询外部信息。"


def _build_course_material_status(citations: List[Dict[str, Any]], business_context: Optional[Dict[str, Any]]) -> str:
    if citations:
        return "本次已命中已索引课程资料，请优先依据课程资料回答。"
    courses = (business_context or {}).get("courses") or []
    if courses:
        return (
            "本次没有命中已索引课程资料。可以依据业务数据中的课程名称、简介、安排、学分等基础信息回答课程概览类问题；"
            "如果问题需要课件、讲义或上传文档中的细节，必须说明当前未命中资料，并建议教师索引课程资料或换一个更贴近资料的问题。"
        )
    return "本次没有命中已索引课程资料，也没有可用课程基础信息。"


@router.post("/agent/chat", include_in_schema=False)
async def agent_runtime_chat(
    req: AgentChatRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Execute a bounded Agent: planning, tools, memory, and synthesis.

    正式入口为 POST /api/knowledge/agent/chat（见 app/routers/knowledge.py），
    本函数是它的实现体；此处同时保留 /api/ai/agent/chat 直连路径，但不进 OpenAPI 清单。
    """
    question = req.question.strip()
    session_id = req.session_id or str(uuid4())
    runtime = None
    service = AiToolService(db)
    try:
        runtime = AgentRuntime(
            db=db,
            user=user,
            service=service,
            retrieve_materials=lambda selected_course_id, material_question: (
                _search_course_chunks(db, selected_course_id, material_question, user=user)
            ),
        )
        result = await runtime.run(
            question=question,
            course_id=req.course_id,
            session_id=session_id,
            confirm=req.confirm,
        )
        memory = result.get("memory") or {}
        return ApiResponse.ok(
            data=AgentChatResponse(
                answer=result["answer"],
                mode="smart_education",
                citations=result.get("citations", []),
                confidence=result.get("confidence", 0.0),
                run_id=result.get("run_id"),
                memory_count=memory.get("used_count", 0),
                status=result.get("status", "COMPLETED"),
                plan=result.get("plan", {}),
                executed_steps=result.get("executed_steps", []),
                requires_confirmation=result.get("requires_confirmation", []),
                memory=memory,
                confirmation_required=result.get("confirmation_required", False),
            )
        )
    except Exception as exc:
        if runtime is not None and runtime.active_run_id is not None:
            await service.fail_run(
                runtime.active_run_id,
                error=str(exc),
            )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Agent runtime failed: {exc}",
        )


async def list_agent_tools(user: User, db: AsyncSession) -> ApiResponse:
    """列出当前登录角色可调用的 Agent 工具（只读）。

    数据源是 ``AgentToolRegistry.specs()`` —— 与运行时真正执行工具时用的是
    同一份注册表，因此这里展示的清单不会与运行行为脱节。构造注册表不需要 LLM，
    所以即使模型未配置，本接口依然可用。
    """
    from ai.agents.tool_registry import AgentToolRegistry

    registry = AgentToolRegistry(db, user, AiToolService(db))
    specs = registry.specs()
    return ApiResponse.ok(
        data={
            "role": user.role,
            "count": len(specs),
            "tools": specs,
        }
    )


@router.post("/courses/{course_id}/documents/index")
async def index_course_documents(
    course_id: int,
    user: User = Depends(require_teacher),
    db: AsyncSession = Depends(get_db),
):
    """Index uploaded course materials into DB chunks and optional vector store."""
    await _ensure_course_access(db, course_id, user)
    if user.role not in {"ADMIN", "TEACHER"}:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only teachers or admins can index documents")

    data = await reindex_course_documents(db, course_id)
    return ApiResponse.ok(data=data)


@router.post("/courses/{course_id}/qa")
async def course_qa(
    course_id: int,
    req: QARequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """课程 RAG 问答：仅基于当前课程已索引资料回答。"""
    await _ensure_course_access(db, course_id, user)
    service = AiToolService(db)
    start = time.time()
    run = await service.create_run(
        user_id=user.id,
        role=user.role,
        workflow="rag_qa",
        input_summary=f"课程 {course_id} 问答: {req.question[:120]}",
    )

    try:
        citations = await _search_course_chunks(db, course_id, req.question, user=user)
        await service.log_tool_call_json(
            run.id,
            "retrieve_course_chunks",
            {"course_id": course_id, "question": req.question, "threshold": 0.18, "max_citations": 5},
            {"hit_count": len(citations), "citations": citations},
        )

        if not citations:
            latency = int((time.time() - start) * 1000)
            answer = "当前课程资料无法支持该问题"
            await service.log_qa(course_id=course_id, user_id=user.id,
                question=req.question,
                answer=answer,
                confidence=0.0, latency_ms=latency)
            await service.complete_run(run.id, output_summary=answer, latency_ms=latency)
            return ApiResponse.ok(data=QAResponse(
                answer=answer,
                citations=[],
                confidence=0.0,
                needs_clarification=True,
                run_id=run.id,
            ))

        context = _build_rag_context(citations)
        try:
            llm = get_llm(temperature=0.3)
            prompt = f"""你是课程资料问答助手。只能依据给定资料回答，不要使用课程简介或外部知识。
如果给定资料不能支持回答，请只回答：当前课程资料无法支持该问题

资料：
{context}

问题：{req.question}

请用中文回答，并尽量点明引用的资料编号。"""
            llm_start = time.time()
            response = await llm.ainvoke(prompt)
            answer = response.content if hasattr(response, 'content') else str(response)
            await service.log_tool_call_json(
                run.id,
                "llm_answer",
                {"question": req.question, "context_count": len(citations)},
                {"answer": answer},
                latency_ms=int((time.time() - llm_start) * 1000),
            )
        except Exception as e:
            answer = "根据当前课程资料：\n" + "\n".join(
                f"{idx}. {item['content'][:220]}" for idx, item in enumerate(citations[:3], 1)
            )
            await service.log_tool_call_json(
                run.id,
                "llm_answer",
                {"question": req.question, "context_count": len(citations)},
                {"fallback_answer": answer},
                error=str(e),
            )

        latency = int((time.time() - start) * 1000)
        await service.log_qa(course_id=course_id, user_id=user.id,
            question=req.question, answer=answer,
            citations=json.dumps(citations, ensure_ascii=False),
            confidence=citations[0]["similarity"] if citations else 0, latency_ms=latency)
        await service.complete_run(run.id, output_summary=answer[:500], latency_ms=latency)

        return ApiResponse.ok(data=QAResponse(
            answer=answer, citations=citations,
            confidence=citations[0]["similarity"] if citations else 0,
            needs_clarification=False,
            run_id=run.id,
        ))
    except Exception as e:
        latency = int((time.time() - start) * 1000)
        await service.fail_run(run.id, error=str(e), latency_ms=latency)
        return ApiResponse.error(message=f"AI 问答失败: {str(e)}", code=500)


@router.post("/students/{student_id}/diagnosis")
async def diagnose_student(
    student_id: int,
    course_id: Optional[int] = Query(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """学情诊断"""
    await _ensure_student_ai_access(db, student_id, user, course_id)
    service = AiToolService(db)
    start = time.time()

    try:
        profile = await service.get_student_profile(student_id)
        weakness = await service.get_weakness_analysis(student_id)

        latency = int((time.time() - start) * 1000)

        # 记录运行
        run = await service.create_run(
            user_id=user.id, role=user.role,
            workflow="diagnosis",
            input_summary=f"诊断学生 {student_id} 学情",
        )
        await service.complete_run(run.id, latency_ms=latency)

        return ApiResponse.ok(data=DiagnosisResponse(
            student_id=student_id,
            course_id=course_id or 0,
            weakness=weakness.get("weakness_areas", []),
            evidence=[
                {"metric": "总作业数", "value": profile.get("grade_count", 0)},
                {"metric": "平均分", "value": round(profile.get("average_score", 0), 1)},
                {"metric": "通过率", "value": f"{weakness.get('pass_rate', 0)}%"},
            ],
            trend=weakness.get("summary", ""),
        ))

    except Exception as e:
        return ApiResponse.error(message=f"诊断失败: {str(e)}", code=500)


@router.post("/students/{student_id}/learning-plan")
async def generate_learning_plan(
    student_id: int,
    course_id: int = Query(..., description="课程 ID"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """生成学习计划（LangChain Agent）"""
    await _ensure_student_ai_access(db, student_id, user, course_id)
    service = AiToolService(db)
    start = time.time()
    run = None

    try:
        # 创建运行记录
        run = await service.create_run(
            user_id=user.id, role=user.role,
            workflow="learning_plan",
            input_summary=f"为学生 {student_id} 生成课程 {course_id} 的学习计划",
        )

        # 构建 Agent 并执行
        chain = build_learning_plan_chain(service)

        initial_state: LearningPlanState = {
            "run_id": run.id,
            "user_id": user.id,
            "student_id": student_id,
            "course_id": course_id,
            "role": user.role,
            "profile": None,
            "grades": None,
            "submissions": None,
            "weakness": None,
            "retrieved_materials": None,
            "plan": None,
            "exercises": None,
            "validation_errors": None,
            "tool_trace": None,
            "final_report": None,
            "error": None,
        }

        # 执行 LangChain workflow
        result = await chain.ainvoke(initial_state)

        latency = int((time.time() - start) * 1000)
        token_usage = None

        final_report = result.get("final_report", {}) or result
        error = result.get("error")

        if error:
            await service.fail_run(run.id, error=error, latency_ms=latency)
            return ApiResponse.error(message=f"生成计划失败: {error}", code=500)

        await service.complete_run(
            run.id,
            output_summary=json.dumps(final_report.get("plan", {}), ensure_ascii=False)[:500],
            latency_ms=latency,
            token_usage=token_usage,
        )

        plan_data = final_report.get("plan", {})
        weakness_data = final_report.get("weakness", {})
        return ApiResponse.ok(data=LearningPlanResponse(
            student_id=student_id,
            course_id=course_id,
            weakness_summary=plan_data.get("weakness_summary", ""),
            daily_tasks=plan_data.get("daily_tasks", []),
            materials=plan_data.get("materials", []),
            exercises=final_report.get("exercises") or [],
            total_hours=plan_data.get("total_hours", 0),
            plan_id=final_report.get("report_id"),
            run_id=run.id,
            basis=[
                {"name": "成绩记录", "value": weakness_data.get("graded_count", 0)},
                {"name": "薄弱点", "value": len(weakness_data.get("weakness_areas", []))},
                {"name": "课程资料", "value": len(result.get("retrieved_materials") or [])},
            ],
        ))

    except Exception as e:
        if run is not None:
            await service.fail_run(run.id, error=str(e), latency_ms=int((time.time() - start) * 1000))
        return ApiResponse.error(message=f"生成学习计划失败: {str(e)}", code=500)


@router.post("/teacher/submissions/{submission_id}/grade-suggestion")
async def grade_suggestion(
    submission_id: int,
    user: User = Depends(require_teacher),
    db: AsyncSession = Depends(get_db),
):
    """AI 批改建议（LangChain Agent）"""
    await _ensure_teacher_submission_access(db, submission_id, user)
    service = AiToolService(db)
    start = time.time()
    run = None

    try:
        # 创建运行记录
        run = await service.create_run(
            user_id=user.id, role=user.role,
            workflow="grading",
            input_summary=f"为提交 {submission_id} 生成批改建议",
        )

        # 构建 Agent 并执行
        chain = build_grading_chain(service)

        initial_state: GradingState = {
            "run_id": run.id,
            "user_id": user.id,
            "submission_id": submission_id,
            "role": user.role,
            "submission": None,
            "assignment": None,
            "peer_reviews": None,
            "critique": None,
            "critique_source": None,
            "grading_baseline": None,
            "suggested_score": None,
            "rubric": None,
            "comment": None,
            "strengths": None,
            "weaknesses": None,
            "risks": None,
            "grading_analysis": None,
            "suggestion_id": None,
            "teacher_action": None,
            "teacher_score": None,
            "tool_trace": None,
            "error": None,
        }

        result = await chain.ainvoke(initial_state)

        latency = int((time.time() - start) * 1000)
        error = result.get("error")

        if error:
            await service.fail_run(run.id, error=error, latency_ms=latency)
            return ApiResponse.error(message=f"生成批改建议失败: {error}", code=500)

        await service.complete_run(run.id, latency_ms=latency)

        return ApiResponse.ok(data=GradingSuggestionResponse(
            id=result.get("suggestion_id"),
            run_id=run.id,
            submission_id=submission_id,
            suggested_score=result.get("suggested_score", 0),
            rubric=result.get("rubric", {}),
            critique=result.get("critique", {}),
            critique_source=result.get("critique_source"),
            comment=result.get("comment", ""),
            strengths=result.get("strengths", []),
            weaknesses=result.get("weaknesses", []),
            risks=result.get("risks", []),
            analysis=result.get("grading_analysis", {}),
        ))

    except Exception as e:
        if run is not None:
            await service.fail_run(run.id, error=str(e), latency_ms=int((time.time() - start) * 1000))
        return ApiResponse.error(message=f"生成批改建议失败: {str(e)}", code=500)


@router.get("/runs/{run_id}", include_in_schema=False)
async def get_run_detail(
    run_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """查看 Agent 运行轨迹"""
    service = AiToolService(db)
    detail = await service.get_run_detail(run_id)
    if detail is None:
        return ApiResponse.error(message="运行记录不存在", code=404)
    # 权限检查：只能查看自己的运行记录
    if detail["user_id"] != user.id and user.role != "ADMIN":
        return ApiResponse.error(message="无权查看此运行记录", code=403)
    return ApiResponse.ok(data=detail)


@router.get("/runs/{run_id}/tool-calls", include_in_schema=False)
async def get_run_tool_calls(
    run_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """查看 Agent 工具调用轨迹。"""
    service = AiToolService(db)
    detail = await service.get_run_detail(run_id)
    if detail is None:
        return ApiResponse.error(message="运行记录不存在", code=404)
    if detail["user_id"] != user.id and user.role != "ADMIN":
        return ApiResponse.error(message="无权查看此运行记录", code=403)
    calls = await service.get_tool_calls(run_id)
    return ApiResponse.ok(data=calls)


# 由 app/routers/review.py 的 /api/review/feedback/{id}/approve 包装暴露，不再单独注册路由
async def approve_feedback(
    suggestion_id: int,
    user: User = Depends(require_teacher),
    db: AsyncSession = Depends(get_db),
):
    """教师采用 AI 批改建议。"""
    suggestion = await _ensure_teacher_feedback_access(db, suggestion_id, user)
    teacher_service = TeacherService(db)
    grade = GradeRequest(score=suggestion.suggested_score, comment=suggestion.comment or "")
    await teacher_service.grade_submission(suggestion.submission_id, grade, user)
    suggestion.teacher_action = "ACCEPTED"
    suggestion.teacher_score = suggestion.suggested_score
    await db.flush()
    return ApiResponse.ok(data={
        "id": suggestion.id,
        "submission_id": suggestion.submission_id,
        "teacher_action": suggestion.teacher_action,
        "teacher_score": suggestion.teacher_score,
    }, message="AI 建议已采用")


@router.put("/feedback/{suggestion_id}")
async def update_feedback(
    suggestion_id: int,
    req: FeedbackUpdateRequest,
    user: User = Depends(require_teacher),
    db: AsyncSession = Depends(get_db),
):
    """教师修改或拒绝 AI 批改建议。"""
    suggestion = await _ensure_teacher_feedback_access(db, suggestion_id, user)
    action = req.action or "MODIFIED"

    if action == "REJECTED":
        suggestion.teacher_action = "REJECTED"
        await db.flush()
        return ApiResponse.ok(data={
            "id": suggestion.id,
            "submission_id": suggestion.submission_id,
            "teacher_action": suggestion.teacher_action,
        }, message="AI 建议已拒绝")

    final_score = req.score if req.score is not None else suggestion.suggested_score
    final_comment = req.comment if req.comment is not None else (suggestion.comment or "")
    if req.rubric is not None:
        suggestion.rubric_json = json.dumps(req.rubric, ensure_ascii=False)
    suggestion.comment = final_comment
    suggestion.teacher_action = "MODIFIED"
    suggestion.teacher_score = final_score

    teacher_service = TeacherService(db)
    await teacher_service.grade_submission(
        suggestion.submission_id,
        GradeRequest(score=final_score, comment=final_comment),
        user,
    )
    await db.flush()
    return ApiResponse.ok(data={
        "id": suggestion.id,
        "submission_id": suggestion.submission_id,
        "teacher_action": suggestion.teacher_action,
        "teacher_score": suggestion.teacher_score,
    }, message="AI 建议已修改并应用")


# 由 app/routers/review.py 的 /api/review/feedback/{id}/regenerate 包装暴露，不再单独注册路由
async def regenerate_feedback(
    suggestion_id: int,
    user: User = Depends(require_teacher),
    db: AsyncSession = Depends(get_db),
):
    """基于同一提交重新生成 AI 批改建议，保留旧历史。"""
    suggestion = await _ensure_teacher_feedback_access(db, suggestion_id, user)
    return await grade_suggestion(suggestion.submission_id, user=user, db=db)
