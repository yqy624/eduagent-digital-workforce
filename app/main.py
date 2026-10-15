"""FastAPI application entrypoint."""
from contextlib import asynccontextmanager
import logging
import os as _os
from pathlib import Path
import sys
from typing import Any

import httpx
from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import HTTPException, RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.staticfiles import StaticFiles

from app.config import settings
from app.database import engine, ensure_runtime_schema, get_db as _get_db
from app.logging_config import setup_logging
from app.middleware.auth import get_current_user as _get_user
from app.middleware.camelcase import camelcase_middleware
from app.middleware.trace import TRACE_ID_HEADER, TraceMiddleware, current_trace_id
from app.models.models import User as _User
from app.schemas.auth import ProfileUpdateRequest
from app.schemas.common import ApiResponse
from app.services.auth_service import AuthService

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

setup_logging(settings.log_level)

import app.routers.auth as auth_router
import app.routers.admin as admin_router
import app.routers.teacher as teacher_router
import app.routers.student as student_router
import app.routers.files as files_router
import app.routers.notifications as notifications_router
import app.routers.vision as vision_router
# 智能评阅：原平台作业/批改能力迁移到新模块的第一个落点
import app.routers.review as review_router
# 四大模块命名空间（薄封装：复用既有 service，把菜单契约的路径变成真）
import app.routers.governance as governance_router
import app.routers.situation as situation_router
import app.routers.knowledge as knowledge_router
import app.routers.insight as insight_router
# 全局检索：桌面端顶栏搜索框的后端（按角色限定可见范围）
import app.routers.search as search_router

if settings.ai_enabled:
    try:
        import app.routers.ai as ai_router

        AI_AVAILABLE = True
    except ImportError as exc:
        print(f"AI routes failed to load: {exc}")
        AI_AVAILABLE = False
        ai_router = None
else:
    print("AI_ENABLED=false; AI and Agent routes are disabled")
    AI_AVAILABLE = False
    ai_router = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    print("EduAgent platform starting...")
    # 按实际后端打印：SQLite 模式下还报 MySQL 主机名会把人带去查错地方
    if settings.db_backend == "sqlite":
        print(f"Database: sqlite -> {settings.sqlite_abs_path}")
    else:
        print(f"Database: mysql -> {settings.db_host}:{settings.db_port}/{settings.db_name}")
    await ensure_runtime_schema()
    if not AI_AVAILABLE:
        print("AI routes are not available; core business APIs remain loaded")
    try:
        yield
    finally:
        await engine.dispose()
        print("EduAgent platform stopped")


def _install_exception_handlers(app: FastAPI) -> None:
    """全局异常处理：所有错误出口都走统一结构，前端不用适配多种格式。"""

    @app.exception_handler(HTTPException)
    async def _http_exception_handler(request: Request, exc: HTTPException):
        return JSONResponse(
            ApiResponse.error(message=str(exc.detail), code=exc.status_code).model_dump(),
            status_code=exc.status_code,
            headers={TRACE_ID_HEADER: current_trace_id()},
        )

    @app.exception_handler(RequestValidationError)
    async def _validation_handler(request: Request, exc: RequestValidationError):
        details = [
            {"field": ".".join(str(p) for p in e.get("loc", ())), "message": e.get("msg", "")}
            for e in exc.errors()
        ]
        payload = ApiResponse.error(message="参数校验失败", code=422).model_dump()
        payload["details"] = details
        return JSONResponse(payload, status_code=422, headers={TRACE_ID_HEADER: current_trace_id()})

    @app.exception_handler(Exception)
    async def _unhandled_handler(request: Request, exc: Exception):
        logging.getLogger("app.main").exception("未处理异常: %s", exc)
        return JSONResponse(
            ApiResponse.error(message="服务器内部错误", code=500).model_dump(),
            status_code=500,
            headers={TRACE_ID_HEADER: current_trace_id()},
        )


app = FastAPI(
    title="EduAgent",
    description="FastAPI based education Agent platform",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(TraceMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.middleware("http")(camelcase_middleware)


@app.middleware("http")
async def no_cache_frontend_middleware(request: Request, call_next):
    """页面与静态资源一律走协商缓存（no-cache + ETag）。

    为什么必须这么做
    ----------------
    本项目前端是零构建的原生 ES module：desktop.html 与 app.js / data.js
    是**彼此独立缓存**的多个文件。此前 StaticFiles 不带任何 Cache-Control，
    浏览器会按「启发式新鲜度」自行决定缓存多久，于是会出现半更新状态 ——
    例如 HTML 与 app.js 已是新版，而 data.js 还是旧版，新版 app.js 调用
    旧版里不存在的取数方法就会抛错，页面上那些由 JS 填充的区域便永远停在
    加载骨架上（表现为「一直加载不出来」，且没有任何报错提示）。

    加上 no-cache 后，每次加载都会带 ETag 回源校验：文件没变返回 304
    （几乎没有开销），变了立刻拿到新版，HTML 与全部模块始终同代。

    只管前端资源，不动 /api/ 的数据响应。
    """
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response

_install_exception_handlers(app)

app.include_router(auth_router.router)
app.include_router(admin_router.router)
app.include_router(teacher_router.router)
app.include_router(student_router.router)
app.include_router(files_router.router)
app.include_router(notifications_router.router)
app.include_router(notifications_router.ws_router)
app.include_router(vision_router.router)
app.include_router(review_router.router)
app.include_router(governance_router.router)
app.include_router(situation_router.router)
app.include_router(situation_router.ws_router)
app.include_router(knowledge_router.router)
app.include_router(insight_router.router)
app.include_router(search_router.router)
if AI_AVAILABLE and ai_router:
    app.include_router(ai_router.router)


@app.get("/api/profile", include_in_schema=False)
async def _profile_get(
    user: _User = Depends(_get_user),
    db: AsyncSession = Depends(_get_db),
):
    svc = AuthService(db)
    profile = await svc.get_profile(user.username)
    return ApiResponse.ok(data=profile)


@app.put("/api/profile", include_in_schema=False)
async def _profile_put(
    req: ProfileUpdateRequest,
    user: _User = Depends(_get_user),
    db: AsyncSession = Depends(_get_db),
):
    svc = AuthService(db)
    profile = await svc.update_profile(user.username, req)
    return ApiResponse.ok(data=profile, message="Profile updated")


_static_dir = _os.path.join(_os.path.dirname(__file__), "..", "static")
if _os.path.isdir(_static_dir):
    app.mount("/static", StaticFiles(directory=_static_dir, html=True), name="static")
    print(f"Static files mounted: {_static_dir}")


@app.get("/", include_in_schema=False)
async def root():
    """默认入口：数字员工协作台（desktop.html，4 页实装版，接真实接口）。
    控制台在 /platform，登录页在 /login.html。"""
    return FileResponse(_os.path.join(_static_dir, "desktop.html"))


@app.get("/workspace", include_in_schema=False)
async def workspace_page():
    """数字员工协作台的稳定地址，与 / 指向同一文件。"""
    return FileResponse(_os.path.join(_static_dir, "desktop.html"))


@app.get("/platform", include_in_schema=False)
async def platform_shell():
    """模块化工作台：按角色渲染菜单与模块占位页。"""
    return FileResponse(_os.path.join(_static_dir, "platform.html"))


@app.get("/platform.html", include_in_schema=False)
async def platform_shell_html():
    return FileResponse(_os.path.join(_static_dir, "platform.html"))


@app.get("/login.html", include_in_schema=False)
async def login_page():
    return FileResponse(_os.path.join(_static_dir, "login.html"))


async def _check_database() -> dict[str, Any]:
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        return {"status": "ok"}
    except Exception as exc:
        return {"status": "error", "error": str(exc)}


async def _check_llm() -> dict[str, Any]:
    if not settings.ai_enabled:
        return {"status": "skipped", "reason": "AI_ENABLED=false"}
    if not AI_AVAILABLE:
        return {"status": "error", "error": "AI routes failed to load"}

    ollama_model = settings.ollama_model.strip()
    if ollama_model:
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                response = await client.get(f"{settings.ollama_base_url.rstrip('/')}/api/tags")
                response.raise_for_status()
            models = response.json().get("models", [])
            names = {item.get("name", "").split(":", 1)[0] for item in models}
            exact_names = {item.get("name", "") for item in models}
            model_available = ollama_model in exact_names or ollama_model in names
            return {
                "status": "ok" if model_available else "degraded",
                "provider": "ollama",
                "model": ollama_model,
                "model_available": model_available,
            }
        except Exception as exc:
            return {
                "status": "error",
                "provider": "ollama",
                "model": ollama_model,
                "error": str(exc),
            }

    providers = []
    if settings.openai_api_key:
        entry = {"provider": "openai", "model": settings.openai_model}
        # 自建/中转网关时把地址一并报出来，便于健康检查定位打到哪去了
        if settings.openai_base_url:
            entry["base_url"] = settings.openai_base_url
        providers.append(entry)
    if settings.dashscope_api_key:
        providers.append({"provider": "dashscope", "model": settings.dashscope_model})
    if settings.anthropic_api_key:
        providers.append({"provider": "anthropic", "model": settings.anthropic_model})
    if providers:
        return {"status": "configured", "providers": providers}

    # 没有真实 provider 时，回落到模型层的占位实现——
    # 骨架阶段不应该因为没有密钥就让健康检查失败
    try:
        from app.core.models.registry import get_llm_provider

        placeholder = get_llm_provider()
        if placeholder.is_placeholder:
            return {
                "status": "placeholder",
                "provider": placeholder.name,
                "model": placeholder.model_name,
            }
    except Exception as exc:  # noqa: BLE001
        return {"status": "error", "error": str(exc)}

    return {"status": "error", "error": "No LLM provider configured"}


def _check_embeddings() -> dict[str, Any]:
    model = settings.embedding_model.strip()
    if not model:
        return {"status": "error", "error": "EMBEDDING_MODEL is empty"}

    try:
        if model.startswith("ollama:"):
            from langchain_community.embeddings import OllamaEmbeddings  # noqa: F401
        else:
            from langchain_community.embeddings import HuggingFaceEmbeddings  # noqa: F401
        return {"status": "ok", "model": model}
    except Exception as exc:
        return {"status": "error", "model": model, "error": str(exc)}


def _check_vector_store() -> dict[str, Any]:
    try:
        from ai.rag.vector_store import VectorStoreManager

        manager = VectorStoreManager()
        path = Path(manager.persist_directory)
        path.mkdir(parents=True, exist_ok=True)
        # 只做写入探测，不做删除：健康检查带有删除副作用会误触发
        # 外部的安全护栏（批量删除保护），把整个服务带崩。
        # 探测文件保留在目录里，下次覆盖写入即可。
        probe = path / ".healthcheck"
        probe.write_text("ok", encoding="utf-8")
        return {"status": "ok", "path": str(path)}
    except Exception as exc:
        return {"status": "error", "error": str(exc)}


async def _check_model_registry() -> dict[str, Any]:
    """模型层健康检查：能看到每个能力当前跑的是占位还是真实实现。"""
    try:
        from app.core.models.registry import registry

        providers = registry.list_providers()
        return {
            "status": "ok",
            "capabilities": {
                cap: {
                    # "生效值"才是运行时真话（配置优先于注册默认）；
                    # 注册默认另列，避免把"注册了哪个"误读成"在跑哪个"。
                    # retrieval 例外：rag_backend=local 走的是 edu 进程内的
                    # 检索实现（业务层降级路径，不是 Provider），直接报断言值。
                    "effective": (
                        settings.rag_backend
                        if cap == "retrieval"
                        else registry.effective_name(cap)
                    ),
                    "registered_default": registry._defaults.get(cap),
                    "implementations": {
                        name: {
                            "placeholder": info.get("is_placeholder"),
                            "model_name": info.get("model_name"),
                        }
                        for name, info in bucket.items()
                    },
                }
                for cap, bucket in providers.items()
            },
        }
    except Exception as exc:  # noqa: BLE001
        return {"status": "error", "error": str(exc)}


@app.get("/api/health")
async def health_check():
    checks = {
        "database": await _check_database(),
        "ai_routes": {"status": "ok" if AI_AVAILABLE else "disabled" if not settings.ai_enabled else "error"},
        "llm": await _check_llm(),
        "embeddings": _check_embeddings(),
        "vector_store": _check_vector_store(),
        "model_registry": await _check_model_registry(),
    }

    critical_ok = checks["database"]["status"] == "ok"
    if settings.ai_enabled:
        critical_ok = critical_ok and checks["ai_routes"]["status"] == "ok"
        critical_ok = critical_ok and checks["llm"]["status"] in {"ok", "configured", "placeholder"}
        critical_ok = critical_ok and checks["embeddings"]["status"] == "ok"
        critical_ok = critical_ok and checks["vector_store"]["status"] == "ok"

    payload = {
        "status": "ok" if critical_ok else "degraded",
        "version": "2.0.0",
        "project": "EduAgent",
        "ai_available": AI_AVAILABLE,
        "checks": checks,
    }
    return JSONResponse(payload, status_code=200 if critical_ok else 503)
