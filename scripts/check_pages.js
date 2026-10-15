/* 用 jsdom 真实执行页面脚本，验证渲染结果与运行时错误。
 * 只做只读检查：不写库、不删文件。
 * 用法：node scripts/check_pages.js [baseUrl]
 */
const { JSDOM, VirtualConsole } = require("jsdom");
const path = require("path");
const fs = require("fs");

const BASE = process.argv[2] || "http://127.0.0.1:18010";
const ROOT = path.resolve(__dirname, "..");
const TOKEN = process.env.SMOKE_TOKEN || "";

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function makeDom(html, url, storage) {
  const vc = new VirtualConsole();
  const errors = [];
  vc.on("jsdomError", (e) => errors.push("jsdomError: " + (e.message || e) + "\n   " + String(e.stack || "").split("\n").slice(1,4).join("\n   ")));
  vc.on("error", (...a) => errors.push("console.error: " + a.join(" ")));
  const dom = new JSDOM(html, {
    url,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(win) {
      // jsdom 不提供 fetch / rAF，这里注入真实的
      win.fetch = (u, o) => {
        const full = String(u).startsWith("http") ? String(u) : BASE + String(u);
        const opts = Object.assign({}, o || {});
        if (TOKEN) {
          opts.headers = Object.assign({}, opts.headers || {}, { Authorization: "Bearer " + TOKEN });
        }
        return fetch(full, opts);
      };
      win.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
      win.scrollTo = () => {};  // jsdom 未实现 scrollTo，页面 boot/切通道会调用
      win.HTMLElement.prototype.scrollTo = function () {};
      if (storage) Object.keys(storage).forEach((k) => win.localStorage.setItem(k, storage[k]));
    },
  });
  return { dom, errors };
}

function count(sel, doc) {
  return doc.querySelectorAll(sel).length;
}

async function checkLogin() {
  const html = read("static/login.html");
  const { dom, errors } = makeDom(html, BASE + "/login.html");
  const w = dom.window;
  await new Promise((r) => setTimeout(r, 1200));
  const d = w.document;
  const out = {
    page: "login.html",
    errors: errors.slice(0, 5),
    brand: !!d.querySelector(".ls-brand"),
    segItems: count(".seg-item", d),
    modalCount: count(".modal", d),
    loginBtn: !!d.getElementById("loginBtn"),
    modules: (d.getElementById("mModules") || {}).textContent,
    vision: (d.getElementById("mVision") || {}).textContent,
    status: (d.getElementById("stText") || {}).textContent,
    iconsInjected: count("[data-icon] svg", d),
  };
  w.close();
  return out;
}

async function checkPlatform() {
  const html = read("static/platform.html");
  const { dom, errors } = makeDom(html, BASE + "/platform", {
    token: TOKEN,
    role: "TEACHER",
    username: "teacher01",
    displayName: "张老师",
  });
  const w = dom.window;
  const d = w.document;
  // 手动加载脚本（jsdom 不自动取外链 script）
  ["static/js/menu.config.js", "static/js/permissions.js", "static/js/hifi.js",
   "static/js/hifi-bridge.js", "static/js/app-shell.js"].forEach((rel) => {
    try {
      w.eval(read(rel));
    } catch (e) {
      errors.push("eval " + rel + ": " + e.message);
    }
  });
  d.dispatchEvent(new w.Event("DOMContentLoaded"));
  await new Promise((r) => setTimeout(r, 2500));

  const content = d.getElementById("content");
  const out = {
    page: "platform.html",
    errors: errors.slice(0, 5),
    navItems: count("#sideNav .nav-item", d),
    contentHtmlLen: content ? content.innerHTML.length : 0,
    statCards: count("#content .stat", d),
    tableRows: count("#content tbody tr", d),
    segViews: count("[data-seg-view]", d),
    iconsInjected: count("#content [data-icon] svg", d),
    hasLab: !!d.getElementById("labRun"),
    modelChip: (d.getElementById("modelChip") || {}).textContent,
    notif: (d.getElementById("notifCount") || {}).textContent,
    firstNav: (d.querySelector("#sideNav .nav-item") || {}).textContent,
  };
  // 切到评阅模块，验证真实业务链路：课程 -> 作业 -> 提交
  w.location.hash = "#/review";
  w.dispatchEvent(new w.Event("hashchange"));
  await new Promise((r) => setTimeout(r, 3000));
  const course = d.getElementById("wbCourse");
  const assign = d.getElementById("wbAssign");
  out.review = {
    courseOptions: course ? course.options.length : 0,
    assignOptions: assign ? assign.options.length : 0,
    wbStats: count("#wbStats .stat", d),
    subRows: count("#wbTable tbody tr", d),
    gradeButtons: count("[data-grade]", d),
    graderNames: Array.prototype.slice.call(d.querySelectorAll("#wbTable tbody tr")).slice(0, 3)
      .map((tr) => (tr.children[0] || {}).textContent),
  };

  w.close();
  return out;
}

(async () => {
  const login = await checkLogin();
  console.log("=== LOGIN ===");
  console.log(JSON.stringify(login, null, 2));
  const plat = await checkPlatform();
  console.log("=== PLATFORM ===");
  console.log(JSON.stringify(plat, null, 2));
  const bad = (login.errors && login.errors.length) || (plat.errors && plat.errors.length) ||
    plat.navItems === 0 || plat.tableRows === 0;
  console.log(bad ? "RESULT: FAIL" : "RESULT: PASS");
  process.exit(bad ? 1 : 0);
})();
