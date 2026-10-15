"""ReAct 循环 —— 从零实现的教学参考（离线可运行，不需要任何模型）。

⚠ 这是**教具**，不是产品实现。读它、跑它、然后自己重写一遍。

为什么要有它：旧的 ``runtime.py``（610 行）是「一次规划 → 顺序执行 → 一次总结」
的单轮流水线 —— 工具执行的结果**从不回流**给模型。ReAct 循环要补的就是这条回路：

    想一想 → 做一步 → 看结果 → 再想一想 → …… → 说结论

怎么跑（不碰数据库、不连大模型）：

    .venv/Scripts/python.exe -m ai.agents.loop

接你真实的 API 时，只改一处：把 ``AgentLoop(llm=...)`` 里的 ``ScriptedLLM``
换成 ``ApiLLM``（本文件末尾给了骨架），循环主体一行都不用动。
"""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Optional, Protocol

# ═══════════════════════════════════════════════════════════════════════════
# 零件 ① 工具：循环能调用的"手脚"
#     循环不认识业务，它只认识「名字 + 参数」——所以工具必须自带说明书。
#     真实项目里这一层已经写好了：ai/agents/tool_registry.py（710 行 / 11 个工具），
#     你的循环只要按 name 去注册表里查表调用，不需要重写。
# ═══════════════════════════════════════════════════════════════════════════


@dataclass
class Tool:
    name: str
    description: str
    params: Dict[str, str]
    handler: Callable[..., Awaitable[Any]]


async def _get_course_stats(course_id: int) -> Dict[str, Any]:
    return {"course_id": course_id, "student_count": 42, "avg_score": 78.5}


async def _list_pending_assignments(course_id: int) -> List[Dict[str, Any]]:
    return [
        {"assignment_id": 101, "title": "递归练习", "due": "2026-10-20"},
        {"assignment_id": 102, "title": "动态规划练习", "due": "2026-10-25"},
    ]


TOOLS: Dict[str, Tool] = {
    t.name: t
    for t in (
        Tool("get_course_stats", "查询某门课程的统计信息", {"course_id": "int"}, _get_course_stats),
        Tool(
            "list_pending_assignments",
            "列出某门课程未完成的作业",
            {"course_id": "int"},
            _list_pending_assignments,
        ),
    )
}


# ═══════════════════════════════════════════════════════════════════════════
# 零件 ② 模型接口：整个循环与 LLM 的唯一接触面
#     它就是「给我一段对话历史，还我一段文本」。协议越窄，越好替换。
# ═══════════════════════════════════════════════════════════════════════════


class LLM(Protocol):
    async def __call__(self, messages: List[Dict[str, str]]) -> str: ...


class ScriptedLLM:
    """离线演示用：按预设剧本逐条返回，替模型说话。"""

    def __init__(self, script: List[str]):
        self._script = list(script)
        self.calls = 0

    async def __call__(self, messages: List[Dict[str, str]]) -> str:
        self.calls += 1
        if self._script:
            return self._script.pop(0)
        return json.dumps({"thought": "剧本已尽", "final_answer": "（演示结束）"}, ensure_ascii=False)


class ApiLLM:
    """接你的真实 API 时替换 ScriptedLLM。决策只在这一处。

    项目里已有现成通道 ``ai/llm.py::get_llm()``（按 OLLAMA→OPENAI→DASHSCOPE→ANTHROPIC
    顺序取配置），你可以直接把它的 ``ainvoke`` 包一层：

        from ai.llm import get_llm
        class ApiLLM:
            def __init__(self): self._model = get_llm()
            async def __call__(self, messages):
                resp = await self._model.ainvoke(messages)
                return resp.content
    """

    async def __call__(self, messages: List[Dict[str, str]]) -> str:  # pragma: no cover
        raise NotImplementedError("把这里换成你的 API 调用")


# ═══════════════════════════════════════════════════════════════════════════
# 零件 ③ 决策契约：模型每一轮必须吐出的结构化对象
#     不约定格式，就无法把"想的"翻译成"做的"。
# ═══════════════════════════════════════════════════════════════════════════


@dataclass
class Step:
    thought: str = ""
    action: Optional[str] = None
    action_input: Dict[str, Any] = field(default_factory=dict)
    final_answer: Optional[str] = None


def parse_step(raw: str) -> Step:
    """从模型输出里抠出 JSON。模型总爱加解释，所以先用正则找最外层花括号。"""
    match = re.search(r"\{.*\}", raw, re.S)
    if not match:
        return Step(thought=raw.strip(), final_answer=f"（模型未返回结构化决策：{raw.strip()[:80]}）")
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return Step(thought=raw.strip(), final_answer=f"（模型返回的 JSON 无法解析：{raw.strip()[:80]}）")
    return Step(
        thought=str(data.get("thought", "")),
        action=data.get("action") or None,
        action_input=data.get("action_input") or {},
        final_answer=data.get("final_answer"),
    )


# ═══════════════════════════════════════════════════════════════════════════
# 零件 ④ 循环本体：状态 + 决策 + 行动 + 回灌 + 收敛
# ═══════════════════════════════════════════════════════════════════════════


@dataclass
class LoopResult:
    answer: str
    iterations: int
    stop_reason: str  # goal_reached | max_iterations | no_progress
    trace: List[Dict[str, Any]] = field(default_factory=list)


class AgentLoop:
    def __init__(
        self,
        llm: LLM,
        tools: Optional[Dict[str, Tool]] = None,
        max_iterations: int = 6,
    ):
        self.llm = llm
        self.tools = tools if tools is not None else TOOLS
        self.max_iterations = max_iterations  # ★ 收敛保险丝：循环必须有硬上限

    # ---- 每轮喂给模型的"说明书"，工具变了它自动跟着变 ----
    def _system_prompt(self) -> str:
        tool_help = "\n".join(
            f"- {t.name}：{t.description}，参数 {list(t.params)}" for t in self.tools.values()
        )
        return f"""你是 EduAgent 的工具规划器。每一轮只输出一个 JSON 对象，不要输出别的文字。

想调用工具时输出：
{{"thought": "你的思考", "action": "工具名", "action_input": {{"参数": 值}}}}

已经可以回答时输出：
{{"thought": "你的思考", "final_answer": "给用户的最终回答"}}

可用工具：
{tool_help}
"""

    async def _act(self, step: Step) -> str:
        """执行工具。关键设计：**失败也要变成观察结果**，交给模型自己纠错，
        而不是抛异常把循环炸掉。"""
        tool = self.tools.get(step.action or "")
        if tool is None:
            return f"错误：不存在名为 {step.action} 的工具。可用工具：{list(self.tools)}"
        try:
            result = await tool.handler(**step.action_input)
        except TypeError as exc:  # 参数对不上
            return f"错误：工具 {step.action} 的参数不正确（{exc}）"
        except Exception as exc:  # 工具内部出错
            return f"错误：工具 {step.action} 执行失败（{exc}）"
        return json.dumps(result, ensure_ascii=False)

    async def run(self, goal: str) -> LoopResult:
        # ── 零件 ④-1 状态：整个循环唯一的记忆载体，就是一个消息列表 ──
        messages: List[Dict[str, str]] = [
            {"role": "system", "content": self._system_prompt()},
            {"role": "user", "content": goal},
        ]
        trace: List[Dict[str, Any]] = []
        last_signature: Optional[str] = None
        repeats = 0

        for iteration in range(1, self.max_iterations + 1):
            # ── 零件 ④-2 决策：把历史喂给模型，要一个结构化决定 ──
            raw = await self.llm(messages)
            step = parse_step(raw)
            record: Dict[str, Any] = {
                "iteration": iteration,
                "thought": step.thought,
                "action": step.action,
                "action_input": step.action_input,
            }
            trace.append(record)

            # ── 零件 ④-5 收敛出口一：模型认为可以回答了 ──
            if step.final_answer is not None:
                return LoopResult(step.final_answer, iteration, "goal_reached", trace)

            # ── 零件 ④-3 行动 ──
            observation = await self._act(step)
            record["observation"] = observation

            # ── 零件 ④-4 回灌：这是"循环"与"流水线"的全部区别 ──
            # 模型有 role 限制（只认 system/user/assistant），所以把模型自己的输出
            # 记为 assistant，把工具结果包装成 user 消息贴回去。
            messages.append({"role": "assistant", "content": raw})
            messages.append({"role": "user", "content": f"观察结果：{observation}"})

            # ── 零件 ④-5 收敛出口二：原地打转就止损 ──
            signature = json.dumps([step.action, step.action_input], sort_keys=True, ensure_ascii=False)
            repeats = repeats + 1 if signature == last_signature else 0
            last_signature = signature
            if repeats >= 2:
                return LoopResult(
                    "模型连续重复同一个动作，已停止以免空转。",
                    iteration,
                    "no_progress",
                    trace,
                )

        # ── 零件 ④-5 收敛出口三：迭代次数用尽 ──
        return LoopResult(
            f"达到最大迭代次数（{self.max_iterations}）仍未得到结论。",
            self.max_iterations,
            "max_iterations",
            trace,
        )


# ═══════════════════════════════════════════════════════════════════════════
# 演示：同一段循环，三种剧本分别触发三种收敛出口
# ═══════════════════════════════════════════════════════════════════════════


def _render(result: LoopResult) -> None:
    print(f"\n  ── 循环轨迹（共 {result.iterations} 轮，停止原因：{result.stop_reason}）")
    for item in result.trace:
        print(f"    [{item['iteration']}] 想：{item['thought']}")
        if item["action"]:
            print(f"         做：{item['action']}({item['action_input']})")
        if "observation" in item:
            print(f"         看：{item['observation'][:110]}")
    print(f"  → 结论：{result.answer}")


async def _demo() -> None:
    print("═" * 74)
    print("剧本 A：两个工具串起来（查统计 → 查作业 → 回答）")
    print("═" * 74)
    loop = AgentLoop(
        llm=ScriptedLLM(
            [
                json.dumps({"thought": "先看这门课的规模", "action": "get_course_stats",
                            "action_input": {"course_id": 1}}, ensure_ascii=False),
                json.dumps({"thought": "再看学生还有什么没交", "action": "list_pending_assignments",
                            "action_input": {"course_id": 1}}, ensure_ascii=False),
                json.dumps({"thought": "信息够了", "final_answer":
                            "课程 1 共 42 名学生，平均分 78.5；作业 101《递归练习》"
                            "与作业 102《动态规划练习》尚无提交记录。"}, ensure_ascii=False),
            ]
        )
    )
    _render(await loop.run("帮我看看课程 1 的情况，学生还有什么没交？"))

    print("\n" + "═" * 74)
    print("剧本 B：模型调了不存在的工具 → 错误回灌 → 模型自己改用正确的工具")
    print("═" * 74)
    loop = AgentLoop(
        llm=ScriptedLLM(
            [
                json.dumps({"thought": "先查作业", "action": "get_assignments",
                            "action_input": {"course_id": 1}}, ensure_ascii=False),
                json.dumps({"thought": "名字错了，改正确的工具名", "action": "list_pending_assignments",
                            "action_input": {"course_id": 1}}, ensure_ascii=False),
                json.dumps({"thought": "可以回答了", "final_answer":
                            "课程 1 有两份作业未提交：《递归练习》（10-20 截止）与"
                            "《动态规划练习》（10-25 截止）。"}, ensure_ascii=False),
            ]
        )
    )
    _render(await loop.run("课程 1 有哪些作业没交？"))

    print("\n" + "═" * 74)
    print("剧本 C：模型陷入死循环（同一个动作反复做）→ 熔断止损")
    print("═" * 74)
    loop = AgentLoop(
        llm=ScriptedLLM(
            [
                json.dumps({"thought": "查统计", "action": "get_course_stats",
                            "action_input": {"course_id": 1}}, ensure_ascii=False),
            ]
            * 6  # 只会做同一件事
        )
    )
    _render(await loop.run("课程 1 平均分多少？"))


if __name__ == "__main__":
    asyncio.run(_demo())
