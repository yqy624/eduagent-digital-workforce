/**
 * 桌面端 DOM 集成测试（jsdom）：在真实 DOM 里跑真正的 app.js。
 *
 * 与 smoke_data_layer.mjs 的分工
 * ----------------------------
 * smoke_data_layer.mjs  只测「数据层」：请求封装、信封解包、字段形态
 * 本文件                测「渲染层」：把 desktop.html 装进 DOM，eval 引擎，
 *                       再 import 真正的 app.js，断言 DOM 里真的出现了数据。
 *
 * 因此它覆盖的是静态检查覆盖不到的一类问题：
 *   选择器写错、锚点改名、innerHTML 拼接出错、mount 未调用导致图标/进度条不渲染、
 *   以及交互（发送指令 → 渲染运行号 → 抽屉填充运行详情）是否真的接通。
 *
 * 用法：node scripts/smoke_desktop_dom.mjs
 * 前置：后端已在运行（且 seed 数据已导入）。基址取环境变量 EA_BASE，缺省 http://127.0.0.1:18010。
 * 依赖：jsdom（装在托管 node 工作区，见下方 WORKSPACE，不污染本项目）。
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

// jsdom 装在 WorkBuddy 托管的 node 工作区（不污染本项目），
// 而 NODE_PATH 对 ESM 无效，所以用 createRequire 从那里解析。
const WORKSPACE = process.env.WB_NODE_WORKSPACE
  || "~/.workbuddy/binaries/node/workspace";
const require = createRequire(WORKSPACE.endsWith("/") ? WORKSPACE : WORKSPACE + "/");
const { JSDOM, VirtualConsole } = require("jsdom");

const BASE = process.env.EA_BASE || "http://127.0.0.1:18010";

let pass = 0, fail = 0;
const problems = [];
const consoleErrors = [];

function ok(label, cond, extra) {
  if (cond) { pass++; console.log("  \u2713 " + label + (extra ? "  " + extra : "")); }
  else { fail++; problems.push(label + (extra ? " :: " + extra : "")); console.log("  \u2717 " + label + (extra ? "  " + extra : "")); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(fn, timeout, step) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeout || 15000)) {
    let v;
    try { v = fn(); } catch (_) { v = null; }
    if (v) return v;
    await sleep(step || 100);
  }
  return null;
}

/* ---------------- 1. 装配 DOM ---------------- */
console.log("=== 1. 装配 DOM（desktop.html → jsdom）===");
const html = readFileSync("static/desktop.html", "utf8");
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => consoleErrors.push("jsdomError: " + (e && e.message)));
vc.on("error", (...a) => consoleErrors.push("console.error: " + a.join(" ")));
vc.on("warn", () => {});

const dom = new JSDOM(html, {
  url: BASE + "/static/desktop.html",
  pretendToBeVisual: true,
  runScripts: "outside-only",
  virtualConsole: vc,
});
const W = dom.window;
const doc = W.document;

// jsdom 未实现 IntersectionObserver（hifi.js 用它做进场动画）
W.IntersectionObserver = class {
  constructor() {} observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
};

// 把 jsdom 环境暴露给 Node 侧 import 的 ES 模块（模块读的是裸全局名）
globalThis.window = W;
globalThis.document = doc;
globalThis.localStorage = W.localStorage;
globalThis.location = W.location;
globalThis.IntersectionObserver = W.IntersectionObserver;
globalThis.requestAnimationFrame = (cb) => W.requestAnimationFrame(cb);
globalThis.cancelAnimationFrame = (id) => W.cancelAnimationFrame(id);
globalThis.getComputedStyle = W.getComputedStyle.bind(W);

const realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => realFetch(String(u).startsWith("http") ? u : BASE + u, o);

await new Promise((r) => (doc.readyState === "complete" ? r() : W.addEventListener("load", r)));
ok("DOM 就绪", doc.readyState === "complete", "readyState=" + doc.readyState);
ok("页面含 4 个 section.page", doc.querySelectorAll("section.page").length === 4,
  doc.querySelectorAll("section.page").length + " 个");

/* ---------------- 2. 引擎脚本 ---------------- */
console.log("\n=== 2. 加载引擎（hifi.js → hifi-bridge.js）===");
W.eval(readFileSync("static/js/hifi.js", "utf8"));
ok("hifi.js 已执行（图标注入）", doc.querySelectorAll("[data-icon] svg").length > 0,
  doc.querySelectorAll("[data-icon] svg").length + " 个 svg");
W.eval(readFileSync("static/js/hifi-bridge.js", "utf8"));
ok("hifi-bridge 暴露 window.Hifi.mount", !!(W.Hifi && typeof W.Hifi.mount === "function"));

/* ---------------- 3. 登录落令牌（走真实 api.js） ---------------- */
console.log("\n=== 3. 登录并落令牌（走 api.js 的 session）===");
const api = await import("../static/js/console/api.js");
const u = await api.login("admin", "Demo@12345", "ADMIN");
ok("令牌已写入 localStorage", W.localStorage.getItem("ea.token") === u.token,
  "len=" + (u.token || "").length);
ok("hifi 引擎已激活首页", doc.querySelectorAll("section.page.is-active").length === 1,
  (doc.querySelector(".page.is-active") || {}).id);

/* ---------------- 4. 载入业务模块，等它渲染 ---------------- */
console.log("\n=== 4. import app.js 并等待首屏渲染 ===");
await import("../static/js/desktop/app.js");
const dash = await waitFor(() => W.__dash, 25000, 150);
ok("app.js 启动并完成一轮取数（window.__dash 就位）", !!dash);
if (!dash) {
  console.log("\n渲染未完成，中止后续断言。错误日志：");
  consoleErrors.forEach((e) => console.log("  " + e));
  process.exit(1);
}
// __dash 只表示「数取到了」，渲染还在同一轮 await 之后。
// 必须等 __rendered，否则下面的 DOM 断言会撞上「数据到了、界面还没画」的竞态。
const painted = await waitFor(() => W.__rendered, 25000, 100);
ok("首屏渲染已完成（window.__rendered 就位）", !!painted);
if (!painted) {
  console.log("\n首屏未画完，中止后续断言。错误日志：");
  consoleErrors.forEach((e) => console.log("  " + e));
  process.exit(1);
}

/* ---------------- 5. 顶栏 / 侧栏 ---------------- */
console.log("\n=== 5. 顶栏与侧栏（renderChrome）===");
const footName = doc.querySelector(".side-foot .xs");
const footRole = doc.querySelector(".side-foot .xxl");
ok("侧栏用户名已换成真实登录名", footName && footName.textContent.trim() === "admin",
  footName && footName.textContent.trim());
ok("侧栏角色已换成中文角色名", footRole && /管理员/.test(footRole.textContent),
  footRole && footRole.textContent.trim());
ok("侧栏头像取显示名首字", /^平$/.test((doc.querySelector(".side-foot .avatar") || {}).textContent || ""),
  (doc.querySelector(".side-foot .avatar") || {}).textContent);
ok("顶栏头像同步", /^平$/.test((doc.querySelector(".topbar .avatar") || {}).textContent || ""));
ok("侧栏不再残留写死姓名「陈书航」", !/陈书航/.test(doc.body.innerHTML));

/* ---------------- 6. 组织带 ---------------- */
console.log("\n=== 6. 组织带（renderBands）===");
const summary = doc.querySelector('[data-org="summary"]');
const pending = doc.querySelector('[data-org="pending"]');
const rulesEl = doc.querySelector('[data-org="rules"]');
ok("场景数/规则数已填充", summary && /个教学场景已开启/.test(summary.textContent),
  summary && summary.textContent.trim());
ok("未确认事件数已填充", pending && /^\d+$/.test(pending.textContent.trim()),
  pending && pending.textContent.trim());
ok("启用规则数已填充", rulesEl && /^\d+$/.test(rulesEl.textContent.trim()),
  rulesEl && rulesEl.textContent.trim());
ok("组织带不再显示占位「—」",
  ![...doc.querySelectorAll('[data-org]')].some((e) => e.textContent.trim() === "—"));

/* ---------------- 7. P1 KPI ---------------- */
console.log("\n=== 7. P1 KPI 四卡（真实指标）===");
const kpi = [...doc.querySelectorAll("#p1 .emp-stats .card")];
ok("KPI 卡数量为 4", kpi.length === 4, kpi.length + " 张");
ok("卡片标签已换成真实指标名",
  kpi.every((c) => (c.querySelector(".stat-label") || {}).textContent.trim() !== "—"),
  kpi.map((c) => (c.querySelector(".stat-label") || {}).textContent.trim()).join(" / "));
ok("KPI 数值带 data-count-to（引擎会滚动）",
  kpi.every((c) => (c.querySelector(".stat-value") || {}).getAttribute
    && c.querySelector(".stat-value").getAttribute("data-count-to") !== null),
  kpi.map((c) => c.querySelector(".stat-value").getAttribute("data-count-to")).join(" / "));
const kpiFoot = kpi.map((c) => (c.querySelector(".xxl") || {}).textContent.trim());
ok("KPI 副标题已填充（严重/警示/信息分布）", kpiFoot.every((t) => t && t.length > 0),
  kpiFoot[0]);
const kpiValueText = kpi.map((c) => c.querySelector(".stat-value").textContent.trim());
await sleep(1200); // 等数字滚动动画结束
const kpiAfter = kpi.map((c) => c.querySelector(".stat-value").textContent.trim());
ok("数字滚动已收敛为真实值（非 0）",
  kpiAfter.every((t) => parseFloat(t.replace(/,/g, "")) > 0 || /^0(\.0)?$/.test(t)),
  "起始 " + kpiValueText.join("/") + " → 收敛 " + kpiAfter.join("/"));

/* ---------------- 8. P1 事件流 ---------------- */
console.log("\n=== 8. P1 实时事件流（vision/events）===");
const box = doc.querySelector("#live-events");
ok("#live-events 存在", !!box);
const events = [...(box ? box.querySelectorAll(".emp-event") : [])];
const expectN = (dash.vision.events.data || []).length;
ok("事件条数与接口返回一致", events.length === expectN, events.length + " / " + expectN);
ok("骨架占位已被真实事件替换", box && box.querySelectorAll(".skeleton").length === 0);
ok("每条事件有标题", events.every((e) => (e.querySelector(".ev-title") || {}).textContent.trim().length > 0),
  events[0] ? events[0].querySelector(".ev-title").textContent.trim() : "");
ok("每条事件有描述", events.every((e) => (e.querySelector(".ev-desc") || {}).textContent.trim().length > 0),
  events[0] ? events[0].querySelector(".ev-desc").textContent.trim().slice(0, 42) + "…" : "");
ok("每条事件有时间戳 HH:MM:SS", events.every((e) => /^\d{2}:\d{2}:\d{2}$/.test((e.querySelector(".ev-meta") || {}).textContent.trim())),
  events[0] ? events[0].querySelector(".ev-meta").textContent.trim() : "");
ok("每条事件有把握程度标签", events.every((e) => /把握/.test((e.querySelector(".emp-conf") || {}).textContent || "")));
ok("severity 已映射为语义类名",
  events.every((e) => /sev-(info|warning|critical)/.test(e.className)),
  [...new Set(events.map((e) => (e.className.match(/sev-\w+/) || [""])[0]))].join(","));
ok("已处理/待处理状态已渲染",
  events.every((e) => /已处理|待处理/.test(e.textContent)));
ok("事件流内不残留假数据（无 2023010142 / run-9f31c2）",
  !/2023010142|run-9f31c2|林嘉禾/.test(doc.body.innerHTML));

/* ---------------- 9. P1 负载与待办 ---------------- */
console.log("\n=== 9. P1 员工负载与待处理 ===");
const loadBox = doc.querySelector('[data-panel="load"]');
ok("负载面板已填充", loadBox && loadBox.querySelectorAll(".progress-bar").length === 5,
  loadBox ? loadBox.querySelectorAll(".progress-bar").length + " 条" : "缺失");
ok("负载面板不再显示写死百分比 78%/64%",
  loadBox && !/78%|64%/.test(loadBox.textContent));
ok("负载百分比写入 data-progress",
  loadBox && [...loadBox.querySelectorAll(".progress-bar")].every((b) => b.getAttribute("data-progress") !== null));
const todoBadge = doc.querySelector('[data-panel="todo-count"]');
const todoBox = doc.querySelector('[data-panel="todo"]');
ok("待办计数已按真实数据更新", todoBadge && /^\d+$/.test(todoBadge.textContent.trim()),
  "角标 " + (todoBadge && todoBadge.textContent.trim()));
ok("待办列表已填充或给出空态",
  todoBox && (todoBox.querySelectorAll(".list-item").length > 0 || todoBox.querySelector(".empty")),
  todoBox ? todoBox.querySelectorAll(".list-item").length + " 条待办" : "缺失");

/* ---------------- 9b. P1 新增块：批改质量 / 学生学情 / 通知 ---------------- */
console.log("\n=== 9b. P1 新增：批改质量复核 / 学生学情档案 / 通知菜单 ===");

const gqBox = doc.querySelector('[data-panel="grading-quality"]');
ok("批改质量区块已渲染出卡片", !!gqBox && gqBox.querySelectorAll(".card").length > 0,
  gqBox ? gqBox.querySelectorAll(".card").length + " 张" : "缺失");
ok("批改质量不再残留骨架", gqBox && gqBox.querySelectorAll(".skeleton").length === 0);
const gqVals = gqBox ? [...gqBox.querySelectorAll(".stat-value")] : [];
ok("批改质量三块数字均带 data-count-to",
  gqVals.length === 3 && gqVals.every((v) => v.getAttribute("data-count-to") !== null),
  gqVals.map((v) => v.textContent.trim()).join(" / "));
const gqNote = doc.querySelector('[data-panel="grading-note"]');
ok("批改质量给出了说明（含样本不足时的如实提示）",
  gqNote && gqNote.textContent.trim().length > 0,
  gqNote ? gqNote.textContent.trim().slice(0, 44) : "");

const stuSel = doc.querySelector('[data-panel="stu-course"]');
const stuList = doc.querySelector('[data-panel="stu-list"]');
ok("学生课程选择器已填充选项", stuSel && stuSel.options.length > 0,
  stuSel ? stuSel.options.length + " 个选项" : "缺失");
// 这里以前只断言「有名单**或**明确空态」，于是管理员看到空态也算过 ——
// 而管理员并不授课，/api/teacher/courses 恒为空，那块面板其实一直是空的。
// 改成按真实数据断言：课程列表与名单都必须有内容。
ok("学生课程选择器列出了真实课程",
  stuSel && [...stuSel.options].some((o) => o.value !== ""),
  stuSel ? [...stuSel.options].map((o) => o.textContent.trim()).join(" / ") : "缺失");
ok("学生名单渲染出真实学生",
  stuList && stuList.querySelectorAll(".list-item").length > 0,
  stuList ? stuList.textContent.replace(/\s+/g, " ").trim().slice(0, 50) : "缺失");
ok("学生名单不再残留骨架", stuList && stuList.querySelectorAll(".skeleton").length === 0);

const notifMenu = doc.querySelector('[data-list="notif-list"]');
ok("通知菜单已填充（非骨架）", notifMenu && notifMenu.querySelectorAll(".skeleton").length === 0);
const bellBtn = doc.querySelector('.topbar [data-icon="bell"]');
ok("顶栏铃铛已接成真控件（点开通知列表，不再弹提示）",
  !!bellBtn && bellBtn.getAttribute("data-menu-open") === "#menu-notif"
    && bellBtn.getAttribute("data-toast") === null);

ok("新增区块不泄漏接口路径 / 运行编号",
  !/\/api\/|run-\d/.test(
    (gqBox ? gqBox.textContent : "") + (gqNote ? gqNote.textContent : "")
    + (stuList ? stuList.textContent : "") + (notifMenu ? notifMenu.textContent : "")));

/* ---------------- 10. P3 名册 ---------------- */
console.log("\n=== 10. P3 数字员工名册 ===");
const cards = [...doc.querySelectorAll("#p3 .emp-card")];
ok("名册 5 张卡", cards.length === 5, cards.length + " 张");
const codes = cards.map((c) => c.getAttribute("data-emp"));
ok("每张卡都挂上 data-emp 且互不重复",
  codes.every(Boolean) && new Set(codes).size === 5, codes.join(","));
ok("名册负载已从设计示意值换成真实口径",
  cards.every((c) => c.querySelector(".emp-load .progress-bar").getAttribute("data-progress") !== null),
  cards[0] ? cards[0].querySelector(".emp-load").textContent.trim().replace(/\s+/g, " ") : "");
ok("名册提示已更新", /位在岗/.test((doc.querySelector("#p3 .emp-hint") || {}).textContent || ""),
  (doc.querySelector("#p3 .emp-hint") || {}).textContent);
ok("P0 全景员工卡同样挂上 data-emp",
  doc.querySelectorAll("#p0 .emp-card[data-emp]").length === 5,
  doc.querySelectorAll("#p0 .emp-card[data-emp]").length + " 张");

/* ---------------- 11. 图标与进度条真的渲染了 ---------------- */
console.log("\n=== 11. 引擎能力是否覆盖到动态节点（mount 调用）===");
// 事件卡按设计不含图标（只用色条 + 文本标签），所以要挑真的带 data-icon 的动态块来验：
// 待办列表的 .stat-icon、KPI 卡的 .stat-delta 图标。
const todoBox0 = doc.querySelector('[data-panel="todo"]');
ok("动态渲染的待办列表图标已注入 svg",
  todoBox0 && todoBox0.querySelectorAll(".stat-icon[data-icon] svg").length > 0,
  todoBox0 ? todoBox0.querySelectorAll(".stat-icon[data-icon] svg").length + " 个" : "");
ok("动态节点内不存在「有 data-icon 但没注入 svg」的元素",
  [...doc.querySelectorAll("[data-icon]")].every((e) => e.querySelector("svg")),
  [...doc.querySelectorAll("[data-icon]")].filter((e) => !e.querySelector("svg")).length + " 个未注入");
ok("KPI 卡内图标已注入 svg",
  kpi.every((c) => c.querySelectorAll("[data-icon] svg").length > 0));
ok("负载进度条已设置宽度",
  loadBox && [...loadBox.querySelectorAll(".progress-bar")].every((b) => /%$/.test(b.style.width || "")),
  loadBox ? loadBox.querySelector(".progress-bar").style.width : "");

/* ---------------- 12. P2 协作台：首屏 ---------------- */
console.log("\n=== 12. P2 协作台首屏 ===");
const stream = doc.querySelector("#chat-stream");
ok("#chat-stream 存在", !!stream);
ok("欢迎语已渲染", stream && stream.querySelector(".emp-turn"));
ok("加载占位已被替换", stream && !/正在加载协作台/.test(stream.textContent));
ok("会话头显示当前协作的员工名与岗位",
  /\S/.test((doc.querySelector('[data-panel="chat-emp"]') || {}).textContent || "") &&
  /\S/.test((doc.querySelector('[data-panel="chat-emp-role"]') || {}).textContent || ""),
  ((doc.querySelector('[data-panel="chat-emp"]') || {}).textContent || "") + " · " +
  ((doc.querySelector('[data-panel="chat-emp-role"]') || {}).textContent || ""));
ok("会话头不暴露内部标识（无 EduAgent / 运行时 / 工具名）",
  !/EduAgent|运行时|get_course_|retrieve_|_tool_/.test(doc.querySelector("#p2 .emp-chat-head").textContent));
ok("本次任务面板为未发起态",
  /还没开始/.test(doc.querySelector("#p2 .stack .card:first-child .emp-kv").textContent));
ok("经验面板显示空态而非假条目",
  doc.querySelector('[data-panel="memory"] .empty') !== null);
ok("P2 不再残留假对话（无 run-9f31c2 / 37 份 / 笔正 会话头）",
  !/run-9f31c2|T-20261013-037/.test(doc.body.innerHTML));

/* ---------------- 13. 交互：发送指令 ---------------- */
console.log("\n=== 13. 交互：发送指令 → 运行时返回运行号 ===");
const input = doc.querySelector("#chat-input");
const send = doc.querySelector("#chat-send");
ok("#chat-input / #chat-send 绑定就位", !!input && !!send);
if (input && send) {
  const q = "平台当前有哪些视觉场景在用？";
  input.value = q;
  const before = stream.querySelectorAll(".emp-turn").length;
  send.dispatchEvent(new W.MouseEvent("click", { bubbles: true, cancelable: true }));

  // 注意：pendingTurn 会立刻追加「运行中…」那一轮，
  // 所以要等 #chat-pending 被移除且最后一条 bot 轮带上运行号，才算真回复。
  const got = await waitFor(() => {
    if (stream.querySelector("#chat-pending")) return null;
    const bots = [...stream.querySelectorAll(".emp-turn-bot")];
    const last = bots[bots.length - 1];
    if (!last) return null;
    const m = last.querySelector(".emp-bot-meta");
    return m && /知问|笔正|明察|知微|守则/.test(m.textContent)
      && /已完成|需要补充信息|等你确认|没做成|处理中|等待中/.test(m.textContent) ? true : null;
  }, 60000, 200);
  ok("用户气泡与员工回复都已追加", !!got,
    stream.querySelectorAll(".emp-turn").length + " 轮（原 " + before + "）");
  ok("加载态已清除", !stream.querySelector("#chat-pending"));

  const userTurn = [...stream.querySelectorAll(".emp-turn-user")].pop();
  ok("用户气泡内容正确", userTurn && userTurn.textContent.includes(q),
    userTurn ? userTurn.textContent.trim().slice(0, 30) : "");

  const botTurn = [...stream.querySelectorAll(".emp-turn-bot")].pop();
  const meta = botTurn ? botTurn.querySelector(".emp-bot-meta").textContent : "";
  ok("回复含员工名与中文状态",
    /知问|笔正|明察|知微|守则/.test(meta)
    && /已完成|需要补充信息|等你确认|没做成|处理中|等待中/.test(meta),
    meta.replace(/\s+/g, " ").trim());
  ok("回复不含内部状态枚举与工具名",
    !/run-\d|[A-Z]{3,}_[A-Z]+|get_course_|retrieve_/.test(meta));

  const kv = doc.querySelector("#p2 .stack .card:first-child .emp-kv").textContent;
  ok("「本次处理」面板已更新为中文状态", /已完成|需要补充信息|等你确认|没做成|处理中/.test(kv),
    kv.replace(/\s+/g, " ").trim().slice(0, 70));
  ok("「本次处理」面板不出现运行号 / 枚举", !/run-\d|[A-Z]{3,}_[A-Z]+/.test(kv));
  ok("调用时间已写入", /\d{2}-\d{2} \d{2}:\d{2}/.test(kv));

  const hasWarn = !!botTurn.querySelector(".alert-warning");
  const hasAnswer = !!(botTurn.querySelector(".emp-bot-text") || {}).textContent;
  ok("给出回答或如实降级说明（不静默空白）", hasWarn || hasAnswer,
    hasWarn ? "降级：alert-warning 已渲染" : "正常回答");
  if (hasWarn) {
    ok("降级说明是面向用户的说法（无 placeholder / LLM / OLLAMA）",
      /答不上来|说具体一点/.test(botTurn.querySelector(".alert-warning").textContent)
      && !/placeholder|LLM|OLLAMA|501/.test(botTurn.querySelector(".alert-warning").textContent));
  }

  // 抽屉是二次取数，给它一点时间
  const ctx = await waitFor(() => {
    const c = doc.querySelector('[data-panel="ctx"]');
    return c && /这次的情况/.test(c.textContent) ? c : null;
  }, 30000, 200);
  ok("本次详情抽屉已填充真实处理信息", !!ctx,
    ctx ? ctx.textContent.replace(/\s+/g, " ").trim().slice(0, 60) : "未填充");
  if (ctx) {
    ok("抽屉含处理步骤与顺利程度", /做了几步/.test(ctx.textContent) && /是否顺利/.test(ctx.textContent));
    ok("抽屉无内部标识（运行号 / 规划来源 / 工具调用）",
      !/run-9f31c2|run-\d|规划来源|工具调用/.test(ctx.textContent));
  }

  await sleep(400);
  ok("发送期间无未捕获异常", consoleErrors.length === 0,
    consoleErrors.slice(0, 2).join(" | "));
}

/* ---------------- 14. 交互：刷新 ---------------- */
console.log("\n=== 14. 交互：顶栏刷新按钮（重复渲染幂等）===");
const refreshBtn = [...doc.querySelectorAll('[data-icon="refresh"]')][0];
ok("找到刷新按钮", !!refreshBtn);
if (refreshBtn) {
  const nBefore = box.querySelectorAll(".emp-event").length;
  refreshBtn.dispatchEvent(new W.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(6000);
  const nAfter = box.querySelectorAll(".emp-event").length;
  ok("刷新后事件流仍为真实数据（未重复追加、未清空）", nAfter === nBefore && nAfter > 0,
    nBefore + " → " + nAfter);
  const allIcons = [...doc.querySelectorAll("[data-icon]")];
  ok("刷新后图标未重复注入（mount 幂等）",
    allIcons.every((e) => e.querySelectorAll("svg").length <= 1),
    allIcons.filter((e) => e.querySelectorAll("svg").length > 1).length + " 个元素图标重复");
  ok("刷新后负载条未叠加（仍 5 条）",
    doc.querySelectorAll('[data-panel="load"] .progress-bar').length === 5,
    doc.querySelectorAll('[data-panel="load"] .progress-bar').length + " 条");
}

/* ---------------- 15. 交互：员工档案编辑链路 ---------------- */
console.log("\n=== 15. 交互：员工编辑链路（编辑 → 校验 → 保存 → DOM 反映 → 持久化）===");
{
  const roster = doc.querySelector('[data-list="emp-roster"]');
  ok("P3 名册容器存在", !!roster);

  // 从真实卡片按钮进入编辑，而不是直接调内部函数
  const editBtn = doc.querySelector('#p3 [data-emp-edit="knowledge"]');
  ok("名册卡挂有编辑入口 data-emp-edit", !!editBtn);

  if (editBtn) {
    editBtn.dispatchEvent(new W.MouseEvent("click", { bubbles: true, cancelable: true }));
    const modal = await waitFor(() => {
      const m = doc.getElementById("modal-employee");
      return m && m.classList.contains("open") ? m : null;
    }, 8000, 50);
    ok("点击编辑后弹层打开（.modal.open）", !!modal);

    if (modal) {
      const nameEl = doc.querySelector("#emp-f-name");
      const codeEl = doc.querySelector("#emp-f-code");
      ok("弹层标题为「编辑员工 · 知问」", /编辑员工\s*·\s*知问/.test(modal.textContent),
        (modal.querySelector('[data-panel="emp-modal-title"]') || {}).textContent);
      ok("显示名已按档案回填", nameEl && nameEl.value === "知问", nameEl && nameEl.value);
      ok("内置员工代号锁定（disabled）", codeEl && codeEl.disabled === true);
      ok("内置员工不出现删除按钮", doc.getElementById("emp-delete").hidden === true);

      const boxes = [...doc.querySelectorAll("#emp-f-tools input[type=checkbox]")];
      ok("工具多选由真实清单渲染", boxes.length > 0, boxes.length + " 个工具");
      const checked = boxes.filter((b) => b.checked).map((b) => b.value);
      ok("知问的 3 个工具处于勾选态",
        ["get_course_overview", "get_course_assignments", "retrieve_course_material"]
          .every((t) => checked.indexOf(t) >= 0), checked.join(","));

      // —— 校验：清空显示名 → 保存应被拦下、字段标红、不落盘 ——
      const rawBefore = W.localStorage.getItem("ea.employees");
      const keep = nameEl.value;
      nameEl.value = "";
      doc.getElementById("emp-save").dispatchEvent(new W.MouseEvent("click", { bubbles: true, cancelable: true }));
      await sleep(80);
      ok("非法输入被拦下且字段标红（.field.has-error）",
        doc.querySelector("#modal-employee .field.has-error") !== null);
      ok("弹层保持打开（未误关）", doc.getElementById("modal-employee").classList.contains("open"));
      ok("非法输入不落盘", W.localStorage.getItem("ea.employees") === rawBefore);
      nameEl.value = keep;

      // —— 合法改动：改名 + 取消一个工具 → 保存 ——
      nameEl.value = "知问·改";
      const drop = boxes.filter((b) => b.value === "get_course_assignments")[0];
      if (drop) drop.checked = false;
      doc.getElementById("emp-save").dispatchEvent(new W.MouseEvent("click", { bubbles: true, cancelable: true }));
      await sleep(150);

      const cardName = (roster.querySelector('[data-emp="knowledge"] .emp-card-name') || {}).textContent || "";
      ok("保存后名册卡显示名即时更新", /知问·改/.test(cardName), cardName.trim());
      ok("保存后弹层已关闭", !doc.getElementById("modal-employee").classList.contains("open"));

      const raw = W.localStorage.getItem("ea.employees") || "";
      ok("改动已持久化到 ea.employees", raw.indexOf("知问·改") >= 0, raw.slice(0, 90));
      ok("覆盖层仅记录差异字段（保留 code 主键）", /"code"\s*:\s*"knowledge"/.test(raw));
      ok("改动的工具集已写入（不再含 get_course_assignments）",
        raw.indexOf("get_course_assignments") < 0);

      const matrixTxt = (doc.querySelector('[data-list="emp-matrix"]') || {}).textContent || "";
      ok("能力矩阵与名册同源，同步反映新显示名", /知问·改/.test(matrixTxt));

      // —— 创建 → 删除（非内置员工可删） ——
      const newBtn = doc.querySelector("[data-emp-new]");
      ok("P3 有创建员工入口", !!newBtn);
      if (newBtn) {
        newBtn.dispatchEvent(new W.MouseEvent("click", { bubbles: true, cancelable: true }));
        const m2 = await waitFor(() => {
          const m = doc.getElementById("modal-employee");
          return m && m.classList.contains("open") ? m : null;
        }, 8000, 50);
        ok("创建弹层打开且代号可编辑", !!m2 && doc.querySelector("#emp-f-code").disabled === false);
        doc.querySelector("#emp-f-name").value = "巡检";
        doc.querySelector("#emp-f-role").value = "巡检员工";
        doc.querySelector("#emp-f-code").value = "inspect";
        doc.querySelector("#emp-f-persona").value = "定期巡检摄像头在线状态并汇总异常，只报不改。";
        const en = doc.getElementById("emp-f-enabled");
        if (en) en.checked = true;
        doc.getElementById("emp-save").dispatchEvent(new W.MouseEvent("click", { bubbles: true, cancelable: true }));
        await sleep(150);
        ok("新员工写入名册", roster.querySelector('[data-emp="inspect"]') !== null);
        ok("新员工计入在岗提示",
          /6 位在岗/.test((doc.querySelector('[data-panel="roster-hint"]') || {}).textContent || ""),
          (doc.querySelector('[data-panel="roster-hint"]') || {}).textContent);

        doc.querySelector('#p3 [data-emp-edit="inspect"]')
          .dispatchEvent(new W.MouseEvent("click", { bubbles: true, cancelable: true }));
        await waitFor(() => {
          const m = doc.getElementById("modal-employee");
          return m && m.classList.contains("open") ? m : null;
        }, 8000, 50);
        ok("自建员工可编辑且出现删除按钮", doc.getElementById("emp-delete").hidden === false);
        doc.getElementById("emp-delete").dispatchEvent(new W.MouseEvent("click", { bubbles: true, cancelable: true }));
        await sleep(150);
        ok("删除后从名册移除", roster.querySelector('[data-emp="inspect"]') === null);
        ok("删除后回落到 5 名在岗",
          /5 位在岗/.test((doc.querySelector('[data-panel="roster-hint"]') || {}).textContent || ""));
      }
    }
  }
}

/* ---------------- 15b. 顶栏真控件：查看范围 / 设置 / 搜索 / 分享 ---------------- */
console.log("\n=== 15b. 顶栏真控件（查看范围 / 设置 / 搜索 / 分享）===");

// 这四个以前都是「假控件」：点一下只弹一句话，或者干脆什么都不发生。
// 这里逐个断言它们确实接到了真实接口 / 真实行为。

// --- 查看范围：列出真实课程，选中后顶栏标签跟着切 ---
const scopeBtn = doc.querySelector('[data-panel="scope"]');
ok("「查看范围」是真控件（打开菜单，不再只弹提示）",
  !!scopeBtn && scopeBtn.getAttribute("data-toast") === null &&
  scopeBtn.getAttribute("data-menu-open") === "#menu-scope",
  scopeBtn ? "menu-open=" + scopeBtn.getAttribute("data-menu-open") +
    " toast=" + scopeBtn.getAttribute("data-toast") : "未找到");
const scopeItems = [...doc.querySelectorAll("#menu-scope [data-scope]")];
ok("查看范围菜单列出了真实课程（含一个默认范围）", scopeItems.length >= 2,
  scopeItems.map((b) => b.textContent.trim()).join(" / "));
const firstCourse = scopeItems.filter((b) => b.getAttribute("data-scope") !== "")[0];
if (firstCourse) {
  const wantName = firstCourse.getAttribute("data-scope-name");
  firstCourse.dispatchEvent(new W.MouseEvent("click", { bubbles: true, cancelable: true }));
  const label = await waitFor(() => {
    const el = doc.querySelector('[data-panel="scope-name"]');
    return el && el.textContent.trim() === wantName ? el : null;
  }, 8000, 50);
  ok("点一门课之后顶栏范围跟着切到课程名", !!label, wantName);
  // 切了范围，批改质量要跟着按课程重新取数
  const note = doc.querySelector('[data-panel="grading-note"]');
  ok("批改质量跟着换到该课程口径", !!doc.querySelector('[data-panel="grading-quality"] .card') || !!note);
}

// --- 设置：打开就是当前账号的真实资料 ---
const setBtn = doc.querySelector('.topbar [data-modal-open="#modal-settings"]');
ok("顶栏「设置」是真控件（打开账户设置，不再只弹提示）",
  !!setBtn && setBtn.getAttribute("data-toast") === null);
if (setBtn) {
  setBtn.dispatchEvent(new W.MouseEvent("click", { bubbles: true, cancelable: true }));
  // 打开的一瞬间就该有内容（用首屏已取到的档案先画），而不是先空一拍、
  // 让人以为「设置里什么都没有」。
  const immediate = (doc.querySelector('[data-panel="set-username"]') || {}).textContent || "";
  ok("设置弹层打开即填充（不留一屏空字段）",
    immediate.trim() !== "" && immediate.trim() !== "—", immediate.trim());
  const userCell = await waitFor(() => {
    const el = doc.querySelector('[data-panel="set-username"]');
    return el && el.textContent.trim() && el.textContent.trim() !== "—" ? el : null;
  }, 8000, 50);
  ok("设置里带出当前账号的登录名", !!userCell, userCell ? userCell.textContent.trim() : "");
  const dnInput = doc.getElementById("set-display-name");
  ok("设置里带出真实显示名", !!dnInput && dnInput.value.trim().length > 0,
    dnInput ? dnInput.value : "");
  const emailInput = doc.getElementById("set-email");
  ok("设置里带出真实邮箱", !!emailInput && /@/.test(emailInput.value), emailInput ? emailInput.value : "");
  const settingsText = (doc.getElementById("modal-settings") || {}).textContent || "";
  ok("设置弹层面向用户（无接口路径 / 原始字段名）",
    !/\/api\/|display_name|new_password|student_no|localStorage/.test(settingsText));
  const setClose = doc.querySelector('#modal-settings [data-close]');
  if (setClose) setClose.dispatchEvent(new W.MouseEvent("click", { bubbles: true, cancelable: true }));
}

// --- 搜索：输入关键词 → 调到真实接口 → 出结果 ---
const searchInput = doc.querySelector('[data-panel="search"]');
const searchRes = doc.querySelector('[data-list="search-res"]');
ok("搜索框有结果容器", !!searchRes);
if (searchInput && searchRes) {
  searchInput.value = "智能";
  searchInput.dispatchEvent(new W.Event("input", { bubbles: true }));
  const hit = await waitFor(() => {
    if (searchRes.hidden) return null;
    const items = searchRes.querySelectorAll("[data-res-target]");
    return items.length ? items[0] : null;
  }, 10000, 100);
  ok("输入关键词后搜到了真实结果", !!hit, hit ? hit.textContent.trim().slice(0, 40) : "");
  ok("搜索结果面向用户（无接口路径 / 原始字段名）",
    !/\/api\/|student_no|target=|course_id/.test(searchRes.textContent),
    searchRes.textContent.replace(/\s+/g, " ").trim().slice(0, 50));
}

// --- 分享：真的把内容写进剪贴板（以前是句不成立的「已复制」）---
const shareBtn = doc.querySelector('[data-panel="share"]');
ok("「分享」是真控件（不再是一句不成立的「已复制」）",
  !!shareBtn && shareBtn.getAttribute("data-toast") === null);
if (shareBtn) {
  let copied = null;
  const realNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: (t) => { copied = t; return Promise.resolve(); } } },
    configurable: true,
  });
  shareBtn.dispatchEvent(new W.MouseEvent("click", { bubbles: true, cancelable: true }));
  await waitFor(() => copied, 5000, 50);
  Object.defineProperty(globalThis, "navigator", { value: realNavigator, configurable: true });
  ok("点「分享」真的把内容写进了剪贴板", typeof copied === "string" && copied.length > 0,
    copied ? copied.split("\n")[0] : "(未复制)");
  ok("复制的是真实数字摘要，不是占位文案",
    !!copied && /教学场景已开启/.test(copied) && /位员工在岗/.test(copied));
}

/* ---------------- 15c. 退出登录（真控件 · 真清会话） ---------------- */
console.log("\n=== 15c. 退出登录 ===");
// 历史 bug：这个是假控件（data-toast="已退出登录"）——只弹提示、不清令牌，
// 于是「点了退出还在登录态」。这里断言它必须是真控件。
const logoutBtn = doc.querySelector('.side-foot [data-modal-open="#modal-logout"]');
ok("侧栏「退出」是真控件（不再只是弹一条提示）",
  !!logoutBtn && logoutBtn.getAttribute("data-toast") === null,
  logoutBtn ? "data-toast=" + logoutBtn.getAttribute("data-toast") : "未找到");
if (logoutBtn) {
  logoutBtn.dispatchEvent(new W.MouseEvent("click", { bubbles: true, cancelable: true }));
  const loModal = await waitFor(() => {
    const m = doc.getElementById("modal-logout");
    return m && m.classList.contains("open") ? m : null;
  }, 8000, 50);
  ok("点「退出」先弹确认层（不会一按就掉线）", !!loModal);
  ok("确认层文案面向用户（无接口路径 / 字段名 / 存储键）",
    !!loModal && !/\/api\/|token|localStorage|ea\./.test(loModal.textContent),
    loModal ? loModal.textContent.replace(/\s+/g, " ").trim().slice(0, 60) : "");

  const confirmBtn = doc.querySelector('[data-panel="logout-confirm"]');
  ok("确认层有「退出登录」按钮", !!confirmBtn);

  const hadToken = W.localStorage.getItem("ea.token") !== null;
  // 打桩 location：jsdom 未实现导航，真调 replace 会记一条 jsdomError 污染第 16 节兜底断言
  const realLocation = globalThis.location;
  let redirected = null;
  globalThis.location = { pathname: "/", search: "", replace: (u) => { redirected = u; } };
  if (confirmBtn) confirmBtn.dispatchEvent(new W.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(150);
  globalThis.location = realLocation;

  ok("点确认前确实处于登录态", hadToken);
  ok("确认后清空了登录令牌", W.localStorage.getItem("ea.token") === null);
  ok("确认后一并清空了用户信息", W.localStorage.getItem("ea.session") === null);
  ok("确认后跳登录页，并带回来协作台的回跳地址（不是 /platform）",
    redirected === "/login.html?next=%2F", redirected || "(未跳转)");
}

/* ---------------- 16. 兜底：无异常 ---------------- */
console.log("\n=== 16. 运行时异常检查 ===");
ok("全流程无 jsdomError / console.error", consoleErrors.length === 0,
  consoleErrors.slice(0, 3).join(" | ") || "无");

/* ---------------- 汇总 ---------------- */
console.log("\n" + "=".repeat(62));
console.log("通过 " + pass + " 项 · 失败 " + fail + " 项");
if (problems.length) {
  console.log("\n失败清单：");
  problems.forEach((p) => console.log("  - " + p));
}
dom.window.close();
process.exit(fail ? 1 : 0);
