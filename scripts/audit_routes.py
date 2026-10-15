#!/usr/bin/env python
"""路由审计：把「后端已注册路由」与「真实调用方」交叉比对，输出 Markdown 报告。

只读脚本，不修改业务代码。

为什么不能只做字符串精确匹配：
    前端大量使用 `api.get("/api/teacher/assignments/" + id + "/submissions")`
    这类拼接写法，静态扫描拿不到完整路径。因此本脚本采用两级口径：
      · 精确命中 —— 路径在源码里以完整（或模板）形式出现
      · 前缀命中 —— 路由的最长字面前缀出现在源码里（说明该资源被使用）
    只要两级都不命中，才判定为「零调用方」。

调用方分类：
    frontend  static/ 下的 js / html（已去注释）
    script    scripts/ 下的 py（TestClient / requests 冒烟）
    menu      static/js/menu.config.js —— 只是能力↔路由声明，不算调用
    docs      *.md —— 对外契约，删前需同步改文档

用法: .venv/Scripts/python.exe scripts/audit_routes.py
产出: scripts/_route_audit.json
"""
from __future__ import annotations

import inspect
import json
import os
import re
import sys
from collections import defaultdict

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)

from app.main import app  # noqa: E402

SKIP_DIRS = {".git", ".venv", "node_modules", "__pycache__", ".workbuddy", "uploads", ".idea"}
ABS_RE = re.compile(r"/api/[A-Za-z0-9_\-/\.\{\}\$\*:]*")
REL_RES = (
    re.compile(r"""api(?:\.(?:get|post|put|del|delete)|\.request)?\(\s*["'](/[^"']*)"""),
    re.compile(r"""request\(\s*["'](/[^"']*)"""),
    re.compile(r"""(?:downloadFile|window\.open|fetch)\(\s*["'](/[^"']*)"""),
)
SVC_RE = re.compile(r"\b([a-z_]*service|service|svc|hub|registry)\.([a-z_][a-z0-9_]*)\s*\(")
SCAN_EXTS = {".js", ".html", ".vue", ".ps1", ".sh", ".sql", ".json", ".md", ".py"}


def normalize(url: str) -> str:
    url = url.split("?")[0].split("#")[0]
    url = re.sub(r"\$\{[^}]*\}", "{p}", url)
    url = re.sub(r"\{[^}]*\}", "{p}", url)
    url = re.sub(r"/+", "/", url)
    if len(url) > 1 and url.endswith("/"):
        url = url[:-1]
    return url


def to_regex(path: str) -> re.Pattern:
    return re.compile("^" + re.escape(normalize(path)).replace(re.escape("{p}"), r"[^/]+") + "$")


def strip_comments(text: str, rel: str) -> str:
    """去掉注释，避免把注释里列出的接口当成调用；行数保持不变。"""
    if rel.endswith(".md"):
        return text
    out = re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group(0).count("\n"), text, flags=re.S)
    out = re.sub(r"(?m)^\s*(//|#).*$", "", out)
    out = re.sub(r"(?m)(?<![:/\w])//[^\n\"']*$", "", out)
    return out


def category(rel: str) -> str:
    if rel == "static/js/menu.config.js":
        return "menu"
    if rel.startswith("static/"):
        return "frontend"
    if rel.endswith(".md"):
        return "docs"
    if rel.startswith("scripts/"):
        return "script"
    return "other"


def build_blobs():
    """{rel: (cat, stripped_text)}，只收需要扫描的文件。"""
    blobs = {}
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            if os.path.splitext(fn)[1].lower() not in SCAN_EXTS:
                continue
            if fn.startswith("_route_audit"):
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, ROOT).replace("\\", "/")
            cat = category(rel)
            if rel.endswith(".py") and not rel.startswith("scripts/"):
                continue
            try:
                raw = open(full, "r", encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            blobs[rel] = (cat, strip_comments(raw, rel))
    return blobs


def collect_routes():
    rows = []
    for r in app.routes:
        path, methods, ep = (getattr(r, "path", None), getattr(r, "methods", None),
                             getattr(r, "endpoint", None))
        if not path or methods is None or ep is None:
            continue
        methods = sorted(m for m in methods if m not in {"HEAD", "OPTIONS"})
        if not methods:
            continue
        try:
            src = inspect.getsourcefile(ep) or "?"
            line = inspect.getsourcelines(ep)[1]
            body = inspect.getsource(ep)
        except (TypeError, OSError):
            src, line, body = "?", 0, ""
        rows.append({
            "path": path, "methods": methods, "func": getattr(ep, "__name__", "?"),
            "file": os.path.relpath(src, ROOT).replace("\\", "/") if src != "?" else "?",
            "line": line,
            "doc": (inspect.getdoc(ep) or "").splitlines()[:1],
            "sig": tuple(sorted(f"{m.group(1)}.{m.group(2)}" for m in SVC_RE.finditer(body))),
        })
    return rows


def longest_prefix(path: str) -> str:
    """路由的字面前缀：第一个 {param} 之前的部分。"""
    idx = path.find("{")
    return path if idx < 0 else path[:idx]


def match_route(r, tokens, blobs):
    """两级匹配：精确路径（含模板）优先，其次最长字面前缀。"""
    norm = normalize(r["path"])
    rx = to_regex(r["path"])
    exact = [t for t in tokens if rx.match(t)]
    used = defaultdict(list)
    for t in exact:
        for rel, cat, line in tokens[t]:
            used[cat].append(f"{rel}:{line}")
    if not (used.get("frontend") or used.get("script")) and "{" in r["path"]:
        pref = longest_prefix(r["path"])
        variants = [pref]
        if pref.startswith("/api/"):
            variants.append(pref[4:])
        variants = [v for v in variants if len(v) > 8]
        for rel, (cat, text) in blobs.items():
            if any(v in text for v in variants):
                used[cat].append(f"{rel}")
    return used


def tokenize(blobs):
    """把源码里出现的路径抽成 token → 位置索引。"""
    tokens = defaultdict(list)
    for rel, (cat, text) in blobs.items():
        for i, line in enumerate(text.splitlines(), 1):
            found = [m.group(0).rstrip(".,;:)\"'`") for m in ABS_RE.finditer(line)]
            if cat in {"frontend", "script"}:
                for rx in REL_RES:
                    found += ["/api" + m.group(1) for m in rx.finditer(line)]
            for raw in found:
                tokens[normalize(raw)].append((rel, cat, i))
    return tokens


def main():
    blobs = build_blobs()
    tokens = tokenize(blobs)
    routes = [r for r in collect_routes() if r["path"].startswith("/api")]

    for r in routes:
        used = match_route(r, tokens, blobs)
        r["calls"] = {k: sorted(set(v)) for k, v in used.items()}
        r["live"] = bool(r["calls"].get("frontend") or r["calls"].get("script"))

    orphans = [r for r in routes if not r["calls"]]
    dead_or_not_declared = [r for r in orphans if not r["calls"].get("docs")]

    by_sig = defaultdict(list)
    for r in routes:
        if r["sig"]:
            by_sig[r["sig"]].append(r)
    dupes = []
    for sig, group in by_sig.items():
        paths = sorted({g["path"] for g in group})
        if len(paths) < 2:
            continue
        info = []
        for p in paths:
            g = next(x for x in group if x["path"] == p)
            info.append({"path": p, "file": f"{g['file']}:{g['line']}",
                         "live": g["live"], "calls": g["calls"]})
        dupes.append({"sig": list(sig), "paths": info})
    dupes.sort(key=lambda d: -len(d["paths"]))

    stats = {
        "api_routes": len(routes),
        "live_routes": sum(1 for r in routes if r["live"]),
        "orphan_routes": len(orphans),
        "orphan_and_undeclared": len(dead_or_not_declared),
        "duplicate_groups": len(dupes),
    }
    print(json.dumps(stats, ensure_ascii=False, indent=2))
    json.dump({"stats": stats, "orphans": orphans, "duplicates": dupes, "routes": routes},
              open(os.path.join(ROOT, "scripts", "_route_audit.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
