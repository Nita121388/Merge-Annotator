import os
import sqlite3
import time
from typing import Any, Dict, List


DB_ENV_KEY = "ANALYSIS_HISTORY_DB"
DEFAULT_DB_NAME = "analysis_history.sqlite3"


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def get_db_path():
    env = os.getenv(DB_ENV_KEY, "").strip()
    if env:
        return env
    base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    return os.path.join(base_dir, DEFAULT_DB_NAME)


def connect_db():
    path = get_db_path()
    dir_path = os.path.dirname(path)
    if dir_path:
        os.makedirs(dir_path, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def init_history_db():
    with connect_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS analysis_history (
                analysis_id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                finished_at TEXT,
                updated_at TEXT,
                state TEXT,
                branch_dir TEXT,
                trunk_dir TEXT,
                merge_dir TEXT,
                base_dir TEXT,
                file_count INTEGER,
                error TEXT
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_analysis_history_created_at ON analysis_history(created_at)"
        )


def record_history_start(
    analysis_id: str,
    branch_dir: str,
    trunk_dir: str,
    merge_dir: str,
    base_dir: str | None,
):
    timestamp = now_iso()
    with connect_db() as conn:
        conn.execute(
            """
            INSERT INTO analysis_history (
                analysis_id,
                created_at,
                updated_at,
                state,
                branch_dir,
                trunk_dir,
                merge_dir,
                base_dir
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(analysis_id) DO UPDATE SET
                updated_at=excluded.updated_at,
                state=excluded.state,
                branch_dir=excluded.branch_dir,
                trunk_dir=excluded.trunk_dir,
                merge_dir=excluded.merge_dir,
                base_dir=excluded.base_dir
            """,
            (
                analysis_id,
                timestamp,
                timestamp,
                "running",
                branch_dir,
                trunk_dir,
                merge_dir,
                base_dir or "",
            ),
        )


def record_history_finish(analysis_id: str, file_count: int):
    timestamp = now_iso()
    with connect_db() as conn:
        conn.execute(
            """
            UPDATE analysis_history
            SET state=?, finished_at=?, updated_at=?, file_count=?
            WHERE analysis_id=?
            """,
            ("done", timestamp, timestamp, file_count, analysis_id),
        )


def record_history_error(analysis_id: str, error: str):
    timestamp = now_iso()
    with connect_db() as conn:
        conn.execute(
            """
            UPDATE analysis_history
            SET state=?, finished_at=?, updated_at=?, error=?
            WHERE analysis_id=?
            """,
            ("error", timestamp, timestamp, error, analysis_id),
        )


def list_history(limit: int = 50, offset: int = 0) -> List[Dict[str, Any]]:
    with connect_db() as conn:
        rows = conn.execute(
            """
            SELECT analysis_id, created_at, finished_at, state,
                   branch_dir, trunk_dir, merge_dir, base_dir,
                   file_count, error
            FROM analysis_history
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
            """,
            (limit, offset),
        ).fetchall()
    items: List[Dict[str, Any]] = []
    for row in rows:
        roots = {
            "branch": row["branch_dir"] or "",
            "trunk": row["trunk_dir"] or "",
            "merge": row["merge_dir"] or "",
            "base": row["base_dir"] or "",
        }
        if not any(roots.values()):
            roots = {}
        items.append(
            {
                "id": row["analysis_id"],
                "created_at": row["created_at"],
                "finished_at": row["finished_at"],
                "state": row["state"] or "",
                "roots": roots,
                "file_count": row["file_count"],
                "error": row["error"],
            }
        )
    return items
