from __future__ import annotations

import json
import os
import subprocess
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException

VERSION = "1.0.0"
POLICY = "single-active-model"

OLLAMA_BASE = os.environ.get("WCKD_OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
DEFAULT_KEEP_ALIVE = os.environ.get("WCKD_MODEL_KEEP_ALIVE", "30m")
REQUEST_TIMEOUT = float(os.environ.get("WCKD_MODEL_MANAGER_TIMEOUT", "180"))

ROOT = Path(os.environ.get("WCKD_MODEL_MANAGER_ROOT", str(Path(__file__).resolve().parent / "model-manager")))
STATE_FILE = ROOT / "state.json"

ROOT.mkdir(parents=True, exist_ok=True)

app = FastAPI(
    title="WCKD Model Manager",
    version=VERSION,
    description="VRAM-aware Ollama model lifecycle manager for WCKD Suite.",
)

_switch_lock = threading.Lock()


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def read_state() -> dict[str, Any]:
    if not STATE_FILE.exists():
        return {
            "version": VERSION,
            "policy": POLICY,
            "active_model": None,
            "last_action": None,
            "updated": None,
        }
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {
            "version": VERSION,
            "policy": POLICY,
            "active_model": None,
            "last_action": "state-read-error",
            "updated": now_iso(),
        }


def write_state(**updates: Any) -> dict[str, Any]:
    state = read_state()
    state.update(updates)
    state["version"] = VERSION
    state["policy"] = POLICY
    state["updated"] = now_iso()

    tmp = STATE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(STATE_FILE)
    return state


def ollama_request(method: str, path: str, payload: Optional[dict[str, Any]] = None,
                   timeout: float = REQUEST_TIMEOUT) -> dict[str, Any]:
    url = f"{OLLAMA_BASE}{path}"
    body = None
    headers = {"Accept": "application/json"}

    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=body, headers=headers, method=method)

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Ollama HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Ollama unavailable: {exc}") from exc

    if not raw:
        return {}

    try:
        return json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise RuntimeError("Ollama returned invalid JSON") from exc


def get_installed_raw() -> list[dict[str, Any]]:
    data = ollama_request("GET", "/api/tags", timeout=15)
    return list(data.get("models") or [])


def get_running_raw() -> list[dict[str, Any]]:
    data = ollama_request("GET", "/api/ps", timeout=15)
    return list(data.get("models") or [])


def model_name(item: dict[str, Any]) -> str:
    return str(item.get("name") or item.get("model") or "")


def installed_names() -> list[str]:
    return [model_name(x) for x in get_installed_raw() if model_name(x)]


def running_names() -> list[str]:
    return [model_name(x) for x in get_running_raw() if model_name(x)]


def gpu_status() -> dict[str, Any]:
    cmd = [
        "nvidia-smi",
        "--query-gpu=name,memory.total,memory.used,memory.free",
        "--format=csv,noheader,nounits",
    ]
    try:
        cp = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception as exc:
        return {"available": False, "error": str(exc)}

    if cp.returncode != 0:
        return {
            "available": False,
            "error": (cp.stderr or cp.stdout or "nvidia-smi failed").strip(),
        }

    line = next((x.strip() for x in cp.stdout.splitlines() if x.strip()), "")
    parts = [x.strip() for x in line.split(",")]
    if len(parts) < 4:
        return {"available": False, "error": f"Unexpected nvidia-smi output: {line}"}

    try:
        total = int(parts[1])
        used = int(parts[2])
        free = int(parts[3])
    except ValueError:
        return {"available": False, "error": f"Unexpected nvidia-smi output: {line}"}

    return {
        "available": True,
        "name": parts[0],
        "memory_total_mb": total,
        "memory_used_mb": used,
        "memory_free_mb": free,
    }


def unload_one(model: str) -> None:
    ollama_request(
        "POST",
        "/api/generate",
        {
            "model": model,
            "prompt": "",
            "stream": False,
            "keep_alive": 0,
        },
    )


def wait_until_not_running(model: str, timeout: float = 20.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if model not in running_names():
            return True
        time.sleep(0.5)
    return model not in running_names()


def wait_until_running(model: str, timeout: float = 30.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if model in running_names():
            return True
        time.sleep(0.5)
    return model in running_names()


def prewarm(model: str, keep_alive: str) -> None:
    ollama_request(
        "POST",
        "/api/generate",
        {
            "model": model,
            "prompt": "",
            "stream": False,
            "keep_alive": keep_alive,
        },
    )


def compact_installed(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result = []
    for x in items:
        result.append({
            "name": model_name(x),
            "size": x.get("size"),
            "modified_at": x.get("modified_at"),
            "details": x.get("details"),
        })
    return result


def compact_running(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result = []
    for x in items:
        result.append({
            "name": model_name(x),
            "size": x.get("size"),
            "size_vram": x.get("size_vram"),
            "expires_at": x.get("expires_at"),
            "details": x.get("details"),
        })
    return result


def current_active_model(running: list[dict[str, Any]]) -> Optional[str]:
    names = [model_name(x) for x in running if model_name(x)]
    state_active = read_state().get("active_model")

    if state_active and state_active in names:
        return state_active
    if len(names) == 1:
        return names[0]
    return state_active if state_active in names else None


@app.get("/health")
def health() -> dict[str, Any]:
    try:
        installed = get_installed_raw()
        running = get_running_raw()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    active = current_active_model(running)

    return {
        "status": "ok",
        "version": VERSION,
        "policy": POLICY,
        "ollama": True,
        "ollama_url": OLLAMA_BASE,
        "keep_alive": DEFAULT_KEEP_ALIVE,
        "installed_models": len(installed),
        "running_models": len(running),
        "active_model": active,
        "gpu": gpu_status(),
        "state_file": str(STATE_FILE),
    }


@app.get("/models")
def models() -> dict[str, Any]:
    try:
        installed = get_installed_raw()
        running = get_running_raw()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    return {
        "installed": compact_installed(installed),
        "running": compact_running(running),
        "active_model": current_active_model(running),
    }


@app.get("/status")
def status() -> dict[str, Any]:
    try:
        running = get_running_raw()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    state = read_state()
    active = current_active_model(running)

    return {
        "status": "ok",
        "version": VERSION,
        "policy": POLICY,
        "active_model": active,
        "running_models": compact_running(running),
        "gpu": gpu_status(),
        "state": state,
    }


def do_load(model: str, keep_alive: str) -> dict[str, Any]:
    installed = installed_names()
    if model not in installed:
        raise HTTPException(
            status_code=404,
            detail={
                "error": "model-not-installed",
                "model": model,
                "installed_models": installed,
            },
        )

    with _switch_lock:
        before_running = running_names()
        unloaded: list[str] = []

        for old in before_running:
            if old != model:
                try:
                    unload_one(old)
                    wait_until_not_running(old)
                    unloaded.append(old)
                except Exception as exc:
                    write_state(
                        active_model=None,
                        last_action="unload-failed",
                        last_error=f"{old}: {exc}",
                    )
                    raise HTTPException(
                        status_code=502,
                        detail=f"Failed to unload {old}: {exc}",
                    )

        try:
            prewarm(model, keep_alive)
        except Exception as exc:
            write_state(
                active_model=None,
                last_action="load-failed",
                last_error=f"{model}: {exc}",
            )
            raise HTTPException(
                status_code=502,
                detail=f"Failed to load {model}: {exc}",
            )

        if not wait_until_running(model):
            write_state(
                active_model=None,
                last_action="load-timeout",
                last_error=f"{model} did not appear in /api/ps",
            )
            raise HTTPException(
                status_code=504,
                detail=f"{model} did not appear in Ollama /api/ps after prewarm",
            )

        after_running = running_names()
        state = write_state(
            active_model=model,
            last_action="load",
            last_error=None,
            keep_alive=keep_alive,
        )

        return {
            "status": "ok",
            "action": "load",
            "model": model,
            "unloaded": unloaded,
            "running_before": before_running,
            "running_after": after_running,
            "gpu": gpu_status(),
            "state": state,
        }


@app.post("/load/{model}")
def load_model(model: str, keep_alive: Optional[str] = None) -> dict[str, Any]:
    return do_load(model, keep_alive or DEFAULT_KEEP_ALIVE)


@app.post("/switch/{model}")
def switch_model(model: str, keep_alive: Optional[str] = None) -> dict[str, Any]:
    result = do_load(model, keep_alive or DEFAULT_KEEP_ALIVE)
    result["action"] = "switch"
    state = write_state(
        active_model=model,
        last_action="switch",
        last_error=None,
        keep_alive=keep_alive or DEFAULT_KEEP_ALIVE,
    )
    result["state"] = state
    return result


@app.post("/unload")
def unload(model: Optional[str] = None) -> dict[str, Any]:
    with _switch_lock:
        before = running_names()
        targets = [model] if model else list(before)

        if model and model not in before:
            return {
                "status": "ok",
                "action": "unload",
                "requested_model": model,
                "unloaded": [],
                "running_before": before,
                "running_after": before,
                "note": "Requested model was not running.",
                "gpu": gpu_status(),
            }

        unloaded: list[str] = []
        failures: dict[str, str] = {}

        for target in targets:
            try:
                unload_one(target)
                if wait_until_not_running(target):
                    unloaded.append(target)
                else:
                    failures[target] = "Model remained present in /api/ps after unload request."
            except Exception as exc:
                failures[target] = str(exc)

        after = running_names()

        active = current_active_model(get_running_raw())
        write_state(
            active_model=active,
            last_action="unload",
            last_error=failures or None,
        )

        if failures:
            raise HTTPException(
                status_code=502,
                detail={
                    "error": "one-or-more-unloads-failed",
                    "unloaded": unloaded,
                    "failures": failures,
                    "running_after": after,
                },
            )

        return {
            "status": "ok",
            "action": "unload",
            "requested_model": model,
            "unloaded": unloaded,
            "running_before": before,
            "running_after": after,
            "gpu": gpu_status(),
        }
