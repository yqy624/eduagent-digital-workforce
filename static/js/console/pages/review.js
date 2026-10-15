/**
 * 智能评阅。
 *
 * 这是原平台作业链路迁移到新模块的落点，接口真实可用：
 *   GET  /api/review/overview                      五口径总览
 *   GET  /api/review/courses                       课程与班级
 *   GET  /api/review/assignments?course_id=        作业
 *   GET  /api/review/assignments/{id}/submissions  提交列表
 *   POST /api/review/submissions/{id}/grade        人工批改（写回成绩）
 *   POST /api/review/submissions/{id}/ai-grade     AI 批改建议（HITL）
 *   POST /api/review/submissions/scan              拍照上传批改
 *   GET  /api/review/scan/tasks                    待批改清单
 *   GET  /api/review/peer-reviews?assignment_id=   同伴互评
 *   GET  /api/review/grades | /my-peer-reviews     学生侧
 *   GET  /api/review/comment-memories              教师评语库
 *   GET  /api/review/grading-quality               批改质量复核
 * 课程刻意不升为一级菜单：它在本模块里是载体，不是业务主轴。
 */

import { h, raw, esc, num, fmtTime, fmtFull, asList } from "../dom.js";
import { icon } from "../icons.js";
import { api, session } from "../api.js";
import {
  plate, badge, emptyState, noteBox, table, statCard, loading, toast,
  approvalCard, thinkTrace, confMeter, meter, toolChip, taskRow, modal,
  statusText, statusTone,
} from "../ui.js";
import {
  crumb, pageHead, loadInto, plannedPanel, capabilityIndex, renderData, objectTable,
} from "./kit.js";

export function mount(ctx) {
  const el = ctx.canvas;
  if (!ctx.child) return mountHome(ctx, el);
  const map = {
    "review-overview": capOverview,
    "review-courses": capCourses,
    "review-assignments": capAssignments,
    "review-enroll": capEnroll,
    "review-manual": (c, e) => capWorkbench(c, e, true),
    "review-ai": (c, e) => capWorkbench(c, e, true, "ai"),
    "review-scan": capScan,
    "review-peer": capPeer,
    "review-grades": capGrades,
    "review-feedback": (c, e) => capWorkbench(c, e, true, "ai"),
    "review-comments": capComments,
    "review-quality": capQuality,
    "review-analysis": capAnalysis,
    "review-submit": capSubmit,
  };
  if (map[ctx.child.id]) return map[ctx.child.id](ctx, el);
  return defaultCap(ctx, el);
}

/* ==================================================================
 * 模块首页
 * ================================================================== */
function mountHome(ctx, el) {
  if (String(ctx.role).toUpperCase() === "STUDENT") return mountHomeStudent(ctx, el);
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb("全部功能", ctx.module.id, "评阅总览"))}
    ${raw(pageHead({
      title: "智能评阅",
      note: ctx.module.note || "作业全生命周期业务模块，含人工与 AI 双通道批改。课程在这里是载体而非主轴 —— 避免教育属性盖过平台的视觉属性。",
      actions: h`<button class="btn btn--outline btn--sm" type="button" id="rvReload">${raw(icon("refresh"))}刷新</button>`,
    }))}
    <div id="rvStats" class="stat-grid"></div>
    <div class="grid grid-side mt-5">
      <div class="stack"><div id="rvWb"></div></div>
      <div class="stack"><div id="rvQuality"></div><div id="rvSide"></div></div>
    </div>
    <div class="mt-5" id="rvIndex"></div>
  </div>`;

  el.querySelector("#rvIndex").innerHTML = capabilityIndex(ctx);
  el.querySelectorAll("[data-cap]").forEach((row) =>
    row.addEventListener("click", () => ctx.go("#/" + ctx.module.id + "/" + row.getAttribute("data-cap"))));
  el.querySelector("#rvReload").addEventListener("click", () => mount(ctx));

  loadInto(el.querySelector("#rvStats"), () => api.get("/api/review/overview"), (d) => {
    d = d || {};
    return statCard({ icon: "book", label: "任教课程", value: d.courseCount || 0 }) +
      statCard({ icon: "file", label: "已发布作业", value: d.assignmentCount || 0 }) +
      statCard({ icon: "users", label: "学生提交", value: d.submissionCount || 0, hint: "待批改 " + (d.pendingCount || 0) + " 份" }) +
      statCard({ icon: "star", label: "平均分", value: d.averageScore == null ? "—" : Number(d.averageScore).toFixed(1), hint: "已批改 " + (d.gradedCount || 0) + " 份" });
  }, { loadingText: "读取评阅总览" });

  el.querySelector("#rvWb").innerHTML = workbenchShell("rv");
  bindWorkbench(ctx, el.querySelector("#rvWb"), "rv", true);

  loadInto(el.querySelector("#rvQuality"), () => api.get("/api/review/grading-quality"), (d) => {
    d = d || {};
    const enough = d.sampleEnough !== false;
    return plate({
      title: "批改质量",
      sub: "机器扫描与教师给分的对照",
      body: h`<div class="stack-sm">
        <div class="row" style="justify-content:space-between"><span class="t-sm muted">提交总数</span><b class="num">${d.submissionCount || 0}</b></div>
        <div class="row" style="justify-content:space-between"><span class="t-sm muted">已批改</span><b class="num">${d.gradedCount || 0}</b></div>
        <div class="row" style="justify-content:space-between"><span class="t-sm muted">扫描任务</span><b class="num">${d.scanCount || 0}</b></div>
        <div class="row" style="justify-content:space-between"><span class="t-sm muted">需复核</span><b class="num">${d.needReviewCount || 0}</b></div>
        ${!enough && d.note ? h`<div class="mt-2">${raw(noteBox({ kind: "warn", body: esc(d.note) }))}</div>` : ""}
      </div>`,
    });
  }).catch(() => {});

  loadInto(el.querySelector("#rvSide"), () => api.get("/api/review/comment-memories"), (rows) => {
    const list = rows || [];
    return plate({
      title: "教师评语库",
      sub: list.length + " 条常用评语",
      tools: h`<a class="btn btn--ghost btn--sm" href="#/review/review-comments">管理</a>`,
      body: list.length
        ? h`<div class="stack-sm">${raw(list.slice(0, 5).map((m) =>
            h`<div><div class="t-sm">${esc(m.commentText || m.comment_text)}</div>
              <div class="t-xs muted">用到 ${m.usageCount || m.usage_count || 0} 次</div></div>`).join(""))}</div>`
        : emptyState({ icon: "edit", title: "还没有评语记录", desc: "教师用过的评语会在这里积累，下次可一键复用。" }),
    });
  }).catch(() => {});
}

/* ---------- 学生版首页 ---------- */
// 学生不该看到「批改工作台 / 批改质量 / 教师评语库」这类教师工具，
// 那些端点对学生直接 403。这里换成学生自己的三块：概览、成绩、互评。
function mountHomeStudent(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb("全部功能", ctx.module.id, "我的评阅"))}
    ${raw(pageHead({
      title: "智能评阅",
      note: "学生视角：查看作业、提交作答、跟踪成绩与互评。发布与批改属于教师视角，此处不展示。",
      actions: h`<button class="btn btn--outline btn--sm" type="button" id="rvReload">${raw(icon("refresh"))}刷新</button>`,
    }))}
    <div id="rvStats" class="stat-grid"></div>
    <div class="grid grid-2 mt-5">
      <div class="stack"><div id="rvGrades"></div></div>
      <div class="stack"><div id="rvPeer"></div></div>
    </div>
    <div class="mt-5" id="rvIndex"></div>
  </div>`;

  el.querySelector("#rvIndex").innerHTML = capabilityIndex(ctx);
  el.querySelectorAll("[data-cap]").forEach((row) =>
    row.addEventListener("click", () => ctx.go("#/" + ctx.module.id + "/" + row.getAttribute("data-cap"))));
  el.querySelector("#rvReload").addEventListener("click", () => mount(ctx));

  loadInto(el.querySelector("#rvStats"), () => api.get("/api/student/dashboard"), (d) => {
    d = d || {};
    return statCard({ icon: "book", label: "已选课程", value: d.selectedCourseCount || 0 }) +
      statCard({ icon: "check-circle", label: "已批改", value: d.gradedCount || 0 }) +
      statCard({ icon: "upload", label: "待出分提交", value: d.submittedPendingCount || 0, hint: "已提交、未批改" }) +
      statCard({ icon: "users", label: "互评加分", value: d.peerReviewBonus == null ? "—" : Number(d.peerReviewBonus).toFixed(1) });
  }, { loadingText: "读取我的学习概览" });

  loadInto(el.querySelector("#rvGrades"), () => api.get("/api/review/grades"), (list) => {
    const items = asList(list);
    return plate({
      title: "我的成绩", sub: items.length + " 条",
      tools: h`<a class="btn btn--ghost btn--sm" href="#/review/review-grades">全部</a>`,
      body: items.length
        ? h`<div class="stack-sm">${raw(items.slice(0, 6).map((g) => h`<div class="row" style="justify-content:space-between;gap:12px">
            <span class="t-sm">${esc(g.assignmentTitle || g.assignment_title || "作业 " + (g.assignmentId || g.assignment_id || ""))}</span>
            <b class="num">${g.score == null ? "—" : g.score}</b></div>`).join(""))}</div>`
        : emptyState({ icon: "star", title: "还没有成绩记录", desc: "教师批改后成绩会出现在这里。" }),
    });
  });

  loadInto(el.querySelector("#rvPeer"), () => api.get("/api/review/my-peer-reviews"), (list) => {
    const items = asList(list);
    return plate({
      title: "分配给我的互评", sub: items.length + " 条",
      tools: h`<a class="btn btn--ghost btn--sm" href="#/review/review-peer">查看</a>`,
      body: items.length
        ? table({
            columns: [{ t: "作业" }, { t: "被评人" }, { t: "状态" }],
            rows: items.map((r) => ([
              esc(r.assignmentTitle || r.assignment_title || "—"),
              esc(r.targetName || r.target_name || "匿名"),
              badge(r.status || "待评", null),
            ])),
          })
        : emptyState({ icon: "users", title: "暂无互评任务", desc: "教师分配互评后，任务会出现在这里。" }),
    });
  });
}

/* ---------- 批改工作台（课程 → 作业 → 提交） ---------- */
function workbenchShell(id) {
  return plate({
    title: "批改工作台",
    sub: "课程 → 作业 → 提交，逐条确认分数",
    flush: true,
    body: h`<div class="grid grid-wb">
      <div class="wb-col">
        <div class="plate-head" style="border-bottom:1px solid var(--line-soft)">
          <div class="plate-title t-sm">课程</div>
          <span class="spacer"></span><span class="t-xs dim" id="${id}Courses-n">—</span>
        </div>
        <div class="wb-list" id="${id}Courses">${raw(loading())}</div>
      </div>
      <div class="wb-col" style="border-right:0">
        <div class="plate-head" style="border-bottom:1px solid var(--line-soft)">
          <div class="plate-title t-sm" id="${id}ATitle">作业</div>
          <span class="spacer"></span>
          <button class="btn btn--ghost btn--sm" type="button" id="${id}Refresh">${raw(icon("refresh"))}</button>
        </div>
        <div id="${id}Body" style="padding:var(--s-4)">${raw(emptyState({ icon: "pointer", title: "先选一门课程", desc: "左侧选择课程后，这里列出该课程下的作业与提交。" }))}</div>
      </div>
    </div>`,
  });
}

function bindWorkbench(ctx, root, id, allowsAi) {
  const cBox = root.querySelector("#" + id + "Courses");
  const body = root.querySelector("#" + id + "Body");
  const cnt = root.querySelector("#" + id + "Courses-n");
  let current = null;

  loadInto(cBox, () => api.get("/api/review/courses"), (list) => {
    const items = asList(list);
    cnt.textContent = items.length + " 门";
    if (!items.length) return emptyState({
      icon: "book", title: "暂无课程",
      desc: session.role === "ADMIN"
        ? "这个账号名下还没有课程。批改任务按任课关系分配，用任课教师账号登录就能看到对应的课程与作业。"
        : "这里只显示你任教的课程。",
    });
    return items.map((c) => h`<button class="wb-item" type="button" data-course="${c.id}">
      <div class="wi-t">${c.name || c.title || "课程 " + c.id}</div>
      <div class="wi-s">${c.studentCount == null ? "" : (c.studentCount || c.student_count || 0) + " 名学生"}${c.code || c.courseCode ? " · " + (c.code || c.courseCode) : ""}</div>
    </button>`).join("");
  }, { after: (data, host) => {
    const items = asList(data);
    host.querySelectorAll("[data-course]").forEach((b, i) => {
      b.addEventListener("click", () => {
        host.querySelectorAll("[data-course]").forEach((x) => x.classList.toggle("is-on", x === b));
        current = items[i];
        loadAssignments(ctx, body, current, allowsAi, id);
      });
    });
    if (items.length) {
      const first = host.querySelector("[data-course]");
      if (first) first.click();
    }
  } });

  const rf = root.querySelector("#" + id + "Refresh");
  if (rf) rf.addEventListener("click", () => { if (current) loadAssignments(ctx, body, current, allowsAi, id); });
}

function loadAssignments(ctx, body, course, allowsAi, id) {
  body.innerHTML = loading("读取作业");
  api.get("/api/review/assignments?course_id=" + encodeURIComponent(course.id)).then((list) => {
    const items = asList(list);
    if (!items.length) {
      body.innerHTML = emptyState({ icon: "file", title: "该课程还没有作业", desc: "作业发布后，学生的提交会挂在这里等待批改。" });
      return;
    }
    body.innerHTML = h`<div class="stack">
      <div class="seg" id="${id}Asg">${raw(items.map((a, i) =>
        h`<button class="seg-btn ${i === 0 ? "is-on" : ""}" type="button" data-a="${a.id}" title="${a.title || ""}"><span class="seg-l">${a.title || "作业 " + a.id}</span></button>`).join(""))}</div>
      <div id="${id}Subs"></div>
    </div>`;
    const subsBox = body.querySelector("#" + id + "Subs");
    const pick = (a) => loadSubmissions(ctx, subsBox, a, allowsAi, id);
    body.querySelectorAll("[data-a]").forEach((b, i) => {
      b.addEventListener("click", () => {
        body.querySelectorAll("[data-a]").forEach((x) => x.classList.toggle("is-on", x === b));
        pick(items[i]);
      });
    });
    pick(items[0]);
  }).catch((err) => {
    body.innerHTML = noteBox({ kind: "danger", title: "作业读取失败", body: esc(err.message) });
  });
}

function loadSubmissions(ctx, box, assignment, allowsAi, id) {
  box.innerHTML = loading("读取提交");
  api.get("/api/review/assignments/" + encodeURIComponent(assignment.id) + "/submissions").then((list) => {
    const items = asList(list);
    if (!items.length) {
      box.innerHTML = emptyState({
        icon: "clipboard", title: "该作业暂无提交",
        desc: "学生提交后会出现在这里；带图片附件的提交会自动进入拍照批改。",
      });
      return;
    }
    const graded = items.filter((s) => String(s.status).toUpperCase() === "GRADED").length;
    const scores = items.map((s) => s.score).filter((v) => v != null).map(Number);
    const avg = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length) : null;

    box.innerHTML = h`<div class="stack">
      <div class="stat-grid">
        ${raw(statCard({ icon: "users", label: "提交", value: items.length }))}
        ${raw(statCard({ icon: "check-circle", label: "已批改", value: graded }))}
        ${raw(statCard({ icon: "clock", label: "待批改", value: items.length - graded }))}
        ${raw(statCard({ icon: "star", label: "平均分", value: avg == null ? "—" : avg.toFixed(1) }))}
      </div>
      <div class="tbl-wrap"><table class="tbl tbl--zebra">
        <thead><tr><th>学生</th><th>状态</th><th>分数</th><th>评分</th><th>提交时间</th><th>操作</th></tr></thead>
        <tbody>${raw(items.map((s) => rowHtml(s, allowsAi)).join(""))}</tbody>
      </table></div>
    </div>`;

    box.querySelectorAll("[data-grade]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sid = btn.getAttribute("data-grade");
        const input = box.querySelector('[data-score="' + sid + '"]');
        const score = Number(input.value);
        if (input.value === "" || Number.isNaN(score)) { toast("请先填写分数", "err"); return; }
        btn.disabled = true;
        api.post("/api/review/submissions/" + sid + "/grade", { score, feedback: "" })
          .then(() => { toast("成绩已写回 " + score, "ok"); loadSubmissions(ctx, box, assignment, allowsAi, id); })
          .catch((err) => { toast("写回失败：" + err.message, "err"); btn.disabled = false; });
      });
    });

    box.querySelectorAll("[data-ai]").forEach((btn) => {
      btn.addEventListener("click", () => runAiGrade(ctx, box, assignment, btn.getAttribute("data-ai"), allowsAi, id));
    });
  }).catch((err) => {
    box.innerHTML = noteBox({ kind: "danger", title: "提交列表读取失败", body: esc(err.message) });
  });
}

function rowHtml(s, allowsAi) {
  const done = String(s.status).toUpperCase() === "GRADED";
  const name = s.studentName || s.student_name || s.studentNo || s.student_no || "学生 " + s.id;
  return h`<tr>
    <td><div class="t-main">${name}</div><div class="t-sub mono">${s.status || ""}</div></td>
    <td>${done ? badge("已批改", "ok") : badge("待批改", "signal")}</td>
    <td>${s.score == null ? raw('<span class="dim">未评分</span>') : h`<b class="num">${s.score}</b>`}</td>
    <td><input class="input" type="number" step="0.5" min="0" style="width:88px" value="${s.score == null ? "" : s.score}" data-score="${s.id}"></td>
    <td class="num">${esc(fmtTime(s.submittedAt || s.submitted_at || s.createdAt || s.created_at))}</td>
    <td><div class="row" style="gap:6px">
      <button class="btn btn--primary btn--sm" type="button" data-grade="${s.id}">写回</button>
      ${allowsAi ? h`<button class="btn btn--outline btn--sm" type="button" data-ai="${s.id}" title="让模型给出建议分与评语，再决定是否采纳">${raw(icon("sparkles"))}AI 建议</button>` : ""}
    </div></td>
  </tr>`;
}

/** AI 批改：把模型建议放进审批卡，人来决定采不采纳 —— 这条边界不能越过 */
function runAiGrade(ctx, box, assignment, submissionId, allowsAi, id) {
  modal({
    title: "AI 批改建议",
    wide: true,
    body: h`<div id="aiBody">${raw(loading("模型正在阅读作业与评分标准"))}</div>`,
    footer: h`<button class="btn btn--outline" type="button" data-close>关闭</button>`,
    mount: (mBody) => {
      const host = mBody.querySelector("#aiBody");
      api.post("/api/review/submissions/" + submissionId + "/ai-grade")
        .then((d) => {
          const suggestion = d || {};
          const score = suggestion.suggestedScore != null ? suggestion.suggestedScore : suggestion.score;
          const feedback = suggestion.feedback || suggestion.comment || suggestion.suggestedFeedback || "";
          const conf = suggestion.confidence != null ? suggestion.confidence : null;
          const runId = suggestion.runId || suggestion.run_id;
          host.innerHTML = h`<div class="stack">
            ${raw(plate({
              title: "模型建议",
              sub: "尚未写入成绩 —— 需要你确认",
              body: h`<div class="stack">
                <div class="row" style="gap:var(--s-5)">
                  <div><div class="t-xs muted">建议分</div><b class="num" style="font-size:var(--t-2xl)">${score == null ? "—" : score}</b></div>
                  ${conf != null ? h`<div style="flex:1;max-width:260px"><div class="t-xs muted" style="margin-bottom:6px">把握程度</div>${raw(confMeter(conf))}</div>` : ""}
                </div>
                ${feedback ? h`<div><div class="t-xs muted" style="margin-bottom:6px">建议评语</div>
                  <div class="t-sm" style="padding:var(--s-3);background:var(--surface-2);border-radius:var(--r-md);border:1px solid var(--line)">${esc(feedback)}</div></div>` : ""}
                ${runId ? h`<div class="row" style="gap:6px">${raw(toolChip("AI 建议", "", "ok"))}</div>` : ""}
              </div>`,
            }))}
            ${raw(thinkTrace({
              title: "模型看到的依据",
              meta: "为什么给这个分",
              steps: [
                "读取作业要求与评分标准（total_points）",
                "读取学生作答内容与附件状态",
                "比对历史评语库，保持评语风格一致",
                "给出建议分与评语，等待教师确认后写回",
              ],
            }))}
            <div id="aiAct">${raw(approvalCard({
              question: "采纳这条建议吗？",
              desc: "采纳后会立即把分数写回该提交，并保存本次评语以备复用。",
              okText: score == null ? "仅采纳评语" : "采纳并写回 " + score + " 分",
              skipText: "不采纳",
            }))}</div>
          </div>`;
          const act = host.querySelector("#aiAct");
          const btnOk = act.querySelector("[data-approve]");
          const btnSkip = act.querySelector("[data-skip]");
          btnOk.addEventListener("click", () => {
            btnOk.disabled = true;
            api.post("/api/review/submissions/" + submissionId + "/grade", { score: score == null ? 0 : score, feedback: feedback || "" })
              .then(() => { toast("已采纳并写回", "ok"); document.querySelectorAll(".modal").forEach((m) => m.remove()); loadSubmissions(ctx, box, assignment, allowsAi, id); })
              .catch((err) => { toast("写回失败：" + err.message, "err"); btnOk.disabled = false; });
          });
          btnSkip.addEventListener("click", () => {
            const card = act.querySelector("[data-approval]");
            card.style.animation = "none";
            card.innerHTML = noteBox({ kind: "info", title: "已跳过这条建议", body: "分数未变动。你可以手动评分，或重新生成建议。" });
          });
        })
        .catch((err) => {
          const unavailable = err.code === 501;
          host.innerHTML = unavailable
            ? noteBox({
                kind: "warn",
                title: "AI 批改暂不可用",
                body: "平台还没有配置大模型服务，配置完成后本页立即可用。",
              })
            : noteBox({ kind: "danger", title: "生成建议失败", body: esc(err.message) });
        });
    },
  });
}

/* ---------- 能力页 ---------- */
/* ---------- 批改工作台（整页） ---------- */
/**
 * 人工通道与 AI 通道共用同一套工作台，差别只在"点了 AI 试批之后发生什么"：
 * 人工直接写回，AI 先出审批卡、教师确认再写回 —— 两条路最终落到同一条提交记录。
 */
function capWorkbench(ctx, el, allowsAi, mode) {
  const isAi = mode === "ai";

  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({
      title: ctx.child.label,
      note: isAi
        ? "AI 先给出分数、把握程度和理由，由老师确认后才计入成绩，和人工批改落到同一份记录上。"
        : "人工通道。左侧选课程、中间选作业、右侧逐份确认分数与评语后计入成绩。",
    }))}
    <div id="wbHost"></div>
    <div class="grid grid-side mt-5">
      <div class="stack">
        ${raw(isAi
          ? noteBox({
              kind: "info",
              title: "AI 结果走审批，不静默写库",
              body: "点「AI 试批」会先给出一张待确认卡片，上面写明建议分数、把握程度和理由；你确认后才计入成绩。",
            })
          : noteBox({
              kind: "info",
              title: "确认后才计入成绩",
              body: "确认后的分数与评语会立即保存，刷新页面依然在；本页不会另存草稿。",
            }))}
      </div>
      <div class="stack" id="wbSide"></div>
    </div>
  </div>`;

  const host = el.querySelector("#wbHost");
  host.innerHTML = workbenchShell("wb");
  bindWorkbench(ctx, host, "wb", allowsAi);

  loadInto(el.querySelector("#wbSide"), () => api.get("/api/review/grading-quality"), (d) => {
    d = d || {};
    const reviewed = d.reviewedCount || d.reviewed_count || 0;
    const adjusted = d.adjustedCount || d.adjusted_count || 0;
    return plate({
      title: "批改质量复核", sub: "抽查批改结果是否稳定",
      body: h`<div class="stack-sm">
        <div class="row" style="justify-content:space-between"><span class="t-sm">已复核</span><b class="num">${num(reviewed)}</b></div>
        <div class="row" style="justify-content:space-between"><span class="t-sm">人工改判</span><b class="num">${num(adjusted)}</b></div>
        <div class="mt-2">${raw(meter(reviewed ? (adjusted / reviewed) * 100 : 0, "", true))}</div>
        <div class="t-xs muted">改判占比越高，说明模型给出的分越需要人来兜底。</div>
      </div>`,
    });
  });
}

function capOverview(ctx, el) {
  const isStudent = String(ctx.role).toUpperCase() === "STUDENT";
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({ title: ctx.child.label, note: isStudent ? "你的学习概览：已选课程、批改进度与最近成绩。" : "把老师与学生的批改进度汇总成一份总览。" }))}
    <div id="oStats" class="stat-grid"></div>
    <div class="grid mt-5"><div id="oScene"></div></div>
  </div>`;
  const statsSrc = isStudent ? "/api/student/dashboard" : "/api/review/overview";
  loadInto(el.querySelector("#oStats"), () => api.get(statsSrc), (d) => {
    d = d || {};
    if (isStudent) {
      return statCard({ icon: "book", label: "已选课程", value: d.selectedCourseCount || 0 }) +
        statCard({ icon: "check-circle", label: "已批改", value: d.gradedCount || 0 }) +
        statCard({ icon: "upload", label: "待出分提交", value: d.submittedPendingCount || 0 }) +
        statCard({ icon: "users", label: "互评加分", value: d.peerReviewBonus == null ? "—" : Number(d.peerReviewBonus).toFixed(1) });
    }
    return statCard({ icon: "book", label: "课程", value: d.courseCount || 0 }) +
      statCard({ icon: "file", label: "作业", value: d.assignmentCount || 0 }) +
      statCard({ icon: "users", label: "提交", value: d.submissionCount || 0 }) +
      statCard({ icon: "check-circle", label: "已批改", value: d.gradedCount || 0, hint: "待批改 " + (d.pendingCount || 0) });
  });
  // 这里原来还有一块「总览字段」面板：把接口返回的每个键名 + 原始 JSON 值铺成一张表，
  // 副标题是「GET /api/review/overview」。那是给开发对接口用的，对使用者零价值 ——
  // 上面四张卡已经把同样的数字用人话讲完了，故整块删除。
  loadInto(el.querySelector("#oScene"), () => api.get("/api/review/scan/tasks?limit=20"), (rows) => {
    const list = rows || [];
    return plate({
      flush: true, title: "拍照批改记录", sub: list.length + " 条",
      body: table({
        columns: [{ t: "编号" }, { t: "状态" }, { t: "素材" }],
        rows: list.map((t) => ([
          h`<span class="t-code">${esc(t.taskCode || t.task_code || "—")}</span>`,
          badge(statusText(t.status), statusTone(t.status)),
          h`<span class="t-code">${esc(t.sourceRef || t.source_ref || "—")}</span>`,
        ])),
        emptyTitle: "暂无拍照批改记录",
      }),
    });
  });
}

function capCourses(ctx, el) {
  const isStudent = String(ctx.role).toUpperCase() === "STUDENT";
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({ title: ctx.child.label, note: isStudent ? "你已选的课程。作业都挂在课程下。" : "课程与班级在评阅模块里是作业的载体，不单独升为一级菜单。" }))}
    <div id="cList"></div>
  </div>`;
  loadInto(el.querySelector("#cList"), () => api.get(isStudent ? "/api/student/my-courses" : "/api/review/courses"), (list) => {
    const items = asList(list);
    if (!items.length) return emptyState({ icon: "book", title: "暂无课程" });
    if (isStudent) {
      return plate({
        flush: true, title: "我的课程", sub: items.length + " 门",
        body: table({
          columns: [{ t: "课程" }, { t: "授课教师" }, { t: "学分" }, { t: "状态" }],
          rows: items.map((c) => ([
            h`<div class="t-main">${esc(c.name || c.title || "课程 " + c.id)}</div>`,
            esc(c.teacherName || c.teacher_name || "—"),
            h`<span class="num">${c.credits == null ? "—" : c.credits}</span>`,
            c.visible === false ? badge("隐藏", null) : badge("在读", "ok"),
          ])),
        }),
      });
    }
    return plate({
      flush: true, title: "课程列表", sub: items.length + " 门",
      body: table({
        columns: [{ t: "课程" }, { t: "编号" }, { t: "学生数" }, { t: "状态" }],
        rows: items.map((c) => ([
          h`<div class="t-main">${c.name || c.title || "课程 " + c.id}</div>`,
          h`<span class="t-code">${c.code || c.courseCode || "—"}</span>`,
          h`<span class="num">${c.studentCount == null ? (c.student_count == null ? "—" : c.student_count) : c.studentCount}</span>`,
          c.visible === false ? badge("隐藏", null) : badge("可见", "ok"),
        ])),
      }),
    });
  });
}

function capAssignments(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({ title: ctx.child.label, note: "题目、截止时间、评分规则。发布后学生端立即可见。" }))}
    <div id="aLocate" class="mb-4"></div>
    <div id="aList"></div>
  </div>`;
  loadInto(el.querySelector("#aList"), () => api.get("/api/review/courses"), (list) => {
    const items = asList(list);
    if (!items.length) return emptyState({ icon: "book", title: "暂无课程", desc: "作业必须挂在课程下。" });
    return plate({
      flush: true, title: "选择课程查看作业", sub: items.length + " 门可选",
      body: h`<div class="wb-list">${raw(items.map((c) =>
        h`<button class="wb-item" type="button" data-c="${c.id}"><div class="wi-t">${c.name || c.title || "课程 " + c.id}</div></button>`).join(""))}</div>`,
    });
  }, { after: (data, host) => {
    const items = asList(data);
    host.querySelectorAll("[data-c]").forEach((b, i) => b.addEventListener("click", () => {
      host.querySelectorAll("[data-c]").forEach((x) => x.classList.toggle("is-on", x === b));
      const box = el.querySelector("#aList");
      loadInto(box, () => api.get("/api/review/assignments?course_id=" + items[i].id), (rows) => {
        const list = asList(rows);
        if (!list.length) return emptyState({ icon: "file", title: "该课程暂无作业" });
        return plate({
          flush: true, title: items[i].name || items[i].title, sub: list.length + " 份作业",
          body: table({
            columns: [{ t: "作业" }, { t: "总分" }, { t: "截止" }, { t: "提交数" }],
            rows: list.map((a) => ([
              h`<div class="t-main">${a.title || "作业 " + a.id}</div><div class="t-sub">${a.description || ""}</div>`,
              h`<span class="num">${a.totalPoints == null ? (a.total_points == null ? "—" : a.total_points) : a.totalPoints}</span>`,
              h`<span class="num">${esc(fmtFull(a.dueDate || a.due_date))}</span>`,
              h`<span class="num">${a.submissionCount == null ? (a.submission_count == null ? "—" : a.submission_count) : a.submissionCount}</span>`,
            ])),
          }),
        });
      });
    }));
  } });
}

function capEnroll(ctx, el) {
  const isStudent = String(ctx.role).toUpperCase() === "STUDENT";
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({ title: ctx.child.label, note: isStudent ? "你已选的课程。" : "选课、退课与班级名单。名单里的座位号，是识别结果归到学生名下的依据。" }))}
    <div id="eList"></div>
  </div>`;
  // 学生没有班级名单接口的权限，只呈现自己的选课列表。
  if (isStudent) {
    loadInto(el.querySelector("#eList"), () => api.get("/api/student/my-courses"), (list) => {
      const items = asList(list);
      if (!items.length) return emptyState({ icon: "book", title: "还没有选课", desc: "选课开放后，课程会出现在这里。" });
      return plate({
        flush: true, title: "我的选课", sub: items.length + " 门",
        body: table({
          columns: [{ t: "课程" }, { t: "授课教师" }, { t: "上课时间" }],
          rows: items.map((c) => ([
            h`<div class="t-main">${esc(c.name || c.title || "课程 " + c.id)}</div>`,
            esc(c.teacherName || c.teacher_name || "—"),
            esc(c.schedule || "—"),
          ])),
        }),
      });
    });
    return;
  }
  loadInto(el.querySelector("#eList"), () => api.get("/api/review/courses"), (list) => {
    const items = asList(list);
    if (!items.length) return emptyState({ icon: "book", title: "暂无课程" });
    return plate({
      flush: true, title: "选择课程查看名单",
      body: h`<div class="wb-list">${raw(items.map((c) => h`<button class="wb-item" type="button" data-c="${c.id}">
        <div class="wi-t">${c.name || c.title || "课程 " + c.id}</div></button>`).join(""))}</div>`,
    });
  }, { after: (data, host) => {
    const items = asList(data);
    host.querySelectorAll("[data-c]").forEach((b, i) => b.addEventListener("click", () => {
      loadInto(el.querySelector("#eList"), () => api.get("/api/review/enrollments?course_id=" + items[i].id), (rows) => {
        const list = asList(rows);
        return plate({
          flush: true, title: "班级名单", sub: list.length + " 人",
          body: table({
            columns: [{ t: "姓名" }, { t: "学号" }, { t: "状态" }],
            rows: list.map((r) => ([
              esc(r.studentName || r.student_name || r.name || "—"),
              h`<span class="t-code">${r.studentNo || r.student_no || "—"}</span>`,
              badge(r.status || "在读", String(r.status) === "DROPPED" ? null : "ok"),
            ])),
            emptyTitle: "名单为空",
          }),
        });
      });
    }));
  } });
}

function capScan(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({
      title: ctx.child.label,
      note: "拍照识别只负责找出题目位置并给出把握程度，分数仍由老师确认后计入。",
    }))}
    <div class="grid grid-side">
      <div class="stack">
        ${raw(plate({
          title: "提交扫描",
          body: h`<div class="grid grid-2">
            <div class="field"><label class="label">作业编号</label><input class="input mono" id="scA" placeholder="如 12"></div>
            <div class="field"><label class="label">提交编号</label><input class="input mono" id="scS" placeholder="如 340"></div>
            <div class="field"><label class="label">附件编号</label><input class="input mono" id="scF" placeholder="如 10"></div>
            <div class="field"><label class="label">素材位置</label><input class="input mono" id="scP" placeholder="图片在本机的位置"></div>
            <div class="field"><label class="label">灵敏度 <b class="num" id="scCV">0.25</b></label>
              <input class="slider" type="range" id="scC" min="0.05" max="0.9" step="0.05" value="0.25"></div>
          </div>
          <div class="row mt-4"><button class="btn btn--signal" type="button" id="scRun">${raw(icon("scan"))}开始扫描</button>
            <span class="t-xs dim">结果会直接显示在下方</span></div>`,
        }))}
        <div id="scOut"></div>
      </div>
      <div id="scTasks"></div>
    </div>
  </div>`;
  el.querySelector("#scC").addEventListener("input", (e) => { el.querySelector("#scCV").textContent = Number(e.target.value).toFixed(2); });
  el.querySelector("#scRun").addEventListener("click", () => {
    const out = el.querySelector("#scOut");
    const payload = {
      assignment_id: Number(el.querySelector("#scA").value) || null,
      submission_id: Number(el.querySelector("#scS").value) || null,
      file_id: Number(el.querySelector("#scF").value) || null,
      source_ref: el.querySelector("#scP").value.trim() || null,
      conf: Number(el.querySelector("#scC").value),
    };
    out.innerHTML = loading("题块定位中");
    api.post("/api/review/submissions/scan", payload).then((d) => {
      out.innerHTML = plate({
        title: "识别结果", sub: "只给出题目位置与把握程度，不给分数",
        body: renderData(d, { labels: { blocks: "题块" } }),
      });
    }).catch((err) => { out.innerHTML = noteBox({ kind: "danger", title: "扫描失败", body: esc(err.message) }); });
  });
  loadInto(el.querySelector("#scTasks"), () => api.get("/api/review/scan/tasks?limit=20"), (rows) => {
    const list = rows || [];
    return plate({
      flush: true, title: "待批改清单", sub: list.length + " 条",
      body: list.length ? h`<div>${raw(list.map((t) => taskRow({
        state: String(t.status) === "succeeded" ? "done" : String(t.status) === "failed" ? "fail" : "run",
        text: h`<b class="mono">${t.taskCode || t.task_code}</b> · ${t.sourceRef || t.source_ref || "—"}`,
        time: t.latencyMs == null ? "" : Number(t.latencyMs).toFixed(0) + "ms",
      })).join(""))}</div>` : emptyState({ icon: "scan", title: "暂无待批改任务" }),
    });
  });
}

function capPeer(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({ title: ctx.child.label, note: "分配与匿名互评。教师视角看配置与进度，学生视角看分配给我的任务。" }))}
    <div id="pBody"></div>
  </div>`;
  const isStudent = String(ctx.role).toUpperCase() === "STUDENT";
  loadInto(el.querySelector("#pBody"),
    () => (isStudent ? api.get("/api/review/my-peer-reviews") : api.get("/api/review/courses")),
    (data) => {
      if (isStudent) {
        const list = asList(data);
        return plate({
          flush: true, title: "分配给我的互评", sub: list.length + " 条",
          body: table({
            columns: [{ t: "作业" }, { t: "被评人" }, { t: "状态" }],
            rows: list.map((r) => ([esc(r.assignmentTitle || r.assignment_title || "—"), esc(r.targetName || r.target_name || "匿名"), badge(r.status || "待评", null)])),
            emptyTitle: "暂无互评任务",
          }),
        });
      }
      const items = asList(data);
      if (!items.length) return emptyState({ icon: "book", title: "暂无课程" });
      return plate({
        flush: true, title: "选择课程查看互评",
        body: h`<div class="wb-list">${raw(items.map((c) => h`<button class="wb-item" type="button" data-c="${c.id}">
          <div class="wi-t">${c.name || c.title || "课程 " + c.id}</div></button>`).join(""))}</div>`,
      });
    }, { after: (data, host) => {
      if (String(ctx.role).toUpperCase() === "STUDENT") return;
      const items = asList(data);
      host.querySelectorAll("[data-c]").forEach((b, i) => b.addEventListener("click", () => {
        loadInto(el.querySelector("#pBody"), () => api.get("/api/review/assignments?course_id=" + items[i].id), (rows) => {
          const list = asList(rows);
          return plate({
            flush: true, title: "选择作业查看互评概览",
            body: h`<div class="wb-list">${raw(list.map((a) => h`<button class="wb-item" type="button" data-a="${a.id}">
              <div class="wi-t">${a.title || "作业 " + a.id}</div></button>`).join(""))}</div>`,
          });
        }, { after: (rows, host2) => {
          const list = asList(rows);
          host2.querySelectorAll("[data-a]").forEach((b, i) => b.addEventListener("click", () => {
            loadInto(el.querySelector("#pBody"), () => api.get("/api/review/peer-reviews?assignment_id=" + list[i].id),
              (d) => plate({ title: "互评概览 · " + (list[i].title || ""), body: renderData(d) }));
          }));
        } });
      }));
    } });
}

function capGrades(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({ title: ctx.child.label, note: "学生个人成绩与课程均分。" }))}
    <div id="gBody"></div>
  </div>`;
  loadInto(el.querySelector("#gBody"), () => api.get("/api/review/grades"), (list) => {
    const items = asList(list);
    if (!items.length) return emptyState({ icon: "star", title: "还没有成绩记录", desc: "教师批改后成绩会出现在这里。" });
    const scores = items.map((g) => g.score).filter((v) => v != null).map(Number);
    const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    return h`<div class="stack">
      <div class="stat-grid">
        ${raw(statCard({ icon: "file", label: "成绩记录", value: items.length }))}
        ${raw(statCard({ icon: "star", label: "平均分", value: avg == null ? "—" : avg.toFixed(1) }))}
        ${raw(statCard({ icon: "trend", label: "最高分", value: scores.length ? Math.max.apply(null, scores) : "—" }))}
      </div>
      ${raw(plate({
        flush: true, title: "成绩明细",
        body: table({
          columns: [{ t: "作业" }, { t: "课程" }, { t: "分数" }, { t: "批改时间" }],
          rows: items.map((g) => ([
            h`<div class="t-main">${g.assignmentTitle || g.assignment_title || "作业 " + (g.assignmentId || g.assignment_id || "")}</div>`,
            esc(g.courseName || g.course_name || "—"),
            g.score == null ? badge("待批改", "signal") : h`<b class="num">${g.score}</b>`,
            h`<span class="num">${esc(fmtTime(g.gradedAt || g.graded_at || g.createdAt || g.created_at))}</span>`,
          ])),
        }),
      }))}
    </div>`;
  });
}

function capComments(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({ title: ctx.child.label, note: "复用历史评语，减少重复输入，同时保证评语风格一致。" }))}
    <div id="cmBody"></div>
  </div>`;
  loadInto(el.querySelector("#cmBody"), () => api.get("/api/review/comment-memories"), (rows) => {
    const list = asList(rows);
    if (!list.length) return emptyState({ icon: "edit", title: "评语库为空", desc: "教师批改时用过的评语会自动沉淀到这里。" });
    return plate({
      flush: true, title: "常用评语", sub: list.length + " 条 · 按使用次数排序",
      body: table({
        columns: [{ t: "评语" }, { t: "分类" }, { t: "使用次数" }, { t: "最近使用" }],
        rows: list.map((m) => ([
          h`<div class="t-main">${esc(m.commentText || m.comment_text)}</div>`,
          esc(m.category || "未分类"),
          h`<span class="num">${m.usageCount || m.usage_count || 0}</span>`,
          h`<span class="num">${esc(fmtTime(m.lastUsedAt || m.last_used_at))}</span>`,
        ])),
      }),
    });
  });
}

function capQuality(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({ title: ctx.child.label, note: "抽样复查、AI 建议采纳率统计。样本不足时明确说明，不硬算百分比。" }))}
    <div id="qBody"></div>
  </div>`;
  loadInto(el.querySelector("#qBody"), () => api.get("/api/review/grading-quality"), (d) => {
    d = d || {};
    const enough = d.sampleEnough !== false;
    return h`<div class="stack">
      ${!enough && d.note ? raw(noteBox({ kind: "warn", title: "样本不足", body: esc(d.note) })) : ""}
      <div class="stat-grid">
        ${raw(statCard({ icon: "clipboard", label: "提交总数", value: d.submissionCount || 0 }))}
        ${raw(statCard({ icon: "check-circle", label: "已批改", value: d.gradedCount || 0 }))}
        ${raw(statCard({ icon: "scan", label: "扫描任务", value: d.scanCount || 0, hint: (d.scanPlaceholderCount || 0) + " 条为示例结果" }))}
        ${raw(statCard({ icon: "alert", label: "需复核", value: d.needReviewCount || 0 }))}
      </div>
      ${raw(plate({
        title: "质量指标", sub: "从已批改的作业里统计",
        body: h`<dl class="kv">
          <dt>平均分</dt><dd class="num">${d.averageScore == null ? "—" : d.averageScore}</dd>
          <dt>把握不足的题目</dt><dd class="num">${d.lowConfidenceCount || 0}</dd>
          <dt>样本充足</dt><dd>${enough ? badge("是", "ok") : badge("否", "warn")}</dd>
          <dt>结论可信度</dt><dd>${esc(d.note || "—")}</dd>
        </dl>`,
      }))}
    </div>`;
  });
}

function capAnalysis(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({ title: ctx.child.label, note: "作业维度统计分析。" }))}
    <div id="anBody"></div>
  </div>`;
  loadInto(el.querySelector("#anBody"), () => api.get("/api/review/courses"), (list) => {
    const items = asList(list);
    if (!items.length) return emptyState({ icon: "book", title: "暂无课程" });
    return plate({
      flush: true, title: "选择课程",
      body: h`<div class="wb-list">${raw(items.map((c) => h`<button class="wb-item" type="button" data-c="${c.id}">
        <div class="wi-t">${c.name || c.title || "课程 " + c.id}</div></button>`).join(""))}</div>`,
    });
  }, { after: (data, host) => {
    const items = asList(data);
    host.querySelectorAll("[data-c]").forEach((b, i) => b.addEventListener("click", () => {
      loadInto(el.querySelector("#anBody"), () => api.get("/api/review/assignments?course_id=" + items[i].id), (rows) => {
        const list = asList(rows);
        return plate({
          flush: true, title: "选择作业",
          body: h`<div class="wb-list">${raw(list.map((a) => h`<button class="wb-item" type="button" data-a="${a.id}">
            <div class="wi-t">${a.title || "作业 " + a.id}</div></button>`).join(""))}</div>`,
        });
      }, { after: (rows, host2) => {
        const list = asList(rows);
        host2.querySelectorAll("[data-a]").forEach((b, i) => b.addEventListener("click", () => {
          loadInto(el.querySelector("#anBody"), () => api.get("/api/review/assignments/" + list[i].id + "/analysis"),
            (d) => plate({ title: "作业分析 · " + (list[i].title || ""), body: renderData(d) }));
        }));
      } });
    }));
  } });
}

function capSubmit(ctx, el) {
  const isStudent = String(ctx.role).toUpperCase() === "STUDENT";
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({ title: ctx.child.label, note: "文本作答与附件上传。带图片附件的提交会自动登记拍照批改任务。" }))}
    <div id="sbBody"></div>
  </div>`;
  loadInto(el.querySelector("#sbBody"), () => api.get(isStudent ? "/api/student/my-courses" : "/api/review/courses"), (list) => {
    const items = asList(list);
    if (!items.length) return emptyState({ icon: "book", title: "暂无课程" });
    return plate({
      flush: true, title: "选择课程查看作业",
      body: h`<div class="wb-list">${raw(items.map((c) => h`<button class="wb-item" type="button" data-c="${c.id}">
        <div class="wi-t">${c.name || c.title || "课程 " + c.id}</div></button>`).join(""))}</div>`,
    });
  }, { after: (data, host) => {
    const items = asList(data);
    host.querySelectorAll("[data-c]").forEach((b, i) => b.addEventListener("click", () => {
      const asgSrc = isStudent ? "/api/student/courses/" + items[i].id + "/assignments" : "/api/review/assignments?course_id=" + items[i].id;
      loadInto(el.querySelector("#sbBody"), () => api.get(asgSrc), (rows) => {
        const list = asList(rows);
        return plate({
          flush: true, title: "作业", sub: "点选后填写作答",
          body: h`<div class="wb-list">${raw(list.map((a) => h`<button class="wb-item" type="button" data-a="${a.id}">
            <div class="wi-t">${a.title || "作业 " + a.id}</div>
            <div class="wi-s">截止 ${esc(fmtFull(a.dueDate || a.due_date))}</div></button>`).join(""))}</div>`,
        });
      }, { after: (rows, host2) => {
        const list = asList(rows);
        host2.querySelectorAll("[data-a]").forEach((b, i) => b.addEventListener("click", () => {
          el.querySelector("#sbBody").innerHTML = plate({
            title: "作答 · " + (list[i].title || ""),
            body: h`<div class="field"><label class="label">作答内容</label>
                <textarea class="textarea" id="sbText" rows="7" placeholder="在此输入你的答案"></textarea></div>
              <div class="row mt-4"><button class="btn btn--primary" type="button" id="sbSend">${raw(icon("upload"))}提交作业</button>
                <span class="t-xs dim">提交后老师即可看到</span></div>`,
          });
          el.querySelector("#sbSend").addEventListener("click", () => {
            const content = el.querySelector("#sbText").value;
            if (!content.trim()) { toast("作答不能为空", "err"); return; }
            api.post("/api/review/assignments/" + list[i].id + "/submit", { content, file_id: null, file_name: null })
              .then(() => toast("提交成功", "ok"))
              .catch((err) => toast("提交失败：" + err.message, "err"));
          });
        }));
      } });
    }));
  } });
}

function defaultCap(ctx, el) {
  // 只有「无动态参数 + 取数」的 GET 端点才适合页面直接盲取；
  // 含 {id} 占位符的路径若直接请求必然 404，故回退到诚实面板。
  const canFetch = ctx.child.available
    && ctx.child.method === "GET"
    && ctx.child.path
    && !/\{[^}]*\}/.test(ctx.child.path);
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({ title: ctx.child.label, note: ctx.child.desc }))}
    ${canFetch ? h`<div id="dcBody"></div>` : raw(plannedPanel(ctx.child))}
  </div>`;
  const box = el.querySelector("#dcBody");
  if (box) loadInto(box, () => api.raw(ctx.child.path, { method: "GET" }), (d) => plate({ title: ctx.child.label, sub: ctx.child.desc, body: renderData(d) }));
}
