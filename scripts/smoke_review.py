"""端到端冒烟：拍照批改接进原作业流程。

覆盖：
1. 学生提交带图片附件的作业
2. 提交后自动登记"待批改"视觉任务（pending，绑定 submission/assignment/file）
3. 教师触发扫描（复用登记的那条任务，不新增记录）
4. 扫描结果解析出题块与复核建议
5. 复核后写回成绩（走原平台既有的评分服务）

用法：
    DB_BACKEND=sqlite python scripts/smoke_review.py
"""
from __future__ import annotations

import asyncio
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("DB_BACKEND", "sqlite")

from sqlalchemy import desc, select  # noqa: E402

from app.database import async_session_factory, ensure_runtime_schema  # noqa: E402
from app.models.models import (  # noqa: E402
    Assignment,
    Enrollment,
    StoredFile,
    Submission,
    User,
)
from app.models.vision_models import VisionTask  # noqa: E402
from app.schemas.assignment import GradeRequest  # noqa: E402
from app.schemas.review import ScanRequest  # noqa: E402
from app.services.assignment_service import AssignmentService  # noqa: E402
from app.services.vision_service import VisionService  # noqa: E402

_failed: list[str] = []


def check(name: str, ok: bool, extra: str = "") -> None:
    print(f"  [{'OK  ' if ok else 'FAIL'}] {name}{(' -> ' + extra) if extra else ''}")
    if not ok:
        _failed.append(name)


async def main() -> int:
    await ensure_runtime_schema()

    async with async_session_factory() as db:
        # ---- 准备：学生 / 教师 / 一个该学生尚未提交的作业 ----
        student = (
            await db.execute(select(User).where(User.username == "student01"))
        ).scalar_one_or_none()
        teacher = (
            await db.execute(select(User).where(User.username == "teacher01"))
        ).scalar_one_or_none()
        if student is None or teacher is None:
            print("  缺少种子账号，先跑：DB_BACKEND=sqlite python scripts/seed_demo.py")
            return 1

        submitted_ids = {
            s.assignment_id
            for s in (
                await db.execute(
                    select(Submission).where(Submission.student_id == student.id)
                )
            ).scalars()
        }
        assignment = (
            await db.execute(
                select(Assignment).where(Assignment.id.notin_(submitted_ids or {0}))
            )
        ).scalars().first()

        if assignment is None:
            assignment = Assignment(
                title="冒烟用作业（拍照批改）",
                description="由 smoke_review.py 创建",
                total_points=100,
                course_id=1,
                teacher_id=teacher.id,
                due_date=datetime.now() + timedelta(days=7),
                peer_review_enabled=False,
                created_at=datetime.now(),
            )
            db.add(assignment)
            await db.flush()
            print(f"  新建作业 id={assignment.id}（种子里没有未提交的作业）")

        # 确保选课，否则提交会被"未选修此课程"拦下
        enrollment = (
            await db.execute(
                select(Enrollment).where(
                    Enrollment.course_id == assignment.course_id,
                    Enrollment.student_id == student.id,
                )
            )
        ).scalar_one_or_none()
        if enrollment is None:
            db.add(
                Enrollment(
                    course_id=assignment.course_id,
                    student_id=student.id,
                    created_at=datetime.now(),
                )
            )
            await db.flush()

        # ---- 1. 学生上传一张作业照片并提交 ----
        print("\n== 1. 提交带图片附件的作业 ==")
        stamp = datetime.now().strftime("%H%M%S%f")
        photo = StoredFile(
            bucket="local",
            category="TEMP_UPLOAD",
            content_type="image/jpeg",
            course_id=assignment.course_id,
            created_at=datetime.now(),
            extension=".jpg",
            object_key=f"smoke/{stamp}.jpg",
            original_name="homework.jpg",
            size=123456,
            storage_path=f"uploads/smoke/{stamp}.jpg",
            uploader_user_id=student.id,
        )
        db.add(photo)
        await db.flush()

        service = AssignmentService(db)
        submission = await service.submit(
            assignment_id=assignment.id,
            student=student,
            content="手写作答，见照片",
            file_ids=[photo.id],
        )
        await db.commit()
        check("提交成功", submission.id is not None, f"submission_id={submission.id}")

        # ---- 2. 提交后自动登记待批改任务 ----
        print("\n== 2. 自动登记待批改任务 ==")
        pending = (
            await db.execute(
                select(VisionTask)
                .where(VisionTask.submission_id == submission.id)
                .order_by(desc(VisionTask.id))
            )
        ).scalars().first()
        check("已登记视觉任务", pending is not None)
        if pending is None:
            print("  提交未触发登记，中止后续检查")
            return 1
        check("状态为 pending（不阻塞提交）", pending.status == "pending")
        check("绑定作业", pending.assignment_id == assignment.id)
        check("绑定提交", pending.submission_id == submission.id)
        check("绑定文件", pending.file_id == photo.id, f"file_id={pending.file_id}")
        check("场景为拍照批改", pending.scene == "paper_grading")

        before = (
            await db.execute(select(VisionTask).where(VisionTask.scene == "paper_grading"))
        ).scalars().all()
        count_before = len(before)

        # ---- 3. 教师触发扫描（复用登记任务）----
        print("\n== 3. 教师触发扫描 ==")
        vision = VisionService(db)
        result = await vision.scan_submission(
            ScanRequest(
                assignment_id=assignment.id,
                submission_id=submission.id,
                file_id=photo.id,
                source_ref=photo.storage_path,
            ),
            operator=teacher.username,
            task_code=pending.task_code,
        )
        await db.commit()
        check("扫描成功", result.status == "succeeded", f"task={result.task_code}")
        check("复用同一条任务记录", result.task_code == pending.task_code)

        after = (
            await db.execute(select(VisionTask).where(VisionTask.scene == "paper_grading"))
        ).scalars().all()
        check("未产生重复任务", len(after) == count_before, f"{count_before} -> {len(after)}")

        # ---- 4. 结果解析 ----
        print("\n== 4. 题块与复核建议 ==")
        check("解析出题块", result.block_count > 0, f"{result.block_count} 个")
        check("给出复核结论", bool(result.hint), result.hint)
        check("占位结果强制人工复核", result.need_review is True)
        for b in result.blocks[:3]:
            print(f"        #{b.index} {b.cls_name} conf={b.conf:.3f} bbox={b.bbox}")

        # ---- 5. 复核后写回成绩（走原评分服务）----
        print("\n== 5. 写回成绩 ==")
        graded = await service.grade(
            submission.id, GradeRequest(score=88.0, comment="拍照批改复核通过"), teacher
        )
        await db.commit()
        check("成绩已写入", graded.score == 88.0, f"score={graded.score}")
        check("状态为已评分", graded.status == "GRADED", graded.status)

    print("\n" + (f"→ SMOKE FAIL: {_failed}" if _failed else "→ SMOKE PASS"))
    return 1 if _failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
