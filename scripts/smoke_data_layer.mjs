/**
 * 前端数据层端到端冒烟测试（无头）。
 *
 * 与 Python 探测的区别：这里运行的是**真正会上线的前端代码**
 * —— static/js/console/api.js + static/js/desktop/data.js，
 * 只把浏览器 API（localStorage / location / fetch 相对路径）打桩，
 * 因此能验证「请求封装 + 信封解包 + 降级包装」这一整层。
 *
 * 断言标准同 app.js 的消费方式：读到的字段类型正确、非 undefined。
 *
 * 用法：node scripts/smoke_data_layer.mjs
 * 前置：后端已在运行。基址取环境变量 EA_BASE，缺省 http://127.0.0.1:18010。
 */

const BASE = process.env.EA_BASE || "http://127.0.0.1:18010";
const _BASE_URL = new URL(BASE);

/* ---------------- 浏览器 API 打桩 ---------------- */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.location = { pathname: "/static/desktop.html", search: "", protocol: _BASE_URL.protocol, host: _BASE_URL.host };
globalThis.window = { location: { replace: (u) => { globalThis.__redirect = u; } } };
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) =>
  realFetch(String(url).startsWith("http") ? url : BASE + url, opts);

/* ---------------- 载入真实前端模块 ---------------- */
const apiMod = await import("../static/js/console/api.js");
const D = await import("../static/js/desktop/data.js");

let pass = 0, fail = 0;
const problems = [];

function ok(label, cond, extra) {
  if (cond) { pass++; console.log("  \u2713 " + label + (extra ? "  " + extra : "")); }
  else { fail++; problems.push(label + (extra ? " :: " + extra : "")); console.log("  \u2717 " + label + (extra ? "  " + extra : "")); }
}

function isArr(v) { return Array.isArray(v); }
function isObj(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
function has(o, k) { return isObj(o) && o[k] !== undefined && o[k] !== null; }

/* ---------------- 1. 登录与会话 ---------------- */
console.log("=== 1. 登录与会话（api.login → session）===");
const u = await apiMod.login("admin", "Demo@12345", "ADMIN");
ok("login 返回 token", typeof u.token === "string" && u.token.length > 50, "len=" + u.token.length);
ok("session.token 已写入", apiMod.session.token === u.token);
ok("session.user.role", apiMod.session.role === "ADMIN", apiMod.session.role);
ok("session.name", typeof apiMod.session.name === "string" && apiMod.session.name.length > 0, apiMod.session.name);
ok("会话键为 ea.token（与 login.html 一致）", store.has("ea.token"));

/* ---------------- 2. loadDashboard：一次拉齐 ---------------- */
console.log("\n=== 2. loadDashboard()：12 路并发取数 ===");
const dash = await D.loadDashboard();
const keys = Object.keys(dash);
ok("聚合返回 6 组", keys.length === 6, keys.join(","));
ok("不含无消费方的 governance（避免白跑请求）", !("governance" in dash));

/* ---------------- 3. 逐块校验（视图层消费口径） ---------------- */
console.log("\n=== 3. 逐块字段校验（同 app.js 消费口径）===");

// renderChrome
{
  const r = dash.profile;
  if (r.ok) {
    const p = r.data;
    ok("profile.displayName", has(p, "displayName"), p.displayName);
    ok("profile.username", has(p, "username"), p.username);
    ok("profile.role", has(p, "role"), p.role);
  } else ok("profile 取数", false, r.error);
  const un = dash.notifications.unread;
  ok("notifications.unread.count", un.ok && has(un.data, "count"), un.ok ? un.data.count : un.error);
}

// renderBands / renderP0 / renderP1 KPI
{
  const vo = dash.vision.overview;
  ok("vision.overview 取数", vo.ok, vo.ok ? "" : vo.error);
  const v = vo.data || {};
  ok("vision.overview.eventTotal", has(v, "eventTotal"), String(v.eventTotal));
  ok("vision.overview.unacknowledged", has(v, "unacknowledged"), String(v.unacknowledged));
  ok("vision.overview.eventBySeverity", isObj(v.eventBySeverity),
    isObj(v.eventBySeverity) ? JSON.stringify(v.eventBySeverity) : "非对象");
  ok("vision.overview.taskTotal", has(v, "taskTotal"), String(v.taskTotal));

  const sc = dash.vision.scenes;
  ok("vision.scenes 为数组", sc.ok && isArr(sc.data), sc.ok ? sc.data.length + " 个" : sc.error);
  if (sc.ok && sc.data.length) {
    const s = sc.data[0];
    ok("scene 项含 value/label", has(s, "value") && has(s, "label"), s.value + " / " + s.label);
  }

  const ro = dash.review.overview;
  ok("review.overview 取数", ro.ok, ro.ok ? "" : ro.error);
  ok("review.overview.pendingCount", has(ro.data || {}, "pendingCount"), String((ro.data || {}).pendingCount));

  const io = dash.insight.overview;
  ok("insight.overview 取数", io.ok, io.ok ? "" : io.error);
  ok("insight.overview.averageScore", has(io.data || {}, "averageScore"), String((io.data || {}).averageScore));
  ok("insight.overview.studentTotal", has(io.data || {}, "studentTotal"), String((io.data || {}).studentTotal));

  const sr = dash.situation.rules;
  ok("situation.rules.rules 为数组", sr.ok && isArr((sr.data || {}).rules),
    sr.ok ? ((sr.data || {}).rules || []).length + " 条" : sr.error);
}

// eventCard：字段 + 身份解析
{
  const ev = dash.vision.events;
  ok("vision.events 取数", ev.ok, ev.ok ? "" : ev.error);
  const list = ev.ok ? ev.data : [];
  ok("vision.events 有数据", isArr(list) && list.length > 0, list.length + " 条");
  const id = dash.vision.identities;
  ok("vision.identities 取数", id.ok, id.ok ? "" : id.error);

  const idMap = {};
  (id.ok ? id.data : []).forEach((it) => { if (it.studentNo) idMap[it.studentNo] = it.displayName || it.studentNo; });
  ok("identityMap 可建（含 displayName）", Object.keys(idMap).length > 0,
    JSON.stringify(idMap).slice(0, 90));

  const FIELDS = ["id", "scene", "severity", "confidence", "createdAt"];
  let missing = [];
  list.forEach((e) => FIELDS.forEach((f) => { if (e[f] === undefined) missing.push("#" + e.id + "." + f); }));
  ok("每条事件都含 id/scene/severity/confidence/createdAt", missing.length === 0,
    missing.length ? missing.slice(0, 5).join(",") : list.length + " 条全部通过");

  const resolved = list.filter((e) => e.subjectRef && idMap[e.subjectRef]).length;
  const unbound = list.filter((e) => !e.subjectRef).length;
  ok("事件 subjectRef 可解析或按设计回退", resolved + unbound === list.length,
    "解析 " + resolved + " · 未绑定 " + unbound + " · 共 " + list.length);

  const sevOk = list.every((e) => ["info", "warning", "critical"].indexOf(e.severity) >= 0);
  ok("severity 取值在 info/warning/critical 内", sevOk,
    [...new Set(list.map((e) => e.severity))].join(","));

  const confOk = list.every((e) => typeof e.confidence === "number" && e.confidence >= 0 && e.confidence <= 1);
  ok("confidence 为 0..1 数值", confOk);
}

// buildTodos
{
  const n = dash.situation.notifications;
  ok("situation.notifications 取数", n.ok, n.ok ? (isArr(n.data) ? n.data.length + " 条" : "非数组") : n.error);
  const ov = dash.vision.overview;
  const ro = dash.review.overview;
  let todos = 0;
  if (ov.ok && (ov.data || {}).unacknowledged > 0) todos++;
  if (n.ok && isArr(n.data) && n.data.length) todos++;
  if (ro.ok && (ro.data || {}).pendingCount > 0) todos++;
  ok("buildTodos 至少产出一条（未确认事件 > 0）", todos > 0, todos + " 条待办");
}

/* ---------------- 4. Agent 对话（P2 协作台） ---------------- */
console.log("\n=== 4. agent.chat()：真实运行时链路 ===");
const t0 = Date.now();
const chat = await D.agent.chat("平台当前有哪些视觉场景在用？");
const cost = Date.now() - t0;
ok("接口未抛异常（safe 包装生效）", typeof chat.ok === "boolean");
ok("返回 ok 或带错误码", chat.ok || (chat.error && chat.code !== undefined),
  chat.ok ? "ok" : "code=" + chat.code + " " + String(chat.error).slice(0, 60));
if (chat.ok) {
  const d = chat.data || {};
  ok("响应含 status", has(d, "status"), d.status);
  ok("响应含 runId（真实运行记录）", has(d, "runId"), "run-" + d.runId);
  ok("响应含 plan", has(d, "plan"), isObj(d.plan) ? Object.keys(d.plan).join(",") : typeof d.plan);
  ok("响应含 executedSteps", d.executedSteps !== undefined,
    isArr(d.executedSteps) ? d.executedSteps.length + " 步" : typeof d.executedSteps);
  ok("响应含 citations", d.citations !== undefined, isArr(d.citations) ? d.citations.length + " 条" : typeof d.citations);
  ok("status 语义可知（COMPLETED / NEEDS_INPUT / FAILED）",
    ["COMPLETED", "NEEDS_INPUT", "FAILED"].indexOf(String(d.status)) >= 0, d.status);
  if (String(d.status) === "NEEDS_INPUT") {
    console.log("      → 降级路径（后端未配置 LLM）：前端会渲染 alert-warning 并如实说明原因");
  }
  console.log("      耗时 " + cost + " ms");
} else {
  console.log("      失败码 " + chat.code + "：" + String(chat.error).slice(0, 120));
}

/* ---------------- 5. 401 守卫 ---------------- */
console.log("\n=== 5. 401 守卫（令牌失效自动跳登录）===");
console.log("    注：api.js 对 /api/auth/* 豁免跳转（避免登录页自身形成重定向环），");
console.log("        因此用业务接口验证；auth.profile 由 app.js 的启动守卫兜住无令牌场景。");
const keep = store.get("ea.token");
store.set("ea.token", "invalid.token.value");
globalThis.__redirect = null;
let threw = false;
try { await apiMod.api.get("/api/vision/overview"); } catch (_) { threw = true; }
ok("业务接口遇 401 抛错并跳登录", threw && typeof globalThis.__redirect === "string",
  threw ? "→ " + globalThis.__redirect : "未抛错（threw=" + threw + "）");
ok("跳转地址携带 next 参数回跳本页", /next=/.test(String(globalThis.__redirect)),
  String(globalThis.__redirect));
ok("会话已被清空（避免带着坏令牌重试）", !store.get("ea.token"), "ea.token=" + store.get("ea.token"));
if (keep) store.set("ea.token", keep);

/* ---------------- 汇总 ---------------- */
console.log("\n" + "=".repeat(60));
console.log("通过 " + pass + " 项 · 失败 " + fail + " 项");
if (problems.length) {
  console.log("\n失败清单：");
  problems.forEach((p) => console.log("  - " + p));
}
process.exit(fail ? 1 : 0);
