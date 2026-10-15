/**
 * DOM 与格式化工具。
 *
 * 安全默认：模板标签 h`…${v}…` 会对所有插值做转义，
 * 想插入可信片段必须显式用 raw() 包裹。这样任何一处忘记转义都不会变成 XSS。
 */

/**
 * 一段"已经产出 HTML"的内容。
 *
 * 之所以做成对象而不是普通字符串：模板可以嵌套，而数组 .join("") 之后
 * 字符串就丢了标记。做成对象后，`h` 的返回值无论被嵌套、被 join、被赋值给
 * innerHTML，标记都还在，不会被外层模板二次转义。
 */
class Safe {
  constructor(html) {
    this.html = html == null ? "" : String(html);
  }
  toString() { return this.html; }
  [Symbol.toPrimitive]() { return this.html; }
}

/** 标记一段"已可信"的 HTML，跳过后面的转义。 */
export function raw(value) {
  return value instanceof Safe ? value : new Safe(value);
}

/**
 * 转义一段文本并返回 Safe。
 *
 * 为什么返回 Safe 而不是普通字符串 —— 这是本模块的关键约定：
 *   h`…${v}…` 已经会替每个插值做一次转义。
 *   若 esc() 返回普通字符串，模板里再写 ${esc(v)} 就会被转义两次
 *   （" → &quot; → &amp;quot;），页面上直接看到实体符号。
 *   返回 Safe 后，外层 h 认得出"这段已经处理过"，不再二次转义，
 *   于是 ${v} 和 ${esc(v)} 两种写法语义一致，怎么写都不会错。
 *
 * 需要"不转义地插入 HTML"时用 raw()；esc() 是"先转义再交给模板"。
 */
export function esc(value) {
  if (value instanceof Safe) return value;
  if (value == null || value === false) return new Safe("");
  if (Array.isArray(value)) return new Safe(value.map((v) => esc(v).html).join(""));
  if (typeof value === "object") return esc(JSON.stringify(value));
  return new Safe(String(value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  ));
}

/** h`<div>${userInput}</div>` —— 插值自动转义，返回值是 Safe。 */
export function h(strings) {
  const vals = Array.prototype.slice.call(arguments, 1);
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += esc(vals[i]) + strings[i + 1];
  return new Safe(out);
}

export const $ = (sel, root) => (root || document).querySelector(sel);
export const $$ = (sel, root) =>
  Array.prototype.slice.call((root || document).querySelectorAll(sel));

export function on(target, type, selOrFn, maybeFn) {
  if (typeof selOrFn === "function") {
    target.addEventListener(type, selOrFn);
    return () => target.removeEventListener(type, selOrFn);
  }
  const fn = (e) => {
    const hit = e.target.closest(selOrFn);
    if (hit && target.contains(hit)) maybeFn(e, hit);
  };
  target.addEventListener(type, fn);
  return () => target.removeEventListener(type, fn);
}

/* ---------------- 格式化 ---------------- */

export function num(v, digits) {
  if (v == null || v === "" || Number.isNaN(Number(v))) return "—";
  const n = Number(v);
  const d = digits == null ? 0 : digits;
  return n.toLocaleString("zh-CN", { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** 千分位 + 单位量纲，用于统计块 */
export function big(v) {
  if (v == null || v === "") return "—";
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  if (Math.abs(n) >= 1e8) return { n: (n / 1e8).toFixed(2), u: "亿" };
  if (Math.abs(n) >= 1e4) return { n: (n / 1e4).toFixed(1), u: "万" };
  return { n: num(n), u: "" };
}

export function pct(part, total) {
  if (!total) return 0;
  return Math.round((Number(part) / Number(total)) * 100);
}

export function ratio(v, digits) {
  if (v == null || v === "") return "—";
  const n = Number(v);
  if (Number.isNaN(n)) return "—";
  return (n <= 1 ? n : n).toFixed(digits == null ? 2 : digits);
}

function pad(n) { return n < 10 ? "0" + n : String(n); }

export function fmtTime(iso) {
  if (!iso) return "—";
  const s = String(iso).replace("T", " ");
  return s.length >= 16 ? s.slice(5, 16) : s;
}

export function fmtFull(iso) {
  if (!iso) return "—";
  return String(iso).replace("T", " ").slice(0, 19);
}

export function fmtClock(d) {
  const t = d || new Date();
  return pad(t.getHours()) + ":" + pad(t.getMinutes()) + ":" + pad(t.getSeconds());
}

export function relTime(iso) {
  if (!iso) return "—";
  const t = new Date(String(iso).replace(" ", "T")).getTime();
  if (Number.isNaN(t)) return fmtTime(iso);
  const diff = Math.floor((Date.now() - t) / 1000);
  if (diff < 60) return diff <= 0 ? "刚刚" : diff + " 秒前";
  if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
  if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
  if (diff < 86400 * 30) return Math.floor(diff / 86400) + " 天前";
  return fmtTime(iso);
}

export function ms(v) {
  if (v == null || v === "") return "—";
  const n = Number(v);
  if (Number.isNaN(n)) return "—";
  return n >= 1000 ? (n / 1000).toFixed(2) + "s" : n.toFixed(n < 10 ? 1 : 0) + "ms";
}

export function debounce(fn, wait) {
  let t;
  return function () {
    const args = arguments, self = this;
    clearTimeout(t);
    t = setTimeout(() => fn.apply(self, args), wait == null ? 180 : wait);
  };
}

export const sleep = (n) => new Promise((r) => setTimeout(r, n));

/* ---------------- 小工具 ---------------- */

export function byId(list, key) {
  const m = {};
  (list || []).forEach((x) => { m[x[key]] = x; });
  return m;
}

export function pick(obj, paths) {
  for (const p of paths) {
    const v = p.split(".").reduce((a, k) => (a == null ? a : a[k]), obj);
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

export function asList(v) {
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.items)) return v.items;
  if (v && Array.isArray(v.content)) return v.content;   // Spring 风格分页
  if (v && Array.isArray(v.list)) return v.list;
  if (v && Array.isArray(v.records)) return v.records;
  if (v && Array.isArray(v.rows)) return v.rows;
  return [];
}
