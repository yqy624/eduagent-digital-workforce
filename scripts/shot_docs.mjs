/**
 * 截取平台真实界面，用于 README / 文档配图。
 *
 * 用法（先起一个临时实例，必须 SQLite 后端）：
 *   EA_BASE=http://127.0.0.1:18012 node scripts/shot_docs.mjs
 *
 * 约定：
 *  · 只读页面，不点任何写操作按钮；登录态通过 localStorage 注入，不落盘。
 *  · 输出 JPEG（界面截图用 PNG 体积大且无收益），统一宽 1440。
 *  · 控制台错误会汇总打印，页面取数失败时仍会截图，便于发现“空白页”问题。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// puppeteer-core 装在托管 node 工作区（不污染本项目）；ESM 不认 NODE_PATH，
// 所以按目录用 createRequire 解析，缺省回落到 npm i puppeteer-core 的本地目录。
const WORKSPACE = process.env.PB_WORKSPACE || process.cwd();
const require = createRequire(WORKSPACE.endsWith("/") || WORKSPACE.endsWith("\\") ? WORKSPACE : WORKSPACE + path.sep);
const puppeteer = require("puppeteer-core");

const BASE = process.env.EA_BASE || "http://127.0.0.1:18012";
const OUT = process.env.SHOT_OUT || "docs/assets/screenshots";
const CHROME = process.env.CHROME_PATH
  || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PASSWORD = process.env.EA_PASSWORD || "Demo@12345";

const ACCOUNTS = {
  admin: { username: "admin", role: "ADMIN" },
  teacher: { username: "teacher01", role: "TEACHER" },
  student: { username: "student01", role: "STUDENT" },
};

async function login(account) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: account.username,
      password: PASSWORD,
      role: account.role,
    }),
  });
  const body = await res.json();
  if (body.code !== 200) {
    throw new Error(`登录失败 ${account.username}: HTTP ${res.status} ${body.code} ${body.message}`);
  }
  return body.data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(page, { name, url, wait = 2600, before, goto }) {
  const errors = [];
  const onErr = (msg) => {
    const text = String(msg.text ? msg.text() : msg);
    if (/Failed to load resource/.test(text)) return;
    errors.push(text);
  };
  page.on("console", (m) => { if (m.type() === "error") onErr(m); });
  page.on("pageerror", (e) => errors.push(String(e && e.message ? e.message : e)));

  await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 }).catch(() => {});
  await sleep(wait);
  if (before) await before(page);
  else if (goto) {
    // 协作台是单页多视图，靠侧栏按钮切页；数据由脚本填充，切完再等一拍
    await page.evaluate((pid) => {
      const btn = document.querySelector(`[data-goto="${pid}"]`);
      if (btn) btn.click();
    }, goto);
    await sleep(1400);
  }
  await sleep(700);

  const file = path.join(OUT, `${name}.jpg`);
  await page.screenshot({ path: file, type: "jpeg", quality: 88 });
  page.removeAllListeners("console");
  page.removeAllListeners("pageerror");

  const size = fs.statSync(file).size;
  console.log(`  ${name.padEnd(26)} ${(size / 1024).toFixed(0).padStart(5)} KB  ${errors.length ? "⚠ " + errors[0].slice(0, 90) : ""}`);
  return errors;
}

const SHOTS = (process.env.SHOT_PAGES || "").trim()
  ? JSON.parse(process.env.SHOT_PAGES)
  : [
  // 编号即 README 里的展示顺序：先协作台（数字员工），再控制台（员工产出落地）
  { name: "01-workspace", role: "admin", url: "/workspace" },
  { name: "02-employees", role: "admin", url: "/workspace", goto: "p3", wait: 2200 },
  { name: "03-command", role: "admin", url: "/workspace", goto: "p1", wait: 3000 },
  { name: "04-chat", role: "admin", url: "/workspace", goto: "p2", wait: 4200 },
  { name: "05-vision", role: "admin", url: "/platform#/vision/vision-overview", wait: 3200 },
  { name: "06-review", role: "admin", url: "/platform#/review/review-overview", wait: 3200 },
  { name: "07-student", role: "student", url: "/workspace" },
  { name: "08-login", guest: true, url: "/login.html?next=/", wait: 1500 },
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const tokens = {};
  for (const [key, account] of Object.entries(ACCOUNTS)) {
    tokens[key] = await login(account);
    console.log(`登录成功 ${account.username} (${account.role})`);
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars", "--force-device-scale-factor=1"],
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  });

  const failures = [];
  for (const shot of SHOTS) {
    const page = await browser.newPage();
    const data = shot.guest ? null : tokens[shot.role];
    if (data) {
      const session = {
        id: data.id == null ? null : data.id,
        username: data.username,
        displayName: data.displayName || data.username,
        role: String(data.role || "").toUpperCase(),
        expiresIn: data.expiresIn || null,
        at: Date.now(),
      };
      await page.evaluateOnNewDocument((token, ses) => {
        localStorage.setItem("ea.token", token);
        localStorage.setItem("ea.session", ses);
      }, data.token || "", JSON.stringify(session));
    }
    const errors = await shoot(page, { ...shot, url: BASE + shot.url });
    if (errors.length) failures.push(`${shot.name}: ${errors[0]}`);
    await page.close();
  }

  await browser.close();
  if (failures.length) {
    console.log("\n渲染告警：");
    failures.forEach((f) => console.log("  - " + f));
    process.exitCode = 0;
  }
}

main().catch((err) => {
  console.error("截图失败:", err && err.message ? err.message : err);
  process.exitCode = 1;
});
