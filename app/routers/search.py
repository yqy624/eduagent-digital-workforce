"""/api/search —— 桌面端顶栏的全局检索。

只做一件事：把「当前这个人有权看到的东西」按关键词捞出来。
可见范围与各业务接口保持一致，避免搜索变成一条绕开权限的侧信道：

    ADMIN    —— 全校课程 + 全校学生
    TEACHER  —— 自己名下的课程 + 这些课程里的学生
    STUDENT  —— 自己选修的课程（**不返回其他学生**：同学名册不该被同学搜到）

每个结果都带 target，前端据此决定点击后做什么（切换查看范围 / 打开某位学生的学情）。
这是「接线」：数据全部来自既有模型，不新建表、不复制业务逻辑。
"""
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.models import Course, Enrollment, User
from app.schemas.common import ApiResponse

router = APIRouter(prefix="/api/search", tags=["全局检索"])

# 每类结果的上限：搜索框是「快速跳转」，不是「列表页」，多了反而看不完
_MAX_ITEMS = 8


def _contains(keyword: str) -> str:
    """构造 LIKE 模式。先剥掉通配符，避免用户用 % 把全表拉出来。

    注意剥完之后**可能变成空串**（用户只输了 `%`），这时调用方必须当作
    「没输入」处理 —— 否则 `"%" + "" + "%"` 会匹配到全部记录。
    """
    cleaned = keyword.replace("%", "").replace("_", "").strip()
    if not cleaned:
        return ""
    return "%" + cleaned + "%"


@router.get("")
async def search(
    q: str = Query(default="", max_length=50, description="关键词"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """按角色可见范围检索课程与学生。空关键词返回空结果，不返回全量。"""
    keyword = (q or "").strip()
    pattern = _contains(keyword)
    if not pattern:
        return ApiResponse.ok(data={"query": keyword, "total": 0, "groups": []})

    role = user.role

    # ---------------- 课程 ----------------
    course_query = select(Course).where(Course.visible == True, Course.name.like(pattern))  # noqa: E712
    if role == "TEACHER":
        course_query = course_query.where(Course.teacher_id == user.id)
    elif role == "STUDENT":
        course_query = course_query.join(
            Enrollment, Enrollment.course_id == Course.id
        ).where(Enrollment.student_id == user.id)
    courses = list((await db.execute(course_query.limit(_MAX_ITEMS))).scalars().all())

    course_items: List[Dict[str, Any]] = []
    for course in courses:
        teacher = (
            await db.execute(select(User).where(User.id == course.teacher_id))
        ).scalar_one_or_none()
        bits = []
        if teacher:
            bits.append(teacher.display_name or teacher.username)
        if course.schedule:
            bits.append(course.schedule)
        course_items.append(
            {
                "id": course.id,
                "title": course.name,
                "subtitle": " · ".join(bits),
                "target": "course",
            }
        )

    # ---------------- 学生 ----------------
    # 学生自己不给学生结果：他能看到的人只有自己，给了反而像泄露名册。
    student_items: List[Dict[str, Any]] = []
    if role in ("ADMIN", "TEACHER"):
        student_query = select(User).where(
            User.role == "STUDENT",
            User.enabled == True,  # noqa: E712
            or_(
                User.display_name.like(pattern),
                User.username.like(pattern),
                User.student_no.like(pattern),
            ),
        )
        if role == "TEACHER":
            # 只搜「在我课上」的学生：一位老师不该通过搜索看到别人的学生
            student_query = (
                student_query.join(
                    Enrollment, Enrollment.student_id == User.id
                )
                .join(Course, Course.id == Enrollment.course_id)
                .where(Course.teacher_id == user.id)
            )
        rows = list((await db.execute(student_query.limit(_MAX_ITEMS * 2))).scalars().all())
        seen = set()
        for student in rows:
            if student.id in seen:
                continue
            seen.add(student.id)
            student_items.append(
                {
                    "id": student.id,
                    "title": student.display_name or student.username,
                    "subtitle": student.student_no or student.username,
                    "target": "student",
                }
            )
            if len(student_items) >= _MAX_ITEMS:
                break

    groups: List[Dict[str, Any]] = []
    if course_items:
        groups.append({"kind": "course", "label": "课程", "items": course_items})
    if student_items:
        groups.append({"kind": "student", "label": "学生", "items": student_items})

    return ApiResponse.ok(
        data={
            "query": keyword,
            "total": len(course_items) + len(student_items),
            "groups": groups,
        }
    )
