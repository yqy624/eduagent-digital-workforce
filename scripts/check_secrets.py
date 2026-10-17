"""提交前的密钥与敏感信息体检。

用法：
    python scripts/check_secrets.py            # 扫描版本库中所有已跟踪文件
    python scripts/check_secrets.py --staged   # 只扫描暂存区（适合做 pre-commit）

设计原则：
    1. 只读，不改文件；发现问题以退出码 1 结束，可直接拦住提交。
    2. 输出里**不打印完整命中内容**，一律截断打码，避免把秘密二次写进日志。
    3. 允许显式占位符（change-me / your- / example.com / 127.0.0.1 等），
       否则模板文件会被反复误报，最后没人看告警。

判据来源：2026-10-17 上线复盘 —— 真正的风险不是"有没有 .env"，
而是「内网地址、本机绝对路径、截断的 key 前缀」被顺手写进结构化文档。
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys

MAX_BYTES = 2 * 1024 * 1024

# (类别, 名称, 正则)
PATTERNS: list[tuple[str, str, re.Pattern[str]]] = [
    # ---- 密钥 ----
    ("secret", "OpenAI/DeepSeek 风格密钥", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}")),
    ("secret", "GitHub token", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}")),
    ("secret", "GitHub 细粒度 token", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}")),
    ("secret", "AWS Access Key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("secret", "Slack token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}")),
    ("secret", "私钥文件内容", re.compile(r"BEGIN (?:RSA|OPENSSH|EC|DSA|PGP) PRIVATE KEY")),
    (
        "secret",
        "疑似硬编码口令",
        re.compile(
            r"(?i)\b(?:api[_-]?key|secret[_-]?key|access[_-]?key|auth[_-]?token|password|passwd)\b"
            r"\s*[:=]\s*[\"'][^\"'\n]{8,}[\"']"
        ),
    ),
    # ---- 基础设施 ----
    ("infra", "私网 IPv4", re.compile(r"\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b")),
    ("infra", "带端口的私网地址", re.compile(r"\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){2}:\d{2,5}\b")),
    # ---- 个人可识别信息 ----
    ("pii", "Windows 用户目录绝对路径", re.compile(r"[A-Za-z]:[\\/]Users[\\/][^\\/\s\"']+")),
    ("pii", "Unix 用户目录绝对路径", re.compile(r"/(?:home|Users)/[^/\s\"']+")),
]

# 命中行里出现这些片段时视为占位符/示例，不报
ALLOW_HINTS = (
    "change-me",
    "changeme",
    "your-",
    "your_",
    "example.com",
    "example.org",
    "<",
    "xxxx",
    "placeholder",
    "127.0.0.1",
    "0.0.0.0",
    "localhost",
    "os.environ",
    "getenv",
    "settings.",
    # Docker 默认桥接网关：compose 里代理到宿主机服务，属环境约定而非秘密
    "172.19.0.1",
    "host.docker.internal",
)

# 这些路径本身就是模板或说明，不参与「疑似硬编码口令」检查（仍检查真实密钥形态）
SOFT_PATHS = (".env.example", "docs/", "README.md", ".gitignore", ".dockerignore")


def tracked_files() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files", "-z"], capture_output=True, check=True
    ).stdout
    return [p for p in out.decode("utf-8").split("\0") if p]


def staged_files() -> list[str]:
    out = subprocess.run(
        ["git", "diff", "--cached", "--name-only", "-z"], capture_output=True, check=True
    ).stdout
    return [p for p in out.decode("utf-8").split("\0") if p]


def mask(text: str) -> str:
    """命中内容一律打码，只留前 4 个字符，避免日志二次泄漏。"""
    text = text.strip()
    head = text[:4]
    return f"{head}***（长度 {len(text)}）" if len(text) > 8 else "***"


def soft_path(path: str) -> bool:
    return any(path == p or path.startswith(p) for p in SOFT_PATHS)


def scan(paths: list[str]) -> list[tuple[str, str, int, str, str]]:
    findings: list[tuple[str, str, int, str, str]] = []
    for path in paths:
        try:
            if not __import__("os").path.isfile(path):
                continue
            if __import__("os").path.getsize(path) > MAX_BYTES:
                continue
            raw = open(path, "rb").read()
            text = raw.decode("utf-8")
        except (OSError, UnicodeDecodeError):
            continue

        for lineno, line in enumerate(text.splitlines(), start=1):
            if any(h in line for h in ALLOW_HINTS):
                continue
            for kind, name, pattern in PATTERNS:
                if kind == "secret" and name == "疑似硬编码口令" and soft_path(path):
                    continue
                m = pattern.search(line)
                if m:
                    findings.append((kind, name, lineno, path, mask(m.group(0))))
    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description="密钥与敏感信息体检")
    parser.add_argument("--staged", action="store_true", help="只扫描暂存区")
    args = parser.parse_args()

    files = staged_files() if args.staged else tracked_files()
    if not files:
        print("[密钥体检] 没有需要检查的文件")
        return 0

    findings = scan(files)
    if not findings:
        print(f"[密钥体检] 通过：{len(files)} 个文件未发现密钥 / 私网地址 / 本机路径")
        return 0

    order = {"secret": 0, "infra": 1, "pii": 2}
    findings.sort(key=lambda f: (order[f[0]], f[3], f[2]))
    labels = {"secret": "密钥", "infra": "基础设施", "pii": "个人信息"}

    print(f"[密钥体检] 发现 {len(findings)} 处可疑内容：")
    for kind, name, lineno, path, masked in findings:
        print(f"  [{labels[kind]}] {path}:{lineno}  {name} → {masked}")
    print("\n处理建议：真实密钥请立刻轮换并从历史中清除，详见 docs/03-开发指南/密钥与配置管理.md")
    return 1


if __name__ == "__main__":
    sys.exit(main())
