"""演示种子数据。

目的：在**没有真实训练数据、没有真实模型**的情况下，
系统依然能本地启动并跑通主流程（登录 -> 建视觉任务 -> 看事件 -> 看概览）。

用法：
    # 本地无依赖启动（推荐）
    DB_BACKEND=sqlite python scripts/seed_demo.py
    DB_BACKEND=sqlite python -m uvicorn app.main:app --port 8001

    # 用现有 MySQL
    python scripts/seed_demo.py

幂等：重复执行不会重复插入，已存在的账号/数据会被跳过。
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select  # noqa: E402

from app.config import settings  # noqa: E402
from app.database import async_session_factory, ensure_runtime_schema  # noqa: E402
from app.middleware.auth import hash_password  # noqa: E402
from app.models.models import Assignment, Course, Enrollment, Submission, User  # noqa: E402
from app.models.vision_models import AlertRule, ModelAsset, VisionIdentity  # noqa: E402

DEMO_PASSWORD = "Demo@12345"

# (username, role, display_name, student_no)
# student_no 必须与下方 SEATS 的学号一致——它才是视觉身份映射的连接键。
USERS = [
    ("admin", "ADMIN", "平台管理员", None),
    ("teacher01", "TEACHER", "张老师", None),
    ("student01", "STUDENT", "李同学", "S2024001"),
    ("student02", "STUDENT", "王同学", "S2024002"),
    ("student03", "STUDENT", "赵同学", "S2024003"),
]

# 座位表：视觉侧 seat_ref -> 业务侧学号。身份映射的基础数据。
SEATS = [
    ("classroom", "R1-C1", "S2024001", "李同学"),
    ("classroom", "R1-C2", "S2024002", "王同学"),
    ("classroom", "R1-C3", "S2024003", "赵同学"),
    ("lab_safety", "BENCH-01", "S2024001", "李同学"),
    ("lab_safety", "BENCH-02", "S2024002", "王同学"),
    ("exam_proctor", "A-01", "S2024001", "李同学"),
    ("exam_proctor", "A-02", "S2024002", "王同学"),
]

# 告警规则：视觉事件的消费侧配置。没有它，critical 事件只是躺在表里的一行记录。
ALERT_RULES = [
    {
        "name": "实验室严重违规即时告警",
        "scene": "lab_safety",
        "severity": "critical",
        "notify_student": True,
        "notify_roles": "TEACHER,ADMIN",
        "dedup_minutes": 10,
    },
    {
        "name": "课堂行为关注项上报",
        "scene": "classroom",
        "severity": "warning",
        "notify_student": False,
        "notify_roles": "TEACHER,ADMIN",
        "dedup_minutes": 30,
    },
    {
        "name": "考场异常全局告警",
        "scene": "exam_proctor",
        "severity": "warning",
        "notify_student": True,
        "notify_roles": "ADMIN",
        "dedup_minutes": 5,
    },
]

# 模型资产：示例实现也登记在册，替换正式模型时把 is_placeholder 改成 False 即可。
# name 会直接显示在用户的「识别模型」列表里 —— 只写用户能读懂的词，
# 不出现「占位 / 真实模型 / YOLO11n」这类实现细节（技术细节留在 framework / version / notes）。
MODEL_ASSETS = [
    {
        "asset_code": "vis-classroom-placeholder",
        "name": "课堂行为识别 · 示例版",
        "capability": "vision",
        "framework": "placeholder",
        "version": "0.0.0-placeholder",
        "source": "内置占位实现",
        "license": "N/A",
        "is_placeholder": True,
        "notes": "替换步骤见 模型接入清单.md：实现 VisionProvider 并注册到 registry",
    },
    {
        "asset_code": "vis-yolo11n",
        "name": "通用目标检测 · 正式版",
        "capability": "vision",
        "framework": "ultralytics",
        "version": "yolo11n",
        "source": "hf-mirror.com/Ultralytics/YOLO11",
        "license": "AGPL-3.0",
        "is_placeholder": False,
        "notes": "权重已落地在 yolo-platform/weights/yolo11n.pt，通过子进程转发调用",
    },
    {
        "asset_code": "llm-placeholder",
        "name": "教育大模型 · 示例版",
        "capability": "llm",
        "framework": "placeholder",
        "version": "0.0.0-placeholder",
        "source": "内置占位实现",
        "license": "N/A",
        "is_placeholder": True,
        "notes": "覆盖解题讲解/评语生成/知识问答/学情报告/适龄改写五类任务",
    },
    {
        "asset_code": "emb-placeholder",
        "name": "资料语义理解 · 示例版",
        "capability": "embedding",
        "framework": "placeholder-hash",
        "version": "0.0.0-placeholder",
        "source": "内置占位实现",
        "license": "N/A",
        "is_placeholder": True,
        "notes": "字符二元组哈希向量，确定性可复现；正式模型建议 bge-m3",
    },
]


async def _seed_users(session) -> dict[str, User]:
    created: dict[str, User] = {}
    for username, role, display, student_no in USERS:
        existing = (
            await session.execute(select(User).where(User.username == username))
        ).scalar_one_or_none()
        if existing is not None:
            # 幂等回填：老库里已存在的学生账号没有学号，不补则身份连接键仍然断裂。
            if student_no and existing.student_no != student_no:
                existing.student_no = student_no
            created[username] = existing
            continue
        user = User(
            username=username,
            password=hash_password(DEMO_PASSWORD),
            role=role,
            display_name=display,
            student_no=student_no,
            email=f"{username}@demo.edu",
            enabled=True,
            created_at=datetime.now(),
        )
        session.add(user)
        await session.flush()
        created[username] = user
    return created


async def _seed_course(session, users: dict[str, User]) -> Course:
    teacher = users["teacher01"]
    existing = (
        await session.execute(select(Course).where(Course.name == "智能视觉导论"))
    ).scalar_one_or_none()
    if existing is not None:
        return existing

    course = Course(
        name="智能视觉导论",
        description="演示课程：用于跑通视觉 -> 学情的主流程",
        credits=3,
        max_students=50,
        enrolled_count=0,
        teacher_id=teacher.id,
        schedule="周一 3-4 节",
        category="演示",
        created_at=datetime.now(),
        visible=True,
    )
    session.add(course)
    await session.flush()

    for username in ("student01", "student02", "student03"):
        session.add(
            Enrollment(
                course_id=course.id,
                student_id=users[username].id,
                enrolled_at=datetime.now(),
                score=0,
                base_score=0,
                peer_review_bonus=0,
            )
        )
    await session.flush()

    assignment = Assignment(
        title="第一次作业：勾股定理应用",
        description="完成三道勾股定理应用题，拍照上传作答",
        detail="提交后由 AI 辅助批改，教师可复核",
        course_id=course.id,
        teacher_id=teacher.id,
        total_points=100,
        due_date=datetime.now() + timedelta(days=7),
        created_at=datetime.now(),
        peer_review_enabled=False,
    )
    session.add(assignment)
    await session.flush()

    session.add(
        Submission(
            assignment_id=assignment.id,
            student_id=users["student01"].id,
            content="第一题：斜边 5；第二题：12；第三题：见手写稿",
            status="SUBMITTED",
            submitted_at=datetime.now(),
        )
    )
    await session.flush()
    return course


async def _seed_identities(session, course: Course) -> int:
    count = 0
    for scene, seat, student_no, display in SEATS:
        existing = (
            await session.execute(
                select(VisionIdentity).where(
                    VisionIdentity.scene == scene,
                    VisionIdentity.seat_ref == seat,
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            continue
        session.add(
            VisionIdentity(
                created_at=datetime.now(),
                scene=scene,
                seat_ref=seat,
                student_no=student_no,
                display_name=display,
                course_id=course.id,
                enabled=True,
            )
        )
        count += 1
    await session.flush()
    return count


async def _seed_alert_rules(session) -> int:
    count = 0
    for row in ALERT_RULES:
        existing = (
            await session.execute(
                select(AlertRule).where(AlertRule.name == row["name"])
            )
        ).scalar_one_or_none()
        if existing is not None:
            continue
        session.add(
            AlertRule(created_at=datetime.now(), updated_at=datetime.now(), **row)
        )
        count += 1
    await session.flush()
    return count


async def _seed_model_assets(session) -> int:
    count = 0
    for row in MODEL_ASSETS:
        existing = (
            await session.execute(
                select(ModelAsset).where(ModelAsset.asset_code == row["asset_code"])
            )
        ).scalar_one_or_none()
        if existing is not None:
            # 幂等回填：展示名以本文件为准。旧库里可能还留着「（占位）/（真实）」这类
            # 实现视角的措辞，会被直接渲染给用户，所以这里一并纠正。
            if existing.name != row["name"]:
                existing.name = row["name"]
                existing.updated_at = datetime.now()
            continue
        session.add(ModelAsset(created_at=datetime.now(), updated_at=datetime.now(), **row))
        count += 1
    await session.flush()
    return count


async def _seed_demo_task(session, course: Course) -> str:
    """跑一个真实的占位任务，让看板一开始就有数据。"""
    from app.schemas.vision import VisionTaskCreateRequest
    from app.services.vision_service import VisionService

    service = VisionService(session)
    task = await service.run_task(
        VisionTaskCreateRequest(
            scene="classroom",
            source_ref="data/samples/demo.jpg",
            source_type="image",
        ),
        operator="seed",
    )
    return task.task_code


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-demo-task", action="store_true")
    args = parser.parse_args()

    print(f"数据库后端 : {settings.db_backend}")
    print(f"连接串     : {settings.database_url}")
    await ensure_runtime_schema()

    async with async_session_factory() as session:
        users = await _seed_users(session)
        print(f"账号       : {len(users)} 个（密码统一为 {DEMO_PASSWORD}）")
        course = await _seed_course(session, users)
        print(f"课程/作业  : {course.name}（含选课与一条演示提交）")
        print(f"身份映射   : 新增 {await _seed_identities(session, course)} 条")
        print(f"告警规则   : 新增 {await _seed_alert_rules(session)} 条")
        print(f"模型资产   : 新增 {await _seed_model_assets(session)} 条")
        if not args.skip_demo_task:
            code = await _seed_demo_task(session, course)
            print(f"演示任务   : {code}")
        await session.commit()

    print("\n下一步：")
    if settings.db_backend == "sqlite":
        print("  DB_BACKEND=sqlite python -m uvicorn app.main:app --port 8001")
    else:
        print("  python -m uvicorn app.main:app --port 8001")
    print("  然后访问 http://localhost:18010/ 用 teacher01 登录")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
