"""桌面端「接线」验收脚本：校验 JS 与 HTML/CSS 之间的契约。

check_prototype.py 管的是「静态页面自身是否合规」；
本脚本管的是「接上真实数据后，JS 与 HTML/CSS 之间的约定是否还成立」。
这一层最容易静默断裂：选择器改名、图标拼错、类名漏定义，
都不会报错 —— 只是页面某块空白或退化成默认样式。

4 组检查
--------
1. 选择器契约  —— app.js 查询的每个锚点，必须真的存在于 desktop.html
2. 生成物契约  —— app.js 拼出来的 class 必须有 CSS 定义，data-icon 必须在引擎词汇表内
2b.员工档案契约 —— employees.js 的可选图标/主题色/工具名必须与引擎、CSS、后端注册表对齐
3. 脚本引用    —— 三个脚本的引用顺序、模块文件与其依赖是否存在
4. 会话键一致  —— login.html / console/api.js / 桌面端 必须共用同一个 token 键

用法：.venv/Scripts/python.exe scripts/check_wiring.py
"""
import os
import re
import sys

HTML = "static/desktop.html"
APP = "static/js/desktop/app.js"
DATA = "static/js/desktop/data.js"
EMP = "static/js/desktop/employees.js"
API = "static/js/console/api.js"
LOGIN = "static/login.html"
HIFI = "static/js/hifi.js"
BRIDGE = "static/js/hifi-bridge.js"
TOOL_REGISTRY = "ai/agents/tool_registry.py"
CSS = ["static/css/hifi.css", "static/css/employee-ui.css", "static/css/desktop.css"]

# 引擎运行时才加的类，源码里查不到定义属正常（与 check_prototype.py 保持一致）
RUNTIME_CLASSES = {"is-on", "is-active", "in", "open", "ripple", "tab-indicator",
                   "seg-thumb", "toast", "toast-wrap", "mask", "out", "has-error",
                   "spinner-center", "is-loading", "is-selected", "is-sorted",
                   "is-desc", "stage-page", "field-msg"}


def read(p):
    return open(p, encoding="utf-8").read() if os.path.exists(p) else ""


def main():
    fails = []
    html = read(HTML)
    app = read(APP)
    data = read(DATA)
    emp = read(EMP)
    api = read(API)
    login = read(LOGIN)
    css = "\n".join(read(f) for f in CSS)
    hifi_js = read(HIFI)
    registry = read(TOOL_REGISTRY)

    print("=" * 66)
    print("# 桌面端接线验收（JS ↔ HTML/CSS 契约）")
    print("=" * 66)

    for p in (HTML, APP, DATA, EMP, API, LOGIN, HIFI, BRIDGE, TOOL_REGISTRY, *CSS):
        if not os.path.exists(p):
            fails.append("文件缺失 " + p)
    if fails:
        print("\n".join("  ✗ " + f for f in fails))
        sys.exit(1)

    defined_css = set(re.findall(r"\.([a-zA-Z][a-zA-Z0-9_-]*)", css))
    known_icons = set(re.findall(r'"([a-z0-9-]+)":\s*\'',
                                 re.search(r"var ICONS = \{(.*?)\n  \};", hifi_js, re.S).group(1)))

    # app.js 自己生成的 HTML 里出现过的 id / 属性（这些锚点是动态的，不算缺失）
    js_literal_html = "\n".join(re.findall(r'"([^"\n]*<[^"\n]*)"', app) +
                                re.findall(r"'([^'\n]*<[^'\n]*)'", app))
    js_ids = set(re.findall(r'id="([^"]+)"', js_literal_html))
    js_attr_tokens = set()
    for a in re.findall(r'\[([a-z-]+)(?:="([^"]*)")?\]', app):
        tok = a[0] + ("=" + a[1] if a[1] else "")
        js_attr_tokens.add(tok)
    for m in re.findall(r'([a-z-]+)="([^"]+)"', js_literal_html):
        js_attr_tokens.add(m[0] + "=" + m[1])

    # ---------- 1. 选择器契约 ----------
    print("\n=== 1. 选择器契约（app.js 查询的锚点必须在 HTML 里）===")
    # 用反向引用匹配外层引号，这样 '[data-panel="load"]' 这种嵌套引号才能完整取出
    calls = [m.group(2) for m in
             re.finditer(r"(?:\$|querySelector|querySelectorAll)\(\s*([\"'])(.*?)\1", app, re.S)]
    calls = [c.strip() for c in calls if c.strip()]
    id_ok, attr_ok, cls_need = [], [], []
    for sel in sorted(set(calls)):
        for cid in re.findall(r"#([A-Za-z][\w-]*)", sel):
            id_ok.append((cid, sel))
        # 属性选择器 [k] / [k="v"]
        for k, v in re.findall(r"\[([a-z-]+)(?:=\"([^\"]*)\")?\]", sel):
            attr_ok.append((k + ("=" + v if v else ""), sel))
        # 纯类选择器部分
        for part in sel.split():
            p = re.sub(r":[\w-]+(\([^)]*\))?", "", part)
            if p.startswith("."):
                cls_need.append((p.lstrip("."), sel))

    bad_ids = []
    for cid, sel in id_ok:
        if ('id="%s"' % cid) not in html and cid not in js_ids:
            bad_ids.append("%s  ← %s" % (cid, sel))
    print("  ✗ 锚点 id 缺失: " + "; ".join(bad_ids) if bad_ids
          else "  ✓ %d 个 id 锚点全部存在（静态或由 app.js 生成）" % len({c for c, _ in id_ok}))
    fails.extend("选择器 id 缺失 " + b for b in bad_ids)

    bad_attr = []
    for tok, sel in attr_ok:
        k, _, v = tok.partition("=")
        if v:
            exists = ('%s="%s"' % (k, v)) in html or tok in js_attr_tokens
        else:
            exists = re.search(r"\b%s(?:=|\s|>)" % re.escape(k), html) is not None
        if not exists:
            bad_attr.append("%s  ← %s" % (tok, sel))
    print("  ✗ 属性锚点缺失: " + "; ".join(sorted(set(bad_attr))) if bad_attr
          else "  ✓ %d 个属性选择器全部有落点" % len({t for t, _ in attr_ok}))
    fails.extend("属性锚点缺失 " + b for b in sorted(set(bad_attr)))

    bad_cls = []
    for c, sel in cls_need:
        if c not in defined_css and c not in RUNTIME_CLASSES and ('class="%s"' % c) not in html \
                and not re.search(r'class="[^"]*\b%s\b' % re.escape(c), html):
            bad_cls.append("%s  ← %s" % (c, sel))
    print("  ✗ 类选择器无定义/无落点: " + "; ".join(sorted(set(bad_cls))) if bad_cls
          else "  ✓ %d 个类选择器全部可解析" % len({c for c, _ in cls_need}))
    fails.extend("类选择器问题 " + b for b in sorted(set(bad_cls)))

    # ---------- 2. 生成物契约 ----------
    print("\n=== 2. 生成物契约（app.js 拼出的 class / icon）===")
    gen_classes = set()
    for attr in re.findall(r'(?:class|className)\s*[=:]\s*"([^"]*)"', app):
        # 模板串拼接（class="emp-step ' + cls + '"）会带出 cls / sev 这类变量名，
        # 在第一个非类名字符处截断，只保留真正的字面类名。
        head = re.split(r"[^A-Za-z0-9_\- ]", attr)[0]
        for c in head.split():
            if re.match(r"^[a-z][a-z0-9-]*$", c):
                gen_classes.add(c)
    undef = sorted(gen_classes - defined_css - RUNTIME_CLASSES)
    print("  ✗ app.js 生成的类无 CSS 定义: " + ", ".join(undef) if undef
          else "  ✓ app.js 生成 %d 个类名，全部有 CSS 定义" % len(gen_classes))
    fails.extend("生成类无定义 " + u for u in undef)

    gen_icons = set(re.findall(r'data-icon="([a-z0-9-]+)"', app))
    gen_icons |= set(re.findall(r'icon:\s*"([a-z0-9-]+)"', app))
    for line in re.findall(r"const ico =[^\n]*", app):
        gen_icons |= set(re.findall(r'"([a-z0-9-]+)"', line))
    unk = sorted(gen_icons - known_icons)
    print("  ✗ app.js 生成的图标不在引擎词汇表: " + ", ".join(unk) if unk
          else "  ✓ app.js 生成 %d 个图标，全部可解析" % len(gen_icons))
    fails.extend("生成图标未知 " + u for u in unk)

    # app.js 生成 HTML 里的复合组件是否带齐子元素（与静态检查同口径）
    comp = []
    if re.search(r'class="progress-bar"', app) or re.search(r"class=\\?\"progress-bar", app):
        if "data-progress" not in app:
            comp.append("生成 .progress-bar 未带 data-progress")
    if re.search(r'class="si"', app) and 'class="sn"' not in app:
        comp.append("生成 .emp-step 缺 .sn")
    print("  ✓ 生成物复合组件结构完整" if not comp else "  ✗ " + "；".join(comp))
    fails.extend(comp)

    # ---------- 2b. 员工档案契约 ----------
    print("\n=== 2b. 员工档案契约（employees.js ↔ 引擎 / CSS / 后端注册表）===")
    # ① 可选图标必须在引擎词汇表内，否则下拉里选出来也渲染不出 svg
    icon_block = re.search(r"ICON_CHOICES\s*=\s*\[(.*?)\]", emp, re.S)
    emp_icons = set(re.findall(r'"([a-z0-9-]+)"', icon_block.group(1))) if icon_block else set()
    bad_icons = sorted(emp_icons - known_icons)
    print("  ✗ employees.js 可选图标不在引擎词汇表: " + ", ".join(bad_icons) if bad_icons
          else "  ✓ %d 个可选图标全部在引擎词汇表内" % len(emp_icons))
    fails.extend("员工可选图标未知 " + b for b in bad_icons)

    # ② 默认档案用到的图标也必须在可选集与引擎词汇表内
    default_icons = set(re.findall(r'icon:\s*"([a-z0-9-]+)"', emp))
    bad_default_icons = sorted(default_icons - emp_icons - known_icons)
    if bad_default_icons:
        print("  ✗ 默认档案图标不在可选集/引擎词汇表:", ", ".join(bad_default_icons))
        fails.extend("默认档案图标未知 " + b for b in bad_default_icons)
    else:
        print("  ✓ 默认档案图标 %d 个，均在可选集内" % len(default_icons))

    # ③ 可选主题色必须在 CSS 里有 .emp-aN 定义（空值=默认品牌蓝，跳过）
    tint_block = re.search(r"TINT_CHOICES\s*=\s*\[(.*?)\]", emp, re.S)
    tints = [t for t in re.findall(r'value:\s*"([^"]*)"', tint_block.group(1))] if tint_block else []
    named_tints = [t for t in tints if t]
    bad_tints = [t for t in named_tints if t not in defined_css]
    print("  ✗ 主题色无 CSS 定义: " + ", ".join(bad_tints) if bad_tints
          else "  ✓ %d 个具名主题色均有 .emp-aN 样式" % len(named_tints))
    fails.extend("主题色无定义 " + b for b in bad_tints)

    # ④ 工具标签键必须与后端注册表的工具名完全一致（多了会显示幽灵工具，少了会退化成英文名）
    label_block = re.search(r"TOOL_LABELS\s*=\s*\{(.*?)\n\};", emp, re.S)
    label_keys = set(re.findall(r"^\s*(\w+):", label_block.group(1), re.M)) if label_block else set()
    reg_tools = set(re.findall(r'"(\w+)":\s*ToolDefinition\(', registry))
    only_js = sorted(label_keys - reg_tools)
    only_py = sorted(reg_tools - label_keys)
    if only_js or only_py:
        if only_js:
            print("  ✗ TOOL_LABELS 含后端不存在的中文标签:", ", ".join(only_js))
            fails.extend("工具标签多余 " + x for x in only_js)
        if only_py:
            print("  ✗ 后端工具缺中文标签（前端会显示英文名）:", ", ".join(only_py))
            fails.extend("工具标签缺失 " + x for x in only_py)
    else:
        print("  ✓ 工具标签 %d 个，与后端注册表一一对应" % len(label_keys))

    # ⑤ 档案里引用的工具名必须都在后端注册表内
    seeded_tools = set(re.findall(r'"([a-z_]+)"', " ".join(
        re.findall(r"tools:\s*\[(.*?)\]", emp, re.S))))
    stale = sorted(seeded_tools - reg_tools)
    print("  ✗ 默认档案引用了不存在的工具: " + ", ".join(stale) if stale
          else "  ✓ 默认档案引用的 %d 个工具均在后端注册表内" % len(seeded_tools & reg_tools))
    fails.extend("档案工具不存在 " + s for s in stale)

    # ---------- 3. 脚本引用契约 ----------
    print("\n=== 3. 脚本引用契约 ===")
    order = re.findall(r'<script[^>]*src="([^"]+)"', html)
    print("  引用顺序:", " → ".join(order))
    required = ["/static/js/hifi.js", "/static/js/hifi-bridge.js", "/static/js/desktop/app.js"]
    miss = [r for r in required if r not in order]
    if miss:
        print("  ✗ 缺少脚本引用:", ", ".join(miss))
        fails.extend("缺少脚本 " + m for m in miss)
    else:
        idx = [order.index(r) for r in required]
        if idx != sorted(idx):
            print("  ✗ 引用顺序错误：hifi.js → hifi-bridge.js → app.js 必须依次加载")
            fails.append("脚本引用顺序错误")
        else:
            print("  ✓ 引擎 → 补丁 → 业务，顺序正确")
    if 'type="module"' not in html.split("/static/js/desktop/app.js")[0].split("<script")[-1]:
        print("  ✗ app.js 未以 type=\"module\" 引入（import 会失败）")
        fails.append("app.js 未用 module 引入")
    else:
        print("  ✓ app.js 以 ES module 引入")

    dep = re.findall(r'from\s+"(\.\.?/[^"]+)"', app) + re.findall(r'from\s+"(\.\.?/[^"]+)"', data)
    print("  模块依赖:", ", ".join(sorted(set(dep))))
    print("  ✓ data.js 复用 console/api.js（含信封解包与 401 处理）"
          if "../console/api.js" in data else "  ✗ data.js 未复用 console/api.js")
    if "../console/api.js" not in data:
        fails.append("data.js 未复用 api.js")

    # app.js 必须把员工档案抽成独立模块引入（员工可编辑后，档案不再是 app.js 内的常量）
    if re.search(r'from\s+"\./employees\.js"', app):
        print("  ✓ app.js 从 ./employees.js 引入员工档案模块")
    else:
        print("  ✗ app.js 未引入 ./employees.js（员工档案不可编辑将无法生效）")
        fails.append("app.js 未引入 employees.js")

    # ---------- 4. 会话键一致性 ----------
    print("\n=== 4. 会话键一致性 ===")
    api_key = re.search(r'TOKEN_KEY\s*=\s*"([^"]+)"', api)
    api_key = api_key.group(1) if api_key else None
    # login.html 必须走 api.js 的会话封装（login() → session.save()），
    # 而不许自己拼一个 localStorage 键 —— 那才是真正的「键不一致」来源。
    login_imports_api = "/static/js/console/api.js" in login
    login_defines_key = re.search(r"TOKEN_KEY\s*=", login) is not None
    login_pref_keys = sorted(set(re.findall(r'"(ea\.[\w.]+)"', login)))
    data_uses = set(re.findall(r'"(ea\.[\w.]+)"', data))

    print("  console/api.js TOKEN_KEY =", api_key)
    print("  login.html 引用 api.js    =", login_imports_api)
    print("  login.html 自有的偏好键    =", login_pref_keys or "（无）",
          "（ea.remember 是「记住我」勾选项，非令牌）")
    print("  桌面端数据层直接使用键      =", sorted(data_uses) or "（无，全部走 api.js）")

    if not api_key:
        fails.append("api.js 未定义 TOKEN_KEY")
    if not login_imports_api:
        fails.append("login.html 未引用 console/api.js")
        print("  ✗ 登录页未走统一会话封装")
    elif login_defines_key:
        fails.append("login.html 自行定义了 TOKEN_KEY")
        print("  ✗ 登录页自建令牌键 → 与数据层可能不一致")
    else:
        print("  ✓ 登录页与数据层共用 api.js 的会话封装，登录态可通")
    if data_uses:
        print("  ✗ 数据层绕过了 api.js 的会话封装:", sorted(data_uses))
        fails.append("数据层绕过会话封装")
    else:
        print("  ✓ 数据层的令牌读写全部经 api.js，无旁路")

    # ---------- 汇总 ----------
    print("\n" + "=" * 66)
    if fails:
        print("✗ 未通过，共 %d 项问题：" % len(fails))
        for f in fails:
            print("   -", f)
        sys.exit(1)
    print("✓ 接线契约全部通过")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
