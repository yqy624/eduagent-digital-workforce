"""视觉域请求/响应 Schema。

所有入参都做显式校验（范围、枚举、长度），不让非法值流到服务层。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.models.contracts import VisionScene

VALID_SCENES = [s.value for s in VisionScene]


class VisionTaskCreateRequest(BaseModel):
    """创建一次视觉分析任务。"""

    scene: str = Field(..., description=f"场景，取值：{VALID_SCENES}")
    source_ref: str = Field(..., min_length=1, max_length=512)
    source_type: str = Field(default="image", pattern="^(image|video|stream)$")
    conf: float = Field(default=0.25, ge=0.0, le=1.0)
    iou: float = Field(default=0.45, ge=0.0, le=1.0)
    imgsz: int = Field(default=640, ge=160, le=1920)
    with_identity: bool = True
    course_id: Optional[int] = None
    # 业务绑定：让视觉任务能挂回原平台的作业 / 提交 / 文件
    assignment_id: Optional[int] = None
    submission_id: Optional[int] = None
    file_id: Optional[int] = None
    backend: Optional[str] = Field(
        default=None, description="指定模型实现，不填则用配置里的默认实现"
    )

    @field_validator("scene")
    @classmethod
    def _check_scene(cls, value: str) -> str:
        if value not in VALID_SCENES:
            raise ValueError(f"scene 必须是 {VALID_SCENES} 之一，收到 {value!r}")
        return value


class VisionTaskOut(BaseModel):
    model_config = ConfigDict(from_attributes=True, protected_namespaces=())

    id: int
    task_code: str
    scene: str
    source_ref: str
    source_type: Optional[str] = None
    status: str
    progress: Optional[int] = 0

    provider: Optional[str] = None
    model_name: Optional[str] = None
    is_placeholder: Optional[bool] = True
    latency_ms: Optional[float] = None
    error_kind: Optional[str] = None
    error_message: Optional[str] = None

    summary: Optional[Dict[str, Any]] = None
    result: Optional[Dict[str, Any]] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    # 业务绑定（拍照批改会用到）
    course_id: Optional[int] = None
    assignment_id: Optional[int] = None
    submission_id: Optional[int] = None
    file_id: Optional[int] = None

    @field_validator("summary", "result", mode="before")
    @classmethod
    def _load_json(cls, value: Any) -> Any:
        """数据库里存的是 JSON 字符串，出参统一还原成对象。"""
        if isinstance(value, str):
            import json

            try:
                return json.loads(value)
            except json.JSONDecodeError:
                return None
        return value


class VisionEventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    task_code: Optional[str] = None
    scene: str
    event_type: str
    event_label: Optional[str] = None
    severity: str
    confidence: Optional[float] = None
    duration_s: Optional[float] = None
    subject_ref: Optional[str] = None
    seat_ref: Optional[str] = None
    frame_id: Optional[int] = None
    acknowledged: bool = False
    evidence: Optional[Dict[str, Any]] = None
    created_at: Optional[datetime] = None

    @field_validator("evidence", mode="before")
    @classmethod
    def _load_json(cls, value: Any) -> Any:
        if isinstance(value, str):
            import json

            try:
                return json.loads(value)
            except json.JSONDecodeError:
                return None
        return value


class VisionIdentityIn(BaseModel):
    scene: str
    seat_ref: str = Field(..., min_length=1, max_length=32)
    student_no: str = Field(..., min_length=1, max_length=64)
    display_name: Optional[str] = Field(default=None, max_length=50)
    track_id: Optional[int] = None
    course_id: Optional[int] = None


class VisionIdentityOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    scene: str
    seat_ref: str
    track_id: Optional[int] = None
    student_no: str
    display_name: Optional[str] = None
    course_id: Optional[int] = None
    enabled: bool = True


class AlertRuleIn(BaseModel):
    """告警规则入参。"""

    name: str = Field(..., min_length=1, max_length=128)
    scene: Optional[str] = Field(default=None, max_length=32, description="留空表示不限场景")
    severity: str = Field(default="warning", pattern="^(info|warning|critical)$")
    notify_student: bool = Field(default=True, description="是否通知事件归属的学生本人")
    notify_roles: Optional[str] = Field(
        default="TEACHER,ADMIN", max_length=128, description="逗号分隔的角色列表"
    )
    dedup_minutes: int = Field(default=10, ge=0, le=1440)
    enabled: bool = True

    @field_validator("scene")
    @classmethod
    def _check_scene(cls, value: Optional[str]) -> Optional[str]:
        if value in (None, "", "any", "ALL"):
            return None
        if value not in VALID_SCENES:
            raise ValueError(f"scene 取值必须是 {VALID_SCENES} 之一，或留空表示不限")
        return value


class AlertRuleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    scene: Optional[str] = None
    severity: str
    notify_student: bool = True
    notify_roles: Optional[str] = None
    dedup_minutes: int = 10
    enabled: bool = True
    created_at: Optional[datetime] = None


class ModelAssetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True, protected_namespaces=())

    id: int
    asset_code: str
    name: str
    capability: str
    framework: Optional[str] = None
    version: Optional[str] = None
    weights_path: Optional[str] = None
    source: Optional[str] = None
    license: Optional[str] = None
    is_placeholder: bool = True
    enabled: bool = True
    notes: Optional[str] = None


class SceneOption(BaseModel):
    value: str
    label: str
    description: str = ""


class VisionOverview(BaseModel):
    """视觉模块概览。态势看板直接消费这个结构。"""

    task_total: int = 0
    task_by_status: Dict[str, int] = Field(default_factory=dict)
    event_total: int = 0
    event_by_severity: Dict[str, int] = Field(default_factory=dict)
    unacknowledged: int = 0
    placeholders_in_use: List[str] = Field(default_factory=list)
    scenes: List[SceneOption] = Field(default_factory=list)
