/* check_scroll.js —— 真实浏览器布局测量（jsdom 不做布局，测不了滚动）
 *
 * 用途：验证主内容区是否真的可滚动。jsdom 的 scrollHeight/clientHeight 恒为 0，
 * 只能靠 CSS 规则推断；本脚本用系统 Chrome/Edge 跑真实布局，直接量：
 *   - .content 的 clientHeight / scrollHeight（scrollHeight > clientHeight 才说明有内容在视口外）
 *   - 真正执行 scrollTop=9999 看能不能滚下去
 *   - 整条祖先链的 height / min-height / overflow
 *
 * 用法：
 *   SMOKE_TOKEN=<token> NODE_PATH=<workspace>/node_modules node scripts/check_scroll.js http://127.0.0.1:18010
 */
const fs = require("fs");
const os = require("os");
const puppeteer = require("puppeteer-core");

const BASE = process.argv[2] || "http://127.0.0.1:18010";
const TOKEN = process.env.SMOKE_TOKEN || "";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const EXE = fs.existsSync(CHROME) ? CHROME : EDGE;
const OUT_DIR = process.env.TMPDIR || os.tmpdir();

function snap(el, cs) {
  return {
    clientH: el.clientHeight,
    scrollH: el.scrollHeight,
    offsetH: el.offsetHeight,
    height: cs.height,
    minHeight: cs.minHeight,
    flex: cs.flex,
    display: cs.display,
    overflowY: cs.overflowY,
    overflowX: cs.overflowX,
    position: cs.position,
  };
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EXE,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  const results = [];
  for (const vp of [
    { width: 1280, height: 720, name: "桌面 1280x720" },
    { width: 900, height: 600, name: "窄窗 900x600" },
  ]) {
    const page = await browser.newPage();
    await page.setViewport({ width: vp.width, height: vp.height });
    await page.evaluateOnNewDocument(
      (t) => {
        if (t) localStorage.setItem("token", t);
        localStorage.setItem("role", "TEACHER");
        localStorage.setItem("username", "teacher01");
        localStorage.setItem("displayName", "王老师");
      },
      TOKEN
    );
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e.message || e)));
    await page.goto(BASE + "/platform", { waitUntil: "networkidle2", timeout: 60000 });
    await new Promise((r) => setTimeout(r, 2500));

    const info = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const cs = (el) => (el ? getComputedStyle(el) : null);
      const out = { url: location.pathname };
      const content = q(".content");
      out.content = content
        ? { clientH: content.clientHeight, scrollH: content.scrollHeight, overflowY: cs(content).overflowY, minHeight: cs(content).minHeight, height: cs(content).height }
        : null;
      ["html", "body", ".app", ".shell", ".main", ".topbar", ".sidebar", ".content-inner"].forEach((k) => {
        const el = k.startsWith(".") ? q(k) : document.documentElement.tagName === "HTML" && k === "html" ? document.documentElement : q(k);
        if (k === "html") {
          out["html"] = { clientH: document.documentElement.clientHeight, scrollH: document.documentElement.scrollHeight, overflowY: cs(document.documentElement).overflowY, height: cs(document.documentElement).height };
          return;
        }
        if (k === "body") {
          out["body"] = { clientH: document.body.clientHeight, scrollH: document.body.scrollHeight, overflowY: cs(document.body).overflowY, height: cs(document.body).height };
          return;
        }
        if (el) out[k] = { clientH: el.clientHeight, scrollH: el.scrollHeight, height: cs(el).height, minHeight: cs(el).minHeight, overflowY: cs(el).overflowY };
      });
      if (content) {
        const before = content.scrollTop;
        content.scrollTop = 99999;
        out.scrollTest = { before: before, after: content.scrollTop, scrollable: content.scrollTop > 0 };
        content.scrollTop = 0;
      }
      out.docScrollTest = (function () {
        window.scrollTo(0, 99999);
        const v = window.scrollY;
        window.scrollTo(0, 0);
        return v;
      })();
      out.contentTextLen = (q("#content") ? q("#content").innerHTML.length : 0);
      return out;
    });

    const shot = OUT_DIR + "/scroll_" + vp.width + ".png";
    await page.screenshot({ path: shot, fullPage: false });
    results.push({ viewport: vp.name, errors: errs, info: info, shot: shot });
    await page.close();
  }

  await browser.close();

  let fail = 0;
  results.forEach((r) => {
    console.log("\n=== " + r.viewport + " ===");
    console.log("运行时错误: " + (r.errors.length ? r.errors.join(" | ") : "无"));
    const c = r.info.content;
    console.log(".content: clientH=" + (c && c.clientH) + " scrollH=" + (c && c.scrollH) +
      " overflowY=" + (c && c.overflowY) + " minHeight=" + (c && c.minHeight) + " height=" + (c && c.height));
    console.log("滚动测试: " + JSON.stringify(r.info.scrollTest) + "  window.scrollY=" + r.info.docScrollTest);
    console.log("内容节点长度: " + r.info.contentTextLen);
    ["html", "body", ".app", ".shell", ".main", ".sidebar"].forEach((k) => {
      const v = r.info[k];
      if (v) console.log("  " + k + ": clientH=" + v.clientH + " scrollH=" + v.scrollH + " height=" + v.height + " overflowY=" + v.overflowY);
    });
    const ok = c && c.scrollH > c.clientH ? c.scrollTest && c.scrollTest.scrollable : true;
    console.log("判定: " + (r.errors.length === 0 && ok !== false ? "PASS" : "FAIL"));
    console.log("截图: " + r.shot);
    if (r.errors.length || ok === false) fail++;
  });
  process.exit(fail ? 1 : 0);
})();
