from __future__ import annotations

import json
import os
import queue
import shlex
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException

VERSION = "1.2.3"

AI_ROOT = Path(__file__).resolve().parent
ORCH_ROOT = AI_ROOT / "orchestrator"
JOBS_DIR = ORCH_ROOT / "jobs"
LOGS_DIR = ORCH_ROOT / "logs"

ROUTER_BASE_URL = "http://127.0.0.1:8002"
RUNNER_BASE_URL = "http://127.0.0.1:8030"
REGISTRY_BASE_URL = "http://127.0.0.1:8050"
MEMORY_BASE_URL = "http://127.0.0.1:8070"
LAB_BASE_URL = "http://127.0.0.1:8020"

MAX_STAGES = 8
MAX_CONTEXT_CHARS = 24000
MAX_QUEUE = 20
POLL_SECONDS = 2

PERSIST_REPLACE_RETRIES = 12
PERSIST_RETRY_BASE_SECONDS = 0.05
PERSIST_DIRECT_RETRIES = 6

TERMINAL_STATES = {
    "completed",
    "failed",
    "cancelled",
    "interrupted",
}

RUNNER_TERMINAL = {
    "completed",
    "blocked",
    "failed",
    "cancelled",
    "timeout",
    "step_limit",
    "stalled",
    "interrupted",
}

DEFAULT_STAGES = [
    {
        "id": "plan",
        "type": "chat",
        "specialist": "REASONING",
        "instruction": (
            "Create a concise execution plan for the objective. "
            "Focus on concrete steps, verification, and likely failure points."
        ),
    },
    {
        "id": "execute",
        "type": "agent",
        "specialist": "AGENTIC",
        "instruction": (
            "Execute the objective in WCKD-LAB. Use the previous plan as guidance. "
            "Do not finish until the requested work is verified by a successful tool turn. "
            "The Orchestrator preflights the workspace before Runner starts. "
            "For filesystem work, do not probe a missing workspace; use the provided workspace "
            "and read back or inspect the final artifact before completion."
        ),
    },
    {
        "id": "review",
        "type": "chat",
        "specialist": "REASONING",
        "instruction": (
            "Review the execution result and the WCKD EXECUTION EVIDENCE packet. "
            "Treat a Verification gate: PASS plus successful Runner audit events as direct "
            "execution evidence. State what completed, what was verified, and any remaining "
            "issue. Do not claim evidence is missing when the packet documents it, and do "
            "not invent details beyond the packet."
        ),
    },
]

ROLE_PREFIX = {
    "GENERAL": "/balanced",
    "CODE": "/code",
    "REASONING": "/smart",
    "WRITING": "/write",
    "TOOLS": "/tools",
    "AGENTIC": "/agentic",
}

_lock = threading.RLock()
_work_queue: queue.Queue[str] = queue.Queue(maxsize=MAX_QUEUE)
_worker_started = False
_active_job_id: str | None = None


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _job_path(job_id: str) -> Path:
    return JOBS_DIR / f"{job_id}.json"


def _log_path(job_id: str) -> Path:
    return LOGS_DIR / f"{job_id}.jsonl"


def _ensure_dirs() -> None:
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    LOGS_DIR.mkdir(parents=True, exist_ok=True)


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    """
    Persist JSON robustly on Windows.

    Transient antivirus/indexer/read locks may cause atomic replacement to fail
    with PermissionError / WinError 5. Use a unique temp file plus retry/backoff.
    If replacement stays blocked, fall back to a guarded direct overwrite.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    last_error: Exception | None = None

    try:
        tmp.write_text(serialized, encoding="utf-8")

        for attempt in range(PERSIST_REPLACE_RETRIES):
            try:
                os.replace(tmp, path)
                return
            except PermissionError as exc:
                last_error = exc
                time.sleep(PERSIST_RETRY_BASE_SECONDS * (attempt + 1))

        # _save_job() holds _lock, and API readers use _read_json_file().
        for attempt in range(PERSIST_DIRECT_RETRIES):
            try:
                path.write_text(serialized, encoding="utf-8")
                return
            except PermissionError as exc:
                last_error = exc
                time.sleep(PERSIST_RETRY_BASE_SECONDS * (attempt + 1))

        if last_error is not None:
            raise last_error

        raise RuntimeError(f"Could not persist orchestration state: {path}")
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except Exception:
            pass


def _read_json_file(path: Path) -> Any:
    with _lock:
        return json.loads(path.read_text(encoding="utf-8-sig"))


def _audit(job_id: str, event: str, **fields: Any) -> None:
    record = {
        "ts": _now_iso(),
        "event": event,
        "job_id": job_id,
        **fields,
    }
    path = _log_path(job_id)
    with _lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def _load_job(job_id: str) -> dict[str, Any]:
    path = _job_path(job_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Unknown orchestration job: {job_id}")

    try:
        payload = _read_json_file(path)
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Cannot read orchestration job {job_id}: {exc}",
        ) from exc

    if not isinstance(payload, dict):
        raise HTTPException(status_code=500, detail=f"Invalid job state: {job_id}")

    return payload


def _save_job(job: dict[str, Any]) -> None:
    job["updated"] = _now_iso()
    with _lock:
        _atomic_write_json(_job_path(str(job["job_id"])), job)


def _http_json(
    url: str,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    timeout: int = 30,
) -> dict[str, Any]:
    data = None
    headers = {"Accept": "application/json"}

    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers=headers,
    )

    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read().decode("utf-8", errors="replace")
        except Exception:
            detail = ""
        raise RuntimeError(
            f"HTTP {exc.code} from {url}: {detail or exc.reason}"
        ) from exc
    except Exception as exc:
        raise RuntimeError(f"Request failed for {url}: {exc}") from exc

    try:
        parsed = json.loads(raw or "{}")
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid JSON from {url}") from exc

    if not isinstance(parsed, dict):
        raise RuntimeError(f"Non-object JSON from {url}")

    return parsed


def _service_health(url: str) -> dict[str, Any]:
    try:
        payload = _http_json(url, timeout=5)
        return {
            "available": True,
            "status": payload.get("status"),
            "version": payload.get("version"),
        }
    except Exception as exc:
        return {
            "available": False,
            "error": str(exc),
        }


def _resolve_specialist(role: str) -> dict[str, Any]:
    role = str(role or "").strip().upper()
    if role not in ROLE_PREFIX:
        raise RuntimeError(f"Unsupported specialist role: {role}")

    payload = _http_json(
        REGISTRY_BASE_URL
        + "/resolve/"
        + urllib.parse.quote(role, safe=""),
        timeout=10,
    )

    resolution = payload.get("resolution")
    if not isinstance(resolution, dict):
        raise RuntimeError(f"Registry returned no resolution for {role}")

    if resolution.get("enabled") is False:
        raise RuntimeError(f"Specialist {role} is disabled.")

    if resolution.get("model_available") is not True:
        raise RuntimeError(f"Specialist {role} has no available model.")

    return resolution


def _chat_completion(
    role: str,
    instruction: str,
    objective: str,
    previous_output: str,
    memory_context: str = "",
) -> dict[str, Any]:
    resolution = _resolve_specialist(role)
    route_mode = str(resolution.get("route_mode") or ROLE_PREFIX[role])
    previous = previous_output[-MAX_CONTEXT_CHARS:] if previous_output else "(none)"
    memory = memory_context[-MAX_CONTEXT_CHARS:] if memory_context else "(none)"

    user_prompt = (
        f"{route_mode}\n"
        f"ORIGINAL OBJECTIVE:\n{objective}\n\n"
        f"PROJECT MEMORY CONTEXT:\n{memory}\n\n"
        f"STAGE INSTRUCTION:\n{instruction}\n\n"
        f"PREVIOUS STAGE OUTPUT:\n{previous}"
    )

    payload = {
        "model": "wckd-auto",
        "stream": False,
        "temperature": resolution.get("temperature", 0.3),
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are one specialist stage inside WCKD Agent Orchestrator. "
                    "Complete only this stage. Be concrete and preserve factual uncertainty."
                ),
            },
            {
                "role": "user",
                "content": user_prompt,
            },
        ],
    }

    response = _http_json(
        ROUTER_BASE_URL + "/v1/chat/completions",
        method="POST",
        payload=payload,
        timeout=900,
    )

    choices = response.get("choices") or []
    if not choices or not isinstance(choices[0], dict):
        raise RuntimeError("Router returned no chat completion choice.")

    message = choices[0].get("message") or {}
    content = message.get("content")

    if not isinstance(content, str) or not content.strip():
        raise RuntimeError("Router returned an empty specialist response.")

    return {
        "output": content.strip(),
        "model": resolution.get("selected_model"),
        "specialist": role,
        "route_mode": route_mode,
    }


def _runner_result_text(result: dict[str, Any]) -> str:
    for key in ("final_response", "message", "result"):
        value = result.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return json.dumps(result, ensure_ascii=False)


def _evidence_value(value: Any, max_chars: int = 1200) -> Any:
    if isinstance(value, str):
        text = value.strip()
        if len(text) > max_chars:
            return text[:max_chars] + "...[truncated]"
        return text

    if isinstance(value, (int, float, bool)) or value is None:
        return value

    try:
        text = json.dumps(value, ensure_ascii=False)
    except Exception:
        text = str(value)

    if len(text) > max_chars:
        text = text[:max_chars] + "...[truncated]"

    return text


def _runner_audit_evidence(runner_job_id: str, tail: int = 60) -> dict[str, Any]:
    try:
        payload = _http_json(
            RUNNER_BASE_URL
            + "/agent/log/"
            + urllib.parse.quote(runner_job_id, safe="")
            + f"?tail={max(10, min(int(tail), 200))}",
            timeout=20,
        )
    except Exception as exc:
        return {
            "source": "unavailable",
            "job_status": None,
            "events": [],
            "error": str(exc),
        }

    events = payload.get("events") or []
    if not isinstance(events, list):
        events = []

    allowed_events = {
        "tool_call",
        "tool_result",
        "verification_tool_turn",
        "job_completed",
    }

    compact: list[dict[str, Any]] = []
    preferred_keys = (
        "ts",
        "event",
        "step",
        "tool",
        "ok",
        "command",
        "path",
        "cwd",
        "exit_code",
        "stdout",
        "stderr",
        "result",
        "error",
        "message",
    )

    for item in events:
        if not isinstance(item, dict):
            continue

        if str(item.get("event") or "") not in allowed_events:
            continue

        record: dict[str, Any] = {}
        for key in preferred_keys:
            if key in item:
                record[key] = _evidence_value(item.get(key))

        if record:
            compact.append(record)

    return {
        "source": payload.get("source"),
        "job_status": payload.get("job_status"),
        "events": compact[-16:],
        "error": None,
    }


def _execution_evidence_packet(
    runner_job_id: str,
    status: dict[str, Any],
    audit: dict[str, Any],
) -> str:
    verification_success = status.get("verification_success_seen") is True
    verification_failure = status.get("verification_failure_seen") is True
    successful_tools = int(status.get("successful_tool_results") or 0)
    failed_tools = int(status.get("failed_tool_results") or 0)

    lines = [
        "WCKD EXECUTION EVIDENCE",
        f"Runner job: {runner_job_id}",
        f"Runner status: {status.get('status')}",
        "Verification gate: PASS",
        f"verification_success_seen: {str(verification_success).lower()}",
        f"verification_failure_seen: {str(verification_failure).lower()}",
        f"successful_tool_results: {successful_tools}",
        f"failed_tool_results: {failed_tools}",
        f"audit_source: {audit.get('source') or 'unknown'}",
        f"audit_job_status: {audit.get('job_status') or 'unknown'}",
        "Audit evidence events:",
    ]

    events = audit.get("events") or []
    if events:
        for item in events:
            lines.append("- " + json.dumps(item, ensure_ascii=False))
    else:
        lines.append("- No audit events were returned by the log API.")

    if audit.get("error"):
        lines.append(f"audit_error: {audit.get('error')}")

    lines.append("END WCKD EXECUTION EVIDENCE")
    return "\n".join(lines)



def _workspace_preflight(
    job: dict[str, Any],
    stage: dict[str, Any],
    workspace: str,
) -> dict[str, Any]:
    quoted = shlex.quote(workspace)

    command = (
        f"if [ -d {quoted} ]; then "
        "printf 'exists'; "
        "else "
        f"mkdir -p -- {quoted} && test -d {quoted} && printf 'created'; "
        "fi"
    )

    result = _http_json(
        LAB_BASE_URL + "/lab/exec",
        method="POST",
        payload={
            "command": command,
            "cwd": "/",
            "timeout_seconds": 30,
        },
        timeout=45,
    )

    exit_code = int(result.get("exit_code") or 0)
    stdout = str(result.get("stdout") or "").strip()
    stderr = str(result.get("stderr") or "").strip()

    if exit_code != 0:
        raise RuntimeError(
            "WORKSPACE_PREFLIGHT_FAILED: "
            f"workspace={workspace} exit_code={exit_code} stderr={stderr}"
        )

    state = stdout if stdout in {"exists", "created"} else "ready"

    preflight = {
        "workspace": workspace,
        "state": state,
        "exit_code": exit_code,
        "verified": True,
        "stdout": stdout,
        "stderr": stderr,
    }

    job["workspace_preflight"] = preflight
    _save_job(job)
    _audit(
        str(job["job_id"]),
        "workspace_preflight",
        stage_id=stage["id"],
        workspace=workspace,
        state=state,
        exit_code=exit_code,
        verified=True,
    )

    return preflight


def _agent_stage(
    job: dict[str, Any],
    stage: dict[str, Any],
    previous_output: str,
    memory_context: str = "",
) -> dict[str, Any]:
    role = str(stage["specialist"]).upper()
    if role != "AGENTIC":
        raise RuntimeError("Agent stages currently require specialist=AGENTIC.")

    resolution = _resolve_specialist(role)

    objective = str(job["objective"])
    workspace = str(job["workspace"])
    previous = previous_output[-MAX_CONTEXT_CHARS:] if previous_output else "(none)"
    memory = memory_context[-MAX_CONTEXT_CHARS:] if memory_context else "(none)"
    instruction = str(stage["instruction"])

    workspace_preflight = _workspace_preflight(
        job,
        stage,
        workspace,
    )

    agent_objective = (
        "You are the execution stage of WCKD Agent Orchestrator.\n"
        f"Work only inside this workspace: {workspace}\n"
        "Workspace preflight: READY. The workspace already exists; do not test for its "
        "existence by listing a missing parent first.\n\n"
        f"ORIGINAL OBJECTIVE:\n{objective}\n\n"
        f"PROJECT MEMORY CONTEXT:\n{memory}\n\n"
        f"STAGE INSTRUCTION:\n{instruction}\n\n"
        f"PREVIOUS STAGE OUTPUT:\n{previous}\n\n"
        "Perform the requested work, use WCKD-LAB tools as needed, and verify the result "
        "before declaring completion."
    )

    start = _http_json(
        RUNNER_BASE_URL + "/agent/start",
        method="POST",
        payload={
            "objective": agent_objective,
            "workspace": workspace,
            "max_steps": int(stage.get("max_steps") or job.get("agent_max_steps") or 90),
            "max_minutes": int(stage.get("max_minutes") or job.get("agent_max_minutes") or 30),
        },
        timeout=30,
    )

    runner_job_id = str(start.get("job_id") or "")
    if not runner_job_id:
        raise RuntimeError("Agent Runner did not return a job_id.")

    job["active_runner_job_id"] = runner_job_id
    _save_job(job)
    _audit(
        str(job["job_id"]),
        "runner_started",
        stage_id=stage["id"],
        runner_job_id=runner_job_id,
    )

    deadline = time.monotonic() + (
        int(stage.get("max_minutes") or job.get("agent_max_minutes") or 30) * 60
    ) + 60

    status: dict[str, Any] | None = None

    while time.monotonic() < deadline:
        current = _load_job(str(job["job_id"]))
        if current.get("cancel_requested"):
            try:
                _http_json(
                    RUNNER_BASE_URL
                    + "/agent/cancel/"
                    + urllib.parse.quote(runner_job_id, safe=""),
                    method="POST",
                    payload={},
                    timeout=15,
                )
            except Exception:
                pass
            raise RuntimeError("ORCHESTRATOR_CANCELLED")

        time.sleep(POLL_SECONDS)
        status = _http_json(
            RUNNER_BASE_URL
            + "/agent/status/"
            + urllib.parse.quote(runner_job_id, safe=""),
            timeout=20,
        )

        job["runner_status"] = {
            "job_id": runner_job_id,
            "status": status.get("status"),
            "step": status.get("step"),
            "max_steps": status.get("max_steps"),
            "last_activity": status.get("last_activity"),
            "last_model": status.get("last_model"),
            "successful_tool_results": status.get("successful_tool_results"),
            "failed_tool_results": status.get("failed_tool_results"),
            "verification_success_seen": status.get("verification_success_seen"),
            "verification_failure_seen": status.get("verification_failure_seen"),
        }
        _save_job(job)

        if str(status.get("status")) in RUNNER_TERMINAL:
            break

    if not status:
        raise RuntimeError("Agent Runner returned no status.")

    runner_status = str(status.get("status"))
    if runner_status != "completed":
        raise RuntimeError(
            f"Agent Runner ended as {runner_status}: {status.get('last_error')}"
        )

    verification_success = status.get("verification_success_seen") is True
    verification_failure = status.get("verification_failure_seen") is True
    successful_tools = int(status.get("successful_tool_results") or 0)

    if not verification_success:
        raise RuntimeError(
            "VERIFICATION_GATE_FAILED: Agent Runner completed without a successful "
            "verification-tool turn."
        )

    if verification_failure:
        raise RuntimeError(
            "VERIFICATION_GATE_FAILED: Agent Runner reports the latest verification "
            "tool turn as failed."
        )

    if successful_tools < 1:
        raise RuntimeError(
            "VERIFICATION_GATE_FAILED: Agent Runner completed without any successful "
            "tool result."
        )

    result = _http_json(
        RUNNER_BASE_URL
        + "/agent/result/"
        + urllib.parse.quote(runner_job_id, safe=""),
        timeout=20,
    )

    audit = _runner_audit_evidence(runner_job_id)
    evidence_packet = _execution_evidence_packet(runner_job_id, status, audit)
    runner_output = _runner_result_text(result)

    output = (
        runner_output.rstrip()
        + "\n\n"
        + evidence_packet
    )

    return {
        "output": output,
        "model": status.get("last_model") or resolution.get("selected_model"),
        "specialist": role,
        "runner_job_id": runner_job_id,
        "runner_status": runner_status,
        "verification_success_seen": verification_success,
        "verification_failure_seen": verification_failure,
        "verification_gate_passed": True,
        "successful_tool_results": status.get("successful_tool_results"),
        "failed_tool_results": status.get("failed_tool_results"),
        "evidence_packet": evidence_packet,
        "evidence_events": audit.get("events") or [],
        "evidence_source": audit.get("source"),
        "workspace_preflight": workspace_preflight,
    }



def _memory_context(
    project_id: str,
    query: str,
    limit: int = 8,
    max_chars: int = 12000,
) -> dict[str, Any]:
    if not project_id:
        return {
            "context": "",
            "citations": [],
            "context_chars": 0,
            "used": False,
        }

    payload = _http_json(
        MEMORY_BASE_URL + "/memory/context",
        method="POST",
        payload={
            "project_id": project_id,
            "query": query,
            "limit": int(limit),
            "max_chars": int(max_chars),
        },
        timeout=30,
    )

    context = str(payload.get("context") or "")
    citations = payload.get("citations") or []

    return {
        "context": context,
        "citations": citations if isinstance(citations, list) else [],
        "context_chars": int(payload.get("context_chars") or len(context)),
        "used": bool(context.strip()),
        "retrieval": payload.get("retrieval"),
    }


def _save_result_memory(job: dict[str, Any]) -> dict[str, Any] | None:
    project_id = str(job.get("project_id") or "").strip()
    if not project_id or job.get("save_result_to_memory") is not True:
        return None

    final_response = str(job.get("final_response") or "").strip()
    if not final_response:
        return None

    payload = _http_json(
        MEMORY_BASE_URL + "/memory/add",
        method="POST",
        payload={
            "project_id": project_id,
            "title": f"Orchestration result {job['job_id']}",
            "source": f"orchestrator:{job['job_id']}",
            "kind": "orchestration-result",
            "text": final_response,
            "tags": ["orchestrator", "verified-result"],
            "metadata": {
                "job_id": job["job_id"],
                "workspace": job["workspace"],
                "objective": job["objective"],
                "completed": job.get("completed"),
                "stages": [
                    {
                        "id": stage.get("id"),
                        "type": stage.get("type"),
                        "specialist": stage.get("specialist"),
                        "model": stage.get("model"),
                        "status": stage.get("status"),
                    }
                    for stage in (job.get("stage_results") or [])
                ],
            },
        },
        timeout=30,
    )

    memory = payload.get("memory")
    if isinstance(memory, dict):
        return {
            "memory_id": memory.get("memory_id"),
            "created": payload.get("created"),
            "deduplicated": payload.get("deduplicated"),
        }

    return {
        "created": payload.get("created"),
        "deduplicated": payload.get("deduplicated"),
    }


def _normalize_stages(value: Any) -> list[dict[str, Any]]:
    raw = DEFAULT_STAGES if value is None else value

    if not isinstance(raw, list) or not raw:
        raise HTTPException(status_code=400, detail="stages must be a non-empty list.")

    if len(raw) > MAX_STAGES:
        raise HTTPException(
            status_code=400,
            detail=f"Maximum {MAX_STAGES} stages are allowed.",
        )

    result: list[dict[str, Any]] = []
    seen: set[str] = set()

    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise HTTPException(
                status_code=400,
                detail=f"stages[{index}] must be an object.",
            )

        stage_id = str(item.get("id") or f"stage-{index + 1}").strip()
        stage_type = str(item.get("type") or "chat").strip().lower()
        specialist = str(item.get("specialist") or "GENERAL").strip().upper()
        instruction = str(item.get("instruction") or "").strip()

        if not stage_id:
            raise HTTPException(status_code=400, detail=f"stages[{index}].id is empty.")
        if stage_id in seen:
            raise HTTPException(status_code=400, detail=f"Duplicate stage id: {stage_id}")
        seen.add(stage_id)

        if stage_type not in {"chat", "agent"}:
            raise HTTPException(
                status_code=400,
                detail=f"{stage_id}: type must be chat or agent.",
            )

        if specialist not in ROLE_PREFIX:
            raise HTTPException(
                status_code=400,
                detail=f"{stage_id}: unsupported specialist {specialist}.",
            )

        if stage_type == "agent" and specialist != "AGENTIC":
            raise HTTPException(
                status_code=400,
                detail=f"{stage_id}: agent stages require AGENTIC specialist.",
            )

        if not instruction:
            raise HTTPException(
                status_code=400,
                detail=f"{stage_id}: instruction is required.",
            )

        stage = {
            "id": stage_id,
            "type": stage_type,
            "specialist": specialist,
            "instruction": instruction,
        }

        if item.get("max_steps") is not None:
            stage["max_steps"] = int(item["max_steps"])
        if item.get("max_minutes") is not None:
            stage["max_minutes"] = int(item["max_minutes"])

        result.append(stage)

    return result


def _preview_stages(stages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    preview = []

    for stage in stages:
        resolution = _resolve_specialist(stage["specialist"])
        preview.append(
            {
                **stage,
                "selected_model": resolution.get("selected_model"),
                "preferred_model": resolution.get("preferred_model"),
                "fallback_used": resolution.get("fallback_used"),
                "route_mode": resolution.get("route_mode"),
                "tools_policy": resolution.get("tools_policy"),
            }
        )

    return preview


def _run_job(job_id: str) -> None:
    global _active_job_id

    job = _load_job(job_id)
    if job.get("status") == "cancelled":
        return

    _active_job_id = job_id
    job["status"] = "running"
    job["started"] = _now_iso()
    job["current_stage"] = None
    _save_job(job)
    _audit(job_id, "job_started", stages=len(job["stages"]))

    previous_output = ""
    memory_context = str(job.get("memory_context") or "")

    try:
        for index, stage in enumerate(job["stages"]):
            current = _load_job(job_id)
            if current.get("cancel_requested"):
                job = current
                job["status"] = "cancelled"
                job["completed"] = _now_iso()
                _save_job(job)
                _audit(job_id, "job_cancelled", before_stage=stage["id"])
                return

            job = current
            job["current_stage"] = stage["id"]
            job["current_stage_index"] = index
            job["progress"] = {
                "completed_stages": index,
                "total_stages": len(job["stages"]),
            }
            _save_job(job)
            _audit(
                job_id,
                "stage_started",
                stage_id=stage["id"],
                stage_type=stage["type"],
                specialist=stage["specialist"],
            )

            started = time.monotonic()

            if stage["type"] == "chat":
                stage_result = _chat_completion(
                    stage["specialist"],
                    stage["instruction"],
                    job["objective"],
                    previous_output,
                    memory_context,
                )
            else:
                stage_result = _agent_stage(
                    job,
                    stage,
                    previous_output,
                    memory_context,
                )

            elapsed = round(time.monotonic() - started, 3)
            previous_output = str(stage_result.get("output") or "")

            stage_record = {
                "id": stage["id"],
                "type": stage["type"],
                "specialist": stage["specialist"],
                "status": "completed",
                "model": stage_result.get("model"),
                "duration_seconds": elapsed,
                "output": previous_output,
            }

            for key in (
                "runner_job_id",
                "runner_status",
                "verification_success_seen",
                "verification_failure_seen",
                "verification_gate_passed",
                "successful_tool_results",
                "failed_tool_results",
                "evidence_packet",
                "evidence_events",
                "evidence_source",
                "workspace_preflight",
                "route_mode",
            ):
                if key in stage_result:
                    stage_record[key] = stage_result[key]

            job = _load_job(job_id)
            job.setdefault("stage_results", []).append(stage_record)

            if stage["type"] == "agent":
                job["verification"] = {
                    "stage_id": stage["id"],
                    "runner_job_id": stage_record.get("runner_job_id"),
                    "runner_status": stage_record.get("runner_status"),
                    "verification_gate_passed": stage_record.get("verification_gate_passed"),
                    "verification_success_seen": stage_record.get("verification_success_seen"),
                    "verification_failure_seen": stage_record.get("verification_failure_seen"),
                    "successful_tool_results": stage_record.get("successful_tool_results"),
                    "failed_tool_results": stage_record.get("failed_tool_results"),
                    "evidence_source": stage_record.get("evidence_source"),
                    "evidence_events": stage_record.get("evidence_events") or [],
                }

            job["last_output"] = previous_output
            job["active_runner_job_id"] = None
            job["runner_status"] = None
            job["progress"] = {
                "completed_stages": index + 1,
                "total_stages": len(job["stages"]),
            }
            _save_job(job)

            _audit(
                job_id,
                "stage_completed",
                stage_id=stage["id"],
                model=stage_result.get("model"),
                duration_seconds=elapsed,
            )

        job = _load_job(job_id)
        job["status"] = "completed"
        job["current_stage"] = None
        job["completed"] = _now_iso()
        job["final_response"] = previous_output

        try:
            saved = _save_result_memory(job)
            job["saved_memory"] = saved
        except Exception as exc:
            job["memory_save_error"] = str(exc)

        _save_job(job)
        _audit(
            job_id,
            "job_completed",
            saved_memory=job.get("saved_memory"),
            memory_save_error=job.get("memory_save_error"),
        )

    except Exception as exc:
        message = str(exc)
        job = _load_job(job_id)

        if message == "ORCHESTRATOR_CANCELLED" or job.get("cancel_requested"):
            job["status"] = "cancelled"
            job["last_error"] = None
            _audit(job_id, "job_cancelled", error=message)
        else:
            job["status"] = "failed"
            job["last_error"] = message
            _audit(job_id, "job_failed", error=message)

        job["current_stage"] = None
        job["completed"] = _now_iso()
        _save_job(job)

    finally:
        _active_job_id = None


def _worker_loop() -> None:
    while True:
        job_id = _work_queue.get()
        try:
            job = _load_job(job_id)
            if job.get("status") == "queued":
                _run_job(job_id)
        except Exception as exc:
            try:
                job = _load_job(job_id)
                job["status"] = "failed"
                job["last_error"] = f"Worker failure: {exc}"
                job["completed"] = _now_iso()
                _save_job(job)
                _audit(job_id, "worker_failure", error=str(exc))
            except Exception:
                pass
        finally:
            _work_queue.task_done()


def _recover_persistent_jobs() -> None:
    _ensure_dirs()

    for path in JOBS_DIR.glob("*.json"):
        try:
            payload = _read_json_file(path)
        except Exception:
            continue

        if not isinstance(payload, dict):
            continue

        status = str(payload.get("status") or "")

        if status == "queued":
            try:
                _work_queue.put_nowait(str(payload["job_id"]))
            except queue.Full:
                payload["status"] = "interrupted"
                payload["last_error"] = "Queue was full during orchestrator startup."
                payload["completed"] = _now_iso()
                _atomic_write_json(path, payload)

        elif status in {"running", "cancel_requested"}:
            payload["status"] = "interrupted"
            payload["last_error"] = "Orchestrator restarted while job was active."
            payload["completed"] = _now_iso()
            _atomic_write_json(path, payload)


def _start_worker_once() -> None:
    global _worker_started

    with _lock:
        if _worker_started:
            return

        thread = threading.Thread(
            target=_worker_loop,
            name="wckd-orchestrator-worker",
            daemon=True,
        )
        thread.start()
        _worker_started = True


app = FastAPI(
    title="WCKD Agent Orchestrator",
    description=(
        "Sequential specialist workflow orchestration for WCKD Suite. "
        "Coordinates Specialist Registry, Auto Router and Agent Runner."
    ),
    version=VERSION,
)


@app.on_event("startup")
def startup() -> None:
    _ensure_dirs()
    _recover_persistent_jobs()
    _start_worker_once()


@app.get("/health")
def health() -> dict[str, Any]:
    dependency_urls = {
        "router": ROUTER_BASE_URL + "/health",
        "runner": RUNNER_BASE_URL + "/health",
        "registry": REGISTRY_BASE_URL + "/health",
        "memory": MEMORY_BASE_URL + "/health",
        "lab": LAB_BASE_URL + "/health",
    }
    with ThreadPoolExecutor(max_workers=len(dependency_urls)) as executor:
        futures = {
            name: executor.submit(_service_health, url)
            for name, url in dependency_urls.items()
        }
        router = futures["router"].result()
        runner = futures["runner"].result()
        registry = futures["registry"].result()
        memory = futures["memory"].result()
        lab = futures["lab"].result()

    dependencies_ok = all(
        item.get("available") is True and item.get("status") == "ok"
        for item in (router, runner, registry, memory, lab)
    )

    return {
        "status": "ok" if dependencies_ok else "degraded",
        "version": VERSION,
        "mode": "sequential-single-worker",
        "max_stages": MAX_STAGES,
        "queue_limit": MAX_QUEUE,
        "queued": _work_queue.qsize(),
        "active_job_id": _active_job_id,
        "dependencies": {
            "router": router,
            "runner": runner,
            "registry": registry,
            "memory": memory,
            "lab": lab,
        },
        "memory_integration": True,
        "persistence": True,
        "audit_logs": True,
        "verified_execution_gate": True,
        "runner_audit_evidence": True,
        "workspace_preflight": True,
        "workspace_preflight_mode": "lab-mkdir-before-runner",
        "default_pipeline": [
            {
                "id": item["id"],
                "type": item["type"],
                "specialist": item["specialist"],
            }
            for item in DEFAULT_STAGES
        ],
    }


@app.get("/orchestrator/workflows")
def workflows() -> dict[str, Any]:
    return {
        "status": "ok",
        "version": VERSION,
        "default": DEFAULT_STAGES,
        "supported_specialists": list(ROLE_PREFIX.keys()),
        "stage_types": ["chat", "agent"],
        "agent_stage_specialist": "AGENTIC",
    }


@app.post("/orchestrator/preview")
def preview(body: dict[str, Any]) -> dict[str, Any]:
    stages = _normalize_stages(body.get("stages"))
    return {
        "status": "ok",
        "version": VERSION,
        "stages": _preview_stages(stages),
    }


@app.post("/orchestrator/start")
def start(body: dict[str, Any]) -> dict[str, Any]:
    objective = str(body.get("objective") or "").strip()
    workspace = str(body.get("workspace") or "").strip()

    if not objective:
        raise HTTPException(status_code=400, detail="objective is required.")

    if not workspace:
        suffix = uuid.uuid4().hex[:8]
        workspace = f"/workspace/orchestrator-{suffix}"

    if not workspace.startswith("/workspace/"):
        raise HTTPException(
            status_code=400,
            detail="workspace must be inside /workspace/.",
        )

    stages = _normalize_stages(body.get("stages"))
    preview_data = _preview_stages(stages)

    project_id = str(body.get("project_id") or "").strip()
    memory_enabled = body.get("memory_enabled", True) is not False
    memory_limit = max(1, min(int(body.get("memory_limit") or 8), 50))
    memory_max_chars = max(
        500,
        min(int(body.get("memory_max_chars") or 12000), 40000),
    )
    save_result_to_memory = body.get("save_result_to_memory", False) is True

    memory_data = {
        "context": "",
        "citations": [],
        "context_chars": 0,
        "used": False,
    }

    if project_id and memory_enabled:
        try:
            memory_data = _memory_context(
                project_id=project_id,
                query=str(body.get("memory_query") or objective),
                limit=memory_limit,
                max_chars=memory_max_chars,
            )
        except Exception as exc:
            raise HTTPException(
                status_code=503,
                detail=f"Project Memory retrieval failed: {exc}",
            ) from exc

    if _work_queue.full():
        raise HTTPException(status_code=429, detail="Orchestrator queue is full.")

    job_id = "orch-" + uuid.uuid4().hex[:12]

    job = {
        "job_id": job_id,
        "version": VERSION,
        "status": "queued",
        "objective": objective,
        "workspace": workspace,
        "project_id": project_id or None,
        "memory_enabled": memory_enabled,
        "memory_used": bool(memory_data.get("used")),
        "memory_context": str(memory_data.get("context") or ""),
        "memory_citations": memory_data.get("citations") or [],
        "memory_context_chars": int(memory_data.get("context_chars") or 0),
        "memory_retrieval": memory_data.get("retrieval"),
        "save_result_to_memory": save_result_to_memory,
        "saved_memory": None,
        "memory_save_error": None,
        "stages": stages,
        "stage_preview": preview_data,
        "stage_results": [],
        "current_stage": None,
        "current_stage_index": None,
        "active_runner_job_id": None,
        "runner_status": None,
        "verification": None,
        "workspace_preflight": None,
        "cancel_requested": False,
        "agent_max_steps": int(body.get("agent_max_steps") or 90),
        "agent_max_minutes": int(body.get("agent_max_minutes") or 30),
        "progress": {
            "completed_stages": 0,
            "total_stages": len(stages),
        },
        "created": _now_iso(),
        "updated": _now_iso(),
        "started": None,
        "completed": None,
        "last_output": None,
        "final_response": None,
        "last_error": None,
    }

    _save_job(job)
    _audit(
        job_id,
        "job_created",
        objective=objective,
        workspace=workspace,
        stages=len(stages),
        project_id=project_id or None,
        memory_used=bool(memory_data.get("used")),
        memory_citations=len(memory_data.get("citations") or []),
        save_result_to_memory=save_result_to_memory,
    )

    _work_queue.put_nowait(job_id)

    return {
        "status": "queued",
        "job_id": job_id,
        "workspace": workspace,
        "project_id": project_id or None,
        "memory_used": bool(memory_data.get("used")),
        "memory_citations": len(memory_data.get("citations") or []),
        "stages": len(stages),
    }


@app.get("/orchestrator/status/{job_id}")
def status(job_id: str) -> dict[str, Any]:
    job = _load_job(job_id)

    return {
        "job_id": job["job_id"],
        "status": job["status"],
        "workspace": job["workspace"],
        "project_id": job.get("project_id"),
        "memory_used": job.get("memory_used"),
        "memory_citations": len(job.get("memory_citations") or []),
        "memory_context_chars": job.get("memory_context_chars"),
        "saved_memory": job.get("saved_memory"),
        "current_stage": job.get("current_stage"),
        "current_stage_index": job.get("current_stage_index"),
        "progress": job.get("progress"),
        "runner_status": job.get("runner_status"),
        "active_runner_job_id": job.get("active_runner_job_id"),
        "verification": job.get("verification"),
        "last_error": job.get("last_error"),
        "created": job.get("created"),
        "started": job.get("started"),
        "updated": job.get("updated"),
        "completed": job.get("completed"),
    }


@app.get("/orchestrator/result/{job_id}")
def result(job_id: str) -> dict[str, Any]:
    job = _load_job(job_id)
    return {
        "job_id": job["job_id"],
        "status": job["status"],
        "objective": job["objective"],
        "workspace": job["workspace"],
        "project_id": job.get("project_id"),
        "memory_used": job.get("memory_used"),
        "memory_citations": job.get("memory_citations") or [],
        "memory_context_chars": job.get("memory_context_chars"),
        "saved_memory": job.get("saved_memory"),
        "memory_save_error": job.get("memory_save_error"),
        "stage_results": job.get("stage_results") or [],
        "verification": job.get("verification"),
        "workspace_preflight": job.get("workspace_preflight"),
        "final_response": job.get("final_response"),
        "last_error": job.get("last_error"),
        "created": job.get("created"),
        "started": job.get("started"),
        "completed": job.get("completed"),
    }


@app.get("/orchestrator/list")
def list_jobs(limit: int = 20) -> dict[str, Any]:
    limit = max(1, min(int(limit), 100))
    jobs = []

    for path in sorted(
        JOBS_DIR.glob("*.json"),
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    )[:limit]:
        try:
            job = _read_json_file(path)
        except Exception:
            continue

        if not isinstance(job, dict):
            continue

        jobs.append(
            {
                "job_id": job.get("job_id"),
                "status": job.get("status"),
                "workspace": job.get("workspace"),
                "current_stage": job.get("current_stage"),
                "progress": job.get("progress"),
                "created": job.get("created"),
                "updated": job.get("updated"),
                "completed": job.get("completed"),
                "last_error": job.get("last_error"),
            }
        )

    return {
        "status": "ok",
        "jobs": jobs,
    }


@app.post("/orchestrator/cancel/{job_id}")
def cancel(job_id: str) -> dict[str, Any]:
    job = _load_job(job_id)

    if job.get("status") in TERMINAL_STATES:
        return {
            "job_id": job_id,
            "status": job.get("status"),
            "message": "Job is already terminal.",
        }

    job["cancel_requested"] = True

    if job.get("status") == "queued":
        job["status"] = "cancelled"
        job["completed"] = _now_iso()
        _audit(job_id, "job_cancelled", while_queued=True)
    else:
        job["status"] = "cancel_requested"
        _audit(
            job_id,
            "cancel_requested",
            runner_job_id=job.get("active_runner_job_id"),
        )

        runner_job_id = job.get("active_runner_job_id")
        if runner_job_id:
            try:
                _http_json(
                    RUNNER_BASE_URL
                    + "/agent/cancel/"
                    + urllib.parse.quote(str(runner_job_id), safe=""),
                    method="POST",
                    payload={},
                    timeout=15,
                )
            except Exception:
                pass

    _save_job(job)

    return {
        "job_id": job_id,
        "status": job["status"],
    }
