/**
 * 学情洞察。
 *
 * 定位：视觉数据的消费方 —— "以视觉为核心"能否成立的技术依据。
 *
 * 接线现状（本轮对齐后）：
 *   · /api/insight/* 命名空间已注册；
 *   · 聚合类（overview / engagement / alerts / reports / profile）直接查库，
 *     不依赖大模型，因此始终有结果；
 *   · 个体类（diagnosis / learning-plan）复用 /api/ai 下同一批 service，
 *     接口通、但输出质量取决于 LLM 是否接入（当前为占位实现，如实标注）。
 *
 * 注意：endpoint 的查询参数必须 snake_case（响应才会被中间件转成 camelCase）。
 */

import { h, raw, esc, fmtTime, asList } from "../dom.js";
import { icon } from "../icons.js";
import { api, session } from "../api.js";
import { plate, badge, emptyState, noteBox, table, statCard, loading, toast, meter, confMeter, sceneText } from "../ui.js";
import { crumb, pageHead, loadInto, plannedPanel, capabilityIndex, renderData } from "./kit.js";

export function mount(ctx) {
  const el = ctx.canvas;
  if (!ctx.child) return mountHome(ctx, el);
  const map = {
    "insight-overview": capOverview,
    "insight-profiles": capProfiles,
    "insight-diagnosis": capDiagnosis,
    "insight-plan": capPlan,
    "insight-engagement": capEngagement,
    "insight-alerts": capAlerts,
    "insight-reports": capReports,
  };
  if (map[ctx.child.id]) return map[ctx.child.id](ctx, el);
  return planned(ctx, el);
}

/** 学生角色只能看自己：用会话里的 id，无需手填 */
function isStudent(ctx) {
  return String(ctx.role).toUpperCase() === "STUDENT";
}

/** 群体总览：全部指标来自 /api/insight/overview */
function mountHome(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb("全部功能", ctx.module.id, "学情总览"))}
    ${raw(pageHead({
      title: "学情分析",
      note: ctx.module.note || "把课堂、作业与考试的情况汇总起来，看清每个学生的学习状况。",
      actions: h`<button class="btn btn--outline btn--sm" type="button" id="iReload">${raw(icon("refresh"))}刷新</button>`,
    }))}
    <div class="stat-grid" id="iStats"></div>
    <div class="grid grid-side mt-5">
      <div class="stack"><div id="iVision"></div><div id="iIndividual"></div></div>
      <div class="stack"><div id="iWiring"></div></div>
    </div>
    <div class="mt-5" id="iIndex"></div>
  </div>`;
  el.querySelector("#iIndex").innerHTML = capabilityIndex(ctx);
  el.querySelectorAll("[data-cap]").forEach((r) => r.addEventListener("click", () => ctx.go("#/" + ctx.module.id + "/" + r.getAttribute("data-cap"))));
  el.querySelector("#iReload").addEventListener("click", () => mount(ctx));

  loadInto(el.querySelector("#iStats"), () => api.get("/api/insight/overview"), (d) => {
    const v = d || {};
    const sev = v.visionEventBySeverity || {};
    return statCard({ icon: "zap", label: "课堂与考场记录", value: v.visionEventTotal || 0, hint: "学生画像会参考这些记录" }) +
      statCard({
        icon: "alert", label: "待确认", value: v.visionUnacknowledged || 0,
        hint: "严重 " + (sev.critical || 0) + " · 关注 " + (sev.warning || 0),
      }) +
      statCard({ icon: "users", label: "学生总数", value: v.studentTotal || 0 }) +
      statCard({
        icon: "star", label: "平均分",
        value: v.averageScore == null ? "—" : Number(v.averageScore).toFixed(1),
        hint: "已评分 " + (v.gradedTotal || 0) + " / 提交 " + (v.submissionTotal || 0),
      });
  }).catch((err) => {
    el.querySelector("#iStats").innerHTML = noteBox({ kind: "danger", title: "读取失败", body: esc(err.message) });
  });

  // 真实的视觉输入源
  loadInto(el.querySelector("#iVision"), () => api.get("/api/vision/events?limit=200"), (rows) => {
    const list = rows || [];
    if (!list.length) {
      return plate({
        title: "课堂与考场记录",
        body: emptyState({
          icon: "scan", title: "还没有课堂与考场记录",
          desc: "先到「课堂与考场监测」提交一次识别，这里就会显示结果。",
          action: h`<a class="btn btn--signal btn--sm" href="#/vision/vision-inference">去提交识别</a>`,
        }),
      });
    }
    const byScene = {}, bySev = {};
    list.forEach((e) => {
      byScene[sceneText(e.scene)] = (byScene[sceneText(e.scene)] || 0) + 1;
      bySev[e.severity || "info"] = (bySev[e.severity || "info"] || 0) + 1;
    });
    return plate({
      title: "课堂与考场记录", sub: "最近 " + list.length + " 条，按场景与严重程度汇总",
      body: h`<div class="stack">
        <div><div class="t-xs muted" style="margin-bottom:8px">按场景</div>
          <div class="stack-sm">${raw(Object.keys(byScene).map((k) => h`<div>
            <div class="row" style="justify-content:space-between"><span class="t-sm">${k}</span><span class="num t-sm">${byScene[k]}</span></div>
            <div class="mt-2">${raw(meter((byScene[k] / list.length) * 100, "", true))}</div></div>`).join(""))}</div></div>
        <div><div class="t-xs muted" style="margin-bottom:8px">按严重程度</div>
          <div class="legend">
            <span><i style="background:var(--danger)"></i>严重 ${bySev.critical || 0}</span>
            <span><i style="background:var(--signal)"></i>关注 ${bySev.warning || 0}</span>
            <span><i style="background:var(--muted-2)"></i>记录 ${bySev.info || 0}</span>
          </div></div>
      </div>`,
    });
  }).catch((err) => { el.querySelector("#iVision").innerHTML = noteBox({ kind: "danger", title: "读取失败", body: esc(err.message) }); });

  // 个体能力入口
  loadInto(el.querySelector("#iIndividual"), () => api.get(isStudent(ctx) ? "/api/student/my-courses" : "/api/review/courses").catch(() => []), (list) => plate({
    title: "看单个学生",
    sub: "数据来自平台的成绩、作业与课堂记录",
    body: h`<div class="stack">
      ${raw(noteBox({ kind: "info", body: "需要先指定一位学生；学生账号会自动使用当前登录的学生。" }))}
      <div class="row row-wrap">
        <a class="btn btn--outline btn--sm" href="#/insight/insight-profiles">${raw(icon("user"))}学生画像</a>
        <a class="btn btn--outline btn--sm" href="#/insight/insight-diagnosis">${raw(icon("activity"))}学习诊断</a>
        <a class="btn btn--outline btn--sm" href="#/insight/insight-plan">${raw(icon("trend"))}学习路径规划</a>
        <a class="btn btn--outline btn--sm" href="#/insight/insight-reports">${raw(icon("layers"))}学情报告</a>
      </div>
      ${raw(noteBox({ kind: "info", body: "已可见课程 " + asList(list).length + " 门。" }))}
    </div>`,
  }));

  // 数据来源：用用户能读懂的话说明每个数字是怎么来的（不列接口，不标占位）
  el.querySelector("#iWiring").innerHTML = plate({
    title: "这些数字从哪里来",
    sub: "每一项都能追溯到记录，不做推测",
    body: h`<div class="stack-sm">
      ${raw([
        ["班级整体情况", "由课堂与考场的识别记录、学生的作业成绩汇总而来", "ok"],
        ["学生个人情况", "结合他的课程成绩、作业批改结果与课堂表现", "ok"],
        ["课堂参与度", "来自课堂识别记录，按座位表对应到每位学生", "ok"],
        ["需要关注的学生", "出现较严重课堂情况的记录会自动进入关注名单", "ok"],
        ["学情快照", "直接统计已有数据，不做推测，数字可核对", "ok"],
        ["薄弱点诊断", "开启智能分析后才能给出知识点建议", "warn"],
        ["学习计划建议", "需要先选择课程，再开启智能分析生成", "warn"],
      ].map((r) => h`<div class="row" style="gap:var(--s-3);align-items:flex-start">
        <div style="min-width:0"><div class="t-sm strong">${r[0]} ${raw(badge(r[2] === "ok" ? "可用" : "需开启", r[2]))}</div><div class="t-xs muted">${r[1]}</div></div></div>`).join(""))}
    </div>`,
  });
}

/* ---------- 通用：学生维度的查询面板 ---------- */

/**
 * 统一构建「选学生 → 调端点 → 展示」的页面骨架。
 * spec: { method, path(id,qs), body(id), needCourse, formTitle, buttonText,
 *         resultTitle, resultSub, hint, note, render, labels }
 */
function studentScaffold(ctx, el, spec) {
  const student = isStudent(ctx);
  const selfId = session.id;
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({ title: ctx.child.label, note: ctx.child.desc || spec.pageNote }))}
    <div class="grid grid-side">
      <div class="stack"><div id="scForm"></div><div id="scOut"></div></div>
      <div class="stack">${raw(spec.side || noteBox({
        kind: "info", title: "数据来源",
        body: esc("这里显示平台记录到的真实数值，不做额外加工。"),
      }))}</div>
    </div>
  </div>`;

  el.querySelector("#scForm").innerHTML = plate({
    title: spec.formTitle || "查询条件",
    sub: student ? "查看你自己的数据" : "输入学生编号后查看",
    body: h`<div class="stack">
      ${student ? "" : h`<div class="field"><label class="label">学生 ID<span class="req">*</span></label>
        <input class="input mono" id="scId" placeholder="学生编号"></div>`}
      ${spec.needCourse ? h`<div class="field"><label class="label">课程 ID<span class="req">*</span></label>
        <input class="input mono" id="scCourse" placeholder="课程编号"></div>` : ""}
      <div class="row"><button class="btn btn--signal" type="button" id="scRun">${raw(icon("play"))}${spec.buttonText || "查询"}</button>
      <span class="t-xs dim">${spec.hint || ""}</span></div>
      ${spec.note ? raw(noteBox({ kind: "info", body: spec.note })) : ""}
    </div>`,
  });

  el.querySelector("#scRun").addEventListener("click", () => {
    const out = el.querySelector("#scOut");
    let id = selfId;
    if (!student) {
      const idEl = el.querySelector("#scId");
      if (!idEl || !idEl.value.trim()) { toast("请填写学生 ID", "err"); return; }
      id = Number(idEl.value.trim());
    }
    if (id == null || Number.isNaN(id)) {
      out.innerHTML = noteBox({ kind: "warn", title: "会话缺少用户 ID", body: "请退出后重新登录，以刷新本地会话。" });
      return;
    }
    let qs = "";
    if (spec.needCourse) {
      const cEl = el.querySelector("#scCourse");
      if (!cEl || !cEl.value.trim()) { toast("请填写课程 ID", "err"); return; }
      qs = "?course_id=" + encodeURIComponent(cEl.value.trim());
    }
    const path = spec.path(id, qs);
    out.innerHTML = loading(spec.loadingText || "处理中");
    const req = spec.method === "GET"
      ? api.get(path)
      : api.post(path, spec.body ? spec.body(id) : undefined);
    req.then((d) => {
      out.innerHTML = plate({
        title: spec.resultTitle || "结果",
        sub: spec.resultSub || "平台记录到的原始数值，未做加工",
        body: spec.render ? spec.render(d) : renderData(d, { labels: spec.labels }),
      });
    }).catch((err) => {
      console.warn("[console] 调用失败", path, err);
      out.innerHTML = err.code === 501
        ? noteBox({ kind: "warn", title: "这项功能还没开启", body: "需要学校开通智能分析服务后才能使用。" })
        : noteBox({ kind: "danger", title: "操作没能完成", body: esc(err.message) || "请稍后重试。" });
    });
  });
}

/* ---------- 个体能力 ---------- */

function capProfiles(ctx, el) {
  studentScaffold(ctx, el, {
    method: "GET",
    docPath: "/api/insight/students/{id}/profile",
    formTitle: "生成学生画像",
    buttonText: "生成画像",
    resultTitle: "学生画像",
    hint: "课程 · 成绩 · 低分作业",
    path: (id) => "/api/insight/students/" + id + "/profile",
    note: "这些数字直接来自成绩与记录，随时可核对。",
    resultSub: "汇总后的数据",
  });
}

function capDiagnosis(ctx, el) {
  studentScaffold(ctx, el, {
    method: "POST",
    docPath: "/api/insight/students/{id}/diagnosis",
    formTitle: "学习诊断",
    buttonText: "开始诊断",
    resultTitle: "诊断结果",
    hint: "知识点薄弱项诊断",
    path: (id) => "/api/insight/students/" + id + "/diagnosis",
    note: "诊断需要学校先开通智能分析服务；尚未开通时，这里不会给出结论。",
  });
}

function capPlan(ctx, el) {
  studentScaffold(ctx, el, {
    method: "POST",
    needCourse: true,
    docPath: "/api/insight/students/{id}/learning-plan?course_id=…",
    formTitle: "生成学习路径",
    buttonText: "生成学习计划",
    resultTitle: "学习路径",
    hint: "个性化一周学习计划与推荐练习",
    path: (id, qs) => "/api/insight/students/" + id + "/learning-plan" + (qs || ""),
    note: "必须指定课程，否则查不到对应数据。",
  });
}

/* ---------- 视觉消费类 ---------- */

function capEngagement(ctx, el) {
  studentScaffold(ctx, el, {
    method: "GET",
    docPath: "/api/insight/students/{id}/engagement",
    formTitle: "课堂参与度",
    buttonText: "统计参与度",
    resultTitle: "参与度汇总",
    hint: "先把识别记录对到这位学生",
    path: (id) => "/api/insight/students/" + id + "/engagement",
    render: (d) => {
      const scenes = asList(d && d.scenes);
      const sev = (d && d.bySeverity) || {};
      return h`<div class="stack">
        <div class="stat-grid">
          ${raw(statCard({ icon: "target", label: "已对应到人", value: (d && d.identityCount) || 0, hint: "按座位表确定是谁" }))}
          ${raw(statCard({ icon: "zap", label: "相关记录", value: (d && d.eventTotal) || 0 }))}
          ${raw(statCard({ icon: "alert", label: "严重", value: sev.critical || 0 }))}
          ${raw(statCard({ icon: "info", label: "关注", value: sev.warning || 0 }))}
        </div>
        ${d && d.note ? raw(noteBox({ kind: "warn", title: "尚不能对到人", body: esc(d.note) })) : ""}
        ${scenes.length
          ? raw(table({
              columns: [{ t: "场景" }, { t: "记录数" }, { t: "平均把握" }],
              rows: scenes.map((s) => ([
                h`<div class="t-main">${esc(sceneText(s.scene))}</div>`,
                h`<span class="num">${s.count}</span>`,
                h`<div style="width:150px">${raw(confMeter(s.averageConfidence || 0))}</div>`,
              ])),
            }))
          : raw(emptyState({ icon: "scan", title: "没有相关记录", desc: "还没有这位学生的识别记录：可能是还没做学生对应，也可能是相关场景还没有识别过。" }))}
      </div>`;
    },
  });
}

function capAlerts(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({
      title: ctx.child.label,
      note: "按你设定的条件自动提醒，课堂与考场的记录是重要依据。",
      actions: h`<button class="btn btn--outline btn--sm" type="button" id="alReload">${raw(icon("refresh"))}刷新</button>`,
    }))}
    <div class="grid grid-side">
      <div class="stack"><div id="alBody"></div></div>
      <div class="stack">
        ${raw(plate({
          title: "这些提醒从哪来",
          body: h`<div class="stack-sm t-sm">
            <div>这里列出<b>严重</b>与<b>关注</b>两级的情况。</div>
            ${raw(noteBox({ kind: "info", body: "自动提醒条件还在开发中；在那之前，这两级情况本身就值得你人工关注。" }))}
          </div>`,
        }))}
      </div>
    </div>
  </div>`;

  const load = () => loadInto(el.querySelector("#alBody"), () => api.get("/api/insight/alerts?limit=200"), (rows) => {
    const list = rows || [];
    return plate({
      flush: true, title: "需要关注的情况", sub: list.length + " 条关注及以上",
      body: table({
        columns: [{ t: "情况" }, { t: "场景" }, { t: "严重程度" }, { t: "把握" }, { t: "时间" }, { t: "确认" }],
        rows: list.map((e) => ([
          h`<div class="t-main">${esc(e.eventLabel || e.eventType || "情况")}</div><div class="t-sub mono">${esc(e.taskCode || "")}</div>`,
          esc(sceneText(e.scene)),
          badge(e.severity === "critical" ? "严重" : "关注", e.severity === "critical" ? "danger" : "warn"),
          h`<div style="width:120px">${raw(confMeter(e.confidence || 0))}</div>`,
          h`<span class="num">${esc(fmtTime(e.createdAt))}</span>`,
          e.acknowledged
            ? badge("已确认", "ok")
            : (ctx.canWrite ? h`<button class="btn btn--signal btn--sm" type="button" data-ack="${e.id}">${raw(icon("check"))}确认</button>` : '<span class="dim">—</span>'),
        ])),
        emptyTitle: "当前没有需要关注的情况",
        emptyDesc: "这是好事 —— 最近没有识别到需要人工介入的情况。",
      }),
    });
  });

  el.querySelector("#alReload").addEventListener("click", load);
  load();
  el.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-ack]");
    if (!b) return;
    api.post("/api/vision/events/" + b.getAttribute("data-ack") + "/ack")
      .then(() => { toast("已确认", "ok"); load(); })
      .catch((err) => toast("确认失败：" + err.message, "err"));
  });
}

function capReports(ctx, el) {
  studentScaffold(ctx, el, {
    method: "POST",
    docPath: "/api/insight/reports",
    formTitle: "生成学情报告",
    buttonText: "生成报告",
    resultTitle: "学情报告",
    hint: "把评分、薄弱点与课堂表现合在一起",
    resultSub: "一次性汇总，每项都标明来源",
    path: () => "/api/insight/reports",
    body: (id) => ({ student_id: id }),
    note: "报告里的数字都可以核对，系统不会为了好看去改写它们。",
    render: (d) => {
      const s = (d && d.summary) || {};
      const wa = asList(d && d.weakAreas);
      const vis = (d && d.vision) || {};
      const src = asList(d && d.sources);
      const sev = vis.bySeverity || {};
      return h`<div class="stack">
        <div class="stat-grid">
          ${raw(statCard({ icon: "layers", label: "成绩条目", value: s.gradeCount || 0 }))}
          ${raw(statCard({ icon: "star", label: "平均分", value: Number(s.averageScore || 0).toFixed(1) }))}
          ${raw(statCard({ icon: "alert", label: "薄弱点", value: s.weakAreaCount || 0 }))}
          ${raw(statCard({ icon: "zap", label: "课堂与考场记录", value: s.visionEventCount || 0, hint: "已对应到人 " + (vis.identityCount || 0) + " 条" }))}
        </div>
        ${d && d.note ? raw(noteBox({ kind: "info", title: "提示", body: esc(d.note) })) : ""}
        ${wa.length ? raw(plate({
          title: "薄弱作业",
          body: table({
            columns: [{ t: "作业" }, { t: "得分" }],
            rows: wa.map((w) => ([
              h`<div class="t-main">${esc(w.assignmentTitle || ("#" + w.assignmentId))}</div>`,
              h`<span class="num">${w.score == null ? "—" : w.score}</span>`,
            ])),
          }),
        })) : ""}
        ${raw(plate({
          title: "课堂与考场表现分布",
          body: h`<div class="legend">
            <span><i style="background:var(--danger)"></i>严重 ${sev.critical || 0}</span>
            <span><i style="background:var(--signal)"></i>关注 ${sev.warning || 0}</span>
            <span><i style="background:var(--muted-2)"></i>记录 ${sev.info || 0}</span>
          </div>`,
        }))}
        ${src.length ? raw(plate({
          title: "数据来源",
          body: h`<div class="row row-wrap">${raw(src.map((x) =>
            h`<span class="chip">${esc(x.name)}</span>`).join(""))}</div>`,
        })) : ""}
      </div>`;
    },
  });
}

/* ---------- 群体/兜底 ---------- */

function capOverview(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({ title: ctx.child.label, note: ctx.child.desc }))}
    <div id="ovBody"></div>
  </div>`;
  loadInto(el.querySelector("#ovBody"), () => api.get("/api/insight/overview"), (d) => {
    const v = d || {};
    const sev = v.visionEventBySeverity || {};
    return h`<div class="stack">
      ${raw(noteBox({ kind: "info", title: "数据来源", body: "以下数字由平台统一汇总。" }))}
      <div class="stat-grid">
        ${raw(statCard({ icon: "zap", label: "课堂与考场记录", value: v.visionEventTotal || 0, hint: "待确认 " + (v.visionUnacknowledged || 0) }))}
        ${raw(statCard({ icon: "users", label: "学生总数", value: v.studentTotal || 0 }))}
        ${raw(statCard({ icon: "layers", label: "提交总数", value: v.submissionTotal || 0, hint: "已评分 " + (v.gradedTotal || 0) }))}
        ${raw(statCard({ icon: "star", label: "平均分", value: v.averageScore == null ? "—" : Number(v.averageScore).toFixed(1) }))}
      </div>
      ${raw(plate({
        title: "按严重程度分布",
        body: h`<div class="legend">
          <span><i style="background:var(--danger)"></i>严重 ${sev.critical || 0}</span>
          <span><i style="background:var(--signal)"></i>关注 ${sev.warning || 0}</span>
          <span><i style="background:var(--muted-2)"></i>记录 ${sev.info || 0}</span>
        </div>`,
      }))}
    </div>`;
  });
}

function planned(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({ title: ctx.child.label, note: ctx.child.desc }))}
    ${raw(plannedPanel(ctx.child))}
  </div>`;
}
