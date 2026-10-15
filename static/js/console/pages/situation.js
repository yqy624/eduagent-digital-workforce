/**
 * 态势感知与告警。
 *
 * 这是所有模块的事件出口。命名成「态势」而非「消息中心」，
 * 因为主要输入是视觉事件流而不是人际消息。本页直连 /api/situation/* 命名空间：
 *   GET  /api/situation/overview      视觉事件规模 + 未读通知 + 待处置计数
 *   GET  /api/situation/notifications 通知中心（收敛 notifications 表，同源）
 *   GET  /api/situation/alerts        告警队列（warning / critical，严重在前）
 *   GET  /api/situation/rules         告警规则配置（真实规则表）
 *   POST /api/situation/rules         新增规则（仅管理员）
 *   PUT  /api/situation/rules/{id}/enabled 启用 / 停用（仅管理员）
 *   WS   /api/situation/alerts/stream 实时推送（与 /ws/notifications 同源别名）
 * 处置动作与通知已读仍写回既有端点：
 *   POST /api/vision/events/{id}/ack
 *   PUT  /api/notifications/{id}/read · /api/notifications/read-all
 */

import { h, raw, esc, num, fmtTime, relTime, asList } from "../dom.js";
import { icon } from "../icons.js";
import { api, openNotificationStream } from "../api.js";
import { plate, badge, emptyState, noteBox, table, statCard, loading, toast, timeline, meter, confMeter, sceneText, rolesText, metricText, healthText } from "../ui.js";
import { crumb, pageHead, loadInto, plannedPanel, capabilityIndex, monitorBrief, renderData } from "./kit.js";

const SEV = { critical: { t: "严重", k: "danger" }, warning: { t: "关注", k: "warn" }, info: { t: "记录", k: null } };
let stream = null;

export function mount(ctx) {
  const el = ctx.canvas;
  if (stream) { try { stream.close(); } catch (_) {} stream = null; }
  if (!ctx.child) return mountHome(ctx, el);
  const map = {
    "situation-overview": capOverview,
    "situation-stream": capStream,
    "situation-alerts": capAlerts,
    "situation-notifications": capNotifications,
    "situation-rules": capRules,
  };
  if (map[ctx.child.id]) return map[ctx.child.id](ctx, el);
  return planned(ctx, el);
}

function mountHome(ctx, el) {
  const isStudent = String(ctx.role).toUpperCase() === "STUDENT";
  if (isStudent) return mountHomeStudent(ctx, el);
  // 运行时监控 /api/admin/monitor 按管理员权限保护；教师访问会 403，故按角色降级到 /api/health。
  const isAdmin = String(ctx.role).toUpperCase() === "ADMIN";
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb("全部功能", ctx.module.id, "态势总览"))}
    ${raw(pageHead({
      title: "态势感知与告警",
      note: "把各处的情况汇总在一页，需要时立即提醒你。",
      actions: h`<a class="btn btn--primary btn--sm" href="#/situation/situation-stream">${raw(icon("broadcast"))}打开实时流</a>`,
    }))}
    <div class="stat-grid" id="sStats"></div>
    <div class="grid grid-side mt-5">
      <div class="stack"><div id="sAlerts"></div></div>
      <div class="stack"><div id="sNotif"></div><div id="sHealth"></div></div>
    </div>
    <div class="mt-5" id="sIndex"></div>
  </div>`;
  el.querySelector("#sIndex").innerHTML = capabilityIndex(ctx);
  el.querySelectorAll("[data-cap]").forEach((r) => r.addEventListener("click", () => ctx.go("#/" + ctx.module.id + "/" + r.getAttribute("data-cap"))));

  loadInto(el.querySelector("#sStats"), () => Promise.all([
    api.get("/api/situation/overview").catch(() => null),
    isAdmin ? api.get("/api/admin/monitor").catch(() => null) : api.get("/api/health").catch(() => null),
  ]), (rr) => {
    const v = rr[0] || {}, mon = rr[1];
    return statCard({ icon: "zap", label: "关注事件", value: v.eventTotal || 0 }) +
      statCard({ icon: "alert", label: "待确认事件", value: v.unacknowledged || 0, hint: "需要人工处置" }) +
      statCard({ icon: "bell", label: "未读通知", value: v.unreadNotifications || 0 }) +
      statCard({ icon: "server", label: "服务状态", value: mon ? "在线" : "—", hint: isAdmin ? (mon && mon.uptime ? "已运行 " + mon.uptime : "暂时读不到") : "由学校管理人员查看" });
  });

  loadInto(el.querySelector("#sAlerts"), () => api.get("/api/situation/alerts?limit=100"), (rows) => {
    const list = (rows || []).filter((e) => e.severity === "warning" || e.severity === "critical");
    if (!list.length) return plate({ title: "告警", body: emptyState({ icon: "shield-check", title: "当前无告警", desc: "视觉模块没有识别到需要人工介入的情况。" }) });
    return plate({
      flush: true, title: "当前告警", sub: list.length + " 条",
      tools: h`<a class="btn btn--ghost btn--sm" href="#/situation/situation-alerts">处置</a>`,
      body: table({
        columns: [{ t: "事件" }, { t: "场景" }, { t: "等级" }, { t: "时间" }, { t: "状态" }],
        rows: list.slice(0, 8).map((e) => ([
          h`<div class="t-main">${e.eventLabel || e.event_label || e.eventType || "事件"}</div>`,
          esc(sceneText(e.scene)),
          badge(SEV[e.severity] ? SEV[e.severity].t : e.severity, SEV[e.severity] ? SEV[e.severity].k : null),
          h`<span class="num">${esc(fmtTime(e.createdAt || e.created_at))}</span>`,
          e.acknowledged ? badge("已确认", "ok") : badge("待确认", "signal"),
        ])),
      }),
    });
  });

  loadInto(el.querySelector("#sNotif"), () => api.get("/api/situation/notifications"), (d) => {
    const list = asList(d);
    return plate({
      title: "通知中心", sub: list.length + " 条",
      tools: h`<a class="btn btn--ghost btn--sm" href="#/situation/situation-notifications">全部</a>`,
      body: list.length
        ? h`<div class="stack-sm">${raw(list.slice(0, 5).map((n) => h`<div class="row" style="gap:10px;align-items:flex-start">
            <span class="dot ${n.read || n.isRead ? "" : "dot--scan"}" style="margin-top:6px"></span>
            <div style="min-width:0"><div class="t-sm">${esc(n.title || n.content || "通知")}</div>
              <div class="t-xs muted">${esc(relTime(n.createdAt || n.created_at))}</div></div></div>`).join(""))}</div>`
        : emptyState({ icon: "bell", title: "没有通知" }),
    });
  }).catch((err) => { el.querySelector("#sNotif").innerHTML = plate({ title: "通知中心", body: noteBox({ kind: "danger", title: "读取失败", body: esc(err.message) }) }); });

  if (isAdmin) {
    loadInto(el.querySelector("#sHealth"), () => api.get("/api/admin/monitor"), (d) => plate({
      title: "平台运行状况", sub: "各项服务与资源占用",
      tools: h`<a class="btn btn--ghost btn--sm" href="#/governance/governance-monitor">详情</a>`,
      body: monitorBrief(d),
    })).catch(() => {});
  } else {
    el.querySelector("#sHealth").innerHTML = plate({
      title: "平台运行状况", sub: "由学校管理人员查看",
      body: noteBox({
        kind: "info",
        body: "平台的运行状况由学校管理人员统一查看。", 
      }),
    });
  }
}

/* ---------- 学生版首页 ---------- */
// 告警处置与系统运行状态是教师 / 管理员视角（端点对学生 403），
// 学生在这里只保留与自己相关的通知与整体态势计数。
function mountHomeStudent(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb("全部功能", ctx.module.id, "我的通知"))}
    ${raw(pageHead({
      title: "态势感知与告警",
      note: "与你相关的通知都汇总在这里。",
    }))}
    <div class="stat-grid" id="sStats"></div>
    <div class="mt-5" id="sNotif"></div>
    <div class="mt-5" id="sIndex"></div>
  </div>`;
  el.querySelector("#sIndex").innerHTML = capabilityIndex(ctx);
  el.querySelectorAll("[data-cap]").forEach((r) => r.addEventListener("click", () => ctx.go("#/" + ctx.module.id + "/" + r.getAttribute("data-cap"))));

  loadInto(el.querySelector("#sStats"), () => Promise.all([
    api.get("/api/situation/notifications").catch(() => []),
    api.get("/api/situation/overview").catch(() => null),
  ]), (rr) => {
    const list = asList(rr[0]);
    const ov = rr[1] || {};
    return statCard({ icon: "bell", label: "通知", value: list.length }) +
      statCard({ icon: "alert", label: "未读通知", value: ov.unreadNotifications || 0 });
  });

  loadInto(el.querySelector("#sNotif"), () => api.get("/api/situation/notifications"), (d) => {
    const list = asList(d);
    return plate({
      title: "通知中心", sub: list.length + " 条",
      tools: h`<a class="btn btn--ghost btn--sm" href="#/situation/situation-notifications">全部</a>`,
      body: list.length
        ? h`<div class="stack-sm">${raw(list.slice(0, 8).map((n) => h`<div class="row" style="gap:10px;align-items:flex-start">
            <span class="dot ${n.read || n.isRead ? "" : "dot--scan"}" style="margin-top:6px"></span>
            <div style="min-width:0"><div class="t-sm">${esc(n.title || n.content || "通知")}</div>
              <div class="t-xs muted">${esc(relTime(n.createdAt || n.created_at))}</div></div></div>`).join(""))}</div>`
        : emptyState({ icon: "bell", title: "没有通知" }),
    });
  });
}

/* ---------- 实时告警流（WebSocket） ---------- */
function capStream(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({
      title: "实时提醒",
      note: "有新情况会立刻推送到这里。断线后会自动重新连接，连接状态显示在右上角。",
      actions: h`<span id="wsState" class="badge badge--ghost">${raw(icon("wifi"))}连接中</span>`,
    }))}
    <div class="grid grid-side">
      <div class="stack">
        ${raw(plate({
          title: "实时推送",
          sub: "有新消息立即显示，不需要手动刷新",
          flush: true,
          body: h`<div id="wsFeed" style="max-height:520px;overflow-y:auto">
            ${raw(emptyState({ icon: "broadcast", title: "等待推送", desc: "保持本页打开。视觉模块产出事件或系统发出通知时，消息会实时出现在这里。" }))}
          </div>`,
        }))}
      </div>
      <div class="stack">
        <div id="wsEvents"></div>
        ${raw(noteBox({ kind: "info", title: "这里会出现什么", body: "课堂与考场的识别结果、作业批改完成、重要提醒，都会实时出现在这里。" }))}
      </div>
    </div>
  </div>`;

  const feed = el.querySelector("#wsFeed");
  const state = el.querySelector("#wsState");
  let started = false;
  const items = [];

  function push(type, payload) {
    if (!started) { feed.innerHTML = ""; started = true; }
    items.unshift({ type, payload, at: new Date() });
    feed.innerHTML = items.slice(0, 80).map((it) => {
      const p = it.payload || {};
      return h`<div class="row" style="gap:10px;padding:11px var(--s-5);border-bottom:1px solid var(--line-soft);align-items:flex-start">
        <span class="dot ${it.type === "NOTIFICATION" ? "dot--scan" : it.type === "ERROR" ? "dot--danger" : "dot--ok"}" style="margin-top:6px"></span>
        <div style="min-width:0;flex:1">
          <div class="t-sm">${esc(p.title || p.content || p.message || it.type)}</div>
          <div class="t-xs muted">${esc(p.scene ? sceneText(p.scene) : "通知")}</div>
        </div>
        <span class="t-xs dim num">${esc(fmtTime(it.at.toISOString()))}</span>
      </div>`;
    }).join("");
  }

  stream = openNotificationStream({
    onOpen: () => { state.className = "badge badge--ok"; state.innerHTML = icon("wifi") + "已连接"; },
    onClose: () => { state.className = "badge badge--warn"; state.innerHTML = icon("wifi") + "重连中"; },
    onMessage: (msg) => push(msg.type || "MESSAGE", msg.payload || msg.data || msg),
  }, "/api/situation/alerts/stream");

  loadInto(el.querySelector("#wsEvents"), () => api.get("/api/situation/alerts?limit=10"), (rows) => {
    const list = rows || [];
    return plate({
      title: "最近的识别记录", sub: "提醒从这里产生",
      body: list.length ? timeline(list.map((e) => ({
        time: fmtTime(e.createdAt || e.created_at),
        tone: e.severity === "critical" ? "critical" : e.severity === "warning" ? "warning" : null,
        title: esc(e.eventLabel || e.event_label || e.eventType || "事件"),
        desc: esc(sceneText(e.scene)) + (e.confidence != null ? " · 把握 " + Math.round(Number(e.confidence) * 100) + "%" : ""),
      }))) : emptyState({ icon: "zap", title: "暂无事件" }),
    });
  });
}

/* ---------- 告警处置 ---------- */
function capAlerts(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({
      title: "告警处置",
      note: "分级路由到责任人。确认动作会写回事件，这是告警从「看到」变成「处理过」的唯一凭据。",
    }))}
    <div class="grid grid-side">
      <div class="stack">
        <div class="row"><div class="seg" id="alSeg">
          <button class="seg-btn is-on" data-s="all">全部</button>
          <button class="seg-btn" data-s="warning">关注</button>
          <button class="seg-btn" data-s="critical">严重</button>
          <button class="seg-btn" data-s="open">待处置</button>
        </div></div>
        <div id="alList"></div>
      </div>
      <div class="stack" id="alSide"></div>
    </div>
  </div>`;

  let mode = "all";
  const load = () => {
    loadInto(el.querySelector("#alList"), () => api.get("/api/vision/events?limit=200"), (rows) => {
      let list = rows || [];
      if (mode === "warning") list = list.filter((e) => e.severity === "warning");
      else if (mode === "critical") list = list.filter((e) => e.severity === "critical");
      else if (mode === "open") list = list.filter((e) => !e.acknowledged);
      if (!list.length) return emptyState({ icon: "shield-check", title: "没有符合条件的告警" });
      return plate({
        flush: true, title: "告警清单", sub: list.length + " 条",
        body: table({
          columns: [{ t: "事件" }, { t: "场景" }, { t: "等级" }, { t: "把握" }, { t: "时间" }, { t: "处置" }],
          rows: list.map((e) => ([
            h`<div class="t-main">${e.eventLabel || e.event_label || e.eventType || "事件"}</div>`,
            esc(sceneText(e.scene)),
            badge(SEV[e.severity] ? SEV[e.severity].t : e.severity, SEV[e.severity] ? SEV[e.severity].k : null),
            h`<div style="width:120px">${raw(confMeter(e.confidence || 0))}</div>`,
            h`<span class="num">${esc(fmtTime(e.createdAt || e.created_at))}</span>`,
            e.acknowledged ? badge("已处置", "ok")
              : (ctx.canWrite ? h`<button class="btn btn--signal btn--sm" type="button" data-ack="${e.id}">${raw(icon("check"))}确认</button>` : '<span class="dim">—</span>'),
          ])),
        }),
      });
    }, { after: (data, host) => {
      host.querySelectorAll("[data-ack]").forEach((b) => b.addEventListener("click", () => {
        b.disabled = true;
        api.post("/api/vision/events/" + b.getAttribute("data-ack") + "/ack")
          .then(() => { toast("已确认并记录", "ok"); load(); })
          .catch((err) => { toast("确认失败：" + err.message, "err"); b.disabled = false; });
      }));
    } });
  };
  load();
  el.querySelectorAll("#alSeg .seg-btn").forEach((b) => b.addEventListener("click", () => {
    el.querySelectorAll("#alSeg .seg-btn").forEach((x) => x.classList.toggle("is-on", x === b));
    mode = b.getAttribute("data-s");
    load();
  }));

  loadInto(el.querySelector("#alSide"), () => api.get("/api/vision/events?limit=500"), (rows) => {
    const list = rows || [];
    const open = list.filter((e) => !e.acknowledged);
    const crit = list.filter((e) => e.severity === "critical" && !e.acknowledged);
    return h`<div class="stack">
      ${raw(plate({ title: "处置进度", body: h`<div class="stack">
        <div class="row" style="justify-content:space-between"><span class="t-sm muted">已处置率</span>
          <b class="num">${list.length ? Math.round(((list.length - open.length) / list.length) * 100) : 0}%</b></div>
        <div>${raw(meter(list.length ? ((list.length - open.length) / list.length) * 100 : 0, "ok"))}</div>
        <div class="row" style="justify-content:space-between"><span class="t-sm muted">待处置</span><b class="num">${open.length}</b></div>
        <div class="row" style="justify-content:space-between"><span class="t-sm muted">其中严重</span><b class="num" style="color:var(--danger)">${crit.length}</b></div>
      </div>` }))}
      ${raw(plate({ title: "分级派发", body: noteBox({
        kind: "info",
        body: "系统会按轻重自动把提醒发给相关学生和负责人，同一件事在设定时间内不会重复打扰。规则在「提醒条件」页设置。",
      }) }))}
    </div>`;
  });
}

/* ---------- 通知中心 ---------- */
function capNotifications(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({
      title: "通知中心",
      note: "所有通知都在这里，未读、标记已读、全部已读都可正常使用。",
      actions: h`<button class="btn btn--outline btn--sm" type="button" id="nAll">${raw(icon("check-circle"))}全部已读</button>`,
    }))}
    <div class="grid grid-side">
      <div class="stack"><div id="nList"></div></div>
      <div class="stack"><div id="nStat"></div></div>
    </div>
  </div>`;

  const load = () => loadInto(el.querySelector("#nList"), () => api.get("/api/situation/notifications"), (d) => {
    const list = asList(d);
    if (!list.length) return emptyState({ icon: "bell", title: "没有通知", desc: "系统消息、作业提醒、告警派发都会出现在这里。" });
    return plate({
      flush: true, title: "通知", sub: list.length + " 条",
      body: h`<div>${raw(list.map((n) => {
        const read = n.read || n.isRead;
        return h`<div class="row" style="gap:12px;padding:13px var(--s-5);border-bottom:1px solid var(--line-soft);align-items:flex-start">
          <span class="dot ${read ? "" : "dot--scan"}" style="margin-top:6px"></span>
          <div style="flex:1;min-width:0">
            <div class="t-sm ${read ? "" : "strong"}">${esc(n.title || n.content || "通知")}</div>
            ${n.content && n.title ? h`<div class="t-xs muted">${esc(n.content)}</div>` : ""}
            <div class="t-xs dim">${esc(fmtTime(n.createdAt || n.created_at))}</div>
          </div>
          ${read ? badge("已读", null) : h`<button class="btn btn--ghost btn--sm" type="button" data-read="${n.id}">${raw(icon("check"))}标记已读</button>`}
        </div>`;
      }).join(""))}</div>`,
    });
  }, { after: (data, host) => {
    host.querySelectorAll("[data-read]").forEach((b) => b.addEventListener("click", () => {
      b.disabled = true;
      api.put("/api/notifications/" + b.getAttribute("data-read") + "/read")
        .then(() => { toast("已标记已读", "ok"); load(); })
        .catch((err) => { toast("操作失败：" + err.message, "err"); b.disabled = false; });
    }));
  } });
  load();
  el.querySelector("#nAll").addEventListener("click", () => {
    api.put("/api/notifications/read-all").then(() => { toast("已全部标记为已读", "ok"); load(); })
      .catch((err) => toast("操作失败：" + err.message, "err"));
  });
  loadInto(el.querySelector("#nStat"), () => api.get("/api/situation/overview"), (d) => {
    const n = d && d.unreadNotifications != null ? d.unreadNotifications : 0;
    return plate({ title: "未读", body: h`<div class="row" style="justify-content:space-between">
      <span class="t-sm muted">未读通知</span><b class="num" style="font-size:var(--t-2xl)">${typeof n === "number" ? n : 0}</b></div>` });
  });
}

function capRules(ctx, el) {
  const canWrite = String(ctx.role).toUpperCase() === "ADMIN";
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({
      title: ctx.child.label,
      note: "在这里设定：什么情况要提醒、怎么提醒、通知给谁。同一件事在设定时间内不会重复提醒。",
      actions: canWrite ? h`<button class="btn btn--primary btn--sm" type="button" id="rAdd">${raw(icon("plus"))}新增规则</button>` : "",
    }))}
    <div id="rBody"></div>
  </div>`;

  const load = () => loadInto(el.querySelector("#rBody"),
    () => api.get("/api/situation/rules").catch((e) => ({ __err: e.message })),
    (d) => {
      if (d && d.__err) return noteBox({ kind: "danger", title: "读取失败", body: esc(d.__err) });
      const list = asList(d && d.rules);
      const head = noteBox({ kind: "info", title: "什么时候会自动提醒", body: esc((d && d.note) || "") });

      if (!list.length) {
        return h`<div class="stack">${raw(head)}${raw(emptyState({
          icon: "sliders", title: "还没有告警规则",
          desc: "没有规则时，识别出的情况只会留在记录里；建立规则后，它才会变成负责人的一条待办。",
          action: canWrite ? h`<button class="btn btn--signal btn--sm" type="button" data-add>${raw(icon("plus"))}建立第一条规则</button>` : "",
        }))}</div>`;
      }

      return h`<div class="stack">
        ${raw(head)}
        ${raw(plate({
          flush: true, title: "告警规则", sub: list.length + " 条",
          body: table({
            columns: [{ t: "名称" }, { t: "场景" }, { t: "触发等级" }, { t: "通知学生" }, { t: "通知角色" }, { t: "去重窗口" }, { t: "状态" }],
            rows: list.map((r) => {
              const sev = SEV[r.severity] || { t: r.severity, k: null };
              return [
                esc(r.name),
                esc(r.scene ? sceneText(r.scene) : "不限场景"),
                badge(sev.t, sev.k),
                r.notifyStudent ? badge("是", "ok") : badge("否", null),
                h`<span class="t-xs">${esc(rolesText(r.notifyRoles))}</span>`,
                esc((r.dedupMinutes == null ? "—" : r.dedupMinutes) + " 分钟"),
                canWrite
                  ? h`<button class="btn btn--ghost btn--sm" type="button" data-toggle="${r.id}" data-on="${r.enabled ? 1 : 0}">${r.enabled ? "停用" : "启用"}</button>`
                  : (r.enabled ? badge("启用", "ok") : badge("停用", null)),
              ];
            }),
          }),
        }))}
      </div>`;
    },
    { after: (d, host) => {
      const add = host.querySelector("[data-add]");
      if (add) add.addEventListener("click", openAdd);
      host.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", () => {
        const next = b.getAttribute("data-on") !== "1";
        b.disabled = true;
        api.put("/api/situation/rules/" + b.getAttribute("data-toggle") + "/enabled", { enabled: next })
          .then(() => { toast(next ? "已启用" : "已停用", "ok"); load(); })
          .catch((err) => { toast("操作失败：" + err.message, "err"); b.disabled = false; });
      }));
    } });

  function openAdd() {
    import("../ui.js").then((m) => {
      m.modal({
        title: "新增告警规则",
        body: h`<div class="stack">
          ${raw(noteBox({ kind: "info", title: "匹配逻辑", body: "事件等级 ≥ 触发等级、且场景匹配（留空表示不限）时命中。命中后通知「事件归属的学生本人」与所选角色，同一标题在去重窗口内只发一次。" }))}
          <div class="grid grid-2">
            <div class="field"><label class="label">规则名称<span class="req">*</span></label>
              <input class="input" id="gName" placeholder="如 实验室严重违规即时告警"></div>
            <div class="field"><label class="label">场景</label>
              <div class="select-wrap"><select class="select" id="gScene">
                <option value="">不限场景</option>
                <option value="lab_safety">实验室安全识别</option>
                <option value="classroom">课堂行为识别</option>
                <option value="exam_proctor">考场行为监测</option>
                <option value="paper_grading">拍照批改</option>
              </select></div></div>
            <div class="field"><label class="label">触发等级（≥）</label>
              <div class="select-wrap"><select class="select" id="gSev">
                <option value="warning">关注</option>
                <option value="critical">严重</option>
                <option value="info">提示</option>
              </select></div></div>
            <div class="field"><label class="label">通知角色 · 逗号分隔</label>
              <input class="input mono" id="gRoles" value="TEACHER,ADMIN" placeholder="TEACHER,ADMIN"></div>
            <div class="field"><label class="label">去重窗口（分钟）</label>
              <input class="input mono" id="gDedup" value="10"></div>
            <div class="field"><label class="label">通知学生本人</label>
              <div class="select-wrap"><select class="select" id="gStudent">
                <option value="1">是</option>
                <option value="0">否</option>
              </select></div></div>
          </div>
        </div>`,
        footer: h`<button class="btn btn--outline" type="button" data-close>取消</button>
                 <button class="btn btn--primary" type="button" id="gSave">保存规则</button>`,
        mount: (body, close) => {
          body.querySelector("#gSave").addEventListener("click", () => {
            const name = body.querySelector("#gName").value.trim();
            if (!name) { toast("规则名称必填", "err"); return; }
            const payload = {
              name,
              scene: body.querySelector("#gScene").value || null,
              severity: body.querySelector("#gSev").value,
              notify_student: body.querySelector("#gStudent").value === "1",
              notify_roles: body.querySelector("#gRoles").value.trim() || null,
              dedup_minutes: Number(body.querySelector("#gDedup").value || 10),
            };
            const btn = body.querySelector("#gSave");
            btn.disabled = true;
            api.post("/api/situation/rules", payload)
              .then(() => { close(); toast("规则已创建", "ok"); load(); })
              .catch((err) => { toast("创建失败：" + err.message, "err"); btn.disabled = false; });
          });
        },
      });
    });
  }

  load();
  const addBtn = el.querySelector("#rAdd");
  if (addBtn) addBtn.addEventListener("click", openAdd);
}

function planned(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({ title: ctx.child.label, note: ctx.child.desc }))}
    ${raw(plannedPanel(ctx.child))}
  </div>`;
}

function capOverview(ctx, el) {
  const isAdmin = String(ctx.role).toUpperCase() === "ADMIN";
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({ title: ctx.child.label, note: "把各模块的关键数字汇总在一页。" }))}
    <div id="soBody"></div>
  </div>`;
  loadInto(el.querySelector("#soBody"), () => Promise.all([
    api.get("/api/situation/overview").catch(() => null),
    isAdmin ? api.get("/api/admin/monitor").catch(() => null) : Promise.resolve(null),
  ]), (rr) => {
    const v = rr[0] || {}, mon = rr[1];
    return h`<div class="stack">
      <div class="stat-grid">
        ${raw(statCard({ icon: "zap", label: "关注事件", value: v.eventTotal || 0 }))}
        ${raw(statCard({ icon: "alert", label: "待确认", value: v.unacknowledged || 0 }))}
        ${raw(statCard({ icon: "bell", label: "未读通知", value: v.unreadNotifications || 0 }))}
        ${raw(statCard({ icon: "server", label: "服务", value: mon ? "在线" : "—" }))}
      </div>
      ${mon ? renderData(mon, {
        objectTitle: "运行状况",
        labels: {
          resourceMetrics: "资源占用",
          dbMetrics: "数据存储",
          alerts: "用量提醒",
          resourceTrend: "资源变化",
          serviceTrend: "服务变化",
          healthReport: "运行报告",
          errorStats: "异常统计",
        },
        // 指标名（active_user_ratio…）与服务状态（up / placeholder…）都是机器取值，
        // 必须过翻译层，否则会原样出现在表格里。
        valueText: { name: metricText, status: healthText },
      }) : raw(plate({
        title: "平台运行状况",
        body: emptyState({
          icon: "server",
          title: isAdmin ? "暂时没有运行数据" : "这部分只对管理人员开放",
          desc: isAdmin ? undefined : "平台的运行指标由管理人员查看。",
        }),
      }))}
    </div>`;
  });
}
