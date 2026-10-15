"""Agent 运行时 —— 旧的线性流水线已删除，正在从零重写。

⚠ 本文件当前是**降级桩**，不是实现。

旧实现是「一次规划 → 顺序执行 → 一次总结」的单轮流水线（610 行），
已从工作区删除，完整代码仍可从 git 取回：

    git show checkpoint-before-loop-rewrite:ai/agents/runtime.py

新的 ReAct 循环（想一想 → 做一步 → 看结果 → 再想一想）在 ``ai/agents/loop.py``
里从零重建。在它接管之前，本桩负责两件事：

1. ``app/routers/ai.py`` 第 40 行是**顶层 import**，文件缺失会让整个 App 起不来，
   所以这里必须留一个同名类；
2. Agent 端点优雅降级 —— 返回一句中文说明，而不是抛 500。

接口保持与旧实现一致（``AgentRuntime(db, user, service, retrieve_materials=...)``、
``await runtime.run(question, course_id, session_id, confirm)``、``active_run_id``），
等新循环成熟后直接替换本文件即可，调用方零改动。
"""

from __future__ import annotations

from typing import Any, Callable, Dict, Optional

_REWRITING_NOTICE = (
    "Agent 循环正在从零重写，暂时无法处理这个请求。"
    "新的循环实现在 ai/agents/loop.py。"
)


class AgentRuntime:
    """占位实现：接口不变，内部等待新循环接管。"""

    def __init__(
        self,
        db,
        user,
        service,
        retrieve_materials: Optional[Callable] = None,
    ):
        self.db = db
        self.user = user
        self.service = service
        self.retrieve_materials = retrieve_materials
        # 旧实现用它做失败回滚；桩阶段恒为 None，因此不会触发 fail_run
        self.active_run_id: Optional[int] = None

    async def run(
        self,
        question: str,
        course_id: Optional[int] = None,
        session_id: Optional[str] = None,
        confirm: bool = False,
    ) -> Dict[str, Any]:
        return {
            "answer": _REWRITING_NOTICE,
            "status": "UNAVAILABLE",
            "plan": {"objective": "rewriting", "steps": []},
            "executed_steps": [],
            "requires_confirmation": [],
            "memory": {"session_id": session_id, "used_count": 0},
            "run_id": None,
            "citations": [],
            "confidence": 0.0,
            "confirmation_required": False,
        }
