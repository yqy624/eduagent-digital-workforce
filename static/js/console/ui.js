/**
 * 组件层。
 *
 * 分两类：
 *  A. 纯渲染函数（返回 HTML 字符串，由调用方拼装）—— 无副作用，可组合；
 *  B. 浮层控制器（Toast / 抽屉 / 弹窗 / 气泡菜单 / 命令面板）—— 管理挂载与销毁。
 * 机器感知类基元（工具芯片 / 思考轨迹 / 审批卡 / 置信度计）取自
 * Beautiful UI 的设计意图：把 AI 的黑盒过程变成可观测、可介入的白盒。
 */

import { h, esc, raw, $, $$, num, big, pct } from "./dom.js";
import { icon } from "./icons.js";

/* ================= A. 纯渲染 ================= */

export function plate(o) {
  const opts = o || {};
  const head = opts.title || opts.sub || opts.tools
    ? h`<div class="plate-head">
        <div>
          ${opts.title ? h`<div class="plate-title">${opts.title}</div>` : ""}
          ${opts.sub ? h`<div class="plate-sub">${opts.sub}</div>` : ""}
        </div>
        ${opts.tools ? h`<div class="plate-tools">${raw(opts.tools)}</div>` : ""}
      </div>`
    : "";
  return h`<section class="plate ${opts.cls || ""}">
    ${raw(head)}
    <div class="plate-body ${opts.flush ? "is-flush" : ""}">${raw(opts.body || "")}</div>
    ${opts.foot ? h`<div class="plate-foot">${raw(opts.foot)}</div>` : ""}
  </section>`;
}

const TONE_ICON = { ok: "check-circle", warn: "alert", danger: "x-circle", info: "info", signal: "zap", scan: "scan" };

export function badge(text, tone, ico) {
  const cls = tone ? " badge--" + tone : "";
  const gi = ico || (tone && TONE_ICON[tone]) || null;
  return h`<span class="badge${cls}">${gi ? raw(icon(gi)) : ""}${text}</span>`;
}

export function statCard(o) {
  const b = typeof o.value === "object" && o.value !== null && "n" in o.value ? o.value : big(o.value);
  const shown = typeof b === "object" ? b.n : b;
  const unit = typeof b === "object" ? b.u : (o.unit || "");
  const isTxt = shown == null || shown === "" || Number.isNaN(Number(shown));
  return h`<div class="stat">
    <div class="stat-k">${o.icon ? raw(icon(o.icon)) : ""}${o.label}</div>
    <div class="stat-v num">
      <span class="n ${isTxt ? "is-txt" : ""}" ${isTxt ? "" : raw('data-count="' + shown + '"')}>${shown == null || shown === "" ? "—" : shown}</span>
      ${(unit || o.unit) ? h`<span class="u">${unit || o.unit}</span>` : ""}
    </div>
    ${o.hint ? h`<div class="stat-h">${o.hint}</div>` : ""}
  </div>`;
}

export function emptyState(o) {
  const opts = o || {};
  return h`<div class="empty">
    <div class="empty-ico">${raw(icon(opts.icon || "scan"))}</div>
    <div class="empty-t">${opts.title || "暂无内容"}</div>
    ${opts.desc ? h`<div class="empty-d">${opts.desc}</div>` : ""}
    ${opts.action ? h`<div class="mt-5">${raw(opts.action)}</div>` : ""}
  </div>`;
}

export function noteBox(o) {
  const tone = o.kind ? " note--" + o.kind : "";
  const gi = o.icon || (o.kind === "danger" ? "alert-octagon" : o.kind === "warn" ? "alert" : "info");
  return h`<div class="note${tone}">${raw(icon(gi))}
    <div>${o.title ? h`<b>${o.title}</b>` : ""}${o.title && o.body ? " " : ""}${raw(o.body || "")}</div>
  </div>`;
}

export function meter(value, tone, thin) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  return h`<div class="meter ${thin ? "meter--thin" : ""}">
    <div class="meter-fill ${tone || ""}" style="width:${v}%"></div></div>`;
}

/** 置信度计（机器给出的把握程度，用琥珀刻度标记） */
export function confMeter(v) {
  const n = Math.max(0, Math.min(1, Number(v) || 0));
  return h`<div class="conf">
    <div class="conf-track"><span class="conf-mark" style="left:calc(${(n * 100).toFixed(1)}% - 1.5px)"></span></div>
    <span class="conf-v">${Math.round(n * 100)}%</span>
  </div>`;
}

export function chips(items) {
  return (items || []).map((c) =>
    h`<span class="chip ${c.tone ? "chip--" + c.tone : ""}">
      ${c.icon ? raw(icon(c.icon)) : ""}${c.label}</span>`
  ).join("");
}

/**
 * 内部工具标识 → 用户能看懂的一句话。
 *
 * 键必须与后端 `ai/agents/tool_registry.py` 的工具名逐字一致（改键会让界面退化成
 * 「处理数据」），值是用户语言。界面上永远只出现值，不出现键。
 */
const TOOL_TEXT = {
  get_course_overview: "查看课程信息",
  get_course_assignments: "查看作业清单",
  retrieve_course_material: "查找课程资料",
  get_my_grades: "查看我的成绩",
  get_my_submissions: "查看我的提交",
  analyze_learning_gaps: "找出薄弱知识点",
  generate_learning_plan: "制定学习计划",
  get_course_statistics: "查看课程统计",
  send_notification: "发送通知",
  publish_assignment: "发布作业",
  submit_assignment: "提交作业",
};

/** 把工具标识翻译成用户语言；未知标识兜底成一句中性描述，绝不原样显示。 */
export function toolText(name) {
  return TOOL_TEXT[String(name || "")] || "处理数据";
}

/**
 * 识别能力的内部标识 → 用户能看懂的用途名。
 * 键与后端模型注册表的 capability 枚举逐字一致；界面上只出现值。
 */
const CAPABILITY_TEXT = {
  vision: "图像识别",
  ocr: "文字识别",
  llm: "语言理解",
  embedding: "语义理解",
  retrieval: "资料检索",
  rerank: "结果排序",
};

/** 把能力标识翻译成用户语言；未知标识兜底成中性描述，绝不原样显示英文枚举。 */
export function capabilityText(name) {
  return CAPABILITY_TEXT[String(name || "")] || "识别能力";
}

/** 场景标识 → 用户语言。取值与后端 /api/vision/scenes 返回的 label 保持一致。 */
const SCENE_TEXT = {
  classroom: "课堂行为识别",
  lab_safety: "实验室安全与违规识别",
  exam_proctor: "考试监考",
  paper_grading: "拍照批改",
};

/** 把场景标识翻译成用户语言。后端字段（scene）是机器标识，界面上永远只出现这句。 */
export function sceneText(scene) {
  return SCENE_TEXT[String(scene || "")] || "其他场景";
}

/** 角色标识 → 用户语言（用于「通知谁」这类列表）。 */
const ROLE_TEXT = { ADMIN: "管理员", TEACHER: "教师", STUDENT: "学生" };

/** 把 "TEACHER,ADMIN" 这类角色串翻译成「教师、管理员」。 */
export function rolesText(roles) {
  const list = String(roles || "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.map((r) => ROLE_TEXT[r] || "相关人员").join("、") || "—";
}

/**
 * 处理状态 → 用户语言。
 * 后端各任务接口的 `status` 是英文枚举（succeeded / running / pending…），
 * 直接 `badge(t.status)` 会把英文塞到表格里 —— 用户读不懂「succeeded」，
 * 也不知道自己该做什么。未知取值兜底成中性描述，绝不透传原文。
 */
const STATUS_TEXT = {
  succeeded: "已完成", success: "已完成", completed: "已完成", done: "已完成",
  failed: "未成功", error: "未成功",
  running: "处理中", processing: "处理中",
  pending: "排队中", queued: "排队中",
  canceled: "已取消", cancelled: "已取消",
};

export function statusText(status) {
  return STATUS_TEXT[String(status || "").toLowerCase()] || "处理中";
}

/** 状态对应的语气色：成功→绿、失败→红、进行中→中性。 */
export function statusTone(status) {
  const k = String(status || "").toLowerCase();
  if (k === "succeeded" || k === "success" || k === "completed" || k === "done") return "ok";
  if (k === "failed" || k === "error") return "danger";
  return null;
}

/* ---------------- 接口字段 → 用户语言 ---------------- */

/**
 * 字段名 / 指标名 / 组件名 → 用户看得懂的说法。
 *
 * 为什么必须有这一层
 * ------------------
 * `kit.renderData()` 是「任何形状的数据都能读」的通用渲染器 —— 它的做法是拿**键名**
 * 当标签。后端字段是机器命名（totalUsers / event_type / storage_usage_ratio），
 * 一旦它被通用渲染器接住就直接上屏，用户看到的是代码而不是自己的数据。
 * 这类泄漏最阴的地方在于：它是**从数据里长出来的**，静态扫源码一个字都扫不到。
 *
 * 策略是**白名单**：这里没登记的字段一律不渲染。
 * 宁可少显示一项，也不把内部命名糊到界面上 —— 逐个补词表永远追不上后端新增字段，
 * 而白名单的反面（漏登记）表现为「少显示」，比「泄漏内部命名」安全得多。
 * 后端新增字段时，在这里补一行即可。
 */
const FIELD_TEXT = {
  // 总览类
  taskTotal: "识别任务", eventTotal: "事件", unacknowledged: "待确认",
  eventBySeverity: "按严重程度", taskByStatus: "按处理状态", scenes: "场景",
  unreadNotifications: "未读通知", placeholdersInUse: "示例内容",
  courseCount: "课程", assignmentCount: "作业", submissionCount: "提交",
  gradedCount: "已批改", pendingCount: "待批改", scanTaskCount: "拍照批改",
  scanPendingCount: "待批改的拍照作业", averageScore: "平均分",
  visionBackend: "识别来源", visionIsPlaceholder: "识别来源为示例",
  // 平台概况
  totalUsers: "账号总数", totalStudents: "学生", totalTeachers: "教师",
  totalCourses: "课程", totalEnrollments: "选课", todayActiveUsers: "今日活跃",
  weeklyNewCourses: "本周新增课程", weeklyNewUsers: "本周新增账号",
  pendingReviewCount: "待处理", todoItems: "待办", topCourses: "活跃课程",
  recentVisits: "最近访问", roleDistribution: "账号构成", activities: "最近动态",
  // 运行监控
  resourceMetrics: "资源占用", dbMetrics: "数据存储", status: "状态",
  uptime: "已运行", resourceTrend: "资源变化", serviceTrend: "服务变化",
  errorStats: "异常统计", alerts: "用量提醒", healthReport: "运行报告",
  labels: "时间", successRate: "成功率", responseTime: "响应时间",
  qps: "每秒请求数", types: "类型", score: "评分",
  abnormalItems: "异常项", services: "服务",
  // 组件自检（/api/health）
  project: "平台名称", version: "版本", aiAvailable: "识别能力可用",
  checks: "组件自检", database: "数据存储", aiRoutes: "识别服务",
  llm: "语言理解", embeddings: "语义理解", vectorStore: "资料检索",
  modelRegistry: "识别能力",
  // 操作记录（details 是后端原始 JSON，故意不登记：它绝不该直接上屏）
  id: "序号", action: "操作", username: "账号",
  role: "身份", ipAddress: "来源地址", timestamp: "时间",
  // 通用列名：多个接口的数组元素共用这几个键（topCourses / roleDistribution / *Metrics）
  name: "名称", value: "数量", threshold: "警戒线", alert: "是否超限",
  key: "项目", teacher: "任课教师", level: "等级", severity: "等级",
};

/** 字段名 → 用户语言；未登记返回空串（调用方据此跳过该字段）。 */
export function fieldText(key) {
  return FIELD_TEXT[String(key || "")] || "";
}

/** 指标 / 组件标识 → 用户语言（monitor 的 *_Metrics[].name、health 的 services[].name）。 */
const METRIC_TEXT = {
  active_user_ratio: "在线用户占比", pending_submission_ratio: "待批改占比",
  storage_usage_ratio: "存储占用", recent_upload_ratio: "近期上传",
  submission_activity: "提交活动", upload_activity: "上传活动",
  users: "账号数", audit_logs_24h: "24 小时操作记录", storage_mb: "存储占用",
  api: "平台服务", database: "数据存储", notification: "消息推送", storage: "文件存储",
  // serviceTrend 的每一路序列名
  success_rate: "成功率", successRate: "成功率",
  response_time: "响应时间", responseTime: "响应时间", qps: "每秒请求数",
};

/** 指标 / 组件标识 → 用户语言；未登记返回「其他项」。 */
export function metricText(name) {
  return METRIC_TEXT[String(name || "")] || "其他项";
}

/** 服务状态 → 用户语言（ok / up / placeholder / error …）。 */
const HEALTH_TEXT = {
  ok: "正常", up: "正常", healthy: "正常",
  warn: "需留意", warning: "需留意",
  error: "异常", down: "不可用",
  placeholder: "试用中",
};

/** 服务状态 → 用户语言；未登记返回「未知」，绝不透传英文枚举。 */
export function healthText(status) {
  return HEALTH_TEXT[String(status || "").toLowerCase()] || "未知";
}

/** 操作记录的动作标识 → 用户语言。后端新增动作类型时在这里补一行。 */
const ACTION_TEXT = { FILE_UPLOAD: "上传文件", LOGIN: "登录", LOGOUT: "退出登录" };

/** 操作标识 → 用户语言；未登记返回中性的「操作」。 */
export function actionText(action) {
  return ACTION_TEXT[String(action || "")] || "操作";
}

/** 提醒等级 → 用户语言（info / warn / critical …）。 */
const LEVEL_TEXT = {
  info: "记录", notice: "提醒", warn: "关注", warning: "关注",
  critical: "严重", error: "严重", fatal: "严重",
};

/** 提醒等级 → 用户语言；未登记返回中性的「提醒」。 */
export function levelText(level) {
  return LEVEL_TEXT[String(level || "").toLowerCase()] || "提醒";
}

/** 提醒处置状态 → 用户语言（OPEN / RESOLVED …）。 */
export function alertStateText(state) {
  const k = String(state || "").toUpperCase();
  if (!k) return "—";
  return k === "OPEN" ? "待处理" : "已处理";
}

/** 动作芯片（含状态点）：只显示用户语言，不显示内部标识 */
export function toolChip(label, stateLabel, tone) {
  return h`<span class="chip ${tone ? "chip--" + tone : ""}">
    <span class="dot ${tone === "ok" ? "dot--ok" : tone === "fail" ? "dot--danger" : tone === "run" ? "dot--scan dot--pulse" : ""}"></span>
    <span>${label}</span>${stateLabel ? h`<span class="dim">${stateLabel}</span>` : ""}</span>`;
}

export function taskRow(o) {
  const state = o.state || "done";
  const ico = state === "run" ? "refresh" : state === "fail" ? "x-circle" : state === "wait" ? "clock" : "check-circle";
  return h`<div class="task-row is-${state === "run" ? "run" : state === "fail" ? "fail" : "done"}">
    <span class="tr-ico">${raw(icon(ico))}</span>
    <span class="tr-txt">${raw(o.text)}</span>
    ${o.time ? h`<span class="tr-time num">${o.time}</span>` : ""}
  </div>`;
}

/** 思考轨迹：可展开的推理过程（默认折叠，避免噪声） */
export function thinkTrace(o) {
  const steps = (o.steps || []).map((s, i) =>
    h`<div class="think-step ${i === (o.steps.length - 1) ? "is-last" : ""}">${raw(s)}</div>`
  ).join("");
  return h`<div class="think" data-think>
    <div class="think-hd" data-think-toggle>
      ${raw(icon("sparkles"))}
      <span class="tt">${o.title || "它是怎么想的"}</span>
      <span class="tm">${o.meta || (o.steps ? o.steps.length + " 步" : "")}</span>
      <span class="caret">${raw(icon("chevron-right"))}</span>
    </div>
    <div class="think-body" hidden>${raw(steps || emptyState({ icon: "info", title: "没有可展示的步骤" }))}</div>
  </div>`;
}

/** 审批卡：AI 拟动作前必须停下等人确认 */
export function approvalCard(o) {
  return h`<div class="approval" data-approval>
    <div class="approval-hd">${raw(icon("shield-check"))}<span>需要你确认</span></div>
    <div class="approval-q">${o.question}</div>
    ${o.desc ? h`<div class="approval-d">${raw(o.desc)}</div>` : ""}
    <div class="approval-acts">
      <button class="btn btn--signal btn--sm" type="button" data-approve>${raw(icon("check"))}${o.okText || "采纳并继续"}</button>
      ${o.altText ? h`<button class="btn btn--outline btn--sm" type="button" data-alternate>${o.altText}</button>` : ""}
      <button class="btn btn--ghost btn--sm" type="button" data-skip>${o.skipText || "跳过"}</button>
    </div>
  </div>`;
}

export function kv(pairs) {
  return h`<dl class="kv">${raw((pairs || []).flatMap((p) =>
    [h`<dt>${p[0]}</dt>`, h`<dd>${raw(p[1])}</dd>`]
  ).join(""))}</dl>`;
}

export function bars(cols, opts) {
  const o = opts || {};
  const list = cols || [];
  const values = list.map((c) => Number(c.value) || 0);
  const max = Math.max.apply(null, [1].concat(values));
  // 只在"确有高低差"时标出峰值：所有柱同高时全刷成信号色会变成一堵黄墙，
  // 反而看不出重点（信号色只留给真正被挑出来的那一个）。
  const hasSpread = values.some((v) => v < max);
  const peak = values.indexOf(max);
  return h`<div class="bars" style="${o.height ? "height:" + o.height + "px" : ""}">
    ${raw(list.map((c, i) => {
      const v = values[i];
      const hp = Math.round((v / max) * 100);
      const hot = c.max || (hasSpread && i === peak && v > 0);
      return h`<div class="bar-col ${hot ? "is-max" : ""}" title="${c.label}：${v}">
        <span class="bv num">${c.display == null ? v : c.display}</span>
        <span class="bk"><i style="height:${hp}%"></i></span>
        <span class="bl">${c.label}</span>
      </div>`;
    }).join(""))}
  </div>`;
}

/** 表格：columns=[{k,t,sort,w}], rows=[[cellHtml,…]] */
export function table(o) {
  const cols = o.columns || [];
  const head = cols.map((c) =>
    h`<th ${c.sort ? raw('data-sort="' + c.k + '"') : ""} ${c.w ? raw('style="width:' + c.w + '"') : ""}>${c.t}</th>`
  ).join("");
  const rows = (o.rows || []).map((r) =>
    h`<tr ${r.__attrs ? raw(r.__attrs) : ""}>${raw((r.cells || r).map((c) => h`<td>${raw(c)}</td>`).join(""))}</tr>`
  ).join("");
  if (!rows) {
    return emptyState({ icon: o.emptyIcon || "table", title: o.emptyTitle || "没有记录", desc: o.emptyDesc });
  }
  return h`<div class="tbl-wrap"><table class="tbl ${o.zebra === false ? "" : "tbl--zebra"}">
    <thead><tr>${raw(head)}</tr></thead><tbody>${raw(rows)}</tbody></table></div>`;
}

export function timeline(items) {
  if (!items || !items.length) return emptyState({ icon: "clock", title: "时间轴为空" });
  return h`<div class="timeline">${raw(items.map((it) =>
    h`<div class="tl-item ${it.tone ? "sev-" + it.tone : ""} ${it.done ? "is-done" : ""}">
      <div class="tl-meta">${it.time ? h`<span class="num">${it.time}</span>` : ""}${raw(it.meta || "")}</div>
      <div class="tl-title">${raw(it.title)}</div>
      ${it.desc ? h`<div class="tl-desc">${raw(it.desc)}</div>` : ""}
      ${it.body ? h`<div class="tl-body">${raw(it.body)}</div>` : ""}
    </div>`).join(""))}</div>`;
}

export function loading(text) {
  return h`<div class="center-spin"><span class="spinner"></span>${text ? h`<span class="t-sm muted" style="margin-left:10px">${text}</span>` : ""}</div>`;
}

/* 折叠轨迹的全局委托（一次绑定，处理所有 [data-think-toggle]） */
export function bindThinkToggles(root) {
  const scope = root || document;
  if (scope.__thinkBound) return;
  scope.__thinkBound = true;
  scope.addEventListener("click", (e) => {
    const hd = e.target.closest("[data-think-toggle]");
    if (!hd) return;
    const box = hd.closest("[data-think]");
    const body = box && box.querySelector(".think-body");
    if (!body) return;
    body.hidden = !body.hidden;
    box.classList.toggle("is-open", !body.hidden);
  });
}

/* 数字滚动：只在首次进入时跑一次，尊重 reduced-motion */
export function runCounters(root) {
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  $$("[data-count]", root || document).forEach((el) => {
    const target = Number(el.getAttribute("data-count"));
    if (Number.isNaN(target) || reduce || el.__counted) return;
    el.__counted = true;
    const dur = 520, t0 = performance.now();
    function step(t) {
      const p = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      const v = target * eased;
      el.textContent = Number.isInteger(target) ? num(Math.round(v)) : v.toFixed(2);
      if (p < 1) requestAnimationFrame(step);
      else el.textContent = Number.isInteger(target) ? num(target) : target.toFixed(2);
    }
    el.textContent = "0";
    requestAnimationFrame(step);
  });
}

/* ================= B. 浮层控制器 ================= */

const stack = [];

export function toast(message, kind) {
  let wrap = $(".toast-wrap");
  if (!wrap) { wrap = document.createElement("div"); wrap.className = "toast-wrap"; document.body.appendChild(wrap); }
  const ico = kind === "ok" || kind === "success" ? "check-circle" : kind === "err" || kind === "error" ? "x-circle" : "info";
  const el = document.createElement("div");
  el.className = "toast is-" + (kind === "ok" || kind === "success" ? "ok" : kind === "err" || kind === "error" ? "err" : "info");
  el.innerHTML = icon(ico) + "<span>" + esc(message) + "</span>";
  wrap.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transform = "translateY(6px)"; }, 2600);
  setTimeout(() => el.remove(), 3100);
}

function makeOverlay(kind, onClose) {
  const ov = document.createElement("div");
  ov.className = "overlay";
  ov.addEventListener("click", () => close());
  document.body.appendChild(ov);
  requestAnimationFrame(() => ov.classList.add("is-on"));
  const entry = { ov, kind };
  function close() {
    ov.classList.remove("is-on");
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
    onClose && onClose();
    setTimeout(() => ov.remove(), 250);
  }
  entry.close = close;
  stack.push(entry);
  return entry;
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && stack.length) stack[stack.length - 1].close();
});

export function drawer(o) {
  const opts = o || {};
  const panel = document.createElement("div");
  panel.className = "drawer";
  panel.innerHTML = h`<div class="drawer-panel">
    <div class="drawer-hd">
      <div>
        <div class="drawer-t">${opts.title || ""}</div>
        ${opts.sub ? h`<div class="plate-sub">${opts.sub}</div>` : ""}
      </div>
      <span class="spacer"></span>
      <button class="btn btn--ghost btn--icon btn--sm" type="button" data-close aria-label="关闭">${raw(icon("x"))}</button>
    </div>
    <div class="drawer-bd" data-body></div>
    ${opts.footer ? h`<div class="drawer-ft">${raw(opts.footer)}</div>` : ""}
  </div>`;

  const overlay = document.createElement("div");
  overlay.className = "overlay";
  document.body.appendChild(overlay);
  document.body.appendChild(panel);
  requestAnimationFrame(() => { overlay.classList.add("is-on"); panel.classList.add("is-on"); });

  const entry = { ov: overlay, kind: "drawer" };
  function close() {
    overlay.classList.remove("is-on"); panel.classList.remove("is-on");
    const i = stack.indexOf(entry); if (i >= 0) stack.splice(i, 1);
    document.removeEventListener("keydown", key);
    opts.onClose && opts.onClose();
    setTimeout(() => { overlay.remove(); panel.remove(); }, 280);
  }
  function key(e) { if (e.key === "Escape") close(); }
  entry.close = close;
  stack.push(entry);
  document.addEventListener("keydown", key);
  overlay.addEventListener("click", close);
  panel.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));

  const body = panel.querySelector("[data-body]");
  if (opts.body) body.innerHTML = opts.body;
  opts.mount && opts.mount(body, close);
  return { close, body, panel };
}

export function modal(o) {
  const opts = o || {};
  const wrap = document.createElement("div");
  wrap.className = "modal" + (opts.wide ? " modal--wide" : "");
  wrap.innerHTML = h`<div class="modal-panel" role="dialog" aria-modal="true">
    <div class="modal-hd">
      <div class="modal-t">${opts.title || ""}</div>
      <span class="spacer"></span>
      <button class="btn btn--ghost btn--icon btn--sm" type="button" data-close aria-label="关闭">${raw(icon("x"))}</button>
    </div>
    <div class="modal-bd" data-body></div>
    ${opts.footer ? h`<div class="modal-ft">${raw(opts.footer)}</div>` : ""}
  </div>`;

  const overlay = document.createElement("div");
  overlay.className = "overlay";
  document.body.appendChild(overlay);
  document.body.appendChild(wrap);
  requestAnimationFrame(() => { overlay.classList.add("is-on"); wrap.classList.add("is-on"); });

  const entry = { ov: overlay, kind: "modal" };
  function close() {
    overlay.classList.remove("is-on"); wrap.classList.remove("is-on");
    const i = stack.indexOf(entry); if (i >= 0) stack.splice(i, 1);
    opts.onClose && opts.onClose();
    setTimeout(() => { overlay.remove(); wrap.remove(); }, 250);
  }
  entry.close = close;
  stack.push(entry);
  overlay.addEventListener("click", close);
  wrap.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));

  const body = wrap.querySelector("[data-body]");
  if (opts.body) body.innerHTML = opts.body;
  opts.mount && opts.mount(body, close);
  return { close, body, panel: wrap.querySelector(".modal-panel") };
}

/** 气泡菜单：锚定到某个元素右下角 */
export function popover(anchor, html, opts) {
  const o = opts || {};
  const el = document.createElement("div");
  el.className = "menu";
  el.innerHTML = html;
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, hh = el.offsetHeight;
  let left = o.align === "left" ? r.left : r.right - w;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  let top = r.bottom + 6;
  if (top + hh > window.innerHeight - 8) top = Math.max(8, r.top - hh - 6);
  el.style.left = left + "px";
  el.style.top = top + "px";

  function close() { el.remove(); document.removeEventListener("mousedown", away); document.removeEventListener("keydown", key); }
  function away(e) { if (!el.contains(e.target)) close(); }
  function key(e) { if (e.key === "Escape") close(); }
  setTimeout(() => { document.addEventListener("mousedown", away); document.addEventListener("keydown", key); }, 0);
  el.addEventListener("click", (e) => {
    const item = e.target.closest("[data-act]");
    if (item) { o.onPick && o.onPick(item.getAttribute("data-act"), item); close(); }
  });
  return { close, el };
}

/** 命令面板：统一入口，支持模块跳转与动作 */
export function commandPalette(o) {
  const opts = o || {};
  const wrap = document.createElement("div");
  wrap.className = "palette";
  wrap.innerHTML = h`<div class="palette-panel">
    <div class="palette-in">${raw(icon("search"))}
      <input type="text" placeholder="搜索模块、能力或动作…" autocomplete="off" spellcheck="false">
      <span class="badge badge--ghost">Esc</span>
    </div>
    <div class="palette-list" data-list></div>
  </div>`;

  const entry = { ov: wrap, kind: "palette" };
  function close() {
    wrap.remove();
    const i = stack.indexOf(entry); if (i >= 0) stack.splice(i, 1);
    document.removeEventListener("keydown", key);
  }
  function key(e) { if (e.key === "Escape") close(); }
  entry.close = close;
  stack.push(entry);
  document.body.appendChild(wrap);
  document.addEventListener("keydown", key);

  const input = wrap.querySelector("input");
  const list = wrap.querySelector("[data-list]");
  let items = [], active = 0;

  function render() {
    const q = input.value.trim().toLowerCase();
    const hits = items.filter((it) => !q || (it.label + " " + (it.sub || "") + " " + (it.kw || "")).toLowerCase().indexOf(q) >= 0);
    const bySec = {};
    hits.forEach((it) => { (bySec[it.section || "结果"] = bySec[it.section || "结果"] || []).push(it); });
    let html = "", idx = 0;
    Object.keys(bySec).forEach((sec) => {
      html += h`<div class="palette-sec">${sec}</div>`;
      bySec[sec].forEach((it) => {
        const on = idx === active ? " is-on" : "";
        html += h`<div class="palette-item${on}" data-idx="${idx}">
          ${raw(icon(it.icon || "dot"))}<span>${it.label}</span>
          ${it.sub ? h`<span class="pi-sub">${it.sub}</span>` : ""}</div>`;
        idx++;
      });
    });
    list.innerHTML = html || h`<div class="palette-sec">没有匹配项</div>`;
    window.__paletteHits = hits;
  }

  function run() {
    const hits = window.__paletteHits || [];
    const it = hits[active];
    if (it) { close(); it.run && it.run(); }
  }

  input.addEventListener("input", () => { active = 0; render(); });
  input.addEventListener("keydown", (e) => {
    const hits = window.__paletteHits || [];
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(hits.length - 1, active + 1); render(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(0, active - 1); render(); }
    else if (e.key === "Enter") { e.preventDefault(); run(); }
  });
  list.addEventListener("click", (e) => {
    const it = e.target.closest("[data-idx]");
    if (it) { active = Number(it.getAttribute("data-idx")); run(); }
  });
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });

  items = opts.items || [];
  render();
  setTimeout(() => input.focus(), 0);
  return { close };
}

export { pct };
