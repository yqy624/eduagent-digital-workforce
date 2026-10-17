"""端到端冒烟：启动应用 -> 登录 -> 跑通视觉主流程。

覆盖：
1. 健康检查（含模型注册表）
2. 未带令牌访问应 401（权限真的生效，不是摆设）
3. 登录拿到令牌
4. 视觉主流程：场景 -> 建任务 -> 查任务 -> 事件流 -> 概览 -> 模型清单 -> 确认事件
5. 非法参数应 422（参数校验真的生效）

用法：
    DB_BACKEND=sqlite python scripts/smoke_app.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("DB_BACKEND", "sqlite")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

USERNAME = "teacher01"
# 演示账号口令（与 scripts/seed_demo.py 保持一致，公开的演示值，非生产凭据）
DEMO_PASSWORD = "Demo@12345"
_failed: list[str] = []


def check(name: str, condition: bool, extra: str = "") -> None:
    mark = "OK  " if condition else "FAIL"
    print(f"  [{mark}] {name}{(' -> ' + extra) if extra else ''}")
    if not condition:
        _failed.append(name)


def main() -> int:
    with TestClient(app) as client:
        print("== 健康检查 ==")
        r = client.get("/api/health")
        body = r.json()
        print(f"  HTTP {r.status_code} · status={body.get('status')}")
        # 响应键会被 camelcase 中间件转成驼峰，因此这里是 modelRegistry
        registry_check = body.get("checks", {}).get("modelRegistry", {})
        check("模型注册表已接入", registry_check.get("status") == "ok")
        for cap, info in registry_check.get("capabilities", {}).items():
            impls = ", ".join(
                f"{n}{'(占位)' if v.get('placeholder') else ''}"
                for n, v in info.get("implementations", {}).items()
            )
            print(f"        {cap:<10} 默认={info.get('default'):<14} 可用: {impls}")

        print("\n== 权限 ==")
        r = client.get("/api/vision/tasks")
        check("无令牌访问被拒绝 401", r.status_code == 401, f"实际 {r.status_code}")

        print("\n== 登录 ==")
        r = client.post(
            "/api/auth/login",
            json={"username": USERNAME, "password": DEMO_PASSWORD, "role": "TEACHER"},
        )
        if r.status_code != 200:
            print(f"  登录失败 HTTP {r.status_code}: {r.text[:200]}")
            print("  提示：先跑 DB_BACKEND=sqlite python scripts/seed_demo.py")
            return 1
        token = r.json()["data"]["token"]
        client.headers["Authorization"] = f"Bearer {token}"
        check("登录成功并拿到令牌", bool(token))

        print("\n== 视觉主流程 ==")
        r = client.get("/api/vision/scenes")
        scenes = r.json()["data"]
        check("场景清单", r.status_code == 200 and len(scenes) == 4, f"{len(scenes)} 个")

        r = client.post(
            "/api/vision/tasks",
            # 请求体保持 snake_case：camelcase 中间件只转换响应，不转换请求
            json={"scene": "lab_safety", "source_ref": "data/samples/lab.jpg", "conf": 0.3},
        )
        task = r.json()["data"]
        check("创建任务", r.status_code == 201, f"status={task.get('status')}")
        check("任务执行成功", task.get("status") == "succeeded", f"provider={task.get('provider')}")
        check("标记占位来源", task.get("isPlaceholder") is True)
        print(f"        任务号 {task.get('taskCode')} · 耗时 {task.get('latencyMs')}ms")

        r = client.get("/api/vision/tasks?page=1&page_size=5")
        data = r.json()["data"]
        check("任务列表分页", r.status_code == 200 and data["total"] >= 1, f"total={data['total']}")

        code = task.get("taskCode")
        r = client.get(f"/api/vision/tasks/{code}")
        check("任务详情", r.status_code == 200)

        r = client.get("/api/vision/events?limit=20")
        events = r.json()["data"]
        check("事件流", r.status_code == 200 and len(events) >= 1, f"{len(events)} 条")
        if events:
            e = events[0]
            print(f"        最新事件: {e.get('eventType')} 严重度={e.get('severity')} 主体={e.get('subjectRef')}")

        r = client.get("/api/vision/overview")
        ov = r.json()["data"]
        check("概览统计", r.status_code == 200 and ov["taskTotal"] >= 1)
        print(
            f"        任务 {ov['taskTotal']} · 事件 {ov['eventTotal']} · "
            f"未确认 {ov['unacknowledged']} · 按严重度 {ov['eventBySeverity']}"
        )
        print(f"        占位实现: {ov['placeholdersInUse']}")

        r = client.get("/api/vision/models")
        models = r.json()["data"]
        check("模型清单", r.status_code == 200 and len(models["assets"]) >= 1,
              f"{len(models['assets'])} 个资产")

        r = client.get("/api/vision/identities?scene=classroom")
        ids = r.json()["data"]
        check("身份映射", r.status_code == 200 and len(ids) >= 1, f"{len(ids)} 条")

        if events:
            r = client.post(f"/api/vision/events/{events[0]['id']}/ack")
            check("确认事件", r.status_code == 200 and r.json()["data"]["acknowledged"] is True)

        print("\n== 参数校验 ==")
        r = client.post("/api/vision/tasks", json={"scene": "not_a_scene", "sourceRef": "x"})
        check("非法 scene 被拒 422", r.status_code == 422, f"实际 {r.status_code}")
        r = client.get("/api/vision/events?severity=unknown")
        check("非法 severity 被拒 422", r.status_code == 422, f"实际 {r.status_code}")

        # 统一返回结构 + trace_id
        r = client.get("/api/vision/scenes")
        body = r.json()
        check("统一返回结构", {"code", "message", "data"} <= set(body))
        check("trace_id 已注入", bool(r.headers.get("X-Trace-Id")))

    print("\n" + (f"→ SMOKE FAIL: {_failed}" if _failed else "→ SMOKE PASS"))
    return 1 if _failed else 0


if __name__ == "__main__":
    sys.exit(main())
