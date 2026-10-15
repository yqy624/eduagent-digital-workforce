/**
 * 知识智能。
 *
 * 现有 RAG 与 Agent 能力的归位。全部走已注册的 /api/knowledge 命名空间：
 *   POST /api/knowledge/courses/{id}/documents/index  文档索引入库
 *   POST /api/knowledge/courses/{id}/qa               基于知识库的检索问答
 *   POST /api/knowledge/agent/chat                    Agent 对话（工具编排）
 *   GET  /api/knowledge/runs/{id}                     运行记录
 *   GET  /api/knowledge/runs/{id}/tool-calls          工具调用轨迹
 *   POST /api/knowledge/regulations/match             视觉事件 → 规范条文
 * 对话区刻意采用「白盒」呈现：工具芯片 + 可展开轨迹 + 行内引用，
 * 让人看得见 agent 做了什么，而不是只给一段结论。
 *
 * 注意：请求体/查询参数保持 snake_case（响应才会被中间件转成 camelCase）。
 */

import { h, raw, esc, num, fmtTime, fmtFull, asList } from "../dom.js";
import { icon } from "../icons.js";
import { api } from "../api.js";
import { plate, badge, emptyState, noteBox, table, statCard, loading, toast, toolChip, toolText, thinkTrace, taskRow, confMeter, sceneText } from "../ui.js";
import { crumb, pageHead, loadInto, plannedPanel, capabilityIndex, renderData, helpNote, rawPanel } from "./kit.js";

export function mount(ctx) {
  const el = ctx.canvas;
  if (!ctx.child) return mountHome(ctx, el);
  const map = {
    "knowledge-docs": capDocs,
    "knowledge-qa": capQa,
    "knowledge-agent": capAgent,
    "knowledge-runs": capRuns,
    "knowledge-regulation": capRegulation,
  };
  if (map[ctx.child.id]) return map[ctx.child.id](ctx, el);
  return planned(ctx, el);
}

/** 学生角色取自己的课程用 /api/student/my-courses（/api/review/courses 对学生 403）。 */
function isStudent(ctx) {
  return String(ctx.role).toUpperCase() === "STUDENT";
}

function mountHome(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb("全部功能", ctx.module.id, "知识总览"))}
    ${raw(pageHead({
      title: "知识智能",
      note: ctx.module.note || "RAG 检索与 Agent 对话，为各模块提供知识解释。它还能反向服务视觉：识别到实验室违规后，自动检索对应安全规范条文。",
      actions: h`<a class="btn btn--primary btn--sm" href="#/knowledge/knowledge-agent">${raw(icon("bot"))}进入对话</a>`,
    }))}
    <div class="grid grid-side">
      <div class="stack"><div id="kChat"></div></div>
      <div class="stack"><div id="kDocs"></div><div id="kRuns"></div></div>
    </div>
    <div class="mt-5" id="kIndex"></div>
  </div>`;
  el.querySelector("#kIndex").innerHTML = capabilityIndex(ctx);
  el.querySelectorAll("[data-cap]").forEach((r) => r.addEventListener("click", () => ctx.go("#/" + ctx.module.id + "/" + r.getAttribute("data-cap"))));

  mountChat(ctx, el.querySelector("#kChat"), { compact: true });

  loadInto(el.querySelector("#kDocs"), () => api.get(isStudent(ctx) ? "/api/student/my-courses" : "/api/review/courses").catch(() => []), (list) => {
    const items = asList(list);
    return plate({
      title: "知识库载体", sub: "文档索引挂在课程下",
      body: h`<div class="stack">
        ${items.length ? h`<dl class="kv">${raw(items.slice(0, 6).map((c) => h`<dt>${c.name || c.title || "课程 " + c.id}</dt><dd class="mono t-xs">id ${c.id}</dd>`).join(""))}</dl>`
          : emptyState({ icon: "book", title: "暂无课程" })}
        <a class="btn btn--outline btn--sm" href="#/knowledge/knowledge-docs">${raw(icon("upload"))}管理知识库</a>
      </div>`,
    });
  });

  loadInto(el.querySelector("#kRuns"), () => api.get("/api/vision/events?limit=1").catch(() => null), () => plate({
    title: "处理记录",
    sub: "AI 运行轨迹",
    body: h`<div class="stack">
      ${raw(noteBox({ kind: "info", body: "每次使用 AI 助手都会留下记录，填入记录编号就能回看它是怎么处理的。" }))}
      <a class="btn btn--outline btn--sm" href="#/knowledge/knowledge-runs">${raw(icon("activity"))}查看运行轨迹</a>
    </div>`,
  }));
}

/* ==================================================================
 * 对话面板（QA / Agent 共用）
 * ================================================================== */
function mountChat(ctx, host, opts) {
  const o = opts || {};
  host.innerHTML = plate({
    title: o.compact ? "智能问答" : ctx.child.label,
    sub: o.compact ? "基于课程资料回答，并给出出处" : ctx.child.desc,
    flush: true,
    body: h`<div id="chatWrap" style="display:flex;flex-direction:column;height:${o.compact ? "460px" : "560px"}">
      <div id="chatList" style="flex:1;overflow-y:auto;padding:var(--s-5)">
        ${raw(emptyState({
          icon: "bot",
          title: "问点什么",
          desc: o.compact ? "可以问「这节课有哪些人走神」「实验室违规对应哪条安全规范」。" : "基于课程知识库检索回答，回答会带引用来源。",
        }))}
      </div>
      <div style="border-top:1px solid var(--line);padding:var(--s-4) var(--s-5)">
        <div class="row" style="gap:var(--s-2);align-items:flex-end">
          <div style="flex:1">
            <textarea class="textarea" id="chatInput" rows="2" placeholder="输入问题…（Enter 发送，Shift+Enter 换行）"></textarea>
            <div class="row" style="gap:var(--s-2);margin-top:6px">
              <span class="t-xs dim">回答会带上引用的资料出处</span>
            </div>
          </div>
          ${!o.compact && ctx.child.id === "knowledge-qa"
            ? h`<input class="input mono" id="chatCourse" style="width:110px;height:var(--h-ctl-lg)" placeholder="课程编号">`
            : h`<input class="input mono" id="chatCourse" style="width:110px;height:var(--h-ctl-lg)" placeholder="课程编号，可留空">`}
          <button class="btn btn--signal btn--lg" type="button" id="chatSend">${raw(icon("send"))}发送</button>
        </div>
      </div>
    </div>`,
  });

  const list = host.querySelector("#chatList");
  const input = host.querySelector("#chatInput");
  const send = host.querySelector("#chatSend");
  let started = false;

  function bubble(role, html, meta) {
    if (!started) { list.innerHTML = ""; started = true; }
    const mine = role === "user";
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;gap:10px;margin-bottom:18px;flex-direction:column";
    wrap.innerHTML = h`<div class="row" style="gap:8px">
      <span class="dot ${mine ? "" : "dot--scan"}"></span>
      <b class="t-sm">${mine ? "你" : "知识智能体"}</b>
      ${meta ? h`<span class="t-xs dim">${meta}</span>` : ""}
    </div>
    <div style="${mine ? "padding:10px 14px;background:var(--surface-3);border-radius:var(--r-md);align-self:flex-start;max-width:82%" : ""}">${raw(html)}</div>`;
    list.appendChild(wrap);
    list.scrollTop = list.scrollHeight;
    return wrap;
  }

  function assistantShell() {
    const body = h`<div id="chatTrace"></div>
      <div id="chatChips" class="row row-wrap" style="gap:6px;margin-top:10px"></div>
      <div id="chatAnswer" class="mt-4"></div>`;
    return bubble("assistant", body, "…");
  }

  function doSend() {
    const q = input.value.trim();
    if (!q) return;
    const course = (host.querySelector("#chatCourse") || {}).value;
    input.value = "";
    bubble("user", esc(q));
    const box = assistantShell();
    const traceBox = box.querySelector("#chatTrace");
    const chipBox = box.querySelector("#chatChips");
    const ansBox = box.querySelector("#chatAnswer");

    // 过程可视化：先给出"正在做什么"，再落结果
    ansBox.innerHTML = h`<div class="stack-sm">
      ${raw(taskRow({ state: "run", text: "正在理解问题并规划检索", time: "" }))}
    </div>`;

    const isQa = ctx.child && ctx.child.id === "knowledge-qa";
    if (isQa && !course) {
      traceBox.innerHTML = noteBox({ kind: "warn", title: "先填课程编号", body: "资料问答是针对某一门课程进行的，填上课程编号再提问。" });
      ansBox.innerHTML = "";
      return;
    }
    const path = isQa
      ? "/api/knowledge/courses/" + encodeURIComponent(course) + "/qa"
      : "/api/knowledge/agent/chat";
    // 后端 AgentChatRequest 的字段名是 question（不是 message），写错会直接 422。
    const body = isQa ? { question: q } : { question: q, course_id: course ? Number(course) : null };

    const t0 = Date.now();
    const timer = setInterval(() => {
      const r = ansBox.querySelector(".task-row .tr-time");
      if (r) r.textContent = ((Date.now() - t0) / 1000).toFixed(1) + "s";
    }, 120);

    api.post(path, body).then((d) => {
      clearInterval(timer);
      const data = d || {};
      const answer = data.answer || data.reply || data.content || data.message || (typeof d === "string" ? d : "");
      const citations = data.citations || data.sources || data.references || [];
      const toolCalls = data.toolCalls || data.tool_calls || data.tools || [];
      const runId = data.runId || data.run_id;

      ansBox.innerHTML = "";
      if (toolCalls.length) {
        chipBox.innerHTML = toolCalls.map((t) => toolChip(
          toolText(t.name || t.tool || t.toolName),
          t.status || (t.error ? "未完成" : "已完成"),
          t.error ? "fail" : "ok"
        )).join("");
      }
      if (runId) {
        traceBox.innerHTML = h`<div class="row" style="gap:8px;margin-bottom:10px">
          ${raw(toolChip("本次处理", "", "run"))}
          <a class="btn btn--ghost btn--sm" href="#/knowledge/knowledge-runs">查看处理记录</a></div>`;
      }
      const steps = data.steps || data.thinking || data.trace;
      if (steps && steps.length) {
        traceBox.innerHTML += thinkTrace({
          title: "处理过程",
          meta: steps.length + " 步",
          steps: steps.map((s) => esc(typeof s === "string" ? s : (s.title || s.name || JSON.stringify(s)))),
        });
      }

      if (answer) {
        // 诚实呈现：整段返回，不做逐字流式伪造
        ansBox.innerHTML = h`<div class="t-base" style="line-height:var(--lh-loose);white-space:pre-wrap">${esc(answer)}</div>`;
        if (citations.length) {
          ansBox.innerHTML += h`<div class="mt-4"><div class="t-xs muted" style="margin-bottom:6px">引用来源</div>
            <div class="row row-wrap" style="gap:6px">${raw(citations.map((c, i) => {
              const label = typeof c === "string" ? c : (c.title || c.source || c.fileName || c.file_name || ("来源 " + (i + 1)));
              return h`<span class="chip">${raw(icon("file-text"))}${esc(label)}</span>`;
            }).join(""))}</div></div>`;
        }
      } else if (!steps || !steps.length) {
        ansBox.innerHTML = rawPanel("查看明细", "", renderData(data));
      }
      list.scrollTop = list.scrollHeight;
    }).catch((err) => {
      clearInterval(timer);
      ansBox.innerHTML = "";
      console.warn("[console] 问答调用失败", path, err);
      traceBox.innerHTML = err.code === 501
        ? noteBox({ kind: "warn", title: "这项功能还没开启", body: "需要学校开通大模型服务后才能使用；开通后本页立即可用。" })
        : noteBox({ kind: "danger", title: "没能给出回答", body: esc(err.message) || "请稍后重试。" });
    });
  }

  send.addEventListener("click", doSend);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); }
  });
}

/* ==================================================================
 * 能力页
 * ================================================================== */
function capDocs(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({ title: ctx.child.label, note: "上传课程资料后系统会自动整理成可检索的内容，全部在本机完成。" }))}
    <div class="grid grid-side">
      <div class="stack">
        ${raw(plate({
          title: "重建课程知识索引",
          body: h`<div class="stack">
            <div class="field" style="max-width:280px"><label class="label">课程 ID<span class="req">*</span></label>
              <input class="input mono" id="dCourse" placeholder="课程编号"></div>
            <div class="row"><button class="btn btn--signal" type="button" id="dRun">${raw(icon("wand"))}重建索引</button>
              <span class="t-xs dim">用课程编号指定要处理的课程</span></div>
            ${raw(noteBox({
              kind: "info", title: "它会索引哪些内容",
              body: "系统会把该课程已上传的课程文档、作业题目与提交内容整理成可检索的资料，无需手工粘贴文本。",
            }))}
          </div>`,
        }))}
        <div id="dOut"></div>
      </div>
      <div class="stack">${raw(helpNote(ctx.child))}</div>
    </div>
  </div>`;
  el.querySelector("#dRun").addEventListener("click", () => {
    const id = el.querySelector("#dCourse").value.trim();
    if (!id) { toast("请填写课程 ID", "err"); return; }
    const out = el.querySelector("#dOut");
    out.innerHTML = loading("正在整理资料");
    api.post("/api/knowledge/courses/" + encodeURIComponent(id) + "/documents/index").then((d) => {
      out.innerHTML = plate({ title: "索引结果", body: renderData(d) });
    }).catch((err) => {
      out.innerHTML = err.code === 501
        ? noteBox({ kind: "warn", title: "资料检索还没开启", body: "需要先配置检索服务，配置完成后本页立即可用。" })
        : noteBox({ kind: "danger", title: "索引失败", body: esc(err.message) });
    });
  });
}

function capQa(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({ title: ctx.child.label, note: ctx.child.desc }))}
    <div id="qaChat"></div>
  </div>`;
  mountChat(ctx, el.querySelector("#qaChat"), { compact: false });
}

function capAgent(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({ title: ctx.child.label, note: "可以直接对话，它会替你查资料并给出出处。" }))}
    <div id="agChat"></div>
  </div>`;
  mountChat(ctx, el.querySelector("#agChat"), { compact: false });
}

function capRuns(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({ title: ctx.child.label, note: "AI 每一步做了什么，都可以在这里回看。" }))}
    <div class="grid grid-side">
      <div class="stack">
        ${raw(plate({
          title: "按记录编号回看",
          body: h`<div class="row"><input class="input mono" id="rId" style="flex:1" placeholder="记录编号">
            <button class="btn btn--primary" type="button" id="rGo">${raw(icon("search"))}查询</button></div>`,
        }))}
        <div id="rOut"></div>
      </div>
      <div class="stack">${raw(helpNote(ctx.child))}</div>
    </div>
  </div>`;
  el.querySelector("#rGo").addEventListener("click", () => {
    const id = el.querySelector("#rId").value.trim();
    if (!id) { toast("请填写记录编号", "err"); return; }
    const out = el.querySelector("#rOut");
    out.innerHTML = loading();
    Promise.all([
      api.get("/api/knowledge/runs/" + encodeURIComponent(id)).catch((e) => ({ __err: e.message })),
      api.get("/api/knowledge/runs/" + encodeURIComponent(id) + "/tool-calls").catch((e) => ({ __err: e.message })),
    ]).then((rr) => {
      const [run, calls] = rr;
      out.innerHTML = h`<div class="stack">
        ${raw(plate({ title: "处理记录", sub: "编号 " + esc(id), body: renderData(run) }))}
        ${raw(plate({
          title: "它做了什么",
          sub: Array.isArray(calls) ? calls.length + " 个步骤" : "",
          body: Array.isArray(calls) && calls.length
            ? h`<div>${raw(calls.map((c) => taskRow({
                state: c.error ? "fail" : "done",
                text: h`${raw(toolChip(toolText(c.name || c.tool), "", c.error ? "fail" : "ok"))}
                  <span class="t-xs dim" style="margin-left:8px">${esc(c.summary || c.result || "")}</span>`,
                time: c.durationMs || c.duration_ms ? Number(c.durationMs || c.duration_ms).toFixed(0) + "ms" : "",
              })).join(""))}</div>`
            : renderData(calls),
        }))}
      </div>`;
    });
  });
}

function capRegulation(ctx, el) {
  el.innerHTML = h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, ctx.child.label))}
    ${raw(pageHead({ title: ctx.child.label, note: "把识别到的违规情况，对应到校规或安全规范的条文上。" }))}
    <div class="grid grid-side">
      <div class="stack">
        ${raw(plate({
          title: "事件 → 规范条文",
          body: h`<div class="stack">
            <div class="grid grid-2" style="gap:var(--s-3)">
              <div class="field"><label class="label">课程编号<span class="req">*</span></label>
                <input class="input mono" id="rgCourse" placeholder="例如 3"></div>
              <div class="field"><label class="label">最多返回几条</label>
                <input class="input mono" id="rgTop" type="number" min="1" max="20" value="5"></div>
            </div>
            <div class="field"><label class="label">从最近需要关注的情况里选（可选）</label>
              <select class="input" id="rgEvent"><option value="">— 手动填写 —</option></select></div>
            <div class="grid grid-2" style="gap:var(--s-3)">
              <div class="field"><label class="label">事件类型</label>
                <input class="input mono" id="rgType" placeholder="如 手机使用 / 未戴护目镜"></div>
              <div class="field"><label class="label">关键词（可选，填了就按它检索）</label>
                <input class="input mono" id="rgQuery" placeholder="如 实验室 护目镜 规范"></div>
            </div>
            <div class="row"><button class="btn btn--signal" type="button" id="rgRun">${raw(icon("search"))}检索规范</button>
              <span class="t-xs dim">结果会直接显示在下方</span></div>
            ${raw(noteBox({
              kind: "info", title: "前置条件",
              body: "检索的是该课程的知识库。若结果为空，先用「知识库文档」页把含规范条文的文档索引到这门课程。",
            }))}
          </div>`,
        }))}
        <div id="rgOut"></div>
      </div>
      <div class="stack">${raw(helpNote(ctx.child))}</div>
    </div>
  </div>`;

  // 用真实预警事件填充下拉：这是「视觉 → 规范」闭环的起点
  api.get("/api/insight/alerts?limit=50").then((rows) => {
    const list = asList(rows);
    const sel = el.querySelector("#rgEvent");
    if (!sel || !list.length) return;
    list.forEach((e) => {
      const o = document.createElement("option");
      o.value = JSON.stringify({ t: e.eventType || "", l: e.eventLabel || "", s: e.scene || "" });
      o.textContent = (e.eventLabel || e.eventType || "事件") + " · " + sceneText(e.scene);
      sel.appendChild(o);
    });
  }).catch(() => {});

  el.querySelector("#rgEvent").addEventListener("change", (ev) => {
    if (!ev.target.value) return;
    try {
      const o = JSON.parse(ev.target.value);
      el.querySelector("#rgType").value = o.t || "";
      el.querySelector("#rgQuery").value = o.l || "";
    } catch (_) { /* 手动填写分支，忽略 */ }
  });

  el.querySelector("#rgRun").addEventListener("click", () => {
    const course = el.querySelector("#rgCourse").value.trim();
    if (!course) { toast("请填写课程 ID", "err"); return; }
    const topRaw = Number(el.querySelector("#rgTop").value || 5);
    const body = {
      course_id: Number(course),
      event_type: el.querySelector("#rgType").value.trim() || null,
      query: el.querySelector("#rgQuery").value.trim() || null,
      top_k: Number.isNaN(topRaw) ? 5 : Math.max(1, Math.min(20, topRaw)),
    };
    const out = el.querySelector("#rgOut");
    out.innerHTML = loading("检索规范条文");
    api.post("/api/knowledge/regulations/match", body).then((d) => {
      const cit = asList(d && d.citations);
      const matched = d && d.matched != null ? d.matched : cit.length;
      out.innerHTML = plate({
        title: "匹配结果",
        sub: matched + " 条 · 关键词「" + ((d && d.query) || body.query || body.event_type || "") + "」",
        body: cit.length
          ? table({
              columns: [{ t: "来源" }, { t: "相似度" }, { t: "条文片段" }],
              rows: cit.map((c) => ([
                h`<div class="t-main mono">${esc(c.source || c.fileName || "—")}</div>`,
                h`<div style="width:130px">${raw(confMeter(c.similarity || c.score || 0))}</div>`,
                h`<div class="t-sm">${esc(String(c.content || "").slice(0, 240))}</div>`,
              ])),
            })
          : emptyState({ icon: "book", title: "没有匹配到条文", desc: "该课程可能还没有上传相关规范文档，或相似度不够高。" }),
      });
    }).catch((err) => {
      out.innerHTML = err.code === 501
        ? noteBox({ kind: "warn", title: "资料检索还没开启", body: "需要先配置检索服务，配置完成后本页立即可用。" })
        : noteBox({ kind: "danger", title: "检索失败", body: esc(err.message) });
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
