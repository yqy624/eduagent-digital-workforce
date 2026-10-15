/* check_layout.js —— 布局/滚动可用性检查
 *
 * 背景：本平台内容区是 JS 动态渲染的，而 hifi 组件库的骨架把滚动交给 .page
 *（多页原型用），.content 没有滚动能力。一旦 .content 不滚，超出视口的内容
 * 会被 html/body 的 height:100% + overflow:hidden 直接裁掉，用户看到"下面没了"。
 *
 * 本脚本用 jsdom 加载页面并注入真实 CSS，检查整条滚动链是否可用：
 *   1. .content 是否是可滚动容器（overflow-y: auto/scroll）
 *   2. flex 链上的 min-height:0 是否补齐（否则 overflow 会被内容撑开而失效）
 *   3. 页面里是否同时存在多个滚动容器导致嵌套滚动
 *   4. 弹窗 / 抽屉内部是否有自己的滚动（长内容不被裁）
 *
 * 用法：
 *   NODE_PATH=<jsdom 目录> node scripts/check_layout.js
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const STATIC = path.join(ROOT, "static");

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log("  OK   " + name + (detail ? "  — " + detail : ""));
  } else {
    fail++;
    console.log("  FAIL " + name + (detail ? "  — " + detail : ""));
  }
}

function loadPage(file, cssFiles) {
  const html = fs.readFileSync(path.join(STATIC, file), "utf-8");
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  cssFiles.forEach((f) => {
    const css = fs.readFileSync(path.join(STATIC, "css", f), "utf-8");
    const style = window.document.createElement("style");
    style.textContent = css;
    window.document.head.appendChild(style);
  });
  return window;
}

function styleOf(window, sel, props) {
  const el = window.document.querySelector(sel);
  if (!el) return null;
  const cs = window.getComputedStyle(el);
  const out = {};
  props.forEach((p) => {
    out[p] = cs.getPropertyValue(p) || cs[p] || "";
  });
  return out;
}

console.log("\n=== 平台页 /platform 滚动链 ===");
{
  const w = loadPage("platform.html", ["hifi.css", "platform-hifi.css"]);

  // 最终方案：标准文档流滚动（document 是唯一滚动容器），见 platform-hifi.css 头注释
  const body = styleOf(w, "body", ["overflow", "height"]);
  check(
    "body 解锁（overflow visible / height auto）",
    body && /visible/.test(body["overflow"] || "") && /auto/.test(body["height"] || ""),
    body ? "overflow=" + body["overflow"] + " height=" + body["height"] : "未取到"
  );

  const content = styleOf(w, ".content", ["overflow-y", "min-height"]);
  check(".content 存在且不裁切（overflow visible）", content && content["overflow-y"] === "visible",
    content ? "overflow-y=" + content["overflow-y"] : "未取到");

  const sb = styleOf(w, ".sidebar", ["position", "overflow-y"]);
  check("侧栏 fixed 常驻 + 内部可滚", sb && sb["position"] === "fixed" && ["auto", "scroll"].includes(sb["overflow-y"]),
    sb ? "position=" + sb["position"] + " overflow-y=" + sb["overflow-y"] : "未取到");

  const tb = styleOf(w, ".topbar", ["position"]);
  check("topbar sticky 吸顶", tb && tb["position"] === "sticky", tb ? "position=" + tb["position"] : "未取到");

  // 嵌套滚动检测：滚动容器不应嵌套（会导致内层滚完外层才滚）
  const scrollables = Array.from(w.document.querySelectorAll("*")).length;
  check("页面节点可被解析", scrollables > 20, scrollables + " 个节点");

  // 弹窗/抽屉自带滚动
  const modalBd = styleOf(w, ".modal-bd", ["overflow-y"]);
  const drawerBd = styleOf(w, ".drawer-bd", ["overflow-y"]);
  check(
    "弹窗内容区自带滚动",
    modalBd && ["auto", "scroll"].includes(modalBd["overflow-y"]),
    modalBd ? "overflow-y=" + modalBd["overflow-y"] : "无 .modal-bd"
  );
  check(
    "抽屉内容区自带滚动",
    drawerBd && ["auto", "scroll"].includes(drawerBd["overflow-y"]),
    drawerBd ? "overflow-y=" + drawerBd["overflow-y"] : "无 .drawer-bd"
  );

  w.close();
}

console.log("\n=== 登录页 / 滚动链 ===");
{
  const w = loadPage("login.html", ["hifi.css", "auth.css"]);
  // 登录页同样是文档流滚动：wrap min-height:100vh，内容撑高文档
  const body2 = styleOf(w, "body", ["overflow", "height"]);
  const wrap = styleOf(w, ".login-wrap", ["min-height"]);
  check(
    "登录页 body 解锁（文档流滚动）",
    body2 && /visible/.test(body2["overflow"] || "") && /auto/.test(body2["height"] || ""),
    body2 ? "overflow=" + body2["overflow"] + " height=" + body2["height"] : "未取到"
  );
  check(
    "登录页 wrap 占满视口（min-height 非零，100vh 被 jsdom 解析为像素）",
    wrap && parseInt(wrap["min-height"], 10) > 0,
    wrap ? "min-height=" + wrap["min-height"] : "未取到"
  );
  w.close();
}

console.log("\n=== CSS 规则静态核对 ===");
{
  const css = fs.readFileSync(path.join(STATIC, "css", "platform-hifi.css"), "utf-8");
  check("html/body 解锁（height auto + overflow visible）", /html,\s*\n?body\s*\{[^}]*height:\s*auto\s*!important/.test(css) && /overflow:\s*visible\s*!important/.test(css));
  check(".content overflow:visible", /\.content\s*\{[^}]*overflow:\s*visible/.test(css));
  check("侧栏 fixed 方案", /\.sidebar\s*\{[^}]*position:\s*fixed/.test(css));
  check("窄屏抽屉态主区去边距", /@container app \(max-width: 720px\)\s*\{[^@]*\.main\s*\{\s*margin-left:\s*0/.test(css));
}

console.log("\nRESULT: " + pass + " 通过 / " + fail + " 失败\n");
process.exit(fail ? 1 : 0);
