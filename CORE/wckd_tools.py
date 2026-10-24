from __future__ import annotations

import json
import re
import sqlite3
import shutil
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field


# ============================================================
# WCKD AI TOOLS v5.2 VOICE INTEGRATION
#
# Workspace root:
#   WCKD CORE root
#
# Includes:
#   - file/folder tools
#   - text search
#   - read-only PowerShell
#   - Open WebUI usage statistics
#   - latest Ollama generation speed (tokens/s)
#
# Rainmeter endpoint:
#   http://127.0.0.1:8001/stats/rainmeter
#
# Rainmeter format:
# STATUS|MODEL|TOTAL_INPUT|TOTAL_OUTPUT|TODAY|LIFETIME|MODEL_TOTAL|
# CONTEXT_MAX|TOKENS_PER_SEC|UPDATED|LAST_INPUT|LAST_OUTPUT|
# LAST_TOTAL|CONTEXT_USED|CONTEXT_PERCENT
# ============================================================

BASE = Path(__file__).resolve().parent

OPENWEBUI_URL = "http://127.0.0.1:8080"
OLLAMA_URL = "http://127.0.0.1:11434"
OPENWEBUI_KEY_FILE = BASE / "secrets" / "openwebui_api_key.txt"
OPENWEBUI_DB = BASE / "open-webui-data" / "webui.db"
ROUTER_STATE_FILE = BASE / "router-state.json"

PRIMARY_MODEL_ID = "wckd-ai"
PRIMARY_MODEL_NAME = "WCKD AI"
ROUTER_MODEL_NAMES = {
    "gpt-oss:20b": "GPT-OSS 20B",
    "nemotron-3-nano:4b": "NEMOTRON 3 NANO 4B",
}
OLLAMA_CONTEXT_LENGTH = 32768

MAX_READ_BYTES = 2 * 1024 * 1024
MAX_WRITE_BYTES = 4 * 1024 * 1024
MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024
MAX_SEARCH_RESULTS = 200
POWERSHELL_TIMEOUT_SECONDS = 30

STATS_CACHE_SECONDS = 2.0

TEXT_EXTENSIONS = {
    ".txt", ".md", ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg",
    ".py", ".ps1", ".psm1", ".psd1", ".js", ".ts", ".tsx", ".jsx",
    ".css", ".scss", ".html", ".htm", ".xml", ".csv", ".log", ".env",
    ".bat", ".cmd", ".sh", ".sql", ".prisma", ".properties",
}

ALLOWED_POWERSHELL_COMMANDS = {
    "Get-ChildItem",
    "Get-Content",
    "Get-Item",
    "Get-Process",
    "Get-Service",
    "Get-ComputerInfo",
    "Get-NetTCPConnection",
    "Get-NetIPConfiguration",
    "Get-NetAdapter",
    "Get-CimInstance",
    "Get-Command",
    "Get-Date",
    "Test-Path",
    "Test-NetConnection",
    "Resolve-DnsName",
    "Select-Object",
    "Where-Object",
    "Sort-Object",
    "Measure-Object",
    "Format-Table",
    "Format-List",
}

BLOCKED_POWERSHELL_PATTERNS = [
    r";",
    r"&&",
    r"\|\|",
    r">",
    r"<",
    r"`",
    r"\$\(",
    r"\bInvoke-Expression\b",
    r"\biex\b",
    r"\bStart-Process\b",
    r"\bStop-Process\b",
    r"\bRemove-Item\b",
    r"\bMove-Item\b",
    r"\bCopy-Item\b",
    r"\bRename-Item\b",
    r"\bSet-Content\b",
    r"\bAdd-Content\b",
    r"\bOut-File\b",
    r"\bNew-Item\b",
    r"\bSet-Item\b",
    r"\bSet-ItemProperty\b",
    r"\bRemove-ItemProperty\b",
    r"\bRestart-Computer\b",
    r"\bStop-Computer\b",
    r"\bshutdown\b",
    r"\bformat\b",
    r"\bdiskpart\b",
    r"\breg(\.exe)?\b",
    r"\bsc(\.exe)?\b",
    r"\bnet\s+user\b",
    r"\bnet\s+localgroup\b",
    r"\bSet-ExecutionPolicy\b",
]


app = FastAPI(
    title="WCKD AI Tools",
    description=(
        "Local WCKD AI tools restricted to D:\\ai, read-only PowerShell, "
        "Open WebUI token usage, latest-message usage, context and Ollama tokens/s."
    ),
    version="5.2.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8080",
        "http://127.0.0.1:8080",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# REQUEST MODELS
# ============================================================

class PathRequest(BaseModel):
    path: str = Field(default=".", description="Path relative to D:\\ai")


class ReadRequest(BaseModel):
    path: str = Field(description="File path relative to D:\\ai")


class WriteRequest(BaseModel):
    path: str = Field(description="File path relative to D:\\ai")
    content: str = Field(description="Full UTF-8 text content to write")
    overwrite: bool = Field(
        default=True,
        description="If false, fail when the target file already exists",
    )


class DirectoryRequest(BaseModel):
    path: str = Field(description="Directory path relative to D:\\ai")


class MoveRequest(BaseModel):
    source: str = Field(description="Existing source path relative to D:\\ai")
    destination: str = Field(description="Destination path relative to D:\\ai")
    overwrite: bool = Field(
        default=False,
        description=(
            "If true, replace an existing destination file. "
            "Directories are never overwritten."
        ),
    )


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, description="Case-insensitive text to search for")
    path: str = Field(default=".", description="Directory path relative to D:\\ai")
    glob: str = Field(default="*", description="Filename glob, for example *.py or *.ps1")
    recursive: bool = Field(default=True)
    max_results: int = Field(default=50, ge=1, le=MAX_SEARCH_RESULTS)


class PowerShellRequest(BaseModel):
    command: str = Field(
        description=(
            "Read-only PowerShell command. Only approved inspection cmdlets are allowed. "
            "Pipelines of approved read-only commands are supported."
        )
    )
    timeout_seconds: int = Field(default=15, ge=1, le=POWERSHELL_TIMEOUT_SECONDS)




# ============================================================
# HELPERS
# ============================================================

_stats_cache: dict = {
    "time": 0.0,
    "data": None,
}


def safe_path(relative_path: str) -> Path:
    relative_path = (relative_path or ".").strip()

    candidate = Path(relative_path)
    if candidate.is_absolute():
        resolved = candidate.resolve()
    else:
        resolved = (BASE / candidate).resolve()

    if resolved != BASE and BASE not in resolved.parents:
        raise HTTPException(
            status_code=403,
            detail="Path outside D:\\ai is not allowed",
        )

    return resolved


def relative_display(path: Path) -> str:
    try:
        rel = path.resolve().relative_to(BASE)
        return "." if str(rel) == "." else str(rel)
    except Exception:
        return str(path)


def ensure_text_file(path: Path) -> None:
    if path.suffix.lower() not in TEXT_EXTENSIONS:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported text file type: {path.suffix or '(no extension)'}",
        )


def validate_powershell(command: str) -> list[str]:
    command = command.strip()

    if not command:
        raise HTTPException(status_code=400, detail="PowerShell command is empty")

    for pattern in BLOCKED_POWERSHELL_PATTERNS:
        if re.search(pattern, command, flags=re.IGNORECASE):
            raise HTTPException(
                status_code=403,
                detail=f"Blocked PowerShell syntax or command matched: {pattern}",
            )

    segments = [segment.strip() for segment in command.split("|") if segment.strip()]

    if not segments:
        raise HTTPException(status_code=400, detail="No PowerShell command found")

    detected = []

    for segment in segments:
        match = re.match(r"^([A-Za-z][A-Za-z0-9-]*)\b", segment)
        if not match:
            raise HTTPException(
                status_code=403,
                detail=f"Could not identify command in pipeline segment: {segment}",
            )

        cmdlet = match.group(1)
        detected.append(cmdlet)

        if cmdlet not in ALLOWED_POWERSHELL_COMMANDS:
            raise HTTPException(
                status_code=403,
                detail=(
                    f"PowerShell command '{cmdlet}' is not allowed. "
                    f"Allowed commands: {', '.join(sorted(ALLOWED_POWERSHELL_COMMANDS))}"
                ),
            )

    return detected


def http_json(url: str, headers: dict | None = None, timeout: int = 5):
    request = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def http_post_json(url: str, payload: dict, timeout: int = 300):
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read().decode("utf-8", errors="replace")
        except Exception:
            detail = str(exc)
        raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc


def get_openwebui_key() -> str:
    if not OPENWEBUI_KEY_FILE.exists():
        raise RuntimeError(f"Open WebUI API key file not found: {OPENWEBUI_KEY_FILE}")

    key = OPENWEBUI_KEY_FILE.read_text(encoding="utf-8-sig").strip()

    if not key:
        raise RuntimeError("Open WebUI API key file is empty")

    return key


def get_openwebui_headers() -> dict:
    return {
        "Authorization": f"Bearer {get_openwebui_key()}",
        "Accept": "application/json",
    }


def get_openwebui_usage() -> dict:
    return http_json(
        f"{OPENWEBUI_URL}/api/v1/users/usage",
        headers=get_openwebui_headers(),
        timeout=10,
    )


def _as_number(value, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _usage_number(usage: dict, *keys: str) -> float:
    for key in keys:
        if key in usage and usage.get(key) is not None:
            value = _as_number(usage.get(key), 0.0)
            if value >= 0:
                return value
    return 0.0


def _metrics_from_usage(usage: dict, model_id: str = "") -> dict | None:
    if not isinstance(usage, dict) or not usage:
        return None

    last_input = int(_usage_number(usage, "input_tokens", "prompt_tokens", "prompt_eval_count"))
    last_output = int(_usage_number(usage, "output_tokens", "completion_tokens", "eval_count"))
    context_used = int(_usage_number(usage, "prompt_tokens", "prompt_eval_count", "input_tokens"))

    tokens_per_second = _usage_number(
        usage,
        "response_token/s",
        "response_tokens_per_second",
        "tokens_per_second",
    )

    if tokens_per_second <= 0:
        eval_count = _usage_number(usage, "eval_count", "completion_tokens", "output_tokens")
        eval_duration = _usage_number(usage, "eval_duration")
        if eval_count > 0 and eval_duration > 0:
            tokens_per_second = (eval_count / eval_duration) * 1_000_000_000.0

    if last_input <= 0 and last_output <= 0 and context_used <= 0 and tokens_per_second <= 0:
        return None

    return {
        "model_id": model_id or "",
        "last_input_tokens": max(0, last_input),
        "last_output_tokens": max(0, last_output),
        "last_total_tokens": max(0, last_input + last_output),
        "context_used_tokens": max(0, context_used),
        "tokens_per_second": max(0.0, round(tokens_per_second, 1)),
        "raw_usage": usage,
    }


def _openwebui_db_candidates() -> list[Path]:
    candidates = [
        OPENWEBUI_DB,
        BASE / "open-webui-data" / "data" / "webui.db",
        BASE / "open-webui-data" / "backend" / "data" / "webui.db",
    ]

    data_dir = BASE / "open-webui-data"
    if data_dir.exists():
        for candidate in data_dir.rglob("webui.db"):
            if candidate not in candidates:
                candidates.append(candidate)

    return candidates


def get_latest_message_stats_from_db() -> dict | None:
    preferred_model_ids = {PRIMARY_MODEL_ID.lower(), "nemotron-3-nano:4b"}

    for db_path in _openwebui_db_candidates():
        if not db_path.exists():
            continue

        connection = None
        try:
            uri = db_path.resolve().as_uri() + "?mode=ro"
            connection = sqlite3.connect(uri, uri=True, timeout=2)
            connection.execute("PRAGMA query_only = ON")

            table_exists = connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_message' LIMIT 1"
            ).fetchone()
            if not table_exists:
                continue

            rows = connection.execute(
                """
                SELECT model_id, usage, created_at
                FROM chat_message
                WHERE role = 'assistant'
                  AND usage IS NOT NULL
                  AND TRIM(CAST(usage AS TEXT)) <> ''
                ORDER BY created_at DESC
                LIMIT 50
                """
            ).fetchall()

            parsed = []
            for model_id, usage_raw, created_at in rows:
                try:
                    usage = json.loads(usage_raw) if isinstance(usage_raw, str) else usage_raw
                except Exception:
                    continue

                metrics = _metrics_from_usage(usage, str(model_id or ""))
                if metrics:
                    parsed.append((str(model_id or ""), metrics, int(created_at or 0)))

            if not parsed:
                continue

            preferred = [
                item for item in parsed
                if item[0].lower() in preferred_model_ids
                or item[0].lower().startswith("nemotron-3-nano:4b")
            ]

            chosen = preferred[0] if preferred else parsed[0]
            result = chosen[1]
            result["source"] = "openwebui-sqlite"
            result["created_at"] = chosen[2]
            return result

        except Exception:
            continue
        finally:
            if connection is not None:
                try:
                    connection.close()
                except Exception:
                    pass

    return None


def _extract_message_usage(message: dict) -> dict | None:
    candidates = []

    direct_usage = message.get("usage")
    if isinstance(direct_usage, dict):
        candidates.append(direct_usage)

    info = message.get("info")
    if isinstance(info, dict):
        if isinstance(info.get("usage"), dict):
            candidates.append(info["usage"])
        candidates.append(info)

    meta = message.get("meta")
    if isinstance(meta, dict) and isinstance(meta.get("usage"), dict):
        candidates.append(meta["usage"])

    output = message.get("output")
    if isinstance(output, dict) and isinstance(output.get("usage"), dict):
        candidates.append(output["usage"])

    for candidate in candidates:
        metrics = _metrics_from_usage(candidate, str(message.get("model_id") or message.get("model") or ""))
        if metrics:
            return metrics

    return None


def get_latest_message_stats_from_api() -> dict | None:
    headers = get_openwebui_headers()
    try:
        chat_list = http_json(f"{OPENWEBUI_URL}/api/v1/chats/?page=1", headers=headers, timeout=10)
    except Exception:
        return None

    if isinstance(chat_list, dict):
        for key in ("items", "chats", "data"):
            if isinstance(chat_list.get(key), list):
                chat_list = chat_list[key]
                break

    if not isinstance(chat_list, list):
        return None

    candidates = []
    for chat_summary in chat_list[:10]:
        if not isinstance(chat_summary, dict):
            continue
        chat_id = chat_summary.get("id")
        if not chat_id:
            continue

        try:
            chat_data = http_json(
                f"{OPENWEBUI_URL}/api/v1/chats/{urllib.parse.quote(str(chat_id))}",
                headers=headers,
                timeout=10,
            )
        except Exception:
            continue

        containers = []
        if isinstance(chat_data, dict):
            containers.append(chat_data)
            chat_blob = chat_data.get("chat")
            if isinstance(chat_blob, dict):
                containers.append(chat_blob)

        messages = []
        for container in containers:
            history = container.get("history")
            if isinstance(history, dict):
                hm = history.get("messages")
                if isinstance(hm, dict):
                    messages.extend(hm.values())
                elif isinstance(hm, list):
                    messages.extend(hm)

            dm = container.get("messages")
            if isinstance(dm, dict):
                messages.extend(dm.values())
            elif isinstance(dm, list):
                messages.extend(dm)

        for message in messages:
            if not isinstance(message, dict) or message.get("role") != "assistant":
                continue
            metrics = _extract_message_usage(message)
            if not metrics:
                continue
            timestamp = _as_number(message.get("timestamp") or message.get("created_at") or message.get("updated_at"), 0.0)
            metrics["source"] = "openwebui-chat-api"
            metrics["created_at"] = int(timestamp)
            candidates.append(metrics)

    if not candidates:
        return None

    candidates.sort(key=lambda item: item.get("created_at", 0), reverse=True)
    return candidates[0]


def get_latest_message_stats() -> dict:
    stats = get_latest_message_stats_from_db()
    if stats is None:
        stats = get_latest_message_stats_from_api()

    if stats is None:
        return {
            "source": "none",
            "model_id": "",
            "last_input_tokens": 0,
            "last_output_tokens": 0,
            "last_total_tokens": 0,
            "context_used_tokens": 0,
            "tokens_per_second": 0.0,
            "created_at": 0,
        }

    return stats


def get_router_state() -> dict:
    try:
        data = json.loads(ROUTER_STATE_FILE.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except Exception:
        pass

    return {
        "active_model": "nemotron-3-nano:4b",
        "task": "GENERAL",
        "status": "idle",
    }


def get_ollama_status(active_model: str | None = None) -> dict:
    try:
        data = http_json(f"{OLLAMA_URL}/api/ps", timeout=3)
        models = data.get("models", [])

        selected = None

        if active_model:
            for model in models:
                name = str(model.get("name", ""))
                if name == active_model or name.startswith(active_model):
                    selected = model
                    break

        if selected is None:
            for model in models:
                name = str(model.get("name", ""))
                if name.startswith("nemotron-3-nano:4b"):
                    selected = model
                    break

        if selected is None and models:
            selected = models[0]

        if selected is None:
            return {
                "online": True,
                "model_loaded": False,
                "context": OLLAMA_CONTEXT_LENGTH,
            }

        return {
            "online": True,
            "model_loaded": True,
            "context": int(
                selected.get("context_length")
                or selected.get("context")
                or OLLAMA_CONTEXT_LENGTH
            ),
        }
    except Exception:
        return {
            "online": False,
            "model_loaded": False,
            "context": OLLAMA_CONTEXT_LENGTH,
        }


def build_stats_uncached() -> dict:
    now = datetime.now()
    today_string = now.strftime("%Y-%m-%d")

    usage = get_openwebui_usage()
    totals = usage.get("totals", {})

    today = {"tokens": 0, "messages": 0, "chats": 0}
    for row in usage.get("heatmap", []):
        if row.get("date") == today_string:
            today = {
                "tokens": int(row.get("tokens") or 0),
                "messages": int(row.get("messages") or 0),
                "chats": int(row.get("chats") or 0),
            }
            break

    model_stats = {
        "model_id": PRIMARY_MODEL_ID,
        "messages": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "total_tokens": 0,
    }
    for model in usage.get("top_models", []):
        if model.get("model_id") == PRIMARY_MODEL_ID:
            model_stats = model
            break

    router = get_router_state()
    active_model = str(router.get("active_model") or "nemotron-3-nano:4b")
    active_task = str(router.get("task") or "GENERAL").upper()

    ollama = get_ollama_status(active_model)
    latest = get_latest_message_stats()

    lifetime = int(totals.get("lifetime_tokens") or 0)
    total_input = int(totals.get("input_tokens") or 0)
    total_output = int(totals.get("output_tokens") or 0)

    context_max = int(ollama["context"] or OLLAMA_CONTEXT_LENGTH)
    context_used = int(latest.get("context_used_tokens") or 0)
    context_percent = min(100.0, (context_used / context_max) * 100.0) if context_max > 0 else 0.0

    active_model_name = ROUTER_MODEL_NAMES.get(active_model, active_model.upper())
    model_display = f"{active_model_name} Â· {active_task}"

    return {
        "status": "ONLINE" if ollama["online"] else "OFFLINE",
        "model": model_display,
        "model_id": active_model,
        "router_task": active_task,
        "total_input_tokens": total_input,
        "total_output_tokens": total_output,
        "lifetime_tokens": lifetime,
        "today_tokens": int(today["tokens"]),
        "today_messages": int(today["messages"]),
        "today_chats": int(today["chats"]),
        "model_input_tokens": int(model_stats.get("input_tokens") or 0),
        "model_output_tokens": int(model_stats.get("output_tokens") or 0),
        "model_total_tokens": int(model_stats.get("total_tokens") or 0),
        "last_input_tokens": int(latest.get("last_input_tokens") or 0),
        "last_output_tokens": int(latest.get("last_output_tokens") or 0),
        "last_total_tokens": int(latest.get("last_total_tokens") or 0),
        "context_used_tokens": context_used,
        "context_max_tokens": context_max,
        "context_percent": round(context_percent, 1),
        "tokens_per_second": float(latest.get("tokens_per_second") or 0.0),
        "last_stats_source": str(latest.get("source") or "none"),
        "model_loaded": bool(ollama["model_loaded"]),
        "updated": now.strftime("%H:%M:%S"),
    }


def build_stats() -> dict:
    now = time.monotonic()

    cached = _stats_cache.get("data")
    cached_time = float(_stats_cache.get("time") or 0.0)

    if cached is not None and (now - cached_time) < STATS_CACHE_SECONDS:
        return cached

    data = build_stats_uncached()
    _stats_cache["time"] = now
    _stats_cache["data"] = data
    return data


def compact_number(value: int) -> str:
    value = int(value)

    if value >= 1_000_000:
        return f"{value / 1_000_000:.1f}M"
    if value >= 1_000:
        return f"{value / 1_000:.1f}K"
    return str(value)


# ============================================================
# HEALTH + WCKD STATS
# ============================================================

@app.get("/health", operation_id="health_check")
def health_check():
    """Check that the WCKD AI local tool server is running."""
    return {
        "status": "ok",
        "version": app.version,
        "workspace": str(BASE),
        "powershell_mode": "read-only allowlist",
    }


@app.get("/stats", operation_id="get_wckd_stats")
def get_wckd_stats():
    """Return WCKD AI/Open WebUI usage statistics as JSON."""
    try:
        return build_stats()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc))


@app.get(
    "/stats/rainmeter",
    response_class=PlainTextResponse,
    include_in_schema=False,
)
def rainmeter_stats():
    """Pipe-delimited WCKD AI stats for Rainmeter."""
    try:
        stats = build_stats()
        return "|".join(
            [
                stats["status"],
                stats["model"],
                compact_number(stats["total_input_tokens"]),
                compact_number(stats["total_output_tokens"]),
                compact_number(stats["today_tokens"]),
                compact_number(stats["lifetime_tokens"]),
                compact_number(stats["model_total_tokens"]),
                compact_number(stats["context_max_tokens"]),
                f'{stats["tokens_per_second"]:.1f}',
                stats["updated"],
                compact_number(stats["last_input_tokens"]),
                compact_number(stats["last_output_tokens"]),
                compact_number(stats["last_total_tokens"]),
                compact_number(stats["context_used_tokens"]),
                f'{stats["context_percent"]:.1f}',
            ]
        )
    except Exception:
        return "OFFLINE|WCKD AI|0|0|0|0|0|32.8K|0.0|--:--:--|0|0|0|0|0.0"


@app.get("/stats/last", operation_id="get_last_generation_stats")
def get_last_generation_stats():
    """Return diagnostic statistics for the newest WCKD AI response."""
    try:
        stats = build_stats()
        return {
            "last_input_tokens": stats["last_input_tokens"],
            "last_output_tokens": stats["last_output_tokens"],
            "last_total_tokens": stats["last_total_tokens"],
            "context_used_tokens": stats["context_used_tokens"],
            "context_max_tokens": stats["context_max_tokens"],
            "context_percent": stats["context_percent"],
            "tokens_per_second": stats["tokens_per_second"],
            "source": stats["last_stats_source"],
            "updated": stats["updated"],
        }
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc))


# ============================================================
# ============================================================





# ============================================================
# FILESYSTEM TOOLS
# ============================================================

@app.post("/list", operation_id="list_files")
def list_files(req: PathRequest):
    """List files and directories inside D:\\ai."""
    path = safe_path(req.path)

    if not path.exists():
        raise HTTPException(status_code=404, detail="Path not found")

    if not path.is_dir():
        raise HTTPException(status_code=400, detail="Path is not a directory")

    items = []

    for item in sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
        try:
            stat = item.stat()
            size = stat.st_size if item.is_file() else None
        except OSError:
            size = None

        items.append(
            {
                "name": item.name,
                "path": relative_display(item),
                "type": "directory" if item.is_dir() else "file",
                "size": size,
            }
        )

    return {
        "path": relative_display(path),
        "items": items,
    }


@app.post("/list_recursive", operation_id="list_files_recursive")
def list_files_recursive(req: PathRequest):
    """Recursively list files and folders inside a workspace directory."""
    path = safe_path(req.path)

    if not path.exists():
        raise HTTPException(status_code=404, detail="Path not found")

    if not path.is_dir():
        raise HTTPException(status_code=400, detail="Path is not a directory")

    items = []
    count = 0

    for item in path.rglob("*"):
        if count >= 1000:
            break

        items.append(
            {
                "path": relative_display(item),
                "type": "directory" if item.is_dir() else "file",
            }
        )
        count += 1

    return {
        "path": relative_display(path),
        "count": len(items),
        "truncated": count >= 1000,
        "items": items,
    }


@app.post("/read", operation_id="read_file")
def read_file(req: ReadRequest):
    """Read a UTF-8 text file inside D:\\ai."""
    path = safe_path(req.path)

    if not path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    if not path.is_file():
        raise HTTPException(status_code=400, detail="Path is not a file")

    ensure_text_file(path)

    size = path.stat().st_size
    if size > MAX_READ_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File is too large to read through this tool ({size} bytes)",
        )

    try:
        content = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        raise HTTPException(status_code=415, detail="File is not valid UTF-8 text")

    return {
        "path": relative_display(path),
        "size": size,
        "content": content,
    }


@app.post("/write", operation_id="write_file")
def write_file(req: WriteRequest):
    """Create or replace a UTF-8 text file inside D:\\ai."""
    path = safe_path(req.path)
    ensure_text_file(path)

    payload = req.content.encode("utf-8")
    if len(payload) > MAX_WRITE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Content is too large to write ({len(payload)} bytes)",
        )

    if path.exists() and not req.overwrite:
        raise HTTPException(status_code=409, detail="File already exists")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(req.content, encoding="utf-8")

    return {
        "status": "written",
        "path": relative_display(path),
        "bytes": len(payload),
    }


@app.post("/mkdir", operation_id="create_directory")
def create_directory(req: DirectoryRequest):
    """Create a directory, including parent directories, inside D:\\ai."""
    path = safe_path(req.path)

    if path.exists() and not path.is_dir():
        raise HTTPException(
            status_code=409,
            detail="A file already exists at that path",
        )

    path.mkdir(parents=True, exist_ok=True)

    return {
        "status": "created",
        "path": relative_display(path),
    }


@app.post("/move", operation_id="move_or_rename")
def move_or_rename(req: MoveRequest):
    """Move or rename a file or directory inside D:\\ai."""
    source = safe_path(req.source)
    destination = safe_path(req.destination)

    if not source.exists():
        raise HTTPException(status_code=404, detail="Source path not found")

    if source == BASE:
        raise HTTPException(status_code=403, detail="The workspace root cannot be moved")

    if destination.exists():
        if destination.is_dir():
            raise HTTPException(
                status_code=409,
                detail=(
                    "Destination directory already exists; "
                    "directory overwrite is disabled"
                ),
            )

        if not req.overwrite:
            raise HTTPException(status_code=409, detail="Destination file already exists")

        destination.unlink()

    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(source), str(destination))

    return {
        "status": "moved",
        "source": req.source,
        "destination": relative_display(destination),
    }


@app.post("/search", operation_id="search_text")
def search_text(req: SearchRequest):
    """Search for text inside workspace text files."""
    root = safe_path(req.path)

    if not root.exists():
        raise HTTPException(status_code=404, detail="Search path not found")

    if not root.is_dir():
        raise HTTPException(status_code=400, detail="Search path is not a directory")

    iterator = root.rglob(req.glob) if req.recursive else root.glob(req.glob)
    needle = req.query.casefold()
    results = []

    for file_path in iterator:
        if len(results) >= req.max_results:
            break

        if not file_path.is_file():
            continue

        if file_path.suffix.lower() not in TEXT_EXTENSIONS:
            continue

        try:
            if file_path.stat().st_size > MAX_SEARCH_FILE_BYTES:
                continue

            text = file_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue

        for line_number, line in enumerate(text.splitlines(), start=1):
            if needle in line.casefold():
                results.append(
                    {
                        "path": relative_display(file_path),
                        "line": line_number,
                        "text": line[:500],
                    }
                )

                if len(results) >= req.max_results:
                    break

    return {
        "query": req.query,
        "path": relative_display(root),
        "count": len(results),
        "results": results,
    }


# ============================================================
# READ-ONLY POWERSHELL
# ============================================================

@app.post(
    "/powershell/read-only",
    operation_id="run_powershell_readonly",
)
def run_powershell_readonly(req: PowerShellRequest):
    """Run an approved read-only PowerShell inspection command."""
    detected_commands = validate_powershell(req.command)

    try:
        result = subprocess.run(
            [
                "powershell.exe",
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                req.command,
            ],
            cwd=str(BASE),
            capture_output=True,
            text=True,
            timeout=req.timeout_seconds,
            encoding="utf-8",
            errors="replace",
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(
            status_code=408,
            detail=f"PowerShell command exceeded {req.timeout_seconds} seconds",
        )

    stdout = result.stdout[-50000:]
    stderr = result.stderr[-20000:]

    return {
        "command": req.command,
        "approved_commands": detected_commands,
        "exit_code": result.returncode,
        "stdout": stdout,
        "stderr": stderr,
    }

# === WCKD_WEB_SEARCH_V1_BEGIN ===
# WCKD Tools extension installed by WCKD Control Center v0.9.3.
# Web Search v1.1.0: normalized relevance guard + decoded Bing target URLs.

import base64 as _wckd_web_base64
import html as _wckd_web_html
import re as _wckd_web_re
import urllib.parse as _wckd_web_parse
import urllib.request as _wckd_web_request
from datetime import datetime as _wckd_web_datetime
from fastapi import HTTPException as _wckd_web_HTTPException


def _wckd_web_clean_html(value):
    text = _wckd_web_re.sub(r"<script\b[^>]*>.*?</script>", " ", str(value or ""), flags=_wckd_web_re.I | _wckd_web_re.S)
    text = _wckd_web_re.sub(r"<style\b[^>]*>.*?</style>", " ", text, flags=_wckd_web_re.I | _wckd_web_re.S)
    text = _wckd_web_re.sub(r"<[^>]+>", " ", text)
    text = _wckd_web_html.unescape(text)
    return _wckd_web_re.sub(r"\s+", " ", text).strip()


def _wckd_web_fetch(url):
    request = _wckd_web_request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) WCKD-WebSearch/1.1",
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9,ro;q=0.8",
        },
    )
    with _wckd_web_request.urlopen(request, timeout=12) as response:
        return response.read().decode("utf-8", errors="replace")


def _wckd_web_decode_ddg_url(value):
    url = _wckd_web_html.unescape(str(value or ""))
    if url.startswith("//"):
        url = "https:" + url

    try:
        parsed = _wckd_web_parse.urlparse(url)
        query = _wckd_web_parse.parse_qs(parsed.query)
        uddg = query.get("uddg")
        if uddg:
            return _wckd_web_parse.unquote(uddg[0])
    except Exception:
        pass

    return url


def _wckd_web_decode_bing_url(value):
    url = _wckd_web_html.unescape(str(value or "")).strip()

    try:
        parsed = _wckd_web_parse.urlparse(url)

        if "bing.com" not in parsed.netloc.lower():
            return url

        params = _wckd_web_parse.parse_qs(parsed.query)
        encoded = (params.get("u") or [""])[0]

        # Bing currently wraps target URLs as u=a1<base64>.
        if encoded.startswith("a1") and len(encoded) > 2:
            payload = encoded[2:]
            padding = "=" * ((4 - (len(payload) % 4)) % 4)
            decoded = _wckd_web_base64.urlsafe_b64decode(payload + padding).decode("utf-8", errors="strict")
            if decoded.startswith(("http://", "https://")):
                return decoded

        if encoded.startswith(("http://", "https://")):
            return encoded
    except Exception:
        pass

    return url


_WCKD_WEB_STOPWORDS = {
    "ce", "este", "e", "cine", "inseamna", "Ã®nseamnÄƒ", "care", "ultima", "ultimul",
    "versiune", "versiunea", "latest", "current", "what", "is", "who", "does",
    "the", "a", "an", "of", "for", "and", "or", "pe", "in", "Ã®n", "la",
    "online", "web", "internet", "te", "rog",
}


def _wckd_web_tokens(query):
    words = _wckd_web_re.findall(r"[A-Za-z0-9Ã€-Ã¿._+-]+", str(query or "").lower())
    return [
        word for word in words
        if len(word) >= 3 and word not in _WCKD_WEB_STOPWORDS
    ]


def _wckd_web_is_relevant(query, item):
    tokens = _wckd_web_tokens(query)
    if not tokens:
        return True

    haystack = " ".join([
        str(item.get("title") or ""),
        str(item.get("url") or ""),
        str(item.get("snippet") or ""),
    ]).lower()

    # For a single entity term such as "Godot", require that exact term.
    if len(tokens) == 1:
        return tokens[0] in haystack

    hits = sum(1 for token in tokens if token in haystack)
    return hits >= 1


def _wckd_web_parse_duckduckgo(raw, limit):
    results = []
    seen = set()

    links = list(_wckd_web_re.finditer(
        r'<a[^>]*class=["\'][^"\']*result__a[^"\']*["\'][^>]*href=["\']([^"\']+)["\'][^>]*>(.*?)</a>',
        raw,
        flags=_wckd_web_re.I | _wckd_web_re.S,
    ))

    for index, match in enumerate(links):
        url = _wckd_web_decode_ddg_url(match.group(1))
        if not url.startswith(("http://", "https://")):
            continue
        if "duckduckgo.com" in _wckd_web_parse.urlparse(url).netloc.lower():
            continue
        if url in seen:
            continue

        title = _wckd_web_clean_html(match.group(2))
        after_start = match.end()
        after_end = links[index + 1].start() if index + 1 < len(links) else min(len(raw), after_start + 5000)
        block = raw[after_start:after_end]

        snippet_match = _wckd_web_re.search(
            r'class=["\'][^"\']*result__snippet[^"\']*["\'][^>]*>(.*?)</(?:a|div|span)>',
            block,
            flags=_wckd_web_re.I | _wckd_web_re.S,
        )
        snippet = _wckd_web_clean_html(snippet_match.group(1)) if snippet_match else ""

        item = {
            "title": title or url,
            "url": url,
            "snippet": snippet,
        }

        if not _wckd_web_is_relevant(query=_wckd_web_active_query, item=item):
            continue

        results.append(item)
        seen.add(url)

        if len(results) >= limit:
            break

    return results


def _wckd_web_parse_bing(raw, limit):
    results = []
    seen = set()

    blocks = _wckd_web_re.findall(
        r'<li[^>]*class=["\'][^"\']*b_algo[^"\']*["\'][^>]*>(.*?)</li>',
        raw,
        flags=_wckd_web_re.I | _wckd_web_re.S,
    )

    for block in blocks:
        link = _wckd_web_re.search(
            r'<h2[^>]*>\s*<a[^>]*href=["\']([^"\']+)["\'][^>]*>(.*?)</a>',
            block,
            flags=_wckd_web_re.I | _wckd_web_re.S,
        )
        if not link:
            continue

        url = _wckd_web_decode_bing_url(link.group(1))
        if not url.startswith(("http://", "https://")):
            continue
        if "bing.com" in _wckd_web_parse.urlparse(url).netloc.lower():
            continue
        if url in seen:
            continue

        snippet_match = _wckd_web_re.search(
            r'<p[^>]*>(.*?)</p>',
            block,
            flags=_wckd_web_re.I | _wckd_web_re.S,
        )

        item = {
            "title": _wckd_web_clean_html(link.group(2)) or url,
            "url": url,
            "snippet": _wckd_web_clean_html(snippet_match.group(1)) if snippet_match else "",
        }

        if not _wckd_web_is_relevant(query=_wckd_web_active_query, item=item):
            continue

        results.append(item)
        seen.add(url)

        if len(results) >= limit:
            break

    return results


_wckd_web_active_query = ""


def _wckd_web_search_impl(query, limit=5):
    global _wckd_web_active_query

    query = str(query or "").strip()
    if not query:
        raise ValueError("query is required")

    limit = max(1, min(int(limit or 5), 10))
    errors = []
    _wckd_web_active_query = query

    providers = [
        (
            "duckduckgo",
            "https://html.duckduckgo.com/html/?q=" + _wckd_web_parse.quote_plus(query),
            _wckd_web_parse_duckduckgo,
        ),
        (
            "bing",
            "https://www.bing.com/search?q=" + _wckd_web_parse.quote_plus(query),
            _wckd_web_parse_bing,
        ),
    ]

    for provider, url, parser in providers:
        try:
            raw = _wckd_web_fetch(url)
            results = parser(raw, limit)
            if results:
                return {
                    "status": "ok",
                    "web_search_version": "1.1.0",
                    "query": query,
                    "provider": provider,
                    "count": len(results),
                    "results": results,
                    "searched_at": _wckd_web_datetime.now().astimezone().isoformat(timespec="seconds"),
                }
            errors.append(provider + ": no relevant parseable results")
        except Exception as exc:
            errors.append(provider + ": " + str(exc))

    return {
        "status": "error",
        "web_search_version": "1.1.0",
        "query": query,
        "provider": None,
        "count": 0,
        "results": [],
        "errors": errors,
        "searched_at": _wckd_web_datetime.now().astimezone().isoformat(timespec="seconds"),
    }


@app.get("/web/health")
def wckd_web_health():
    return {
        "status": "ok",
        "web_search_version": "1.1.0",
        "providers": ["duckduckgo", "bing"],
        "api_key_required": False,
        "bing_redirect_decode": True,
        "relevance_filter": True,
    }


@app.get("/web/search")
def wckd_web_search_get(q: str, limit: int = 5):
    result = _wckd_web_search_impl(q, limit)
    if result.get("status") != "ok":
        raise _wckd_web_HTTPException(status_code=502, detail=result)
    return result


@app.post("/web/search")
def wckd_web_search_post(body: dict):
    result = _wckd_web_search_impl(body.get("query"), body.get("limit", 5))
    if result.get("status") != "ok":
        raise _wckd_web_HTTPException(status_code=502, detail=result)
    return result


@app.get("/web/tool")
def wckd_web_tool_descriptor():
    return {
        "name": "web_search",
        "description": "Search the public web and return relevant normalized title, direct URL and snippet results.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 10},
            },
            "required": ["query"],
        },
        "endpoint": "/web/search",
        "method": "POST",
    }

# === WCKD_WEB_SEARCH_V1_END ===
