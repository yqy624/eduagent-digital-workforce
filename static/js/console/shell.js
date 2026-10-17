/**
 * 控制台外壳。
 *
 * 职责：渲染一次性的骨架（器械脊柱 / 帧标尺 / 画布），并提供给页面用的
 * 更新句柄。页面模块只往 #canvas 里写内容，不碰骨架。
 *
 * 帧标尺是这套界面的签名元素：它把"今天"当一条时间基，
 * 视觉事件按发生时刻钉在轨道上，游标指向当前时间 —— 编码的是真实信息，
 * 不是装饰性的进度条。
 */

import { h, raw, esc, $, $$, num, fmtClock } from "./dom.js";
import { icon } from "./icons.js";
import { registry } from "./registry.js";
import { drawer } from "./ui.js";

// 侧栏分组标题也会直接显示给用户，所以用「干什么用的」而不是「属于哪一层架构」来命名。
const GROUP_OF = {
  vision: "监测",
  review: "教学",
  insight: "教学",
  knowledge: "教学",
  situation: "教学",
  governance: "平台管理",
};

export function mountShell(root, opts) {
  const options = opts || {};
  const role = options.role || "";
  const mods = registry.visibleModules(role);

  const groups = {};
  mods.forEach((m) => {
    const g = GROUP_OF[m.id] || "其他";
    (groups[g] = groups[g] || []).push(m);
  });

  const navHtml = Object.keys(groups).map((g) =>
    h`<div class="spine-group">
      <div class="spine-group-t">${g}</div>
      ${raw(groups[g].map((m) =>
        h`<a class="nav-link" href="#/${m.id}" data-mod="${m.id}">
          ${raw(icon(m.icon))}
          <span>${m.label}</span>
        </a>`
      ).join(""))}
    </div>`
  ).join("");

  root.innerHTML = h`<div class="shell" id="shellRoot">
    <aside class="spine">
      <div class="spine-brand">
        <span class="spine-mark">${raw(icon("scan"))}</span>
        <span>
          <b>数字员工平台</b>
          <span>课堂 · 作业 · 学情 · 提醒</span>
        </span>
      </div>
      <nav class="spine-body" id="spineNav">${raw(navHtml)}</nav>
      <div class="spine-foot">
        <div class="spine-live" id="spineLive">
          <span class="dot dot--scan dot--pulse"></span><span>正在连接…</span>
        </div>
        <div class="spine-user">
          <span class="avatar" id="spineAvatar">${esc((options.name || "—").slice(0, 1))}</span>
          <span class="su-txt">
            <b>${options.name || "—"}</b>
            <span>${options.roleLabel || role}</span>
          </span>
        </div>
      </div>
    </aside>

    <div class="stage">
      <div class="timebase">
        <button class="tb-btn" type="button" id="tbMenu" aria-label="折叠导航">${raw(icon("menu"))}</button>
        <div class="tb-rail" id="tbRail" title="今天的视觉事件分布">
          <div class="tb-ticks" id="tbTicks"></div>
          <div class="tb-baseline"></div>
          <div id="tbFlags"></div>
          <div class="tb-cursor" id="tbCursor"></div>
        </div>
        <div class="tb-readout">
          <span>${h`<b class="num" id="tbEvents">—</b> 事件`}</span>
          <span class="dim">·</span>
          <span class="dim">服务状态</span> <b id="tbStatus">连接中</b>
          <span class="dim">·</span>
          <b class="num" id="tbClock">--:--:--</b>
        </div>
        <button class="tb-btn" type="button" id="tbSearch" aria-label="搜索（Ctrl+K）">${raw(icon("search"))}</button>
        <button class="tb-btn" type="button" id="tbBell" aria-label="实时动态">${raw(icon("bell"))}</button>
        <button class="tb-btn" type="button" id="tbUser" aria-label="账户">${raw(icon("user"))}</button>
      </div>
      <main class="canvas" id="canvas"></main>
    </div>
  </div>`;

  /* ---------- 帧标尺 ---------- */
  const ticks = root.querySelector("#tbTicks");
  let tickHtml = "";
  for (let hr = 0; hr <= 24; hr++) {
    const major = hr % 3 === 0;
    const left = (hr / 24) * 100;
    tickHtml += h`<span class="tb-tick ${major ? "major" : ""}" style="left:${left}%"></span>`;
    if (major && hr < 24) tickHtml += h`<span class="tb-tick-label" style="left:${left}%">${String(hr).padStart(2, "0")}</span>`;
  }
  ticks.innerHTML = tickHtml;

  const cursor = root.querySelector("#tbCursor");
  const flagsBox = root.querySelector("#tbFlags");
  const eventsEl = root.querySelector("#tbEvents");
  const clockEl = root.querySelector("#tbClock");

  function placeCursor() {
    const d = new Date();
    const frac = (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400;
    cursor.style.left = (frac * 100).toFixed(3) + "%";
    clockEl.textContent = fmtClock(d);
  }
  placeCursor();
  const clockTimer = setInterval(placeCursor, 1000);

  /** 把一天的视觉事件钉到轨道上（severity 决定颜色与高度） */
  function plotEvents(events) {
    const list = (events || []).slice(0, 300);
    const flags = list.map((e) => {
      const t = new Date(String(e.createdAt || e.created_at || "").replace(" ", "T"));
      if (Number.isNaN(t.getTime())) return "";
      const frac = (t.getHours() * 3600 + t.getMinutes() * 60 + t.getSeconds()) / 86400;
      const sev = e.severity || "info";
      const title = (e.eventLabel || e.event_label || e.eventType || e.event_type || "事件") +
        " · " + (e.scene || "") + " · " + sev;
      return h`<span class="tb-flag sev-${sev}" style="left:${(frac * 100).toFixed(3)}%" title="${title}"></span>`;
    }).join("");
    flagsBox.innerHTML = flags;
    const today = new Date().toDateString();
    const nToday = list.filter((e) => {
      const t = new Date(String(e.createdAt || e.created_at || "").replace(" ", "T"));
      return !Number.isNaN(t.getTime()) && t.toDateString() === today;
    }).length;
    eventsEl.textContent = num(nToday || list.length);
  }

  function setStatus(text, tone) {
    const el = root.querySelector("#tbStatus");
    el.textContent = text;
    el.style.color = tone === "warn" ? "var(--signal-ink)" : tone === "danger" ? "var(--danger)" : "";
  }

  function setLive(text, tone) {
    const el = root.querySelector("#spineLive");
    const dot = tone === "ok" ? "dot--ok" : tone === "danger" ? "dot--danger" : "dot--scan dot--pulse";
    el.innerHTML = h`<span class="dot ${dot}"></span><span>${text}</span>`;
  }

  function setActive(moduleId) {
    $$(".nav-link", root).forEach((a) => a.classList.toggle("is-on", a.getAttribute("data-mod") === moduleId));
  }

  /* ---------- 检查器（右侧抽屉） ---------- */
  function inspector(o) {
    return drawer({
      title: o.title,
      sub: o.sub,
      body: o.body,
      footer: o.footer,
      mount: o.mount,
      onClose: o.onClose,
    });
  }

  return {
    root,
    canvas: root.querySelector("#canvas"),
    plotEvents,
    setStatus,
    setLive,
    setActive,
    inspector,
    destroy() { clearInterval(clockTimer); },
    spine: root.querySelector("#spineNav"),
  };
}

/** 卸载时清掉定时器等资源 */
export function unmountShell(shell) {
  if (shell && shell.destroy) shell.destroy();
}
