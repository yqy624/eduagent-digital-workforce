# -*- coding: utf-8 -*-
"""生成 EduAgent 项目 Word 文档：需求分析 / 产品设计 / 技术方案 / 开发周期"""
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
import datetime

OUT = r"~\Desktop\school\CCC\edu-ai-platform\EduAgent_项目需求分析与技术实现方案.docx"


def set_ea(run_or_style, ea_font):
    """安全设置中文字体（eastAsia），自动创建缺失的 rPr/rFonts 元素。"""
    el = run_or_style.element
    rpr = el.get_or_add_rPr() if hasattr(el, "get_or_add_rPr") else el.rPr
    if rpr is None:
        rpr = OxmlElement("w:rPr")
        el.append(rpr)
    rfonts = rpr.rFonts
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    rfonts.set(qn("w:eastAsia"), ea_font)

PRIMARY = RGBColor(0x1F, 0x4E, 0x79)   # 深蓝
ACCENT = RGBColor(0x2E, 0x74, 0xB5)

doc = Document()

# ---------- 全局样式 ----------
style = doc.styles["Normal"]
style.font.name = "Calibri"
style.font.size = Pt(11)
style.element.rPr.rFonts.set(qn("w:eastAsia"), "宋体")
style.paragraph_format.line_spacing = 1.35
style.paragraph_format.space_after = Pt(4)

def set_heading_style(name, size, color=PRIMARY, bold=True, before=14, after=6):
    st = doc.styles[name]
    st.font.name = "Calibri"
    st.font.size = Pt(size)
    st.font.bold = bold
    st.font.color.rgb = color
    set_ea(st, "黑体")
    st.paragraph_format.space_before = Pt(before)
    st.paragraph_format.space_after = Pt(after)

set_heading_style("Heading 1", 18, PRIMARY, True, 20, 8)
set_heading_style("Heading 2", 15, PRIMARY, True, 14, 6)
set_heading_style("Heading 3", 12.5, ACCENT, True, 10, 4)

def para(text, bold=False, size=11, color=None, align=None, indent=0):
    p = doc.add_paragraph()
    r = p.add_run(text)
    r.bold = bold
    r.font.size = Pt(size)
    if color:
        r.font.color.rgb = color
    if align:
        p.alignment = align
    if indent:
        p.paragraph_format.left_indent = Cm(indent)
    return p

def bullet(text, bold_prefix=None):
    p = doc.add_paragraph(style="List Bullet")
    if bold_prefix:
        r = p.add_run(bold_prefix)
        r.bold = True
        p.add_run(text)
    else:
        p.add_run(text)
    return p

def table(headers, rows, widths=None, header_bg="1F4E79"):
    t = doc.add_table(rows=1 + len(rows), cols=len(headers))
    t.style = "Table Grid"
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    for j, h in enumerate(headers):
        cell = t.cell(0, j)
        cell.text = ""
        r = cell.paragraphs[0].add_run(h)
        r.bold = True
        r.font.size = Pt(10.5)
        r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
        r.font.name = "Calibri"
        set_ea(r, "黑体")
        shd = OxmlElement("w:shd")
        shd.set(qn("w:val"), "clear")
        shd.set(qn("w:fill"), header_bg)
        cell._tc.get_or_add_tcPr().append(shd)
        cell.paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.CENTER
    for i, row in enumerate(rows):
        for j, v in enumerate(row):
            cell = t.cell(i + 1, j)
            cell.text = ""
            r = cell.paragraphs[0].add_run(str(v))
            r.font.size = Pt(10)
            r.font.name = "Calibri"
            set_ea(r, "宋体")
    if widths:
        for j, w in enumerate(widths):
            for row in t.rows:
                row.cells[j].width = Cm(w)
    return t

def page_break():
    doc.add_page_break()

# ================= 封面 =================
for _ in range(5):
    doc.add_paragraph()
para("EduAgent", bold=True, size=36, color=PRIMARY, align=WD_ALIGN_PARAGRAPH.CENTER)
para("基于多 Agent 的智慧教育学习运营平台", bold=True, size=20, color=ACCENT, align=WD_ALIGN_PARAGRAPH.CENTER)
doc.add_paragraph()
para("需求分析 · 产品设计思路 · 技术实现方案 · 开发周期规划", size=14, align=WD_ALIGN_PARAGRAPH.CENTER)
doc.add_paragraph()
para("项目文档 V1.0", size=12, align=WD_ALIGN_PARAGRAPH.CENTER)
para(datetime.date.today().strftime("%Y年%m月%d日"), size=12, align=WD_ALIGN_PARAGRAPH.CENTER)
page_break()

# ================= 目录（说明） =================
para("文档目录", bold=True, size=16, color=PRIMARY)
toc_items = [
    ("一、", "项目概述"),
    ("二、", "需求分析"),
    ("三、", "产品设计思路"),
    ("四、", "技术实现方案"),
    ("五、", "开发周期规划"),
    ("六、", "风险分析与总结"),
]
for num, title in toc_items:
    p = doc.add_paragraph()
    r = p.add_run(f"{num}  {title}")
    r.font.size = Pt(12)
    r.bold = True
    p.paragraph_format.space_after = Pt(6)
para("（正文各级标题均已使用 Word 内置标题样式，可在 Word 中通过「引用 → 目录」一键自动生成可跳转目录）",
     size=9, color=RGBColor(0x80, 0x80, 0x80))
page_break()

# ================= 一、项目概述 =================
doc.add_heading("一、项目概述", level=1)
para("EduAgent 是一个基于多 Agent 架构的智慧教育学习运营平台。项目在原有智慧教育管理系统的基础上，将 Java 后端整体迁移为 Python FastAPI，并引入 LangChain 多 Agent 工作流，实现了从「记录课程、作业、成绩」的传统管理系统，向「基于课程资料和学习行为进行学情诊断、课程答疑、学习路径规划、AI 辅助批改和教学建议生成」的智能化学习运营平台的升级。")
para("项目当前定位为 AI 教育平台 Preview / MVP：已具备可演示的三角色工作台（管理员 / 教师 / 学生）、课程与作业管理、学生学习任务、匿名互评、AI 学情诊断、课程资料 RAG 问答和教师 AI 辅助批改闭环。适合用于开源展示、课程设计、毕业设计原型及 AI 教育产品 MVP 验证。")
para("项目部署于阿里云 ECS（Ubuntu 22.04，2 核 2G），通过 Docker Compose 编排 MySQL、FastAPI 后端与 Nginx 前端，提供完整的「开发 — 部署 — 演示」链路。", bold=False)

# ================= 二、需求分析 =================
doc.add_heading("二、需求分析", level=1)

doc.add_heading("2.1 项目背景与痛点", level=2)
bullet("传统教务系统只做「记录」：课程、作业、成绩的增删改查，数据沉淀后缺乏利用，教师难以掌握学生真实学情；")
bullet("学生课后缺少针对性辅导：无法基于自身错题与薄弱点获得个性化学习计划；")
bullet("教师批改负担重：主观题批改耗时，评分标准不统一，评语复用率低；")
bullet("课程资料利用率低：课件、讲义、作业附件散落各处，学生提问无法快速定位到权威资料；")
bullet("技术栈陈旧：原系统为 Java 单体架构，迭代慢、难以接入大模型能力。")

doc.add_heading("2.2 目标用户与角色", level=2)
table(
    ["角色", "用户画像", "核心诉求"],
    [
        ["管理员 ADMIN", "平台运营人员", "用户与权限管理、课程资源全局管理、平台运行概览与数据看板"],
        ["教师 TEACHER", "授课教师", "课程与作业发布、作业批改（含 AI 辅助）、互评配置、学情查看与教学建议"],
        ["学生 STUDENT", "在籍学生", "选课、查看课程与作业、提交作业、匿名互评、AI 课程问答、学情诊断与学习计划"],
    ],
    widths=[3.5, 4.5, 8.0],
)

doc.add_heading("2.3 功能性需求", level=2)
doc.add_heading("2.3.1 认证与用户管理", level=3)
bullet("统一登录入口，支持注册、登录、找回密码；JWT 无状态认证，兼容原前端调用方式；")
bullet("三角色权限隔离，中间件按角色校验接口访问；个人资料查看与修改。")

doc.add_heading("2.3.2 管理员端", level=3)
bullet("用户管理（查询 / 禁用 / 角色分配）；管理后台数据看板（用户数、课程数、活跃度等统计）；")
bullet("课程与资源的全局管理视图。")

doc.add_heading("2.3.3 教师端", level=3)
bullet("课程管理：创建课程、管理课程资料；作业管理：发布作业、设置截止时间与总分；")
bullet("批改管理：查看提交、打分写评语；互评配置：开启/关闭匿名互评、设置互评窗口与奖励规则；")
bullet("AI 辅助批改：一键生成建议分数与评语，确认后写回正式成绩（Human-in-the-loop）；")
bullet("评语记忆：常用评语自动保存与复用，生成教学讲评。")

doc.add_heading("2.3.4 学生端", level=3)
bullet("选课与我的课程；查看作业列表、在线提交作业（支持文件上传，历史提交引用 file_id::fileName 格式）；")
bullet("查看成绩与互评记录；消息通知（REST 拉取 + WebSocket 实时推送）；")
bullet("AI 能力：课程资料问答（RAG）、学情诊断、个性化学习计划生成。")

doc.add_heading("2.3.5 AI 智能功能", level=3)
table(
    ["功能模块", "功能描述", "验收要点"],
    [
        ["课程 RAG 助教", "课程资料上传 → 切片 → 向量索引；学生提问时检索课程文档 + 作业附件 + 教师讲义生成回答", "回答必须带引用来源；无资料支撑时明确拒答"],
        ["学情诊断 Agent", "读取课程、作业、提交、成绩、互评记录，识别薄弱点并生成诊断报告", "诊断结论有数据支撑，可追溯"],
        ["学习路径规划 Agent", "基于诊断结果生成一周学习计划 + 推荐练习", "计划可执行、资料有覆盖、LLM 不可用时规则兜底"],
        ["教师批改 Agent", "按题目要求 + 学生答案 + 评分标准给出建议分数与评语", "教师确认后才写回成绩，评语可记忆复用"],
        ["Agent 运行轨迹", "记录每次 Agent 运行的 tool call 与状态流转，可查询", "GET /api/ai/runs/{run_id} 可回放"],
    ],
    widths=[3.2, 7.8, 5.0],
)

doc.add_heading("2.4 非功能性需求", level=2)
table(
    ["维度", "需求说明"],
    [
        ["性能", "核心列表接口响应 < 500ms；AI 接口异步处理，不阻塞主流程；RAG 检索在秒级返回"],
        ["安全", "JWT 认证 + 角色鉴权；上传文件类型/大小限制（默认 20MB）；密钥通过环境变量注入，不硬编码"],
        ["可用性", "LLM 不可用时 AI 功能自动降级（规则兜底），核心业务不受影响；AI_ENABLED 可整体开关"],
        ["可维护性", "分层架构（router / service / model / schema），统一 camelCase 中间件转换；Alembic 数据库迁移"],
        ["可移植性", "Docker Compose 一键编排（MySQL + Backend + Nginx），支持本地与云服务器一致部署"],
        ["兼容性", "接口字段风格兼容原前端（JSON 响应 camelCase、请求 snake_case）"],
    ],
    widths=[2.5, 13.5],
)

doc.add_heading("2.5 需求优先级", level=2)
table(
    ["优先级", "需求", "说明"],
    [
        ["P0（必须）", "三角色认证与核心业务（课程/作业/提交/成绩）", "系统可用性基线"],
        ["P0（必须）", "文件上传与预览下载", "作业提交的前置依赖"],
        ["P1（重要）", "AI 学情诊断与学习计划", "项目智能化核心卖点"],
        ["P1（重要）", "教师 AI 辅助批改闭环", "提升教师端价值"],
        ["P1（重要）", "课程 RAG 问答", "资料利用率提升"],
        ["P2（增强）", "匿名互评、通知推送、评语记忆、教学讲评", "体验增强与差异化"],
    ],
    widths=[2.8, 8.0, 5.2],
)

# ================= 三、产品设计思路 =================
doc.add_heading("三、产品设计思路", level=1)

doc.add_heading("3.1 产品定位", level=2)
para("EduAgent 定位为「AI 教育平台 Preview / MVP」，核心理念是：系统不仅管理数据，更主动「读懂」数据。以 Agent 为大脑、以课程资料与学习行为数据为燃料，向三类角色输出可执行的价值：")
bullet("对学生：随时可问的课程助教 + 个性化学习路径；")
bullet("对教师：AI 辅助批改减负 + 学情洞察与教学建议；")
bullet("对管理员：平台运行全景视图。")

doc.add_heading("3.2 总体架构设计", level=2)
para("系统采用「前端静态工作台 + FastAPI 后端 + AI 编排层 + 数据层」的分层架构，整体拓扑如下：")
table(
    ["层次", "组件", "职责"],
    [
        ["接入层", "Nginx（静态 + 反向代理）", "托管前端静态页面，/api 与 /ws 反向代理至后端"],
        ["前端层", "原生 HTML/CSS/JS 三端工作台（login / admin / teacher / student）", "登录统一入口，三角色独立工作台页面，ECharts 数据可视化"],
        ["接口层", "FastAPI + REST + WebSocket", "认证、业务 CRUD、文件、通知、AI 接口；swagger 文档"],
        ["业务层", "Services + Middleware", "业务逻辑、JWT/角色鉴权、camelCase 字段转换"],
        ["AI 编排层", "LangChain + Agent Runtime + Tool Registry", "Runnable 链式工作流、工具注册与调用、运行轨迹记录"],
        ["数据层", "MySQL 8.0 + Redis + Chroma/FAISS", "业务数据、会话缓存、课程资料向量索引"],
        ["模型层", "OpenAI / 通义千问 / Claude / 本地 Ollama", "可切换 LLM，本地模型支持离线演示"],
    ],
    widths=[2.5, 6.5, 7.0],
)

doc.add_heading("3.3 角色工作台设计", level=2)
bullet("统一登录入口：所有角色从同一页面登录，按 JWT 角色路由到对应工作台，并内嵌演示路径与新用户引导；")
bullet("管理员工作台：全局统计看板（ECharts 图表）、用户管理、课程总览；")
bullet("教师工作台：课程与作业管理、提交列表与 AI 批改面板、互评配置、学情查看；")
bullet("学生工作台：选课、我的课程、作业提交、成绩与互评、AI 问答与学习计划入口。")

doc.add_heading("3.4 AI Agent 设计思路", level=2)
doc.add_heading("3.4.1 通用 Agent 运行时", level=3)
para("所有 AI 功能复用同一套 Agent 运行时（ai/agents/runtime.py）与工具注册表（ai/agents/tool_registry.py）：Agent 通过声明式工具调用业务服务（查成绩、查作业、检索资料、生成练习等），每次工具调用写入 ai_tool_calls 表，形成可回放的运行轨迹；LLM 不可用时自动降级为基于规则的兜底输出，保证功能永远可用。")

doc.add_heading("3.4.2 学习路径规划 Agent（Runnable 链）", level=3)
para("采用 LangChain Runnable 链式编排，State 贯穿全流程：")
p = doc.add_paragraph()
r = p.add_run("User Input → [collect_profile 收集画像] → [analyze_weakness 薄弱分析] → [retrieve_materials 检索资料] → [plan_tasks 规划任务] → [generate_exercises 生成练习] → [validate_plan 校验] → [save_report 保存报告]")
r.font.name = "Consolas"
r.font.size = Pt(9.5)
set_ea(r, "宋体")
p.paragraph_format.space_before = Pt(4)
bullet("State 包含 user_id、role、course_id、profile、grades、submissions、weakness、plan、exercises 等字段；")
bullet("每步通过 RunnableLambda 调用 AiToolService 获取真实业务数据并记录 tool trace；")
bullet("短期记忆为 Runnable 内部状态，长期记忆落库 ai_learning_reports，支持历史报告查询。")

doc.add_heading("3.4.3 教师批改 Agent（Human-in-the-loop）", level=3)
p = doc.add_paragraph()
r = p.add_run("{提交ID} → [读取作业+答案] → [获取评分标准] → [AI 评分] → [等待教师确认] → [写回成绩]")
r.font.name = "Consolas"
r.font.size = Pt(9.5)
set_ea(r, "宋体")
p.paragraph_format.space_before = Pt(4)
bullet("AI 只生成建议分数与评语，不直接落库；教师采纳后由人工确认写回正式成绩，保证成绩权威性；")
bullet("评语记忆（teacher_comment_memories 表）自动沉淀教师常用评语，并支持生成教学讲评。")

doc.add_heading("3.5 核心业务流程", level=2)
para("主业务闭环：教师发布作业 → 学生提交作业（可带附件）→（可选）匿名互评 → AI 批改建议 → 教师确认成绩 → 学生查看成绩 → 学情诊断 → 学习计划生成 → 学生按计划学习。", bold=True)
para("整个流程形成「布置 — 提交 — 评价 — 反馈 — 提升」的完整学习运营闭环，AI 在评价（批改建议）与提升（诊断 + 计划 + RAG 答疑）两个环节介入，这是产品区别于传统教务系统的核心差异点。")

# ================= 四、技术实现方案 =================
doc.add_heading("四、技术实现方案", level=1)

doc.add_heading("4.1 技术栈选型", level=2)
table(
    ["层级", "技术选型", "选型理由"],
    [
        ["后端框架", "FastAPI + SQLAlchemy 2.0 Async + Pydantic", "异步高性能、自动 OpenAPI 文档、类型安全"],
        ["数据库", "MySQL 8.0（student_db，utf8mb4）", "成熟稳定，兼容原系统数据"],
        ["缓存", "Redis", "会话与热点缓存"],
        ["认证", "JWT（python-jose）+ 角色中间件", "无状态、兼容原前端"],
        ["AI 编排", "LangChain（Runnable / RunnableLambda / RunnableBranch）", "链式工作流标准、工具编排能力成熟"],
        ["向量检索", "Chroma / FAISS", "课程资料语义检索，支持本地无服务化部署"],
        ["LLM", "OpenAI / 通义千问 / Claude / Ollama（granite4.1:8b）", "多供应商可切换，本地模型支持离线演示"],
        ["前端", "原生 HTML/CSS/JS + ECharts", "轻量免构建，适合静态托管与低资源服务器"],
        ["部署", "Docker Compose + Nginx（阿里云 ECS）", "一键编排，多项目路径路由（/ 与 /new/）"],
    ],
    widths=[2.5, 6.5, 7.0],
)

doc.add_heading("4.2 后端工程结构", level=2)
para("采用清晰的按层分包结构：")
code_lines = [
    "app/            FastAPI 应用",
    "  main.py       应用入口（lifespan 初始化、中间件注册、路由挂载）",
    "  config.py     配置（环境变量驱动）",
    "  database.py   异步数据库引擎与会话",
    "  models/       SQLAlchemy 模型（业务表 + AI 表）",
    "  schemas/      Pydantic 序列化与请求校验（snake_case）",
    "  routers/      auth / admin / teacher / student / files / notifications / ai",
    "  services/     业务逻辑层（auth / course / assignment / student / teacher / ai_tool / notification）",
    "  middleware/   JWT 鉴权 + camelCase 响应转换",
    "ai/             AI 功能模块",
    "  llm.py       LLM 配置与多供应商切换",
    "  prompts.py   提示词模板",
    "  rag/         资料加载器 + 向量存储（切片 / 索引 / 检索）",
    "  agents/      Agent 运行时 + 工具注册表 + 记忆",
    "  tools/       业务工具（成绩 / 作业 / 课程 / 通知）",
    "  workflows/   learning_plan_chain / grading_chain",
    "  evals/       RAG 与批改评测脚本",
    "scripts/        基线检查 / 演示数据 / 部署脚本",
]
for ln in code_lines:
    p = doc.add_paragraph()
    r = p.add_run(ln)
    r.font.name = "Consolas"
    r.font.size = Pt(9)
    set_ea(r, "宋体")
    p.paragraph_format.space_after = Pt(1)

doc.add_heading("4.3 数据模型设计", level=2)
para("业务数据模型（app/models/models.py）：")
table(
    ["数据表", "说明", "关键字段"],
    [
        ["users", "用户（三角色）", "role、username、password_hash、status"],
        ["courses", "课程", "teacher_id、name、description、max_students"],
        ["enrollments", "选课关系", "student_id、course_id、status"],
        ["assignments", "作业", "course_id、due_date、total_points、peer_review_*"],
        ["submissions", "作业提交", "assignment_id、student_id、score、file_path/file_name、ai_suggestion"],
        ["peer_reviews", "匿名互评", "submission_id、reviewer_id、score、comment"],
        ["notifications", "通知", "user_id、type、content、read_at"],
        ["audit_logs", "审计日志", "user_id、action、detail"],
        ["students", "学生档案", "user_id、学号、班级等扩展信息"],
        ["stored_files", "文件存储", "original_name、storage_path、size、content_type"],
        ["teacher_comment_memories", "评语记忆", "teacher_id、content、usage_count"],
    ],
    widths=[4.0, 5.5, 6.5],
)
para("AI 数据模型（app/models/ai_models.py）：")
table(
    ["数据表", "说明"],
    [
        ["ai_document_chunks", "课程资料切片（来源、chunk 文本、向量索引状态）"],
        ["ai_index_jobs", "资料索引任务（状态、进度、错误信息）"],
        ["ai_runs", "Agent 运行记录（工作流类型、状态、输入输出摘要）"],
        ["ai_tool_calls", "Agent 工具调用轨迹（工具名、入参、出参摘要）"],
        ["ai_agent_memories", "Agent 长期记忆"],
        ["ai_qa_logs", "RAG 问答日志（问题、答案、引用来源）"],
        ["ai_learning_reports", "学习计划报告（薄弱点、计划、练习）"],
    ],
    widths=[4.5, 11.5],
)

doc.add_heading("4.4 AI 工作流实现", level=2)
doc.add_heading("4.4.1 RAG 问答链路", level=3)
para("资料上传 → 文件解析（loader）→ 文本切片 → 向量化写入 Chroma/FAISS → 提问时向量检索 Top-K → 组装上下文与引用 → LLM 生成带引用的回答 → 记录 ai_qa_logs。回答强制要求引用来源，检索不到相关资料的提问明确拒答，防止幻觉。")

doc.add_heading("4.4.2 学习计划链实现要点", level=3)
bullet("TypedDict 定义全链路 State，类型安全；")
bullet("每个节点为 RunnableLambda，挂载日志与 tool trace 记录；")
bullet("validate_plan 节点校验计划可执行性（任务数、时间安排、资料覆盖），不通过则通过 RunnableBranch 重试或修正；")
bullet("LLM 异常时 Fallback 到基于成绩统计的规则引擎，保证接口稳定可用。")

doc.add_heading("4.4.3 批改链实现要点", level=3)
bullet("组合「作业要求 + 学生答案 + 评分标准 + 互评/附件状态」构造上下文，实现内容感知的评分建议；")
bullet("ai_runs 记录建议生成过程；教师确认接口将建议分数写回 submissions.score；")
bullet("本地内容感知规则作为稳定默认，真实 LLM 评分作为增强（可选依赖，缺失时自动降级）。")

doc.add_heading("4.5 API 设计", level=2)
para("统一前缀 /api，响应经 camelCase 中间件转换为前端 camelCase 字段；请求体使用 snake_case。核心接口：")
table(
    ["接口", "角色", "功能"],
    [
        ["POST /api/auth/login · register · forgot-password", "ALL", "登录 / 注册 / 找回密码"],
        ["GET /api/admin/users · /api/admin/dashboard", "ADMIN", "用户管理 / 管理看板"],
        ["GET·POST /api/teacher/courses；POST /api/teacher/assignments", "TEACHER", "课程与作业管理"],
        ["POST /api/teacher/submissions/{id}/grade", "TEACHER", "批改写回成绩"],
        ["GET /api/student/courses · my-courses；POST enroll/{id}", "STUDENT", "选课与我的课程"],
        ["POST /api/student/assignments/{id}/submit", "STUDENT", "提交作业"],
        ["POST /api/files/upload · GET preview · download", "ALL", "文件上传预览下载"],
        ["GET /api/notifications；WS /ws/notifications?token=", "ALL", "通知拉取与实时推送"],
        ["POST /api/ai/courses/{id}/qa", "ALL", "课程 RAG 问答"],
        ["POST /api/ai/students/{id}/diagnosis · learning-plan", "SELF/TEACHER", "学情诊断 / 学习计划"],
        ["POST /api/ai/teacher/submissions/{id}/grade-suggestion", "TEACHER", "AI 批改建议"],
        ["GET /api/ai/runs/{run_id}", "OWNER/ADMIN", "Agent 运行轨迹回放"],
    ],
    widths=[7.5, 2.5, 6.0],
)

doc.add_heading("4.6 前端实现", level=2)
bullet("静态三端工作台：static/login.html、static/admin、static/teacher、static/student；")
bullet("app.js 统一封装 fetch、JWT 注入与错误处理；ECharts 实现统计图表；")
bullet("响应式布局适配桌面与移动端；「加载中 — 成功 — 失败」统一反馈模式；")
bullet("无需构建工具，静态文件由 Nginx 直接托管，适配低配云服务器。")

doc.add_heading("4.7 部署方案", level=2)
para("Docker Compose 三容器编排：")
bullet("mysql:8.0：数据持久化卷，healthcheck 就绪检测；")
bullet("backend：FastAPI 应用（Gunicorn + Uvicorn workers），环境变量注入数据库与密钥配置；")
bullet("nginx:alpine：托管 static/，反向代理 /api 与 /ws 至后端，80 端口对外；")
bullet("服务器 nginx 按路径路由多项目：/ → EduAgent，/new/ → realtime-collab-doc；")
bullet("更新流程：本地 git push → 服务器 git pull → docker compose up -d --build，容器 unless-stopped 自动恢复。")

# ================= 五、开发周期规划 =================
doc.add_heading("五、开发周期规划", level=1)
para("本规划面向单人开发（毕业设计 / 课程设计 / MVP 验证场景），按 5 天/周、每天约 6 小时有效开发时间估算，总工期 8 周（约 40 个工作日）。各阶段产出物明确、可验收，阶段间存在顺序依赖，核心链路（P0）集中在前 5 周完成。")

doc.add_heading("5.1 阶段划分与工期明细", level=2)
table(
    ["阶段", "主要任务", "工期", "里程碑 / 产出物"],
    [
        ["阶段一：需求分析与总体设计", "需求调研、用例梳理、角色与功能清单、架构选型、数据库 ER 设计、接口契约定义", "5 天（第 1 周）", "需求文档 + 架构图 + 数据模型 + API 契约"],
        ["阶段二：开发环境与项目骨架", "虚拟环境、依赖安装、FastAPI 骨架、配置管理、数据库连接、Alembic 初始化、CI 基线脚本", "3 天（第 2 周 1-3 天）", "可启动的空服务 + 基线检查通过"],
        ["阶段三：认证与三角色核心业务", "JWT 认证中间件、用户/课程/选课/作业/提交/成绩/互评 CRUD、管理员看板、演示数据脚本", "8 天（第 2 周 4-5 天 + 第 3 周）", "三角色核心 API 全部可用，Swagger 可测"],
        ["阶段四：文件服务与课程知识库", "文件上传/预览/下载、类型与大小校验、课程资料管理、RAG 切片与向量索引", "5 天（第 4 周）", "文件闭环 + 课程资料可索引可检索"],
        ["阶段五：AI Agent 工作流", "LLM 接入与多供应商切换、Agent 运行时与工具注册、RAG 问答、学情诊断、学习计划链、教师批改链、运行轨迹", "10 天（第 5-6 周）", "三大 AI 功能端到端可用，含规则兜底"],
        ["阶段六：前端工作台与联调", "统一登录页、三角色工作台页面、ECharts 看板、AI 功能交互面板、通知推送联调、移动端适配", "5 天（第 7 周）", "全流程可演示的完整产品界面"],
        ["阶段七：测试与评测", "基线检查、核心接口回归、RAG/批改/学习计划评测脚本、边界与异常用例", "3 天（第 8 周 1-3 天）", "评测报告 + 已知问题清单"],
        ["阶段八：部署上线与文档交付", "Docker Compose 编排、Nginx 配置、服务器部署、演示数据初始化、README 与项目文档归档", "2 天（第 8 周 4-5 天）", "线上可访问的演示环境 + 完整文档"],
    ],
    widths=[4.0, 6.0, 2.6, 3.4],
)

doc.add_heading("5.2 周进度甘特示意", level=2)
gantt = [
    ["阶段一 需求分析与总体设计", "■■■■■", "■■■■■", "", "", "", "", "", ""],
    ["阶段二 环境与骨架", "■■■", "", "", "", "", "", "", ""],
    ["阶段三 认证与核心业务", "■■", "■■■■■", "■", "", "", "", "", ""],
    ["阶段四 文件与课程知识库", "", "", "■■■■■", "", "", "", "", ""],
    ["阶段五 AI Agent 工作流", "", "", "", "■■■■■", "■■■■■", "", "", ""],
    ["阶段六 前端与联调", "", "", "", "", "", "■■■■■", "", ""],
    ["阶段七 测试与评测", "", "", "", "", "", "", "■■■", ""],
    ["阶段八 部署与交付", "", "", "", "", "", "", "■■", "■■"],
]
t = doc.add_table(rows=1 + len(gantt), cols=9)
t.style = "Table Grid"
headers = ["阶段 \\ 周次", "第1周", "第2周", "第3周", "第4周", "第5周", "第6周", "第7周", "第8周"]
for j, h in enumerate(headers):
    cell = t.cell(0, j)
    cell.text = ""
    r = cell.paragraphs[0].add_run(h)
    r.bold = True
    r.font.size = Pt(9.5)
    r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
    set_ea(r, "黑体")
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:fill"), "1F4E79")
    cell._tc.get_or_add_tcPr().append(shd)
    cell.paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.CENTER
for i, row in enumerate(gantt):
    for j, v in enumerate(row):
        cell = t.cell(i + 1, j)
        cell.text = ""
        r = cell.paragraphs[0].add_run(v)
        r.font.size = Pt(9)
        r.font.name = "Consolas"
        set_ea(r, "宋体")
        if j == 0:
            r.font.size = Pt(9)
            cell.paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.LEFT
        else:
            cell.paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.CENTER
doc.add_paragraph()
para("说明：■ 表示该周投入开发。阶段三与阶段四存在少量并行（第 3 周第 1 天为阶段三收尾），阶段六依赖阶段五的 AI 接口先联调后端再接入页面。", size=9.5, color=RGBColor(0x60, 0x60, 0x60))

doc.add_heading("5.3 关键里程碑", level=2)
table(
    ["里程碑", "时间点", "验收标准"],
    [
        ["M1 系统骨架可用", "第 2 周第 3 天", "服务可启动，基线检查 0 错误，数据库迁移成功"],
        ["M2 核心业务闭环", "第 3 周结束", "三角色 API 全量可用，Swagger 完成端到端联调"],
        ["M3 知识库就绪", "第 4 周结束", "资料上传→索引→检索全链路可用，引用可追溯"],
        ["M4 AI 能力完成", "第 6 周结束", "诊断、计划、批改三大 Agent 端到端可用，含降级兜底"],
        ["M5 产品可演示", "第 7 周结束", "三端工作台完整可用，演示路径顺畅"],
        ["M6 上线交付", "第 8 周结束", "线上环境可访问，文档齐全，评测报告完成"],
    ],
    widths=[3.8, 3.4, 8.8],
)

doc.add_heading("5.4 阶段工作分配建议（单人或小组）", level=2)
table(
    ["人数", "分工建议", "工期影响"],
    [
        ["单人", "按阶段顺序推进，AI 阶段（阶段五）预留缓冲", "8 周"],
        ["双人", "A：后端 + AI 工作流；B：前端工作台 + 部署联调，阶段三起并行", "6 周（阶段三开始并行）"],
        ["三人小组", "A：后端与数据库；B：AI 与评测；C：前端与部署，阶段一后全面并行", "5 周"],
    ],
    widths=[2.5, 9.5, 4.0],
)

# ================= 六、风险分析与总结 =================
doc.add_heading("六、风险分析与总结", level=1)
doc.add_heading("6.1 风险与应对", level=2)
table(
    ["风险", "影响", "应对措施"],
    [
        ["LLM 服务不稳定 / 无网络", "AI 功能不可用", "多供应商切换 + 本地 Ollama + 规则兜底，AI_ENABLED 开关"],
        ["低配服务器资源不足（2G 内存）", "构建与运行缓慢", "轻量依赖、静态前端免构建、Docker 资源限制、按需启动服务"],
        ["异步 SQLAlchemy 使用不当", "连接泄漏 / 死锁", "统一 session 依赖注入、基线脚本巡检、日志监控"],
        ["RAG 检索质量差", "回答引用错误", "切片策略调优、检索 Top-K 校验、拒答机制 + 评测脚本量化"],
        ["需求蔓延", "工期超期", "P0/P1/P2 分级，先闭环核心链路再增强"],
    ],
    widths=[4.5, 3.0, 8.5],
)

doc.add_heading("6.2 总结", level=2)
para("EduAgent 以「多 Agent 智慧教育」为核心定位，通过 FastAPI + LangChain 的技术组合，在传统教务管理之上构建了 RAG 课程答疑、学情诊断、学习路径规划、AI 辅助批改四大智能能力，并以三角色工作台承载完整的学习运营闭环。项目规划 8 周工期、六大里程碑，节奏紧凑、可验收性强，适合作为毕业设计、课程设计或 AI 教育产品 MVP 落地演示。")

doc.save(OUT)
print("OK ->", OUT)
