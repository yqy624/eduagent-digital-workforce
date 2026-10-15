"""数据库连接管理。

支持两种后端（由 DB_BACKEND 配置切换）：
- mysql  ：生产形态，连接池参数按 MySQL 调优
- sqlite ：本地无依赖启动，用于演示与冒烟测试

切换后端不需要改任何业务代码，改环境变量即可。
"""
import logging

from sqlalchemy import BigInteger, Integer, inspect, text
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import DeclarativeBase
from app.config import settings

logger = logging.getLogger(__name__)


@compiles(BigInteger, "sqlite")
def _compile_bigint_for_sqlite(type_, compiler, **kw):
    """SQLite 下把 BIGINT 编译成 INTEGER。

    原因：SQLite 只有 INTEGER PRIMARY KEY 才会成为 rowid 别名并自增，
    而 SQLAlchemy 的 BigInteger 默认渲染成 BIGINT，导致自增失效、
    插入时报 "NOT NULL constraint failed: id"。
    这里只在 sqlite 方言下改写，不影响 MySQL。
    """
    return "INTEGER"


def _build_engine():
    if settings.db_backend == "sqlite":
        # SQLite 不支持连接池参数，传了会报错
        return create_async_engine(settings.database_url, echo=False)
    return create_async_engine(
        settings.database_url,
        pool_size=10,
        max_overflow=20,
        pool_pre_ping=True,
        echo=False,
    )


engine = _build_engine()

async_session_factory = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


class Base(DeclarativeBase):
    pass


async def _columns_of(conn, table: str) -> set[str]:
    return await conn.run_sync(
        lambda sync_conn: {
            column["name"] for column in inspect(sync_conn).get_columns(table)
        }
        if inspect(sync_conn).has_table(table)
        else set()
    )


async def _add_column_if_missing(conn, table: str, column: str, ddl: str) -> None:
    """补列。失败只记日志不中断——MySQL 与 SQLite 的 DDL 语法并不完全兼容，
    本地启动不应该因为一段兼容补丁而失败。"""
    try:
        if column not in await _columns_of(conn, table):
            await conn.execute(text(ddl))
    except Exception as exc:  # noqa: BLE001
        logger.warning("补列失败（忽略）: %s.%s -> %s", table, column, exc)


async def _add_index_if_missing(conn, table: str, index: str, ddl: str) -> None:
    """补索引。与补列同理：MySQL 的 CREATE INDEX 不支持 IF NOT EXISTS，
    所以先查现有索引名再决定是否执行，失败同样只记日志不中断启动。"""
    try:
        existing = await conn.run_sync(
            lambda sync_conn: {
                ix["name"] for ix in inspect(sync_conn).get_indexes(table)
            }
            if inspect(sync_conn).has_table(table)
            else set()
        )
        if index not in existing:
            await conn.execute(text(ddl))
    except Exception as exc:  # noqa: BLE001
        logger.warning("补索引失败（忽略）: %s.%s -> %s", table, index, exc)


async def ensure_runtime_schema() -> None:
    import app.models.models  # noqa: F401
    import app.models.ai_models  # noqa: F401
    import app.models.vision_models  # noqa: F401

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

        await _add_column_if_missing(
            conn, "assignments", "detail", "ALTER TABLE assignments ADD COLUMN detail TEXT NULL"
        )
        await _add_column_if_missing(
            conn, "ai_runs", "plan_json", "ALTER TABLE ai_runs ADD COLUMN plan_json TEXT NULL"
        )

        # 用户学号：视觉身份映射与业务用户的连接键（后加的，已存在的库靠这里补齐）
        await _add_column_if_missing(
            conn,
            "users",
            "student_no",
            "ALTER TABLE users ADD COLUMN student_no VARCHAR(64) NULL",
        )
        await _add_index_if_missing(
            conn,
            "users",
            "uq_users_student_no",
            "CREATE UNIQUE INDEX uq_users_student_no ON users (student_no)",
        )

        # 视觉表与业务表的绑定列（后加的，已存在的库靠这里补齐）
        for table, column in (
            ("vision_tasks", "submission_id"),
            ("vision_tasks", "assignment_id"),
            ("vision_tasks", "file_id"),
            ("vision_events", "course_id"),
            ("vision_events", "assignment_id"),
            ("vision_events", "submission_id"),
        ):
            await _add_column_if_missing(
                conn,
                table,
                column,
                f"ALTER TABLE {table} ADD COLUMN {column} BIGINT NULL",
            )


async def get_db() -> AsyncSession:
    """FastAPI 依赖注入：获取数据库会话"""
    async with async_session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()
