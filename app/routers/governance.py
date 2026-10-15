"""/api/governance/* —— 平台治理命名空间。

菜单契约（static/js/menu.config.js）给治理模块定的是 /api/governance/*。
本文件把这些能力按该命名空间暴露出来，内部**直接复用**已有的
AdminService 与模型注册表，不重写任何业务逻辑 —— 属于"接线"，不是"重建"。

权限与 /api/admin 保持一致：仅 ADMIN。前端对 403 已做中性降级。
"""
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.models.registry import registry
from app.database import get_db
from app.middleware.auth import require_admin
from app.models.models import StoredFile
from app.models.vision_models import ModelAsset
from app.schemas.common import ApiResponse
from app.services.admin_service import AdminService

router = APIRouter(
    prefix="/api/governance",
    tags=["平台治理"],
    dependencies=[Depends(require_admin)],
)


@router.get("/overview")
async def overview(db: AsyncSession = Depends(get_db)):
    """治理总览：复用管理后台 dashboard 的同一份口径。"""
    return ApiResponse.ok(data=await AdminService(db).get_dashboard())


@router.get("/users")
async def users(
    role: Optional[str] = Query(default=None, pattern="^(ADMIN|TEACHER|STUDENT)?$"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    """用户与权限。"""
    return ApiResponse.ok(data=await AdminService(db).list_users(role, page, page_size))


@router.get("/org")
async def org(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
):
    """组织架构与班级：课程即班级载体。"""
    return ApiResponse.ok(data=await AdminService(db).list_courses(page, page_size))


@router.get("/audit-logs")
async def audit_logs(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    """审计日志：谁在什么时候做了什么。"""
    return ApiResponse.ok(data=await AdminService(db).get_audit_logs(page, page_size))


@router.get("/monitor")
async def monitor(
    health_check: bool = Query(default=False),
    db: AsyncSession = Depends(get_db),
):
    """系统健康监控：运行时指标、趋势、阈值告警。"""
    return ApiResponse.ok(data=await AdminService(db).get_monitor(health_check=health_check))


@router.get("/compute")
async def compute(db: AsyncSession = Depends(get_db)):
    """模型与算力资源：模型注册表 + model_assets 资产表。

    这是本模块区别于普通管理后台的关键 —— 模型被当作资产管理。
    """
    rows = list((await db.execute(select(ModelAsset))).scalars().all())
    return ApiResponse.ok(
        data={
            "registry": registry.list_providers(),
            "assets": [
                {
                    "id": a.id,
                    "asset_code": a.asset_code,
                    "name": a.name,
                    "capability": a.capability,
                    "framework": a.framework,
                    "version": a.version,
                    "weights_path": a.weights_path,
                    "source": a.source,
                    "license": a.license,
                    "is_placeholder": a.is_placeholder,
                    "enabled": a.enabled,
                    "notes": a.notes,
                }
                for a in rows
            ],
        }
    )


@router.get("/files")
async def files(
    limit: int = Query(default=100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    """文件与对象存储：stored_files 表。

    /api/files 只提供 upload/preview/download，没有列表接口；
    这里补上列表能力，让"文件与对象存储"页有真实数据可看。
    """
    rows = list(
        (await db.execute(select(StoredFile).order_by(StoredFile.id.desc()).limit(limit)))
        .scalars()
        .all()
    )
    return ApiResponse.ok(
        data=[
            {
                "id": f.id,
                "original_name": f.original_name,
                "object_key": f.object_key,
                "bucket": f.bucket,
                "category": f.category,
                "content_type": f.content_type,
                "extension": f.extension,
                "size": f.size,
                "course_id": f.course_id,
                "assignment_id": f.assignment_id,
                "submission_id": f.submission_id,
                "uploader_user_id": f.uploader_user_id,
                "created_at": f.created_at.isoformat() if f.created_at else None,
            }
            for f in rows
        ]
    )
