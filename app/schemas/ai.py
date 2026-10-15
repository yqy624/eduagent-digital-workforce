"""AI 相关 Schema"""
from datetime import datetime
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class QARequest(BaseModel):
    """RAG 问答请求"""
    question: str = Field(..., min_length=1, max_length=2000)


class Citation(BaseModel):
    """引用来源。

    字段分两层：
    - ``document_id`` 是 **edu 侧**的文件 id（本地检索与前端跳转都用它，保持兼容）；
    - ``rag_doc_id`` 是 **知识库侧**的文档 ID，仅外置检索时有值，用于溯源。
    两者含义不同，不要互相赋值。
    """
    document_id: Optional[int] = None
    rag_doc_id: Optional[str] = None
    chunk_index: Optional[int] = 0
    content: str
    score: float
    similarity: Optional[float] = None
    source: str
    file_name: Optional[str] = None
    source_type: Optional[str] = None
    # 知识库提供的页码定位；无法定位时 locator_status 为 unknown
    page_start: Optional[int] = None
    page_end: Optional[int] = None
    locator_status: Optional[str] = None
    # 该引用关联的图片（知识库按文档归组返回），供图文回答与插图消费
    images: List[Dict[str, Any]] = []


class QAResponse(BaseModel):
    answer: str
    citations: List[Citation] = []
    confidence: float
    needs_clarification: bool = False
    run_id: Optional[int] = None


class AgentChatRequest(BaseModel):
    """Agent 对话请求"""
    question: str = Field(..., min_length=1, max_length=2000)
    course_id: Optional[int] = None
    mode: Optional[str] = Field(default=None, max_length=50)
    session_id: Optional[str] = Field(default=None, max_length=100)
    confirm: bool = False


class AgentChatResponse(BaseModel):
    """Agent 对话响应"""
    answer: str
    mode: str = "smart_education"
    citations: List[Citation] = []
    confidence: float = 0.0
    run_id: Optional[int] = None
    memory_count: int = 0
    status: str = "COMPLETED"
    plan: Dict[str, Any] = {}
    executed_steps: List[Dict[str, Any]] = []
    requires_confirmation: List[Dict[str, Any]] = []
    memory: Dict[str, Any] = {}
    confirmation_required: bool = False


class DiagnosisResponse(BaseModel):
    """学情诊断结果"""
    student_id: int
    course_id: int
    weakness: List[Dict[str, Any]] = []
    evidence: List[Dict[str, Any]] = []
    trend: Optional[str] = None


class LearningPlanResponse(BaseModel):
    """学习计划"""
    student_id: int
    course_id: int
    weakness_summary: str
    daily_tasks: List[Dict[str, Any]] = []
    materials: List[str] = []
    exercises: List[Dict[str, Any]] = []
    total_hours: float = 0
    plan_id: Optional[int] = None
    run_id: Optional[int] = None
    basis: List[Dict[str, Any]] = []


class GradingSuggestionResponse(BaseModel):
    """AI 批改建议"""
    id: Optional[int] = None
    run_id: Optional[int] = None
    submission_id: int
    suggested_score: float
    rubric: Dict[str, Any] = {}
    critique: Dict[str, Any] = {}
    critique_source: Optional[str] = None
    comment: str
    strengths: List[str] = []
    weaknesses: List[str] = []
    risks: List[str] = []
    analysis: Dict[str, Any] = {}


class FeedbackUpdateRequest(BaseModel):
    score: Optional[float] = Field(None, ge=0)
    comment: Optional[str] = None
    rubric: Optional[Dict[str, Any]] = None
    action: Optional[str] = Field(None, pattern="^(MODIFIED|REJECTED)$")


class AgentRunResponse(BaseModel):
    """Agent 运行记录"""
    id: int
    user_id: int
    role: str
    workflow: str
    status: str
    latency_ms: int
    token_usage: Optional[int] = None
    error: Optional[str] = None
    created_at: Optional[str] = None
    tool_calls: List[Dict[str, Any]] = []
