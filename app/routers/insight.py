"""/api/insight/* —— 学情洞察命名空间。

定位：视觉数据的**消费方**。"以视觉为核心"能否成立，取决于这里能不能把
视觉事件、评阅成绩、个体诊断合起来给出结论。

实现策略：
  · 聚合类（overview / engagement / alerts / reports）直接查库，不依赖大模型；
  · 个体类（profile / diagnosis / learning-plan）复用的仍是 /api/ai 下的同一批函数，
    因此接口通、但输出质量取决于模型是否已接入（当前 LLM 为占位实现）。

对 /api/ai 与 AiToolService 的 import 一律延迟，避免 AI 依赖缺失时应用起不来。
"""
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.models import Enrollment, Submission, User
from app.models.vision_models import VisionEvent, VisionIdentity
from app.schemas.common import ApiResponse
from app.services.vision_service import VisionService

router = APIRouter(prefix="/api/insight", tags=["学情洞察"])


def _ai_module():
    try:
        import app.routers.ai as ai_module

        return ai_module
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=501, detail=f"AI 能力未启用：{exc}") from exc


def _tool_service(db: AsyncSession):
    try:
        from app.services.ai_tool_service import AiToolService

        return AiToolService(db)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=501, detail=f"AI 能力未启用：{exc}") from exc


async def _ensure_view(db: AsyncSession, student_id: int, user: User) -> User:
    """学生本人 / 教师 / 管理员可查看该学生的学情。"""
    target = (
        await db.execute(select(User).where(User.id == student_id))
    ).scalar_one_or_none()
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="学生不存在")
    if user.role in {"ADMIN", "TEACHER"} or user.id == student_id:
        return target
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="无权查看该学生")


@router.get("/overview")
async def overview(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """学情总览：视觉输入规模 + 评分闭环进度。"""
    vision = await VisionService(db).overview()
    student_total = (
        await db.execute(select(func.count(User.id)).where(User.role == "STUDENT"))
    ).scalar() or 0
    submission_total = (
        await db.execute(select(func.count(Submission.id)))
    ).scalar() or 0
    graded_total = (
        await db.execute(
            select(func.count(Submission.id)).where(Submission.score.isnot(None))
        )
    ).scalar() or 0
    average_score = (
        await db.execute(select(func.avg(Submission.score)).where(Submission.score.isnot(None)))
    ).scalar()
    return ApiResponse.ok(
        data={
            "student_total": student_total,
            "submission_total": submission_total,
            "graded_total": graded_total,
            "average_score": float(average_score) if average_score is not None else None,
            "vision_event_total": vision.event_total,
            "vision_unacknowledged": vision.unacknowledged,
            "vision_event_by_severity": vision.event_by_severity,
        }
    )


@router.get("/students/{student_id}/profile")
async def profile(
    student_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """学生画像：课程、成绩与低分作业的原始聚合。"""
    await _ensure_view(db, student_id, user)
    data = await _tool_service(db).get_student_profile(student_id)
    return ApiResponse.ok(data=data)


@router.post("/students/{student_id}/diagnosis")
async def diagnosis(
    student_id: int,
    course_id: Optional[int] = Query(default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """学习诊断（等价 /api/ai/students/{id}/diagnosis）。"""
    await _ensure_view(db, student_id, user)
    return await _ai_module().diagnose_student(
        student_id, course_id=course_id, user=user, db=db
    )


@router.post("/students/{student_id}/learning-plan")
async def learning_plan(
    student_id: int,
    course_id: int = Query(..., description="课程 ID"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """学习路径规划（等价 /api/ai/students/{id}/learning-plan）。"""
    await _ensure_view(db, student_id, user)
    return await _ai_module().generate_learning_plan(
        student_id, course_id=course_id, user=user, db=db
    )


@router.get("/students/{student_id}/engagement")
async def engagement(
    student_id: int,
    limit: int = Query(default=500, ge=1, le=2000),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """课堂参与度：用身份映射把视觉事件对到具体学生。

    连接键是 vision_identities.student_no == users.student_no（业务学号）。
    注意不是 username —— 登录名与学号是两套命名空间，此前用 username 连接
    导致命中恒为 0、参与度永远为空。
    没有映射时返回空集合并说明原因 —— 不编造参与度。
    """
    target = await _ensure_view(db, student_id, user)

    target_no = target.student_no
    identities = (
        list(
            (
                await db.execute(
                    select(VisionIdentity).where(
                        VisionIdentity.student_no == target_no
                    )
                )
            )
            .scalars()
            .all()
        )
        if target_no
        else []
    )
    pairs = {(i.scene, i.seat_ref) for i in identities}

    events = list(
        (
            await db.execute(
                select(VisionEvent).order_by(VisionEvent.id.desc()).limit(limit)
            )
        )
        .scalars()
        .all()
    )
    mine = [e for e in events if (e.scene, e.seat_ref) in pairs]

    by_scene: Dict[str, Any] = {}
    by_severity: Dict[str, int] = {}
    for e in mine:
        bucket = by_scene.setdefault(e.scene or "未知", {"count": 0, "confidence_sum": 0.0})
        bucket["count"] += 1
        bucket["confidence_sum"] += float(e.confidence or 0)
        by_severity[e.severity or "info"] = by_severity.get(e.severity or "info", 0) + 1

    scenes = [
        {
            "scene": k,
            "count": v["count"],
            "average_confidence": round(v["confidence_sum"] / v["count"], 4) if v["count"] else 0,
        }
        for k, v in by_scene.items()
    ]

    return ApiResponse.ok(
        data={
            "student_id": student_id,
            "student_no": target_no,
            "identity_count": len(identities),
            "event_total": len(mine),
            "scenes": scenes,
            "by_severity": by_severity,
            "note": (
                "" if pairs
                else (
                    "该学生尚未登记学号（users.student_no），无法关联视觉身份。"
                    "请先为该学生补充学号。"
                    if not target_no
                    else "该学号还没有视觉身份映射（vision_identities.student_no），"
                         "无法把视觉事件对到人。先到「视觉感知中枢 → 身份映射绑定」建立映射。"
                )
            ),
        }
    )


@router.get("/alerts")
async def alerts(
    limit: int = Query(default=100, ge=1, le=500),
    acknowledged: Optional[bool] = Query(default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """学业与行为预警：以视觉事件中的关注级以上事件为输入。

    与其他端点一致要求登录：预警数据包含学生行为标签，不应匿名可读。
    """
    service = VisionService(db)
    rows = []
    for severity in ("critical", "warning"):
        rows.extend(
            await service.list_events(
                severity=severity, acknowledged=acknowledged, limit=limit
            )
        )
    rows.sort(key=lambda e: (e.severity != "critical", -(e.id or 0)))
    from app.schemas.vision import VisionEventOut

    return ApiResponse.ok(data=[VisionEventOut.model_validate(e) for e in rows[:limit]])


class ReportRequest(BaseModel):
    """学情报告请求。"""

    student_id: int
    course_id: Optional[int] = None


@router.post("/reports")
async def reports(
    req: ReportRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """学情报告：把评分、薄弱点、视觉行为合并成一份可核对的快照。

    刻意不调用 LLM —— 报告的价值在于"数字可核对"，措辞润色交给模型是
    可选项而非前提。返回的每一项都标明数据来源。
    """
    target = await _ensure_view(db, req.student_id, user)
    service = _tool_service(db)

    profile_data = await service.get_student_profile(req.student_id)
    grades = profile_data.get("grades") or []
    low_scores = profile_data.get("low_score_assignments") or []

    average_score = profile_data.get("average_score") or 0
    weak_areas: List[Dict[str, Any]] = [
        {
            "assignment_id": g.get("assignment_id"),
            "assignment_title": g.get("assignment_title") or g.get("title"),
            "score": g.get("score"),
        }
        for g in low_scores[:10]
    ]

    # 视觉行为：与 engagement 同一套连接键 —— users.student_no（业务学号）
    target_no = target.student_no
    identities = (
        list(
            (
                await db.execute(
                    select(VisionIdentity).where(
                        VisionIdentity.student_no == target_no
                    )
                )
            )
            .scalars()
            .all()
        )
        if target_no
        else []
    )
    pairs = {(i.scene, i.seat_ref) for i in identities}
    events = list(
        (
            await db.execute(select(VisionEvent).order_by(VisionEvent.id.desc()).limit(1000))
        )
        .scalars()
        .all()
    )
    mine = [e for e in events if (e.scene, e.seat_ref) in pairs]
    severity: Dict[str, int] = {}
    for e in mine:
        severity[e.severity or "info"] = severity.get(e.severity or "info", 0) + 1

    course_rows = list(
        (
            await db.execute(
                select(Enrollment.course_id).where(Enrollment.student_id == req.student_id)
            )
        )
        .scalars()
        .all()
    )

    return ApiResponse.ok(
        data={
            "student_id": req.student_id,
            "student_no": target_no,
            "course_id": req.course_id,
            "enrolled_course_ids": course_rows,
            "summary": {
                "grade_count": profile_data.get("grade_count", 0),
                "average_score": round(float(average_score), 2),
                "weak_area_count": len(weak_areas),
                "vision_event_count": len(mine),
            },
            "weak_areas": weak_areas,
            "vision": {"by_severity": severity, "identity_count": len(identities)},
            "sources": [
                {"name": "成绩记录", "endpoint": "/api/review/grades"},
                {"name": "低分作业", "endpoint": "submissions + assignments"},
                {"name": "视觉行为", "endpoint": "/api/vision/events"},
                {"name": "身份映射", "endpoint": "/api/vision/identities"},
            ],
            "note": (
                "" if pairs
                else (
                    "该学生尚未登记学号（users.student_no），视觉行为部分为空。"
                    "补充学号后本报告会自动补全。"
                    if not target_no
                    else "缺少视觉身份映射（vision_identities.student_no），"
                         "视觉行为部分为空。建立映射后本报告会自动补全。"
                )
            ),
        }
    )
