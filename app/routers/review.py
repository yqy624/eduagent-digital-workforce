"""智能评阅 — RESTful 接口。

命名沿用菜单映射表里的 `/api/review/*`：
    POST /api/review/submissions/scan            拍照上传批改（YOLO 嵌入作业流程的入口）
    GET  /api/review/scan/tasks                  待批改清单
    POST /api/review/submissions/{id}/apply-score 复核后写回成绩

本文件是"原平台功能迁移到新模块"的第一个落点。后续课程、作业、互评等端点
会按 `原平台改造方案_菜单迁移与YOLO接入.md` 的阶段 2 逐个从 teacher.py 迁过来。
"""
import json
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.middleware.auth import get_current_user, require_student, require_teacher
from app.models.models import Assignment, Course, Submission, TeacherCommentMemory, User
from app.models.vision_models import VisionTask
from app.schemas.assignment import (
    AssignmentCreate,
    AssignmentUpdate,
    PeerReviewConfigUpdate,
    GradeRequest,
    SubmissionResponse,
    SubmissionSubmit,
)
from app.schemas.common import ApiResponse
from app.schemas.review import (
    GradingQuality,
    ReviewOverview,
    ScanRequest,
    ScanResult,
    ScanTaskItem,
)
from app.services.assignment_service import AssignmentService
from app.services.student_service import StudentService
from app.services.teacher_service import TeacherService
from app.utils.display import public_file_name
from app.services.vision_service import VisionService

# AI 批改与批改反馈确认：迁移期直接复用 ai.py 里已实现的能力，
# 不在这里复制一份 LangChain 编排逻辑 —— 否则两套批改入口会各自漂移。
# ai.py 依赖 ai/ 包与模型密钥，导入失败时相关端点降级为 501 而不是崩在启动阶段。
try:  # pragma: no cover - 取决于 ai/ 包是否可用
    import app.routers.ai as _ai_router

    _ai_grade_suggestion = _ai_router.grade_suggestion
    _ai_approve_feedback = _ai_router.approve_feedback
    _ai_regenerate_feedback = _ai_router.regenerate_feedback
    AI_REVIEW_AVAILABLE = True
except Exception:  # noqa: BLE001 - 导入期失败必须吞掉，不能让整个应用起不来
    _ai_grade_suggestion = None
    _ai_approve_feedback = None
    _ai_regenerate_feedback = None
    AI_REVIEW_AVAILABLE = False

router = APIRouter(
    prefix="/api/review",
    tags=["智能评阅"],
    dependencies=[Depends(get_current_user)],
)


def _service(db: AsyncSession = Depends(get_db)) -> VisionService:
    return VisionService(db)


@router.post(
    "/submissions/scan",
    response_model=ApiResponse[ScanResult],
    dependencies=[Depends(require_teacher)],
    status_code=status.HTTP_201_CREATED,
)
async def scan_submission(
    req: ScanRequest,
    service: VisionService = Depends(_service),
    user: User = Depends(get_current_user),
):
    """拍照上传批改：对一张作业照片做题块定位。

    返回值里**没有分数**。能确定的是"题块在哪、置信度多少、哪些需要复核"，
    分数由教师在评分环节确认后写回 —— 这条边界不能越过。
    """
    try:
        result = await service.scan_submission(req, operator=user.username)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    return ApiResponse.ok(data=result, message="扫描完成")


@router.get("/scan/tasks", response_model=ApiResponse[list[ScanTaskItem]])
async def list_scan_tasks(
    assignment_id: Optional[int] = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    service: VisionService = Depends(_service),
):
    """教师工作台的"待批改"清单。"""
    tasks = await service.list_scan_tasks(assignment_id=assignment_id, limit=limit)
    items = []
    for t in tasks:
        summary = None
        if isinstance(t.summary_json, str):
            try:
                summary = json.loads(t.summary_json)
            except json.JSONDecodeError:
                summary = None
        items.append(
            ScanTaskItem(
                task_code=t.task_code,
                status=t.status,
                scene=t.scene,
                # 只给文件名：source_ref 可能是本机绝对路径，不下发
                source_name=public_file_name(t.source_ref),
                assignment_id=t.assignment_id,
                submission_id=t.submission_id,
                is_placeholder=t.is_placeholder,
                model_name=t.model_name,
                latency_ms=t.latency_ms,
                created_at=t.created_at,
                summary=summary,
            )
        )
    return ApiResponse.ok(data=items)


@router.post(
    "/submissions/{submission_id}/apply-score",
    response_model=ApiResponse[dict],
    dependencies=[Depends(require_teacher)],
)
async def apply_score(
    submission_id: int,
    req: GradeRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """复核后写回成绩。走的是原平台既有的评分服务，不另起一套。"""
    try:
        submission = await AssignmentService(db).grade(submission_id, req, user)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    return ApiResponse.ok(
        data={
            "submissionId": submission.id,
            "score": submission.score,
            "status": submission.status,
        },
        message="成绩已写入",
    )


# ====================================================================
# 以下为阶段 2 迁移区：把旧 teacher.py / student.py / ai.py 里属于
# "评阅域"的能力搬到 /api/review/* 下，与菜单映射表逐项对齐。
#
# 迁移原则：只搬"路由与权限"，不搬业务逻辑。所有实现仍调用原来的
# TeacherService / StudentService / AssignmentService，因此旧端点与新端点
# 行为完全一致，阶段 3 下线旧端点时不会出现两套逻辑漂移。
# ====================================================================


async def _teacher_course_ids(db: AsyncSession, user: User) -> List[int]:
    """当前用户的统计口径课程 id 列表（避免越权看到别人的数据）。

    管理员的口径是**全校** —— 他和 /api/governance、/api/admin 看到的是同一片数据。
    如果这里也按「自己教的课」算，管理员（通常一门课都不教）的评阅总览会恒为空，
    而且从「查看范围」里点任意一门课都会被 403 挡回来。
    """
    query = select(Course.id)
    if user.role != "ADMIN":
        query = query.where(Course.teacher_id == user.id)
    rows = await db.execute(query)
    return list(rows.scalars().all())


@router.get("/overview", response_model=ApiResponse[ReviewOverview])
async def overview(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """评阅总览：课程 / 作业 / 提交 / 批改 / 扫描五个口径的真实计数。"""
    course_ids = await _teacher_course_ids(db, user)
    overview_data = ReviewOverview(course_count=len(course_ids))

    if course_ids:
        overview_data.assignment_count = int(
            (
                await db.execute(
                    select(func.count(Assignment.id)).where(
                        Assignment.course_id.in_(course_ids)
                    )
                )
            ).scalar()
            or 0
        )

        # 提交按作业关联到课程，避免直接扫全表
        sub_q = (
            select(func.count(Submission.id))
            .join(Assignment, Assignment.id == Submission.assignment_id)
            .where(Assignment.course_id.in_(course_ids))
        )
        overview_data.submission_count = int((await db.execute(sub_q)).scalar() or 0)

        graded_q = (
            select(func.count(Submission.id))
            .join(Assignment, Assignment.id == Submission.assignment_id)
            .where(
                Assignment.course_id.in_(course_ids),
                Submission.status == "GRADED",
            )
        )
        overview_data.graded_count = int((await db.execute(graded_q)).scalar() or 0)
        overview_data.pending_count = (
            overview_data.submission_count - overview_data.graded_count
        )

        avg_q = (
            select(func.avg(Submission.score))
            .join(Assignment, Assignment.id == Submission.assignment_id)
            .where(
                Assignment.course_id.in_(course_ids),
                Submission.score.isnot(None),
            )
        )
        avg = (await db.execute(avg_q)).scalar()
        overview_data.average_score = round(float(avg), 2) if avg is not None else None

        scan_q = select(func.count(VisionTask.id)).where(
            VisionTask.scene == "paper_grading",
            VisionTask.course_id.in_(course_ids),
        )
        overview_data.scan_task_count = int((await db.execute(scan_q)).scalar() or 0)
        scan_pending_q = select(func.count(VisionTask.id)).where(
            VisionTask.scene == "paper_grading",
            VisionTask.course_id.in_(course_ids),
            VisionTask.status.in_(["pending", "running"]),
        )
        overview_data.scan_pending_count = int(
            (await db.execute(scan_pending_q)).scalar() or 0
        )

    try:
        from app.core.models.registry import get_vision_provider

        provider = get_vision_provider()
        overview_data.vision_backend = provider.name
        overview_data.vision_is_placeholder = bool(provider.is_placeholder)
    except Exception:  # noqa: BLE001
        pass

    return ApiResponse.ok(data=overview_data)


@router.get("/courses", response_model=ApiResponse[list])
async def my_courses(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """课程与班级（教师视角）。"""
    data = await TeacherService(db).get_my_courses(user)
    return ApiResponse.ok(data=data)


@router.get("/assignments", response_model=ApiResponse[list])
async def list_assignments(
    course_id: int = Query(..., description="课程 id"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """作业发布：课程下的作业列表。"""
    try:
        return ApiResponse.ok(
            data=await TeacherService(db).get_course_assignments(course_id, user)
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))


@router.post("/assignments", response_model=ApiResponse[dict])
async def create_assignment(
    req: AssignmentCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """发布作业。"""
    try:
        data = await TeacherService(db).create_assignment(req, user)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    return ApiResponse.ok(data=data, message="作业发布成功")


@router.put("/assignments/{assignment_id}", response_model=ApiResponse[dict])
async def update_assignment(
    assignment_id: int,
    req: AssignmentUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """编辑作业。"""
    try:
        data = await TeacherService(db).update_assignment(assignment_id, req, user)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    return ApiResponse.ok(data=data, message="作业已更新")


@router.delete("/assignments/{assignment_id}", response_model=ApiResponse[dict])
async def delete_assignment(
    assignment_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """删除作业。"""
    try:
        await TeacherService(db).delete_assignment(assignment_id, user)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    return ApiResponse.ok(message="作业已删除")


@router.get(
    "/assignments/{assignment_id}/submissions", response_model=ApiResponse[list]
)
async def list_submissions(
    assignment_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """作业的提交记录（批改入口的下游数据）。"""
    try:
        return ApiResponse.ok(
            data=await TeacherService(db).get_submissions(assignment_id, user)
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))


@router.post("/submissions/{submission_id}/grade", response_model=ApiResponse[dict])
async def grade_submission(
    submission_id: int,
    req: GradeRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """人工批改。

    与 `/api/review/submissions/{id}/apply-score` 是同一条链路的两种叫法：
    前者是菜单里的"人工批改"，后者是拍照批改复核后的写回，实现共用
    AssignmentService.grade，不存在第二套评分逻辑。
    """
    try:
        data = await TeacherService(db).grade_submission(submission_id, req, user)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    return ApiResponse.ok(data=data, message="评分成功")


@router.post("/submissions/{submission_id}/ai-grade", response_model=ApiResponse[dict])
async def ai_grade_submission(
    submission_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """AI 自动批改。

    把旧 `ai.py:/teacher/submissions/{id}/grade-suggestion` 收编到评阅域，
    避免"AI 批改"和"批改建议"两个入口各说各话。实现仍调用原 chain。
    """
    if not AI_REVIEW_AVAILABLE or _ai_grade_suggestion is None:
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail="AI 批改依赖的模型能力未启用，请先配置大模型密钥后重试",
        )
    result = await _ai_grade_suggestion(
        submission_id=submission_id, user=user, db=db
    )
    if isinstance(result, ApiResponse) and result.code != 200:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=result.message)
    return result


@router.get("/assignments/{assignment_id}/analysis", response_model=ApiResponse[dict])
async def assignment_analysis(
    assignment_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """作业分析。"""
    try:
        return ApiResponse.ok(
            data=await TeacherService(db).get_assignment_analysis(assignment_id, user)
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))


@router.get("/peer-reviews", response_model=ApiResponse[dict])
async def peer_reviews(
    assignment_id: int = Query(..., description="作业 id"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """同伴互评概览。"""
    try:
        return ApiResponse.ok(
            data=await TeacherService(db).get_peer_review_overview(assignment_id, user)
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))


@router.post("/assignments/{assignment_id}/peer-review", response_model=ApiResponse[dict])
async def create_peer_review(
    assignment_id: int,
    req: PeerReviewConfigUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """配置同伴互评。"""
    try:
        data = await TeacherService(db).update_peer_review(assignment_id, req, user)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    return ApiResponse.ok(data=data, message="互评配置已更新")


@router.put("/assignments/{assignment_id}/peer-review", response_model=ApiResponse[dict])
async def update_peer_review(
    assignment_id: int,
    req: PeerReviewConfigUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """更新同伴互评配置。"""
    return await create_peer_review(assignment_id, req, db, user)


@router.get("/enrollments", response_model=ApiResponse[list])
async def enrollments(
    course_id: int = Query(..., description="课程 id"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """选课与名单。"""
    try:
        return ApiResponse.ok(
            data=await TeacherService(db).get_course_students(course_id, user)
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))


@router.get("/comment-memories", response_model=ApiResponse[list])
async def comment_memories(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """教师评语库：复用历史评语，减少重复输入。"""
    rows = await db.execute(
        select(TeacherCommentMemory)
        .where(TeacherCommentMemory.teacher_id == user.id)
        .order_by(TeacherCommentMemory.usage_count.desc())
        .limit(50)
    )
    items = []
    for m in rows.scalars().all():
        items.append(
            {
                "id": m.id,
                "category": m.category,
                "commentText": m.comment_text,
                "usageCount": m.usage_count,
                "lastUsedAt": m.last_used_at.isoformat() if m.last_used_at else None,
                "createdAt": m.created_at.isoformat() if m.created_at else None,
            }
        )
    return ApiResponse.ok(data=items)


@router.get("/grading-quality", response_model=ApiResponse[GradingQuality])
async def grading_quality(
    course_id: Optional[int] = Query(default=None, description="限定课程，不填则统计全部"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """批改质量复核。

    统计口径是"机器扫描结论"与"教师最终给分"的对照：扫描标记为需要复核的
    提交有多少、低置信度题块有多少。样本不足时明确返回 sample_enough=False，
    不硬算百分比 —— 小样本算出来的比率没有意义。
    """
    course_ids = await _teacher_course_ids(db, user)
    if course_id is not None:
        if course_id not in course_ids:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail="无权查看该课程的批改质量"
            )
        course_ids = [course_id]

    quality = GradingQuality(scope_course_id=course_id)
    if not course_ids:
        # 这句话会原样显示给用户，所以按角色说准：管理员看的不是「教师名下」
        quality.note = "当前还没有可统计的课程"
        return ApiResponse.ok(data=quality)

    base = (
        select(func.count(Submission.id), func.avg(Submission.score))
        .join(Assignment, Assignment.id == Submission.assignment_id)
        .where(Assignment.course_id.in_(course_ids))
    )
    row = (await db.execute(base)).first()
    quality.submission_count = int(row[0] or 0) if row else 0
    if row and row[1] is not None:
        quality.average_score = round(float(row[1]), 2)

    graded_q = (
        select(func.count(Submission.id))
        .join(Assignment, Assignment.id == Submission.assignment_id)
        .where(Assignment.course_id.in_(course_ids), Submission.status == "GRADED")
    )
    quality.graded_count = int((await db.execute(graded_q)).scalar() or 0)

    scans = await db.execute(
        select(VisionTask).where(
            VisionTask.scene == "paper_grading",
            VisionTask.course_id.in_(course_ids),
            VisionTask.status == "succeeded",
        )
    )
    scan_rows = list(scans.scalars().all())
    quality.scan_count = len(scan_rows)

    for task in scan_rows:
        if task.is_placeholder:
            quality.scan_placeholder_count += 1
        summary: Dict[str, Any] = {}
        if isinstance(task.summary_json, str):
            try:
                loaded = json.loads(task.summary_json)
                if isinstance(loaded, dict):
                    summary = loaded
            except json.JSONDecodeError:
                summary = {}
        if summary.get("need_review"):
            quality.need_review_count += 1
        quality.low_confidence_count += int(summary.get("low_confidence_count") or 0)

    quality.sample_enough = quality.scan_count >= 10
    if not quality.sample_enough:
        quality.note = (
            f"扫描样本仅 {quality.scan_count} 条，不足以评估批改质量，"
            "以下数字仅作参考，请勿直接作为结论"
        )
    elif quality.scan_placeholder_count:
        quality.note = (
            f"其中 {quality.scan_placeholder_count} 条来自示例内容，"
            "未经过真实识别，复核结论时需剔除"
        )
    else:
        quality.note = "样本充足，且均由真实模型产出"

    return ApiResponse.ok(data=quality)


@router.post("/feedback/{suggestion_id}/approve", response_model=ApiResponse[dict])
async def approve_feedback(
    suggestion_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """批改反馈确认：教师采用 AI 建议并写回成绩。"""
    if not AI_REVIEW_AVAILABLE or _ai_approve_feedback is None:
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail="批改反馈依赖的 AI 能力未启用",
        )
    return await _ai_approve_feedback(
        suggestion_id=suggestion_id, user=user, db=db
    )


@router.post("/feedback/{suggestion_id}/regenerate", response_model=ApiResponse[dict])
async def regenerate_feedback(
    suggestion_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """批改反馈重新生成。"""
    if not AI_REVIEW_AVAILABLE or _ai_regenerate_feedback is None:
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail="批改反馈依赖的 AI 能力未启用",
        )
    return await _ai_regenerate_feedback(
        suggestion_id=suggestion_id, user=user, db=db
    )


# ------------------------------------------------------------
# 学生侧：在线作答提交 / 成绩查询
# ------------------------------------------------------------


@router.post(
    "/assignments/{assignment_id}/submit",
    response_model=ApiResponse[SubmissionResponse],
)
async def submit_assignment(
    assignment_id: int,
    req: SubmissionSubmit,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_student),
):
    """在线作答提交。

    提交时若带图片附件，会自动登记一条拍照批改任务（见 assignment_service.submit），
    这是 YOLO 接进作业闭环的入口，不需要学生额外操作。
    """
    service = StudentService(db)
    try:
        file_ref = str(req.file_id) if req.file_id is not None else req.file_path
        data = await service.submit_assignment(
            assignment_id, user, req.content, file_ref, req.file_name, req.file_ids
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    return ApiResponse.ok(data=data, message="提交成功")


@router.get("/grades", response_model=ApiResponse[list])
async def my_grades(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_student),
):
    """成绩查询（学生视角）。"""
    return ApiResponse.ok(data=await StudentService(db).get_my_grades(user))


@router.get("/my-peer-reviews", response_model=ApiResponse[list])
async def my_peer_reviews(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_student),
):
    """分配给我的互评任务。"""
    return ApiResponse.ok(data=await StudentService(db).get_my_peer_reviews(user))
