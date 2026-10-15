"""LLM and embedding factory helpers."""
import os
from typing import Optional

import httpx
from langchain_openai import ChatOpenAI

from app.config import settings


def get_llm(temperature: float = 0.3, model_name: Optional[str] = None):
    """Return a configured chat model, preferring local Ollama when available."""
    ollama_model = settings.ollama_model or os.getenv("OLLAMA_MODEL", "")
    if ollama_model:
        return ChatOpenAI(
            model=model_name or ollama_model,
            temperature=temperature,
            api_key="ollama",
            base_url=f"{settings.ollama_base_url}/v1",
        )
    if settings.openai_api_key:
        kwargs = {
            "model": model_name or settings.openai_model or "gpt-4o",
            "temperature": temperature,
            "api_key": settings.openai_api_key,
            # 网关掉线时不死等：连接 5s / 读取按配置 / 最多重试 llm_max_retries 次。
            # 默认行为会连续重试到分钟级，前端只能一直转圈。
            "timeout": httpx.Timeout(
                connect=5.0,
                read=float(settings.llm_request_timeout_s),
                write=30.0,
                pool=5.0,
            ),
            "max_retries": settings.llm_max_retries,
        }
        # 自建 / 中转网关（OpenAI 兼容）：必须显式传 base_url，否则会打到官方地址
        if settings.openai_base_url:
            kwargs["base_url"] = settings.openai_base_url
        return ChatOpenAI(**kwargs)
    if settings.dashscope_api_key:
        from langchain_dashscope import ChatDashScope

        return ChatDashScope(
            model=model_name or settings.dashscope_model or "qwen-max",
            temperature=temperature,
            api_key=settings.dashscope_api_key,
        )
    if settings.anthropic_api_key:
        from langchain_anthropic import ChatAnthropic

        return ChatAnthropic(
            model=model_name or settings.anthropic_model or "claude-sonnet-4",
            temperature=temperature,
            api_key=settings.anthropic_api_key,
        )
    raise ValueError("未配置任何大模型服务商；请设置 OLLAMA_MODEL 或 API Key（如 DASHSCOPE_API_KEY）")


def get_embeddings():
    """Return the configured embedding model or raise when vector indexing is unavailable."""
    model = (settings.embedding_model or "").strip()
    if not model:
        raise RuntimeError("EMBEDDING_MODEL 未配置，无法进行向量索引")

    if model.startswith("ollama:"):
        from langchain_community.embeddings import OllamaEmbeddings

        return OllamaEmbeddings(
            model=model.split(":", 1)[1],
            base_url=settings.ollama_base_url,
        )

    from langchain_community.embeddings import HuggingFaceEmbeddings

    return HuggingFaceEmbeddings(
        model_name=model,
        model_kwargs={"local_files_only": True},
    )
