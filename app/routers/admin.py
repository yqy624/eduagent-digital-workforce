"""管理员路由"""
from typing import Optional
from fastapi import APIRouter, Body, Depends, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.middleware.auth import require_admin
from app.models.models import User
from app.schemas.auth import RegisterRequest, UserResponse
from app.schemas.common import ApiResponse
from app.services.admin_service import AdminService

router = APIRouter(prefix="/api/admin", tags=["管理员"], dependencies=[Depends(require_admin)])


@router.get("/dashboard")
async def dashboard(db: AsyncSession = Depends(get_db)):
    """管理后台数据"""
    service = AdminService(db)
    data = await service.get_dashboard()
    return ApiResponse.ok(data=data)


@router.get("/users")
async def list_users(
    role: Optional[str] = Query(None, pattern="^(ADMIN|TEACHER|STUDENT)?$"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    """用户列表"""
    service = AdminService(db)
    data = await service.list_users(role, page, page_size)
    return ApiResponse.ok(data=data)


@router.get("/users/export", include_in_schema=False)
async def export_users(db: AsyncSession = Depends(get_db)):
    service = AdminService(db)
    csv_content = await service.export_users_csv()
    return Response(
        content="\ufeff" + csv_content,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="users.csv"'},
    )


@router.post("/users")
async def create_user(
    req: RegisterRequest, db: AsyncSession = Depends(get_db)
):
    """创建用户"""
    service = AdminService(db)
    try:
        user = await service.create_user(req)
        return ApiResponse.ok(data=user, message="创建成功")
    except ValueError as e:
        return ApiResponse.error(message=str(e), code=400)


@router.put("/courses/{course_id}/visibility", include_in_schema=False)
async def toggle_visibility(course_id: int, db: AsyncSession = Depends(get_db)):
    """切换课程可见性"""
    from app.models.models import Course
    from sqlalchemy import select
    result = await db.execute(select(Course).where(Course.id == course_id))
    course = result.scalar_one_or_none()
    if not course:
        return ApiResponse.error(message="课程不存在", code=404)
    course.visible = not course.visible
    await db.flush()
    if course.visible:
        from app.services.notification_service import NotificationService
        await NotificationService(db).create_for_roles(
            ["STUDENT"],
            "课程重新上架",
            f"课程《{course.name}》已重新开放。",
            category="COURSE",
            type_="INFO",
            link=f"/platform#/review/review-courses",
        )
    return ApiResponse.ok(data={"visible": course.visible}, message="更新成功")


@router.get("/activities", include_in_schema=False)
async def list_activities(db: AsyncSession = Depends(get_db)):
    """活动列表"""
    service = AdminService(db)
    return ApiResponse.ok(data=await service.list_activities())


@router.post("/activities", include_in_schema=False)
async def create_activity(
    body: dict = Body(...),
    user: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    service = AdminService(db)
    try:
        activity = await service.create_activity(
            str(body.get("title") or "").strip(),
            str(body.get("content") or "").strip(),
            body.get("audience") or "ALL",
            user.username,
            body.get("link"),
        )
        return ApiResponse.ok(data=service._activity_dict(activity), message="Activity published")
    except ValueError as e:
        return ApiResponse.error(message=str(e), code=400)


@router.put("/activities/{activity_id}", include_in_schema=False)
async def update_activity(
    activity_id: int,
    body: dict = Body(...),
    user: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    service = AdminService(db)
    try:
        activity = await service.update_activity(activity_id, body, user.username)
        return ApiResponse.ok(data=service._activity_dict(activity), message="Activity updated")
    except ValueError as e:
        return ApiResponse.error(message=str(e), code=400)


@router.post("/activities/{activity_id}/republish", include_in_schema=False)
async def republish_activity(
    activity_id: int,
    user: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    service = AdminService(db)
    try:
        activity = await service.republish_activity(activity_id, user.username)
        return ApiResponse.ok(data=service._activity_dict(activity), message="Activity republished")
    except ValueError as e:
        return ApiResponse.error(message=str(e), code=400)


@router.delete("/activities/{activity_id}", include_in_schema=False)
async def delete_activity(activity_id: int, db: AsyncSession = Depends(get_db)):
    service = AdminService(db)
    try:
        await service.delete_activity(activity_id)
        return ApiResponse.ok(message="Activity deleted")
    except ValueError as e:
        return ApiResponse.error(message=str(e), code=400)


@router.get("/monitor", include_in_schema=False)
async def monitor(
    health_check: bool = Query(False, alias="healthCheck"),
    db: AsyncSession = Depends(get_db),
):
    """系统监控"""
    service = AdminService(db)
    return ApiResponse.ok(data=await service.get_monitor(health_check=health_check))


@router.put("/courses/batch-hide", include_in_schema=False)
async def batch_hide_courses(body: dict = Body(...), db: AsyncSession = Depends(get_db)):
    service = AdminService(db)
    data = await service.batch_hide_courses(body.get("courseIds") or body.get("course_ids") or [])
    return ApiResponse.ok(data=data, message="Batch hide finished")


@router.delete("/courses/batch-delete", include_in_schema=False)
async def batch_delete_courses(body: dict = Body(...), db: AsyncSession = Depends(get_db)):
    service = AdminService(db)
    data = await service.batch_delete_courses(body.get("courseIds") or body.get("course_ids") or [])
    return ApiResponse.ok(data=data, message="Batch delete finished")


@router.put("/courses/{course_id}", include_in_schema=False)
async def update_course(course_id: int, body: dict = Body(...), db: AsyncSession = Depends(get_db)):
    service = AdminService(db)
    try:
        data = await service.update_course(course_id, body)
        return ApiResponse.ok(data=data, message="Course updated")
    except ValueError as e:
        return ApiResponse.error(message=str(e), code=400)


@router.delete("/courses/{course_id}", include_in_schema=False)
async def delete_course(course_id: int, db: AsyncSession = Depends(get_db)):
    service = AdminService(db)
    try:
        data = await service.delete_course(course_id)
        return ApiResponse.ok(data=data, message="Course deleted")
    except ValueError as e:
        return ApiResponse.error(message=str(e), code=400)


@router.put("/users/{user_id}/toggle", include_in_schema=False)
async def toggle_user_compat(user_id: int, db: AsyncSession = Depends(get_db)):
    service = AdminService(db)
    enabled = await service.toggle_user_enabled(user_id)
    return ApiResponse.ok(data={"enabled": enabled})


@router.delete("/users/{user_id}", include_in_schema=False)
async def delete_user(user_id: int, db: AsyncSession = Depends(get_db)):
    from app.models.models import User as _U
    from sqlalchemy import select
    r = await db.execute(select(_U).where(_U.id == user_id))
    u = r.scalar_one_or_none()
    if not u: return ApiResponse.error(message="用户不存在", code=404)
    await db.delete(u)
    await db.flush()
    return ApiResponse.ok(message="已删除")


@router.put("/users/{user_id}/password", include_in_schema=False)
async def reset_pwd(user_id: int, body: dict = {}, db: AsyncSession = Depends(get_db)):
    from app.middleware.auth import hash_password as _hp
    from app.models.models import User as _U
    from sqlalchemy import select
    r = await db.execute(select(_U).where(_U.id == user_id))
    u = r.scalar_one_or_none()
    if not u: return ApiResponse.error(message="用户不存在", code=404)
    u.password = _hp(body.get("password", "123456"))
    await db.flush()
    return ApiResponse.ok(message="密码已重置")


@router.get("/courses/{course_id}/enrollments", include_in_schema=False)
async def course_enrollments(course_id: int, db: AsyncSession = Depends(get_db)):
    service = AdminService(db)
    try:
        return ApiResponse.ok(data=await service.get_course_enrollments(course_id))
    except ValueError as e:
        return ApiResponse.error(message=str(e), code=400)


@router.put("/courses/{course_id}/enrollments", include_in_schema=False)
async def update_course_enrollments(
    course_id: int,
    body: dict = Body(...),
    db: AsyncSession = Depends(get_db),
):
    service = AdminService(db)
    try:
        data = await service.update_course_enrollments(course_id, body)
        return ApiResponse.ok(data=data, message="Course enrollments updated")
    except ValueError as e:
        return ApiResponse.error(message=str(e), code=400)
