/**
 * 平台治理。
 *
 * 「模型与算力资源」是本模块区别于普通管理后台的关键 —— 模型被当作资产管理。
 * 本页直连 /api/governance/* 命名空间（管理员权限）：
 *   GET  /api/governance/overview    治理总览（复用 dashboard 口径）
 *   GET  /api/governance/users       用户与权限
 *   GET  /api/governance/org         组织架构与班级（课程即班级载体）
 *   GET  /api/governance/audit-logs  审计日志
 *   GET  /api/governance/monitor     运行时指标 / 趋势 / 阈值告警
 *   GET  /api/governance/compute     模型注册表 + model_assets 资产台账
 *   GET  /api/governance/files       存储对象列表（补 /api/files 缺失的列表能力）
 * 写操作沿用既有端点（命名空间未提供写口）：
 *   POST /api/admin/users · PUT /api/admin/users/{id}/toggle · DELETE /api/admin/users/{id}
 *   POST /api/files/upload
 *   GET  /api/health                 组件自检 + 模型注册表
 */

import { h, raw, esc, num, fmtTime, fmtFull, asList } from "../dom.js";
import { icon } from "../icons.js";
import { api, session } from "../api.js";
import { plate, badge, emptyState, noteBox, table, statCard, loading, toast, meter, popover, modal, capabilityText,
  fieldText, metricText, healthText, rolesText, actionText, levelText, alertStateText } from "../ui.js";
import { crumb, pageHead, loadInto, plannedPanel, capabilityIndex, renderData, monitorBrief, checkDetail, seriesBars } from "./kit.js";

export function mount(ctx) {
  const el = ctx.canvas;
  if (!ctx.child) return mountHome(ctx, el);
  const map = {
    "governance-overview": capOverview,
    "governance-users": capUsers,
    "governance-org": capOrg,
    "governance-compute": capCompute,
    "governance-files": capFiles,
    "governance-audit": capAudit,
    "governance-monitor": capMonitor,
  };
  if (map[ctx.child.id]) return map[ctx.child.id](ctx, el);
  return planned(ctx, el);
}

function mountHome(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb("全部功能", ctx.module.id, "平台概况"))}
    ${raw(pageHead({
      title: "平台管理",
      note: "账号与权限、院系班级、模型与算力、文件存储。",
    }))}
    <div class="stat-grid" id="gStats"></div>
    <div class="grid grid-side mt-5">
      <div class="stack"><div id="gCompute"></div><div id="gMonitor"></div></div>
      <div class="stack"><div id="gQuick"></div></div>
    </div>
    <div class="mt-5" id="gIndex"></div>
  </div>`;
  el.querySelector("#gIndex").innerHTML = capabilityIndex(ctx);
  el.querySelectorAll("[data-cap]").forEach((r) => r.addEventListener("click", () => ctx.go("#/" + ctx.module.id + "/" + r.getAttribute("data-cap"))));

  loadInto(el.querySelector("#gStats"), () => Promise.all([
    api.get("/api/governance/overview").catch(() => null),
    api.get("/api/health").catch(() => null),
  ]), (rr) => {
    const d = rr[0] || {}, hl = rr[1] || {};
    const checks = hl.checks || {};
    const providers = (checks.modelRegistry || {}).capabilities || {};
    return statCard({ icon: "users", label: "用户", value: d.totalUsers || 0, hint: "学生 " + (d.totalStudents || 0) + " · 教师 " + (d.totalTeachers || 0) }) +
      statCard({ icon: "book", label: "课程", value: d.totalCourses || 0, hint: "选课 " + (d.totalEnrollments || 0) + " 条" }) +
      statCard({ icon: "box", label: "识别能力", value: Object.keys(providers).length, hint: "平台支持的识别能力" }) +
      statCard({ icon: "alert", label: "待处理", value: d.pendingReviewCount || 0, hint: "待批改 / 待复核" });
  });

  loadInto(el.querySelector("#gCompute"), () => api.get("/api/health"), (hl) => {
    const checks = (hl && hl.checks) || {};
    const providers = (checks.modelRegistry || {}).capabilities || {};
    return plate({
      title: "识别模型与算力", sub: "各项识别能力的运行情况",
      tools: h`<a class="btn btn--ghost btn--sm" href="#/governance/governance-compute">详情</a>`,
      body: Object.keys(providers).length
        ? h`<div class="stack-sm">${raw(Object.keys(providers).map((cap) => {
            const info = providers[cap] || {};
            const impls = info.implementations || {};
            const def = info.default;
            const d = impls[def] || {};
            const ph = d.placeholder !== false;
            return h`<div class="row" style="justify-content:space-between">
              <div><div class="t-sm strong">${capabilityText(cap)}</div>
                <div class="t-xs muted">可切换 ${Object.keys(impls).length} 个版本</div></div>
              ${ph ? badge("示例内容", "warn") : ""}</div>`;
          }).join(""))}</div>`
        : emptyState({ icon: "box", title: "暂无内容" }),
    });
  });

  loadInto(el.querySelector("#gMonitor"), () => api.get("/api/governance/monitor"), (d) => plate({
    title: "平台运行状况", sub: "各项服务是否正常",
    tools: h`<a class="btn btn--ghost btn--sm" href="#/governance/governance-monitor">详情</a>`,
    body: monitorBrief(d),
  }));

  el.querySelector("#gQuick").innerHTML = plate({
    title: "快捷入口",
    body: h`<div class="stack-sm">
      ${raw([["users", "账号与权限", "users"], ["org", "院系与班级", "layers"], ["logs", "操作记录", "list"], ["files", "文件与附件", "folder"]].map((r) =>
        h`<a class="btn btn--outline btn--sm" href="#/governance/governance-${r[0]}" style="justify-content:flex-start">
          ${raw(icon(r[2]))}${r[1]}</a>`).join(""))}
    </div>`,
  });
}

function capOverview(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({ title: ctx.child.label, note: "平台运行状况与资源概况。" }))}
    <div id="goBody"></div>
  </div>`;
  loadInto(el.querySelector("#goBody"), () => api.get("/api/governance/overview"), (d) => {
    if (!d) return emptyState({ icon: "activity", title: "暂时读不到平台概况", desc: "稍后刷新再试。" });
    // 只挑「校长真的要看」的几个数，其余交回通用渲染器（由字段词表决定露不露）。
    // 之前这里是「取前 4 个数字键 + 其余 JSON.stringify 上屏」，
    // 结果 totalUsers / todoItems / roleDistribution 这些字段名直接成了界面文字。
    const detail = {};
    ["topCourses", "roleDistribution", "recentVisits", "activities"].forEach((k) => {
      if (Array.isArray(d[k]) && d[k].length) detail[k] = d[k];
    });
    return h`<div class="stack">
      <div class="stat-grid">
        ${raw(statCard({ icon: "users", label: "账号总数", value: d.totalUsers || 0,
          hint: "学生 " + (d.totalStudents || 0) + " · 教师 " + (d.totalTeachers || 0) }))}
        ${raw(statCard({ icon: "book", label: "课程", value: d.totalCourses || 0,
          hint: "选课 " + (d.totalEnrollments || 0) + " 人次" }))}
        ${raw(statCard({ icon: "activity", label: "今日活跃", value: d.todayActiveUsers || 0 }))}
        ${raw(statCard({ icon: "clipboard", label: "待处理", value: d.pendingReviewCount || 0 }))}
      </div>
      ${raw(Object.keys(detail).length
        ? renderData(detail, { objectTitle: "明细" })
        : plate({ title: "明细", body: emptyState({ icon: "activity", title: "暂时没有可展示的明细" }) }))}
    </div>`;
  });
}

/* ---------- 用户与权限 ---------- */
function capUsers(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({
      title: ctx.child.label,
      note: "维护账号，并决定每类账号能看到哪些内容。停用或删除都会留下记录。",
      actions: h`<button class="btn btn--outline btn--sm" type="button" id="uReload">${raw(icon("refresh"))}刷新</button>`,
    }))}
    <div class="row row-wrap mb-4">
      <div class="input-icon" style="min-width:220px"><span class="lead">${raw(icon("search"))}</span>
        <input class="input" id="uSearch" placeholder="按用户名 / 姓名过滤"></div>
      <div class="seg" id="uRole">
        <button class="seg-btn is-on" data-r="">全部</button>
        <button class="seg-btn" data-r="ADMIN">管理员</button>
        <button class="seg-btn" data-r="TEACHER">教师</button>
        <button class="seg-btn" data-r="STUDENT">学生</button>
      </div>
    </div>
    <div id="uList"></div>
  </div>`;

  let role = "", q = "";
  const load = () => loadInto(el.querySelector("#uList"), () => api.get("/api/governance/users"), (d) => {
    let list = asList(d);
    if (role) list = list.filter((u) => String(u.role).toUpperCase() === role);
    if (q) list = list.filter((u) => (String(u.username || "") + String(u.displayName || u.display_name || "")).toLowerCase().indexOf(q) >= 0);
    if (!list.length) return emptyState({ icon: "users", title: "没有匹配的用户" });
    return plate({
      flush: true, title: "账号", sub: list.length + " 个",
      body: table({
        columns: [{ t: "账号" }, { t: "身份" }, { t: "状态" }, { t: "最近登录" }, { t: "操作" }],
        rows: list.map((u) => ([
          h`<div class="t-main">${esc(u.displayName || u.display_name || u.username)}</div><div class="t-sub mono">${esc(u.username)}</div>`,
          badge(String(u.role || "").toUpperCase() === "ADMIN" ? "管理员" : String(u.role || "").toUpperCase() === "TEACHER" ? "教师" : "学生",
            String(u.role || "").toUpperCase() === "ADMIN" ? "danger" : String(u.role || "").toUpperCase() === "TEACHER" ? "info" : null),
          u.enabled === false ? badge("停用", null) : badge("启用", "ok"),
          h`<span class="num">${esc(u.lastLogin || u.last_login ? fmtFull(u.lastLogin || u.last_login) : "—")}</span>`,
          h`<div class="row" style="gap:6px">
            <button class="btn btn--outline btn--sm" type="button" data-toggle="${u.id}" data-on="${u.enabled === false ? 0 : 1}">${u.enabled === false ? "启用" : "停用"}</button>
            <button class="btn btn--ghost btn--sm" type="button" data-del="${u.id}" data-name="${esc(u.username)}" style="color:var(--danger)">${raw(icon("trash"))}</button>
          </div>`,
        ])),
      }),
    });
  }, { after: (data, host) => {
    host.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", () => {
      b.disabled = true;
      const on = b.getAttribute("data-on") === "1";
      api.put("/api/admin/users/" + b.getAttribute("data-toggle") + "/toggle", { enabled: !on })
        .then(() => { toast(on ? "已停用" : "已启用", "ok"); load(); })
        .catch((err) => { toast("操作失败：" + err.message, "err"); b.disabled = false; });
    }));
    host.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
      const id = b.getAttribute("data-del"), name = b.getAttribute("data-name");
      modal({
        title: "删除账号",
        body: noteBox({ kind: "danger", title: "该操作不可撤销", body: "将删除账号 " + esc(name) + " 及其关联数据，删除后无法登录。" }),
        footer: h`<button class="btn btn--outline" type="button" data-close>取消</button>
                 <button class="btn btn--danger" type="button" id="delOk">确认删除</button>`,
        mount: (body, close) => {
          body.querySelector("#delOk").addEventListener("click", () => {
            api.del("/api/admin/users/" + id).then(() => { close(); toast("已删除", "ok"); load(); })
              .catch((err) => toast("删除失败：" + err.message, "err"));
          });
        },
      });
    }));
  } });
  load();
  el.querySelector("#uReload").addEventListener("click", load);
  el.querySelector("#uSearch").addEventListener("input", (e) => { q = e.target.value.trim().toLowerCase(); load(); });
  el.querySelectorAll("#uRole .seg-btn").forEach((b) => b.addEventListener("click", () => {
    el.querySelectorAll("#uRole .seg-btn").forEach((x) => x.classList.toggle("is-on", x === b));
    role = b.getAttribute("data-r");
    load();
  }));
}

function capOrg(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({ title: ctx.child.label, note: "维护院系、班级与座位表。有座位表，识别结果才能对应到具体学生。" }))}
    <div id="oBody"></div>
  </div>`;
  loadInto(el.querySelector("#oBody"), () => api.get("/api/governance/org"), (d) => {
    const list = asList(d);
    if (!list.length) return emptyState({ icon: "school", title: "暂无课程记录" });
    return plate({
      flush: true, title: "课程列表", sub: list.length + " 门（含可见性与批量调整）",
      body: table({
        columns: [{ t: "课程" }, { t: "编号" }, { t: "授课教师" }, { t: "选课 / 上限" }, { t: "可见性" }],
        rows: list.map((c) => ([
          h`<div class="t-main">${esc(c.name || c.title || "课程 " + c.id)}</div>`,
          h`<span class="t-code">${esc(c.code || c.courseCode || "—")}</span>`,
          esc(teacherLabel(c)),
          h`<span class="num">${c.enrolledCount == null ? "—" : c.enrolledCount} / ${c.maxStudents == null ? "—" : c.maxStudents}</span>`,
          c.visible === false ? badge("隐藏", null) : badge("可见", "ok"),
        ])),
      }),
    });
  });
}

/* ---------- 模型与算力资源 ---------- */
function capCompute(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({ title: ctx.child.label, note: "查看识别模型有哪些版本，以及服务器算力的占用情况。" }))}
    <div id="cpBody"></div>
    <div id="cpAssets" class="mt-5"></div>
  </div>`;
  loadInto(el.querySelector("#cpBody"), () => api.get("/api/health"), (hl) => {
    const checks = (hl && hl.checks) || {};
    const reg = (checks.modelRegistry || {}).capabilities || {};
    const caps = Object.keys(reg);
    return h`<div class="stack">
      <div class="stat-grid">
        ${raw(statCard({ icon: "box", label: "模型能力", value: caps.length }))}
        ${raw(statCard({ icon: "cpu", label: "服务状态", value: healthText(hl && hl.status) }))}
        ${raw(statCard({ icon: "database", label: "资料检索", value: checks.vectorStore && checks.vectorStore.status === "ok" ? "可用" : "未启用" }))}
        ${raw(statCard({ icon: "layers", label: "语义理解", value: checks.embeddings && checks.embeddings.status === "ok" ? "就绪" : "未就绪" }))}
      </div>
      ${caps.length ? h`<div class="grid grid-2">${raw(caps.map((cap) => {
        const info = reg[cap] || {};
        const impls = info.implementations || {};
        const def = info.default;
        return plate({
          title: capabilityText(cap), sub: "可切换 " + Object.keys(impls).length + " 个版本",
          flush: true,
          body: h`<div>${raw(Object.keys(impls).map((n) => {
            const im = impls[n] || {};
            const ph = im.placeholder !== false;
            const idx = Object.keys(impls).indexOf(n) + 1;
            // 不显示实现名（placeholder-hash-embedding 这类）：它是权重文件标识，
            // 对使用者没有意义，只需要知道「是不是当前在用的、用起来正不正常」。
            return h`<div class="row" style="justify-content:space-between;padding:11px var(--s-5);border-bottom:1px solid var(--line-soft)">
              <div style="min-width:0"><div class="t-sm strong truncate">第 ${num(idx)} 个版本 ${n === def ? badge("当前使用", "signal") : ""}</div>
                <div class="t-xs muted truncate">${ph ? "示例内容，仅用于体验流程" : "正常使用中"}</div></div>
              ${ph ? badge("示例内容", "warn") : ""}</div>`;
          }).join(""))}</div>`,
        });
      }).join(""))}</div>` : emptyState({ icon: "box", title: "暂无内容" })}
      ${raw(noteBox({
        kind: "info", title: "关于识别模型",
        body: "平台会持续升级识别模型，你在功能页面里的操作方式不会改变。",
      }))}
    </div>`;
  });

  // model_assets 台账：模型被当作资产逐个登记（权重路径、版本、许可、是否占位）
  loadInto(el.querySelector("#cpAssets"), () => api.get("/api/governance/compute").catch((e) => ({ __err: e.message })), (d) => {
    if (d && d.__err) return noteBox({ kind: "danger", title: "读取失败", body: "暂时取不到数据，请稍后重试。" });
    const assets = (d && d.assets) || [];
    if (!assets.length) return emptyState({ icon: "box", title: "还没有登记模型", desc: "上传模型后会在这里列出。" });
    return plate({
      flush: true, title: "识别模型", sub: "共 " + assets.length + " 项",
      body: table({
        columns: [{ t: "名称" }, { t: "用途" }, { t: "状态" }],
        rows: assets.map((a) => [
          h`<div class="t-main">${esc(a.name || "识别模型")}</div>`,
          esc(capabilityText(a.capability)),
          a.isPlaceholder ? badge("示例", "warn") : badge("真实", "ok"),
        ]),
      }),
    });
  });
}

/* ---------- 文件与对象存储 ---------- */
function capFiles(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({ title: ctx.child.label, note: "截图、作业附件与课程文档统一在这里管理。" }))}
    <div class="grid grid-side">
      <div class="stack">
        ${raw(plate({
          title: "上传文件",
          body: h`<div class="stack">
            <input type="file" id="fFile" class="input" style="height:auto;padding:8px">
            <div class="row"><button class="btn btn--primary" type="button" id="fUp">${raw(icon("upload"))}上传文件</button></div>
            <div id="fOut"></div>
          </div>`,
        }))}
      </div>
      <div class="stack"><div id="fList"></div></div>
    </div>
  </div>`;

  const loadList = () => loadInto(el.querySelector("#fList"), () => api.get("/api/governance/files?limit=100").catch((e) => ({ __err: e.message })), (d) => {
    if (d && d.__err) return noteBox({ kind: "danger", title: "读取失败", body: "暂时取不到数据，请稍后重试。" });
    const list = asList(d);
    if (!list.length) return emptyState({ icon: "folder", title: "暂无文件", desc: "上传文件后会在这里列出。" });
    return plate({
      flush: true, title: "文件", sub: "共 " + list.length + " 个",
      body: table({
        columns: [{ t: "文件" }, { t: "类别" }, { t: "大小" }, { t: "上传时间" }],
        rows: list.map((f) => [
          h`<div class="t-main">${esc(f.originalName || f.objectKey || "—")}</div><div class="t-sub mono">${esc(f.contentType || f.extension || "")}</div>`,
          badge(f.category || "—", null),
          h`<span class="num">${esc(fmtBytes(f.size))}</span>`,
          h`<span class="num">${esc(fmtFull(f.createdAt))}</span>`,
        ]),
      }),
    });
  });
  loadList();

  el.querySelector("#fUp").addEventListener("click", () => {
    const f = el.querySelector("#fFile").files[0];
    if (!f) { toast("请先选择文件", "err"); return; }
    const fd = new FormData();
    fd.append("file", f);
    const out = el.querySelector("#fOut");
    out.innerHTML = loading("上传中");
    api.raw("/api/files/upload", { method: "POST", body: fd }).then((d) => {
      out.innerHTML = plate({ title: "上传成功", body: renderData(d) });
      toast("上传成功", "ok");
      loadList();
    }).catch((err) => { out.innerHTML = noteBox({ kind: "danger", title: "上传失败", body: "暂时取不到数据，请稍后重试。" }); });
  });
}

/** 授课教师：后端可能返回嵌套对象 {id, username, displayName}，也可能是字符串。 */
function teacherLabel(c) {
  const t = c && c.teacher;
  if (t && typeof t === "object") return t.displayName || t.username || "—";
  return (c && (c.teacherName || c.teacher)) || "—";
}

/** 字节数转可读字符串。 */
function fmtBytes(n) {
  if (n == null) return "—";
  const v = Number(n);
  if (!isFinite(v)) return "—";
  if (v < 1024) return v + " B";
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " KB";
  if (v < 1024 * 1024 * 1024) return (v / (1024 * 1024)).toFixed(1) + " MB";
  return (v / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function capAudit(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({ title: ctx.child.label, note: "谁在什么时候做了什么，都会留在这里。" }))}
    <div id="auBody"></div>
  </div>`;
  loadInto(el.querySelector("#auBody"), () => api.get("/api/governance/audit-logs"), (d) => {
    const list = asList(d);
    if (!list.length) return emptyState({ icon: "clipboard", title: "暂无操作记录" });
    // 之前这里用接口返回的**键名**当表头（会显示 ipAddress / details），
    // 还把 details 里的原始 JSON 直接铺进单元格。现在只列用户看得懂的列。
    return plate({
      flush: true, title: "操作记录", sub: list.length + " 条",
      body: table({
        columns: [{ t: "时间" }, { t: "账号" }, { t: "身份" }, { t: "操作" }, { t: "来源地址" }],
        rows: list.map((r) => [
          h`<span class="num">${esc(fmtFull(r.timestamp || r.createdAt || r.created_at))}</span>`,
          esc(r.username || "—"),
          badge(rolesText(r.role), r.role === "ADMIN" ? "signal" : null),
          esc(actionText(r.action)),
          h`<span class="mono t-sm">${esc(r.ipAddress || "—")}</span>`,
        ]),
      }),
    });
  });
}

function capMonitor(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({
      title: ctx.child.label,
      note: "查看各项服务是否正常，以及识别任务有没有堆积。",
    }))}
    <div id="mnBrief" class="stat-grid"></div>
    <div class="grid grid-2 mt-5">
      <div class="stack"><div id="mnHealth"></div><div id="mnMetrics"></div></div>
      <div class="stack"><div id="mnTrend"></div><div id="mnAlerts"></div></div>
    </div>
  </div>`;

  loadInto(el.querySelector("#mnBrief"), () => Promise.all([
    api.get("/api/health").catch(() => null),
    api.get("/api/governance/monitor").catch(() => null),
  ]), (rr) => {
    const hl = rr[0] || {}, mon = rr[1] || {};
    const checks = hl.checks || {};
    const keys = Object.keys(checks);
    const bad = keys.filter((k) => checks[k] && checks[k].status !== "ok");
    const alerts = Array.isArray(mon.alerts) ? mon.alerts : [];
    return statCard({ icon: "activity", label: "总体状态", value: healthText(hl.status) }) +
      statCard({
        icon: "server", label: "组件自检", value: keys.length,
        hint: bad.length ? bad.length + " 项没就绪：" + bad.map((k) => fieldText(k) || "组件").join("、") : "全部就绪",
      }) +
      statCard({ icon: "clock", label: "已运行", value: mon.uptime || "—" }) +
      statCard({
        icon: "alert", label: "用量提醒", value: alerts.length,
        hint: alerts.length ? String(alerts[0].title || alerts[0].message || "") : "没有需要处理的提醒",
      });
  });

  loadInto(el.querySelector("#mnHealth"), () => api.get("/api/health"), (hl) => {
    const checks = (hl && hl.checks) || {};
    const keys = Object.keys(checks);
    if (!keys.length) return emptyState({ icon: "shield-check", title: "没有自检项" });
    return plate({
      flush: true,
      title: "组件自检", sub: "各项组件是否正常",
      body: table({
        columns: [{ t: "组件" }, { t: "状态" }, { t: "明细" }],
        rows: keys.map((k) => {
          const c = checks[k] || {};
          const tone = c.status === "ok" ? "ok" : c.status === "error" ? "danger" : "warn";
          return [
            h`<span class="t-main">${esc(fieldText(k) || "组件")}</span>`,
            badge(healthText(c.status), tone),
            h`<span class="t-xs muted">${checkDetail(c)}</span>`,
          ];
        }),
      }),
    });
  });

  loadInto(el.querySelector("#mnMetrics"), () => api.get("/api/governance/monitor"), (d) => {
    const b = d || {};
    const rows = [];
    const push = (group, arr) => (Array.isArray(arr) ? arr : []).forEach((m) => {
      rows.push([group, metricText(m.name), m.value, m.threshold, !!m.alert]);
    });
    push("资源", b.resourceMetrics);
    push("数据存储", b.dbMetrics);
    if (!rows.length) return emptyState({ icon: "gauge", title: "没有指标数据" });
    return plate({
      flush: true, title: "运行指标", sub: "各项指标的当前值与警戒线",
      body: table({
        columns: [{ t: "类别" }, { t: "指标" }, { t: "当前值" }, { t: "警戒线" }, { t: "判定" }],
        rows: rows.map((r) => [
          esc(String(r[0])),
          h`<span class="mono t-sm">${r[1]}</span>`,
          h`<span class="num">${r[2]}</span>`,
          h`<span class="num muted">${r[3] == null ? "—" : r[3]}</span>`,
          badge(r[4] ? "超出警戒线" : "正常", r[4] ? "danger" : "ok"),
        ]),
      }),
    });
  });

  loadInto(el.querySelector("#mnTrend"), () => api.get("/api/governance/monitor"), (d) => {
    const b = d || {};
    const svc = b.serviceTrend || {};
    const res = Array.isArray(b.resourceTrend) ? b.resourceTrend : [];
    const blocks = [];
    if (Array.isArray(svc.labels) && Array.isArray(svc.successRate)) {
      blocks.push(seriesBars(svc.labels, svc.successRate, "服务成功率（%）", 140));
    }
    if (Array.isArray(svc.labels) && Array.isArray(svc.responseTime)) {
      blocks.push(seriesBars(svc.labels, svc.responseTime, "响应时间（ms）", 140));
    }
    res.forEach((t) => {
      const first = Array.isArray(t.values) ? t.values[0] : null;
      const vals = Array.isArray(first) ? first : (Array.isArray(t.values) ? t.values : []);
      if (Array.isArray(t.labels) && vals.length) {
        blocks.push(seriesBars(t.labels, vals, metricText(t.name), 128));
      }
    });
    if (!blocks.length) return emptyState({ icon: "trend", title: "没有趋势数据" });
    return h`<div class="stack">${raw(blocks.join(""))}</div>`;
  });

  loadInto(el.querySelector("#mnAlerts"), () => api.get("/api/governance/monitor"), (d) => {
    const alerts = Array.isArray((d || {}).alerts) ? d.alerts : [];
    if (!alerts.length) {
      return emptyState({ icon: "shield-check", title: "没有待处理的提醒", desc: "超出警戒线的指标会在这里登记。" });
    }
    return plate({
      flush: true, title: "用量提醒", sub: alerts.length + " 条",
      body: table({
        columns: [{ t: "级别" }, { t: "内容" }, { t: "状态" }, { t: "时间" }],
        rows: alerts.map((a) => [
          badge(levelText(a.level), /warn|critical/i.test(String(a.level)) ? "warn" : null),
          h`<div class="t-main">${esc(a.title || "—")}</div>${a.message ? h`<div class="t-sub">${esc(a.message)}</div>` : ""}`,
          badge(alertStateText(a.status), a.status === "OPEN" ? "signal" : "ok"),
          h`<span class="num">${esc(fmtFull(a.time))}</span>`,
        ]),
      }),
    });
  });
}

function planned(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({ title: ctx.child.label, note: ctx.child.desc }))}
    ${raw(plannedPanel(ctx.child))}
  </div>`;
}
