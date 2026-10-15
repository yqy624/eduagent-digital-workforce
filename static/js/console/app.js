/**
 * 控制台引导与路由。
 *
 * 路由是 hash 形式：#/<moduleId>[/<capabilityId>]，直接可分享、可刷新。
 * 角色只决定「看得见什么」：不可见的模块即使手输 hash 也会被挡回。
 */

import { h, raw, esc, $, $$, num, fmtTime, relTime } from "./dom.js";
import { icon } from "./icons.js";
import { api, session, logout, openNotificationStream } from "./api.js";
import { registry } from "./registry.js";
import { mountShell } from "./shell.js";
import { toast, commandPalette, popover, drawer, emptyState, plate, badge, timeline, loading, bindThinkToggles, sceneText } from "./ui.js";

import * as visionPage from "./pages/vision.js";
import * as reviewPage from "./pages/review.js";
import * as insightPage from "./pages/insight.js";
import * as knowledgePage from "./pages/knowledge.js";
import * as situationPage from "./pages/situation.js";
import * as governancePage from "./pages/governance.js";

const PAGES = {
  vision: visionPage, review: reviewPage, insight: insightPage,
  knowledge: knowledgePage, situation: situationPage, governance: governancePage,
};

const state = { shell: null, events: [], health: null, role: "", tab: null, notifier: null };

/* ---------------- 路由 ---------------- */
function parseHash() {
  const parts = (location.hash || "").replace(/^#\/?/, "").split("/").filter(Boolean);
  return { moduleId: parts[0] || "", childId: parts[1] || "" };
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function render() {
  const { moduleId, childId } = parseHash();
  const role = state.role;
  const visible = registry.visibleModules(role);

  if (!visible.length) {
    state.shell.canvas.innerHTML = plate({
      title: "还没有开通功能",
      body: emptyState({ icon: "ban", title: "当前账号暂未开通任何功能", desc: "请联系学校管理员为你的账号开通权限。" }),
    });
    return;
  }

  let mod = registry.get(moduleId);
  if (!mod || visible.indexOf(mod) < 0) {
    mod = visible[0];
    location.replace("#/" + mod.id);
    return;
  }

  let child = childId ? registry.child(mod.id, childId) : null;
  if (child && registry.visibleChildren(role, mod.id).indexOf(child) < 0) child = null;

  state.shell.setActive(mod.id);
  const page = PAGES[mod.id];
  const ctx = {
    module: mod,
    child,
    role,
    canWrite: registry.canWrite(role, mod.id),
    canvas: state.shell.canvas,
    shell: state.shell,
    go,
    refresh: render,
    setEventCache: (evs) => { state.events = evs || []; },
    refreshTimebase: loadTimebase,
  };
  try {
    page && page.mount
      ? page.mount(ctx)
      : (state.shell.canvas.innerHTML = plate({ title: "功能准备中", body: emptyState({ title: "这个功能还在准备中" }) }));
  } catch (err) {
    console.error("[console] 页面渲染失败", err);
    state.shell.canvas.innerHTML = plate({
      title: "页面没能打开",
      body: emptyState({ icon: "alert", title: "页面加载失败", desc: "请刷新重试；若一直失败，请联系学校管理员。" }),
    });
  }
  bindThinkToggles(state.shell.canvas);
}

/* ---------------- 帧标尺数据 ---------------- */
function loadTimebase() {
  return api.get("/api/vision/events?limit=300")
    .then((events) => {
      state.events = events || [];
      state.shell.plotEvents(state.events);
    })
    .catch(() => {});
}

function loadHealth() {
  return api.get("/api/health").then((hl) => {
    state.health = hl;
    const checks = (hl && hl.checks) || {};
    const dbOk = !!(checks.database && checks.database.status === "ok");
    state.shell.setStatus(dbOk ? "正常" : "部分受限", dbOk ? "ok" : "warn");
    state.shell.setLive(dbOk ? "服务正常" : "部分功能暂不可用", dbOk ? "ok" : "danger");
  }).catch(() => {
    state.shell.setStatus("连接失败", "danger");
    state.shell.setLive("暂时连不上服务", "danger");
  });
}

/* ---------------- 顶栏交互 ---------------- */
function openEventDrawer() {
  const d = drawer({
    title: "实时动态",
    sub: "今天的课堂与考场动态，按时间倒序",
    body: loading(),
    onClose: () => {},
  });
  api.get("/api/vision/events?limit=40").then((list) => {
    const evs = list || [];
    d.body.innerHTML = evs.length
      ? timeline(evs.map((e) => ({
          time: fmtTime(e.createdAt || e.created_at),
          tone: e.severity === "critical" ? "critical" : e.severity === "warning" ? "warning" : null,
          done: !!e.acknowledged,
          title: esc(e.eventLabel || e.event_label || e.eventType || "情况"),
          // scene 是后端机器标识（classroom / lab_safety…），必须过 sceneText 才上屏。
          // 这里曾经直接输出 e.scene，于是抽屉里明晃晃地显示 lab_safety。
          desc: esc(sceneText(e.scene)),
        })))
      : emptyState({ icon: "zap", title: "暂无记录", desc: "识别到情况之后，这里会按时间列出。" });
  }).catch((err) => {
    console.warn("[console] 事件流读取失败", err);
    d.body.innerHTML = emptyState({ icon: "alert", title: "读取失败", desc: "暂时取不到记录，请稍后重试。" });
  });
}

function openUserMenu(anchor) {
  const u = session.user || {};
  const roleLabel = { ADMIN: "管理员", TEACHER: "教师", STUDENT: "学生" }[String(u.role || "").toUpperCase()] || "使用者";
  popover(anchor,
    h`<div class="menu-label">${esc(u.displayName || u.username || "—")} · ${esc(roleLabel)}</div>
      <button class="menu-item" type="button" data-act="profile">${raw(icon("user"))}个人信息</button>
      <button class="menu-item" type="button" data-act="theme">${raw(icon("eye"))}切换明暗</button>
      <div class="menu-sep"></div>
      <button class="menu-item is-danger" type="button" data-act="logout">${raw(icon("log-out"))}退出登录</button>`,
    { onPick: (act) => {
      if (act === "logout") return logout();
      if (act === "profile") return openProfile();
      if (act === "theme") {
        const cur = document.documentElement.getAttribute("data-theme");
        document.documentElement.setAttribute("data-theme", cur === "dark" ? "light" : "dark");
        toast(cur === "dark" ? "已切换到亮色" : "已切换到暗色", "ok");
      }
    } });
}

function openProfile() {
  api.get("/api/profile").then((p) => {
    const { modal } = window.__ui || {};
    void modal;
    import("./ui.js").then((m) => m.modal({
      title: "个人信息",
      body: plate({
        body: h`<dl class="kv">
          <dt>用户名</dt><dd class="mono">${esc(p.username)}</dd>
          <dt>姓名</dt><dd>${esc(p.displayName || p.display_name || "—")}</dd>
          <dt>邮箱</dt><dd>${esc(p.email || "—")}</dd>
          <dt>角色</dt><dd>${raw(badge(String(p.role || "").toUpperCase() === "ADMIN" ? "管理员" : String(p.role || "").toUpperCase() === "TEACHER" ? "教师" : "学生", "info"))}</dd>
        </dl>`,
      }),
      footer: h`<button class="btn btn--outline" type="button" data-close>关闭</button>`,
    }));
  }).catch((err) => toast("读取失败：" + err.message, "err"));
}

function openPalette() {
  const mods = registry.visibleModules(state.role);
  const items = [];
  mods.forEach((m) => items.push({
    section: "功能", label: m.label, icon: m.icon, kw: m.label, run: () => go("#/" + m.id),
  }));
  mods.forEach((m) => registry.visibleChildren(state.role, m.id).forEach((c) => items.push({
    section: "具体功能", label: c.label, sub: m.label + " · " + c.group, icon: "dot",
    kw: c.label + " " + m.label,
    run: () => go("#/" + m.id + "/" + c.id),
  })));
  items.push({ section: "动作", label: "刷新当前页", icon: "refresh", run: () => render() });
  items.push({ section: "动作", label: "打开实时动态", icon: "bell", run: openEventDrawer });
  items.push({ section: "动作", label: "切换明暗主题", icon: "eye",
    run: () => { const c = document.documentElement.getAttribute("data-theme"); document.documentElement.setAttribute("data-theme", c === "dark" ? "light" : "dark"); } });
  items.push({ section: "动作", label: "退出登录", icon: "log-out", run: logout });
  commandPalette({ items });
}

/* ---------------- 启动 ---------------- */
function boot() {
  if (!session.token) {
    location.replace("/login.html?next=" + encodeURIComponent("/platform"));
    return;
  }
  state.role = String(session.role || "").toUpperCase();

  const root = document.getElementById("spineRoot") || document.body;
  state.shell = mountShell(root, {
    role: state.role,
    name: session.name,
    roleLabel: { ADMIN: "管理员", TEACHER: "教师", STUDENT: "学生" }[state.role] || state.role,
  });

  // 顶栏按钮
  const menuBtn = document.getElementById("tbMenu");
  if (menuBtn) menuBtn.addEventListener("click", () => {
    const root2 = document.getElementById("shellRoot");
    if (root2) root2.classList.toggle("is-mini");
  });
  const searchBtn = document.getElementById("tbSearch");
  if (searchBtn) searchBtn.addEventListener("click", openPalette);
  const bellBtn = document.getElementById("tbBell");
  if (bellBtn) bellBtn.addEventListener("click", openEventDrawer);
  const userBtn = document.getElementById("tbUser");
  if (userBtn) userBtn.addEventListener("click", () => openUserMenu(userBtn));

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); }
  });

  window.addEventListener("hashchange", render);

  transformPanel();  // 面板化：非 ADMIN 隐藏治理模块的入口由权限层负责
  loadHealth();
  loadTimebase();
  setInterval(loadTimebase, 60000);
  state.notifier = openNotificationStream({
    onMessage: (msg) => {
      if (msg && (msg.type === "NOTIFICATION" || msg.type === "notification")) {
        const p = msg.payload || msg.data || msg;
        toast(p.title || p.content || "收到一条通知", "ok");
        loadTimebase();
      }
    },
  });

  if (!location.hash) location.replace("#/" + (registry.visibleModules(state.role)[0] || {}).id);
  else render();
}

/** 给学生角色做一次轻量面板化：隐藏写操作按钮由各页 canWrite 控制，这里只提示 */
function transformPanel() {
  if (state.role !== "STUDENT") return;
  const el = document.querySelector(".spine-live");
  if (el) el.setAttribute("title", "学生视角：可查看作业、提交、成绩与互评");
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();

export { go, render };
