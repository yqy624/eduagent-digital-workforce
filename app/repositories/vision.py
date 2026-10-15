"""视觉域 Repository。

只做数据存取，不含业务判断；业务规则放在 app/services/ 下。
"""

from __future__ import annotations

from typing import Any, ClassVar, List, Optional, Type

from sqlalchemy import desc

from app.models.vision_models import (
    ModelAsset,
    VisionEvent,
    VisionIdentity,
    VisionTask,
)
from app.repositories.base import BaseRepository


class VisionTaskRepository(BaseRepository[VisionTask]):
    model: ClassVar[Type[VisionTask]] = VisionTask

    async def get_by_code(self, task_code: str) -> Optional[VisionTask]:
        return await self.find_one(VisionTask.task_code == task_code)

    async def list_recent(self, scene: Optional[str] = None, limit: int = 20):
        where: List[Any] = []
        if scene:
            where.append(VisionTask.scene == scene)
        return await self.list(
            *where, order_by=desc(VisionTask.id), limit=limit, offset=0
        )

    async def mark_running(self, task: VisionTask) -> VisionTask:
        return await self.update(task, status="running", progress=10)

    async def mark_succeeded(
        self,
        task: VisionTask,
        *,
        result_json: str,
        summary_json: str,
        provider: str,
        model_name: str,
        is_placeholder: bool,
        latency_ms: float,
    ) -> VisionTask:
        return await self.update(
            task,
            status="succeeded",
            progress=100,
            result_json=result_json,
            summary_json=summary_json,
            provider=provider,
            model_name=model_name,
            is_placeholder=is_placeholder,
            latency_ms=latency_ms,
            error_kind=None,
            error_message=None,
        )

    async def mark_failed(
        self, task: VisionTask, *, error_kind: str, error_message: str
    ) -> VisionTask:
        return await self.update(
            task,
            status="failed",
            error_kind=error_kind,
            error_message=error_message[:2000],
        )


class VisionEventRepository(BaseRepository[VisionEvent]):
    model: ClassVar[Type[VisionEvent]] = VisionEvent

    async def list_by_task(self, task_code: str, limit: int = 200):
        return await self.list(
            VisionEvent.task_code == task_code,
            order_by=desc(VisionEvent.id),
            limit=limit,
            offset=0,
        )

    async def list_unacknowledged(self, severity: Optional[str] = None, limit: int = 50):
        where: List[Any] = [VisionEvent.acknowledged.is_(False)]
        if severity:
            where.append(VisionEvent.severity == severity)
        return await self.list(*where, order_by=desc(VisionEvent.id), limit=limit, offset=0)

    async def count_by_severity(self) -> dict[str, int]:
        result: dict[str, int] = {}
        for level in ("info", "warning", "critical"):
            result[level] = await self.count(VisionEvent.severity == level)
        return result


class VisionIdentityRepository(BaseRepository[VisionIdentity]):
    model: ClassVar[Type[VisionIdentity]] = VisionIdentity

    async def resolve(
        self, scene: str, seat_ref: str
    ) -> Optional[VisionIdentity]:
        return await self.find_one(
            VisionIdentity.scene == scene,
            VisionIdentity.seat_ref == seat_ref,
            VisionIdentity.enabled.is_(True),
        )


class ModelAssetRepository(BaseRepository[ModelAsset]):
    model: ClassVar[Type[ModelAsset]] = ModelAsset

    async def list_by_capability(self, capability: str):
        return await self.list(
            ModelAsset.capability == capability,
            order_by=desc(ModelAsset.id),
            limit=100,
            offset=0,
        )
