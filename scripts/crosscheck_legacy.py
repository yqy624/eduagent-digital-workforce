#!/usr/bin/env python
"""交叉比对：菜单里声明的 legacy 接口 × 路由审计结论。

menu.config.js 的每个能力卡都写了 `endpoint:`（新控制台用的）与 `legacy:`（旧接口），
等于项目自己维护了一份"待废弃清单"。本脚本把它和 audit_routes.py 的结果对齐，
标注每条 legacy 接口当前是否还有真实调用方。
"""
import json
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
LEGACY_PAGES = {"static/admin/dashboard.html",
                "static/teacher/dashboard.html",
                "static/student/dashboard.html"}


def norm(u: str) -> str:
    u = u.split("?")[0]
    u = re.sub(r"\{[^}]*\}", "{p}", u)
    return u.rstrip("/")


def to_re(p: str) -> re.Pattern:
    return re.compile("^" + re.escape(norm(p)).replace(re.escape("{p}"), r"[^/]+") + "$")


def main():
    data = json.load(open(os.path.join(ROOT, "scripts/_route_audit.json"), encoding="utf-8"))
    routes = data["routes"]

    text = open(os.path.join(ROOT, "static/js/menu.config.js"), encoding="utf-8").read()
    legacy = set()
    for m in re.finditer(r'legacy:\s*"([^"]*)"', text):
        for p in re.findall(r"/api/[a-z0-9/{}\._\-]*", m.group(1)):
            legacy.add(norm(p))

    buckets = {"零调用": [], "仅旧页面": [], "仍有新控制台调用": [], "未匹配": []}
    for lp in sorted(legacy):
        rx = to_re(lp)
        hit = [r for r in routes if rx.match(norm(r["path"]))]
        if not hit:
            buckets["未匹配"].append((lp, None))
            continue
        r = hit[0]
        files = {f.split(":")[0] for f in r["calls"].get("frontend", [])}
        if not r["live"]:
            buckets["零调用"].append((lp, r))
        elif files <= LEGACY_PAGES:
            buckets["仅旧页面"].append((lp, r))
        else:
            buckets["仍有新控制台调用"].append((lp, r))

    print(f"菜单 legacy 声明去重后：{len(legacy)} 条\n")
    for name, items in buckets.items():
        print(f"### {name}（{len(items)}）")
        for lp, r in items:
            loc = f"{r['file']}:{r['line']}" if r else "-"
            print(f"    {lp:56} {loc}")
        print()


if __name__ == "__main__":
    main()
