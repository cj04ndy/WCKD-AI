from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException

VERSION = "1.0.0"

AI_ROOT = Path(__file__).resolve().parent
MEMORY_ROOT = AI_ROOT / "memory"
DB_PATH = MEMORY_ROOT / "memory.db"

DEFAULT_LIMIT = 8
MAX_LIMIT = 50
MAX_TEXT_CHARS = 200_000
DEFAULT_CONTEXT_CHARS = 12_000
MAX_CONTEXT_CHARS = 40_000

_lock = threading.RLock()
_fts5_available = False


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(
        str(DB_PATH),
        timeout=30,
        check_same_thread=False,
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


def _ensure_schema() -> None:
    global _fts5_available

    MEMORY_ROOT.mkdir(parents=True, exist_ok=True)

    with _lock:
        conn = _connect()
        try:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS memories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    memory_id TEXT NOT NULL UNIQUE,
                    project_id TEXT NOT NULL,
                    title TEXT NOT NULL DEFAULT '',
                    source TEXT NOT NULL DEFAULT 'manual',
                    kind TEXT NOT NULL DEFAULT 'note',
                    text TEXT NOT NULL,
                    tags_json TEXT NOT NULL DEFAULT '[]',
                    metadata_json TEXT NOT NULL DEFAULT '{}',
                    content_hash TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_memories_project
                    ON memories(project_id);

                CREATE INDEX IF NOT EXISTS idx_memories_project_kind
                    ON memories(project_id, kind);

                CREATE INDEX IF NOT EXISTS idx_memories_hash
                    ON memories(project_id, content_hash);
                """
            )

            try:
                conn.execute(
                    """
                    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
                    USING fts5(
                        title,
                        text,
                        source,
                        content='memories',
                        content_rowid='id',
                        tokenize='unicode61'
                    )
                    """
                )

                conn.executescript(
                    """
                    CREATE TRIGGER IF NOT EXISTS memories_ai
                    AFTER INSERT ON memories BEGIN
                        INSERT INTO memories_fts(rowid, title, text, source)
                        VALUES (new.id, new.title, new.text, new.source);
                    END;

                    CREATE TRIGGER IF NOT EXISTS memories_ad
                    AFTER DELETE ON memories BEGIN
                        INSERT INTO memories_fts(memories_fts, rowid, title, text, source)
                        VALUES ('delete', old.id, old.title, old.text, old.source);
                    END;

                    CREATE TRIGGER IF NOT EXISTS memories_au
                    AFTER UPDATE ON memories BEGIN
                        INSERT INTO memories_fts(memories_fts, rowid, title, text, source)
                        VALUES ('delete', old.id, old.title, old.text, old.source);

                        INSERT INTO memories_fts(rowid, title, text, source)
                        VALUES (new.id, new.title, new.text, new.source);
                    END;
                    """
                )

                # Rebuild keeps FTS synchronized even if schema was introduced
                # after records already existed.
                conn.execute(
                    "INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')"
                )
                _fts5_available = True

            except sqlite3.OperationalError:
                _fts5_available = False

            conn.commit()
        finally:
            conn.close()


def _normalize_project_id(value: Any) -> str:
    project_id = str(value or "").strip()

    if not project_id:
        raise HTTPException(status_code=400, detail="project_id is required.")

    if len(project_id) > 120:
        raise HTTPException(status_code=400, detail="project_id is too long.")

    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", project_id):
        raise HTTPException(
            status_code=400,
            detail=(
                "project_id may contain only letters, numbers, dot, "
                "underscore and hyphen."
            ),
        )

    return project_id


def _normalize_tags(value: Any) -> list[str]:
    if value is None:
        return []

    if not isinstance(value, list):
        raise HTTPException(status_code=400, detail="tags must be a list.")

    result: list[str] = []

    for item in value:
        tag = str(item or "").strip().lower()
        if not tag:
            continue
        if len(tag) > 80:
            raise HTTPException(status_code=400, detail="tag is too long.")
        if tag not in result:
            result.append(tag)

    return result[:50]


def _normalize_metadata(value: Any) -> dict[str, Any]:
    if value is None:
        return {}

    if not isinstance(value, dict):
        raise HTTPException(status_code=400, detail="metadata must be an object.")

    # Ensure metadata is JSON serializable before it reaches SQLite.
    try:
        encoded = json.dumps(value, ensure_ascii=False)
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"metadata is not JSON serializable: {exc}",
        ) from exc

    if len(encoded) > 100_000:
        raise HTTPException(status_code=400, detail="metadata is too large.")

    return value


def _content_hash(
    project_id: str,
    title: str,
    source: str,
    kind: str,
    text: str,
) -> str:
    canonical = "\n".join(
        [
            project_id.strip(),
            title.strip(),
            source.strip(),
            kind.strip(),
            text.strip(),
        ]
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _row_to_memory(row: sqlite3.Row) -> dict[str, Any]:
    try:
        tags = json.loads(row["tags_json"])
    except Exception:
        tags = []

    try:
        metadata = json.loads(row["metadata_json"])
    except Exception:
        metadata = {}

    result = {
        "memory_id": row["memory_id"],
        "project_id": row["project_id"],
        "title": row["title"],
        "source": row["source"],
        "kind": row["kind"],
        "text": row["text"],
        "tags": tags,
        "metadata": metadata,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }

    if "rank" in row.keys():
        result["rank"] = row["rank"]

    return result


def _fts_query(query: str) -> str:
    tokens = re.findall(r"\w+", query, flags=re.UNICODE)
    tokens = [token for token in tokens if token.strip()]

    if not tokens:
        return ""

    # Prefix search makes queries such as "specialist registr" useful without
    # exposing raw FTS5 syntax from the API caller.
    return " OR ".join(f'"{token}"*' for token in tokens[:24])


def _search_fts(
    conn: sqlite3.Connection,
    project_id: str,
    query: str,
    limit: int,
    kind: str | None,
) -> list[dict[str, Any]]:
    fts = _fts_query(query)
    if not fts:
        return []

    sql = """
        SELECT
            m.*,
            bm25(memories_fts, 3.0, 1.0, 0.5) AS rank
        FROM memories_fts
        JOIN memories AS m
          ON m.id = memories_fts.rowid
        WHERE memories_fts MATCH ?
          AND m.project_id = ?
    """
    args: list[Any] = [fts, project_id]

    if kind:
        sql += " AND m.kind = ?"
        args.append(kind)

    sql += " ORDER BY rank ASC, m.updated_at DESC LIMIT ?"
    args.append(limit)

    rows = conn.execute(sql, args).fetchall()
    return [_row_to_memory(row) for row in rows]


def _search_like(
    conn: sqlite3.Connection,
    project_id: str,
    query: str,
    limit: int,
    kind: str | None,
) -> list[dict[str, Any]]:
    tokens = re.findall(r"\w+", query, flags=re.UNICODE)
    tokens = [token.lower() for token in tokens if token.strip()]

    if not tokens:
        return []

    score_parts = []
    where_parts = []
    args: list[Any] = []

    for token in tokens[:12]:
        pattern = f"%{token}%"
        where_parts.append(
            "(lower(title) LIKE ? OR lower(text) LIKE ? OR lower(source) LIKE ?)"
        )
        args.extend([pattern, pattern, pattern])

        score_parts.append(
            """
            (
                CASE WHEN lower(title) LIKE ? THEN 3 ELSE 0 END +
                CASE WHEN lower(text) LIKE ? THEN 1 ELSE 0 END +
                CASE WHEN lower(source) LIKE ? THEN 1 ELSE 0 END
            )
            """
        )

    score_args: list[Any] = []
    for token in tokens[:12]:
        pattern = f"%{token}%"
        score_args.extend([pattern, pattern, pattern])

    sql = f"""
        SELECT
            memories.*,
            ({' + '.join(score_parts)}) * -1.0 AS rank
        FROM memories
        WHERE project_id = ?
          AND ({' OR '.join(where_parts)})
    """

    final_args: list[Any] = score_args + [project_id] + args

    if kind:
        sql += " AND kind = ?"
        final_args.append(kind)

    sql += " ORDER BY rank ASC, updated_at DESC LIMIT ?"
    final_args.append(limit)

    rows = conn.execute(sql, final_args).fetchall()
    return [_row_to_memory(row) for row in rows]


def _search(
    project_id: str,
    query: str,
    limit: int,
    kind: str | None = None,
) -> list[dict[str, Any]]:
    query = str(query or "").strip()
    if not query:
        raise HTTPException(status_code=400, detail="query is required.")

    limit = max(1, min(int(limit), MAX_LIMIT))
    kind_value = str(kind or "").strip().lower() or None

    with _lock:
        conn = _connect()
        try:
            if _fts5_available:
                return _search_fts(
                    conn,
                    project_id,
                    query,
                    limit,
                    kind_value,
                )

            return _search_like(
                conn,
                project_id,
                query,
                limit,
                kind_value,
            )
        finally:
            conn.close()


def _memory_count() -> tuple[int, int]:
    with _lock:
        conn = _connect()
        try:
            total = int(
                conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
            )
            projects = int(
                conn.execute(
                    "SELECT COUNT(DISTINCT project_id) FROM memories"
                ).fetchone()[0]
            )
            return total, projects
        finally:
            conn.close()


app = FastAPI(
    title="WCKD Project Memory",
    description=(
        "Persistent project-scoped memory and local RAG retrieval for WCKD Suite."
    ),
    version=VERSION,
)


@app.on_event("startup")
def startup() -> None:
    _ensure_schema()


@app.get("/health")
def health() -> dict[str, Any]:
    try:
        total, projects = _memory_count()
        db_ok = True
        error = None
    except Exception as exc:
        total = 0
        projects = 0
        db_ok = False
        error = str(exc)

    return {
        "status": "ok" if db_ok else "error",
        "version": VERSION,
        "backend": "sqlite",
        "retrieval": "fts5" if _fts5_available else "lexical-fallback",
        "fts5": _fts5_available,
        "database": str(DB_PATH),
        "database_ok": db_ok,
        "projects": projects,
        "memories": total,
        "project_scoped": True,
        "persistence": True,
        "max_context_chars": MAX_CONTEXT_CHARS,
        "error": error,
    }


@app.post("/memory/add")
def add_memory(body: dict[str, Any]) -> dict[str, Any]:
    project_id = _normalize_project_id(body.get("project_id"))
    text = str(body.get("text") or "").strip()
    title = str(body.get("title") or "").strip()
    source = str(body.get("source") or "manual").strip() or "manual"
    kind = str(body.get("kind") or "note").strip().lower() or "note"
    tags = _normalize_tags(body.get("tags"))
    metadata = _normalize_metadata(body.get("metadata"))

    if not text:
        raise HTTPException(status_code=400, detail="text is required.")

    if len(text) > MAX_TEXT_CHARS:
        raise HTTPException(
            status_code=400,
            detail=f"text exceeds {MAX_TEXT_CHARS} characters.",
        )

    if len(title) > 500:
        raise HTTPException(status_code=400, detail="title is too long.")

    if len(source) > 500:
        raise HTTPException(status_code=400, detail="source is too long.")

    if len(kind) > 80:
        raise HTTPException(status_code=400, detail="kind is too long.")

    content_hash = _content_hash(project_id, title, source, kind, text)
    now = _now_iso()

    with _lock:
        conn = _connect()
        try:
            existing = conn.execute(
                """
                SELECT *
                FROM memories
                WHERE project_id = ?
                  AND content_hash = ?
                LIMIT 1
                """,
                (project_id, content_hash),
            ).fetchone()

            if existing:
                return {
                    "status": "ok",
                    "created": False,
                    "deduplicated": True,
                    "memory": _row_to_memory(existing),
                }

            memory_id = "mem-" + uuid.uuid4().hex[:16]

            conn.execute(
                """
                INSERT INTO memories(
                    memory_id,
                    project_id,
                    title,
                    source,
                    kind,
                    text,
                    tags_json,
                    metadata_json,
                    content_hash,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    memory_id,
                    project_id,
                    title,
                    source,
                    kind,
                    text,
                    json.dumps(tags, ensure_ascii=False),
                    json.dumps(metadata, ensure_ascii=False),
                    content_hash,
                    now,
                    now,
                ),
            )
            conn.commit()

            row = conn.execute(
                "SELECT * FROM memories WHERE memory_id = ?",
                (memory_id,),
            ).fetchone()

            return {
                "status": "ok",
                "created": True,
                "deduplicated": False,
                "memory": _row_to_memory(row),
            }
        finally:
            conn.close()


@app.post("/memory/search")
def search_memory(body: dict[str, Any]) -> dict[str, Any]:
    project_id = _normalize_project_id(body.get("project_id"))
    query = str(body.get("query") or "").strip()
    limit = int(body.get("limit") or DEFAULT_LIMIT)
    kind = body.get("kind")

    memories = _search(
        project_id=project_id,
        query=query,
        limit=limit,
        kind=kind,
    )

    return {
        "status": "ok",
        "version": VERSION,
        "project_id": project_id,
        "query": query,
        "count": len(memories),
        "retrieval": "fts5" if _fts5_available else "lexical-fallback",
        "memories": memories,
    }


@app.post("/memory/context")
def memory_context(body: dict[str, Any]) -> dict[str, Any]:
    project_id = _normalize_project_id(body.get("project_id"))
    query = str(body.get("query") or "").strip()
    limit = int(body.get("limit") or DEFAULT_LIMIT)
    max_chars = int(body.get("max_chars") or DEFAULT_CONTEXT_CHARS)
    kind = body.get("kind")

    max_chars = max(500, min(max_chars, MAX_CONTEXT_CHARS))

    memories = _search(
        project_id=project_id,
        query=query,
        limit=limit,
        kind=kind,
    )

    parts: list[str] = []
    citations: list[dict[str, Any]] = []
    used = 0

    for item in memories:
        header = (
            f"[MEMORY {item['memory_id']} | "
            f"kind={item['kind']} | source={item['source']}]"
        )
        if item["title"]:
            header += f" {item['title']}"

        block = header + "\n" + item["text"].strip()
        separator = "\n\n"

        needed = len(block) + (len(separator) if parts else 0)
        remaining = max_chars - used

        if remaining <= 0:
            break

        if needed > remaining:
            # Keep a useful partial final item while respecting context budget.
            allowance = max(0, remaining - len(header) - 2)
            if allowance < 120:
                break
            block = header + "\n" + item["text"].strip()[:allowance]
            needed = len(block) + (len(separator) if parts else 0)

        parts.append(block)
        used += needed

        citations.append(
            {
                "memory_id": item["memory_id"],
                "title": item["title"],
                "source": item["source"],
                "kind": item["kind"],
                "created_at": item["created_at"],
            }
        )

    context = "\n\n".join(parts)

    return {
        "status": "ok",
        "version": VERSION,
        "project_id": project_id,
        "query": query,
        "context": context,
        "context_chars": len(context),
        "citations": citations,
        "retrieval": "fts5" if _fts5_available else "lexical-fallback",
    }


@app.get("/memory/projects")
def list_projects() -> dict[str, Any]:
    with _lock:
        conn = _connect()
        try:
            rows = conn.execute(
                """
                SELECT
                    project_id,
                    COUNT(*) AS memories,
                    MAX(updated_at) AS updated_at
                FROM memories
                GROUP BY project_id
                ORDER BY updated_at DESC
                """
            ).fetchall()
        finally:
            conn.close()

    return {
        "status": "ok",
        "projects": [
            {
                "project_id": row["project_id"],
                "memories": int(row["memories"]),
                "updated_at": row["updated_at"],
            }
            for row in rows
        ],
    }


@app.get("/memory/list/{project_id}")
def list_memories(
    project_id: str,
    limit: int = 50,
) -> dict[str, Any]:
    project_id = _normalize_project_id(project_id)
    limit = max(1, min(int(limit), 200))

    with _lock:
        conn = _connect()
        try:
            rows = conn.execute(
                """
                SELECT *
                FROM memories
                WHERE project_id = ?
                ORDER BY updated_at DESC
                LIMIT ?
                """,
                (project_id, limit),
            ).fetchall()
        finally:
            conn.close()

    return {
        "status": "ok",
        "project_id": project_id,
        "count": len(rows),
        "memories": [_row_to_memory(row) for row in rows],
    }


@app.get("/memory/{memory_id}")
def get_memory(memory_id: str) -> dict[str, Any]:
    memory_id = str(memory_id or "").strip()

    with _lock:
        conn = _connect()
        try:
            row = conn.execute(
                "SELECT * FROM memories WHERE memory_id = ?",
                (memory_id,),
            ).fetchone()
        finally:
            conn.close()

    if not row:
        raise HTTPException(status_code=404, detail=f"Unknown memory: {memory_id}")

    return {
        "status": "ok",
        "memory": _row_to_memory(row),
    }


@app.delete("/memory/{memory_id}")
def delete_memory(memory_id: str) -> dict[str, Any]:
    memory_id = str(memory_id or "").strip()

    with _lock:
        conn = _connect()
        try:
            row = conn.execute(
                "SELECT memory_id FROM memories WHERE memory_id = ?",
                (memory_id,),
            ).fetchone()

            if not row:
                raise HTTPException(
                    status_code=404,
                    detail=f"Unknown memory: {memory_id}",
                )

            conn.execute(
                "DELETE FROM memories WHERE memory_id = ?",
                (memory_id,),
            )
            conn.commit()
        finally:
            conn.close()

    return {
        "status": "ok",
        "deleted": memory_id,
    }


@app.delete("/memory/project/{project_id}")
def clear_project(project_id: str) -> dict[str, Any]:
    project_id = _normalize_project_id(project_id)

    with _lock:
        conn = _connect()
        try:
            count = int(
                conn.execute(
                    "SELECT COUNT(*) FROM memories WHERE project_id = ?",
                    (project_id,),
                ).fetchone()[0]
            )

            conn.execute(
                "DELETE FROM memories WHERE project_id = ?",
                (project_id,),
            )
            conn.commit()
        finally:
            conn.close()

    return {
        "status": "ok",
        "project_id": project_id,
        "deleted": count,
    }
