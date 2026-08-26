"""Teacher grading-suggestion Agent workflow implemented with LangChain runnables."""
import json
import re
from typing import Any, Dict, List, Literal, Optional, TypedDict

from langchain_core.output_parsers import JsonOutputParser
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import RunnableBranch, RunnableLambda

from app.services.ai_tool_service import AiToolService
from ai.llm import get_llm
from ai.prompts import GRADING_SYSTEM_PROMPT


_STOPWORDS = {
    "assignment",
    "requirement",
    "requirements",
    "student",
    "teacher",
    "submit",
    "submission",
    "course",
    "content",
    "include",
    "using",
    "with",
    "from",
    "that",
    "this",
    "your",
    "\u4f5c\u4e1a",
    "\u8981\u6c42",
    "\u63d0\u4ea4",
    "\u8bfe\u7a0b",
    "\u5b66\u751f",
    "\u6559\u5e08",
    "\u5b8c\u6210",
    "\u8bf4\u660e",
    "\u5185\u5bb9",
    "\u5206\u6790",
    "\u6839\u636e",
    "\u5305\u62ec",
    "\u9700\u8981",
    "\u76f8\u5173",
    "\u901a\u8fc7",
    "\u4f7f\u7528",
    "\u8bc4\u5206",
    "\u6807\u51c6",
    "\u9644\u4ef6",
    "\u6587\u4ef6",
}

_CJK_NOISE_PATTERN = re.compile(
    "|".join(
        [
            "\u8bf7",
            "\u6839\u636e",
            "\u5b8c\u6210",
            "\u63d0\u4ea4",
            "\u5305\u542b",
            "\u5305\u62ec",
            "\u4f5c\u4e1a",
            "\u8981\u6c42",
            "\u8bfe\u7a0b",
            "\u5b66\u751f",
            "\u6559\u5e08",
            "\u8bf4\u660e",
            "\u8fdb\u884c",
            "\u5206\u6790",
            "\u5b9e\u9a8c",
            "\u9700\u8981",
            "\u7ed9\u51fa",
            "\u4ee5\u53ca",
            "\u6216\u8005",
            "\u548c",
            "\u4e0e",
            "\u53ca",
            "\u5e76",
            "\u7684",
        ]
    )
)

_GRADING_DIMENSIONS = (
    ("requirements", "切题性/要求覆盖", 0.24),
    ("completeness", "完整度", 0.26),
    ("depth", "内容深度", 0.18),
    ("structure", "结构", 0.10),
    ("evidence", "证据与论证", 0.14),
    ("expression", "语法与表达", 0.08),
)

_DIMENSION_ALIASES = {
    "topic": "requirements",
    "relevance": "requirements",
    "coverage": "completeness",
    "fullness": "completeness",
    "grammar": "expression",
    "language": "expression",
    "reasoning": "evidence",
}

_CHECKLIST_STATUS_ALIASES = {
    "complete": "complete",
    "completed": "complete",
    "done": "complete",
    "partial": "partial",
    "partially": "partial",
    "missing": "missing",
    "incomplete": "missing",
    "缺失": "missing",
    "未完成": "missing",
    "部分完成": "partial",
    "完成": "complete",
}


def _safe_total_points(assignment: Dict[str, Any]) -> float:
    value = assignment.get("total_points") or 100
    try:
        return float(value)
    except (TypeError, ValueError):
        return 100.0


def _text_value(value: Any) -> str:
    return str(value or "").strip()


def _normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def _split_cjk_phrases(segment: str) -> List[str]:
    cleaned = _CJK_NOISE_PATTERN.sub("|", segment)
    raw_parts = re.split(r"[|,.;:!?，。；：！？、\s]+", cleaned)
    phrases: List[str] = []
    for part in raw_parts:
        part = part.strip()
        if len(part) < 2:
            continue
        if len(part) <= 6:
            phrases.append(part)
            continue
        phrases.append(part)
        sizes = (6, 4) if len(part) > 10 else (4,)
        for size in sizes:
            step = max(size // 2, 1)
            for index in range(0, max(len(part) - size + 1, 0), step):
                chunk = part[index:index + size]
                if len(chunk) >= 4:
                    phrases.append(chunk)
    return phrases


def _extract_keywords(text: str, limit: int = 16) -> List[str]:
    """Extract grading-coverage keywords without fragmenting CJK text into bigrams."""
    if not text:
        return []

    candidates: List[str] = []
    candidates.extend(re.findall(r"[A-Za-z][A-Za-z0-9_+#.-]{1,}", text))
    for segment in re.findall(r"[\u4e00-\u9fff]{2,}", text):
        candidates.extend(_split_cjk_phrases(segment))

    keywords: List[str] = []
    seen = set()
    for raw in candidates:
        token = raw.strip(" \t\r\n,.!?;:()[]{}<>\"'")
        if len(token) < 2:
            continue
        token_lower = token.lower()
        if token_lower in _STOPWORDS or token_lower.isdigit():
            continue
        if token_lower not in seen:
            seen.add(token_lower)
            keywords.append(token)
        if len(keywords) >= limit:
            break
    return keywords


def _count_markers(text: str, markers: List[str]) -> int:
    lowered = text.lower()
    return sum(1 for marker in markers if marker.lower() in lowered)


def _attachment_names(submission: Dict[str, Any]) -> List[str]:
    names: List[str] = []
    raw_paths = _text_value(submission.get("file_paths"))
    if raw_paths:
        for item in re.split(r"[,;\n]+", raw_paths):
            item = item.strip()
            if item:
                names.append(item.split("::", 1)[1] if "::" in item else item)
    file_name = _text_value(submission.get("file_name"))
    if file_name and file_name not in names:
        names.append(file_name)
    return names


def _safe_score(value: Any, *, clamp: bool = False) -> float:
    """Normalize a model-provided score and optionally clamp bad bounds."""
    if isinstance(value, bool):
        raise ValueError("score must be numeric")
    try:
        score = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("score must be numeric") from exc
    if not clamp and not 0 <= score <= 100:
        raise ValueError(f"score {score} is outside 0-100")
    return max(0.0, min(100.0, score))


def _normalize_checklist_status(value: Any) -> str:
    raw = _text_value(value)
    return _CHECKLIST_STATUS_ALIASES.get(raw.lower(), _CHECKLIST_STATUS_ALIASES.get(raw, ""))


def _validate_requirement_checklist(payload: Any) -> List[Dict[str, str]]:
    if not isinstance(payload, list):
        raise ValueError("model output must contain requirement_checklist")
    if not payload:
        raise ValueError("requirement checklist must contain at least one item")

    checklist: List[Dict[str, str]] = []
    for raw_item in payload[:12]:
        if not isinstance(raw_item, dict):
            raise ValueError("requirement checklist items must be objects")
        requirement = _text_value(raw_item.get("requirement"))
        status = _normalize_checklist_status(raw_item.get("status"))
        evidence = _text_value(raw_item.get("evidence"))
        if not requirement or status not in {"complete", "partial", "missing"} or not evidence:
            raise ValueError("invalid requirement checklist item")
        checklist.append(
            {
                "requirement": requirement[:300],
                "status": status,
                "evidence": evidence[:500],
            }
        )
    return checklist


def _checklist_ratio(checklist: List[Dict[str, str]]) -> Optional[float]:
    if not checklist:
        return None
    values = {"complete": 1.0, "partial": 0.5, "missing": 0.0}
    return round(sum(values[item["status"]] for item in checklist) / len(checklist), 2)


def _validate_critique(payload: Any, *, clamp: bool = False) -> Dict[str, Any]:
    """Validate the strict JSON contract returned by the grading model."""
    if not isinstance(payload, dict):
        raise ValueError("model output must be a JSON object")

    checklist = _validate_requirement_checklist(payload.get("requirement_checklist"))
    raw_dimensions = payload.get("dimensions")
    if not isinstance(raw_dimensions, dict):
        raise ValueError("model output must contain dimensions")

    dimensions: Dict[str, Dict[str, Any]] = {}
    for key, label, _weight in _GRADING_DIMENSIONS:
        raw_item = raw_dimensions.get(key)
        if raw_item is None:
            for alias, target in _DIMENSION_ALIASES.items():
                if target == key and raw_dimensions.get(alias) is not None:
                    raw_item = raw_dimensions[alias]
                    break
        if not isinstance(raw_item, dict):
            raise ValueError(f"missing dimension: {key}")
        comment = _text_value(raw_item.get("comment"))
        if not comment:
            raise ValueError(f"missing comment: {key}")
        dimensions[key] = {
            "label": label,
            "score": round(_safe_score(raw_item.get("score"), clamp=clamp), 1),
            "comment": comment[:500],
        }

    return {
        "requirement_checklist": checklist,
        "checklist_ratio": _checklist_ratio(checklist),
        "dimensions": dimensions,
        "overall_comment": _text_value(
            payload.get("overall_comment") or payload.get("overall_reason")
        )[:800],
    }


def _assignment_allows_concise_response(assignment: Dict[str, Any]) -> bool:
    assignment_text = _normalize_text(
        "\n".join(
            [
                _text_value(assignment.get("title")),
                _text_value(assignment.get("description")),
                _text_value(assignment.get("detail")),
            ]
        )
    )
    return bool(
        re.search(
            r"一句话|不超过\s*\d+\s*字|"
            r"\d+\s*字以内|选择题|判断题|填空题|单项选择|多项选择",
            assignment_text,
            re.IGNORECASE,
        )
    )


def _assignment_complexity(assignment: Dict[str, Any]) -> int:
    assignment_text = _normalize_text(
        "\n".join(
            [
                _text_value(assignment.get("title")),
                _text_value(assignment.get("description")),
                _text_value(assignment.get("detail")),
            ]
        )
    )
    markers = re.findall(
        r"包括|涵盖|分别|并且|以及|完成|解释|说明|分析|比较|实现|给出|"
        r"总结|结果|步骤|实验|代码|数据|原因|优缺点|反思",
        assignment_text,
        re.IGNORECASE,
    )
    return len(markers) + (1 if len(_extract_keywords(assignment_text, limit=12)) >= 8 else 0)


def _content_completeness_cap(
    submission: Dict[str, Any],
    assignment: Dict[str, Any],
) -> Dict[str, Any]:
    content = _normalize_text(_text_value(submission.get("content")))
    if not content:
        return {
            "cap": 0.0 if not _attachment_names(submission) else 55.0,
            "content_length": 0,
            "task_complexity": _assignment_complexity(assignment),
            "reason": "没有可直接评阅的正文内容",
        }
    if _assignment_allows_concise_response(assignment):
        return {
            "cap": 100.0,
            "content_length": len(content),
            "task_complexity": _assignment_complexity(assignment),
            "reason": "作业明确允许简短回答",
        }

    complexity = _assignment_complexity(assignment)
    if complexity < 4:
        cap = 100.0
        reason = "作业要求较少，完整度交由 LLM 结合内容判断"
    elif len(content) < 80:
        cap = 45.0
        reason = "复杂作业的正文过短，无法证明完整完成"
    elif len(content) < 160:
        cap = 60.0
        reason = "正文较短，只能证明部分完成"
    elif len(content) < 280:
        cap = 75.0
        reason = "正文展开有限，完整度需要保守评估"
    elif len(content) < 420:
        cap = 88.0
        reason = "正文基本展开，但仍需检查关键过程和结果"
    else:
        cap = 100.0
        reason = "正文长度足以支持完整性判断，交由 LLM 评估实际质量"
    return {
        "cap": cap,
        "content_length": len(content),
        "task_complexity": complexity,
        "reason": reason,
    }


def _calibrate_critique(
    critique: Dict[str, Any],
    submission: Dict[str, Any],
    assignment: Dict[str, Any],
) -> Dict[str, Any]:
    """Apply evidence-aware completeness guards after the model's qualitative review."""
    calibrated = dict(critique)
    calibrated["dimensions"] = {
        key: dict(item) for key, item in (critique.get("dimensions") or {}).items()
    }
    notes: List[str] = []

    checklist_ratio = critique.get("checklist_ratio")
    if checklist_ratio is not None:
        checklist_cap = checklist_ratio * 100
        for key in ("requirements", "completeness"):
            item = calibrated["dimensions"].get(key)
            if item and item["score"] > checklist_cap:
                item["score"] = round(checklist_cap, 1)
                notes.append(f"{key} 受要求清单完成比例限制")

    profile = _content_completeness_cap(submission, assignment)
    content_cap = profile["cap"]
    if content_cap < 100:
        requirements = calibrated["dimensions"].get("requirements")
        requirements_cap = min(content_cap + 25, 100)
        if requirements and requirements["score"] > requirements_cap:
            requirements["score"] = round(requirements_cap, 1)
            notes.append("要求覆盖受正文证据上限限制")

        completeness = calibrated["dimensions"].get("completeness")
        if completeness and completeness["score"] > content_cap:
            completeness["score"] = round(content_cap, 1)
            notes.append("完整度受正文完整性证据上限限制")

        depth = calibrated["dimensions"].get("depth")
        depth_cap = min(content_cap + 12, 100)
        if depth and depth["score"] > depth_cap:
            depth["score"] = round(depth_cap, 1)
            notes.append("深度受正文展开程度上限限制")

        if profile["content_length"] < 80:
            evidence = calibrated["dimensions"].get("evidence")
            if evidence and evidence["score"] > 45:
                evidence["score"] = 45.0
                notes.append("正文过短，证据分上限为 45")

    calibrated["quality_control"] = {
        **profile,
        "checklist_ratio": checklist_ratio,
        "adjustments": notes,
    }
    return calibrated


def _grading_prompt_payload(
    submission: Dict[str, Any],
    assignment: Dict[str, Any],
    peer_reviews: List[Dict[str, Any]],
) -> str:
    attachment_names = _attachment_names(submission)
    peer_text = "\n".join(
        f"- 评分：{review.get('rating')}/10；评语：{_text_value(review.get('comment'))}"
        for review in peer_reviews[:8]
    ) or "暂无已提交互评"
    return json.dumps(
        {
            "assignment": {
                "title": _text_value(assignment.get("title")),
                "description": _text_value(assignment.get("description")),
                "detail": _text_value(assignment.get("detail")),
                "total_points": _safe_total_points(assignment),
            },
            "submission": {
                "content": _text_value(submission.get("content"))[:16000],
                "attachments": attachment_names,
                "attachment_note": (
                    "附件正文未被当前批改流程解析，只能根据附件名称提示教师复核。"
                    if attachment_names
                    else "无附件"
                ),
            },
            "peer_reviews": peer_text,
        },
        ensure_ascii=False,
    )


async def _invoke_llm_critique(
    submission: Dict[str, Any],
    assignment: Dict[str, Any],
    peer_reviews: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """Call the model through a JSON parser and retry once on contract errors."""
    parser = JsonOutputParser()
    prompt = ChatPromptTemplate.from_messages(
        [
            # 作为变量注入，避免系统提示词中的 JSON 花括号被当成模板变量。
            ("system", "{grading_system_prompt}"),
            (
                "human",
                "请评阅下面的作业数据。\n"
                "返回内容必须是 JSON，不要输出 Markdown。\n"
                "解析器约束：{format_instructions}\n"
                "作业数据：\n{payload}\n"
                "{retry_hint}",
            ),
        ]
    )
    chain = prompt | get_llm(temperature=0.15) | parser
    payload = _grading_prompt_payload(submission, assignment, peer_reviews)
    last_payload = None
    last_error = None

    for attempt in range(2):
        retry_hint = (
            ""
            if attempt == 0
            else (
                "上一次输出未通过校验。请重新输出完整 JSON，确保六个维度都存在，"
                "且 requirement_checklist 至少包含一项，"
                "每个 score 都是 0-100 的数字，且不要输出任何额外文字。"
            )
        )
        try:
            parsed = await chain.ainvoke(
                {
                    "grading_system_prompt": GRADING_SYSTEM_PROMPT,
                    "format_instructions": parser.get_format_instructions(),
                    "payload": payload,
                    "retry_hint": retry_hint,
                }
            )
            last_payload = parsed
            return _validate_critique(parsed)
        except Exception as exc:
            last_error = exc

    # JSON 可解析但仍有越界分数时，最后一次允许截断，避免阻断教师批改。
    if last_payload is not None:
        return _validate_critique(last_payload, clamp=True)
    raise RuntimeError(f"LLM grading critique failed after retry: {last_error}")


def _heuristic_critique(analysis: Dict[str, Any]) -> Dict[str, Any]:
    """Fallback contract for environments without a configured LLM."""
    comments = {
        "requirements": "根据作业要求覆盖和实际回应情况判断是否切题。",
        "completeness": "根据要求覆盖、正文展开、过程、证据和结论判断完成是否完整。",
        "depth": "根据正文展开、句子数量和分析过程判断内容深度。",
        "structure": "根据段落数量和结构标记判断组织是否清晰。",
        "evidence": "根据案例、数据、代码、结果和推理标记判断论证支撑。",
        "expression": "根据文本长度、重复度和表达完整性判断语言规范程度。",
    }
    dimensions = {}
    for key, label, _weight in _GRADING_DIMENSIONS:
        dimensions[key] = {
            "label": label,
            "score": round(float(analysis["component_scores"].get(key, 0.5)) * 100, 1),
            "comment": comments[key],
        }
    checklist = [
        {
            "requirement": keyword,
            "status": "complete",
            "evidence": "正文中出现相关内容",
        }
        for keyword in analysis.get("matched_keywords", [])[:6]
    ]
    checklist.extend(
        {
            "requirement": keyword,
            "status": "missing",
            "evidence": "正文中未找到相关内容",
        }
        for keyword in analysis.get("missing_keywords", [])[:6]
    )
    return {
        "requirement_checklist": checklist,
        "checklist_ratio": _checklist_ratio(checklist),
        "dimensions": dimensions,
        "overall_comment": "当前未能调用评分模型，已使用本地规则生成保守建议，请教师重点复核。",
    }


def _score_critique(
    critique: Dict[str, Any],
    assignment: Dict[str, Any],
    peer_reviews: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """Map validated 0-100 dimension scores to the final assignment score."""
    total_points = _safe_total_points(assignment)
    dimensions = critique["dimensions"]
    component_scores = {
        key: round(float(dimensions[key]["score"]) / 100, 2)
        for key, _label, _weight in _GRADING_DIMENSIONS
    }
    weighted_ratio = sum(
        component_scores[key] * weight
        for key, _label, weight in _GRADING_DIMENSIONS
    )
    score = total_points * max(0.0, min(weighted_ratio, 1.0))

    peer_summary = None
    if peer_reviews:
        peer_summary = round(
            sum(float(review.get("rating") or 0) for review in peer_reviews)
            / len(peer_reviews),
            1,
        )
        if peer_summary >= 8:
            score += total_points * 0.04
        elif peer_summary <= 3:
            score -= total_points * 0.05

    score = max(0.0, min(total_points, round(score, 1)))
    strengths = []
    weaknesses = []
    for key, label, _weight in _GRADING_DIMENSIONS:
        item = dimensions[key]
        line = f"{label}：{item['comment']}"
        if item["score"] >= 70:
            strengths.append(line)
        else:
            weaknesses.append(line)
    if peer_summary is not None:
        peer_line = f"互评平均分为 {peer_summary}/10"
        if peer_summary >= 8:
            strengths.append(peer_line)
        elif peer_summary <= 3:
            weaknesses.append(peer_line + "，建议教师重点复核")

    return {
        "score": score,
        "strengths": strengths[:5],
        "weaknesses": weaknesses[:5],
        "component_scores": component_scores,
        "peer_summary": peer_summary,
    }


def analyze_submission_for_grading(
    submission: Dict[str, Any],
    assignment: Dict[str, Any],
    peer_reviews: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Local content-aware grading analysis for deterministic Agent tooling."""
    total_points = _safe_total_points(assignment)
    raw_content = _text_value(submission.get("content"))
    content = _normalize_text(raw_content)
    assignment_text = "\n".join(
        [
            _text_value(assignment.get("title")),
            _text_value(assignment.get("description")),
            _text_value(assignment.get("detail")),
        ]
    )
    keywords = _extract_keywords(assignment_text)
    content_lower = content.lower()
    matched_keywords = [kw for kw in keywords if kw.lower() in content_lower]
    missing_keywords = [kw for kw in keywords if kw.lower() not in content_lower]
    keyword_coverage = len(matched_keywords) / len(keywords) if keywords else 0.65

    content_length = len(content)
    sentences = [s for s in re.split(r"[.!?\n\u3002\uff01\uff1f]+", raw_content) if s.strip()]
    paragraphs = [p for p in re.split(r"\n{1,}|\r\n{1,}", raw_content) if p.strip()]
    structure_markers = _count_markers(
        content,
        [
            "first",
            "second",
            "then",
            "finally",
            "summary",
            "1.",
            "2.",
            "3.",
            "\u9996\u5148",
            "\u5176\u6b21",
            "\u7136\u540e",
            "\u6700\u540e",
            "\u56e0\u6b64",
            "\u603b\u7ed3",
        ],
    )
    evidence_markers = _count_markers(
        content,
        [
            "example",
            "case",
            "data",
            "result",
            "because",
            "code",
            "formula",
            "experiment",
            "\u4f8b\u5982",
            "\u6848\u4f8b",
            "\u6570\u636e",
            "\u7ed3\u679c",
            "\u539f\u56e0",
            "\u5bf9\u6bd4",
            "\u8bc1\u660e",
            "\u4ee3\u7801",
            "\u516c\u5f0f",
            "\u5b9e\u9a8c",
        ],
    )
    has_numbers_or_code = bool(re.search(r"\d|```|def |class |function |SELECT |import |=", content))
    attachment_list = _attachment_names(submission)
    only_attachment = not content and bool(attachment_list)

    length_ratio = min(content_length / 650, 1.0)
    depth_ratio = min((len(sentences) / 8) * 0.45 + length_ratio * 0.55, 1.0)
    structure_ratio = min((len(paragraphs) / 3) * 0.45 + (structure_markers / 4) * 0.55, 1.0)
    evidence_ratio = min((evidence_markers / 4) * 0.65 + (0.35 if has_numbers_or_code else 0), 1.0)
    completeness_ratio = min(
        keyword_coverage * 0.30
        + depth_ratio * 0.25
        + evidence_ratio * 0.20
        + structure_ratio * 0.15
        + length_ratio * 0.10,
        1.0,
    )
    if len(matched_keywords) >= 5 and content_length >= 120:
        depth_ratio = max(depth_ratio, 0.55)
    if content_length >= 260 and evidence_ratio < 0.35:
        evidence_ratio = 0.35
    completeness_ratio = min(
        keyword_coverage * 0.30
        + depth_ratio * 0.25
        + evidence_ratio * 0.20
        + structure_ratio * 0.15
        + length_ratio * 0.10,
        1.0,
    )
    content_cap = _content_completeness_cap(submission, assignment)["cap"] / 100
    if content_cap < 1:
        completeness_ratio = min(completeness_ratio, content_cap)

    unique_chars = len(set(content))
    unique_ratio = unique_chars / content_length if content_length else 0
    lines = [line.strip() for line in raw_content.splitlines() if line.strip()]
    repeated_lines = len(lines) - len(set(lines)) if len(lines) >= 3 else 0
    if content_length < 40:
        expression_ratio = 0.35
    elif unique_ratio < 0.18 or repeated_lines >= 2:
        expression_ratio = 0.48
    elif content_length >= 160:
        expression_ratio = 0.9
    else:
        expression_ratio = 0.82

    if only_attachment:
        component_scores = {
            "requirements": 0.42,
            "completeness": 0.35,
            "depth": 0.38,
            "structure": 0.35,
            "evidence": 0.38,
            "expression": 0.65,
        }
    else:
        component_scores = {
            "requirements": keyword_coverage,
            "completeness": completeness_ratio,
            "depth": depth_ratio,
            "structure": structure_ratio,
            "evidence": evidence_ratio,
            "expression": expression_ratio,
        }

    weighted_ratio = sum(
        component_scores[key] * weight
        for key, _label, weight in _GRADING_DIMENSIONS
    )
    score = total_points * max(0.0, min(weighted_ratio, 1.0))

    peer_reviews = peer_reviews or []
    peer_summary = None
    if peer_reviews:
        peer_summary = round(sum(float(r.get("rating") or 0) for r in peer_reviews) / len(peer_reviews), 1)
        if peer_summary >= 8:
            score += total_points * 0.04
        elif peer_summary <= 3:
            score -= total_points * 0.05

    score = max(0, min(total_points, round(score, 1)))

    strengths: List[str] = []
    weaknesses: List[str] = []
    risks: List[str] = []

    if matched_keywords:
        strengths.append("Covers key requirements: " + ", ".join(matched_keywords[:4]))
    elif keywords and not only_attachment:
        weaknesses.append("Does not clearly cover key requirements: " + ", ".join(missing_keywords[:4]))

    if content_length >= 450:
        strengths.append("Submission is sufficiently detailed and developed")
    elif only_attachment:
        weaknesses.append("Main evidence is in attachments; text content is not enough for direct assessment")
    elif content_length < 80:
        weaknesses.append("Text content is too short to support a high-confidence grade")
    else:
        weaknesses.append("Depth can be improved with more process, evidence, or conclusions")

    if structure_ratio >= 0.65:
        strengths.append("Structure is clear enough for review")
    else:
        weaknesses.append("Structure is not clear; organize by steps, viewpoints, or headings")

    if evidence_ratio >= 0.55:
        strengths.append("Uses examples, data, code, results, or reasoning as evidence")
    else:
        weaknesses.append("Evidence is insufficient; add cases, data, code, or derivation steps")

    if peer_summary is not None:
        if peer_summary >= 8:
            strengths.append(f"Peer-review average is {peer_summary}/10")
        elif peer_summary <= 3:
            weaknesses.append(f"Peer-review average is {peer_summary}/10; teacher review is recommended")

    if missing_keywords and len(matched_keywords) < max(2, len(keywords) // 3):
        risks.append("Low requirement coverage; teacher should check for topic drift")
    if content_length < 40 and not only_attachment:
        risks.append("Submission text is too short to judge mastery")
    if unique_ratio and unique_ratio < 0.18:
        risks.append("Text repetition is high; check for copied or padded content")
    if only_attachment:
        risks.append("AI did not parse attachment body; preview attachments before confirming the score")

    return {
        "score": score,
        "strengths": strengths[:5],
        "weaknesses": weaknesses[:5],
        "risks": risks[:4],
        "matched_keywords": matched_keywords[:6],
        "missing_keywords": missing_keywords[:6],
        "keyword_coverage": round(keyword_coverage, 2),
        "completeness_ratio": round(completeness_ratio, 2),
        "content_length": content_length,
        "sentence_count": len(sentences),
        "paragraph_count": len(paragraphs),
        "task_complexity": _assignment_complexity(assignment),
        "content_completeness_cap": round(content_cap, 2),
        "attachment_names": attachment_list,
        "component_scores": {key: round(value, 2) for key, value in component_scores.items()},
    }


class GradingState(TypedDict):
    run_id: int
    user_id: int
    submission_id: int
    role: str
    submission: Optional[Dict[str, Any]]
    assignment: Optional[Dict[str, Any]]
    peer_reviews: Optional[List[Dict[str, Any]]]
    critique: Optional[Dict[str, Any]]
    critique_source: Optional[str]
    grading_baseline: Optional[Dict[str, Any]]
    suggested_score: Optional[float]
    rubric: Optional[Dict[str, Any]]
    comment: Optional[str]
    strengths: Optional[List[str]]
    weaknesses: Optional[List[str]]
    risks: Optional[List[str]]
    grading_analysis: Optional[Dict[str, Any]]
    suggestion_id: Optional[int]
    teacher_action: Optional[str]
    teacher_score: Optional[float]
    tool_trace: Optional[List[Dict[str, Any]]]
    error: Optional[str]


async def load_submission(state: GradingState, service: AiToolService) -> Dict[str, Any]:
    submission = await service.grade_tools.get_submission_detail(state["submission_id"])
    if submission is None:
        return {"error": "Submission does not exist"}

    assignment = await service.assignment_tools.get_assignment(submission["assignment_id"])
    peer_reviews = await service.assignment_tools.get_peer_reviews_for_submission(state["submission_id"])
    await service.log_tool_call_json(
        state.get("run_id"),
        "load_submission",
        {"submission_id": state["submission_id"]},
        {
            "assignment_id": submission.get("assignment_id"),
            "assignment_title": assignment.get("title") if assignment else None,
            "peer_review_count": len(peer_reviews),
        },
    )
    return {
        "submission": submission,
        "assignment": assignment or {},
        "peer_reviews": peer_reviews,
        "tool_trace": [
            {
                "node": "load_submission",
                "result": f"Loaded submission ID={state['submission_id']}",
            }
        ],
    }


async def get_rubric(state: GradingState, service: AiToolService) -> Dict[str, Any]:
    assignment = state.get("assignment") or {}
    total_points = _safe_total_points(assignment)
    rubric = {
        "total_points": total_points,
        "criteria": [
            {"name": key, "label": label, "weight": weight, "score_range": [0, 100]}
            for key, label, weight in _GRADING_DIMENSIONS
        ],
    }
    await service.log_tool_call_json(
        state.get("run_id"),
        "get_rubric",
        {"assignment_id": assignment.get("id")},
        rubric,
    )
    return {
        "rubric": rubric,
        "tool_trace": (state.get("tool_trace") or [])
        + [{"node": "get_rubric", "result": f"Loaded rubric with total points {total_points}"}],
    }


async def critique_submission(state: GradingState, service: AiToolService) -> Dict[str, Any]:
    """先让 LLM 按维度点评并输出结构化分数。"""
    if state.get("error"):
        return {"error": state["error"]}
    submission = state.get("submission") or {}
    assignment = state.get("assignment") or {}
    peer_reviews = state.get("peer_reviews") or []
    baseline = analyze_submission_for_grading(submission, assignment, peer_reviews)
    try:
        critique = await _invoke_llm_critique(submission, assignment, peer_reviews)
        critique = _calibrate_critique(critique, submission, assignment)
        source = "llm"
        error = None
    except Exception as exc:
        critique = _heuristic_critique(baseline)
        critique = _calibrate_critique(critique, submission, assignment)
        source = "heuristic_fallback"
        error = str(exc)

    await service.log_tool_call_json(
        state.get("run_id"),
        "critique_submission",
        {
            "submission_id": state["submission_id"],
            "content_length": baseline["content_length"],
            "peer_review_count": len(peer_reviews),
        },
        {
            "source": source,
            "critique": critique,
            "fallback_error": error,
        },
    )
    return {
        "critique": critique,
        "critique_source": source,
        "grading_baseline": baseline,
        "tool_trace": (state.get("tool_trace") or [])
        + [{"node": "critique_submission", "result": f"Critique source: {source}"}],
    }


async def suggest_grade(state: GradingState, service: AiToolService) -> Dict[str, Any]:
    assignment = state.get("assignment") or {}
    peer_reviews = state.get("peer_reviews") or []
    if state.get("error"):
        return {"error": state["error"]}
    critique = state.get("critique") or {}
    baseline = state.get("grading_baseline") or {}
    scored = _score_critique(critique, assignment, peer_reviews)
    total_points = _safe_total_points(assignment)
    rubric = {
        **(state.get("rubric") or {}),
        "requirement_checklist": critique.get("requirement_checklist", []),
        "checklist_ratio": critique.get("checklist_ratio"),
        "dimension_reviews": critique.get("dimensions", {}),
        "overall_comment": critique.get("overall_comment", ""),
        "quality_control": critique.get("quality_control", {}),
        "critique_source": state.get("critique_source") or "unknown",
    }

    await service.log_tool_call_json(
        state.get("run_id"),
        "suggest_grade",
        {
            "submission_id": state["submission_id"],
            "content_length": baseline.get("content_length", 0),
            "peer_review_count": len(peer_reviews),
            "critique_source": state.get("critique_source"),
        },
        {
            "suggested_score": scored["score"],
            "strengths": scored["strengths"],
            "weaknesses": scored["weaknesses"],
            "risks": baseline.get("risks", []),
            "component_scores": scored["component_scores"],
        },
    )
    return {
        "rubric": rubric,
        "suggested_score": scored["score"],
        "strengths": scored["strengths"],
        "weaknesses": scored["weaknesses"],
        "risks": baseline.get("risks", []),
        "grading_analysis": {
            "matched_keywords": baseline.get("matched_keywords", []),
            "missing_keywords": baseline.get("missing_keywords", []),
            "keyword_coverage": baseline.get("keyword_coverage", 0),
            "content_length": baseline.get("content_length", 0),
            "attachment_names": baseline.get("attachment_names", []),
            "sentence_count": baseline.get("sentence_count", 0),
            "paragraph_count": baseline.get("paragraph_count", 0),
            "completeness_ratio": baseline.get("completeness_ratio", 0),
            "content_completeness_cap": baseline.get("content_completeness_cap", 1),
            "component_scores": scored["component_scores"],
            "requirement_checklist": critique.get("requirement_checklist", []),
            "checklist_ratio": critique.get("checklist_ratio"),
            "dimension_reviews": critique.get("dimensions", {}),
            "overall_comment": critique.get("overall_comment", ""),
            "quality_control": critique.get("quality_control", {}),
            "critique_source": state.get("critique_source") or "unknown",
        },
        "tool_trace": (state.get("tool_trace") or [])
        + [{"node": "suggest_grade", "result": f"Suggested score: {scored['score']}/{total_points}"}],
    }


async def generate_comment(state: GradingState, service: AiToolService) -> Dict[str, Any]:
    strengths = state.get("strengths") or []
    weaknesses = state.get("weaknesses") or []
    risks = state.get("risks") or []
    critique = state.get("critique") or {}
    suggested_score = float(state.get("suggested_score") or 0)
    assignment = state.get("assignment") or {}
    submission = state.get("submission") or {}
    total_points = _safe_total_points(assignment)
    assignment_title = _text_value(assignment.get("title")) or "Assignment"
    content = _normalize_text(_text_value(submission.get("content")))

    comment_parts = [f"《{assignment_title}》批改建议"]
    if critique.get("overall_comment"):
        comment_parts.append("总体点评：" + critique["overall_comment"])
    checklist = critique.get("requirement_checklist") or []
    checklist_missing = [
        item["requirement"]
        for item in checklist
        if item.get("status") in {"partial", "missing"}
    ]
    if checklist_missing:
        comment_parts.append("要求清单缺口：" + "；".join(checklist_missing[:5]))
    for key, label, _weight in _GRADING_DIMENSIONS:
        item = (critique.get("dimensions") or {}).get(key)
        if item:
            comment_parts.append(
                f"{label}（{item['score']:.0f}/100）：{item['comment']}"
            )
    if strengths:
        comment_parts.append("主要优点：" + "；".join(strengths))
    if weaknesses:
        comment_parts.append("主要改进：" + "；".join(weaknesses))
    if risks:
        comment_parts.append("教师复核：" + "；".join(risks))
    if content:
        excerpt = content[:90] + ("..." if len(content) > 90 else "")
        comment_parts.append("内容摘录：" + excerpt)

    ratio = suggested_score / max(total_points, 1) * 100
    if ratio >= 90:
        comment_parts.append("综合判断：完成质量优秀。")
    elif ratio >= 75:
        comment_parts.append("综合判断：整体完成较好，但细节和证据仍可加强。")
    elif ratio >= 60:
        comment_parts.append("综合判断：基本满足要求，但仍存在明显薄弱项。")
    else:
        comment_parts.append("综合判断：与要求存在较大差距，建议修改后重新提交。")

    comment = "\n".join(comment_parts)
    await service.log_tool_call_json(
        state.get("run_id"),
        "generate_comment",
        {"suggested_score": suggested_score, "total_points": total_points},
        {"comment": comment},
    )
    return {
        "comment": comment,
        "tool_trace": (state.get("tool_trace") or [])
        + [{"node": "generate_comment", "result": "Generated grading comment"}],
    }


async def wait_for_review(state: GradingState, service: AiToolService) -> Dict[str, Any]:
    if state.get("error"):
        return {"error": state["error"]}
    try:
        suggestion = await service.save_grading_suggestion(
            submission_id=state["submission_id"],
            run_id=state.get("run_id", 0),
            suggested_score=state.get("suggested_score", 0),
            rubric_json=json.dumps(state.get("rubric", {}), ensure_ascii=False),
            comment=state.get("comment", ""),
            strengths=json.dumps(state.get("strengths", []), ensure_ascii=False),
            weaknesses=json.dumps(state.get("weaknesses", []), ensure_ascii=False),
        )
        await service.log_tool_call_json(
            state.get("run_id"),
            "wait_for_review",
            {"submission_id": state["submission_id"]},
            {"suggestion_id": suggestion.id, "teacher_action": "PENDING"},
        )
        return {
            "suggestion_id": suggestion.id,
            "tool_trace": (state.get("tool_trace") or [])
            + [{"node": "wait_for_review", "result": f"Saved suggestion ID={suggestion.id}"}],
        }
    except Exception as exc:
        return {"error": f"Failed to save grading suggestion: {exc}"}


def should_generate_comment(state: GradingState) -> Literal["generate_comment", "wait_for_review"]:
    return "wait_for_review" if state.get("error") else "generate_comment"


def _merge_state(updater):
    """Run one async workflow step and merge its updates into the state."""

    async def invoke(state: GradingState) -> GradingState:
        updates = await updater(state)
        return {**state, **updates}

    return RunnableLambda(invoke)


def build_grading_chain(service: AiToolService):
    """Build a critique-first grading workflow with a review branch."""
    load = _merge_state(lambda state: load_submission(state, service))
    rubric = _merge_state(lambda state: get_rubric(state, service))
    critique = _merge_state(lambda state: critique_submission(state, service))
    suggest = _merge_state(lambda state: suggest_grade(state, service))
    comment = _merge_state(lambda state: generate_comment(state, service))
    review = _merge_state(lambda state: wait_for_review(state, service))

    conditional = RunnableBranch(
        (lambda state: should_generate_comment(state) == "generate_comment", comment | review),
        review,
    )
    return load | rubric | critique | suggest | conditional
