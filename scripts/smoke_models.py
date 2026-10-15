"""模型抽象层冒烟脚本。

验证三件事：
1. 三类能力（视觉 / 大模型 / 向量化）都能通过统一契约调用成功
2. 占位实现是**确定性**的——同一输入两次调用产出完全一致
3. 注册表能按名字切换实现，且未就绪时安全回落

用法：
    python scripts/smoke_models.py
    python scripts/smoke_models.py --vision-backend yolo-platform
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.models import (  # noqa: E402
    EmbeddingRequest,
    LLMRequest,
    LLMTask,
    VisionRequest,
    VisionScene,
    get_embedding_provider,
    get_llm_provider,
    get_vision_provider,
    registry,
)


def _fingerprint(obj) -> str:
    payload = json.dumps(obj, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.md5(payload.encode("utf-8")).hexdigest()[:12]


async def check_vision(backend: str | None) -> bool:
    print("== 视觉能力 ==")
    provider = get_vision_provider(backend)
    print(f"  实现        : {provider.name} (placeholder={provider.is_placeholder})")
    ok = True
    for scene in VisionScene:
        req = VisionRequest(scene=scene, source_ref="data/samples/demo.jpg")
        result = await provider.invoke(req)
        if not result.ok:
            print(f"  [{scene.value}] 失败: {result.error}")
            ok = False
            continue
        state = result.data
        print(
            f"  [{scene.value:<14}] 目标 {len(state.objects)} · 事件 {len(state.events)} "
            f"· {state.summary.get('classes_seen', {})} · {result.meta.latency_ms:.2f}ms"
        )
        for event in state.events:
            print(f"       事件 {event.type:<16} 严重度={event.severity} 主体={event.subject_ref}")

        # 确定性校验
        again = await provider.invoke(req)
        if _fingerprint(state.model_dump()) != _fingerprint(again.data.model_dump()):
            print(f"  [{scene.value}] 结果不确定！同一输入两次调用不一致")
            ok = False
    return ok


async def check_llm(backend: str | None) -> bool:
    print("\n== 大模型能力 ==")
    provider = get_llm_provider(backend)
    print(f"  实现        : {provider.name} (placeholder={provider.is_placeholder})")
    ok = True
    for task in LLMTask:
        req = LLMRequest(task=task, prompt="已知直角三角形两直角边分别为 3 和 4，求斜边长")
        result = await provider.invoke(req)
        if not result.ok:
            print(f"  [{task.value}] 失败: {result.error}")
            ok = False
            continue
        print(
            f"  [{task.value:<17}] {len(result.data.text)} 字 · tokens="
            f"{result.data.usage.get('total_tokens', 0)} · {result.meta.latency_ms:.2f}ms"
        )
    return ok


async def check_embedding(backend: str | None) -> bool:
    print("\n== 向量化能力 ==")
    provider = get_embedding_provider(backend)
    print(f"  实现        : {provider.name} (placeholder={provider.is_placeholder})")
    texts = ["勾股定理的定义", "勾股定理的定义", "实验室安全规范"]
    result = await provider.invoke(EmbeddingRequest(texts=texts))
    if not result.ok:
        print(f"  失败: {result.error}")
        return False

    a, b, c = result.data.vectors
    sim_same = sum(x * y for x, y in zip(a, b))
    sim_diff = sum(x * y for x, y in zip(a, c))
    print(f"  维度        : {result.data.dim}")
    print(f"  相似度(同文本): {sim_same:.4f}   期望 1.0000")
    print(f"  相似度(异文本): {sim_diff:.4f}   期望 [0, 1) 且明显小于同文本")

    # 容差取 1e-4：向量分量做了定点截断，归一化后自相似度不会精确等于 1
    ok = abs(sim_same - 1.0) < 1e-4 and -1e-6 <= sim_diff < sim_same - 1e-6
    if not ok:
        print("  相似度不符合预期")
    return ok


async def check_registry() -> bool:
    print("\n== 注册表 ==")
    for cap, bucket in registry.list_providers().items():
        names = ", ".join(bucket)
        print(f"  {cap:<10} 可用实现: {names}   默认: {registry._defaults.get(cap)}")
    return True


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--vision-backend", default=None)
    parser.add_argument("--llm-backend", default=None)
    parser.add_argument("--embedding-backend", default=None)
    args = parser.parse_args()

    results = [
        await check_vision(args.vision_backend),
        await check_llm(args.llm_backend),
        await check_embedding(args.embedding_backend),
        await check_registry(),
    ]
    passed = all(results)
    print("\n" + ("→ SMOKE PASS" if passed else "→ SMOKE FAIL"))
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
