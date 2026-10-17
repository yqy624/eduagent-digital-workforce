/* probe_scroll.js —— 真实浏览器滚动探测（最终版：标准文档流方案）
 *
 * 平台采用「document 作为唯一滚动容器」的方案（见 platform-hifi.css 头注释）。
 * 本脚本验证：
 *   1. window 能滚到内容底部（scrollY > 0，且最大 scrollY ≈ docScrollH - clientH）
 *   2. 真实滚轮事件能滚动（用户实际操作路径）
 *   3. topbar 滚动后吸顶（sticky 生效）
 *   4. 侧栏吸附在视口（sticky），不随内容滚走
 *   5. 滚到底后，页面最后一块内容可见（"下面的功能显示得出来"）
 *
 * 用法：
 *   SMOKE_TOKEN=<token> NODE_PATH=<workspace>/node_modules node scripts/probe_scroll.js http://127.0.0.1:18010
 */
const fs = require("fs");
const os = require("os");
const puppeteer = require("puppeteer-core");

const BASE = process.argv[2] || "http://127.0.0.1:18010";
const TOKEN = process.env.SMOKE_TOKEN || "";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const EXE = fs.existsSync(CHROME) ? CHROME : EDGE;

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  OK   " + name + (detail ? "  — " + detail : "")); }
  else { fail++; console.log("  FAIL " + name + (detail ? "  — " + detail : "")); }
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EXE, headless: "new",
    args: ["--no-sandbox", "--disable-gpu"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.evaluateOnNewDocument((t) => {
    if (t) localStorage.setItem("token", t);
    localStorage.setItem("role", "TEACHER");
    localStorage.setItem("username", "teacher01");
  }, TOKEN);
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e.message || e)));
  await page.goto(BASE + "/platform", { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2200));

  const base = await page.evaluate(() => ({
    docScrollH: document.documentElement.scrollHeight,
    docClientH: document.documentElement.clientHeight,
    bodyOverflow: getComputedStyle(document.body).overflow,
    bodyHeight: getComputedStyle(document.body).height,
    contentScrollH: (document.querySelector(".content") || {}).scrollHeight,
  }));
  console.log("文档: scrollH=" + base.docScrollH + " clientH=" + base.docClientH +
    " bodyOverflow=" + base.bodyOverflow + " bodyHeight=" + base.bodyHeight);
  check("文档高度超出视口（存在需要滚动的内容）", base.docScrollH > base.docClientH,
    base.docScrollH + " > " + base.docClientH);
  check("body 解锁 overflow（文档流滚动）", base.bodyOverflow === "visible", base.bodyOverflow);

  // instant 滚到底
  const bottom = await page.evaluate(() => {
    window.scrollTo({ top: 999999, behavior: "instant" });
    return window.scrollY;
  });
  check("window 可滚到底", bottom > 100, "scrollY=" + bottom);
  check("滚到底后距文档底部很近", Math.abs(base.docScrollH - base.docClientH - bottom) < 8,
    "期望 " + (base.docScrollH - base.docClientH) + "，实际 " + bottom);

  // 滚到底后：最后的内容块在视口内
  const lastVisible = await page.evaluate(() => {
    const inner = document.querySelector(".content-inner");
    if (!inner) return { ok: false, why: "no .content-inner" };
    const kids = Array.from(inner.children).filter((el) => el.offsetHeight > 0);
    const last = kids[kids.length - 1];
    const r = last.getBoundingClientRect();
    return { ok: r.top < window.innerHeight && r.bottom > 0, tag: last.tagName, cls: String(last.className).slice(0, 40), top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight };
  });
  check("滚到底后最后一块内容可见", !!lastVisible.ok,
    lastVisible.ok ? JSON.stringify({ cls: lastVisible.cls, top: lastVisible.top, bottom: lastVisible.bottom, vh: lastVisible.vh }) : JSON.stringify(lastVisible));

  // topbar sticky
  const sticky = await page.evaluate(() => {
    const tb = document.querySelector(".topbar");
    const r = tb.getBoundingClientRect();
    return { top: Math.round(r.top), pos: getComputedStyle(tb).position, visible: r.bottom > 0 };
  });
  check("topbar 滚动后吸顶可见", sticky.pos === "sticky" && sticky.top === 0 && sticky.visible,
    "position=" + sticky.pos + " top=" + sticky.top);

  // 侧栏吸附
  const sb = await page.evaluate(() => {
    const s = document.querySelector(".sidebar");
    const r = s.getBoundingClientRect();
    return { top: Math.round(r.top), pos: getComputedStyle(s).position, h: Math.round(r.height), vh: window.innerHeight };
  });
  check("侧栏 fixed 常驻视口", sb.pos === "fixed" && sb.top === 0 && Math.abs(sb.h - sb.vh) < 4,
    "position=" + sb.pos + " top=" + sb.top + " h=" + sb.h + " vh=" + sb.vh);

  // 真实滚轮
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  const box = await page.evaluate(() => {
    const c = document.querySelector(".content");
    const r = c.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + Math.min(r.height, window.innerHeight) / 2 };
  });
  await page.mouse.move(box.x, box.y);
  for (let i = 0; i < 5; i++) await page.mouse.wheel({ deltaY: 400 });
  await new Promise((r) => setTimeout(r, 500));
  const wheelY = await page.evaluate(() => window.scrollY);
  check("真实滚轮可滚动", wheelY > 0, "scrollY=" + wheelY);

  check("运行时无错误", errs.length === 0, errs.length ? errs.join(" | ") : "0 错误");

  await page.evaluate(() => window.scrollTo({ top: 400, behavior: "instant" }));
  await new Promise((r) => setTimeout(r, 200));
  await page.screenshot({ path: require("path").join(os.tmpdir(), "scroll_probed.png") });
  await browser.close();

  console.log("\nRESULT: " + pass + " 通过 / " + fail + " 失败\n");
  process.exit(fail ? 1 : 0);
})();
