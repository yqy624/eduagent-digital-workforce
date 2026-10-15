"""/api/knowledge/* —— 知识智能命名空间。

文档索引、RAG 问答、Agent 对话、运行轨迹在实现上都已存在，只是挂在 /api/ai 下。
本文件按菜单契约把它们暴露到 /api/knowledge，内部复用同一批函数，
保证两条路径行为一致（不是复制一份实现）。

对 /api/ai 的 import 放在函数内部：AI 能力（rag / llm 依赖）未安装时，
本模块仍可被 import，只是相关端点返回明确错误，不会拖垮整个应用启动。
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.database import get_db
from app.middleware.auth import get_current_user, require_teacher
from app.models.models import User
from app.schemas.ai import AgentChatRequest, QARequest
from app.schemas.common import ApiResponse
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/api/knowledge", tags=["知识智能"])


def _ai():
    """延迟加载 AI 路由模块，避免 AI 依赖缺失时影响应用启动。"""
    try:
        import app.routers.ai as ai_module

        return ai_module
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=501, detail=f"AI 能力未启用：{exc}"
        ) from exc


@router.post("/courses/{course_id}/documents/index")
async def knowledge_index(
    course_id: int,
    user: User = Depends(require_teacher),
    db: AsyncSession = Depends(get_db),
):
    """重建课程知识索引（等价 /api/ai/courses/{id}/documents/index）。"""
    return await _ai().index_course_documents(course_id, user=user, db=db)


@router.post("/courses/{course_id}/qa")
async def knowledge_qa(
    course_id: int,
    req: QARequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """基于课程知识库的检索增强问答。"""
    return await _ai().course_qa(course_id, req, user=user, db=db)


@router.post("/agent/chat")
async def knowledge_agent(
    req: AgentChatRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Agent 对话：规划 → 工具调用 → 综合。"""
    return await _ai().agent_runtime_chat(req, user=user, db=db)


@router.get("/runs/{run_id}")
async def knowledge_run(
    run_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Agent 运行记录。"""
    return await _ai().get_run_detail(run_id, user=user, db=db)


@router.get("/runs/{run_id}/tool-calls")
async def knowledge_run_tool_calls(
    run_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Agent 工具调用轨迹。"""
    return await _ai().get_run_tool_calls(run_id, user=user, db=db)


@router.get("/tools")
async def knowledge_tools(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """当前登录角色可调用的 Agent 工具清单（只读）。

    供前端「数字员工」展示真实工具能力，替代早期前端自拟的「技能包」标签——
    后者在后端并不存在，容易让人误以为工具是按员工分配的（实际是按登录角色）。
    """
    return await _ai().list_agent_tools(user=user, db=db)


class RegulationMatchRequest(BaseModel):
    """视觉违规事件 → 规范条文的匹配请求。"""

    course_id: int = Field(..., description="在哪个课程的知识库里检索规范")
    event_type: Optional[str] = Field(default=None, max_length=64)
    event_label: Optional[str] = Field(default=None, max_length=128)
    query: Optional[str] = Field(default=None, max_length=200)
    top_k: int = Field(default=5, ge=1, le=20)


@router.post("/regulations/match")
async def regulations_match(
    req: RegulationMatchRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """规范知识关联：把视觉事件类型检索到对应的规范条文。

    这是"感知 + 解释"闭环的最后一环。实现上复用课程知识库的检索能力，
    把事件标签当作查询词 —— 所以它是否返回内容，取决于该课程是否已索引
    含规范条文的文档（用 /api/knowledge/courses/{id}/documents/index 建立）。
    """
    ai_module = _ai()
    query = req.query or " ".join(
        part for part in (req.event_label, req.event_type) if part
    ) or "安全规范 违规 处置"
    citations = await ai_module._search_course_chunks(
        db, req.course_id, query, user=user, max_citations=req.top_k
    )
    return ApiResponse.ok(
        data={
            "query": query,
            "course_id": req.course_id,
            "matched": len(citations),
            "citations": citations,
        }
    )
