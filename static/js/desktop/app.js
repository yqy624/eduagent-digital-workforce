/**
 * 桌面端视图层：把 data.js 拿到的真实数据渲染进 desktop.html。
 *
 * 与引擎的分工
 * ------------
 * hifi.js 负责「交互」（路由切换、弹层、Toast、校验、数字滚动），
 * 本文件只负责「数据 → DOM」。二者靠属性契约协作，不互相调用内部函数。
 *
 * 两个必须知道的引擎行为（已读源码确认，非推断）：
 *   · 所有交互都是 document 级事件委托，因此**动态渲染的节点自带 data-toast /
 *     data-goto / data-loading 即可生效**，不需要重新绑定；
 *   · hifi.js 只在 DOMContentLoaded 扫描一次 DOM（图标注入 / 进度条 / 数字滚动），
 *     动态插入的节点必须调用 window.Hifi.mount(el)（见 hifi-bridge.js）补齐。
 *
 * 文案原则（本文件与 desktop.html / employees.js 共同遵守）
 * -------------------------------------------------------
 * 界面上的每一个字都是给用户看的：不出现接口路径、字段名、工具名、版本号、
 * 运行编号、状态枚举、存储键、内部模块名。后端返回的值只用于判断，上屏前
 * 一律经下面的显示层词表翻译（STATUS_TEXT / SEV_TEXT / SCOPE_TEXT）。
 * 回归检查：check_prototype.py 扫静态文本，smoke_desktop_dom.mjs 扫渲染结果。
 *
 * 降级原则
 * --------
 * 任何一块数据失败只降级该块（错误态给出用户能采取行动的一句话），
 * 技术原因写进控制台留给维护者；不留白、不炸整页。
 */
import * as D from "./data.js";
import { session, loginUrl } from "./data.js";
import {
  loadEmployees,
  saveEmployees,
  upsertEmployee,
  removeEmployee,
  isBuiltin,
  makeEmployee,
  ICON_CHOICES,
  TINT_CHOICES,
  WRITE_POLICIES,
  writePolicyLabel,
  toolLabel,
} from "./employees.js";

/* ============================ 常量 ============================ */

/* 员工档案已抽到 ./employees.js（页面上可编辑，存 localStorage）。
   默认档案的 code 与后端模块一一对应，见该文件的 DEFAULT_EMPLOYEES。 */

const SCENE = {
  classroom: "课堂行为识别",
  lab_safety: "实验室安全",
  exam_proctor: "考试监考",
  paper_grading: "拍照批改",
};

/* ----------------------------------------------------------------------
   显示层词表
   ----------------------------------------------------------------------
   后端返回的状态枚举、severity、mode 等**只用于判断**，绝不直接上屏。
   界面上出现的一律是这里的中文。新增枚举时在这里补一行即可 ——
   这是本文件唯一允许出现「英文字面量」的地方（键名）。

   规则：任何用户可见文本都不得包含接口路径、字段名、工具名、版本号、
   运行编号、状态枚举、存储键、内部模块名。回归检查见
   scripts/smoke_desktop_dom.mjs 的「禁用词」扫描。
   ---------------------------------------------------------------------- */
const STATUS_TEXT = {
  COMPLETED: "已完成",
  NEEDS_INPUT: "需要补充信息",
  WAITING_CONFIRMATION: "等你确认",
  FAILED: "没做成",
  RUNNING: "处理中",
  PENDING: "等待中",
  REJECTED: "已取消",
  NEEDS_CONFIRM: "等你确认",
  SKIPPED: "已跳过",
};

function statusText(v) {
  return STATUS_TEXT[String(v || "").toUpperCase()] || "已处理";
}

const SEV_CLASS = { info: "sev-info", warning: "sev-warning", critical: "sev-critical" };
const SEV_TEXT = { info: "提示", warning: "需要注意", critical: "紧急" };
const SEV_TAG = { info: "tag-outline", warning: "tag-warning", critical: "tag-danger" };

/** 顶栏范围名与搜索提示：按角色给不同的说法。 */
const SCOPE_TEXT = {
  ADMIN: { name: "全校 · 教学空间", search: "搜索员工、课程或学生…" },
  TEACHER: { name: "我的课程与班级", search: "搜索员工、课程或学生…" },
  STUDENT: { name: "我的课程", search: "搜索员工或课程…" },
};

/** 协作台的快捷提问：按角色给真正用得上的问题。 */
const QUICK_PROMPTS = {
  ADMIN: ["最近有哪些事需要我处理？", "这周的课堂与安全提醒情况", "哪些学生需要重点关注？"],
  TEACHER: ["哪些学生需要我关注？", "帮我看看这门课的作业情况", "给我一份这周的学情小结"],
  STUDENT: ["我最近的学习情况怎么样？", "帮我找出薄弱的知识点", "给我一份这周的学习计划"],
};

/* ============================ 渲染工具 ============================ */

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function $(sel, root) {
  return (root || document).querySelector(sel);
}

/** 给容器补引擎能力（图标 / 进度条 / 数字滚动）。 */
function mount(el) {
  if (el && window.Hifi) window.Hifi.mount(el);
}

function fmtClock(iso) {
  if (!iso) return "--:--";
  const d = new Date(iso);
  if (isNaN(d)) return "--:--";
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

/** 置信度分档：>=0.85 高，>=0.6 中，其余低。 */
function confLevel(v) {
  const n = Number(v);
  if (isNaN(n)) return "mid";
  if (n >= 0.85) return "hi";
  if (n >= 0.6) return "mid";
  return "lo";
}

function emptyBlock(title, desc) {
  return (
    '<div class="empty">' +
    '<span class="stat-icon" data-icon="info"></span>' +
    '<div class="title">' + esc(title) + "</div>" +
    '<div class="xs" style="margin-top:4px">' + esc(desc || "") + "</div>" +
    "</div>"
  );
}

function errBlock(what, res) {
  // 技术原因只写进控制台，给维护者看；界面上只留用户能采取行动的说法。
  if (res && res.error) console.warn("[desktop]", what, res.error);
  return (
    '<div class="alert alert-danger">' +
    '<span class="a-ic" data-icon="alert-triangle"></span>' +
    "<div><div class=\"a-title\">" + esc(what) + "暂时读不到</div>" +
    '<div class="a-body">点右上角「刷新」可以重试；如果一直这样，请找管理员看看。</div></div></div>'
  );
}

/** 统一取值：成功返回 data，失败返回 fallback，并记录错误供降级提示。 */
function val(res, fallback) {
  return res && res.ok && res.data != null ? res.data : fallback;
}

/* ============================ 顶栏与侧栏 ============================ */

/** 当前登录角色（大写）。界面上一切「按角色不同」的判断都以它为准。 */
function currentRole(dash) {
  const p = val((dash || {}).profile, null) || session.user || {};
  return String(p.role || session.role || "").toUpperCase();
}

function renderChrome(dash) {
  const p = val(dash.profile, null) || session.user || {};
  const name = p.displayName || p.username || "未登录";
  const roleMap = { ADMIN: "管理员", TEACHER: "教师", STUDENT: "学生" };
  const rk = currentRole(dash);
  const role = roleMap[rk] || "用户";

  document.querySelectorAll(".side-foot .avatar").forEach(function (a) {
    a.textContent = (name || "?").slice(0, 1);
  });
  const foot = $(".side-foot .xs");
  if (foot) foot.textContent = p.username || "—";
  const footRole = $(".side-foot .xxl");
  if (footRole) footRole.textContent = role + (p.studentNo ? " · " + p.studentNo : "");
  document.querySelectorAll(".topbar .avatar").forEach(function (a) {
    a.textContent = (name || "?").slice(0, 1);
  });

  // 查看范围与搜索提示：老师看班级，学生看自己
  const sc = SCOPE_TEXT[rk] || SCOPE_TEXT.TEACHER;
  scopeState.baseName = sc.name;
  document.querySelectorAll('[data-panel="org-name"]').forEach(function (el) {
    el.textContent = sc.name;
  });
  // 换了角色，上一个角色选的课程范围不再适用
  if (scopeState.role && scopeState.role !== rk) {
    scopeState.courseId = null;
    scopeState.courseName = null;
    scopeState.courses = null;
  }
  scopeState.role = rk;
  paintScope();
  const search = $('[data-panel="search"]');
  if (search) search.setAttribute("placeholder", sc.search);

  // 学生只接收结果、不派活 —— 派任务入口对他们没有意义
  const canDispatch = rk !== "STUDENT";
  document.querySelectorAll('[data-modal-open="modal-dispatch"]').forEach(function (b) {
    b.style.display = canDispatch ? "" : "none";
  });

  // 协作台的快捷提问按角色换成本角色真用得上的问题
  const tips = QUICK_PROMPTS[rk] || QUICK_PROMPTS.TEACHER;
  document.querySelectorAll("#p2 .emp-quick .btn").forEach(function (b, i) {
    if (tips[i]) b.textContent = tips[i];
  });

  // 学生看不到「批改质量复核」与「学生学情档案」——这两块的接口本身也不对他们开放
  document.querySelectorAll('[data-hide-for="STUDENT"]').forEach(function (el) {
    el.style.display = rk === "STUDENT" ? "none" : "";
  });

  // 未读通知角标（顶栏铃铛 + 侧栏协作台）
  const un = val(dash.notifications && dash.notifications.unread, null);
  notifState.unread = un && un.count != null ? num(un.count) : 0;
  paintUnreadBadge();
}

/** 未读角标：顶栏铃铛的小红点 + 侧栏「协作台」的数字。标记已读后同步刷新。 */
function paintUnreadBadge() {
  const count = notifState.unread;
  const bell = $('.topbar [data-icon="bell"]');
  if (bell) {
    // 铃铛现在是真控件（点开是通知列表），所以不再挂 data-toast，否则会同时弹提示
    bell.setAttribute("aria-label", count > 0 ? "通知 · " + count + " 条未读" : "通知");
    const dot = bell.querySelector(".desk-dot");
    if (dot) dot.style.display = count > 0 ? "" : "none";
  }
  const navBadge = $('[data-panel="nav-unread"]');
  if (navBadge) {
    navBadge.textContent = String(count);
    if (count > 0) navBadge.removeAttribute("hidden");
    else navBadge.setAttribute("hidden", "");
  }
}

/* ============================ P0 · 协作全景 ============================ */

function renderP0(dash) {
  renderBands(dash);
  // 在岗员工卡与 P3 名册共用一套渲染（见 renderEmployees），此处不再单独维护
}

/** P0/P1 共用的组织带：场景数 / 待处理提醒 / 生效提醒条件。 */
function renderBands(dash) {
  const scenes = val(dash.vision.scenes, []);
  const rules = val(dash.situation.rules, {});
  const ruleList = (rules && rules.rules) || [];
  const enabledRules = ruleList.filter(function (r) { return r.enabled !== false; }).length;

  document.querySelectorAll('[data-org="summary"]').forEach(function (el) {
    el.textContent = (scenes.length || 0) + " 个教学场景已开启 · " + enabledRules + " 条提醒条件生效";
  });
  document.querySelectorAll('[data-org="pending"]').forEach(function (el) {
    el.textContent = String(num(val(dash.vision.overview, {}).unacknowledged));
  });
  document.querySelectorAll('[data-org="rules"]').forEach(function (el) {
    el.textContent = String(enabledRules);
  });
}

/**
 * 每位员工「手上正在处理多少事」—— 取自各模块的真实计数，不编造。
 * 学生拿不到教师的评阅口径（接口本身就不开放），所以按角色换一列说法。
 */
function empWorkload(dash) {
  const d = dash || {};
  const role = currentRole(d);
  const isStudent = role === "STUDENT";
  const vo = val(d.vision && d.vision.overview, {});
  const io = val(d.insight && d.insight.overview, {});
  const ro = isStudent ? {} : val(d.review && d.review.overview, {});
  const rules = val(d.situation && d.situation.rules, {});
  const ruleList = (rules && rules.rules) || [];

  return [
    { code: "knowledge", label: "课程资料", value: 0, text: "待上传" },
    isStudent
      ? { code: "review", label: "我的作业", value: num(io.gradedTotal), text: num(io.gradedTotal) + " 份已批" }
      : { code: "review", label: "待批改作业", value: num(ro.pendingCount), text: num(ro.pendingCount) + " 份待批" },
    { code: "vision", label: "影像提醒", value: num(vo.eventTotal), text: num(vo.eventTotal) + " 条" },
    isStudent
      ? { code: "insight", label: "我的学情", value: num(io.submissionTotal), text: num(io.submissionTotal) + " 份提交" }
      : { code: "insight", label: "学情覆盖", value: num(io.studentTotal), text: num(io.studentTotal) + " 名学生" },
    { code: "situation", label: "提醒条件", value: ruleList.length, text: ruleList.length + " 条生效" },
  ];
}

function num(v) {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

/* ============================ P1 · 指挥台 ============================ */

function renderP1(dash) {
  const vo = val(dash.vision.overview, {});
  const io = val(dash.insight.overview, {});
  const isStudent = currentRole(dash) === "STUDENT";
  const ro = isStudent ? {} : val(dash.review.overview, {});
  const sev = vo.eventBySeverity || {};

  // ---- KPI 四卡：真实指标，措辞随角色走（学生看到的是班级口径） ----
  const kpis = [
    {
      label: isStudent ? "全班课堂与安全提醒" : "课堂与安全提醒",
      value: num(vo.eventTotal),
      delta: '<span data-icon="alert-triangle" class="ico-sm"></span>紧急 ' + num(sev.critical) + " 条",
      deltaClass: "",
      foot: "需要注意 " + num(sev.warning) + " · 提示 " + num(sev.info),
    },
    {
      label: isStudent ? "全班已交作业" : "待批改作业",
      value: isStudent ? num(io.submissionTotal) : num(ro.pendingCount),
      delta: '<span data-icon="edit" class="ico-sm"></span>' +
        (isStudent ? "已批改 " + num(io.gradedTotal) + " 份" : "共收到 " + num(ro.submissionCount) + " 份"),
      deltaClass: "",
      foot: isStudent ? "平均分 " + (io.averageScore == null ? "—" : Number(io.averageScore).toFixed(1))
        : "已批改 " + num(ro.gradedCount) + " 份",
    },
    {
      label: isStudent ? "全班待处理提醒" : "待你处理",
      value: num(vo.unacknowledged),
      delta: '<span data-icon="shield" class="ico-sm"></span>' +
        (isStudent ? "老师处理后会归档" : "处理完才会归档"),
      deltaClass: "",
      foot: "影像分析 " + num(vo.taskTotal) + " 次",
    },
    {
      label: isStudent ? "班级平均分" : "学生平均分",
      value: io.averageScore == null ? 0 : Number(io.averageScore),
      decimals: 1,
      delta: '<span data-icon="users" class="ico-sm"></span>覆盖 ' + num(io.studentTotal) + " 名学生",
      deltaClass: "",
      foot: "已批改 " + num(io.gradedTotal) + " 份",
    },
  ];

  const stats = document.querySelectorAll("#p1 .emp-stats .card");
  stats.forEach(function (card, i) {
    const k = kpis[i];
    if (!k) return;
    const lb = card.querySelector(".stat-label");
    if (lb) lb.textContent = k.label;
    const v = card.querySelector(".stat-value");
    if (v) {
      v.setAttribute("data-count-to", k.value);
      v.setAttribute("data-decimals", k.decimals || 0);
      v.removeAttribute("data-suffix");
      v.textContent = String(k.value);
    }
    const dl = card.querySelector(".stat-delta");
    if (dl) {
      dl.className = "stat-delta " + (k.deltaClass || "");
      dl.innerHTML = k.delta;
    }
    const ft = card.querySelector(".xxl");
    if (ft) ft.textContent = k.foot;
    mount(card); // 让 data-count-to 在被填充后才启动滚动
  });

  // ---- 最新提醒：真实事件；学生只看到与自己相关的那部分 ----
  const box = $("#live-events");
  if (box) {
    if (!dash.vision.events.ok) {
      box.innerHTML = errBlock("提醒", dash.vision.events);
    } else {
      const mine = (val(dash.profile, null) || {}).studentNo;
      let evs = dash.vision.events.data || [];
      if (isStudent && mine) {
        evs = evs.filter(function (e) { return e.subjectRef === mine; });
      }
      if (!evs.length) {
        box.innerHTML = emptyBlock(
          isStudent ? "暂时没有与你有关的提醒" : "暂时没有需要你关注的情况",
          "员工发现值得你注意的事，会第一时间出现在这里。");
      } else {
        const idMap = identityMap(dash);
        box.innerHTML = '<div class="stack-sm stagger">' + evs.map(function (e) {
          return eventCard(e, idMap);
        }).join("") + "</div>";
      }
    }
    mount(box);
  }

  // ---- 员工负载 ----
  const loadBox = document.querySelector('[data-panel="load"]');
  const wl = empWorkload(dash);
  const maxW = Math.max.apply(null, wl.map(function (w) { return w.value; }).concat([1]));
  if (loadBox) {
    loadBox.innerHTML = wl.map(function (w) {
      const emp = empState.employees.filter(function (x) { return x.code === w.code; })[0] || {};
      const pct = Math.round((w.value / maxW) * 100);
      return (
        '<div><div class="row-between"><span class="sub">' + esc(emp.name) + " · " + esc(emp.role) +
        '</span><span class="num xs">' + esc(w.text) + "</span></div>" +
        '<div class="progress progress-thin" style="margin-top:6px">' +
        '<span class="progress-bar" data-progress="' + pct + '" style="width:' + pct + '%"></span></div></div>'
      );
    }).join("");
    mount(loadBox);
  }

  // ---- 待你处理 ----
  const todo = document.querySelector('[data-panel="todo"]');
  const todoBadge = document.querySelector('[data-panel="todo-count"]');
  if (todo) {
    const items = buildTodos(dash);
    if (todoBadge) todoBadge.textContent = String(items.length);
    todo.innerHTML = items.length
      ? items.map(function (t) {
          return (
            '<div class="list-item"><span class="stat-icon" data-icon="' + t.icon + '"></span>' +
            '<div style="flex:1;min-width:0"><div class="title">' + esc(t.title) + "</div>" +
            '<div class="xs">' + esc(t.desc) + "</div></div>" +
            '<button class="btn btn-secondary btn-sm" data-toast="' + esc(t.toast) + '" data-toast-type="info">' + esc(t.action) + "</button></div>"
          );
        }).join("")
      : emptyBlock("暂时没有要你处理的事", "需要你点头才能往下走的事，会出现在这里。");
    mount(todo);
  }
}

function buildTodos(dash) {
  const isStudent = currentRole(dash) === "STUDENT";
  const vo = val(dash.vision.overview, {});
  const ro = isStudent ? {} : val(dash.review.overview, {});
  const notifs = val(dash.situation.notifications, []);
  const list = [];
  if (!isStudent && num(vo.unacknowledged) > 0) {
    list.push({
      icon: "eye",
      title: "有待处理的提醒",
      desc: "明察发现了 " + num(vo.unacknowledged) + " 条，等你过目",
      action: "去看看",
      toast: "已定位到待处理的提醒",
    });
  }
  if (Array.isArray(notifs) && notifs.length) {
    list.push({
      icon: "send",
      title: "已经发出去的通知",
      desc: "守则送达了 " + notifs.length + " 条",
      action: "查看",
      toast: "已打开通知列表",
    });
  }
  if (num(ro.pendingCount) > 0) {
    list.push({
      icon: "edit",
      title: "成绩等你确认",
      desc: "笔正批好了 " + num(ro.pendingCount) + " 份，确认后才会计入",
      action: "去确认",
      toast: "已进入成绩确认",
    });
  }
  return list;
}

function identityMap(dash) {
  const map = {};
  const ids = val(dash.vision.identities, []);
  (ids || []).forEach(function (it) {
    if (it.studentNo) map[it.studentNo] = it.displayName || it.studentNo;
  });
  return map;
}

function eventCard(e, idMap) {
  const sev = SEV_CLASS[e.severity] || "sev-info";
  const student = idMap[e.subjectRef] || e.subjectRef || "未绑定身份";
  const desc = [
    SCENE[e.scene] || e.scene,
    e.seatRef ? "座位 " + e.seatRef : null,
    student,
    e.durationS != null ? "持续 " + Number(e.durationS).toFixed(1) + " 秒" : null,
  ].filter(Boolean).join(" · ");

  return (
    '<div class="emp-event ' + sev + '"><span class="ev-bar"></span>' +
    '<div class="ev-main">' +
    '<div class="ev-title">' + esc((SCENE[e.scene] || e.scene) + " · " + (e.eventLabel || e.eventType)) + "</div>" +
    '<div class="ev-desc">' + esc(desc) + "</div>" +
    '<div class="row-wrap" style="margin-top:6px">' +
    '<span class="emp-conf ' + confLevel(e.confidence) + '">把握 ' +
      Math.round(Number(e.confidence || 0) * 100) + "%</span>" +
    '<span class="tag ' + (SEV_TAG[e.severity] || "tag-outline") + ' tag-outline">' + esc(SEV_TEXT[e.severity] || "提示") + "</span>" +
    (e.acknowledged ? '<span class="tag tag-outline">已处理</span>' : '<span class="tag tag-warning tag-outline">待处理</span>') +
    "</div></div>" +
    '<span class="ev-meta">' + esc(fmtClock(e.createdAt)) + "</span></div>"
  );
}

/* ============================ 通知（顶栏铃铛） ============================ */

/* 数据层早就封好了 list / 标记已读 / 全部已读，但一直没有任何调用方 ——
   铃铛此前是个假控件（点了只弹一句话）。这里把它接成真实通知列表。 */
const notifState = { items: [], unread: 0 };

/** 通知菜单：只上屏用户看得懂的标题、摘要与时间，不显示内部分类枚举。 */
function renderNotifMenu(box, items) {
  const unread = items.filter(function (n) { return !n.read; }).length;
  const head = '<div class="menu-title">通知' + (unread ? " · " + unread + " 条未读" : "") + "</div>";
  if (!items.length) {
    box.innerHTML = head + '<div class="xs" style="padding:10px">暂时没有新通知。</div>';
    mount(box);
    return;
  }
  box.innerHTML = head + items.slice(0, 8).map(function (n) {
    return '<div class="list-item' + (n.read ? "" : " is-active") + '" data-notif="' + esc(n.id) + '">' +
      '<div class="li-main">' +
        '<div class="li-title">' + esc(n.title || "通知") + "</div>" +
        '<div class="li-desc">' + esc(String(n.content || "").slice(0, 48)) + "</div>" +
      "</div>" +
      '<div class="li-meta">' + esc(fmtDateTime(n.createdAt)) + "</div>" +
      "</div>";
  }).join("") +
    '<div class="menu-item" data-notif-all>全部标为已读</div>';
  mount(box);
}

async function loadNotifications() {
  const box = $('[data-list="notif-list"]');
  if (!box) return;
  try {
    const res = await D.notifications.list();
    if (!res.ok) {
      if (res.error) console.warn("[desktop] notifications", res.error);
      box.innerHTML = '<div class="menu-title">通知</div>' +
        '<div class="xs" style="padding:10px">通知暂时读不到，点右上角「刷新」可以重试。</div>';
      return;
    }
    notifState.items = Array.isArray(res.data) ? res.data : [];
    renderNotifMenu(box, notifState.items);
  } catch (err) {
    console.warn("[desktop] notifications", err);
    // 通知菜单在首屏是骨架，抛出后必须换掉，否则点开铃铛永远是一片灰条。
    box.innerHTML = '<div class="menu-title">通知</div>' +
      '<div class="xs" style="padding:10px">通知暂时读不到，点右上角「刷新」可以重试。</div>';
  }
}

function bindNotifications() {
  document.addEventListener("click", async function (ev) {
    const one = ev.target.closest("[data-notif]");
    if (one) {
      ev.preventDefault();
      const id = one.getAttribute("data-notif");
      const res = await D.notifications.markRead(id);
      if (!res.ok) { toastMsg("没能标记已读，稍后再试", "warning"); return; }
      const item = notifState.items.filter(function (n) {
        return String(n.id) === String(id);
      })[0];
      if (item && !item.read) {
        item.read = true;
        notifState.unread = Math.max(0, notifState.unread - 1);
        paintUnreadBadge();
      }
      const box = $('[data-list="notif-list"]');
      if (box) renderNotifMenu(box, notifState.items);
      return;
    }
    if (ev.target.closest("[data-notif-all]")) {
      ev.preventDefault();
      const res = await D.notifications.markAllRead();
      if (!res.ok) { toastMsg("没能标记已读，稍后再试", "warning"); return; }
      notifState.items.forEach(function (n) { n.read = true; });
      notifState.unread = 0;
      paintUnreadBadge();
      const box = $('[data-list="notif-list"]');
      if (box) renderNotifMenu(box, notifState.items);
      toastMsg("已全部标为已读", "success");
    }
  });
}

/* ============================ 顶栏：查看范围 ============================ */

/**
 * 顶栏「查看范围」。
 * 之前它只在点击时弹一句「当前查看：…」，点完什么都不会变 —— 又是个假控件。
 * 现在它列出**这个人真实能看到的课程**，选中之后，指挥台里按课程取数的
 * 「批改质量复核」跟着切过去；「学生学情档案」能对上同一门课时也一起切。
 *
 * 取哪个接口取决于角色：老师看自己的课，学生看自己选的课，管理员看全校。
 */
const scopeState = { courses: null, courseId: null, courseName: null, baseName: "", role: "" };

/** 把「当前范围」画到顶栏标签上。选了具体课程显示课程名，否则显示本角色的默认范围。 */
function paintScope() {
  const label = scopeState.courseId == null ? scopeState.baseName : scopeState.courseName;
  document.querySelectorAll('[data-panel="scope-name"]').forEach(function (el) {
    el.textContent = label || "—";
  });
  const btn = $('[data-panel="scope"]');
  if (btn) btn.setAttribute("aria-label", "切换查看范围 · 当前：" + (label || "—"));
}

/**
 * 按角色取「这个人能看到的课程」。
 * 老师看自己教的课，学生看自己选的课，管理员看全校 —— 与后端各接口的可见范围保持一致。
 * 「查看范围」菜单和学生学情档案共用它，免得两处各写一份角色分支、日后走偏。
 */
async function fetchCoursesForRole(role) {
  let res;
  try {
    if (role === "ADMIN") res = await D.teaching.allCourses();
    else if (role === "STUDENT") res = await D.teaching.myCourses();
    else res = await D.teaching.courses();
  } catch (err) {
    return { ok: false, error: err };
  }
  if (!res.ok) return res;
  // 治理模块把课程包在 content 里，教师/学生两个接口直接给数组
  const rows = role === "ADMIN"
    ? ((res.data && res.data.content) || [])
    : (Array.isArray(res.data) ? res.data : []);
  return { ok: true, data: rows };
}

async function loadScopeMenu() {
  const box = $('[data-list="scope-list"]');
  if (!box) return;
  const role = currentRole(window.__dash);
  scopeState.role = role;
  const res = await fetchCoursesForRole(role);
  const head = '<div class="menu-title">切换查看范围</div>';
  if (!res.ok) {
    scopeState.courses = [];
    box.innerHTML = head +
      '<div class="xs" style="padding:10px">课程暂时读不到，点右上角「刷新」可以重试。</div>';
    mount(box);
    return;
  }

  const rows = res.data;
  scopeState.courses = rows;

  const items = [{ id: null, name: scopeState.baseName, hint: "" }].concat(
    rows.map(function (c) { return { id: c.id, name: c.name, hint: c.schedule || "" }; })
  );
  const cur = String(scopeState.courseId == null ? "" : scopeState.courseId);
  box.innerHTML = head + items.map(function (it) {
    const raw = it.id == null ? "" : String(it.id);
    return '<button class="menu-item" data-scope="' + esc(raw) + '"' +
      ' data-scope-name="' + esc(it.name) + '"' +
      ' data-icon="' + (raw === cur ? "check" : "target") + '">' +
      esc(it.name) + (it.hint ? " · " + esc(it.hint) : "") + "</button>";
  }).join("");
  mount(box);
}

/** 切换查看范围，并让依赖它的两块重新取数。 */
async function applyScope(courseId, courseName) {
  scopeState.courseId = courseId === "" || courseId == null ? null : courseId;
  scopeState.courseName = scopeState.courseId == null ? null : (courseName || "");
  paintScope();
  const menu = document.getElementById("menu-scope");
  if (menu) menu.classList.remove("open");
  loadScopeMenu();

  const role = currentRole(window.__dash);
  const tasks = [loadGradingQuality(role)];
  // 学生学情那块自带课程下拉：能对上同一门课就跟着切，对不上就各管各的
  const sel = $('[data-panel="stu-course"]');
  const matched = sel && scopeState.courseId != null &&
    Array.prototype.some.call(sel.options, function (o) {
      return String(o.value) === String(scopeState.courseId);
    });
  if (matched) {
    sel.value = String(scopeState.courseId);
    stuState.courseId = Number(scopeState.courseId);
    tasks.push(loadCourseStudents());
  }
  await Promise.allSettled(tasks);
}

function bindScope() {
  document.addEventListener("click", function (ev) {
    const item = ev.target.closest("[data-scope]");
    if (!item) return;
    ev.preventDefault();
    applyScope(item.getAttribute("data-scope"), item.getAttribute("data-scope-name"));
  });
}

/* ============================ 顶栏：账户设置 ============================ */

const ROLE_TEXT = { ADMIN: "管理员", TEACHER: "教师", STUDENT: "学生" };

function setPanelText(panel, text) {
  document.querySelectorAll('[data-panel="' + panel + '"]').forEach(function (el) {
    el.textContent = text;
  });
}

function clearSettingsErrors() {
  const modal = document.getElementById("modal-settings");
  if (!modal) return;
  modal.querySelectorAll(".has-error").forEach(function (el) { el.classList.remove("has-error"); });
  modal.querySelectorAll(".field-msg").forEach(function (el) { el.textContent = ""; });
}

/** 用户是否已经动过表单。动过就不再用后到的接口结果覆盖他正在输入的内容。 */
let settingsTouched = false;

function paintSettings(p) {
  setPanelText("set-username", p.username || "—");
  setPanelText("set-role", (ROLE_TEXT[p.role] || "用户") + (p.studentNo ? " · " + p.studentNo : ""));
  setField("#set-display-name", p.displayName || "");
  setField("#set-email", p.email || "");
  setField("#set-password", "");
}

/**
 * 打开设置时填充资料。
 *
 * 先用**首屏已经取到的**档案立刻画上（loadDashboard 里已经拉过一次 profile），
 * 再打一次接口做校正 —— 否则弹层打开的瞬间会是一屏空字段，
 * 看起来就像「设置里什么都没有」。
 */
async function fillSettings() {
  clearSettingsErrors();
  settingsTouched = false;
  const cached = val(window.__dash && window.__dash.profile, null);
  if (cached) {
    paintSettings(cached);
  } else {
    setPanelText("set-username", "正在读取…");
    setPanelText("set-role", "正在读取…");
  }

  const res = await D.auth.profile();
  if (res.ok) {
    if (!settingsTouched) paintSettings(res.data || {});
    return;
  }
  if (!cached) {
    // 连缓存都没有，说明确实读不到 —— 如实说，不要留一屏看不出状态的空字段
    setPanelText("set-username", "读不到");
    setPanelText("set-role", "读不到");
    toastMsg("资料暂时读不到，关上再打开一次试试", "warning");
  }
}

async function saveSettings() {
  const displayName = fieldVal("#set-display-name");
  const email = fieldVal("#set-email");
  const pwEl = $("#set-password");
  const password = pwEl ? pwEl.value : "";
  clearSettingsErrors();

  let bad = false;
  if (!displayName) { setErr("#set-display-name", "显示名不能为空"); bad = true; }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setErr("#set-email", "邮箱格式看起来不对"); bad = true;
  }
  if (password && password.length < 6) { setErr("#set-password", "密码至少 6 位"); bad = true; }
  if (bad) return;

  // 请求体保持 snake_case。密码留空**不要**带这个键 ——
  // 带了空串，后端会当成「把密码改成空」，而不是「不改密码」。
  const body = { display_name: displayName, email: email };
  if (password) body.new_password = password;

  const btn = $('[data-panel="settings-save"]');
  if (btn) btn.disabled = true;
  const res = await D.auth.updateProfile(body);
  if (btn) btn.disabled = false;
  if (!res.ok) { toastMsg(res.error || "没保存成功，稍后再试", "warning"); return; }

  // 顶栏与侧栏的名字读的是会话缓存，改完立刻同步，否则要刷新才变
  const p = res.data || {};
  const cur = session.user || {};
  session.save({
    token: session.token,
    id: p.id != null ? p.id : cur.id,
    username: p.username || cur.username,
    displayName: p.displayName || displayName,
    role: p.role || cur.role,
    expiresIn: cur.expiresIn,
  });

  toastMsg(password ? "已保存，下次登录请用新密码" : "已保存", "success");
  const close = document.querySelector('#modal-settings [data-close]');
  if (close) close.click();
  await refresh();
}

function bindSettings() {
  // 打开的那一刻再去取真实资料（引擎只负责把弹层显示出来）
  document.addEventListener("click", function (ev) {
    if (!ev.target.closest('[data-modal-open="#modal-settings"]')) return;
    fillSettings();
  });
  // 用户一旦开始输入，就不要再让后到的接口结果盖掉他正在写的内容
  ["#set-display-name", "#set-email", "#set-password"].forEach(function (sel) {
    const el = $(sel);
    if (el) el.addEventListener("input", function () { settingsTouched = true; });
  });
  const save = $('[data-panel="settings-save"]');
  if (save) save.addEventListener("click", saveSettings);
}

/* ============================ 顶栏：全局检索 ============================ */

/**
 * 顶栏搜索框。以前能输入却搜不出任何东西 —— 后端当时也没有检索接口。
 * 现在打到 /api/search：**服务端按角色限定可见范围**，前端只负责呈现与跳转。
 * 这样学生搜不到同学名册，老师也搜不到别人的学生。
 */
const searchState = { timer: 0, seq: 0, q: "" };

function searchBox() { return $('[data-list="search-res"]'); }

function hideSearch() {
  const box = searchBox();
  if (box) { box.hidden = true; box.innerHTML = ""; }
}

function showSearchNote(title, note) {
  const box = searchBox();
  if (!box) return;
  box.innerHTML = '<div class="menu-title">' + esc(title) + "</div>" +
    '<div class="xs" style="padding:2px 10px 8px">' + esc(note) + "</div>";
  box.hidden = false;
  mount(box);
}

function renderSearch(data) {
  const groups = (data && data.groups) || [];
  if (!groups.length) {
    showSearchNote("没有找到「" + ((data && data.query) || "") + "」",
      "换个关键词试试，比如课程名或学生姓名。");
    return;
  }
  const box = searchBox();
  if (!box) return;
  box.innerHTML = groups.map(function (g) {
    return '<div class="menu-title">' + esc(g.label) + "</div>" +
      (g.items || []).map(function (it) {
        return '<button class="menu-item" data-res-target="' + esc(it.target) +
          '" data-res-id="' + esc(it.id) + '" data-res-name="' + esc(it.title) + '"' +
          ' data-icon="' + (it.target === "student" ? "user" : "layers") + '">' +
          esc(it.title) + (it.subtitle ? " · " + esc(it.subtitle) : "") + "</button>";
      }).join("");
  }).join("");
  box.hidden = false;
  mount(box);
}

async function runSearch() {
  const q = searchState.q;
  if (!q) return;
  const seq = ++searchState.seq;
  let res;
  try {
    res = await D.search.query(q);
  } catch (err) {
    res = { ok: false, error: err };
  }
  // 慢请求可能后到：只认最后一次输入的结果，否则结果会和关键词对不上
  if (seq !== searchState.seq) return;
  if (!res.ok) { showSearchNote("搜索", "暂时搜不了，稍后再试。"); return; }
  renderSearch(res.data);
}

function bindSearch() {
  const input = $('[data-panel="search"]');
  if (!input) return;
  input.addEventListener("input", function () {
    const q = input.value.trim();
    searchState.q = q;
    window.clearTimeout(searchState.timer);
    if (!q) { hideSearch(); return; }
    // 边打字边发请求会把接口打满：停下来 250ms 再查
    searchState.timer = window.setTimeout(runSearch, 250);
  });
  input.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { hideSearch(); input.blur(); }
  });
  document.addEventListener("click", function (ev) {
    const item = ev.target.closest("[data-res-target]");
    if (!item) {
      if (!ev.target.closest(".desk-search")) hideSearch();
      return;
    }
    ev.preventDefault();
    const target = item.getAttribute("data-res-target");
    const id = item.getAttribute("data-res-id");
    const name = item.getAttribute("data-res-name");
    hideSearch();
    input.value = "";
    searchState.q = "";
    if (target === "student") { openStudent(id, name); return; }
    applyScope(id, name);
  });
}

/* ============================ 协作全景：分享 ============================ */

/**
 * 「分享」以前是个**说谎**的按钮：点击弹「已复制，可以发给同事了」，
 * 但它什么都没复制 —— 页面上一个字都没进剪贴板。
 *
 * 现在真的把当前协作全景的关键数字整理成一段话复制走；复制不成就如实说失败，
 * 不再给一句不成立的成功提示。
 */
function buildShareText() {
  const dash = window.__dash || {};
  const scenes = val(dash.vision.scenes, []);
  const rules = val(dash.situation.rules, {});
  const ruleList = (rules && rules.rules) || [];
  const enabledRules = ruleList.filter(function (r) { return r.enabled !== false; }).length;
  const pending = num(val(dash.vision.overview, {}).unacknowledged);
  const onDuty = (empState.employees || []).filter(function (e) { return e.enabled !== false; }).length;
  const scope = scopeState.courseId == null ? scopeState.baseName : scopeState.courseName;

  return [
    "【协作全景 · 数字员工协作台】",
    (scenes.length || 0) + " 个教学场景已开启 · " + enabledRules + " 条提醒条件生效",
    onDuty + " 位员工在岗 · 待处理提醒 " + pending + " 条",
    "查看范围：" + (scope || "—"),
  ].join("\n");
}

/** navigator.clipboard 只在安全上下文可用，http 下要用老办法兜底。 */
function legacyCopy(text) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch (_) {
    return false;
  }
}

function sharePanorama() {
  const text = buildShareText();
  const done = function () { toastMsg("已复制，可以发给同事了", "success"); };
  const fail = function () { toastMsg("复制没成功，可以手动选中页面内容再复制", "warning"); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text)
      .then(done)
      .catch(function () { (legacyCopy(text) ? done : fail)(); });
    return;
  }
  (legacyCopy(text) ? done : fail)();
}

function bindShare() {
  document.addEventListener("click", function (ev) {
    const btn = ev.target.closest('[data-panel="share"]');
    if (!btn) return;
    ev.preventDefault();
    sharePanorama();
  });
}

/* ============================ P1 · 批改质量复核 ============================ */

/**
 * 把「机器初判」与「教师最终给分」的对照，翻成用户看得懂的三块数字。
 * 注意：这里只呈现**计数**，不呈现任何比率 —— 比率在小样本下没有意义，
 * 后端用 sampleEnough 明确挡掉了硬算比率这件事，视图层也不越界。
 */
function gradingTiles(q) {
  const scanned = num(q.scanCount);
  const need = num(q.needReviewCount);
  const low = num(q.lowConfidenceCount);
  return [
    {
      label: "已自动初判",
      value: scanned,
      foot: "共收到 " + num(q.submissionCount) + " 份提交",
    },
    {
      label: "建议你复核",
      value: need,
      foot: need ? "初判拿不准的先挑出来" : "暂时没有要复核的",
    },
    {
      label: "拿不准的题目",
      value: low,
      foot: low ? "建议你亲自看一眼" : "没有拿不准的题目",
    },
  ];
}

async function loadGradingQuality(role) {
  const box = $('[data-panel="grading-quality"]');
  if (!box) return;
  if (role === "STUDENT") { box.innerHTML = ""; return; }
  const note = $('[data-panel="grading-note"]');
  try {
    // 跟着顶栏的「查看范围」走：选了具体课程就只看那门课的提交
    const res = await D.review.gradingQuality(scopeState.courseId);
    if (!res.ok) {
      box.innerHTML = '<div class="card" style="grid-column:1 / -1"><div class="card-bd">' +
        errBlock("批改质量", res) + "</div></div>";
      if (note) note.textContent = "";
      mount(box);
      return;
    }
    const q = res.data || {};
    box.innerHTML = gradingTiles(q).map(function (t) {
      return '<div class="card"><div class="card-bd">' +
        '<div class="stat-label">' + esc(t.label) + "</div>" +
        '<div class="stat-value num" data-count-to="' + t.value + '">' + t.value + "</div>" +
        '<div class="xxl" style="margin-top:6px">' + esc(t.foot) + "</div>" +
        "</div></div>";
    }).join("");
    if (note) {
      const avg = q.averageScore == null ? null : Number(q.averageScore);
      note.textContent = q.sampleEnough === true
        ? "已批改 " + num(q.gradedCount) + " 份" + (avg == null ? "" : " · 平均分 " + avg.toFixed(1))
        : (q.note || "批改记录还不多，上面的数字先看个大概，多攒一些会更准。");
    }
    mount(box);
  } catch (err) {
    // 兜底必须把骨架换掉。以前这里只打 console.warn，一旦抛错
    // 骨架就永远留在页面上 —— 用户看到的是「一直加载不出来」。
    console.warn("[desktop] grading-quality", err);
    box.innerHTML = '<div class="card" style="grid-column:1 / -1"><div class="card-bd">' +
      errBlock("批改质量", { error: err }) + "</div></div>";
    if (note) note.textContent = "";
    mount(box);
  }
}

/* ============================ P1 · 学生学情档案 ============================ */

const stuState = { courses: null, courseId: null };

async function loadCourseStudents() {
  const list = $('[data-panel="stu-list"]');
  if (!list) return;
  if (stuState.courseId == null) {
    list.innerHTML = emptyBlock("还没有可查看的课程", "课程挂上之后，这里会列出课程里的学生。");
    mount(list);
    return;
  }
  list.innerHTML = '<div class="skeleton" style="height:42px"></div>';
  // 取数自己兜住异常：本函数是被 loadStudents 的 try 包着的，
  // 但一旦抛出就连「学生名单」的错误提示都渲染不出来，骨架会留下。
  let res;
  try {
    res = await D.teaching.courseStudents(stuState.courseId);
  } catch (err) {
    res = { ok: false, error: err };
  }
  if (!res.ok) {
    if (res.error) console.warn("[desktop] course students", res.error);
    list.innerHTML = errBlock("学生名单", res);
    mount(list);
    return;
  }
  const rows = Array.isArray(res.data) ? res.data : [];
  if (!rows.length) {
    list.innerHTML = emptyBlock("这门课还没有学生", "等学生选课之后，这里会列出名单。");
    mount(list);
    return;
  }
  list.innerHTML = rows.map(function (s) {
    const name = s.displayName || s.username || "学生";
    return '<div class="list-item">' +
      '<span class="stat-icon" data-icon="user"></span>' +
      '<div class="li-main">' +
        '<div class="li-title">' + esc(name) + "</div>" +
        '<div class="li-desc">' + esc(s.username || "—") + "</div>" +
      "</div>" +
      '<button class="btn btn-secondary btn-sm" data-stu-open="' + esc(s.id) +
        '" data-stu-name="' + esc(name) + '">看学情</button>' +
      "</div>";
  }).join("");
  mount(list);
}

async function loadStudents(role) {
  const sel = $('[data-panel="stu-course"]');
  const list = $('[data-panel="stu-list"]');
  if (!sel || !list) return;
  if (role === "STUDENT") { list.innerHTML = ""; return; }
  try {
    if (!stuState.courses) {
      const res = await fetchCoursesForRole(role);
      if (!res.ok) {
        if (res.error) console.warn("[desktop] courses", res.error);
        sel.innerHTML = '<option value="">读不到课程</option>';
        list.innerHTML = errBlock("课程", res);
        mount(list);
        return;
      }
      stuState.courses = res.data;
      sel.innerHTML = stuState.courses.length
        ? stuState.courses.map(function (c) {
            return '<option value="' + esc(c.id) + '">' + esc(c.name) + "</option>";
          }).join("")
        : '<option value="">还没有课程</option>';
      // 顶栏「查看范围」已经选过就直接沿用，否则默认第一门
      const inScope = stuState.courses.some(function (c) {
        return String(c.id) === String(scopeState.courseId);
      });
      stuState.courseId = inScope
        ? scopeState.courseId
        : (stuState.courses.length ? stuState.courses[0].id : null);
      if (inScope) sel.value = String(scopeState.courseId);
    }
    await loadCourseStudents();
  } catch (err) {
    // 同上：兜底必须落地成可读内容，不能把骨架留在页面上。
    console.warn("[desktop] students", err);
    sel.innerHTML = '<option value="">读不到课程</option>';
    list.innerHTML = errBlock("学生名单", { error: err });
    mount(list);
  }
}

/**
 * 打开某位学生的学情抽屉。
 * 课堂参与那块**不回显后端给的说明文本** —— 那段话里带着内部字段名；
 * 这里改成按真实字段（有没有学号、有没有绑定座位）分情况给出可执行的提示。
 */
async function openStudent(studentId, name) {
  const title = $('[data-panel="stu-drawer-title"]');
  if (title) title.textContent = (name || "学生") + " · 学情";
  const trigger = document.getElementById("stu-drawer-trigger");
  if (trigger) trigger.click();

  const box = $('[data-panel="stu-detail"]');
  if (!box) return;
  box.innerHTML = '<div class="skeleton" style="height:60px"></div>';
  mount(box);

  try {
    const [pRes, eRes] = await Promise.all([
      D.insight.studentProfile(studentId),
      D.insight.studentEngagement(studentId),
    ]);
    const p = (pRes.ok && pRes.data) || {};
    const e = (eRes.ok && eRes.data) || {};
    const avg = p.averageScore == null ? null : Number(p.averageScore);

    let h = '<div class="title" style="margin-bottom:8px">成绩</div>' +
      '<dl class="emp-kv">' +
      "<dt>已批改</dt><dd class=\"num\">" + num(p.gradeCount) + " 份</dd>" +
      "<dt>平均分</dt><dd class=\"num\">" + (avg == null ? "—" : avg.toFixed(1)) + "</dd>" +
      "<dt>在学课程</dt><dd class=\"num\">" + ((p.courses || []).length) + " 门</dd>" +
      "</dl>";

    const low = p.lowScoreAssignments || [];
    if (low.length) {
      h += '<div class="divider"></div><div class="title" style="margin-bottom:8px">需要留意的作业</div>' +
        '<div class="stack-sm">' + low.slice(0, 6).map(function (g) {
          const total = Number(g.totalPoints) || 100;
          return '<div class="row-between"><span class="sub">' +
            esc(g.assignmentTitle || "未命名作业") + '</span><span class="num xs">' +
            esc(String(g.score)) + " / " + esc(String(total)) + "</span></div>";
        }).join("") + "</div>";
    }

    h += '<div class="divider"></div><div class="title" style="margin-bottom:8px">课堂参与</div>';
    if (!eRes.ok) {
      h += '<div class="xs">课堂参与情况暂时读不到，点右上角「刷新」可以重试。</div>';
    } else if (num(e.eventTotal) > 0) {
      h += '<div class="stack-sm">' + (e.scenes || []).map(function (s) {
        return '<div class="row-between"><span class="sub">' + esc(SCENE[s.scene] || s.scene) +
          '</span><span class="num xs">' + num(s.count) + " 次</span></div>";
      }).join("") + "</div>";
    } else if (!e.studentNo) {
      h += '<div class="xs">这位学生还没有登记学号。补上学号之后，就能把他的课堂表现对到人。</div>';
    } else if (num(e.identityCount) === 0) {
      h += '<div class="xs">这位学生还没有绑定课堂座位。绑定之后，课堂表现就会记到他名下。</div>';
    } else {
      h += '<div class="xs">这位学生暂时没有需要记录的课堂情况。</div>';
    }

    box.innerHTML = h;
    mount(box);
  } catch (err) {
    console.warn("[desktop] student detail", err);
    if (box) {
      box.innerHTML = emptyBlock("这位学生的学情暂时读不到", "点右上角「刷新」可以再试一次。");
      mount(box);
    }
  }
}

function bindStudents() {
  const sel = $('[data-panel="stu-course"]');
  if (sel) {
    sel.addEventListener("change", function () {
      stuState.courseId = sel.value ? Number(sel.value) : null;
      loadCourseStudents();
    });
  }
  document.addEventListener("click", function (ev) {
    const b = ev.target.closest("[data-stu-open]");
    if (!b) return;
    ev.preventDefault();
    openStudent(b.getAttribute("data-stu-open"), b.getAttribute("data-stu-name"));
  });
}

/* ============================ P3 · 数字员工（可编辑档案） ============================ */

const empState = {
  employees: [],   // 生效档案（默认 ⊕ 本地覆盖）
  tools: null,     // 当前角色可用能力的真实清单（与后端同源，用于弹窗勾选）
  current: null,   // 协作台当前对话的员工 code
  editCode: null,  // 正在编辑的员工 code；null = 创建模式
};

/** 引擎只导出了 mount，弹层 / Toast 都是内部函数 → 用「模拟点击」驱动，不改引擎。 */
function toastMsg(msg, type) {
  const b = document.createElement("button");
  b.setAttribute("data-toast", msg);
  b.setAttribute("data-toast-type", type || "success");
  b.style.display = "none";
  document.body.appendChild(b);
  b.click();
  window.setTimeout(function () { b.remove(); }, 0);
}

function avatarHtml(e, large) {
  return (
    '<span class="emp-avatar' + (large ? " emp-avatar-lg" : "") +
    (e.tint ? " " + esc(e.tint) : "") + '">' +
    '<span data-icon="' + esc(e.icon) + '" class="ico-lg"></span>' +
    '<span class="emp-dot ' + (e.enabled ? "on" : "off") + '"></span></span>'
  );
}

function loadBarHtml(w, maxW) {
  const pct = maxW ? Math.round((w.value / maxW) * 100) : 0;
  return (
    '<div class="emp-load"><span>' + esc(w.label) + "</span>" +
    '<span class="progress progress-thin"><span class="progress-bar" data-progress="' +
    pct + '" style="width:' + pct + '%"></span></span>' +
    '<span class="num">' + esc(w.text) + "</span></div>"
  );
}

/** 能力芯片：显示的是「能帮你做的事」，不是内部工具名。 */
function chipsHtml(e, max) {
  const list = max ? e.tools.slice(0, max) : e.tools;
  if (!list.length) return "";
  return (
    '<div class="emp-chip-row">' +
    list.map(function (t) { return '<span class="emp-chip">' + esc(toolLabel(t)) + "</span>"; }).join("") +
    "</div>"
  );
}

/** 当前对话的员工（协作台会话头 / 气泡头像都用它）。 */
function currentEmployee() {
  const list = empState.employees.filter(function (e) { return e.enabled; });
  if (!list.length) return null;
  return list.filter(function (e) { return e.code === empState.current; })[0] || list[0];
}

/** P0 · 在岗员工卡（紧凑）。 */
function flowCard(e, wl, maxW) {
  const w = wl.filter(function (x) { return x.code === e.code; })[0] ||
    { label: "—", value: 0, text: "—" };
  return (
    '<div class="emp-card" data-emp="' + esc(e.code) + '">' +
      '<div class="emp-card-top">' + avatarHtml(e) +
        '<div style="min-width:0;flex:1">' +
          '<div class="emp-card-name">' + esc(e.name) + "</div>" +
          '<div class="emp-card-role">' + esc(e.role) + "</div>" +
        "</div>" +
      "</div>" +
      chipsHtml(e, 3) +
      loadBarHtml(w, maxW) +
      '<div class="row" style="gap:var(--sp-2)">' +
        '<button class="btn btn-secondary btn-sm" data-emp-edit="' + esc(e.code) +
          '" data-icon="edit">调整</button>' +
        '<button class="btn btn-ghost btn-sm" data-emp-pick="' + esc(e.code) +
          '" data-icon="message">找它办事</button>' +
      "</div>" +
    "</div>"
  );
}

/** P3 · 名册卡（详细）。 */
function rosterCard(e, wl, maxW) {
  const w = wl.filter(function (x) { return x.code === e.code; })[0] ||
    { label: "—", value: 0, text: "—" };
  return (
    '<div class="emp-card' + (e.enabled ? "" : " is-off") + '" data-emp="' + esc(e.code) + '">' +
      '<div class="emp-card-top">' + avatarHtml(e, true) +
        '<div style="min-width:0;flex:1">' +
          '<div class="emp-card-name">' + esc(e.name) + "</div>" +
          '<div class="emp-card-role">' + esc(e.role) + "</div>" +
        "</div>" +
        '<button class="btn btn-ghost btn-icon btn-sm" data-emp-edit="' + esc(e.code) +
          '" data-icon="edit" aria-label="调整"></button>' +
      "</div>" +
      '<p class="emp-persona">' + esc(e.persona || "（还没写职责说明）") + "</p>" +
      '<dl class="emp-kv">' +
        "<dt>负责的事</dt><dd>" + (e.tools.length ? esc(e.tools.length + " 项") : "—") + "</dd>" +
        "<dt>能查看</dt><dd>" + esc(e.domain || "—") + "</dd>" +
        "<dt>涉及改动</dt><dd>" + esc(writePolicyLabel(e.writePolicy)) + "</dd>" +
        "<dt>状态</dt><dd>" + (e.enabled
          ? '<span class="tag tag-success tag-outline">在岗</span>'
          : '<span class="tag tag-outline">已停用</span>') + "</dd>" +
      "</dl>" +
      chipsHtml(e) +
      loadBarHtml(w, maxW) +
    "</div>"
  );
}

/** P3 · 员工能力一览表的一行。 */
function matrixRow(e) {
  const tone = e.writePolicy === "read" ? "tag-outline" : "tag-warning tag-outline";
  return (
    "<tr>" +
      '<td class="td-strong">' + esc(e.name) + "</td>" +
      "<td>" + (e.tools.length
        ? '<div class="emp-chip-row">' + e.tools.map(function (t) {
            return '<span class="emp-chip">' + esc(toolLabel(t)) + "</span>";
          }).join("") + "</div>"
        : '<span class="sub">—</span>') + "</td>" +
      '<td class="sub">' + esc(e.domain || "—") + "</td>" +
      '<td><span class="tag ' + tone + '">' + esc(writePolicyLabel(e.writePolicy)) + "</span></td>" +
      '<td class="sub">' + esc(e.fallback || "—") + "</td>" +
    "</tr>"
  );
}

function renderEmployees(dash) {
  const list = empState.employees;
  const wl = dash ? empWorkload(dash) : [];
  const maxW = Math.max.apply(null, wl.map(function (x) { return x.value; }).concat([1]));
  const active = list.filter(function (e) { return e.enabled; });

  const flow = $('[data-list="emp-flow"]');
  if (flow) {
    flow.innerHTML = active.map(function (e) { return flowCard(e, wl, maxW); }).join("");
    mount(flow);
  }

  const roster = $('[data-list="emp-roster"]');
  if (roster) {
    roster.innerHTML = list.map(function (e) { return rosterCard(e, wl, maxW); }).join("");
    mount(roster);
  }

  const matrix = $('[data-list="emp-matrix"]');
  if (matrix) {
    matrix.innerHTML = list.map(matrixRow).join("");
    mount(matrix);
  }

  const hint = $('[data-panel="roster-hint"]');
  if (hint) {
    hint.textContent = active.length + " 位在岗 · " + (list.length - active.length) + " 位已停用";
  }

  // 顶栏与指挥台的「员工在岗」计数
  document.querySelectorAll('[data-panel="emp-count"]').forEach(function (el) {
    el.textContent = active.length + " / " + list.length;
  });

  // 切换员工菜单：点一下就去协作台找它办事
  const sw = $('[data-list="emp-switch"]');
  if (sw) {
    sw.innerHTML =
      '<div class="menu-title">要跟谁说话</div>' +
      active.map(function (e) {
        return '<button class="menu-item" data-emp-pick="' + esc(e.code) +
          '" data-icon="' + esc(e.icon) + '">' + esc(e.name) + " · " + esc(e.role) + "</button>";
      }).join("");
    mount(sw);
  }

  // 派任务弹窗的「交给谁」：用真实名册，不用硬编码名单
  const as = $('[data-panel="dispatch-assignee"]');
  if (as) {
    as.innerHTML = '<option value="">请选择…</option>' +
      active.map(function (e) {
        return "<option>" + esc(e.name) + " · " + esc(e.role) + "</option>";
      }).join("");
  }

  // 协作台侧栏「还能找谁帮忙」：真实名册 + 启停状态
  const peers = $('[data-panel="peers"]');
  if (peers) {
    const cur = currentEmployee();
    peers.innerHTML = list.length
      ? list.map(function (e) {
          const me = cur && e.code === cur.code;
          return '<div class="row-between"><span class="sub">' + esc(e.name) + " · " + esc(e.role) +
            "</span>" + (me
              ? '<span class="tag tag-success tag-outline">正在对话</span>'
              : (e.enabled
                ? '<button class="btn btn-ghost btn-sm" data-emp-pick="' + esc(e.code) + '">去找它</button>'
                : '<span class="tag tag-outline">已停用</span>')) + "</div>";
        }).join("")
      : '<div class="xs">名册还是空的，先去「数字员工」里加一位。</div>';
    mount(peers);
  }

  const ts = $('[data-panel="tool-summary"]');
  if (ts) {
    ts.textContent = "共 " + list.length + " 位员工，正在为你工作的是 " + active.length + " 位";
  }

  renderChatHead();
}

/* ----------------------------- 档案编辑交互 ----------------------------- */

function fieldVal(sel) {
  const el = $(sel);
  return el ? String(el.value || "").trim() : "";
}

function setField(sel, v) {
  const el = $(sel);
  if (el) el.value = v == null ? "" : v;
}

function setErr(sel, msg) {
  const el = $(sel);
  if (!el) return;
  const field = el.closest(".field");
  if (field) {
    field.classList.add("has-error");
    const m = field.querySelector(".field-msg");
    if (m) m.textContent = msg;
  }
}

function clearErrors() {
  document.querySelectorAll("#modal-employee .has-error").forEach(function (el) {
    el.classList.remove("has-error");
  });
  document.querySelectorAll("#modal-employee .field-msg").forEach(function (el) {
    el.textContent = "";
  });
}

function fillSelect(sel, opts, value) {
  const el = $(sel);
  if (!el) return;
  el.innerHTML = opts.map(function (o) {
    return '<option value="' + esc(o.value) + '"' + (o.value === value ? " selected" : "") +
      ">" + esc(o.label) + "</option>";
  }).join("");
}

function openEmployeeModal(code) {
  const list = empState.employees;
  const e = code ? list.filter(function (x) { return x.code === code; })[0] : null;
  empState.editCode = e ? e.code : null;

  const title = $('[data-panel="emp-modal-title"]');
  if (title) title.textContent = e ? "编辑员工 · " + e.name : "创建数字员工";

  setField("#emp-f-name", e ? e.name : "");
  setField("#emp-f-role", e ? e.role : "");
  setField("#emp-f-code", e ? e.code : "");
  setField("#emp-f-order", e ? (e.order || 9) : list.length + 1);
  setField("#emp-f-persona", e ? e.persona : "");
  setField("#emp-f-domain", e ? (e.domain || "") : "");
  setField("#emp-f-fallback", e ? (e.fallback || "") : "");

  const builtin = e ? isBuiltin(e.code) : false;
  const codeInput = $("#emp-f-code");
  if (codeInput) codeInput.disabled = builtin;
  const codeHint = $('[data-panel="emp-code-hint"]');
  if (codeHint) {
    codeHint.textContent = builtin
      ? "系统内置员工，代号不可改"
      : "系统内部识别用，只能用英文小写字母、数字、- 或 _";
  }

  fillSelect("#emp-f-icon", ICON_CHOICES.map(function (v) {
    return { value: v, label: v };
  }), e ? e.icon : "users");
  fillSelect("#emp-f-tint", TINT_CHOICES, e ? e.tint : "");
  fillSelect("#emp-f-write", WRITE_POLICIES, e ? e.writePolicy : "read");

  const box = $("#emp-f-tools");
  if (box) {
    const all = (empState.tools && empState.tools.tools) || [];
    const checked = (e && e.tools) || [];
    box.innerHTML = all.length
      ? all.map(function (t) {
          return '<label class="check"><input type="checkbox" value="' + esc(t.name) + '"' +
            (checked.indexOf(t.name) >= 0 ? " checked" : "") +
            '><span class="box"></span><span>' + esc(toolLabel(t.name)) +
            (t.readOnly === false || t.requiresConfirmation
              ? ' <span class="xs">· 会先问你</span>' : "") +
            "</span></label>";
        }).join("")
      : '<div class="xs">暂时读不到可分配的事，稍后刷新再试。</div>';
  }

  const en = document.getElementById("emp-f-enabled");
  if (en) en.checked = e ? !!e.enabled : false;

  const del = document.getElementById("emp-delete");
  if (del) del.hidden = !e || builtin;

  clearErrors();

  const trigger = document.getElementById("emp-modal-trigger");
  if (trigger) trigger.click();
}

function collectEmployee() {
  const tools = [];
  document.querySelectorAll("#emp-f-tools input:checked").forEach(function (c) {
    tools.push(c.value);
  });
  const en = document.getElementById("emp-f-enabled");
  return makeEmployee({
    code: empState.editCode || fieldVal("#emp-f-code"),
    name: fieldVal("#emp-f-name"),
    role: fieldVal("#emp-f-role"),
    persona: fieldVal("#emp-f-persona"),
    domain: fieldVal("#emp-f-domain"),
    fallback: fieldVal("#emp-f-fallback"),
    icon: fieldVal("#emp-f-icon") || "users",
    tint: fieldVal("#emp-f-tint"),
    writePolicy: fieldVal("#emp-f-write") || "read",
    enabled: !!(en && en.checked),
    tools: tools,
    order: Number(fieldVal("#emp-f-order")) || 9,
  });
}

function validateEmployee(emp) {
  if (!emp.name || emp.name.length < 2) { setErr("#emp-f-name", "显示名至少 2 个字"); return false; }
  if (!emp.role) { setErr("#emp-f-role", "岗位称谓必填"); return false; }
  if (!emp.code) { setErr("#emp-f-code", "员工代号必填"); return false; }
  if (!/^[a-z0-9_-]+$/.test(emp.code)) {
    setErr("#emp-f-code", "只能用英文小写字母、数字、- 或 _");
    return false;
  }
  if (!empState.editCode && empState.employees.some(function (x) {
    return x.code === emp.code;
  })) {
    setErr("#emp-f-code", "该代号已被占用");
    return false;
  }
  if (!emp.persona) {
    setErr("#emp-f-persona", "请写清这个岗位负责什么、不负责什么");
    return false;
  }
  return true;
}

function persistEmployees(next, okMsg) {
  if (!saveEmployees(next)) {
    toastMsg("保存失败：本机浏览器存储不可用", "error");
    return false;
  }
  empState.employees = loadEmployees();
  renderEmployees(window.__dash);
  empState.editCode = null;
  const ov = document.getElementById("modal-employee");
  if (ov) {
    const closeBtn = ov.querySelector("[data-close]");
    if (closeBtn) closeBtn.click();
  }
  toastMsg(okMsg, "success");
  return true;
}

function saveEmployee() {
  clearErrors();
  const emp = collectEmployee();
  if (!validateEmployee(emp)) {
    toastMsg("请检查标红的字段", "error");
    return;
  }
  const isEdit = !!empState.editCode;
  persistEmployees(upsertEmployee(empState.employees, emp),
    (isEdit ? "已保存 · " : "已创建 · ") + emp.name);
}

function deleteEmployee() {
  const code = empState.editCode;
  if (!code || isBuiltin(code)) return;
  persistEmployees(removeEmployee(empState.employees, code), "已删除 · " + code);
}

/** 切到某位员工：协作台换人，并跳过去。 */
function selectEmployee(code) {
  const e = empState.employees.filter(function (x) { return x.code === code; })[0];
  if (!e) return;
  empState.current = code;
  renderChatHead();
  renderEmployees(window.__dash);
  const nav = document.querySelector('[data-goto="p2"]');
  if (nav) nav.click();
  toastMsg("现在由 " + e.name + " 接待你", "success");
}

function bindEmployees() {
  document.addEventListener("click", function (ev) {
    const pick = ev.target.closest("[data-emp-pick]");
    if (pick) {
      ev.preventDefault();
      selectEmployee(pick.getAttribute("data-emp-pick"));
      return;
    }
    if (ev.target.closest("[data-emp-new]")) {
      ev.preventDefault();
      openEmployeeModal(null);
      return;
    }
    const ed = ev.target.closest("[data-emp-edit]");
    if (ed) {
      ev.preventDefault();
      openEmployeeModal(ed.getAttribute("data-emp-edit"));
      return;
    }
    if (ev.target.closest("#emp-save")) {
      ev.preventDefault();
      saveEmployee();
      return;
    }
    if (ev.target.closest("#emp-delete")) {
      ev.preventDefault();
      deleteEmployee();
    }
  });
}

function renderP3(dash) {
  renderEmployees(dash);
}

/* ============================ P2 · 协作台（Agent 运行时） ============================ */

const chatState = { sessionId: null, busy: false };

/** 把会话头换成当前对话的员工。 */
function renderChatHead() {
  const e = currentEmployee();
  if (!e) return;
  const nameEl = $('[data-panel="chat-emp"]');
  if (nameEl) nameEl.textContent = e.name;
  const roleEl = $('[data-panel="chat-emp-role"]');
  if (roleEl) roleEl.textContent = e.role;
  const av = $('[data-panel="chat-avatar"]');
  if (av) {
    av.className = "emp-avatar" + (e.tint ? " " + e.tint : "");
    av.innerHTML = '<span data-icon="' + esc(e.icon) + '" class="ico-lg"></span>' +
      '<span class="emp-dot ' + (e.enabled ? "on" : "off") + '"></span>';
    mount(av);
  }
}

/** 对话气泡里的头像。 */
function turnAvatar() {
  const e = currentEmployee();
  return e
    ? avatarHtml(e)
    : '<span class="emp-avatar"><span data-icon="message" class="ico-lg"></span></span>';
}

function renderChat(dash) {
  const stream = $("#chat-stream");
  if (!stream) return;
  if (!stream.getAttribute("data-ready")) {
    stream.setAttribute("data-ready", "1");
    stream.innerHTML = welcomeTurn();
    mount(stream);
  }
}

function welcomeTurn() {
  const e = currentEmployee();
  const who = e ? e.name + " · " + e.role : "你的数字员工";
  return (
    '<div class="emp-turn emp-turn-bot">' +
    turnAvatar() +
    '<div class="emp-bot-body">' +
    '<div class="emp-bot-meta"><span>' + esc(who) + "</span><span>·</span><span>在线</span></div>" +
    '<div class="emp-bot-text"><p>跟我说说你想做什么就行。我会先把打算怎么做讲清楚，' +
    "做完把结果交给你；需要你点头的地方，我会停下来问你。</p>" +
    '<p class="xs">例如：<b>哪些学生需要我关注？</b> · <b>帮我看看这门课的作业情况</b></p></div>' +
    "</div></div>"
  );
}

function pendingTurn(text) {
  const e = currentEmployee();
  return (
    '<div class="emp-turn emp-turn-user"><div class="emp-bubble-user">' + esc(text) + "</div></div>" +
    '<div class="emp-turn emp-turn-bot" id="chat-pending">' +
    turnAvatar() +
    '<div class="emp-bot-body"><div class="emp-bot-meta"><span>' +
    esc(e ? e.name : "员工") + '</span><span>·</span><span>正在处理…</span></div>' +
    '<div class="emp-bot-text"><p class="xs">我正在看这件事该怎么安排，稍等。</p></div></div></div>'
  );
}

function botTurn(res) {
  const e = currentEmployee();
  const ok = res.ok;
  const d = res.data || {};
  const status = d.status || (ok ? "COMPLETED" : "FAILED");

  let meta = "<span>" + esc(e ? e.name : "员工") + "</span><span>·</span><span>" +
    esc(statusText(status)) + "</span>";

  let body = "";

  if (!ok) {
    if (res && res.error) console.warn("[desktop] chat", res.error);
    body =
      '<div class="alert alert-danger"><span class="a-ic" data-icon="alert-triangle"></span>' +
      '<div><div class="a-title">这次没处理成功</div><div class="a-body">' +
      "可以再说一遍或者换个说法；如果一直不行，请找管理员看看。</div></div></div>";
  } else {
    if (d.answer) {
      body += '<div class="emp-bot-text"><p>' + esc(d.answer) + "</p></div>";
    }

    // 处理过程：只说做了几步、顺不顺利，不暴露内部工具名与耗时
    const steps = d.executedSteps || [];
    const plan = d.plan || {};
    const planSteps = plan.steps || [];
    const rows = steps.length ? steps : planSteps;
    if (rows.length) {
      body +=
        '<div class="emp-trace"><div class="emp-trace-hd"><span data-icon="list" class="ico-sm"></span>' +
        "<b>它是怎么做的</b><span class=\"spacer\"></span><span>共 " + rows.length + " 步</span></div>" +
        '<div class="emp-trace-bd">' +
        rows.map(function (s, i) {
          const st = String(s.status || "").toUpperCase();
          const isFail = st === "FAILED" || st === "REJECTED";
          const isWait = st === "PENDING" || st === "NEEDS_CONFIRM";
          const ico = isFail ? "x-circle" : isWait ? "alert-triangle" : "check-circle";
          const cls = isFail ? "is-fail" : isWait ? "is-wait" : "";
          return (
            '<div class="emp-step ' + cls + '"><span class="si" data-icon="' + ico + '"></span>' +
            '<span class="sn">第 ' + (i + 1) + " 步</span>" +
            '<span class="sl">' + esc(st ? statusText(st) : "已完成") + "</span></div>"
          );
        }).join("") +
        "</div></div>";
    }

    // 需要你点头的事
    const need = d.requiresConfirmation || [];
    if (d.confirmationRequired || need.length) {
      body +=
        '<div class="emp-gate"><span class="gi" data-icon="shield"></span><div>' +
        "<b>有 " + need.length + " 件事要你点头</b>" +
        "<p>你同意之后才会真正执行，在那之前什么都没有改动。</p>" +
        '<div class="row-wrap" style="margin-top:8px">' +
        '<button class="btn btn-primary btn-sm" data-chat-confirm data-icon="check">同意并继续</button>' +
        '<button class="btn btn-ghost btn-sm" data-toast="已驳回，什么都没有改动" data-toast-type="warning">先不要</button>' +
        "</div></div></div>";
    }

    // 引用
    const cites = d.citations || [];
    if (cites.length) {
      body +=
        '<div class="emp-cites">' + cites.slice(0, 4).map(function (c) {
          return (
            '<span class="emp-cite"><span data-icon="file" class="ico-sm"></span>' +
            esc(c.fileName || c.source || "课程资料") +
            (c.pageStart ? ' <span class="cn">p.' + esc(c.pageStart) + "</span>" : "") +
            "</span>"
          );
        }).join("") + "</div>";
    }

    // 参考过的过往经验
    const mem = d.memory || {};
    if (d.memoryCount || mem.usedCount) {
      body +=
        '<div class="xs" style="margin-top:8px">参考了 ' +
        esc(d.memoryCount != null ? d.memoryCount : mem.usedCount) + " 条过往经验</div>";
    }

    // 答不上来时如实说明，不伪造回答
    if (String(status).toUpperCase() === "NEEDS_INPUT") {
      body +=
        '<div class="alert alert-warning"><span class="a-ic" data-icon="alert-triangle"></span>' +
        '<div><div class="a-title">它还答不上来</div>' +
        '<div class="a-body">这次没能把你的意思理清楚，所以什么都没有做。' +
        "试着说具体一点：哪门课、哪位学生、你想知道什么。</div></div></div>";
    }
  }

  return (
    '<div class="emp-turn emp-turn-bot">' + turnAvatar() +
    '<div class="emp-bot-body"><div class="emp-bot-meta">' + meta + "</div>" + body + "</div></div>"
  );
}

function updateTaskPanel(res) {
  const box = $('[data-panel="task-kv"]');
  if (!box) return;
  const d = (res && res.data) || {};
  const conf = d.confidence != null && d.confidence !== ""
    ? Math.round(Number(d.confidence) * 100) + "%"
    : "—";
  box.innerHTML =
    "<dt>状态</dt><dd>" + esc(statusText(d.status || (res && res.ok ? "COMPLETED" : "FAILED"))) + "</dd>" +
    "<dt>把握程度</dt><dd class=\"num\">" + esc(conf) + "</dd>" +
    "<dt>用到的经验</dt><dd class=\"num\">" + esc(d.memoryCount != null ? d.memoryCount : 0) + " 条</dd>" +
    "<dt>处理时间</dt><dd>" + esc(fmtDateTime(new Date().toISOString())) + "</dd>";

  // 经验面板：只做计数对齐，明细未开放时如实说明，不编造条目
  const n = d.memoryCount != null ? Number(d.memoryCount) : 0;
  const memBadge = $('[data-panel="mem-count"]');
  if (memBadge) memBadge.textContent = String(n);
  const memBox = $('[data-panel="memory"]');
  if (memBox) {
    memBox.innerHTML =
      n > 0
        ? '<div class="xs">这次参考了 <b class="num">' + esc(n) + "</b> 条过往经验。</div>"
        : emptyBlock("这次没有用到过往经验", "多跟员工聊几次，它参考过的历史记录会显示在这里。");
    mount(memBox);
  }
}

async function sendChat(question, opts) {
  if (chatState.busy || !question.trim()) return;
  const stream = $("#chat-stream");
  if (!stream) return;

  chatState.busy = true;
  chatState.lastQuestion = question;
  stream.insertAdjacentHTML("beforeend", pendingTurn(question));
  const pend = $("#chat-pending");
  mount(stream);
  stream.scrollTop = stream.scrollHeight;

  const res = await D.agent.chat(question, {
    sessionId: chatState.sessionId,
    confirm: !!(opts && opts.confirm),
  });
  const d = (res && res.data) || {};
  if (d.memory && d.memory.sessionId) chatState.sessionId = d.memory.sessionId;

  if (pend) pend.remove();
  stream.insertAdjacentHTML("beforeend", botTurn(res));
  mount(stream);
  updateTaskPanel(res);
  stream.scrollTop = stream.scrollHeight;
  chatState.busy = false;
  // 抽屉里的运行详情是二次取数，放在最后且不阻塞对话渲染
  updateContextDrawer(res);
}

/* ============================ P2 · 会话上下文抽屉 ============================ */

/**
 * 用真实记录填充「本次详情」抽屉。
 * 数据来自运行与步骤接口，失败只降级抽屉本身，不影响已经渲染完的对话。
 * 抽屉里只出现用户看得懂的东西：它给了什么结论、做了几步、顺不顺利。
 */
async function updateContextDrawer(res) {
  const box = $('[data-panel="ctx"]');
  if (!box) return;
  const rid = res && res.data ? res.data.runId : null;
  if (rid == null) {
    box.innerHTML = emptyBlock("还没有记录",
      "在协作台聊一句，这里会显示这次处理的结果和用到的员工。");
    mount(box);
    return;
  }

  box.innerHTML = '<div class="skeleton" style="height:52px"></div>';
  const [runRes, callsRes] = await Promise.all([D.agent.run(rid), D.agent.toolCalls(rid)]);
  const run = (runRes.ok && runRes.data) || {};
  const calls = callsRes.ok && Array.isArray(callsRes.data) ? callsRes.data : [];
  const failed = calls.filter(function (c) { return c.error; }).length;

  let h = '<div class="xs">你说了什么</div><div style="margin-top:4px">' +
    esc(run.inputSummary || (res.data && res.data.question) || "—") + "</div>";

  if (run.outputSummary) {
    h += '<div class="alert alert-info" style="margin-top:var(--sp-3)">' +
      '<span class="a-ic" data-icon="info"></span><div>' +
      '<div class="a-title">它最后给出的结果</div>' +
      '<div class="a-body">' + esc(String(run.outputSummary).slice(0, 300)) + "</div></div></div>";
  }

  h += '<div class="divider"></div><div class="title" style="margin-bottom:8px">这次的情况</div>' +
    '<dl class="emp-kv">' +
    "<dt>状态</dt><dd>" + esc(statusText(run.status)) + "</dd>" +
    "<dt>做了几步</dt><dd class=\"num\">" + (callsRes.ok ? calls.length + " 步" : "—") + "</dd>" +
    "<dt>是否顺利</dt><dd>" + (callsRes.ok ? (failed ? "有 " + failed + " 步没成功" : "顺利") : "—") + "</dd>" +
    "<dt>处理时间</dt><dd>" + esc(fmtDateTime(run.createdAt)) + "</dd>" +
    "</dl>";

  if (!runRes.ok) {
    if (runRes.error) console.warn("[desktop] run", runRes.error);
    h += '<div class="xs" style="margin-top:var(--sp-3)">这次的情况暂时读不到，点右上角「刷新」可以再试。</div>';
  }

  box.innerHTML = h;
  mount(box);
}

function bindChat() {
  const btn = $("#chat-send");
  const input = $("#chat-input");
  if (btn) {
    btn.addEventListener("click", function () {
      sendChat(input ? input.value : "");
      if (input) input.value = "";
    });
  }
  if (input) {
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        sendChat(input.value);
        input.value = "";
      }
    });
  }
  // 快捷指令
  document.querySelectorAll("#p2 .emp-quick .btn").forEach(function (q) {
    q.removeAttribute("data-toast");
    q.addEventListener("click", function () {
      if (input) { input.value = q.textContent.trim(); input.focus(); }
    });
  });
  // 确认放行（Gate）：以 confirm=true 重放上一次提问，让运行时执行写操作
  document.addEventListener("click", function (e) {
    const c = e.target.closest("[data-chat-confirm]");
    if (!c) return;
    if (chatState.lastQuestion) sendChat(chatState.lastQuestion, { confirm: true });
  });
}

/* ============================ 启动 ============================ */

async function refresh() {
  const dash = await D.loadDashboard();
  window.__dash = dash;
  if (!empState.tools) {
    const tr = await D.agent.tools();
    empState.tools = tr && tr.ok ? tr.data : null;
  }
  renderChrome(dash);
  renderP0(dash);
  renderP1(dash);
  renderP3(dash);
  renderChat(dash);
  // 这三块各自独立取数：任一失败只降级自己（内部都走 safe() / try，不会抛）。
  // 用 allSettled 而不是 all —— 万一将来哪块漏了兜底而抛出，也不该连累另外两块
  // 变成「永远加载中」。
  const role = currentRole(dash);
  await Promise.allSettled([
    loadScopeMenu(),
    loadGradingQuality(role),
    loadStudents(role),
    loadNotifications(),
  ]);
  // 首屏绘制完成的信号。
  // window.__dash 在「取到数」时就挂上了，而渲染还在同一轮 await 之后 ——
  // DOM 测试若只等 __dash，就会撞上「数据到了、界面还没画」的竞态。
  window.__rendered = true;
}

function bindRefresh() {
  document.querySelectorAll('[data-icon="refresh"]').forEach(function (b) {
    b.addEventListener("click", function () { refresh(); });
  });
}

/**
 * 退出登录。
 *
 * 两点必须写对，否则就是「点了没用」或「退出后被送错页」：
 *   1. 光弹提示不算退出 —— 必须真清会话（清 localStorage 里的令牌与用户信息）。
 *   2. 回跳地址必须写 "/"。loginUrl() 不传参时缺省是 /platform，
 *      那会把桌面端用户退出后送去智慧教育平台登录，登录完也回不来。
 */
function bindLogout() {
  const btn = $('[data-panel="logout-confirm"]');
  if (!btn) return;
  btn.addEventListener("click", function () {
    session.clear();
    location.replace(loginUrl("/"));
  });
}

async function boot() {
  // 认证守卫：无令牌直接去登录页，登录后回到本页
  if (!session.token) {
    location.replace(loginUrl(location.pathname + location.search));
    return;
  }
  empState.employees = loadEmployees();
  bindChat();
  bindRefresh();
  bindEmployees();
  bindStudents();
  bindNotifications();
  bindScope();
  bindSettings();
  bindSearch();
  bindShare();
  bindLogout();
  await refresh();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
