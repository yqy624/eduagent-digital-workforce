"""数字员工协作台 · 前端页面自动验收脚本

对每个页面目标跑 5 组检查：
  1. 结构      —— 标签闭合、页面清单、路由落点、弹层引用
  2. 硬约束    —— 零外链、只用令牌、无业务 JS
  3. 资源解析  —— 图标名是否在引擎词汇表内、类名是否有定义
                 （图标名拼错会静默退化成 info 图标，不报错但语义错误）
  4. 组件结构  —— .switch/.check/.progress-bar/.field-msg/tabs 子元素是否齐备
                 （缺子元素会静默不可见，不报错但视觉崩坏）
  5. 边界态    —— 每页至少一种空/骨架/校验/禁用/告警态
  6. 面向用户  —— 可见文本里不得出现接口路径、工具名、版本号、运行编号、
                 状态枚举、存储键、内部模块名与工程黑话

用法：.venv/Scripts/python.exe scripts/check_prototype.py
"""
import glob
import os
import re
import sys
from html.parser import HTMLParser

JS = "static/js/hifi.js"

# 每个目标 = 一份 HTML + 它实际引用的样式表清单（顺序即层叠顺序）
TARGETS = [
    {
        "name": "数字员工协作台 · employee-workspace.html（舞台壳 + 11 页）",
        "html": "static/employee-workspace.html",
        "css": ["static/css/hifi.css",
                "static/css/employee-ui.css",
                "static/css/employee-page.css"],
    },
    {
        "name": "桌面端 · desktop.html（应用外壳 + 4 页）",
        "html": "static/desktop.html",
        "css": ["static/css/hifi.css",
                "static/css/employee-ui.css",
                "static/css/desktop.css"],
    },
]

VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link",
        "meta", "param", "source", "track", "wbr"}

# 由引擎运行时才加上的类，源码里查不到定义是正常的
RUNTIME_CLASSES = {"is-on", "is-active", "in", "open", "ripple", "tab-indicator",
                   "seg-thumb", "toast", "toast-wrap", "mask", "out", "has-error",
                   "spinner-center", "is-loading", "is-selected", "is-sorted",
                   "is-desc", "stage-page", "field-msg"}

# 边界态关键词（出现在某页片段内即算覆盖）
BOUNDARY_KEYS = ("empty", "skeleton", "has-error", "alert-danger", "alert-warning",
                 "spinner", "disabled")

# 「面向用户」禁用词表：出现在**可见文本**里即判失败。
# 只扫文本、不扫属性 —— 类名 / data-* / id 里的英文是机器标识符，允许存在。
# 判据是「用户看不看得懂」，不是「有没有英文」：
#   · 接口路径、工具名、版本号、运行编号 → 只有实现者看得懂
#   · 技能包 / 数据域 / 运行时 / 落库    → 研发黑话，用户不知道自己能做什么
ADMIN_SPEAK = [
    (r"localStorage", "存储实现泄漏"),
    (r"/api/", "接口路径泄漏"),
    (r"\b(?:get|retrieve|analyze|generate|publish|submit|send)_[a-z_]+\b", "内部工具名"),
    (r"\b[a-z][a-z0-9-]*\.(?:rag|chain|yolo|profile|rules|retrieve|overview|guard|infer"
     r"|bind|emit|match|memory|build|analyze|rule|dispatch|suggest)\b", "内部模块名"),
    (r"\bv\d+\.\d+\.\d+\b", "版本号"),
    (r"\brun-\d", "运行编号"),
    (r"smart_education|governance|agent_runtime|OLLAMA|API Key|placeholder", "内部标识"),
    (r"技能包|数据域|写策略|失败降级|降级隔离|契约|校验点|单点回溯|调用函数", "工程术语"),
    (r"运行时|受控运行时|人工 Gate|\bGate\b|工具调用|工具清单|岗位工具|登录角色|角色权限",
     "工程术语"),
    (r"向量库|向量检索|embedding", "工程术语"),
    (r"try/except|落库|静默降级|会签|阈值|置信度|事件总线|工单派发|流水线接力", "工程术语"),
    (r"平台边界|平台治理|平台底座|设计取舍|技术选型", "架构自述"),
    (r"规划中，尚未实现", "占位导航"),
    # —— 第二轮补全：上一轮词表偏窄，「事件流 / 占位实现 / 模型层 / 注册表 / 控制台」
    #    这类中台自述实际仍存活在用户可见文案里，属于漏检。判据不变：用户看不看得懂。
    (r"中台|控制台|后端|服务端", "实现视角"),
    (r"占位|真实模型|模型接入|不作为结论|链路连通|熔断", "实现自述"),
    (r"事件流|能力清单|视觉实现|模型层|注册表|权重路径|资产台账", "中台视角"),
    (r"YOLO|classroom|conf\s*[≥>]", "模型架构名"),
    (r"seed_demo|\.py\b|\.mjs\b|\.ps1\b", "开发脚本引用"),
    # —— 第三轮补全：从「枚举术语」升级到「识别形态」。
    #    逐个往词表里加词永远追不上新出现的叫法，但有两类形态是**结构性**的泄漏：
    #    ① camelCase / snake_case 标识符 —— 被人写进界面文案的字段名；
    #    ② 「以表名 / 字段名当提示词」的输入框 —— 让用户去填 courses 表中的 id。
    #    邮箱里的下划线要放行，否则用户管理表里的地址会被误判。
    (r"\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b", "接口字段名"),
    (r"(?<![@\w])[a-z][a-z0-9]*_[a-z0-9_]+(?![@\w])", "接口字段名"),
    (r"表中的\s*id|assignment_id|submission_id|file_id|data/samples", "数据库 / 部署路径"),
    (r"audit_logs|placeholder", "内部标识"),
]


def visible_text(html):
    """剥掉注释、脚本、样式与所有标签，只留用户真正看得到的字。"""
    h = re.sub(r"<!--.*?-->", " ", html, flags=re.S)
    h = re.sub(r"<(script|style)\b[^>]*>.*?</\1>", " ", h, flags=re.S | re.I)
    h = re.sub(r"<[^>]+>", " ", h)
    return re.sub(r"\s+", " ", h)


class Structure(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.stack, self.errors, self.pages, self.ids = [], [], [], []
        self.gotos, self.opened = set(), set()

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if "id" in a:
            self.ids.append(a["id"])
        if tag == "section" and a.get("class", "").startswith("page"):
            self.pages.append((a.get("id"), a.get("data-pid"), a.get("data-title")))
        if a.get("data-goto"):
            self.gotos.add(a["data-goto"])
        for key in ("data-modal-open", "data-drawer-open", "data-sheet-open", "data-menu-open"):
            if a.get(key):
                self.opened.add(a[key].lstrip("#"))
        if tag not in VOID:
            self.stack.append((tag, self.getpos()))

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        if not self.stack:
            self.errors.append(f"多余的结束标签 </{tag}> @行{self.getpos()[0]}")
            return
        if self.stack[-1][0] == tag:
            self.stack.pop()
        elif any(t == tag for t, _ in self.stack):
            while self.stack and self.stack[-1][0] != tag:
                bad, pos = self.stack.pop()
                self.errors.append(f"未闭合 <{bad}> @行{pos[0]}（被 </{tag}> 隐式关闭）")
            if self.stack:
                self.stack.pop()
        else:
            self.errors.append(f"意外结束标签 </{tag}> @行{self.getpos()[0]}")


def check(target, js, fails):
    html = open(target["html"], encoding="utf-8").read()
    css = "\n".join(open(f, encoding="utf-8").read() for f in target["css"])

    print(f"\n{'#' * 62}\n# {target['name']}\n{'#' * 62}")

    # ---------- 1. 结构 ----------
    print("\n=== 1. 结构完整性 ===")
    s = Structure()
    s.feed(html)
    for e in s.errors:
        fails.append(f"{target['html']}: {e}")
        print("  ✗", e)
    unclosed = [f"<{t}> @行{p[0]}" for t, p in s.stack if t != "html"]
    if unclosed:
        fails.extend(f"{target['html']}: 未闭合 {x}" for x in unclosed)
        print("  ✗ 未闭合:", ", ".join(unclosed))
    if not s.errors and not unclosed:
        print("  ✓ 标签全部闭合")

    seen = {p[0] for p in s.pages}
    print(f"  ✓ 页面 {len(s.pages)} 个: " + " ".join(p[1] or "?" for p in s.pages))
    bad_goto = sorted(g for g in s.gotos if g not in seen)
    print("  ✗ 路由落点缺失: " + ", ".join(bad_goto) if bad_goto else "  ✓ 路由全部有落点")
    fails.extend(f"{target['html']}: 路由缺失 {g}" for g in bad_goto)

    missing_ov = sorted(o for o in s.opened if o not in s.ids)
    print("  ✗ 弹层未定义: " + ", ".join(missing_ov) if missing_ov
          else f"  ✓ 弹层引用 {len(s.opened)} 个，全部有定义")
    fails.extend(f"{target['html']}: 弹层未定义 {o}" for o in missing_ov)

    # ---------- 2. 硬约束 ----------
    print("\n=== 2. 硬约束 ===")
    ext = re.findall(r'(?:src|href)\s*=\s*"(?:https?:)?//[^"]+"', html)
    print("  ✗ 存在外链资源" if ext else "  ✓ 零外链（无 CDN / 网络字体 / 外链图片）")
    fails.extend(f"{target['html']}: 外链 {e}" for e in ext)
    print("  ✓ 本地资源:", re.findall(r'(?:src|href)\s*=\s*"(/[^"]+)"', html))

    hard = re.findall(r'\bstyle="[^"]*?(#[0-9a-fA-F]{3,8})', html)
    print("  ✓ 内联样式无硬编码色值" if not hard else f"  ✗ 内联色值 {sorted(set(hard))}")
    fails.extend(f"{target['html']}: 内联色值 {h}" for h in set(hard))

    inline_js = re.findall(r"<script(?![^>]*\bsrc=)", html)
    print(f"  {'✓' if not inline_js else '✗'} 无内联业务 JS（内联 script 数 {len(inline_js)}）")
    if inline_js:
        fails.append(f"{target['html']}: 存在内联业务 JS")

    # ---------- 3. 资源解析 ----------
    print("\n=== 3. 图标与类名解析 ===")
    known_icons = set(re.findall(r'"([a-z0-9-]+)":\s*\'',
                                 re.search(r"var ICONS = \{(.*?)\n  \};", js, re.S).group(1)))
    used_icons = set(re.findall(r'data-icon="([^"]+)"', html))
    unknown = sorted(used_icons - known_icons)
    print("  ✗ 图标无法解析（会退化成 info）: " + ", ".join(unknown) if unknown
          else f"  ✓ 使用 {len(used_icons)} 个图标，全部可解析（引擎共 {len(known_icons)} 个）")
    fails.extend(f"{target['html']}: 未知图标 {u}" for u in unknown)

    defined = set(re.findall(r"\.([a-zA-Z][a-zA-Z0-9_-]*)", css))
    used = {c for attr in re.findall(r'class="([^"]+)"', html) for c in attr.split()}
    undefined = sorted(used - defined - RUNTIME_CLASSES)
    print("  ✗ 类名无定义: " + ", ".join(undefined) if undefined
          else f"  ✓ 使用 {len(used)} 个类名，全部有定义")
    fails.extend(f"{target['html']}: 未定义类名 {u}" for u in undefined)

    # ---------- 4. 复合组件结构 ----------
    print("\n=== 4. 复合组件结构 ===")
    issues = []

    switches = re.findall(r'<label class="switch[^"]*">(.*?)</label>', html, re.S)
    if [x for x in switches if 'class="track"' not in x or 'class="thumb"' not in x]:
        issues.append(f".switch 缺 track/thumb → 开关完全不可见")

    checks_ = re.findall(r'<label class="check[^"]*">(.*?)</label>', html, re.S)
    if [x for x in checks_ if 'class="box"' not in x]:
        issues.append(".check 缺 .box → 勾选框完全不可见")

    bars = re.findall(r'<span class="progress-bar"[^>]*>', html)
    n_ok = len([b for b in bars if "data-progress" in b])
    if n_ok != len(bars):
        issues.append(f".progress-bar 缺 data-progress × {len(bars) - n_ok} → 永远停在 0")

    # 含受校验控件的 .field 必须预留 .field-msg（否则 setErr 找不到落点，退化为 Toast）
    fields = re.findall(r'<div class="field"[^>]*>(.*?)(?=<div class="field"[^>]*>|</form>)',
                        html, re.S)
    n_bad = len([f for f in fields
                 if re.search(r"data-required|data-min|data-msg", f) and "field-msg" not in f])
    if n_bad:
        issues.append(f"受校验 .field 缺 .field-msg × {n_bad} → 校验错误退化为 Toast")

    for i, box in enumerate(re.findall(r"<div[^>]*data-tabs[^>]*>(.*?)(?=<section)", html, re.S), 1):
        nt = len(re.findall(r'class="tab[" ]', box))
        np_ = len(re.findall(r'class="tab-panel[" ]', box))
        if nt != np_ or not nt:
            issues.append(f"第 {i} 个 tab 容器 tab({nt})/panel({np_}) 数量不匹配")
        if len(re.findall(r'class="tab is-on"', box)) != 1:
            issues.append(f"第 {i} 个 tab 容器默认高亮不唯一")

    print(f"  .switch {len(switches)} · .check {len(checks_)} · .progress-bar {n_ok}/{len(bars)}")
    print("  ✓ 结构完整" if not issues else "  ✗ " + "；".join(issues))
    fails.extend(f"{target['html']}: {i}" for i in issues)

    # ---------- 5. 边界态覆盖 ----------
    print("\n=== 5. 每页边界态覆盖 ===")
    for pid, _, _ in s.pages:
        seg = html.split(f'id="{pid}"', 1)[-1].split("<section", 1)[0]
        marks = [k for k in BOUNDARY_KEYS if k in seg]
        if not marks:
            fails.append(f"{target['html']}: {pid} 缺边界态")
        print(f"  {pid:5} {'✓ ' + ', '.join(marks) if marks else '✗ 无'}")

    # ---------- 6. 文案面向用户 ----------
    print("\n=== 6. 文案面向用户（禁用管理员 / 实现措辞）===")
    text = visible_text(html)
    hits = []
    for pat, why in ADMIN_SPEAK:
        for m in re.finditer(pat, text):
            s, e = max(0, m.start() - 22), min(len(text), m.end() + 22)
            hits.append(f"{why}：「…{text[s:e].strip()}…」")
    if hits:
        for x in hits:
            print("  ✗", x)
        fails.extend(f"{target['html']}: {x}" for x in hits)
    else:
        print("  ✓ 可见文本无管理员 / 实现措辞")


# ---------------------------------------------------------------- JS 渲染层

# 会被渲染给用户的键名。只有这些键后面的字面量算「用户可见」——
# 例如 docPath / path / endpoint 里的接口路径是给程序用的，原样保留不算泄漏。
RENDER_KEYS = (
    "title", "label", "desc", "body", "sub", "note", "hint", "text", "unit",
    "placeholder", "question", "okText", "skipText", "altText", "loadingText",
    "emptyTitle", "emptyDesc", "objectTitle", "formTitle", "resultTitle",
    "resultSub", "buttonText", "tooltip", "header", "t", "name",
)

JS_TARGETS = [
    "static/js/menu.config.js",
    "static/js/console/app.js",
    "static/js/console/shell.js",
    "static/js/console/ui.js",
    "static/js/console/registry.js",
    "static/js/console/dom.js",
    "static/js/console/icons.js",
] + sorted(glob.glob("static/js/console/pages/*.js")) \
  + sorted(glob.glob("static/js/desktop/*.js"))

KEY_RE = re.compile(
    r"\b(" + "|".join(RENDER_KEYS) + r")\s*:\s*((?:\"[^\"]*\"|'[^']*'|\s|\+)*)"
)
LIT_RE = re.compile(r"\"([^\"]*)\"|'([^']*)'")
TAG_TEXT_RE = re.compile(r">([^<>]+)<")
CJK_RE = re.compile(r"[\u4e00-\u9fff]")


def strip_template_exprs(src):
    """把模板字符串里的 `${…}` 换成空格。

    这里不能用正则。`${raw(plate({ title: "明细", body: emptyState({ … }) }))}`
    这种嵌套三层大括号的写法，`[^{}]` 一类的表达式根本匹配不到 —— 表达式会整段留在
    「可见文本」里，于是 `objectTitle` / `plannedPanel` 这些**代码**被当成文案误报。
    改成逐字符扫描：读到 `${` 就按大括号配平找结尾，同时跳过字符串字面量，
    保证嵌套层数与引号里的花括号都不出错。
    """
    out, i, n = [], 0, len(src)
    while i < n:
        if src[i] == "$" and i + 1 < n and src[i + 1] == "{":
            depth, j = 1, i + 2
            while j < n and depth:
                c = src[j]
                if c in "\"'`":
                    q, k = c, j + 1
                    while k < n:
                        if src[k] == "\\":
                            k += 2
                            continue
                        if src[k] == q:
                            break
                        k += 1
                    j = k + 1
                    continue
                if c == "{":
                    depth += 1
                elif c == "}":
                    depth -= 1
                j += 1
            out.append(" ")
            i = j
            continue
        out.append(src[i])
        i += 1
    return "".join(out)


def strip_js_comments(src):
    """剥掉 JS 注释，但**必须跳过字符串**。

    用正则直接删 `//…` 会把 `'<svg xmlns="http://www.w3.org/2000/svg"…'` 里的 `//`
    当成行注释，字符串被从中切断 —— 后面所有抽取都跟着错位（icons.js 就有这种行）。
    这里改成逐字符扫描：进字符串就整段搬走；注释按原字符数留白，行号仍与源文件对齐。
    """
    out, i, n = [], 0, len(src)
    while i < n:
        c = src[i]
        if c in "\"'`":
            q, j = c, i + 1
            while j < n:
                if src[j] == "\\":
                    j += 2
                    continue
                if src[j] == q:
                    break
                j += 1
            out.append(src[i:j + 1])
            i = j + 1
            continue
        if c == "/" and src[i:i + 2] == "//":
            j = src.find("\n", i)
            j = n if j < 0 else j
            out.append(" " * (j - i))
            i = j
            continue
        if c == "/" and src[i:i + 2] == "/*":
            j = src.find("*/", i + 2)
            j = n if j < 0 else j + 2
            out.append("".join(ch if ch == "\n" else " " for ch in src[i:j]))
            i = j
            continue
        out.append(c)
        i += 1
    return "".join(out)


def js_visible_strings(src):
    """抽出「会被渲染给用户」的字面量。

    两条来源，其余一律不算（避免把接口路径、字段名误判成文案）：
      1. 渲染键后面的字面量          —— label: "…" / title: "…"
      2. 模板字符串里标签之间的文本  —— `…<div>上传文件</div>…`（先剥掉 ${…}）

    注意来源 ① **不做语言过滤**：它出现在渲染键后面，本身就已经是展示文案了。
    而最危险的一类泄漏（`sub: "GET /api/vision/events"` 这种接口路径、`classroom`
    这类枚举）恰恰全是 ASCII —— 按「含中文」过滤会把它们整整齐齐地漏掉。
    来源 ② 同理也不再过滤：`<span>POST /api/…</span>` 同样是纯 ASCII 的正文泄漏。
    """
    src = strip_js_comments(src)
    out = []
    # ① 渲染键后面的字面量：不做语言过滤（理由见 docstring）
    for m in KEY_RE.finditer(src):
        for lm in LIT_RE.finditer(m.group(2)):
            out.append(lm.group(1) if lm.group(1) is not None else lm.group(2))
    # ② 模板字符串里标签之间的文本。
    #    过去这里按「含中文」过滤，理由是「会混进代码片段」—— 但那把最直白的一类泄漏
    #    整整齐齐地漏掉了：`<span class="t-xs dim">POST /api/review/submissions/scan</span>`
    #    是纯 ASCII，一个汉字都没有，于是从来没被抽出来过（检查器的第三个缺口）。
    #    现在不再按语言过滤：抽取交给这里，**判据交给 ADMIN_SPEAK**。
    for tm in re.finditer(r"`(?:[^`\\]|\\.)*`", src, flags=re.S):
        body = strip_template_exprs(tm.group(0))
        for cm in TAG_TEXT_RE.finditer(body):
            out.append(cm.group(1))
    return [s.strip() for s in out if s.strip()]


def check_js_copy(fails):
    print("\n" + "#" * 62)
    print("# JS 渲染层 · 用户可见文案")
    print("#" * 62)
    print("\n=== 7. 文案面向用户（禁用管理员 / 实现措辞）===")
    missing = [f for f in JS_TARGETS if not os.path.exists(f)]
    if missing:
        print("  ✗ 目标文件不存在:", ", ".join(missing))
        fails.extend(f"JS 文案检查: 目标文件不存在 {f}" for f in missing)
        return
    hits = []
    for f in JS_TARGETS:
        for s in js_visible_strings(open(f, encoding="utf-8").read()):
            for pat, why in ADMIN_SPEAK:
                if re.search(pat, s):
                    hits.append(f"{f}: {why}：「{s[:70]}」")
                    break
    if hits:
        for x in hits[:40]:
            print("  ✗", x)
        if len(hits) > 40:
            print(f"  … 另有 {len(hits) - 40} 条")
        fails.extend(f"JS 文案: {x}" for x in hits)
    else:
        print(f"  ✓ {len(JS_TARGETS)} 个 JS 模块的用户可见文案均无管理员 / 实现措辞")


# ---------------------------------------------------------------- 入口页与外壳

# 这两屏不是「原型页」：没有多页 / 路由 / 边界态，走不了 check() 的全套结构检查。
# 但它们是**用户最先看到的两屏**（登录 → 平台外壳），文案同样受硬约束；
# 且 login.html 的注册 / 找回密码弹窗由内联模块脚本渲染，必须连脚本一起扫。
ENTRY_TARGETS = ["static/login.html", "static/platform.html"]
INLINE_SCRIPT_RE = re.compile(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", flags=re.S)


def check_entry_copy(fails):
    print("\n" + "#" * 62)
    print("# 入口页与外壳（登录 / 平台外壳）· 用户可见文案")
    print("#" * 62)
    print("\n=== 8. 文案面向用户（禁用管理员 / 实现措辞）===")
    hits = []
    for f in ENTRY_TARGETS:
        if not os.path.exists(f):
            print("  ✗ 文件不存在:", f)
            fails.append(f"入口页检查: 文件不存在 {f}")
            continue
        src = open(f, encoding="utf-8").read()
        chunks = [visible_text(src)]
        for m in INLINE_SCRIPT_RE.finditer(src):
            chunks += js_visible_strings(m.group(1))
        for ch in chunks:
            for pat, why in ADMIN_SPEAK:
                if re.search(pat, ch):
                    hits.append(f"{f}: {why}：「{ch[:70]}」")
                    break
    if hits:
        for x in hits[:40]:
            print("  ✗", x)
        fails.extend(f"入口页文案: {x}" for x in hits)
    else:
        print(f"  ✓ {len(ENTRY_TARGETS)} 个入口页（含内联脚本）文案均无管理员 / 实现措辞")


# ---------------------------------------------------------------- 接口路径不得当内容

# 接口路径只有两个合法去处：① 作为 api.<method>(…) 的实参；② path / docPath 这类
# **只给程序用**的配置字段。一旦它直接成为数组的元素（例如被 .map 渲染成一张对照表），
# 就会变成用户读得到的文字 —— 上一轮正是靠这个漏洞把「数据来源状态表」放了过去。
def endpoints_in_arrays(src):
    """标出「直接作为数组元素」的接口路径。

    要区分两种逗号：数组元素之间（会被 .map 渲染成内容）与函数实参之间（请求调用）。
    所以按括号类型压栈 —— 读到字符串时若栈顶是 `[`，它就是被列成数据的路径；
    栈顶是 `(`（实参）或 `{`（配置字段的值）都算合法去处。
    """
    out, stack, i, n = [], [], 0, len(src)
    while i < n:
        c = src[i]
        if c in "\"'`":
            q, j = c, i + 1
            while j < n:
                if src[j] == "\\":
                    j += 2
                    continue
                if src[j] == q:
                    break
                j += 1
            lit = src[i + 1:j]
            if q != "`" and lit.startswith("/api/") and stack and stack[-1] == "[":
                out.append((src[:i].count("\n") + 1, lit))
            i = j + 1
            continue
        if c in "([{":
            stack.append(c)
        elif c in ")]}":
            if stack:
                stack.pop()
        i += 1
    return out


def check_endpoint_not_rendered(fails):
    print("\n=== 9. 接口路径没有被当成内容渲染 ===")
    hits = []
    for f in JS_TARGETS:
        if not os.path.exists(f):
            continue
        for line, lit in endpoints_in_arrays(strip_js_comments(open(f, encoding="utf-8").read())):
            hits.append(f"{f}:{line} 「{lit}」")
    if hits:
        for x in hits[:20]:
            print("  ✗ 路径被列成数组元素（会被渲染）:", x)
        fails.extend(f"接口路径当内容: {x}" for x in hits)
    else:
        print("  ✓ 接口路径只出现在请求调用与程序用字段里（没有作为数组元素被渲染）")


def main():
    js = open(JS, encoding="utf-8").read()
    fails = []
    for t in TARGETS:
        check(t, js, fails)

    check_js_copy(fails)
    check_entry_copy(fails)
    check_endpoint_not_rendered(fails)

    print("\n" + "=" * 62)
    if fails:
        print(f"✗ 未通过，共 {len(fails)} 项问题")
        sys.exit(1)
    print(f"✓ 全部通过（{len(TARGETS)} 个页面目标 + {len(ENTRY_TARGETS)} 个入口页 + "
          f"{len(JS_TARGETS)} 个 JS 模块）")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
