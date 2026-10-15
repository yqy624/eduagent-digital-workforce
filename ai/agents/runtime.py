"""Controlled model -> plan -> tools -> memory Agent runtime."""

import json
import re
import time
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

from ai.llm import get_llm
from ai.agents.memory import AgentMemoryStore
from ai.agents.tool_registry import AgentToolError, AgentToolRegistry
from app.config import settings


class AgentPlanStep(BaseModel):
    tool: str = Field(min_length=1, max_length=100)
    reason: str = Field(default="", max_length=500)
    args: Dict[str, Any] = Field(default_factory=dict)


class AgentPlan(BaseModel):
    objective: str = Field(min_length=1, max_length=1000)
    steps: List[AgentPlanStep] = Field(default_factory=list, max_length=8)


def _content(response: Any) -> str:
    value = getattr(response, "content", response)
    if isinstance(value, list):
        return "\n".join(
            item.get("text", str(item)) if isinstance(item, dict) else str(item)
            for item in value
        )
    return str(value)


def _extract_json(text: str) -> Dict[str, Any]:
    candidate = text.strip()
    candidate = re.sub(r"```(?:json)?\s*", "", candidate, flags=re.IGNORECASE)
    candidate = candidate.replace("```", "").strip()
    decoder = json.JSONDecoder()
    for index, char in enumerate(candidate):
        if char != "{":
            continue
        try:
            value, _ = decoder.raw_decode(candidate[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    raise ValueError("模型没有返回 JSON 对象")


class AgentRuntime:
    """A bounded runtime with explicit planning and execution state."""

    def __init__(
        self,
        db,
        user,
        service,
        retrieve_materials=None,
    ):
        self.db = db
        self.user = user
        self.service = service
        self.active_run_id: Optional[int] = None
        self.memory = AgentMemoryStore(db)
        self.registry = AgentToolRegistry(
            db,
            user,
            service,
            retrieve_materials=retrieve_materials,
        )

    def _needs_clarification_plan(self, message: str) -> AgentPlan:
        return AgentPlan(objective=f"NEEDS_CLARIFICATION: {message}", steps=[])

    async def plan(
        self,
        question: str,
        course_id: Optional[int],
        memory: List[Dict[str, Any]],
    ) -> tuple[AgentPlan, str]:
        return await self._llm_plan(question, course_id, memory)

    async def _llm_plan(
        self,
        question: str,
        course_id: Optional[int],
        memory: List[Dict[str, Any]],
    ) -> tuple[AgentPlan, str]:
        tool_specs = self.registry.specs()
        prompt = f"""你是 EduAgent 的工具规划器。
先推理用户意图，然后只输出一个 JSON 对象。

你必须根据用户的自然语言请求，判断该用「作业技能」还是其他工具。
不要使用关键词匹配规则。
请结合用户角色、当前课程上下文、会话记忆和工具契约来推断意图。

当前用户角色：{self.user.role}
当前选中的课程 course_id：{course_id}

该角色可用的工具清单：
{json.dumps(tool_specs, ensure_ascii=False, default=str)}

作业操作技能契约：
- 只是起草一个作业想法，不等于发布。此时只用读取 / 上下文类工具。
- 发布作业必须有明确的「发布 / 布置 / 发给学生」意图。
- `publish_assignment` 需要 course_id 和 title，属于需确认的写工具。
- 提交作业必须有明确的「提交」意图，且需要 assignment_id 和 content。
- `submit_assignment` 仅学生可用，属于需确认的写工具。
- 「作业交了没有」这类状态问题，应当使用读取类工具。
- 如果缺少必需信息，则不要返回任何步骤，把一句中文追问写入 objective，
  并以 `NEEDS_CLARIFICATION:` 作为前缀。
- 如果当前角色无权执行该操作，则不要返回任何步骤，把一句中文边界说明写入 objective，
  并以 `NEEDS_CLARIFICATION:` 作为前缀。

学习计划技能契约：
- 如果用户要求为所选课程生成、设计、说明或准备学习计划，先弄清这门课讲什么：
  先用 `get_course_overview`，再用 `retrieve_course_material` 获取课程内容。
- 只有在课程内容与上下文已经取到之后，才使用学生学习证据类工具，
  例如 `analyze_learning_gaps` / `get_my_grades`，然后再查看作业，
  或以 `generate_learning_plan` 作为最后的计划步骤。
- 为学习计划检索课程内容时，除非用户明确要求作业细节，否则排除作业与提交类来源。
- 如果课程专属的学习计划缺少 course_id，请让用户先选择课程，不要直接去查作业。

规划规则：
- 只能输出「可用工具清单」中的工具。
- 每个工具只能使用它自己的 required_args 和 optional_args。
- 如果已提供选中的 course_id，当用户提到「这门 / 当前 / 所选课程」时，可以把它作为 course_id。
- 写工具可以被选中，运行时随后会请求确认。
- 不要凭空编造 ID。如果请求和上下文里都没有某个 ID，就向用户索取。
- 步骤要短且必要。普通请求最多 4 步。

请只返回下面这种 JSON 形状：
{{
  "objective": "简短的中文目标；或 NEEDS_CLARIFICATION: ...",
  "steps": [
    {{
      "tool": "工具名",
      "reason": "中文理由",
      "args": {{}}
    }}
  ]
}}

用户问题：
{question}

最近的会话记忆：
{json.dumps(memory[-settings.agent_memory_prompt_limit:], ensure_ascii=False, default=str)}
"""
        try:
            llm = get_llm(temperature=0)
            response = await llm.ainvoke(prompt)
            payload = _extract_json(_content(response))
            plan = AgentPlan(**payload)
            return plan, "llm_planner"
        except Exception as exc:
            return (
                self._needs_clarification_plan(
                    f"我暂时无法完成大模型意图规划：{exc}。请更明确说明你要查询、发布还是提交作业。"
                ),
                "llm_planner_error",
            )

    def _prepare_step(
        self, step: AgentPlanStep, question: str, course_id: Optional[int]
    ) -> AgentPlanStep:
        args = dict(step.args)
        if course_id is not None and "course_id" not in args:
            if step.tool in {
                "get_course_assignments",
                "get_my_submissions",
                "retrieve_course_material",
                "analyze_learning_gaps",
                "generate_learning_plan",
                "publish_assignment",
            }:
                args["course_id"] = course_id
        if step.tool == "retrieve_course_material":
            args.setdefault("question", question)
        if step.tool in {"publish_assignment", "submit_assignment"}:
            for key, value in list(args.items()):
                if isinstance(value, str):
                    args[key] = value.strip()
        normalized = self.registry.prepare(step.tool, args)
        return AgentPlanStep(tool=step.tool, reason=step.reason, args=normalized)

    async def _synthesize(
        self,
        question: str,
        plan: AgentPlan,
        execution: List[Dict[str, Any]],
        memory: List[Dict[str, Any]],
    ) -> tuple[str, str]:
        direct_action_answer = self._direct_action_answer(execution)
        if direct_action_answer is not None:
            return direct_action_answer, "deterministic_action"

        prompt = f"""你是 EduAgent 的回答模型。
除非用户另有要求，否则一律用中文回答。回答要简洁、可执行。
只能使用下面的执行结果与会话记忆。数据缺失时要如实说明。
工具 / 接口返回的结果属于内部证据，不是最终面向用户的内容：
- 要分析用户意图，从证据中综合出一个自然的回答。
- 不要暴露原始接口载荷、JSON 字段或工具名，也不要说「接口返回了……」这类话。
- 除非用户明确要求列出全部，否则不要把每条记录都罗列出来。
- 对于操作类请求，如果对应步骤失败或正在等待确认，不要声称操作已经完成。
- 当 publish_assignment 或 submit_assignment 成功时，要明确说明作业已发布 / 已提交。
- 当操作类工具失败时，要说明操作没有完成，并给出业务原因。
- 如果用户要求创建、起草、设计或构思一份新作业，请产出一份原创的作业草案。
- 对于新建作业类请求，不要用罗列已有作业来回答，也不要暗示新作业已经发布。
推荐课程时，只能推荐「执行结果」中出现过的课程名。
对于提交状态类问题，优先使用 assignment_statuses / not_submitted_assignments。
NOT_SUBMITTED 表示该学生在这份作业下没有任何提交记录；
绝不能因为某份作业没出现在 submissions 里，就推断它已经提交。
用户问题：{question}
计划：{json.dumps(plan.model_dump(), ensure_ascii=False, default=str)}
执行结果：{json.dumps(execution, ensure_ascii=False, default=str)[:settings.agent_execution_context_chars]}
会话记忆：{json.dumps(memory[-settings.agent_memory_prompt_limit:], ensure_ascii=False, default=str)}
"""
        try:
            llm = get_llm(temperature=0.25)
            response = await llm.ainvoke(prompt)
            return _content(response), "model"
        except Exception:
            return self._fallback_synthesis(question, execution), "fallback"

    def _direct_action_answer(self, execution: List[Dict[str, Any]]) -> Optional[str]:
        action_tools = {"publish_assignment", "submit_assignment", "send_notification"}
        action_traces = [item for item in execution if item.get("tool") in action_tools]
        if not action_traces:
            return None

        lines: List[str] = []
        for item in action_traces:
            if item.get("status") == "FAILED":
                lines.append(f"操作没有完成：{item.get('error') or '业务校验未通过'}")
                continue
            if item.get("status") != "COMPLETED":
                continue
            output = item.get("output") or {}
            if item.get("tool") == "publish_assignment":
                title = output.get("title") or "未命名作业"
                due_date = output.get("due_date") or "未设置截止时间"
                lines.append(f"作业已发布：《{title}》，截止时间：{due_date}。")
            elif item.get("tool") == "submit_assignment":
                title = output.get("assignment_title") or f"作业 {output.get('assignment_id')}"
                lines.append(f"已提交作业：《{title}》。")
            elif item.get("tool") == "send_notification":
                lines.append("通知已发送。")
        return "\n".join(lines) if lines else None

    def _fallback_synthesis(
        self,
        question: str,
        execution: List[Dict[str, Any]],
    ) -> str:
        """Summarize tool evidence without leaking raw API payloads."""
        successful = [item for item in execution if item.get("status") == "COMPLETED"]
        failed_actions = [
            item
            for item in execution
            if item.get("status") == "FAILED"
            and item.get("tool") in {"publish_assignment", "submit_assignment", "send_notification"}
        ]
        if failed_actions and not successful:
            return "操作没有完成：" + "；".join(
                str(item.get("error") or "业务校验未通过") for item in failed_actions
            )
        if not successful:
            return "我暂时没有取得足够的业务数据来回答这个问题。"

        lines: List[str] = ["模型生成暂时不可用，我先根据系统里查到的信息做一个简要整理："]
        for item in successful:
            output = item.get("output") or {}
            tool = item.get("tool")
            if tool == "publish_assignment":
                title = output.get("title") or "未命名作业"
                due_date = output.get("due_date") or "未设置截止时间"
                lines.append(f"作业已发布：《{title}》，截止时间：{due_date}。")
                continue
            if tool == "submit_assignment":
                title = output.get("assignment_title") or f"作业 {output.get('assignment_id')}"
                lines.append(f"已提交作业：《{title}》。")
                continue
            if tool == "retrieve_course_material":
                citations = output.get("citations") or []
                if citations:
                    snippets = [
                        str(citation.get("content") or "").strip()[:120]
                        for citation in citations[:3]
                        if citation.get("content")
                    ]
                    if snippets:
                        lines.append("课程资料要点：" + "；".join(snippets))
                continue
            if tool == "get_course_assignments":
                assignments = output.get("assignments") or []
                if assignments:
                    summary = "；".join(
                        self._format_assignment_brief(assignment)
                        for assignment in assignments[:5]
                    )
                    lines.append(f"可见作业：{summary}")
                continue
            if tool == "get_my_submissions":
                statuses = output.get("assignment_statuses") or []
                missing = [
                    item
                    for item in statuses
                    if item.get("submission_status") == "NOT_SUBMITTED"
                ]
                submitted_count = output.get("submitted_count", 0)
                if missing:
                    titles = "、".join(
                        f"《{item.get('title') or '未命名作业'}》" for item in missing[:5]
                    )
                    lines.append(f"你还有 {len(missing)} 项作业未提交：{titles}。")
                else:
                    lines.append(f"当前可见作业中已有 {submitted_count} 项提交记录。")
                continue
            if tool == "get_my_grades":
                grades = output.get("grades") or []
                if grades:
                    lines.append(
                        "近期成绩："
                        + "；".join(
                            f"《{grade.get('title') or '未命名作业'}》{grade.get('score')}"
                            for grade in grades[:5]
                        )
                    )
                continue
            if tool == "analyze_learning_gaps":
                summary = output.get("summary")
                average = output.get("average_percentage")
                if summary:
                    suffix = f"，平均完成度约 {average}%" if average is not None else ""
                    lines.append(f"学情判断：{summary}{suffix}。")
                continue
            if tool == "generate_learning_plan":
                tasks = output.get("daily_tasks") or []
                if tasks:
                    lines.append(
                        "学习安排："
                        + "；".join(
                            f"第 {task.get('day')} 天 {task.get('focus')}"
                            for task in tasks[:5]
                        )
                    )
                continue
            if tool == "get_course_overview":
                course = output.get("course")
                courses = output.get("courses") or []
                if course:
                    lines.append(self._format_course_brief(course))
                elif courses:
                    lines.append(
                        "可见课程："
                        + "、".join(
                            str(course.get("name") or "未命名课程")
                            for course in courses[:5]
                        )
                    )
                continue
            if tool == "get_course_statistics":
                lines.append(
                    "教学概览："
                    f"学生 {output.get('student_count', 0)} 人，"
                    f"作业 {output.get('assignment_count', 0)} 项，"
                    f"待批改 {output.get('pending_grading', 0)} 份，"
                    f"已评分 {output.get('graded_count', 0)} 份。"
                )
        return "\n".join(lines)

    def _format_assignment_brief(self, assignment: Dict[str, Any]) -> str:
        title = assignment.get("title") or "未命名作业"
        due_date = assignment.get("due_date") or "未设置截止时间"
        description = (assignment.get("description") or "").strip()
        description_text = f"，要求：{description[:80]}" if description else ""
        return f"《{title}》（截止：{due_date}{description_text}）"

    def _format_course_brief(self, course: Dict[str, Any]) -> str:
        name = course.get("name") or "未命名课程"
        schedule = course.get("schedule") or "未设置"
        description = (course.get("description") or "暂无课程简介").strip()
        return f"课程《{name}》：上课时间 {schedule}，简介：{description}"

    def _format_confirmation_step(self, step: AgentPlanStep) -> str:
        args = step.args
        if step.tool == "publish_assignment":
            due_date = args.get("due_date") or "未设置截止时间"
            total_points = args.get("total_points")
            points_text = f"，总分 {total_points}" if total_points is not None else ""
            return (
                f"发布作业《{args.get('title')}》到课程 {args.get('course_id')}"
                f"，截止时间 {due_date}{points_text}。"
            )
        if step.tool == "submit_assignment":
            content = str(args.get("content") or "")
            summary = content[:80] + ("..." if len(content) > 80 else "")
            return f"提交作业 {args.get('assignment_id')}，内容摘要：{summary}"
        if step.tool == "send_notification":
            return f"发送通知给 {args.get('recipient_username')}：{args.get('title')}"
        return step.tool

    async def run(
        self,
        question: str,
        course_id: Optional[int],
        session_id: str,
        confirm: bool = False,
    ) -> Dict[str, Any]:
        started = time.time()
        run = await self.service.create_run(
            user_id=self.user.id,
            role=self.user.role,
            workflow="agent_runtime",
            input_summary=f"智慧教育机器人: {question[:120]}",
        )
        self.active_run_id = run.id
        memory = await self.memory.load(
            self.user.id, session_id, course_id, limit=settings.agent_memory_load_limit
        )
        plan, planner_source = await self.plan(question, course_id, memory)
        if plan.objective.startswith("NEEDS_CLARIFICATION:"):
            answer = plan.objective.split(":", 1)[1].strip()
            await self.service.update_run_plan(
                run.id,
                {
                    "planner_source": planner_source,
                    "objective": plan.objective,
                    "steps": [],
                    "rejected": [],
                },
            )
            await self.service.log_tool_call_json(
                run.id,
                "agent_planner",
                {"question": question, "assistant": "smart_education"},
                {"source": planner_source, "plan": plan.model_dump(), "rejected": []},
            )
            await self.service.update_run_status(
                run.id,
                "NEEDS_INPUT",
                output_summary=answer,
            )
            return {
                "answer": answer,
                "status": "NEEDS_INPUT",
                "plan": plan.model_dump(),
                "executed_steps": [],
                "requires_confirmation": [],
                "memory": {"session_id": session_id, "used_count": len(memory)},
                "run_id": run.id,
                "citations": [],
                "confidence": 0.0,
                "confirmation_required": False,
            }
        prepared_steps: List[AgentPlanStep] = []
        rejected: List[Dict[str, Any]] = []
        for step in plan.steps:
            try:
                prepared_steps.append(self._prepare_step(step, question, course_id))
            except AgentToolError as exc:
                rejected.append(
                    {"tool": step.tool, "status": "REJECTED", "error": str(exc)}
                )
        plan = AgentPlan(objective=plan.objective, steps=prepared_steps)
        await self.service.update_run_plan(
            run.id,
            {
                "planner_source": planner_source,
                "objective": plan.objective,
                "steps": [step.model_dump() for step in plan.steps],
                "rejected": rejected,
            },
        )
        await self.service.log_tool_call_json(
            run.id,
            "agent_planner",
            {"question": question, "assistant": "smart_education"},
            {
                "source": planner_source,
                "plan": plan.model_dump(),
                "rejected": rejected,
            },
        )

        pending = [
            step for step in plan.steps
            if self.registry.get(step.tool).requires_confirmation and not confirm
        ]
        if pending:
            answer = (
                "请确认以下操作，确认后我再执行：\n"
                + "\n".join(f"- {self._format_confirmation_step(step)}" for step in pending)
            )
            await self.service.update_run_status(
                run.id,
                "WAITING_CONFIRMATION",
                output_summary=answer,
            )
            return {
                "answer": answer,
                "status": "WAITING_CONFIRMATION",
                "plan": plan.model_dump(),
                "executed_steps": [],
                "requires_confirmation": [step.model_dump() for step in pending],
                "memory": {"session_id": session_id, "used_count": len(memory)},
                "run_id": run.id,
                "citations": [],
                "confidence": 0.0,
                "confirmation_required": True,
            }

        execution: List[Dict[str, Any]] = []
        for step in plan.steps:
            started_step = time.time()
            trace: Dict[str, Any] = {
                "tool": step.tool,
                "args": step.args,
                "reason": step.reason,
                "status": "RUNNING",
            }
            try:
                output = await self.registry.execute(step.tool, step.args)
                trace.update(
                    {
                        "status": "COMPLETED",
                        "output": output,
                        "latency_ms": int((time.time() - started_step) * 1000),
                    }
                )
                await self.service.log_tool_call_json(
                    run.id,
                    step.tool,
                    step.args,
                    output,
                    latency_ms=trace["latency_ms"],
                )
            except Exception as exc:
                trace.update(
                    {
                        "status": "FAILED",
                        "error": str(exc),
                        "latency_ms": int((time.time() - started_step) * 1000),
                    }
                )
                await self.service.log_tool_call_json(
                    run.id,
                    step.tool,
                    step.args,
                    {},
                    latency_ms=trace["latency_ms"],
                    error=str(exc),
                )
            execution.append(trace)

        answer, synthesis_source = await self._synthesize(
            question, plan, execution, memory
        )
        await self.service.log_tool_call_json(
            run.id,
            "agent_synthesis",
            {"question": question, "step_count": len(execution)},
            {"answer": answer, "source": synthesis_source},
        )
        citations = []
        for trace in execution:
            citations.extend((trace.get("output") or {}).get("citations", []))
        confidence = max(
            [float(item.get("similarity", 0)) for item in citations] or [0.0]
        )
        await self.memory.remember_turn(
            self.user.id,
            session_id,
            course_id,
            question,
            answer,
            [item["tool"] for item in execution],
        )
        latency = int((time.time() - started) * 1000)
        await self.service.log_qa(
            course_id=course_id or 0,
            user_id=self.user.id,
            question=question,
            answer=answer,
            citations=json.dumps(citations, ensure_ascii=False),
            confidence=confidence,
            latency_ms=latency,
        )
        await self.service.complete_run(
            run.id,
            output_summary=answer[:500],
            latency_ms=latency,
        )
        return {
            "answer": answer,
            "status": "COMPLETED",
            "plan": plan.model_dump(),
            "executed_steps": execution,
            "requires_confirmation": [],
            "memory": {"session_id": session_id, "used_count": len(memory)},
            "run_id": run.id,
            "citations": citations[:10],
            "confidence": confidence,
            "confirmation_required": False,
        }
