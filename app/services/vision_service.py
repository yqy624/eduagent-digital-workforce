"""视觉域业务逻辑。

职责边界：
- 编排「调用模型 -> 落库 -> 派生事件 -> 身份映射」这条链路
- **不直接依赖任何具体模型**：只通过 registry 拿 Provider
- 模型失败不算业务异常：任务会被标记 failed 并保留错误分类，接口仍返回 200
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.models import VisionRequest, VisionScene
from app.core.models.registry import registry
from app.models.vision_models import VisionEvent, VisionTask
from app.repositories.vision import (
    VisionEventRepository,
    VisionIdentityRepository,
    VisionTaskRepository,
)
from app.schemas.vision import VALID_SCENES, VisionOverview, VisionTaskCreateRequest

logger = logging.getLogger(__name__)


def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def _new_task_code() -> str:
    return f"VT{datetime.now().strftime('%Y%m%d%H%M%S')}{uuid.uuid4().hex[:6].upper()}"


class VisionService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.tasks = VisionTaskRepository(session)
        self.events = VisionEventRepository(session)
        self.identities = VisionIdentityRepository(session)

    # ------------------------------------------------------------
    # 执行分析任务
    # ------------------------------------------------------------

    async def run_task(
        self,
        req: VisionTaskCreateRequest,
        operator: Optional[str] = None,
        task: Optional[VisionTask] = None,
    ) -> VisionTask:
        """执行一次视觉分析任务。

        task 非空时复用已有记录（作业提交时登记的那条 pending 任务），
        避免同一份作业产生两条任务记录。
        """
        provider = registry.get("vision", req.backend)

        if task is None:
            task = await self.tasks.create(
                task_code=_new_task_code(),
                scene=req.scene,
                source_ref=req.source_ref,
                source_type=req.source_type,
                status="pending",
                progress=0,
                provider=provider.name,
                model_name=provider.model_name,
                is_placeholder=provider.is_placeholder,
                params_json=_dump(req.model_dump()),
                course_id=req.course_id,
                operator=operator,
                # 业务绑定：视觉结果挂回原平台的作业 / 提交 / 文件
                submission_id=req.submission_id,
                assignment_id=req.assignment_id,
                file_id=req.file_id,
                created_at=datetime.now(),
                updated_at=datetime.now(),
            )
        else:
            await self.tasks.update(
                task,
                source_ref=req.source_ref,
                provider=provider.name,
                model_name=provider.model_name,
                is_placeholder=provider.is_placeholder,
                params_json=_dump(req.model_dump()),
                course_id=req.course_id,
                operator=operator,
                submission_id=req.submission_id,
                assignment_id=req.assignment_id,
                file_id=req.file_id,
                updated_at=datetime.now(),
            )

        await self.tasks.mark_running(task)

        request = VisionRequest(
            scene=VisionScene(req.scene),
            source_ref=req.source_ref,
            source_type=req.source_type,
            conf=req.conf,
            iou=req.iou,
            imgsz=req.imgsz,
            with_identity=req.with_identity,
        )

        result = await provider.invoke(request)

        if not result.ok:
            error = result.error
            logger.warning(
                "vision task %s failed: [%s] %s",
                task.task_code,
                error.kind.value if error else "unknown",
                error.message if error else "",
            )
            return await self.tasks.mark_failed(
                task,
                error_kind=error.kind.value if error else "provider_error",
                error_message=error.message if error else "未知错误",
            )

        state = result.data
        await self._persist_events(task, state.events, req.with_identity)

        return await self.tasks.mark_succeeded(
            task,
            result_json=_dump(state.model_dump()),
            summary_json=_dump(state.summary),
            provider=result.meta.provider,
            model_name=result.meta.model_name,
            is_placeholder=result.meta.is_placeholder,
            latency_ms=result.meta.latency_ms,
        )

    async def _persist_events(self, task: VisionTask, events, with_identity: bool) -> None:
        """把 SceneState 的事件流落库，并做身份映射。"""
        now = datetime.now()
        rows: List[Dict[str, Any]] = []

        for event in events:
            seat = (event.evidence or {}).get("seat")
            # 身份映射的落点：视觉只认座位/轨迹，业务才认学号。
            # 映射不到时退回座位号，保证事件始终可定位，不至于丢失主体。
            subject_ref = event.subject_ref or (str(seat) if seat else None)
            if with_identity and seat:
                identity = await self.identities.resolve(task.scene, str(seat))
                if identity is not None:
                    subject_ref = identity.student_no

            rows.append(
                {
                    "created_at": now,
                    "task_id": task.id,
                    "task_code": task.task_code,
                    "scene": task.scene,
                    # 业务上下文一并落库，事件才能按课、按作业聚合
                    "course_id": task.course_id,
                    "assignment_id": task.assignment_id,
                    "submission_id": task.submission_id,
                    "event_type": event.type,
                    "event_label": event.label,
                    "severity": event.severity,
                    "confidence": event.confidence,
                    "duration_s": event.duration_s,
                    "subject_ref": subject_ref,
                    "seat_ref": (event.evidence or {}).get("seat"),
                    "frame_id": (event.evidence or {}).get("frame_id"),
                    "acknowledged": False,
                    "evidence_json": _dump(event.evidence or {}),
                }
            )

        if rows:
            await self.events.create_all(rows)
            # 消费侧：事件落库后按告警规则派发通知。
            # 派发失败只记日志——它不该反过来影响"事件已经落库"这个事实。
            try:
                from app.services.alert_rule_service import AlertRuleService

                await AlertRuleService(self.session).evaluate(rows)
            except Exception:  # noqa: BLE001
                logger.warning("告警派发失败（不影响事件落库）", exc_info=True)

    # ------------------------------------------------------------
    # 拍照批改：YOLO 接进原作业流程的落点
    # ------------------------------------------------------------

    async def scan_submission(
        self,
        req: "ScanRequest",
        operator: Optional[str] = None,
        task_code: Optional[str] = None,
    ) -> "ScanResult":
        """扫描一张作业照片。

        这是"视觉能力嵌入原业务"的示例链路：
            作业照片 -> 视觉任务 -> 题块定位 -> 教师复核 -> 评分
        刻意**不产出分数**：系统没有标准答案，凭识别结果直接给分等于编数据。
        """
        from sqlalchemy import select

        from app.models.models import Assignment
        from app.schemas.review import ScanBlock, ScanResult

        result = await self.session.execute(
            select(Assignment).where(Assignment.id == req.assignment_id)
        )
        assignment = result.scalar_one_or_none()
        if assignment is None:
            raise ValueError(f"作业不存在：{req.assignment_id}")

        task_req = VisionTaskCreateRequest(
            scene=VisionScene.PAPER_GRADING.value,
            source_ref=req.source_ref,
            source_type="image",
            conf=req.conf,
            # 批改场景没有座位概念，不做身份映射
            with_identity=False,
            course_id=assignment.course_id,
            assignment_id=req.assignment_id,
            submission_id=req.submission_id,
            file_id=req.file_id,
            backend=req.backend,
        )
        # 传入 task_code 时复用作业提交阶段登记的那条 pending 任务
        existing = await self.tasks.get_by_code(task_code) if task_code else None
        task = await self.run_task(task_req, operator=operator, task=existing)

        if task.status == "failed":
            return ScanResult(
                task_code=task.task_code,
                status="failed",
                is_placeholder=bool(task.is_placeholder),
                model_name=task.model_name,
                assignment_id=task.assignment_id,
                submission_id=task.submission_id,
                file_id=task.file_id,
                error_kind=task.error_kind,
                error_message=task.error_message,
                hint="识别失败，请检查素材路径或模型后端配置",
            )

        state = json.loads(task.result_json) if task.result_json else {}
        objects = state.get("objects") or []

        # 优先只取题块；若该模型不产出 question_block 类别，则退回全部目标
        has_block_cls = any(o.get("cls_name") == "question_block" for o in objects)
        blocks: List[ScanBlock] = []
        idx = 0
        for obj in objects:
            cls_name = obj.get("cls_name") or ""
            if has_block_cls and cls_name != "question_block":
                continue
            idx += 1
            blocks.append(
                ScanBlock(
                    index=idx,
                    cls_name=cls_name,
                    conf=float(obj.get("conf") or 0.0),
                    bbox=list(obj.get("bbox") or []),
                )
            )

        threshold = max(req.conf, 0.5)
        low = [b for b in blocks if b.conf < threshold]

        # 当前权重没训练出题块类别时，不能把通用检测目标说成"题块"
        if not has_block_cls and objects:
            hint = (
                "当前用的是通用识别模型，还不能准确框出题块；"
                "以下结果仅用于确认流程可用，正式批改请改用人工批改"
            )
        elif not blocks:
            hint = "没有找到题块：请确认图片清晰度，或改用人工批改"
        elif low:
            hint = f"共找到 {len(blocks)} 个题块，其中 {len(low)} 个不够清晰，建议人工复核后再给分"
        else:
            hint = f"共找到 {len(blocks)} 个题块，定位清楚"

        return ScanResult(
            task_code=task.task_code,
            status=task.status,
            is_placeholder=bool(task.is_placeholder),
            model_name=task.model_name,
            latency_ms=task.latency_ms,
            assignment_id=task.assignment_id,
            submission_id=task.submission_id,
            file_id=task.file_id,
            block_count=len(blocks),
            low_confidence_count=len(low),
            blocks=blocks,
            hint=hint,
            # 占位实现、低置信度、无题块、权重未训练题块类 —— 都必须人工复核
            need_review=bool(
                task.is_placeholder or low or not blocks or not has_block_cls
            ),
        )

    async def register_pending_task(
        self,
        *,
        scene: str,
        source_ref: str,
        source_type: str = "image",
        course_id: Optional[int] = None,
        assignment_id: Optional[int] = None,
        submission_id: Optional[int] = None,
        file_id: Optional[int] = None,
        operator: Optional[str] = None,
        stage: str = "registered",
        dedupe: bool = False,
    ) -> Optional[VisionTask]:
        """登记一条 pending 视觉任务，**不跑模型**。

        推理耗时不可控（冷启十余秒），绝不能挡住上传 / 提交这类交互。
        登记只回答"哪个文件要在哪个场景下被分析"，执行交给
        :func:`schedule_upload_analysis` 或教师在批改工作台手动触发。

        ``dedupe=True`` 时，同一主体已有 pending 任务则直接复用——
        否则同一份作业被重复提交会把待办清单刷成一片重复项。
        """
        if dedupe:
            existing = await self._find_pending(scene, file_id, submission_id)
            if existing is not None:
                return existing

        now = datetime.now()
        return await self.tasks.create(
            task_code=_new_task_code(),
            scene=scene,
            source_ref=source_ref,
            source_type=source_type,
            status="pending",
            progress=0,
            course_id=course_id,
            operator=operator,
            submission_id=submission_id,
            assignment_id=assignment_id,
            file_id=file_id,
            params_json=_dump(
                {
                    "scene": scene,
                    "source_ref": source_ref,
                    "stage": stage,
                }
            ),
            created_at=now,
            updated_at=now,
        )

    async def _find_pending(
        self, scene: str, file_id: Optional[int], submission_id: Optional[int]
    ) -> Optional[VisionTask]:
        """找同场景下同一主体的待执行任务，优先按文件、退回按提交。"""
        from sqlalchemy import desc

        for column, value in (
            (VisionTask.file_id, file_id),
            (VisionTask.submission_id, submission_id),
        ):
            if value is None:
                continue
            rows = await self.tasks.list(
                VisionTask.scene == scene,
                VisionTask.status == "pending",
                column == value,
                order_by=desc(VisionTask.id),
                limit=1,
                offset=0,
            )
            if rows:
                return rows[0]
        return None

    async def register_pending_scan(
        self,
        *,
        assignment_id: int,
        submission_id: Optional[int],
        file_id: Optional[int],
        source_ref: str,
        course_id: Optional[int] = None,
        operator: Optional[str] = None,
    ) -> Optional[VisionTask]:
        """作业提交时的"待拍照批改"登记。

        语义化封装：场景固定为 ``paper_grading``，且**必定去重**——
        学生重复提交同一份作业不应产生多条待批改记录。
        """
        return await self.register_pending_task(
            scene=VisionScene.PAPER_GRADING.value,
            source_ref=source_ref,
            source_type="image",
            course_id=course_id,
            assignment_id=assignment_id,
            submission_id=submission_id,
            file_id=file_id,
            operator=operator,
            stage="registered_by_submit",
            dedupe=True,
        )

    async def list_scan_tasks(
        self, assignment_id: Optional[int] = None, limit: int = 20
    ) -> List[VisionTask]:
        """列出拍照批改任务（教师工作台的"待批改"清单）。"""
        from sqlalchemy import desc

        where = [VisionTask.scene == VisionScene.PAPER_GRADING.value]
        if assignment_id:
            where.append(VisionTask.assignment_id == assignment_id)
        return await self.tasks.list(
            *where, order_by=desc(VisionTask.id), limit=limit, offset=0
        )

    # ------------------------------------------------------------
    # 查询
    # ------------------------------------------------------------

    async def list_tasks(self, scene: Optional[str] = None, limit: int = 20) -> List[VisionTask]:
        return await self.tasks.list_recent(scene=scene, limit=limit)

    async def get_task(self, task_code: str) -> Optional[VisionTask]:
        return await self.tasks.get_by_code(task_code)

    async def paginate_tasks(self, scene: Optional[str] = None, page: int = 1, page_size: int = 20):
        from sqlalchemy import desc

        where = [VisionTask.scene == scene] if scene else []
        return await self.tasks.paginate(
            *where, order_by=desc(VisionTask.id), page=page, page_size=page_size
        )

    async def list_events(
        self,
        *,
        severity: Optional[str] = None,
        acknowledged: Optional[bool] = None,
        limit: int = 50,
    ) -> List[VisionEvent]:
        if acknowledged is False:
            return await self.events.list_unacknowledged(severity=severity, limit=limit)
        where = []
        if severity:
            where.append(VisionEvent.severity == severity)
        if acknowledged is not None:
            where.append(VisionEvent.acknowledged.is_(acknowledged))
        from sqlalchemy import desc

        return await self.events.list(
            *where, order_by=desc(VisionEvent.id), limit=limit, offset=0
        )

    async def acknowledge_event(self, event_id: int) -> Optional[VisionEvent]:
        event = await self.events.get(event_id)
        if event is None:
            return None
        return await self.events.update(event, acknowledged=True)

    async def overview(self) -> VisionOverview:
        from app.core.models.contracts import SCENE_LABELS
        from app.schemas.vision import SceneOption

        task_total = await self.tasks.count()
        status_counts: Dict[str, int] = {}
        for status in ("pending", "running", "succeeded", "failed"):
            status_counts[status] = await self.tasks.count(VisionTask.status == status)

        event_total = await self.events.count()
        severity_counts = await self.events.count_by_severity()
        unack = await self.events.count(VisionEvent.acknowledged.is_(False))

        # 只报"当前生效的实现是占位"的能力。
        # 原实现遍历所有**已注册**实现，把"注册过占位"说成"正在使用占位"——
        # 配好真实后端后这份清单依旧不空，属于误报，会让人误判视觉没接上。
        # retrieval 不纳入：rag_backend=local 时走 edu 进程内的检索实现
        # （业务层降级路径，不是 Provider），http-rag 时是真实服务——两者都不是占位。
        placeholders: List[str] = []
        for cap in ("vision", "llm", "embedding"):
            effective = registry.effective_name(cap)
            info = registry.list_providers().get(cap, {}).get(effective, {})
            if info.get("is_placeholder"):
                placeholders.append(f"{cap}:{effective}")

        return VisionOverview(
            task_total=task_total,
            task_by_status=status_counts,
            event_total=event_total,
            event_by_severity=severity_counts,
            unacknowledged=unack,
            placeholders_in_use=sorted(set(placeholders)),
            scenes=[
                SceneOption(value=s.value, label=SCENE_LABELS[s], description="")
                for s in VisionScene
            ],
        )


# ------------------------------------------------------------
# 上传即感知：让 edu 侧上传的图片真正进入视觉模型
# ------------------------------------------------------------
#
# 在此之前，上传接口只做两件事——落盘、投递知识库；视觉任务只能由
# 调用方手填 source_ref 去调 /api/vision/tasks 创建。结果是平台里
# "上传的图片"与"被识别的图片"是两批互不相干的数据。
# 下面这组函数补上这一环，并且沿用入库投递的节奏：**登记同步、推理异步**。

_background_tasks: set = set()

# 需要人工复核的场景：只登记，由教师在工作台显式触发。
# 批改结果直接影响分数，不能让模型跑完就自动落分。
_REVIEW_BEFORE_RUN = {VisionScene.PAPER_GRADING.value}


def _spawn(coro) -> None:
    """把协程挂到事件循环，并持有引用防止被 GC 提前回收。"""
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


async def _run_registered_task(task_code: str) -> None:
    """后台执行一条已登记的 pending 任务（自建会话，不依赖请求生命周期）。"""
    from app.database import async_session_factory

    try:
        async with async_session_factory() as session:
            service = VisionService(session)
            task = await service.tasks.get_by_code(task_code)
            if task is None or task.status != "pending":
                # 已被人工触发或已终态，不重复跑
                return
            req = VisionTaskCreateRequest(
                scene=task.scene,
                source_ref=task.source_ref,
                source_type=task.source_type or "image",
                course_id=task.course_id,
                assignment_id=task.assignment_id,
                submission_id=task.submission_id,
                file_id=task.file_id,
                # 只有课堂场景存在"座位 → 学号"的映射；其余场景开着也映射不到，
                # 反而会让 subject_ref 落空，不如直接退回座位/目标本身
                with_identity=task.scene == VisionScene.CLASSROOM.value,
            )
            await service.run_task(req, operator=f"auto:{task.scene}", task=task)
            await session.commit()
    except Exception as exc:  # noqa: BLE001 - 感知失败不该影响上传/提交
        logger.warning("视觉任务后台执行异常 task=%s: %s", task_code, exc)


async def schedule_upload_analysis(
    *,
    file_id: int,
    scene: str,
    source_ref: str,
    course_id: Optional[int] = None,
    assignment_id: Optional[int] = None,
    submission_id: Optional[int] = None,
    operator: Optional[str] = None,
) -> Optional[str]:
    """上传图片后投递视觉分析，返回登记出的 task_code。

    两种节奏，由场景决定：

    - **需人工复核**（``paper_grading``）：只登记，教师在工作台触发
    - **自动感知**（课堂行为 / 实验室安全 / 监考）：登记后立刻后台执行

    与入库投递同一条纪律：登记是毫秒级写库（同步完成，可返回 task_code），
    推理放后台跑（冷启可能十余秒，绝不能拖住上传响应）。

    **调用方必须在数据库提交之后调用**——后台任务跑在独立会话里，
    提交前调度会读不到刚写入的文件记录。本函数不抛异常。
    """
    if scene not in VALID_SCENES:
        logger.warning("忽略未知视觉场景: %s（可选：%s）", scene, VALID_SCENES)
        return None

    task_code: Optional[str] = None
    try:
        from app.database import async_session_factory

        async with async_session_factory() as session:
            service = VisionService(session)
            task = await service.register_pending_task(
                scene=scene,
                source_ref=source_ref,
                source_type="image",
                course_id=course_id,
                assignment_id=assignment_id,
                submission_id=submission_id,
                file_id=file_id,
                operator=operator,
                stage="registered_by_upload",
                dedupe=True,
            )
            await session.commit()
            task_code = task.task_code if task is not None else None
    except Exception as exc:  # noqa: BLE001 - 登记失败不影响上传本身
        logger.warning("登记视觉任务失败（不影响上传）: %s", exc)
        return None

    if task_code and scene not in _REVIEW_BEFORE_RUN:
        _spawn(_run_registered_task(task_code))

    return task_code


# 图片来源判定：以扩展名与 content-type 双条件放行，
# 与 assignment_service 的 IMAGE_EXTENSIONS 保持同一集合。
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}


def is_image_upload(extension: Optional[str], content_type: Optional[str]) -> bool:
    """判断一个已上传文件是否可作为视觉输入。"""
    if (extension or "").lower() in IMAGE_EXTENSIONS:
        return True
    return bool((content_type or "").startswith("image/"))
