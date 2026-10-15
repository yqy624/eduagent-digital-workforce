/**
 * 视觉感知中枢。
 *
 * 平台的核心引擎，也是唯一有完整真实接口的模块：
 *   GET  /api/vision/overview   感知总览
 *   GET  /api/vision/scenes     场景清单
 *   POST /api/vision/tasks      提交一次真实分析任务
 *   GET  /api/vision/tasks      任务分页
 *   GET  /api/vision/events     结构化事件流
 *   POST /api/vision/events/{id}/ack  确认事件（人在回路）
 *   GET  /api/vision/identities 身份映射
 *   GET  /api/vision/models     模型资产 + 注册表
 * 数据集 / 模型训练两个能力服务端未落地，如实标注。
 */

import { h, raw, esc, num, fmtTime, fmtFull, relTime, debounce } from "../dom.js";
import { icon } from "../icons.js";
import { api } from "../api.js";
import {
  plate, badge, emptyState, noteBox, table, statCard, loading, toast,
  timeline, bars, confMeter, meter, kv, taskRow, chips, capabilityText, sceneText,
  statusText, statusTone,
} from "../ui.js";
import {
  crumb, pageHead, renderData, loadInto,
  plannedPanel, capabilityIndex, capScaffold, objectTable, rawPanel,
} from "./kit.js";

// 场景页标识 → 提交给后端的场景值 + 页头标题。
// 这里曾经还有一个 sample 字段指向 data/samples/*.jpg，用来预填「素材路径」输入框；
// 该目录从来不存在，用户点提交必然失败 —— 现在改为让用户选本机照片，字段随之删除。
const SCENE_OF = {
  "vision-classroom": { value: "classroom", label: "课堂行为识别" },
  "vision-exam": { value: "exam_proctor", label: "考场行为监测" },
  "vision-lab": { value: "lab_safety", label: "实验室安全识别" },
  "vision-scan": { value: "paper_grading", label: "拍照识别批改" },
};

const SEV = { critical: { t: "严重", k: "danger" }, warning: { t: "关注", k: "warn" }, info: { t: "记录", k: null } };

function eventTitle(e) {
  return e.eventLabel || e.event_label || e.eventType || e.event_type || "事件";
}

/* ==================================================================
 * 模块首页
 * ================================================================== */
export function mount(ctx) {
  const el = ctx.canvas;
  if (!ctx.child) return mountHome(ctx, el);
  const map = {
    "vision-overview": capOverview,
    "vision-models": capModels,
    "vision-inference": capInference,
    "vision-records": capRecords,
    "vision-identity": capIdentity,
    "vision-datasets": capDatasets,
    "vision-training": capTraining,
  };
  if (SCENE_OF[ctx.child.id]) return capScene(ctx, el, SCENE_OF[ctx.child.id]);
  if (map[ctx.child.id]) return map[ctx.child.id](ctx, el);
  return defaultCap(ctx, el);
}

function mountHome(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb("全部功能", ctx.module.id, "感知总览"))}
    ${raw(pageHead({
      title: "课堂与考场监测",
      note: "摄像头与照片的识别都在这里进行，结果会自动汇总到学情分析与提醒里。",
      actions: h`<button class="btn btn--outline btn--sm" type="button" id="vReload">${raw(icon("refresh"))}刷新</button>`,
    }))}
    <div id="vStats" class="stat-grid"></div>
    <div class="grid grid-side mt-5">
      <div class="stack">
        <div id="vScenes"></div>
        <div id="vRunner"></div>
        <div id="vEvents"></div>
      </div>
      <div class="stack">
        <div id="vModels"></div>
        <div id="vIdent"></div>
      </div>
    </div>
    <div class="mt-5" id="vIndex"></div>
  </div>`;

  el.querySelector("#vIndex").innerHTML = capabilityIndex(ctx);
  bindIndexNav(ctx, el);
  el.querySelector("#vReload").addEventListener("click", () => mount(ctx));

  loadOverview(ctx, el);
  loadScenes(ctx, el);
  renderRunner(ctx, el);
  loadEvents(ctx, el, 8);
  loadModels(ctx, el);
  loadIdentityCount(ctx, el);
}

function loadOverview(ctx, el) {
  loadInto(el.querySelector("#vStats"),
    () => api.get("/api/vision/overview"),
    (d) => {
      d = d || {};
      const scenes = d.scenes || [];
      return statCard({ icon: "layers", label: "识别任务", value: d.taskTotal || 0, hint: "累计提交的识别任务" }) +
        statCard({ icon: "zap", label: "发现的情况", value: d.eventTotal || 0, hint: "识别出来的课堂与考场情况" }) +
        statCard({ icon: "alert", label: "待确认", value: d.unacknowledged || 0, hint: "还没有人确认" }) +
        statCard({ icon: "scan", label: "覆盖场景", value: scenes.length || 4, hint: "平台支持的识别场景" });
    },
    { loadingText: "读取感知总览" });

  api.get("/api/vision/overview").then((d) => {
    const box = el.querySelector("#vScenes");
    if (!box) return;
    const data = d || {};
    const st = data.taskByStatus || {};
    const sev = data.eventBySeverity || {};
    const stCols = [
      { label: "成功", value: st.succeeded || 0, max: true },
      { label: "失败", value: st.failed || 0 },
      { label: "运行中", value: st.running || 0 },
      { label: "排队", value: st.pending || 0 },
    ];
    const sevCols = [
      { label: "严重", value: sev.critical || 0 },
      { label: "关注", value: sev.warning || 0 },
      { label: "记录", value: sev.info || 0 },
    ];
    const empty = !stCols.concat(sevCols).some((c) => c.value > 0);
    box.innerHTML = empty
      ? plate({
          title: "任务与事件分布",
          body: emptyState({
            icon: "scan",
            title: "还没有任务与事件",
            desc: "在下方「场景试跑」提交一次分析，任务状态与事件严重度的分布会立刻填上真实数据。",
          }),
        })
      : plate({
          title: "任务状态与事件严重度",
          sub: "今天的识别概况",
          body: h`<div class="grid grid-2">
            <div><div class="t-xs muted" style="margin-bottom:4px">任务状态（共 ${num(data.taskTotal || 0)} 个）</div>
              ${raw(bars(stCols, { height: 130 }))}</div>
            <div><div class="t-xs muted" style="margin-bottom:4px">事件严重度（共 ${num(data.eventTotal || 0)} 条）</div>
              ${raw(bars(sevCols, { height: 130 }))}</div>
          </div>`,
        });
  }).catch(() => {});
}

function loadScenes(ctx, el) {
  api.get("/api/vision/scenes").then((list) => {
    ctx._scenes = list || [];
  }).catch(() => {});
}

function loadIdentityCount(ctx, el) {
  const box = el.querySelector("#vIdent");
  box.innerHTML = loading();
  api.get("/api/vision/identities").then((rows) => {
    const list = rows || [];
    box.innerHTML = plate({
      title: "学生对应",
      sub: "把画面里的人对应到学生",
      tools: h`<a class="btn btn--ghost btn--sm" href="#/vision/vision-identity">查看</a>`,
      body: list.length
        ? h`<dl class="kv">
            <dt>已绑定</dt><dd><b class="num">${list.length}</b> 条</dd>
            <dt>覆盖场景</dt><dd>${esc([...new Set(list.map((r) => r.scene))].filter(Boolean).map(sceneText).join("、") || "—")}</dd>
          </dl>`
        : emptyState({
            icon: "users",
            title: "还没有绑定关系",
            desc: "把画面里的人对到座位表上的学生，识别结果才有归属 —— 否则只知道「有人低头」，不知道是谁。",
          }),
    });
    if (!list.length) return;
    void (function () {})();
  }).catch(() => {
    box.innerHTML = plate({ title: "学生对应", body: noteBox({ kind: "danger", title: "读取失败", body: "暂时读不到，请稍后重试。" }) });
  });
}

/* ---------- 场景试跑：真实提交一次分析任务 ---------- */
function renderRunner(ctx, el) {
  el.querySelector("#vRunner").innerHTML = plate({
    title: "场景试跑",
    sub: "上传一张课堂或考场照片，看看能识别出什么",
    body: h`<div class="grid grid-3">
      <div class="field">
        <label class="label">场景</label>
        <div class="select-wrap"><select class="select" id="vcScene"></select></div>
      </div>
      <div class="field">
        <label class="label">选择照片</label>
        <input class="input" type="file" id="vcSrc" accept="image/*">
      </div>
      <div class="field">
        <label class="label">灵敏度 <b class="num" id="vcConfV">0.30</b></label>
        <input class="slider" type="range" id="vcConf" min="0.05" max="0.9" step="0.05" value="0.3">
      </div>
    </div>
    <div class="row mt-4">
      <button class="btn btn--signal" type="button" id="vcRun">${raw(icon("play"))}提交分析</button>
      <span class="t-xs dim" id="vcHint">支持 jpg、png 等常见图片格式</span>
    </div>
    <div class="mt-4" id="vcOut"></div>`,
  });

  const sel = el.querySelector("#vcScene");
  const conf = el.querySelector("#vcConf");
  const confV = el.querySelector("#vcConfV");
  const run = el.querySelector("#vcRun");
  const out = el.querySelector("#vcOut");

  const scenes = [
    { value: "classroom", label: "课堂行为识别" },
    { value: "lab_safety", label: "实验室安全识别" },
    { value: "exam_proctor", label: "考场行为监测" },
    { value: "paper_grading", label: "拍照识别批改" },
  ];
  const fill = (list) => {
    sel.innerHTML = list.map((s) => h`<option value="${s.value}">${s.label || s.value}</option>`).join("");
  };
  fill(scenes);
  api.get("/api/vision/scenes").then((list) => { if (list && list.length) fill(list); }).catch(() => {});

  conf.addEventListener("input", () => { confV.textContent = Number(conf.value).toFixed(2); });

  run.addEventListener("click", () => {
    const picker = el.querySelector("#vcSrc");
    const file = picker && picker.files && picker.files[0];
    if (!file) {
      out.innerHTML = noteBox({
        kind: "info", title: "先选一张照片",
        body: "点「选择照片」从本机选一张图片，再点提交分析。",
      });
      return;
    }
    out.innerHTML = loading("正在上传照片");
    run.disabled = true;
    const t0 = Date.now();
    const timer = setInterval(() => {
      run.innerHTML = icon("clock") + "运行中 " + ((Date.now() - t0) / 1000).toFixed(1) + "s";
    }, 120);
    const done = () => {
      clearInterval(timer);
      run.innerHTML = icon("play") + "提交分析";
      run.disabled = false;
    };
    const fd = new FormData();
    fd.append("file", file);

    api.raw("/api/files/upload?category=TEMP_UPLOAD", { method: "POST", body: fd })
      .then((up) => api.post("/api/vision/tasks", {
        scene: sel.value, source_ref: up.storage_path, conf: Number(conf.value),
      }))
      .then((d) => {
        out.innerHTML = taskResult(d || {});
        ctx.refreshTimebase && ctx.refreshTimebase();
      })
      .catch((err) => {
        out.innerHTML = noteBox({ kind: "danger", title: "这次识别没能完成", body: esc(err.message) });
      })
      .then(done);
  });
}

function taskResult(d) {
  const ph = d.isPlaceholder === true;
  // 这里曾经显示「实现 <provider> · 模型 <modelName>」——
  // provider / modelName 是内部取值（placeholder / placeholder-yolo），
  // 对用户既看不懂也没用处。保留的是他真正关心的两件事：用了多久、结果可不可信。
  return h`<div class="stack">
    ${noteBox({
      kind: ph ? "warn" : "info",
      title: ph ? "示例结果" : "识别结果",
      body: h`用时 <span class="mono">${d.latencyMs == null ? "—" : Number(d.latencyMs).toFixed(1) + "ms"}</span>`
        + (ph ? "。这是示例结果，用来体验完整流程，请不要当作真实结论。" : "。"),
    })}
    ${plate({
      title: "任务记录",
      sub: "识别结果会出现在下方的实时动态里",
      body: h`<dl class="kv">
        <dt>编号</dt><dd><span class="mono">${esc(d.taskCode || d.task_code || "—")}</span> ${badge(statusText(d.status), statusTone(d.status))}</dd>
        <dt>场景</dt><dd>${esc(sceneText(d.scene))}</dd>
        <dt>素材</dt><dd class="mono t-xs">${esc(d.sourceRef || d.source_ref || "—")}</dd>
        <dt>进度</dt><dd><div style="max-width:180px">${raw(meter(d.progress || 0, statusTone(d.status) === "ok" ? "ok" : "", true))}</div></dd>
      </dl>`,
    })}
    <div id="vcEvents"></div>
  </div>`;
}

/* ---------- 事件流 ---------- */
function loadEvents(ctx, el, limit) {
  const box = el.querySelector("#vEvents");
  box.innerHTML = loading("正在读取动态");
  return api.get("/api/vision/events?limit=" + (limit || 20))
    .then((list) => {
      const evs = list || [];
      if (!evs.length) {
        box.innerHTML = plate({
          title: "识别动态",
          sub: "按时间倒序",
          body: emptyState({
            icon: "zap",
            title: "暂无事件",
            desc: "提交一次识别后，结果会按时间记录在这里，并自动用于学情分析与提醒。",
          }),
        });
        return;
      }
      box.innerHTML = plate({
        title: "识别动态",
        sub: evs.length + " 条最新事件",
        tools: h`<a class="btn btn--ghost btn--sm" href="#/vision/vision-records">全部记录</a>`,
        body: timeline(evs.map((e) => ({
          time: fmtTime(e.createdAt || e.created_at),
          tone: e.severity === "critical" ? "critical" : e.severity === "warning" ? "warning" : null,
          done: !!e.acknowledged,
          title: esc(eventTitle(e)) + " " + badge(SEV[e.severity] ? SEV[e.severity].t : e.severity, SEV[e.severity] ? SEV[e.severity].k : null),
          desc: esc(sceneText(e.scene)) + (e.taskCode || e.task_code ? " · 记录 " + esc(e.taskCode || e.task_code) : "") +
            (e.confidence != null ? " · 把握 " + Math.round(Number(e.confidence) * 100) + "%" : ""),
        }))),
      });
      ctx.setEventCache && ctx.setEventCache(evs);
    })
    .catch((err) => {
      box.innerHTML = plate({ title: "识别动态", body: noteBox({ kind: "danger", title: "读取失败", body: esc(err.message) }) });
    });
}

/* ---------- 模型资产 ---------- */
function loadModels(ctx, el) {
  const box = el.querySelector("#vModels");
  box.innerHTML = loading();
  api.get("/api/vision/models").then((d) => {
    d = d || {};
    const assets = d.assets || [];
    box.innerHTML = plate({
      title: "识别模型",
      sub: "共 " + assets.length + " 项",
      tools: h`<a class="btn btn--ghost btn--sm" href="#/vision/vision-models">详情</a>`,
      body: assets.length
        ? h`<div class="stack-sm">${raw(assets.map((a) =>
            h`<div class="row" style="justify-content:space-between">
              <div><div class="t-sm strong">${esc(a.name || "识别模型")}</div>
                <div class="t-xs muted">${esc(capabilityText(a.capability))}</div></div>
              ${a.isPlaceholder ? badge("示例内容", "warn") : ""}
            </div>`).join(""))}</div>`
        : emptyState({ icon: "box", title: "暂无内容" }),
    });
  }).catch((err) => {
    box.innerHTML = plate({ title: "识别模型", body: noteBox({ kind: "danger", title: "读取失败", body: esc(err.message) }) });
  });
}

/* ==================================================================
 * 能力页
 * ================================================================== */

function bindIndexNav(ctx, el) {
  el.querySelectorAll("[data-cap]").forEach((row) => {
    row.addEventListener("click", () => ctx.go("#/" + ctx.module.id + "/" + row.getAttribute("data-cap")));
  });
}

function capOverview(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({ title: ctx.child.label, note: ctx.child.desc }))}
    <div id="ovStats" class="stat-grid"></div>
    <div id="ovScene" class="mt-5"></div>
  </div>`;
  loadInto(el.querySelector("#ovStats"), () => api.get("/api/vision/overview"), (d) => {
    d = d || {};
    return statCard({ icon: "layers", label: "任务总数", value: d.taskTotal || 0 }) +
      statCard({ icon: "zap", label: "事件总数", value: d.eventTotal || 0 }) +
      statCard({ icon: "alert", label: "待确认事件", value: d.unacknowledged || 0 }) +
      statCard({ icon: "box", label: "示例结果", value: (d.placeholdersInUse || []).length, hint: "仅用于体验流程，不作结论" });
  });
  api.get("/api/vision/overview").then((d) => {
    const data = d || {};
    const st = data.taskByStatus || {};
    const sev = data.eventBySeverity || {};
    el.querySelector("#ovScene").innerHTML = plate({
      title: "任务与事件分布",
      sub: "今天的整体情况",
      body: h`<div class="grid grid-2">
        <div><div class="t-xs muted" style="margin-bottom:4px">任务状态</div>
          ${raw(bars([
            { label: "成功", value: st.succeeded || 0, max: true },
            { label: "失败", value: st.failed || 0 },
            { label: "运行中", value: st.running || 0 },
            { label: "排队", value: st.pending || 0 },
          ], { height: 130 }))}</div>
        <div><div class="t-xs muted" style="margin-bottom:4px">事件严重度</div>
          ${raw(bars([
            { label: "严重", value: sev.critical || 0 },
            { label: "关注", value: sev.warning || 0 },
            { label: "记录", value: sev.info || 0 },
          ], { height: 130 }))}</div>
      </div>`,
    });
  }).catch(() => {});
}

function capModels(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({
      title: ctx.child.label,
      note: "这里可以看到平台具备哪些识别能力，每一项目前用的是哪套模型。",
      actions: h`<button class="btn btn--outline btn--sm" type="button" id="mReload">${raw(icon("refresh"))}刷新</button>`,
    }))}
    <div class="grid grid-side">
      <div class="stack"><div id="mAssets"></div></div>
      <div class="stack"><div id="mRegistry"></div></div>
    </div>
  </div>`;
  const load = () => loadInto(el.querySelector("#mAssets"),
    () => api.get("/api/vision/models"),
    (d) => {
      const assets = (d && d.assets) || [];
      if (!assets.length) return emptyState({ icon: "box", title: "还没有可用的识别模型", desc: "识别模型由平台统一维护，稍后刷新即可。" });
      return plate({
        flush: true, title: "识别模型", sub: "共 " + assets.length + " 项",
        body: table({
          columns: [{ t: "名称" }, { t: "用途" }, { t: "状态" }],
          rows: assets.map((a) => ([
            h`<div class="t-main">${esc(a.name || "识别模型")}</div>`,
            esc(capabilityText(a.capability)),
            a.enabled ? badge("已启用", "info") : badge("已停用", null),
          ])),
        }),
      });
    });
  load();
  el.querySelector("#mReload").addEventListener("click", load);

  loadInto(el.querySelector("#mRegistry"), () => api.get("/api/vision/models"), (d) => {
    const reg = (d && d.registry) || {};
    const defaults = (d && d.defaults) || {};
    const caps = Object.keys(reg);
    if (!caps.length) return emptyState({ icon: "layers", title: "暂无内容" });
    return h`<div class="stack">${raw(caps.map((cap) =>
      plate({
        title: capabilityText(cap),
        sub: "可切换 " + Object.keys(reg[cap] || {}).length + " 个版本",
        body: h`<div class="stack-sm">${raw(Object.keys(reg[cap] || {}).map((name) => {
          const im = reg[cap][name] || {};
          const isDef = name === defaults[cap];
          const idx = Object.keys(reg[cap] || {}).indexOf(name) + 1;
          // 不显示实现名（placeholder-yolo / yolo11n.pt 这种文件名）：用户要的是
          // 「现在用哪个、健不健康」，不是权重文件叫什么。
          return h`<div class="row" style="justify-content:space-between;gap:12px">
            <div style="min-width:0">
              <div class="t-sm strong truncate">第 ${num(idx)} 个版本 ${isDef ? badge("当前使用", "signal") : ""} ${im.isPlaceholder ? badge("示例内容", "warn") : ""}</div>
              <div class="t-xs muted truncate">${im.circuit && im.circuit.open ? "这项能力暂时不可用" : "运行正常"}</div>
            </div>
          </div>`;
        }).join(""))}</div>`,
      })).join(""))}</div>`;
  });
}

function capInference(ctx, el) {
  el.innerHTML = capScaffold(ctx, {});
  const result = el.querySelector("#capResult");
  const load = () => loadInto(result,
    () => api.get("/api/vision/tasks?page=1&page_size=20"),
    (d) => {
      const items = (d && d.items) || [];
      if (!items.length) return emptyState({ icon: "layers", title: "还没有识别任务", desc: "在场景页提交一次任务后，它会在这里排队、执行、留痕。" });
      return plate({
        flush: true,
        title: "识别任务记录",
        sub: "共 " + ((d && d.total) || items.length) + " 条",
        body: table({
          columns: [{ t: "编号" }, { t: "场景" }, { t: "状态" }, { t: "耗时" }, { t: "提交时间" }],
          rows: items.map((t) => ([
            h`<span class="t-code">${esc(t.taskCode || t.task_code || "—")}</span>`,
            esc(sceneText(t.scene)),
            badge(statusText(t.status), statusTone(t.status)),
            h`<span class="num">${t.latencyMs == null ? "—" : Number(t.latencyMs).toFixed(1) + "ms"}</span>`,
            h`<span class="num">${esc(fmtFull(t.createdAt || t.created_at))}</span>`,
          ])),
        }),
      });
    });
  load();
  el.querySelector("#capReload").addEventListener("click", load);
}

function capScene(ctx, el, scene) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({
      title: ctx.child.label,
      note: ctx.child.desc,
      actions: h`<span class="badge badge--scan">${raw(icon("scan"))}${scene.label}</span>`,
    }))}
    <div class="grid grid-side">
      <div class="stack">
        <div id="sRun"></div>
        <div id="sOut"></div>
      </div>
      <div class="stack">
        ${raw(plate({
          title: "这项功能怎么用",
          flush: true,
          body: h`<div style="padding:var(--s-5)"><dl class="kv">
            <dt>识别场景</dt><dd>${scene.label}</dd>
            <dt>需要提供</dt><dd>一个素材（图片、视频或实时画面）</dd>
            <dt>灵敏度</dt><dd>调高更容易发现情况，也更容易误报</dd>
            <dt>你会得到</dt><dd>识别结果，以及按时间排列的事件记录</dd>
          </dl></div>`,
        }))}
        <div id="sEventSide"></div>
      </div>
    </div>
  </div>`;

  const runBox = el.querySelector("#sRun");
  runBox.innerHTML = plate({
    title: "提交分析任务",
    sub: "选一张照片、调好灵敏度，提交后就能看到结果",
    body: h`<div class="grid grid-2">
      <div class="field">
        <label class="label">选择照片</label>
        <input class="input" type="file" id="sSrc" accept="image/*">
      </div>
      <div class="field">
        <label class="label">灵敏度 <b class="num" id="sConfV">0.30</b></label>
        <input class="slider" type="range" id="sConf" min="0.05" max="0.9" step="0.05" value="0.3">
      </div>
    </div>
    <div class="row mt-4">
      <button class="btn btn--signal" type="button" id="sRunBtn">${raw(icon("play"))}提交并查看结果</button>
      <span class="t-xs dim">支持 jpg、png 等常见图片格式</span>
    </div>`,
  });

  el.querySelector("#sConf").addEventListener("input", (e) => {
    el.querySelector("#sConfV").textContent = Number(e.target.value).toFixed(2);
  });
  el.querySelector("#sRunBtn").addEventListener("click", () => {
    const out = el.querySelector("#sOut");
    const picker = el.querySelector("#sSrc");
    const file = picker && picker.files && picker.files[0];
    // 这里原来是「手填一个服务器上的素材路径」，默认值 data/samples/lab.jpg，
    // 而 data/samples/ 根本不存在 —— 用户点提交只会拿到一条报错。
    // 改成选本机照片：上传后拿存储位置再提交任务，只跑一次分析。
    if (!file) {
      out.innerHTML = noteBox({
        kind: "info", title: "先选一张照片",
        body: "点上面的输入框，从本机选一张图片，再点提交。",
      });
      return;
    }
    out.innerHTML = loading("正在上传照片");
    const fd = new FormData();
    fd.append("file", file);
    api.raw("/api/files/upload?category=TEMP_UPLOAD", { method: "POST", body: fd })
      .then((up) => api.post("/api/vision/tasks", {
        scene: scene.value,
        source_ref: up.storage_path,
        conf: Number(el.querySelector("#sConf").value),
      }))
      .then((d) => {
        out.innerHTML = taskResult(d || {});
        const code = d && (d.taskCode || d.task_code);
        const evBox = out.querySelector("#vcEvents");
        if (evBox && code) {
          api.get("/api/vision/events?limit=60").then((list) => {
            const mine = (list || []).filter((x) => (x.taskCode || x.task_code) === code);
            evBox.innerHTML = mine.length
              ? plate({
                  title: "本任务产出的事件", sub: mine.length + " 条",
                  body: h`<div class="stack-sm">${raw(mine.map((e) => h`<div class="row" style="justify-content:space-between">
                    <div><div class="t-sm strong">${esc(eventTitle(e))}</div>
                      <div class="t-xs muted">${esc(sceneText(e.scene))}</div></div>
                    <div style="width:170px">${raw(confMeter(e.confidence || 0))}</div>
                  </div>`).join(""))}</div>`,
                })
              : noteBox({ kind: "info", title: "这次没有发现需要记录的情况", body: "换一张照片，或把灵敏度调低一点再试。" });
          }).catch(() => {});
        }
        ctx.refreshTimebase && ctx.refreshTimebase();
      })
      .catch((err) => {
        out.innerHTML = noteBox({ kind: "danger", title: "这次识别没能完成", body: esc(err.message) });
      });
  });

  loadInto(
    el.querySelector("#sEventSide"),
    () => api.get("/api/vision/events?limit=6"),
    (list) => {
      const evs = list || [];
      return plate({
        title: "最近事件",
        sub: "最新的 6 条动态",
        body: evs.length
          ? timeline(evs.map((e) => ({
              time: fmtTime(e.createdAt || e.created_at),
              tone: e.severity === "critical" ? "critical" : e.severity === "warning" ? "warning" : null,
              title: esc(eventTitle(e)),
              desc: esc(sceneText(e.scene)),
            })))
          : emptyState({ icon: "zap", title: "暂无事件" }),
      });
    }
  );
}

function capRecords(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({
      title: ctx.child.label,
      note: "按时间回看每一次识别，必要时可以人工纠正；教师或管理员确认之后，结果才会计入统计。",
      actions: h`<button class="btn btn--outline btn--sm" type="button" id="rReload">${raw(icon("refresh"))}刷新</button>`,
    }))}
    <div class="grid grid-side">
      <div class="stack">
        <div class="row row-wrap">
          <div class="seg" id="rSeg">
            <button class="seg-btn is-on" data-sev="">全部</button>
            <button class="seg-btn" data-sev="warning">关注</button>
            <button class="seg-btn" data-sev="critical">严重</button>
          </div>
          <span class="spacer"></span>
          <label class="check"><input type="checkbox" id="rUnack"><span>只看未确认</span></label>
        </div>
        <div id="rList"></div>
      </div>
      <div id="rSide"></div>
    </div>
  </div>`;

  let sev = "";
  const load = () => {
    const params = new URLSearchParams();
    params.set("limit", "50");
    if (sev) params.set("severity", sev);
    if (el.querySelector("#rUnack").checked) params.set("acknowledged", "false");
    const list = el.querySelector("#rList");
    loadInto(list, () => api.get("/api/vision/events?" + params.toString()), (rows) => {
      const evs = rows || [];
      if (!evs.length) return emptyState({ icon: "zap", title: "没有符合条件的事件", desc: "换一个筛选条件，或先提交一次场景任务。" });
      const canWrite = ctx.canWrite;
      return plate({
        flush: true, title: "事件记录", sub: evs.length + " 条",
        body: h`<div class="tbl-wrap"><table class="tbl tbl--zebra">
          <thead><tr><th>事件</th><th>场景</th><th>严重度</th><th>把握</th><th>时间</th><th>状态</th><th></th></tr></thead>
          <tbody>${raw(evs.map((e) => {
            const done = !!e.acknowledged;
            const tone = e.severity === "critical" ? "danger" : e.severity === "warning" ? "warn" : null;
            return h`<tr>
              <td><div class="t-main">${eventTitle(e)}</div><div class="t-sub mono">${e.taskCode || e.task_code || ""}</div></td>
              <td>${esc(sceneText(e.scene))}</td>
              <td>${badge(SEV[e.severity] ? SEV[e.severity].t : e.severity || "—", tone)}</td>
              <td><div style="width:130px">${raw(confMeter(e.confidence || 0))}</div></td>
              <td class="num">${esc(fmtTime(e.createdAt || e.created_at))}</td>
              <td>${done ? badge("已确认", "ok") : badge("待确认", "signal")}</td>
              <td>${done || !canWrite ? raw('<span class="dim">—</span>')
                : h`<button class="btn btn--outline btn--sm" type="button" data-ack="${e.id}">${raw(icon("check"))}确认</button>`}</td>
            </tr>`;
          }).join(""))}</tbody></table></div>`,
      });
    }, { after: (data, host) => {
      host.querySelectorAll("[data-ack]").forEach((b) => {
        b.addEventListener("click", () => {
          b.disabled = true;
          api.post("/api/vision/events/" + b.getAttribute("data-ack") + "/ack")
            .then(() => { toast("事件已确认", "ok"); load(); ctx.refreshTimebase && ctx.refreshTimebase(); })
            .catch((err) => { toast("确认失败：" + err.message, "err"); b.disabled = false; });
        });
      });
    } });
  };
  load();
  el.querySelector("#rReload").addEventListener("click", load);
  el.querySelector("#rUnack").addEventListener("change", load);
  el.querySelectorAll("#rSeg .seg-btn").forEach((b) => {
    b.addEventListener("click", () => {
      el.querySelectorAll("#rSeg .seg-btn").forEach((x) => x.classList.toggle("is-on", x === b));
      sev = b.getAttribute("data-sev");
      load();
    });
  });

  loadInto(el.querySelector("#rSide"),
    () => api.get("/api/vision/events?limit=500"),
    (rows) => {
      const evs = rows || [];
      const bySev = { info: 0, warning: 0, critical: 0 };
      const byScene = {};
      evs.forEach((e) => {
        bySev[e.severity] = (bySev[e.severity] || 0) + 1;
        const s = sceneText(e.scene); byScene[s] = (byScene[s] || 0) + 1;
      });
      const unack = evs.filter((e) => !e.acknowledged).length;
      return h`<div class="stack">
        ${raw(plate({
          title: "严重度分布", sub: "最近 500 条事件",
          body: h`<div class="stack-sm">
            ${raw([["严重", bySev.critical, "danger"], ["关注", bySev.warning, "warn"], ["记录", bySev.info, ""]].map((r) =>
              h`<div><div class="row" style="justify-content:space-between"><span class="t-sm">${r[0]}</span><span class="num t-sm">${r[1]}</span></div>
                <div class="mt-2">${raw(meter(evs.length ? (r[1] / evs.length) * 100 : 0, r[2], true))}</div></div>`).join(""))}
          </div>`,
        }))}
        ${raw(plate({
          title: "待处置", body: h`<div class="row" style="justify-content:space-between">
            <span class="t-sm muted">未确认事件</span><b class="num" style="font-size:var(--t-2xl)">${unack}</b></div>`,
        }))}
        ${raw(plate({ title: "按场景", sub: "事件来源分布", body: Object.keys(byScene).length
          ? h`<dl class="kv">${raw(Object.keys(byScene).map((k) => h`<dt>${esc(k)}</dt><dd class="num">${byScene[k]}</dd>`).join(""))}</dl>`
          : emptyState({ icon: "scan", title: "暂无数据" }) }))}
      </div>`;
    });
}

function capIdentity(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({
      title: ctx.child.label,
      note: "把画面里的人对应到具体学生：有这层对应，「有个学生在低头」才能变成「张三从第 15 分钟起持续走神」。座位号加场景决定一个人是谁。",
      actions: ctx.canWrite ? h`<button class="btn btn--primary btn--sm" type="button" id="idAdd">${raw(icon("plus"))}新增绑定</button>` : "",
    }))}
    <div class="grid grid-side">
      <div class="stack"><div id="idList"></div></div>
      <div id="idSide"></div>
    </div>
  </div>`;

  const load = () => loadInto(el.querySelector("#idList"),
    () => api.get("/api/vision/identities"),
    (rows) => {
      const list = rows || [];
      if (!list.length) return emptyState({
        icon: "users", title: "还没有绑定关系",
        desc: "画面里的每个人靠临时编号区分，但成绩与考勤只认学生。缺了这层对应，后面的参与度分析和预警就找不到人。",
        action: ctx.canWrite ? h`<button class="btn btn--signal btn--sm" type="button" data-add>${raw(icon("plus"))}建立第一条绑定</button>` : "",
      });
      return plate({
        flush: true, title: "学生对应名单", sub: list.length + " 条",
        body: table({
          columns: [{ t: "场景" }, { t: "座位" }, { t: "学号" }, { t: "姓名" }, { t: "画面编号" }, { t: "状态" }],
          rows: list.map((r) => ([
            esc(sceneText(r.scene)), esc(r.seatRef || r.seat_ref || "—"),
            h`<span class="mono">${r.studentNo || r.student_no || "—"}</span>`,
            esc(r.displayName || r.display_name || "—"),
            h`<span class="mono">${r.trackId || r.track_id || "—"}</span>`,
            r.enabled ? badge("启用", "ok") : badge("停用", null),
          ])),
        }),
      });
    }, { after: (d, host) => { const b = host.querySelector("[data-add]"); if (b) b.addEventListener("click", openAdd); } });

  function openAdd() {
    const { modal } = window.__console || {};
    void modal;
    import("../ui.js").then((m) => {
      m.modal({
        title: "新增身份绑定",
        body: h`<div class="stack">
          ${noteBox({ kind: "info", body: "座位号加场景就能确定是谁。画面编号可以留空，留空表示按座位自动匹配。", title: "绑定规则" })}
          <div class="grid grid-2">
            <div class="field"><label class="label">场景<span class="req">*</span></label>
              <div class="select-wrap"><select class="select" id="fScene">
                <option value="classroom">课堂行为识别</option>
                <option value="exam_proctor">考场行为监测</option>
                <option value="lab_safety">实验室安全识别</option>
              </select></div></div>
            <div class="field"><label class="label">座位号<span class="req">*</span></label>
              <input class="input mono" id="fSeat" placeholder="如 A-03"></div>
            <div class="field"><label class="label">学号<span class="req">*</span></label>
              <input class="input mono" id="fNo" placeholder="如 S2024001"></div>
            <div class="field"><label class="label">姓名</label>
              <input class="input" id="fName" placeholder="对应学生姓名"></div>
            <div class="field"><label class="label">画面编号</label>
              <input class="input mono" id="fTrack" placeholder="可留空"></div>
            <div class="field"><label class="label">课程编号</label>
              <input class="input mono" id="fCourse" placeholder="可留空"></div>
          </div>
        </div>`,
        footer: h`<button class="btn btn--outline" type="button" data-close>取消</button>
                 <button class="btn btn--primary" type="button" id="fSave">保存绑定</button>`,
        mount: (body, close) => {
          body.querySelector("#fSave").addEventListener("click", () => {
            const payload = {
              scene: body.querySelector("#fScene").value,
              seat_ref: body.querySelector("#fSeat").value.trim(),
              student_no: body.querySelector("#fNo").value.trim() || null,
              display_name: body.querySelector("#fName").value.trim() || null,
              track_id: body.querySelector("#fTrack").value.trim() || null,
              course_id: body.querySelector("#fCourse").value.trim() ? Number(body.querySelector("#fCourse").value) : null,
            };
            if (!payload.seat_ref) { toast("座位号必填", "err"); return; }
            if (!payload.student_no) { toast("请填学号：识别结果要按学号归到学生名下", "err"); return; }
            const btn = body.querySelector("#fSave");
            btn.disabled = true;
            api.post("/api/vision/identities", payload)
              .then(() => { close(); toast("绑定已保存", "ok"); load(); })
              .catch((err) => { toast("保存失败：" + err.message, "err"); btn.disabled = false; });
          });
        },
      });
    });
  }

  load();
  const add = el.querySelector("#idAdd");
  if (add) add.addEventListener("click", openAdd);

  loadInto(el.querySelector("#idSide"),
    () => api.get("/api/vision/identities"),
    (rows) => {
      const list = rows || [];
      const byScene = {};
      list.forEach((r) => { const s = sceneText(r.scene); byScene[s] = (byScene[s] || 0) + 1; });
      return plate({
        title: "已绑定的学生", sub: "按场景统计已绑定的数量",
        body: list.length
          ? h`<dl class="kv">${raw(Object.keys(byScene).map((k) => h`<dt>${esc(k)}</dt><dd class="num">${byScene[k]}</dd>`).join(""))}</dl>`
          : emptyState({ icon: "users", title: "还没有绑定关系" }),
      });
    });
}

function capDatasets(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({ title: ctx.child.label, note: ctx.child.desc }))}
    ${raw(plannedPanel(ctx.child, {
      title: "图片集管理",
      extra: h`<div class="grid grid-3">
        ${raw(["导入图片","统一格式","检查标记"].map((t) => h`<div class="stat"><div class="stat-k">${raw(icon("folder"))}${t}</div>
          <div class="stat-v"><span class="n" style="font-size:var(--t-md)">准备中</span></div>
          <div class="stat-h">暂未开放</div></div>`).join(""))}
      </div>`,
    }))}
  </div>`;
}

function capTraining(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({ title: ctx.child.label, note: ctx.child.desc }))}
    ${raw(plannedPanel(ctx.child, {
      title: "训练自己的识别模型",
      extra: noteBox({
        kind: "info",
        title: "为什么先不做这个",
        body: "训练出来的模型要能直接用于识别才有意义。等图片集整理好、识别效果稳定之后，这里再开放。",
      }),
    }))}
  </div>`;
}

function defaultCap(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({ title: ctx.child.label, note: ctx.child.desc }))}
    ${ctx.child.available
      ? raw(capScaffold(ctx, {}))
      : raw(plannedPanel(ctx.child))}
  </div>`;
  if (ctx.child.available && ctx.child.path) {
    const result = el.querySelector("#capResult");
    // 只有「无动态参数 + 取数」的 GET 端点才适合页面直接盲取；
    // 含 {id} 占位符或写操作端点一律不发请求，避免必然的 404/422。
    const canFetch = (ctx.child.method || "GET") === "GET" && !/\{[^}]*\}/.test(ctx.child.path);
    if (result) {
      if (canFetch) {
        loadInto(result, () => api.raw(ctx.child.path, { method: "GET" }),
          (d) => plate({ title: ctx.child.label, sub: ctx.child.desc, body: renderData(d) }));
      } else {
        result.innerHTML = noteBox({
          kind: "info", title: "这项操作请在对应页面完成",
          body: "本项需要先选定具体对象，或属于改动数据的操作，因此这里不直接展示结果。请到对应的业务页面完成。",
        });
      }
    }
  }
}

export { SCENE_OF };
