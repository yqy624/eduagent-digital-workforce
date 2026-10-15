"""阶段 2 迁移冒烟：验证 /api/review/* 已覆盖评阅域的全部能力。

跑法（服务先起来）：
    DB_BACKEND=sqlite .venv/Scripts/python.exe run.py --host 127.0.0.1 --port 8003
    .venv/Scripts/python.exe scripts/smoke_review_migration.py --base http://127.0.0.1:8003

脚本只走真实 HTTP，不 mock：能过说明端点、权限、返回结构都对。
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from typing import Any, Dict, Optional

PASS: list[str] = []
FAIL: list[str] = []


def call(
    base: str,
    method: str,
    path: str,
    token: Optional[str] = None,
    body: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    url = base + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url=url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {"code": exc.code, "message": raw}


def check(label: str, ok: bool, detail: str = "") -> None:
    tag = "OK  " if ok else "FAIL"
    line = f"[{tag}] {label}" + (f"  -> {detail}" if detail else "")
    print(line)
    (PASS if ok else FAIL).append(label)


def ok(resp: Dict[str, Any]) -> bool:
    return resp.get("code") == 200


def detail_of(resp: Dict[str, Any], limit: int = 90) -> str:
    msg = str(resp.get("message") or "")
    data = resp.get("data")
    if isinstance(data, list):
        msg = f"{len(data)} 条 " + msg
    elif isinstance(data, dict):
        msg = json.dumps(data, ensure_ascii=False)[:limit] + " " + msg
    return msg.strip()


def login(base: str, username: str, role: str) -> Optional[str]:
    resp = call(
        base,
        "POST",
        "/api/auth/login",
        body={"username": username, "password": "Demo@12345", "role": role},
    )
    if ok(resp):
        return resp["data"]["token"]
    print(f"  登录失败 {username}: {resp.get('message')}")
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8003")
    ap.add_argument("--course-id", type=int, default=1)
    args = ap.parse_args()
    base = args.base.rstrip("/")
    cid = args.course_id

    print(f"=== 阶段 2 迁移冒烟  base={base} ===")

    t_tok = login(base, "teacher01", "TEACHER")
    s_tok = login(base, "student01", "STUDENT")
    if not t_tok or not s_tok:
        print("登录失败，终止")
        return 1
    check("登录 teacher01 / student01", True)

    # ---------- 只读端点 ----------
    for label, path in [
        ("评阅总览 GET /overview", "/api/review/overview"),
        ("课程与班级 GET /courses", "/api/review/courses"),
        ("教师评语库 GET /comment-memories", "/api/review/comment-memories"),
        ("批改质量复核 GET /grading-quality", "/api/review/grading-quality"),
        (f"选课与名单 GET /enrollments?course_id={cid}", f"/api/review/enrollments?course_id={cid}"),
        (f"作业发布 GET /assignments?course_id={cid}", f"/api/review/assignments?course_id={cid}"),
        ("待批改清单 GET /scan/tasks", "/api/review/scan/tasks"),
    ]:
        resp = call(base, "GET", path, token=t_tok)
        check(label, ok(resp), detail_of(resp))

    for label, path in [
        ("成绩查询 GET /grades（学生）", "/api/review/grades"),
        ("我的互评 GET /my-peer-reviews（学生）", "/api/review/my-peer-reviews"),
    ]:
        resp = call(base, "GET", path, token=s_tok)
        check(label, ok(resp), detail_of(resp))

    # ---------- 作业闭环：发布 → 提交 → 批改 → 分析 → 互评 → 删除 ----------
    # 标题带时间戳，保证脚本可重复运行（课程下作业名唯一）
    tag = __import__("time").strftime("%m%d%H%M%S")
    title = f"冒烟作业-{tag}"

    created = call(
        base, "POST", "/api/review/assignments", token=t_tok,
        body={
            "course_id": cid,
            "title": title,
            "description": "由 smoke_review_migration.py 创建，用于验证评阅域端点",
            "due_date": "2026-12-31T23:59:59",
            "max_score": 100,
        },
    )
    if ok(created):
        aid = created["data"]["id"]
        check("发布作业 POST /assignments", True, f"assignment_id={aid}")
    else:
        # 字段命名可能与 CourseCreate/AssignmentCreate 不一致，退而用既有作业
        check("发布作业 POST /assignments", False, detail_of(created))
        listing = call(base, "GET", f"/api/review/assignments?course_id={cid}", token=t_tok)
        aid = listing["data"][0]["id"] if ok(listing) and listing["data"] else None
        if aid is None:
            print("无可用作业，终止")
            return 1
        print(f"  回退使用既有作业 id={aid}")

    updated = call(
        base, "PUT", f"/api/review/assignments/{aid}", token=t_tok,
        body={"title": f"{title}-已改名"},
    )
    check("编辑作业 PUT /assignments/{id}", ok(updated), detail_of(updated))

    subs = call(base, "GET", f"/api/review/assignments/{aid}/submissions", token=t_tok)
    check("提交记录 GET /assignments/{id}/submissions", ok(subs), detail_of(subs))

    analysis = call(base, "GET", f"/api/review/assignments/{aid}/analysis", token=t_tok)
    check("作业分析 GET /assignments/{id}/analysis", ok(analysis), detail_of(analysis))

    pr = call(base, "GET", f"/api/review/peer-reviews?assignment_id={aid}", token=t_tok)
    check("互评概览 GET /peer-reviews", ok(pr), detail_of(pr))

    pr_cfg = call(
        base, "POST", f"/api/review/assignments/{aid}/peer-review", token=t_tok,
        body={"enabled": True, "reviews_per_student": 2},
    )
    check("互评配置 POST /assignments/{id}/peer-review", ok(pr_cfg), detail_of(pr_cfg))

    # 学生提交（这是拍照批改自动登记的入口）
    submit = call(
        base, "POST", f"/api/review/assignments/{aid}/submit", token=s_tok,
        body={"content": "冒烟提交：验证评阅域提交端点", "file_ids": []},
    )
    if ok(submit):
        check("在线作答提交 POST /assignments/{id}/submit（学生）", True, detail_of(submit))
        sid = submit["data"].get("id")
        if sid:
            graded = call(
                base, "POST", f"/api/review/submissions/{sid}/grade", token=t_tok,
                body={"score": 88, "comment": "冒烟评分"},
            )
            check("人工批改 POST /submissions/{id}/grade", ok(graded), detail_of(graded))
    else:
        check("在线作答提交 POST /assignments/{id}/submit（学生）", False, detail_of(submit))

    # 权限反向验证：学生不能批改
    denied = call(
        base, "POST", "/api/review/submissions/1/grade", token=s_tok,
        body={"score": 10, "comment": "越权测试"},
    )
    check("权限：学生调用批改应被拒绝", denied.get("code") in (401, 403),
          f"code={denied.get('code')}")

    # 业务保护：已有学生提交的作业不允许删除，这是原平台的既有规则，
    # 这里验证的是"保护生效"，而不是"删除成功"。
    guard = call(base, "DELETE", f"/api/review/assignments/{aid}", token=t_tok)
    check(
        "业务保护：有提交的作业禁止删除",
        guard.get("code") == 400 and "提交" in str(guard.get("message")),
        detail_of(guard),
    )

    # 无提交的新作业应当可以正常删除
    tmp = call(
        base, "POST", "/api/review/assignments", token=t_tok,
        body={
            "course_id": cid,
            "title": f"冒烟作业-待删除-{tag}",
            "description": "用于验证删除端点",
            "due_date": "2026-12-31T23:59:59",
            "max_score": 100,
        },
    )
    if ok(tmp):
        tmp_id = tmp["data"]["id"]
        deleted = call(base, "DELETE", f"/api/review/assignments/{tmp_id}", token=t_tok)
        check("删除作业 DELETE /assignments/{id}（无提交）", ok(deleted), detail_of(deleted))
    else:
        check("删除作业 DELETE /assignments/{id}（无提交）", False, detail_of(tmp))

    print()
    print(f"=== 结果：{len(PASS)} 通过 / {len(FAIL)} 失败 ===")
    if FAIL:
        for f in FAIL:
            print("  失败:", f)
        return 1
    print("SMOKE PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
