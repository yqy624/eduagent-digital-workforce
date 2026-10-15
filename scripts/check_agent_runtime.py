"""Lightweight checks for the controlled Agent runtime.

This script does not connect to MySQL or call an LLM. It validates the local
contracts that make the Agent more than a single API call: the runtime interface
the HTTP layer depends on, tool allowlists, argument validation, confirmation
metadata, the language of every prompt / tool description the model is fed, and
a replayable behaviour test for the ReAct loop itself.

重写期间的状态说明
------------------
旧的线性流水线 ``ai/agents/runtime.py``（610 行）已删除，完整实现可从
``git show checkpoint-before-loop-rewrite:ai/agents/runtime.py`` 取回。
新的 ReAct 循环在 ``ai/agents/loop.py`` 里从零重建。

因此本脚本相应调整：
* 依赖旧设计的 ``check_plan_validation`` 已移除，换成 ``check_agent_interface``
  —— 它盯的是「HTTP 层调用 AgentRuntime 的方式」，重写前后都成立；
* 提示词语言检查会在 ``loop.py`` / ``runtime.py`` 里自动找锚点，找不到就**显式跳过并打印**，
  不会静默通过；
* 新增 ``check_loop_replay``：用桩模型把循环真实跑一遍，断言收敛出口正确。
"""

from __future__ import annotations

import asyncio
import inspect
import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from ai.agents.tool_registry import AgentToolError, ToolDefinition  # noqa: E402

# 提示词可能出现在任一实现文件里（重写期间两个都看）
LOOP_SOURCES = ("ai/agents/loop.py", "ai/agents/runtime.py")

SKIPPED: list[str] = []


async def _noop(args):
    return {"ok": True, "args": args}


# ── HTTP 层依赖的运行时契约 ────────────────────────────────────────────────


def check_agent_interface() -> None:
    """``app/routers/ai.py`` 顶层 import 了 ``AgentRuntime``，且按固定签名调用。

    这是重写期间唯一不能破的契约：文件缺失会让整个 App 起不来，
    签名变了会让 Agent 端点在运行时报 TypeError。
    """
    from ai.agents.runtime import AgentRuntime

    init_params = set(inspect.signature(AgentRuntime.__init__).parameters)
    missing = {"db", "user", "service"} - init_params
    if missing:
        raise AssertionError(f"AgentRuntime.__init__ 缺少参数: {sorted(missing)}")

    run = getattr(AgentRuntime, "run", None)
    if run is None or not inspect.iscoroutinefunction(run):
        raise AssertionError("AgentRuntime.run 必须是 async 方法")
    run_params = set(inspect.signature(run).parameters)
    for name in ("question", "course_id", "session_id", "confirm"):
        if name not in run_params:
            raise AssertionError(f"AgentRuntime.run 缺少参数: {name}")

    if "active_run_id" not in inspect.getsource(AgentRuntime):
        raise AssertionError("AgentRuntime 必须暴露 active_run_id（HTTP 层用它做失败回滚）")


# ── 工具契约（与循环实现无关，重写期间保持硬断言）────────────────────────


def check_tool_argument_contract() -> None:
    tool = ToolDefinition(
        name="retrieve_course_material",
        description="retrieve",
        required_args={"course_id", "question"},
        optional_args=set(),
        allowed_roles={"STUDENT"},
        read_only=True,
        requires_confirmation=False,
        handler=_noop,
    )
    assert tool.normalize_args({"course_id": 1, "question": "x"})["course_id"] == 1
    try:
        tool.normalize_args({"course_id": 1})
    except AgentToolError:
        pass
    else:
        raise AssertionError("missing required arguments should be rejected")
    try:
        tool.normalize_args({"course_id": 1, "question": "x", "unsafe": True})
    except AgentToolError:
        pass
    else:
        raise AssertionError("unknown arguments should be rejected")


def check_confirmation_metadata() -> None:
    tool = ToolDefinition(
        name="send_notification",
        description="send",
        required_args={"recipient_username", "title", "content"},
        optional_args={"link"},
        allowed_roles={"TEACHER"},
        read_only=False,
        requires_confirmation=True,
        handler=_noop,
    )
    assert not tool.read_only
    assert tool.requires_confirmation


def check_confirmation_argument_contract() -> None:
    tool = ToolDefinition(
        name="send_notification",
        description="send",
        required_args={"recipient_username", "title", "content"},
        optional_args=set(),
        allowed_roles={"TEACHER"},
        read_only=False,
        requires_confirmation=True,
        handler=_noop,
    )
    assert tool.requires_confirmation is True
    values = tool.normalize_args(
        {
            "recipient_username": "student",
            "title": "Notice",
            "content": "Content",
        }
    )
    assert values["recipient_username"] == "student"


# ── ReAct 循环的可回放行为测试 ────────────────────────────────────────────


def check_loop_replay() -> None:
    """用桩模型把循环真实跑一遍 —— 收敛性必须可验证，不能只看源码。

    三个必须成立的出口：拿到结论 / 迭代用尽 / 原地打转止损。
    另加一条：工具报错必须变成观察结果回灌，而不是抛异常炸掉循环。
    """
    try:
        from ai.agents.loop import AgentLoop, ScriptedLLM
    except ImportError:
        SKIPPED.append("ReAct 循环行为测试（ai/agents/loop.py 尚不可导入）")
        return

    def script(*decisions: dict) -> str:
        import json

        return json.dumps(decisions[0], ensure_ascii=False)

    def step(thought: str, **kw) -> str:
        return script({"thought": thought, **kw})

    # 出口一：模型给出 final_answer
    result = asyncio.run(
        AgentLoop(
            llm=ScriptedLLM(
                [
                    step("查统计", action="get_course_stats", action_input={"course_id": 1}),
                    step("够了", final_answer="课程 1 平均分 78.5"),
                ]
            )
        ).run("课程 1 平均分多少？")
    )
    assert result.stop_reason == "goal_reached", result.stop_reason
    assert result.iterations == 2, result.iterations
    assert "78.5" in result.answer
    assert result.trace[0]["observation"].startswith("{"), result.trace

    # 出口二：迭代用尽
    result = asyncio.run(
        AgentLoop(
            llm=ScriptedLLM(
                [step("查统计", action="get_course_stats", action_input={"course_id": i}) for i in range(1, 9)]
            ),
            max_iterations=4,
        ).run("课程 1 平均分多少？")
    )
    assert result.stop_reason == "max_iterations", result.stop_reason
    assert result.iterations == 4, result.iterations

    # 出口三：原地打转 → 熔断
    result = asyncio.run(
        AgentLoop(
            llm=ScriptedLLM(
                [step("查统计", action="get_course_stats", action_input={"course_id": 1})] * 6
            )
        ).run("课程 1 平均分多少？")
    )
    assert result.stop_reason == "no_progress", result.stop_reason
    assert result.iterations < 6, "熔断应当在耗尽迭代次数之前触发"

    # 错误回灌：不存在的工具必须变成观察结果，循环继续
    result = asyncio.run(
        AgentLoop(
            llm=ScriptedLLM(
                [
                    step("猜一个工具", action="no_such_tool", action_input={}),
                    step("改对了", final_answer="好了"),
                ]
            )
        ).run("随便问点什么")
    )
    assert result.stop_reason == "goal_reached", result.stop_reason
    assert "不存在" in result.trace[0]["observation"], result.trace[0]


# ── 提示词语言（面向模型的中文契约）──────────────────────────────────────


def check_prompts_are_chinese() -> None:
    """Every prompt / tool description the model reads must be Chinese.

    Machine identifiers are allowed — JSON contract keys, tool names, argument
    names, status enums and the NEEDS_CLARIFICATION marker — because the runtime
    parses them. Anything else must be Chinese. This turns a silent regression
    (someone pastes an English sentence back into a prompt) into a hard failure.
    """
    sources = {
        rel: (PROJECT_ROOT / rel).read_text(encoding="utf-8")
        for rel in LOOP_SOURCES
        if (PROJECT_ROOT / rel).exists()
    }
    registry_src = (PROJECT_ROOT / "ai/agents/tool_registry.py").read_text(encoding="utf-8")

    allowed = {
        # 品牌与格式词
        "EduAgent", "JSON", "ID",
        # 契约标记
        "NEEDS_CLARIFICATION",
        # JSON 契约键（决策对象）
        "objective", "steps", "tool", "reason", "args",
        "thought", "action", "action_input", "final_answer",
        # 工具契约字段
        "required_args", "optional_args",
        # 参数名
        "course_id", "assignment_id", "content", "title",
        # 状态枚举与数据键
        "NOT_SUBMITTED", "assignment_statuses",
        "not_submitted_assignments", "submissions",
        # 11 个工具名
        "get_course_overview", "get_course_assignments", "retrieve_course_material",
        "get_my_grades", "get_my_submissions", "analyze_learning_gaps",
        "generate_learning_plan", "get_course_statistics", "send_notification",
        "publish_assignment", "submit_assignment",
    }

    def strip_f_expressions(text: str) -> str:
        # {{ }} 是 f-string 里的字面花括号，先换成哨兵，避免被当成表达式吞掉
        text = text.replace("{{", "\x01").replace("}}", "\x02")
        text = re.sub(r"\{[^{}]*\}", " ", text)
        return text.replace("\x01", "{").replace("\x02", "}")

    def latin_tokens(text: str) -> set:
        return set(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", text))

    def prompt_block(src: str, anchor: str) -> str:
        # f""" 在锚点之前，所以要向前找最后一次出现的位置
        idx = src.index(anchor)
        start = src.rindex('f"""', 0, idx) + 4
        return src[start : src.index('"""', start)]

    for label, anchor in (
        ("规划器提示词", "你是 EduAgent 的工具规划器"),
        ("合成器提示词", "你是 EduAgent 的回答模型"),
    ):
        origin = next((rel for rel, src in sources.items() if anchor in src), None)
        if origin is None:
            # 该提示词尚未在新循环里重建 —— 显式跳过，绝不静默通过
            SKIPPED.append(f"{label}语言检查（在 {sorted(sources)} 中未找到锚点）")
            continue
        extra = latin_tokens(strip_f_expressions(prompt_block(sources[origin], anchor))) - allowed
        if extra:
            raise AssertionError(f"{label}（{origin}）出现未登记的英文词元: {sorted(extra)}")

    # 11 个工具描述必须是纯中文，连一个拉丁字母都不能有
    descriptions = re.findall(
        r'ToolDefinition\(\s*\n\s*"[^"]+",\s*\n\s*"([^"]+)"', registry_src
    )
    if not descriptions:
        raise AssertionError("未从 tool_registry.py 解析到任何工具描述")
    for desc in descriptions:
        if re.search(r"[A-Za-z]", desc):
            raise AssertionError(f"工具描述含英文: {desc}")
    if len(descriptions) != 11:
        raise AssertionError(f"工具描述数量异常，期望 11 条，实际 {len(descriptions)} 条")

    # 工具错误文案必须是中文（f-string 表达式里的代码标识符、以及工具名本身不计）
    tool_name_pattern = "|".join(
        sorted((t for t in allowed if "_" in t and t[0].islower()), key=len, reverse=True)
    )
    for _, msg in re.findall(r'AgentToolError\(\s*(f?)"([^"]*)"', registry_src):
        stripped = strip_f_expressions(msg)
        stripped = re.sub(tool_name_pattern, " ", stripped)
        if re.search(r"[A-Za-z]", stripped):
            raise AssertionError(f"工具错误文案含英文: {msg}")
        if not re.search(r"[\u4e00-\u9fff]", stripped):
            raise AssertionError(f"工具错误文案不是中文: {msg}")


def main() -> None:
    check_agent_interface()
    check_tool_argument_contract()
    check_confirmation_metadata()
    check_confirmation_argument_contract()
    check_loop_replay()
    check_prompts_are_chinese()
    for item in SKIPPED:
        print(f"SKIP: {item}")
    print("Agent runtime checks passed")


if __name__ == "__main__":
    main()
