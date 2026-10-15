"""应用配置管理。

所有可变配置从环境变量读取，.env 仅用于本地开发。
"""

from pathlib import Path
from typing import Optional

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


PROJECT_ROOT = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    # Server
    app_env: str = "development"
    server_host: str = "0.0.0.0"
    # 统一端口方案（ai-suite）：业务 A = 教育，占「教育段 1801x」
    server_port: int = 18010
    log_level: str = "INFO"
    cors_origins: str = "http://localhost:18010,http://127.0.0.1:18010"

    # Database
    # db_backend: mysql（生产/现有形态）| sqlite（本地无依赖启动）
    db_backend: str = Field(default="mysql", pattern="^(mysql|sqlite)$")
    db_host: str = "localhost"
    db_port: int = 3306
    db_name: str = "student_db"
    db_username: str = "root"
    db_password: str = "change-me"
    sqlite_path: str = "data/platform.db"

    @property
    def database_url(self) -> str:
        if self.db_backend == "sqlite":
            return f"sqlite+aiosqlite:///{self.sqlite_abs_path}"
        return f"mysql+aiomysql://{self.db_username}:{self.db_password}@{self.db_host}:{self.db_port}/{self.db_name}?charset=utf8mb4"

    @property
    def database_url_sync(self) -> str:
        """用于 Alembic 等同步工具"""
        if self.db_backend == "sqlite":
            return f"sqlite:///{self.sqlite_abs_path}"
        return f"mysql+pymysql://{self.db_username}:{self.db_password}@{self.db_host}:{self.db_port}/{self.db_name}?charset=utf8mb4"

    @property
    def sqlite_abs_path(self) -> Path:
        path = Path(self.sqlite_path)
        resolved = path if path.is_absolute() else PROJECT_ROOT / path
        resolved.parent.mkdir(parents=True, exist_ok=True)
        return resolved

    # Redis
    redis_host: str = "localhost"
    redis_port: int = 6379
    redis_password: Optional[str] = ""
    redis_database: int = 0

    # JWT
    jwt_secret: str = "ChangeThisJwtSecretBeforeProductionUse_AtLeast32CharsLong"
    jwt_expiration: int = 86400000  # 24 hours in ms

    # MinIO (optional)
    minio_endpoint: Optional[str] = "http://localhost:9000"
    minio_access_key: Optional[str] = "minioadmin"
    minio_secret_key: Optional[str] = "minioadmin"
    minio_bucket: str = "education-files"

    # Local file storage
    upload_dir: str = "uploads"
    max_upload_size_mb: int = Field(default=20, ge=1, le=1024)

    # AI and vector store
    ai_enabled: bool = True
    vector_store: str = "faiss"
    embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2"
    chroma_persist_dir: str = "data/chroma"
    agent_memory_load_limit: int = Field(default=8, ge=1, le=50)
    agent_memory_prompt_limit: int = Field(default=6, ge=1, le=50)
    agent_execution_context_chars: int = Field(default=16000, ge=1000, le=100000)

    # LLM API Keys
    openai_api_key: Optional[str] = None
    openai_model: str = "gpt-4o"
    anthropic_api_key: Optional[str] = None
    anthropic_model: str = "claude-sonnet-4"
    dashscope_api_key: Optional[str] = None
    dashscope_model: str = "qwen-max"

    # Ollama（本地 LLM）
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = ""

    # ----------------------------------------------------------
    # 模型层：实现选择（切换真实模型只改这里，业务代码不动）
    # ----------------------------------------------------------
    model_vision_backend: str = "placeholder"  # placeholder | yolo-platform | http-yolo
    model_llm_backend: str = "placeholder"  # placeholder | ollama | openai ...
    model_embedding_backend: str = "placeholder"  # placeholder | hf | ollama ...

    # 视觉模型：转发到 yolo-platform 子进程推理（每次请求重新加载权重）
    yolo_platform_dir: str = "~/Desktop/yolo-platform"
    yolo_platform_python: str = ".venv/Scripts/python.exe"
    vision_weights: str = "yolo11n.pt"

    # 视觉模型：转发到常驻 HTTP 推理服务（模型只加载一次，推荐）
    vision_service_url: str = "http://127.0.0.1:18030"

    # ----------------------------------------------------------
    # 检索层：知识库外置（rag-go）
    # ----------------------------------------------------------
    # local=用 edu 进程内的 FAISS/词法实现（现状）；http-rag=外置给 rag-go
    rag_backend: str = "local"  # local | http-rag
    rag_service_url: str = "http://127.0.0.1:18000"
    # 检索要走"向量召回 + 融合 + 重排"，比单次推理慢，超时留足余量
    rag_service_timeout_ms: int = Field(default=15000, ge=1000, le=120000)
    # 课程 -> 逻辑库名：{prefix}{course_id}，需与知识库侧约定一致
    rag_library_prefix: str = "course_"
    # 入库方式：multipart=edu 直接上传字节（无需对象存储）；from-object=走 MinIO
    rag_ingest_mode: str = "multipart"  # multipart | from-object
    # 附件入库后是否自动投递给知识库（关闭则只保留检索外置）
    rag_ingest_enabled: bool = True
    # 关掉检索时是否回落到 edu 本地实现（生产建议 True）
    rag_fallback_to_local: bool = True

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
        # model_* 前缀的字段（model_vision_backend 等）会触发保护命名空间告警
        protected_namespaces=(),
    )

    @property
    def cors_origins_list(self) -> list[str]:
        """返回可直接交给 CORSMiddleware 的来源列表。"""
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def upload_path(self) -> Path:
        """返回相对于项目根目录解析后的上传目录。"""
        path = Path(self.upload_dir)
        return path if path.is_absolute() else PROJECT_ROOT / path

    @property
    def chroma_path(self) -> Path:
        path = Path(self.chroma_persist_dir)
        return path if path.is_absolute() else PROJECT_ROOT / path


settings = Settings()
