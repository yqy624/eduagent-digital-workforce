/**
 * 页面工具集。
 *
 * 这一层只做两件事：把服务端返回渲染成用户看得懂的结构；数据取不到时如实说明原因。
 *
 * 文案铁律
 * --------
 * 本文件的输出全都直接显示给用户，因此不出现接口路径、建设状态、AI 依赖、
 * 旧端点对照这类实现信息 —— 用户关心「我能做什么」，不关心「这是哪个接口做的」。
 */

import { h, raw, esc, num, fmtTime, fmtFull, relTime, asList } from "../dom.js";
import { icon } from "../icons.js";
import { registry } from "../registry.js";
import { api } from "../api.js";
import { plate, badge, emptyState, noteBox, table, statCard, loading, toast, bars, fieldText, healthText } from "../ui.js";

/* ---------------- 页面头 ---------------- */

export function crumb(moduleLabel, moduleId, title) {
  return h`<div class="crumb">
    <a href="#/${moduleId}">${moduleLabel}</a>
    <span class="sep">${raw(icon("chevron-right"))}</span>
    <span class="cur">${title}</span>
  </div>`;
}

export function pageHead(o) {
  return h`<div class="page-head">
    <div class="ph-main">
      <h1 class="h-2">${o.title}</h1>
      ${o.note ? h`<div class="ph-note">${raw(o.note)}</div>` : ""}
    </div>
    ${o.actions ? h`<div class="ph-actions">${raw(o.actions)}</div>` : ""}
  </div>`;
}

/* ---------------- 通用数据渲染 ---------------- */

function isPlainObject(v) { return v && typeof v === "object" && !Array.isArray(v); }

/**
 * {labels:[…], <数值字段>:[…]} 形状的时序数据。
 * 后端把趋势数据就是这么给的 —— 可能是单路（serviceTrend: labels + successRate
 * + responseTime），也可能是多路（resourceTrend 的 values 是 number[][]）。
 * 直接 JSON.stringify 会甩出一大坨对象字面量，这里识别出来交给柱形图。
 */
function asSeries(v) {
  if (!isPlainObject(v)) return null;
  const keys = Object.keys(v);
  const labelKey = keys.find((k) => Array.isArray(v[k]) && v[k].length && typeof v[k][0] === "string");
  if (!labelKey) return null;
  const labels = v[labelKey];
  if (labels.length < 3) return null;
  const series = [];
  keys.forEach((k) => {
    if (k === labelKey) return;
    const arr = v[k];
    if (!Array.isArray(arr) || !arr.length) return;
    let vals = null;
    if (typeof arr[0] === "number") vals = arr;
    else if (Array.isArray(arr[0]) && typeof arr[0][0] === "number") vals = arr[0];
    if (vals && vals.length === labels.length) series.push({ name: k, values: vals });
  });
  return series.length ? { labels, series } : null;
}

/** 嵌套对象的紧凑内联摘要（k v · k v）。用来替代 [object Object]。 */
function inline(v, depth) {
  if (v == null) return "—";
  if (Array.isArray(v)) {
    if (!v.length) return "空";
    if (v.every((x) => x == null || typeof x !== "object")) return v.map((x) => String(x)).join("、");
    return v.length + " 项";
  }
  if (isPlainObject(v)) {
    const keys = Object.keys(v);
    if (!keys.length) return "空";
    if ((depth || 0) >= 1) return keys.length + " 项内容";
    // 键名同样只认已登记的：这一层渲染也直接显示给用户
    return keys.filter(fieldText).slice(0, 6).map((k) => fieldText(k) + " " + inline(v[k], 1)).join(" · ");
  }
  return String(v);
}

function scalar(v) {
  if (v == null) return '<span class="dim">—</span>';
  if (typeof v === "boolean") return v ? badge("是", "ok") : badge("否", null);
  if (typeof v === "number") return `<span class="num">${num(v, Number.isInteger(v) ? 0 : 2)}</span>`;
  if (typeof v === "object") {
    const t = inline(v);
    if (t.length <= 80) return h`<span class="t-xs">${t}</span>`;
    // 太长就别硬铺：几十个时间点的 labels 铺成一行会把表格撑变形
    const n = Array.isArray(v) ? v.length + " 项" : Object.keys(v).length + " 项内容";
    return h`<span class="t-xs muted">${n}</span>`;
  }
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}T?/.test(s)) return `<span class="num">${esc(fmtFull(s))}</span>`;
  if (s.length > 90) return `<span class="t-xs">${esc(s)}</span>`;
  return esc(s);
}

/**
 * 把任意返回渲染成可读结构。
 * 规则：标量 → 键值表；对象数组 → 表格；时序对象 → 柱形图；
 * 嵌套对象 → 递归成独立小节；标量数组 → 内联列表。
 * 目的是让任何形状的数据都能读，而不是甩一段 JSON 字符串出来。
 */
export function renderData(data, opts) {
  const o = opts || {};
  if (data == null) return emptyState({ icon: "info", title: o.emptyTitle || "暂无数据" });

  if (Array.isArray(data)) {
    if (!data.length) return emptyState({ icon: o.emptyIcon || "database", title: o.emptyTitle || "没有记录", desc: o.emptyDesc });
    if (!isPlainObject(data[0])) {
      return h`<ul class="stack-sm">${raw(data.map((v) => h`<li>${raw(scalar(v))}</li>`).join(""))}</ul>`;
    }
    return objectTable(data, o);
  }

  if (isPlainObject(data)) {
    // 标签只有两个来源：调用方显式给的 labels、共享的字段词表。
    // 都没有 => 不渲染。通用渲染器绝不能把键名当文案（「没有登记的字段一律不渲染」
    // 是这一层唯一的保证方式，详见 ui.js 的 FIELD_TEXT）。
    const nameOf = (k) => (o.labels && o.labels[k]) || fieldText(k) || "";
    // 多路序列里每一路的 name 也是机器取值（successRate / responseTime），
    // 走和「指标名」同一套翻译；翻不出来就留空，绝不把键名当图例。
    const seriesName = (n) => (o.valueText && o.valueText.name
      ? o.valueText.name(n) : ((o.labels && o.labels[n]) || fieldText(n) || ""));
    const keys = Object.keys(data).filter((k) => nameOf(k));
    const seriesKeys = keys.filter((k) => asSeries(data[k]));
    const seriesListKeys = keys.filter(
      (k) => Array.isArray(data[k]) && data[k].length && data[k].every((x) => asSeries(x))
    );
    const tableKeys = keys.filter(
      (k) => Array.isArray(data[k]) && data[k].length && isPlainObject(data[k][0]) && seriesListKeys.indexOf(k) < 0
    );
    const nestedKeys = keys.filter(
      (k) => isPlainObject(data[k]) && seriesKeys.indexOf(k) < 0 && tableKeys.indexOf(k) < 0
    );
    const scalarKeys = keys.filter(
      (k) => seriesKeys.indexOf(k) < 0 && seriesListKeys.indexOf(k) < 0 &&
        tableKeys.indexOf(k) < 0 && nestedKeys.indexOf(k) < 0
    );

    let html = "";
    if (scalarKeys.length) {
      html += plate({
        title: o.objectTitle || "字段",
        flush: true,
        body: h`<div style="padding:var(--s-5)">
          <dl class="kv">${raw(scalarKeys.map((k) => h`<dt>${nameOf(k)}</dt><dd>${raw(scalar(data[k]))}</dd>`).join(""))}</dl>
        </div>`,
      });
    }
    seriesKeys.forEach((k) => {
      const s = asSeries(data[k]);
      html += h`<div class="mt-4">${raw(plate({
        title: nameOf(k),
        sub: s.series.length + " 路序列 · " + s.labels.length + " 个时间点",
        body: chartBlock(s.labels, s.series[0].values, s.series.length > 1 ? seriesName(s.series[0].name) : "", 138),
      }))}</div>`;
      s.series.slice(1).forEach((one) => {
        const n = seriesName(one.name);
        html += h`<div class="mt-4">${raw(plate({
          title: nameOf(k) + (n ? " · " + n : ""),
          sub: s.labels.length + " 个时间点",
          body: chartBlock(s.labels, one.values, "", 138),
        }))}</div>`;
      });
    });
    seriesListKeys.forEach((k) => {
      const items = data[k];
      // 多路序列里大部分可能是整窗为 0 的空转通道，逐路画图会把版面铺满噪声。
      // 只画真正有数据的，全空时聚合成一句话。
      const live = items.filter((it) => {
        const s = asSeries(it);
        return s.series.some((one) => one.values.some((v) => Number(v)));
      });
      if (!live.length) {
        html += h`<div class="mt-4">${raw(plate({
          title: nameOf(k),
          sub: items.length + " 路序列",
          body: h`<div class="t-sm muted">窗口内 ${items.length} 路序列全部为 0，没有活动记录。</div>`,
        }))}</div>`;
        return;
      }
      html += h`<div class="mt-4">${raw(plate({
        title: nameOf(k),
        sub: live.length === items.length ? items.length + " 路序列" : live.length + " / " + items.length + " 路序列有数据",
        flush: true,
        body: h`<div style="padding:var(--s-5)">
          ${raw(live.map((item) => {
            const s = asSeries(item);
            return chartBlock(s.labels, s.series[0].values,
              seriesName(item.name) || seriesName(s.series[0].name), 124);
          }).join(""))}
        </div>`,
      }))}</div>`;
    });
    nestedKeys.forEach((k) => {
      // 递归时把字段名当作子级第一块面板的标题，避免"面板套面板"的双层边框。
      // o 整体透传（否则 valueText 这类取值翻译会在下一层丢掉）。
      html += h`<div class="mt-4">${raw(renderData(data[k], Object.assign({}, o, {
        objectTitle: nameOf(k),
      })))}</div>`;
    });
    tableKeys.forEach((k) => {
      html += h`<div class="mt-4">${raw(plate({
        title: nameOf(k),
        sub: data[k].length + " 条",
        body: objectTable(data[k], o),
        flush: true,
      }))}</div>`;
    });
    return h`<div class="stack">${raw(html || emptyState({ icon: "info", title: "没有可展示的字段" }))}</div>`;
  }

  return h`<div class="mono">${esc(String(data))}</div>`;
}

/**
 * 对象数组 → 表格。
 * 列名同样只认「有用户语言」的字段：没有登记的键既不做列名、也不做列。
 * 全部未登记时如实说「没有可展示的记录」，而不是把键名铺成表头。
 * opts.valueText 可给某一列配取值翻译（例如 metric 名、服务状态）。
 */
export function objectTable(list, opts) {
  const o = opts || {};
  const labelOf = (k) => (o.labels && o.labels[k]) || (o.header && o.header[k]) || fieldText(k);
  const cellOf = (k, v) => (o.valueText && o.valueText[k] ? o.valueText[k](v) : v);
  const keys = [];
  list.slice(0, 40).forEach((row) => Object.keys(row).forEach((k) => { if (keys.indexOf(k) < 0) keys.push(k); }));
  const cols = keys
    .filter((k) => labelOf(k))
    .filter((k) => !o.columns || o.columns.indexOf(k) >= 0)
    .slice(0, 8);
  if (!cols.length) {
    return emptyState({ icon: "database", title: o.emptyTitle || "没有可展示的记录" });
  }
  const rows = list.slice(0, 200).map((row) => cols.map((k) => scalar(cellOf(k, row[k]))));
  return table({
    columns: cols.map((k) => ({ t: labelOf(k), k })),
    rows,
    emptyTitle: o.emptyTitle || "没有记录",
  });
}

/* ---------------- 运行时监控（/api/admin/monitor · /api/health） ---------------- */

/** 一个值在表格里的紧凑表示：数组数长度，对象数内容项，标量原样 */
function briefVal(v) {
  if (v == null) return "—";
  if (Array.isArray(v)) return v.length + " 项";
  if (typeof v === "object") return Object.keys(v).length + " 项内容";
  return String(v);
}

/**
 * 自检项 → 一行可读摘要。
 * 之前这里是 JSON.stringify 直接上屏，页面上会出现
 * {"status":"ok","latencyMs":3} 这种既难读又撑破单元格的东西。
 *
 * 现在只输出**有用户语言**的子项（fieldText 登记过）。
 * 这条过滤同时挡掉了 path / model / provider 这类内部取值 ——
 * 它们本身没有面向用户的说法，露出来只是把实现细节摊给客户看。
 */
export function checkDetail(c) {
  const keys = Object.keys(c || {}).filter((k) => k !== "status" && k !== "ok" && fieldText(k));
  if (!keys.length) return "—";
  return keys.slice(0, 4).map((k) => fieldText(k) + " " + briefVal(c[k])).join(" · ");
}

/** 只出柱子本身（不带面板外壳），供 renderData 嵌进已有面板 */
function chartBlock(labels, values, caption, height) {
  const lb = labels || [], vs = values || [];
  const head = caption ? h`<div class="t-xs muted" style="margin-bottom:6px">${caption}</div>` : "";
  // 整窗全 0 时画出来是一排贴底的细线，看着像渲染坏了。
  // 把"这段时间没有活动"直接讲清楚，比摆一张空图诚实也好读。
  if (!vs.some((v) => Number(v))) {
    return h`<div style="margin-top:var(--s-3)">
      ${head}
      <div class="t-sm muted" style="padding:var(--s-3) 0">窗口内 ${lb.length} 个时间点均为 0</div>
    </div>`;
  }
  const step = Math.ceil(lb.length / 12);
  return h`<div style="margin-top:var(--s-3)">
    ${head}
    ${raw(bars(lb.map((x, i) => ({
      label: step > 1 && i % step ? "" : String(x).slice(5),
      value: vs[i] || 0,
      display: vs[i] == null ? "" : vs[i],
    })), { height: height || 132 }))}
  </div>`;
}

/** {labels:[…], values:[…]} 形状 → 独立面板里的柱形图 */
export function seriesBars(labels, values, name, height) {
  const lb = labels || [];
  if (!lb.length) return emptyState({ icon: "trend", title: "没有序列数据" });
  return plate({
    title: name,
    sub: lb.length + " 个时间点",
    body: chartBlock(lb, values, "", height),
  });
}

/** 监控数据的紧凑摘要，用于首页侧栏 —— 只要状态、时长、告警，不铺全量指标 */
export function monitorBrief(d) {
  if (!d) {
    return emptyState({ icon: "server", title: "暂时读不到运行状况", desc: "稍后刷新再试。" });
  }
  const alerts = Array.isArray(d.alerts) ? d.alerts : [];
  const sev = {};
  alerts.forEach((a) => {
    const s = String(a.level || a.severity || "unknown");
    sev[s] = (sev[s] || 0) + 1;
  });
  const ok = /^(ok|up|healthy)$/i.test(String(d.status || ""));
  const rows = [
    ["已运行", String(d.uptime || "—")],
    ["待处理提醒", alerts.length + " 条"],
    ["健康分", d.healthReport && d.healthReport.score != null ? String(d.healthReport.score) : "—"],
  ];
  return h`<div class="stack-sm">
    <div class="row row-wrap" style="gap:8px">
      ${raw(badge(healthText(d.status || "未返回"), ok ? "ok" : "warn"))}
      ${raw(Object.keys(sev).map((s) => badge(s + " × " + sev[s], "danger")))}
    </div>
    <dl class="kv">${raw(rows.map((r) => h`<dt>${r[0]}</dt><dd>${r[1]}</dd>`).join(""))}</dl>
  </div>`;
}

/* ---------------- 明细（默认折叠） ---------------- */

/**
 * 明细默认收起：用户想核对每一项数值时再展开，
 * 收起时不占据正文版面、不抢主线信息的注意力。
 */
export function rawPanel(title, sub, body) {
  return h`<details class="raw-panel">
    <summary>
      <span>${title}</span>
      ${sub ? h`<span class="t-xs muted" style="margin-left:8px">${sub}</span>` : ""}
    </summary>
    <div class="raw-panel-body">${raw(body || "")}</div>
  </details>`;
}

/* ---------------- 异步加载守卫 ---------------- */

/**
 * 把一段异步加载包成"加载中 → 渲染 / 报错"。
 * 出错时给用户一句可行动的说明；技术原因写进控制台，不糊到界面上。
 */
export function loadInto(el, loader, render, opts) {
  const o = opts || {};
  el.innerHTML = loading(o.loadingText);
  return loader()
    .then((data) => { el.innerHTML = render(data); return data; })
    .then((data) => { o.after && o.after(data, el); return data; })
    .catch((err) => {
      const code = Number(err && err.code);
      const msg = String((err && err.message) || err || "");
      // 权限说明要中性：这是「这份数据不属于你」，不是「你被拒绝了」。
      // 绝不把后端原文（需要角色 ADMIN/TEACHER，当前角色为 STUDENT）抛到界面上 ——
      // 那既泄漏了内部权限划分，又让用户看到一片红。
      if (code === 403 || /需要角色|权限不足|无权限|Forbidden/.test(msg)) {
        el.innerHTML = noteBox({
          kind: "info",
          icon: "ban",
          title: "这份数据不对你开放",
          body: "这部分属于另一类账号使用的内容，已自动为你隐去。",
        });
        return null;
      }
      console.warn("[console] 读取失败", err);
      el.innerHTML = noteBox({
        kind: "danger",
        title: "读取失败",
        body: "暂时取不到这部分内容，请稍后重试。",
      }) + (o.retry !== false
        ? h`<div class="mt-4"><button class="btn btn--outline btn--sm" type="button" data-retry>${raw(icon("refresh"))}重试</button></div>`
        : "");
      const btn = el.querySelector("[data-retry]");
      if (btn) btn.addEventListener("click", () => loadInto(el, loader, render, o));
      return null;
    });
}

/* ---------------- 功能说明 ---------------- */

/**
 * 功能说明面板：只回答「这个功能能帮我做什么」。
 * 不出现接口、命名空间、新旧端点对照 —— 那是实现者的事。
 */
export function helpNote(child) {
  return plate({
    title: "关于这项功能",
    body: h`<div class="stack">
      ${noteBox({
        kind: "info",
        body: child && child.desc ? child.desc + "。" : "这项功能正在完善中。",
      })}
    </div>`,
  });
}

/* ---------------- 待上线面板 ---------------- */

/**
 * 功能还没上线时的说明：讲清楚它将会做什么，并说明为什么现在不展示内容。
 * 不画饼、不塞演示数据。
 */
export function plannedPanel(child, opts) {
  const o = opts || {};
  return plate({
    title: o.title || "这项功能正在准备",
    body: h`<div class="stack">
      ${noteBox({
        kind: "warn",
        title: "这项功能还没开通。",
        body: (child && child.desc ? "开通后你可以用它" + child.desc + "。" : "开通后这里会显示真实内容。") +
          " 在它准备好之前，这里不会用示例内容充数。",
      })}
      ${o.extra ? h`<div>${raw(o.extra)}</div>` : ""}
    </div>`,
  });
}

/* ---------------- 能力索引 ---------------- */

export function capabilityIndex(ctx, opts) {
  const o = opts || {};
  const kids = registry.visibleChildren(ctx.role, ctx.module.id);
  const rows = kids.map((c) => ({
    __attrs: h`data-cap="${c.id}" style="cursor:pointer" data-search="${(c.label + " " + c.group).toLowerCase()}"`,
    cells: [
      h`<div class="t-main">${c.label}</div>${c.desc ? h`<div class="t-sub">${c.desc}</div>` : ""}`,
      esc(c.group),
    ],
  }));
  return plate({
    flush: true,
    title: o.title || "这个模块能做什么",
    sub: o.sub || (kids.length + " 项功能，点击任意一行进入"),
    body: table({
      columns: [{ t: "功能", k: "label" }, { t: "分类", k: "group" }],
      rows,
      emptyTitle: "当前账号暂时没有可用功能",
    }),
  });
}

/* ---------------- 通用能力页 ---------------- */

/**
 * 多数能力页的骨架相同：面包屑 → 页头 → 可运行的查询区 → 结果区。
 * 差异通过 spec 注入。
 */
export function capScaffold(ctx, spec) {
  const c = ctx.child;
  const runArea = spec.run ? h`<div id="capRun" class="mt-4">${raw(spec.run)}</div>` : "";
  return h`<div class="reveal">
    ${raw(crumb(ctx.module.label, ctx.module.id, c.label))}
    ${raw(pageHead({
      title: c.label,
      note: c.desc,
      actions: h`<button class="btn btn--outline btn--sm" type="button" id="capReload">${raw(icon("refresh"))}刷新</button>`,
    }))}
    <div class="grid grid-side">
      <div class="stack">
        ${raw(runArea)}
        <div id="capResult"></div>
      </div>
      <div class="stack">
        ${raw(plate({
          title: "关于这项功能",
          flush: true,
          body: h`<div style="padding:var(--s-5)">
            ${c.desc
              ? h`<div class="t-sm">${esc(c.desc)}。</div>`
              : h`<div class="t-sm muted">这项功能正在完善中。</div>`}
            <div class="mt-4 t-xs muted">所属：${ctx.module.label} · ${c.group}</div>
          </div>`,
        }))}
        ${spec.side || ""}
      </div>
    </div>
  </div>`;
}

export { api, plate, badge, emptyState, noteBox, table, statCard, loading, toast };
