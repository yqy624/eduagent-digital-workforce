/**
 * 控制台 DOM 集成测试（jsdom）：在真实 DOM 里跑真正的 static/js/console/app.js。
 *
 * 为什么需要它
 * ----------
 * `/platform`（platform.html + js/console/*）是**唯一被路由的产品页**，但此前没有任何
 * DOM 层覆盖：check_prototype.py 读静态源码，check_wiring.py 读选择器与类名接线，
 * smoke_data_layer.mjs 测数据层，smoke_desktop_dom.mjs 测 desktop.html ——
 * 控制台「渲染出来到底长什么样」没人验。
 *
 * 它还负责一件静态检查做不到的事：**扫描渲染完成后的可见文本**。
 * 「课堂行为识别 · 示例版」这类文案来自数据库，源码里根本查不到，只有渲染出来才抓得住。
 *
 * 用法：
 *   node scripts/smoke_console_dom.mjs                 # 只跑 ADMIN
 *   node scripts/smoke_console_dom.mjs --all           # 三个角色各起一个进程跑满全部页面
 *   node scripts/smoke_console_dom.mjs --role=STUDENT
 * 前置：后端已在 127.0.0.1:18010 运行，且 seed 数据已导入。
 * 依赖：jsdom（装在托管 node 工作区，不污染本项目）。
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// jsdom 装在任意 node_modules 目录时，用 WB_NODE_WORKSPACE 指向它；
// 缺省按当前工作目录解析（npm i jsdom 即可）
const WORKSPACE = process.env.WB_NODE_WORKSPACE || process.cwd();
const require = createRequire(WORKSPACE.endsWith("/") ? WORKSPACE : WORKSPACE + "/");
const { JSDOM, VirtualConsole } = require("jsdom");

// 后端地址可用 EA_BASE 覆盖：想在临时实例（换端口 / 换代码版本）上验证时，
// 不必去动用户正在跑的那个进程。
const BASE = process.env.EA_BASE || "http://127.0.0.1:18010";
const ACCOUNTS = { ADMIN: "admin", TEACHER: "teacher01", STUDENT: "student01" };

// 用户上传的文件名天然是 snake_case（edu_vision_probe.jpg），属于正常业务数据。
const FILE_LIKE = /\.(?:jpe?g|png|gif|webp|bmp|svg|txt|md|pdf|csv|xlsx?|docx?|pptx?|zip|rar|mp4|mov|avi|json|xml)\b/i;

// 渲染后的可见文本里不该出现的措辞。
// 完整词表以 scripts/check_prototype.py 的 ADMIN_SPEAK 为准（那个按行扫源码）；
// 这里只放**可能从数据里长出来**的高风险词 —— 静态检查抓不到的正是这部分。
// 每项是 [原因, 正则, 例外正则?]：例外命中时放行（例如文件名不算标识符泄漏）。
const BANNED = [
  ["接口路径泄漏", /\/api\//],
  ["存储实现泄漏", /localStorage/],
  ["实现视角", /中台|控制台|后端|服务端/],
  ["实现自述", /占位|真实模型|模型接入|链路连通|熔断/],
  ["中台视角", /事件流|能力清单|视觉实现|模型层|注册表|权重路径/],
  ["工程术语", /技能包|数据域|运行时|工具调用|阈值|置信度|向量库|embedding|落库|契约|会签/],
  ["模型架构名", /YOLO|classroom/],
  ["开发脚本引用", /\.py\b|\.mjs\b|seed_demo/],
  ["运行编号", /run-\d/],
  // 第三轮补齐：以下三个词此前不在词表里，但已实际从数据库 / 接口 payload 长进用户界面
  ["研发缩写", /HITL|TODO|WIP/],
  ["流程黑话", /业务闭环|闭环|赋能|抓手|中台化/],
  ["标注术语", /帧级标注|标注帧|打标/],
  ["内部单号", /任务号|任务编号|事件编号/],
  // 第四轮：从「词表」升级到「形态」。逐个枚举术语永远追不上漏检 ——
  // 但只要可见文本里出现 camelCase / snake_case 标识符，它一定是代码而不是人话
  // （taskTotal / placeholdersInUse / event_type / source_ref …）。
  // 两个误报要放行：邮箱里的下划线、以及用户真实上传的文件名。
  ["接口字段名", /\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/, FILE_LIKE],
  ["接口字段名", /(?<![@\w])[a-z][a-z0-9]*_[a-z0-9_]+(?![@\w])/, FILE_LIKE],
  // 第五轮：第四轮按「形态」抓标识符，但**裸字段名**是小写单词（scene / status / role），
  // 形态规则看不见。这一类同样是从后端 payload 里长出来的，只能点名列举。
  ["后端字段直出", /\b(?:scene|task_code|source_ref|student_no|track_id|assignment_id|submission_id|file_id|event_type)\b/],
  // 第六轮：研发视角短语。第五轮扫到 `已注册的识别场景`、`已接入的识别能力数`、
  // `个体画像的原始输入`、`结构化事件` 全都没进词表 —— 它们不是术语名词，是**研发视角的定语**，
  // 共同特征是「在描述实现进度或数据加工阶段」，而用户在描述自己的事。
  ["实现进度自述", /已注册|已接入|已上线|已落地|未落地|待建设|需改造|建设中|还没上线/],
  ["数据加工阶段", /结构化事件|可消费事件|原始输入|原始数据|数据源|上游|下游|链路/],
  ["内部机制名", /身份映射|感知中枢|模型资产|模型注册表|权重|置信度/],
  // 第七轮：**平台自己的模块叫法**。菜单上这个模块叫「课堂与考场监测」，
  // 但代码里它叫 vision / 视觉，于是「视觉事件」「视觉输入源」这类只有研发看得懂的
  // 词混进了界面。判据很简单：菜单里没出现过的模块名，就不该出现在文案里。
  // ⚠ 这里**不能裸写 `/视觉/`** —— 课程名「智能视觉导论」是真实数据，会被误判。
  // 只列举确实属于内部叫法的固定搭配。
  ["内部模块叫法", /视觉模块|视觉事件|视觉告警|视觉预警|视觉输入源|视觉输入|视觉行为|视觉记录|视觉结果|感知中枢|个体能力|个体画像|输入源|消费对象|报告口径|口径/],
  // 第八轮：部署/交付视角的词。「还没上线」「接口未落地」是给排期看的，用户只关心能不能用。
  ["交付视角", /接口未落地|接口没有|服务端未|尚未配置|暂无数据表/],
];

// ---------------------------------------------------------------- --all 分发
// 注意：这里**不能用 process.exit()** —— 输出到管道时 stdout 是异步的，
// 进程立刻退出会把还没 flush 的内容整段丢掉（表现就是「跑了但一个字都没打出来」）。
// 改成设置 exitCode，让进程自然退出。
if (process.argv.includes("--all")) {
  let bad = 0;
  for (const role of Object.keys(ACCOUNTS)) {
    try {
      process.stdout.write(execFileSync(
        process.execPath, [fileURLToPath(import.meta.url), "--role=" + role], { encoding: "utf8" }));
    } catch (e) {
      if (e.stdout) process.stdout.write(e.stdout);
      if (e.stderr) process.stderr.write(e.stderr);
      // 派生失败（受限沙箱会返回 EBUSY）时 e.stdout/e.stderr 都是 undefined，
      // 只写那两个字段会**把错误整段吞掉** —— 现象就是「跑了但一个字都没打出来」。
      // 这里必须显式报出来，并给出受限环境下的替代跑法。
      if (!e.stdout && !e.stderr) {
        process.stderr.write(`  ✗ 无法为角色 ${role} 启动子进程：${e.code || e.message}\n`);
        process.stderr.write("    受限环境会禁止 spawn。请分别执行：\n"
          + "      node scripts/smoke_console_dom.mjs --role=ADMIN\n"
          + "      node scripts/smoke_console_dom.mjs --role=TEACHER\n"
          + "      node scripts/smoke_console_dom.mjs --role=STUDENT\n");
      }
      bad = 1;
    }
  }
  process.exitCode = bad;
} else {

const ROLE = (process.argv.find((a) => a.startsWith("--role=")) || "").split("=")[1] || "ADMIN";
const USER = ACCOUNTS[ROLE];
if (!USER) { console.error("未知角色：" + ROLE); process.exit(2); }

let pass = 0, fail = 0;
const problems = [];
const pageErrors = [];

function ok(label, cond, extra) {
  if (cond) { pass++; console.log("  \u2713 " + label + (extra ? "  " + extra : "")); }
  else { fail++; problems.push(label + (extra ? " :: " + extra : "")); console.log("  \u2717 " + label + (extra ? "  " + extra : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 1. 装配 DOM ---------------- */
console.log(`\n================ 控制台 DOM 集成测试 · 角色 ${ROLE} ================`);
console.log("=== 1. 装配 DOM（platform.html → jsdom）===");
const html = readFileSync("static/platform.html", "utf8");
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => pageErrors.push("jsdomError: " + (e && e.message)));
vc.on("error", (...a) => pageErrors.push("console.error: " + a.join(" ")));
vc.on("warn", () => {});

const dom = new JSDOM(html, {
  url: BASE + "/platform", pretendToBeVisual: true,
  runScripts: "outside-only", virtualConsole: vc,
});
const W = dom.window;
const doc = W.document;

W.IntersectionObserver = class {
  constructor() {} observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
};
globalThis.window = W;
globalThis.document = doc;
globalThis.localStorage = W.localStorage;
globalThis.location = W.location;
globalThis.URLSearchParams = W.URLSearchParams;
globalThis.FormData = W.FormData;
globalThis.IntersectionObserver = W.IntersectionObserver;
globalThis.requestAnimationFrame = (cb) => W.requestAnimationFrame(cb);
globalThis.cancelAnimationFrame = (id) => W.cancelAnimationFrame(id);
globalThis.getComputedStyle = W.getComputedStyle.bind(W);
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => realFetch(String(u).startsWith("http") ? u : BASE + u, o);

await new Promise((r) => (doc.readyState === "complete" ? r() : W.addEventListener("load", r)));
ok("DOM 就绪", doc.readyState === "complete", "readyState=" + doc.readyState);
ok("页面存在装配点 #spineRoot", !!doc.getElementById("spineRoot"));

/* ---------------- 2. 菜单配置 + 登录 ---------------- */
console.log("\n=== 2. 菜单配置与登录（走真实 api.js 的 session）===");
// menu.config.js 是经典脚本（挂 window.PLATFORM_MENU），用 eval 装进 jsdom 的 window
new Function("window", readFileSync("static/js/menu.config.js", "utf8"))(W);
ok("window.PLATFORM_MENU 已就位", !!(W.PLATFORM_MENU && W.PLATFORM_MENU.modules));

const api = await import("../static/js/console/api.js");
const u = await api.login(USER, "Demo@12345", ROLE);
ok("令牌已写入 localStorage", W.localStorage.getItem("ea.token") === u.token,
  "len=" + (u.token || "").length);
ok("角色已落库", String(W.localStorage.getItem("ea.session") || "").includes(ROLE));

/* ---------------- 3. 载入控制台 ---------------- */
console.log("\n=== 3. import console/app.js 并等待外壳装配 ===");
const app = await import("../static/js/console/app.js");
const shell = doc.getElementById("shellRoot");
ok("外壳已装配（#shellRoot）", !!shell);
ok("导航已渲染（#spineNav 有内容）",
  !!doc.getElementById("spineNav") && doc.getElementById("spineNav").textContent.trim().length > 10);
ok("侧栏角色名已中文化（不出现枚举 ADMIN/TEACHER/STUDENT）",
  !/ADMIN|TEACHER|STUDENT/.test(doc.querySelector(".spine-foot") ? doc.querySelector(".spine-foot").textContent : ""),
  (doc.querySelector(".spine-foot") || {}).textContent);

const registry = (await import("../static/js/console/registry.js")).registry;
const mods = registry.visibleModules(ROLE);
const routes = [];
for (const m of mods) {
  // 模块首页（#/vision）也必须扫。此前只枚举了子页，于是 6 个首页的 statCard 说明文案
  // 完全没人验过 —— 而 `结构化事件 / 识别产出的可消费事件 / 个体画像的原始输入`
  // 这几条最刺眼的措辞恰好全都在首页上。
  routes.push({ module: m.id, child: "", label: m.label + " · 模块首页", home: true });
  for (const c of registry.visibleChildren(ROLE, m.id)) routes.push({ module: m.id, child: c.id, label: c.label });
}
ok("角色可见功能页面已枚举", routes.length > 0,
  `${mods.length} 个模块 / ${routes.length} 个页面（含首页）`);

/* ---------------- 4. 逐页渲染并扫描可见文本 ---------------- */
console.log("\n=== 4. 逐页渲染并扫描可见文本 ===");
const canvas = doc.getElementById("canvas");
const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 跳到指定子页并等它真正渲染完。
 *
 * 这里有两个曾把测试骗过去的坑，都写死在函数里：
 *
 * ① hash 必须是 `模块/子页` 两段。`app.js` 的 `parseHash()` 把第一段当模块 id，
 *    只传子页 id（如 `vision-records`）会解析成「不存在的模块」→ 回退到
 *    `visible[0]`。结果 40 多个路由全都渲染同一个默认页，扫描扫的是同一份文本，
 *    自然一条问题都报不出来。
 *
 * ② 不能只等「长度稳定」。上一个页面的残留内容同样满足「长度稳定 > 40」，
 *    于是切换瞬间就判定完成，扫到的是**上一页的文本**。这里改成三重条件：
 *    内容相对导航前发生了变化 + 内容长度稳定 + 确实观察到过 DOM 变动。
 */
async function routeTo(moduleId, childId) {
  const target = childId ? moduleId + "/" + childId : moduleId;
  const before = canvas.textContent;
  let mutations = 0;
  const obs = new W.MutationObserver(() => { mutations++; });
  obs.observe(canvas, { childList: true, subtree: true, characterData: true });
  const t0 = Date.now();
  app.go(target);
  let lastLen = -1, stable = 0, changed = false;
  for (let i = 0; i < 120; i++) {
    await sleep2(50);
    const txt = canvas.textContent;
    if (txt !== before) changed = true;
    const len = txt.length;
    // ③ 还必须屏住 700ms。页面壳是同步写进去的，真正的数据是随后 fetch 回来的 ——
    //    只等「长度稳定」会在壳刚写完之后就判定完成，于是 statCard 的说明文案
    //    （jargon 的重灾区）永远扫不到。多等一会儿，让异步取数落屏。
    if (changed && mutations > 0 && len === lastLen && len > 40 && Date.now() - t0 > 700) {
      if (++stable >= 2) break;
    } else stable = 0;
    lastLen = len;
  }
  obs.disconnect();
  return { len: lastLen, changed, hash: W.location.hash };
}

/** hash 归一化：`#/vision`、`#vision`、`vision` 视为同一个地址。 */
const normHash = (hh) => String(hh || "").replace(/^#\/?/, "").replace(/\/+$/, "");

const visited = [];
const bad = [];
const seenLeaks = new Set();
const contentByRoute = new Map();  // 归一化文本 → 首个渲染出它的路由（用于抓「所有页渲染成同一页」）

/** 找出「哪个元素里的文本」命中了禁用词 —— 只报片段没用，得能直接去改。 */
function locate(re, root, allowRe) {
  const hits = [];
  for (const el of root.querySelectorAll("*")) {
    if (el.tagName === "SCRIPT" || el.tagName === "STYLE") continue;
    for (const n of el.childNodes) {
      if (n.nodeType !== 3) continue;
      const value = String(n.nodeValue || "");
      if (allowRe && allowRe.test(value)) continue;
      const m = value.match(re);
      if (!m) continue;
      const path = [];
      for (let p = el; p && p !== root; p = p.parentElement) {
        path.unshift(p.tagName.toLowerCase()
          + (p.id ? "#" + p.id : "")
          + (p.className ? "." + String(p.className).trim().split(/\s+/)[0] : ""));
      }
      hits.push({ where: path.join(">"), text: value.trim().slice(0, 60) });
      break;
    }
  }
  return hits;
}

/* ---------------- 统一的泄漏上报 ----------------
 * 必须做成「增量上报」：第 4 节先把 bad 打完，第 6 节的浮层再往 bad 里追加 ——
 * 如果第 6 节之后不再打印一次，这些命中就**既不上屏也不计数**，
 * 表现又是「测试全绿但问题是真存在的」。凡是往 bad 里写的地方，都必须走这个函数。
 */
let reported = 0;
function reportLeaks(title) {
  const fresh = bad.slice(reported);
  reported = bad.length;
  if (!fresh.length) return 0;
  console.log(`\n  ✗ ${title} ${fresh.length} 条：`);
  fresh.slice(0, 200).forEach((x) => console.log("     · " + x));
  fail += fresh.length;
  problems.push(...fresh);
  return fresh.length;
}

/* ---------------- 扫描器自检 ----------------
 * 没有这一步，「0 条问题」既可能是真干净，也可能是扫描器压根没在工作 ——
 * 二者在输出上完全一样。这里塞一段**已知有问题**的文本进 DOM，确认扫描器抓得到。
 */
{
  const probeEl = doc.createElement("div");
  probeEl.className = "self-test";
  probeEl.textContent = "taskTotal lab_safety";
  canvas.appendChild(probeEl);
  const camel = locate(/\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/, canvas);
  const snake = locate(/(?<![@\w])[a-z][a-z0-9]*_[a-z0-9_]+(?![@\w])/, canvas);
  probeEl.remove();
  ok("扫描器自检：能抓到 camelCase / snake_case（否则「0 条问题」不算数）",
    camel.length > 0 && snake.length > 0, `camel=${camel.length} snake=${snake.length}`);
}

for (const r of routes) {
  const key = r.home ? r.module + "/（首页）" : r.module + "/" + r.child;
  const errBefore = pageErrors.length;
  const { len, changed, hash } = await routeTo(r.module, r.child);
  visited.push(key);
  const thrown = pageErrors.slice(errBefore);
  if (thrown.length) bad.push(`${key}（${r.label}）渲染抛错：${thrown[0]}`);
  if (!changed) bad.push(`${key}（${r.label}）切换后内容没有任何变化 —— 很可能根本没路由到这一页`);
  const wantHash = r.home ? r.module : r.module + "/" + r.child;
  if (normHash(hash) !== wantHash) bad.push(`${key}（${r.label}）地址没落到该页：location.hash=${hash}`);
  if (len < 40) bad.push(`${key}（${r.label}）渲染后仍然空白（${len} 字）`);
  if (/页面渲染失败/.test(canvas.textContent || "")) bad.push(`${key}（${r.label}）出现渲染失败占位`);

  // 指纹去重：两个不同的页面渲染出逐字相同的文本，几乎一定是路由或取数出了问题
  const text = (canvas.textContent || "").replace(/\s+/g, " ").trim();
  const prevRoute = contentByRoute.get(text);
  if (prevRoute) bad.push(`${key}（${r.label}）与 ${prevRoute} 渲染出完全相同的文本 —— 疑似没有独立取数`);
  else contentByRoute.set(text, key);

  for (const [why, re, allowRe] of BANNED) {
    for (const hh of locate(re, canvas, allowRe)) {
      const k = `${key}|${why}|${hh.where}|${hh.text}`;
      if (!seenLeaks.has(k)) { seenLeaks.add(k); bad.push(`${key}（${r.label}）${why} @ ${hh.where}：「${hh.text}」`); }
    }
  }
}
ok(`逐页渲染完成（${visited.length} 页）`, visited.length === routes.length, visited.length + "/" + routes.length);

if (!reportLeaks("逐页渲染问题")) {
  ok(`渲染后的可见文本全部面向用户（${visited.length} 页 × ${BANNED.length} 类禁用措辞）`, true);
}

/* ---------------- 5. 顶栏状态文案 ---------------- */
console.log("\n=== 5. 顶栏状态文案 ===");
const status = doc.getElementById("tbStatus");
ok("顶栏状态用词面向用户（不出现「后端」）",
  !!status && !/后端|服务端/.test(status.textContent),
  status && status.textContent.trim());

/* ---------------- 6. 浮层文案（实时动态抽屉 / 用户菜单） ----------------
 * 浮层挂在 document.body 上，不在 #canvas 里，所以第 4 节逐页扫描**扫不到它们**。
 * 而「实时动态」抽屉渲染的是事件流原始字段（e.scene）、用户菜单渲染的是原始角色枚举
 * （u.role → "admin"）—— 都是数据里长出来的措辞，静态源码里只看到变量名，一个字都扫不到。
 * 唯一能验的办法就是真把它点开。
 */
console.log("\n=== 6. 浮层文案（实时动态抽屉 / 用户菜单）===");
const sleep3 = (ms) => new Promise((r) => setTimeout(r, ms));

/** 浮层挂在 body 上（ui.js 的 drawer/modal/toast 都是 document.body.appendChild）；
 *  所以扫描根用 documentElement 而不是 #canvas，把浮层一并覆盖。 */
function scanOverlay(where) {
  for (const [why, re, allowRe] of BANNED) {
    for (const hh of locate(re, doc.documentElement, allowRe)) {
      // 去重键里**不含 where**：抽屉开着的时候扫用户菜单，会把抽屉里同一段文本再报一遍。
      const k = `浮层|${why}|${hh.where}|${hh.text}`;
      if (!seenLeaks.has(k)) { seenLeaks.add(k); bad.push(`${where}${why} @ ${hh.where}：「${hh.text}」`); }
    }
  }
}

const bell = doc.getElementById("tbBell");
ok("顶栏存在「实时动态」入口 #tbBell", !!bell);
if (bell) {
  bell.dispatchEvent(new W.MouseEvent("click", { bubbles: true }));
  await sleep3(1200);
  scanOverlay("实时动态浮层：");
  const ovText = Array.from(doc.querySelectorAll("#drawer, .drawer, .modal, .popover"))
    .map((e) => e.textContent).join(" ").replace(/\s+/g, " ").trim();
  ok("实时动态浮层已弹出并有内容", ovText.length > 0, ovText.slice(0, 70));
  if (!reportLeaks("实时动态浮层问题")) ok("实时动态浮层文案面向用户（无原始字段）", true);
} else bad.push("缺少 #tbBell，实时动态浮层文案无法验证");

const userBtn = doc.getElementById("tbUser");
ok("顶栏存在用户菜单入口 #tbUser", !!userBtn);
if (userBtn) {
  userBtn.dispatchEvent(new W.MouseEvent("click", { bubbles: true }));
  await sleep3(400);
  scanOverlay("用户菜单浮层：");
  if (!reportLeaks("用户菜单浮层问题")) ok("用户菜单浮层文案面向用户（角色不显示英文枚举）", true);
} else bad.push("缺少 #tbUser，用户菜单浮层文案无法验证");

/* ---------------- 7. 运行时异常 ---------------- */
console.log("\n=== 7. 运行时异常检查 ===");
const real = pageErrors.filter((e) => !/jsdomError/.test(e));
ok("全流程无 console.error", real.length === 0, real.slice(0, 2).join(" | ") || "无");

console.log("\n" + "=".repeat(62));
console.log(`通过 ${pass} 项 · 失败 ${fail} 项${fail ? "（详见上方）" : ""}`);

/* ---------------- 收尾 ----------------
 * app.js 里 `setInterval(loadTimebase, 60000)` 与通知 WebSocket 会一直吊住事件循环，
 * 进程**永远不会自然退出**。现象是：结果早就打完了，但外层 `timeout` 到点才把它杀掉 ——
 * 而 SIGTERM 会丢掉管道里还没 flush 的那一段输出，看起来就像「跑了却一个字都没打出来」。
 * （此前 `--all | grep` 只看到前两节，一度被误判成「第 3 节挂住」，真身就在这里。）
 * 所以显式收尾：先关掉 jsdom 窗口释放它的定时器，等 stdout 排空，再退出。
 */
try { W.close(); } catch (e) { /* 关不掉也不影响结论 */ }
process.exitCode = fail ? 1 : 0;
await new Promise((resolve) => {
  if (process.stdout.writableLength > 0) process.stdout.once("drain", resolve);
  else setImmediate(resolve);
});
process.exit(process.exitCode);

}  // ← 关闭「非 --all」分支
