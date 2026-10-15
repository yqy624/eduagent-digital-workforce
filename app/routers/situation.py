"""/api/situation/* —— 态势感知与告警命名空间。

主要输入是**视觉事件流**而不是人际消息，所以叫"态势"而不是"消息中心"。
本文件把已有的 VisionService / NotificationService 按菜单契约的命名空间
暴露出来；权限沿用各自服务的既有约定，不额外收紧。
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.middleware.auth import decode_access_token, get_current_user
from app.models.models import Notification, User
from app.schemas.common import ApiResponse
from app.schemas.vision import AlertRuleIn, AlertRuleOut, VisionEventOut
from app.services.alert_rule_service import AlertRuleService
from app.services.notification_hub import notification_hub
from app.services.notification_service import NotificationService
from app.services.vision_service import VisionService

router = APIRouter(prefix="/api/situation", tags=["态势感知与告警"])
ws_router = APIRouter(tags=["态势感知与告警"])


@router.get("/overview")
async def overview(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """态势总览：视觉事件规模 + 未读通知 + 待处置计数。"""
    vision = await VisionService(db).overview()
    unread = (
        await db.execute(
            select(func.count(Notification.id)).where(
                Notification.recipient == user.username,
                Notification.is_read.is_(False),
            )
        )
    ).scalar() or 0
    return ApiResponse.ok(
        data={
            "task_total": vision.task_total,
            "event_total": vision.event_total,
            "event_by_severity": vision.event_by_severity,
            "unacknowledged": vision.unacknowledged,
            "unread_notifications": unread,
        }
    )


@router.get("/notifications")
async def notifications(
    limit: int = Query(default=50, ge=1, le=100),
    unread_only: bool = Query(default=False),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """通知中心：收敛 notifications 表（与 /api/notifications 同源）。"""
    filters = [Notification.recipient == user.username]
    if unread_only:
        filters.append(Notification.is_read.is_(False))
    rows = list(
        (
            await db.execute(
                select(Notification)
                .where(*filters)
                .order_by(Notification.created_at.desc(), Notification.id.desc())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    return ApiResponse.ok(data=[NotificationService.to_payload(r) for r in rows])


@router.get("/alerts")
async def alerts(
    limit: int = Query(default=100, ge=1, le=500),
    acknowledged: Optional[bool] = Query(default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """告警处置队列：warning / critical 的视觉事件，严重在前。

    与 insight/alerts 一致要求登录：告警含学生行为标签，不应匿名可读。
    """
    service = VisionService(db)
    rows = []
    for severity in ("critical", "warning"):
        rows.extend(
            await service.list_events(
                severity=severity, acknowledged=acknowledged, limit=limit
            )
        )
    return ApiResponse.ok(data=[VisionEventOut.model_validate(e) for e in rows[:limit]])


@router.get("/rules")
async def rules(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """告警规则配置：场景 + 等级阈值 + 通知对象 + 去重窗口。

    规则引擎已落地 —— 视觉事件落库后会按这里的规则匹配、去重并派发通知。
    """
    rows = await AlertRuleService(db).list_rules()
    return ApiResponse.ok(
        data={
            "implemented": True,
            "rules": [AlertRuleOut.model_validate(r).model_dump() for r in rows],
            "note": (
                "出现需要关注的情况时，平台会按这里的设置自动提醒相关负责人；"
                "同一条提醒在设定时间内只发一次，不会反复打扰。"
            ),
        }
    )


@router.post("/rules")
async def create_rule(
    req: AlertRuleIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """新增告警规则（仅管理员）。"""
    if user.role != "ADMIN":
        raise HTTPException(status_code=403, detail="仅管理员可配置告警规则")
    rule = await AlertRuleService(db).create_rule(req)
    return ApiResponse.ok(
        data=AlertRuleOut.model_validate(rule).model_dump(), message="规则已创建"
    )


class RuleToggle(BaseModel):
    enabled: bool


@router.put("/rules/{rule_id}/enabled")
async def toggle_rule(
    rule_id: int,
    req: RuleToggle,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """启用 / 停用一条规则（仅管理员）。"""
    if user.role != "ADMIN":
        raise HTTPException(status_code=403, detail="仅管理员可配置告警规则")
    rule = await AlertRuleService(db).set_enabled(rule_id, req.enabled)
    if rule is None:
        raise HTTPException(status_code=404, detail="规则不存在")
    return ApiResponse.ok(
        data=AlertRuleOut.model_validate(rule).model_dump(),
        message="已启用" if req.enabled else "已停用",
    )


@ws_router.websocket("/api/situation/alerts/stream")
async def alerts_stream(websocket: WebSocket):
    """实时告警流：与 /ws/notifications 同源的别名通道。

    按模块命名空间接线，前端切到本路径后行为与通知流完全一致。
    """
    token: Optional[str] = websocket.query_params.get("token")
    if not token:
        await websocket.close(code=1008, reason="缺少认证令牌")
        return
    try:
        username = decode_access_token(token).get("sub")
    except Exception:
        await websocket.close(code=1008, reason="认证令牌无效")
        return
    if not username:
        await websocket.close(code=1008, reason="认证令牌无效")
        return

    await notification_hub.connect(username, websocket)
    await websocket.send_json({"type": "CONNECTED"})
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        notification_hub.disconnect(username, websocket)
    except Exception:
        notification_hub.disconnect(username, websocket)
