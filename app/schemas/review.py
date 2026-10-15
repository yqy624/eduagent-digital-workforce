"""智能评阅域 Schema。

拍照批改是 YOLO 接进原平台的主场景：它复用作业的提交与评分闭环，
而不是另起一套流程。这里只定义"扫描与复核"相关的契约。
"""
from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, Field


class ReviewModel(BaseModel):
    """评阅域契约基类。

    `model_name` 这类字段会撞上 pydantic 的 `model_` 保护命名空间，
    这里显式关掉该限制，避免启动时刷警告。
    """

    model_config = {"protected_namespaces": ()}


class ScanBlock(ReviewModel):
    """一个被定位到的题块。"""

    index: int
    cls_name: str
    conf: float
    bbox: List[float] = Field(default_factory=list)


class ScanRequest(BaseModel):
    """发起一次拍照批改扫描。"""

    assignment_id: int
    submission_id: Optional[int] = None
    file_id: Optional[int] = None
    source_ref: str = Field(..., min_length=1, max_length=512)
    conf: float = Field(default=0.25, ge=0.0, le=1.0)
    backend: Optional[str] = None


class ScanResult(ReviewModel):
    """扫描结果。

    注意：**这里不产出分数**。系统没有标准答案，凭识别结果直接给分是编数据。
    产出的只是"题块是否定位成功、哪些块置信度不足、需要人工复核哪些"，
    最终分数仍由教师在评分环节确认。
    """

    task_code: str
    status: str
    is_placeholder: bool = True
    model_name: Optional[str] = None
    latency_ms: Optional[float] = None

    assignment_id: Optional[int] = None
    submission_id: Optional[int] = None
    file_id: Optional[int] = None

    block_count: int = 0
    low_confidence_count: int = 0
    blocks: List[ScanBlock] = Field(default_factory=list)
    hint: str = ""
    need_review: bool = False
    error_kind: Optional[str] = None
    error_message: Optional[str] = None


class ScanTaskItem(ReviewModel):
    """扫描任务列表项，供教师工作台列出"待批改"。"""

    task_code: str
    status: str
    scene: str
    source_ref: str
    assignment_id: Optional[int] = None
    submission_id: Optional[int] = None
    is_placeholder: Optional[bool] = True
    model_name: Optional[str] = None
    latency_ms: Optional[float] = None
    created_at: Optional[datetime] = None
    summary: Optional[dict] = None


class ReviewOverview(ReviewModel):
    """评阅总览。

    所有字段都来自真实查询，没有数据时是 0 而不是编出来的示范值。
    """

    course_count: int = 0
    assignment_count: int = 0
    submission_count: int = 0
    graded_count: int = 0
    pending_count: int = 0
    scan_task_count: int = 0
    scan_pending_count: int = 0
    average_score: Optional[float] = None
    vision_backend: Optional[str] = None
    vision_is_placeholder: bool = True


class GradingQuality(ReviewModel):
    """批改质量复核。

    用"机器扫描结论"与"教师最终给分"之间的偏差来做复核，
    只统计真实存在的记录，样本不足时给出 `sample_enough=False` 而不是硬算比率。
    """

    scope_course_id: Optional[int] = None
    submission_count: int = 0
    graded_count: int = 0
    scan_count: int = 0
    scan_placeholder_count: int = 0
    need_review_count: int = 0
    low_confidence_count: int = 0
    average_score: Optional[float] = None
    sample_enough: bool = False
    note: str = ""
