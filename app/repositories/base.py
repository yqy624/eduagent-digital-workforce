"""数据访问层：Repository 抽象。

存在的唯一理由：**让业务代码不直接碰 ORM 与具体数据库**。
业务层拿到的是 Repository 接口，换成别的真实数据源（另一套库、外部 API、
甚至 CSV）时，只要实现同样的接口即可，业务代码零改动。
"""

from __future__ import annotations

from typing import Any, ClassVar, Generic, List, Optional, Sequence, Type, TypeVar

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import Select

from app.database import Base

ModelT = TypeVar("ModelT", bound=Base)


class BaseRepository(Generic[ModelT]):
    """通用 Repository。子类声明 model 即可获得全部基础能力。"""

    model: ClassVar[Type[ModelT]]

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    # ------------------------------------------------------------
    # 读
    # ------------------------------------------------------------

    def _base_select(self, where: Optional[Sequence[Any]] = None) -> Select:
        stmt = select(self.model)
        for cond in where or []:
            stmt = stmt.where(cond)
        return stmt

    async def get(self, pk: Any) -> Optional[ModelT]:
        return await self.session.get(self.model, pk)

    async def find_one(self, *where: Any) -> Optional[ModelT]:
        result = await self.session.execute(self._base_select(where).limit(1))
        return result.scalar_one_or_none()

    async def list(
        self,
        *where: Any,
        order_by: Any = None,
        limit: int = 100,
        offset: int = 0,
    ) -> List[ModelT]:
        stmt = self._base_select(where)
        if order_by is not None:
            stmt = stmt.order_by(order_by)
        stmt = stmt.limit(limit).offset(offset)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def count(self, *where: Any) -> int:
        stmt = select(func.count()).select_from(self.model)
        for cond in where:
            stmt = stmt.where(cond)
        result = await self.session.execute(stmt)
        return int(result.scalar_one() or 0)

    async def paginate(
        self,
        *where: Any,
        order_by: Any = None,
        page: int = 1,
        page_size: int = 20,
    ) -> dict[str, Any]:
        page = max(1, page)
        page_size = max(1, min(page_size, 200))
        total = await self.count(*where)
        items = await self.list(
            *where, order_by=order_by, limit=page_size, offset=(page - 1) * page_size
        )
        total_pages = (total + page_size - 1) // page_size
        return {
            "items": items,
            "total": total,
            "page": page,
            "page_size": page_size,
            "total_pages": total_pages,
        }

    # ------------------------------------------------------------
    # 写
    # ------------------------------------------------------------

    async def create(self, **kwargs: Any) -> ModelT:
        entity = self.model(**kwargs)  # type: ignore[call-arg]
        self.session.add(entity)
        await self.session.flush()
        return entity

    async def create_all(self, rows: List[dict[str, Any]]) -> List[ModelT]:
        entities = [self.model(**row) for row in rows]  # type: ignore[call-arg]
        self.session.add_all(entities)
        await self.session.flush()
        return entities

    async def update(self, entity: ModelT, **kwargs: Any) -> ModelT:
        for key, value in kwargs.items():
            setattr(entity, key, value)
        await self.session.flush()
        return entity

    async def delete(self, entity: ModelT) -> None:
        await self.session.delete(entity)
        await self.session.flush()
