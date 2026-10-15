"""Lightweight checks for the controlled Agent runtime.

This script does not connect to MySQL or call an LLM. It validates the local
contracts that make the Agent more than a single API call: structured plans,
tool allowlists, argument validation, confirmation metadata, and the language
of every prompt / tool description the model is fed.
"""

from __future__ import annotations

import asyncio
import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from ai.agents.runtime import AgentPlan, AgentPlanStep
from ai.agents.tool_registry import AgentToolError, ToolDefinition


async def _noop(args):
    return {"ok": True, "args": args}


def check_plan_validation() -> None:
    plan = AgentPlan(
        objective="answer a course question",
        steps=[
            AgentPlanStep(
                tool="retrieve_course_material",
                args={"course_id": 1, "question": "Explain recursion"},
            )
        ],
    )
    assert plan.steps[0].tool == "retrieve_course_material"


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


def check_prompts_are_chinese() -> None:
    """Every prompt / tool description the model reads must be Chinese.

    Machine identifiers are allowed — JSON contract keys, tool names, argument
    names, status enums and the NEEDS_CLARIFICATION marker — because the runtime
    parses them. Anything else must be Chinese. This turns a silent regression
    (someone pastes an English sentence back into a prompt) into a hard failure.
    """
    runtime_src = (PROJECT_ROOT / "ai/agents/runtime.py").read_text(encoding="utf-8")
    registry_src = (PROJECT_ROOT / "ai/agents/tool_registry.py").read_text(
        encoding="utf-8"
    )

    allowed = {
        # 品牌与格式词
        "EduAgent", "JSON", "ID",
        # 契约标记
        "NEEDS_CLARIFICATION",
        # JSON 契约键
        "objective", "steps", "tool", "reason", "args",
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

    def prompt_block(anchor: str) -> str:
        # f""" 在锚点之前，所以要向前找最后一次出现的位置
        idx = runtime_src.index(anchor)
        start = runtime_src.rindex('f"""', 0, idx) + 4
        return runtime_src[start:runtime_src.index('"""', start)]

    for label, anchor in (
        ("规划器提示词", "你是 EduAgent 的工具规划器"),
        ("合成器提示词", "你是 EduAgent 的回答模型"),
    ):
        extra = latin_tokens(strip_f_expressions(prompt_block(anchor))) - allowed
        if extra:
            raise AssertionError(f"{label} 出现未登记的英文词元: {sorted(extra)}")

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
    check_plan_validation()
    check_tool_argument_contract()
    check_confirmation_metadata()
    check_confirmation_argument_contract()
    check_prompts_are_chinese()
    print("Agent runtime checks passed")


if __name__ == "__main__":
    main()
