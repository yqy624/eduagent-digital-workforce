"""视觉感知中枢 — RESTful 接口。

命名规则遵循模块化的命名空间约定：
    /api/vision/*     视觉域（未来可独立成服务，网关转发即可，业务代码不动）
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.models.registry import registry
from app.database import get_db
from app.middleware.auth import get_current_user, require_teacher
from app.models.models import User
from app.models.vision_models import ModelAsset, VisionIdentity
from app.repositories.vision import VisionIdentityRepository
from app.schemas.common import ApiResponse
from app.schemas.vision import (
    ModelAssetOut,
    SceneOption,
    VisionIdentityIn,
    VisionIdentityOut,
    VisionEventOut,
    VisionOverview,
    VisionTaskCreateRequest,
    VisionTaskOut,
)
from app.services.vision_service import VisionService

router = APIRouter(
    prefix="/api/vision",
    tags=["视觉感知中枢"],
    dependencies=[Depends(get_current_user)],
)

SCENE_DESCRIPTIONS = {
    "classroom": "课堂行为识别：抬头/低头、注意力、手机使用",
    "lab_safety": "实验室安全与违规识别：手套、护目镜、实验服",
    "exam_proctor": "考试监考：作弊行为嫌疑检测",
    "paper_grading": "拍照批改：题块定位与作答区域切分",
}


def _service(db: AsyncSession = Depends(get_db)) -> VisionService:
    return VisionService(db)


@router.get("/scenes", response_model=ApiResponse[list[SceneOption]])
async def list_scenes():
    """可用场景清单。前端场景选择器直接消费。"""
    from app.core.models.contracts import SCENE_LABELS, VisionScene

    scenes = [
        SceneOption(
            value=s.value,
            label=SCENE_LABELS[s],
            description=SCENE_DESCRIPTIONS.get(s.value, ""),
        )
        for s in VisionScene
    ]
    return ApiResponse.ok(data=scenes)


@router.post(
    "/tasks",
    response_model=ApiResponse[VisionTaskOut],
    dependencies=[Depends(require_teacher)],
    status_code=status.HTTP_201_CREATED,
)
async def create_task(
    req: VisionTaskCreateRequest,
    service: VisionService = Depends(_service),
    user: User = Depends(get_current_user),
):
    """创建并执行一次视觉分析任务。

    模型失败不会抛 500：任务会被标记 failed 并在 error_kind 里给出分类，
    保证"模型没接好"时接口依旧可用、可观测。
    """
    task = await service.run_task(req, operator=user.username)
    return ApiResponse.ok(data=VisionTaskOut.model_validate(task), message="任务已提交")


@router.get("/tasks", response_model=ApiResponse[dict])
async def list_tasks(
    scene: Optional[str] = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=200),
    service: VisionService = Depends(_service),
):
    """任务列表（分页）。"""
    result = await service.paginate_tasks(scene=scene, page=page, page_size=page_size)
    items = [VisionTaskOut.model_validate(t).model_dump() for t in result["items"]]
    return ApiResponse.ok(
        data={
            "items": items,
            "total": result["total"],
            "page": result["page"],
            "page_size": result["page_size"],
            "total_pages": result["total_pages"],
        }
    )


@router.get("/tasks/{task_code}", response_model=ApiResponse[VisionTaskOut])
async def get_task(task_code: str, service: VisionService = Depends(_service)):
    task = await service.get_task(task_code)
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="任务不存在")
    return ApiResponse.ok(data=VisionTaskOut.model_validate(task))


@router.get("/events", response_model=ApiResponse[list[VisionEventOut]])
async def list_events(
    severity: Optional[str] = Query(default=None, pattern="^(info|warning|critical)$"),
    acknowledged: Optional[bool] = Query(default=None),
    limit: int = Query(default=50, ge=1, le=500),
    service: VisionService = Depends(_service),
):
    """事件流。学情洞察与态势告警消费的入口。"""
    events = await service.list_events(
        severity=severity, acknowledged=acknowledged, limit=limit
    )
    return ApiResponse.ok(data=[VisionEventOut.model_validate(e) for e in events])


@router.post(
    "/events/{event_id}/ack",
    response_model=ApiResponse[VisionEventOut],
    dependencies=[Depends(require_teacher)],
)
async def acknowledge_event(event_id: int, service: VisionService = Depends(_service)):
    """确认（处置）一条事件。"""
    event = await service.acknowledge_event(event_id)
    if event is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="事件不存在")
    return ApiResponse.ok(data=VisionEventOut.model_validate(event), message="已确认")


@router.get("/identities", response_model=ApiResponse[list[VisionIdentityOut]])
async def list_identities(
    scene: Optional[str] = Query(default=None),
    service: VisionService = Depends(_service),
):
    """身份映射表：视觉目标 -> 业务主体。"""
    repo = VisionIdentityRepository(service.session)
    where = [VisionIdentity.scene == scene] if scene else []
    rows = await repo.list(*where, limit=500, offset=0)
    return ApiResponse.ok(data=[VisionIdentityOut.model_validate(r) for r in rows])


@router.post(
    "/identities",
    response_model=ApiResponse[VisionIdentityOut],
    dependencies=[Depends(require_teacher)],
    status_code=status.HTTP_201_CREATED,
)
async def create_identity(
    req: VisionIdentityIn,
    service: VisionService = Depends(_service),
):
    """新增身份映射。座位号 + 场景 决定一个视觉目标对应哪个学生。"""
    from datetime import datetime

    identity = await service.identities.create(
        created_at=datetime.now(),
        scene=req.scene,
        seat_ref=req.seat_ref,
        student_no=req.student_no,
        display_name=req.display_name,
        track_id=req.track_id,
        course_id=req.course_id,
        enabled=True,
    )
    return ApiResponse.ok(data=VisionIdentityOut.model_validate(identity), message="已绑定")


@router.get("/models", response_model=ApiResponse[dict])
async def list_models(service: VisionService = Depends(_service)):
    """模型资产 + 注册表状态。

    这个接口是"模型接入清单"的运行时版本：
    能看到每个能力的可用实现、当前默认实现、以及哪些还跑在占位上。
    """
    result = await service.session.execute(select(ModelAsset))
    asset_rows = list(result.scalars().all())

    return ApiResponse.ok(
        data={
            "registry": registry.list_providers(),
            "assets": [ModelAssetOut.model_validate(a).model_dump() for a in asset_rows],
        }
    )


@router.get("/overview", response_model=ApiResponse[VisionOverview])
async def overview(service: VisionService = Depends(_service)):
    """视觉模块概览，供态势感知看板消费。"""
    return ApiResponse.ok(data=await service.overview())
