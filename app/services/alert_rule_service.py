"""告警规则引擎：把视觉事件翻译成"该通知谁"。

为什么需要它
------------
视觉事件落库只是**数据**，不是**业务动作**。在规则引擎之前，一条
`no_gloves / critical` 只会静静躺在 `vision_events` 里等某个页面去读；
规则引擎之后，它会在同一事务里被匹配、去重，并派发成责任人可见的通知。

这样"视觉是源、业务是消费方"才闭环：**消费方的动作是通知，而不是展示**。

三条自我约束（与事件派生层一致的态度）
--------------------------------------
1. **只消费已有事实**：不猜测、不补全事件内容，只做匹配与路由。
2. **不打扰**：同一标题在去重窗口内只发一次，避免持续违规刷屏。
3. **可解释**：通知正文带上等级、置信度、任务号与命中的规则名，人能回溯。
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import Notification, User
from app.models.vision_models import AlertRule
from app.schemas.vision import AlertRuleIn
from app.services.notification_service import NotificationService

# 等级序：info 不触发告警，仅作展示
SEVERITY_ORDER: Dict[str, int] = {"info": 0, "warning": 1, "critical": 2}
SEVERITY_LABELS: Dict[str, str] = {"info": "提示", "warning": "关注", "critical": "严重"}
SCENE_LABELS: Dict[str, str] = {
    "classroom": "课堂行为识别",
    "lab_safety": "实验室安全识别",
    "exam_proctor": "考场行为监测",
    "paper_grading": "拍照批改",
}


def severity_rank(value: Optional[str]) -> int:
    return SEVERITY_ORDER.get((value or "info").strip().lower(), 0)


class AlertRuleService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    # ------------------------------------------------------------------
    # 规则维护
    # ------------------------------------------------------------------

    async def list_rules(self, enabled_only: bool = False) -> List[AlertRule]:
        stmt = select(AlertRule)
        if enabled_only:
            stmt = stmt.where(AlertRule.enabled.is_(True))
        stmt = stmt.order_by(AlertRule.id.asc())
        return list((await self.db.execute(stmt)).scalars().all())

    async def create_rule(self, payload: AlertRuleIn) -> AlertRule:
        now = datetime.now()
        rule = AlertRule(
            name=payload.name,
            scene=payload.scene or None,
            severity=payload.severity,
            notify_student=payload.notify_student,
            notify_roles=payload.notify_roles or None,
            dedup_minutes=payload.dedup_minutes,
            enabled=payload.enabled,
            created_at=now,
            updated_at=now,
        )
        self.db.add(rule)
        await self.db.flush()
        return rule

    async def set_enabled(self, rule_id: int, enabled: bool) -> Optional[AlertRule]:
        rule = (
            await self.db.execute(select(AlertRule).where(AlertRule.id == rule_id))
        ).scalar_one_or_none()
        if rule is None:
            return None
        rule.enabled = enabled
        rule.updated_at = datetime.now()
        await self.db.flush()
        return rule

    # ------------------------------------------------------------------
    # 事件消费
    # ------------------------------------------------------------------

    async def evaluate(self, event_rows: Sequence[Dict[str, Any]]) -> List[Notification]:
        """对一批刚落库的事件做规则匹配并派发通知。

        入参是 `VisionService._persist_events` 组装好的行字典，因此本方法
        **不依赖 ORM 对象**，可以直接在落库后原地调用。
        """
        if not event_rows:
            return []

        rules = await self.list_rules(enabled_only=True)
        if not rules:
            return []

        now = datetime.now()
        notifier = NotificationService(self.db)
        created: List[Notification] = []

        for row in event_rows:
            rank = severity_rank(row.get("severity"))
            if rank <= 0:
                continue  # info 不告警
            for rule in rules:
                if rank < severity_rank(rule.severity):
                    continue
                if rule.scene and rule.scene != row.get("scene"):
                    continue

                title, content, link, recipients = await self._build_dispatch(rule, row)
                fresh = await self._exclude_deduped(
                    recipients, title, rule.dedup_minutes, now
                )
                if not fresh:
                    continue
                created.extend(
                    await notifier.create_for_usernames(
                        fresh,
                        title,
                        content,
                        category="ALERT",
                        type_="ALERT",
                        link=link,
                    )
                )
        return created

    async def _build_dispatch(
        self, rule: AlertRule, row: Dict[str, Any]
    ) -> tuple[str, str, Optional[str], List[str]]:
        """组装一条通知：标题 / 正文 / 跳转 / 收件人。"""
        scene = str(row.get("scene") or "")
        label = row.get("event_label") or row.get("event_type") or "视觉事件"
        subject = row.get("subject_ref")
        severity = str(row.get("severity") or "info")

        recipients: set[str] = set()

        # 1) 归属到具体学生：subject_ref 落库时已是业务学号，按学号找回登录名
        if rule.notify_student and subject:
            rows = await self.db.execute(
                select(User.username).where(
                    User.student_no == subject, User.enabled.is_(True)
                )
            )
            recipients.update(rows.scalars().all())

        # 2) 按角色通知责任人（教师 / 管理员）
        roles = [
            item.strip().upper()
            for item in str(rule.notify_roles or "").split(",")
            if item.strip()
        ]
        if roles:
            rows = await self.db.execute(
                select(User.username).where(
                    User.role.in_(roles), User.enabled.is_(True)
                )
            )
            recipients.update(rows.scalars().all())

        # 标题直接进通知列表，是收件人第一眼看到的东西：不带任何内部前缀，
        # 场景名走人话映射表；万一出现表外场景，退化成中性词而不是裸枚举。
        title = f"{SCENE_LABELS.get(scene, '识别提醒')}：{label}"
        if subject:
            title += f"（{subject}）"

        # 通知正文是**发给老师和学生看的**：不出现等级枚举、置信度小数、任务编号、
        # 也不出现规则名这类配置侧词汇。收件人需要知道的是「发生了什么、去哪里看」。
        content = (
            f"平台识别到需要{SEVERITY_LABELS.get(severity, severity)}的情况，"
            f"请在「课堂与考场监测 · 记录回看与纠正」里查看详情并确认。"
        )
        task_code = row.get("task_code")
        link = "/platform#/vision/vision-records" if task_code else None
        return title, content, link, sorted(recipients)

    async def _exclude_deduped(
        self,
        recipients: Sequence[str],
        title: str,
        dedup_minutes: int,
        now: datetime,
    ) -> List[str]:
        """窗口内已有同标题通知的收件人不再打扰。"""
        if not recipients:
            return []
        window = max(int(dedup_minutes or 0), 0)
        if window <= 0:
            return list(recipients)
        cutoff = now - timedelta(minutes=window)
        rows = await self.db.execute(
            select(Notification.recipient).where(
                Notification.recipient.in_(list(recipients)),
                Notification.title == title,
                Notification.created_at >= cutoff,
            )
        )
        already = set(rows.scalars().all())
        return [name for name in recipients if name not in already]
