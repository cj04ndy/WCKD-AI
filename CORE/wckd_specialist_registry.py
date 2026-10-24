from __future__ import annotations

import json
import urllib.request
from datetime import datetime
from pathlib import Path
from threading import RLock
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

VERSION = "1.0.0"

AI_ROOT = Path(__file__).resolve().parent
REGISTRY_DIR = AI_ROOT / "specialists"
REGISTRY_FILE = REGISTRY_DIR / "registry.json"
OLLAMA_TAGS_URL = "http://127.0.0.1:11434/api/tags"

_lock = RLock()

DEFAULT_SPECIALISTS: list[dict[str, Any]] = [
    {
        "id": "GENERAL",
        "display_name": "General",
        "enabled": True,
        "description": "Default general-purpose WCKD specialist.",
        "preferred_model": "qwen3.5:9b",
        "fallback_models": ["nemotron-3-nano:4b", "gpt-oss:20b"],
        "route_mode": "/balanced",
        "tools_policy": "none",
        "temperature": 0.6,
        "max_steps": 0,
        "tags": ["general", "chat"],
    },
    {
        "id": "CODE",
        "display_name": "Code",
        "enabled": True,
        "description": "Programming, debugging, refactoring and code analysis.",
        "preferred_model": "gpt-oss:20b",
        "fallback_models": ["qwen3.5:9b", "nemotron-3-nano:4b"],
        "route_mode": "/code",
        "tools_policy": "safe-tools",
        "temperature": 0.2,
        "max_steps": 0,
        "tags": ["code", "debug", "development"],
    },
    {
        "id": "REASONING",
        "display_name": "Reasoning",
        "enabled": True,
        "description": "Hard analysis, diagnostics, architecture and planning.",
        "preferred_model": "gpt-oss:20b",
        "fallback_models": ["qwen3.5:9b", "nemotron-3-nano:4b"],
        "route_mode": "/smart",
        "tools_policy": "none",
        "temperature": 0.3,
        "max_steps": 0,
        "tags": ["reasoning", "analysis", "architecture"],
    },
    {
        "id": "WRITING",
        "display_name": "Writing",
        "enabled": True,
        "description": "Rewriting, summarization and language tasks.",
        "preferred_model": "qwen3.5:9b",
        "fallback_models": ["nemotron-3-nano:4b", "gpt-oss:20b"],
        "route_mode": "/write",
        "tools_policy": "none",
        "temperature": 0.7,
        "max_steps": 0,
        "tags": ["writing", "summary", "language"],
    },
    {
        "id": "TOOLS",
        "display_name": "Tools",
        "enabled": True,
        "description": "Narrow, low-risk structured tool execution.",
        "preferred_model": "nemotron-3-nano:4b",
        "fallback_models": ["qwen3.5:9b"],
        "route_mode": "/tools",
        "tools_policy": "safe-tools",
        "temperature": 0.1,
        "max_steps": 0,
        "tags": ["tools", "structured", "fast"],
    },
    {
        "id": "AGENTIC",
        "display_name": "Agentic",
        "enabled": True,
        "description": "Multi-step autonomous work through WCKD Agent Runner.",
        "preferred_model": "qwen3.5:9b",
        "fallback_models": ["gpt-oss:20b", "nemotron-3-nano:4b"],
        "route_mode": "/agentic",
        "tools_policy": "agentic",
        "temperature": 0.2,
        "max_steps": 180,
        "tags": ["agent", "multi-step", "tools"],
    },
]

ALLOWED_TOOLS_POLICIES = {"none", "safe-tools", "agentic"}


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    tmp.replace(path)


def _ensure_registry() -> None:
    REGISTRY_DIR.mkdir(parents=True, exist_ok=True)
    if not REGISTRY_FILE.exists():
        _atomic_write_json(
            REGISTRY_FILE,
            {
                "schema_version": 1,
                "registry_version": VERSION,
                "updated": _now_iso(),
                "specialists": DEFAULT_SPECIALISTS,
            },
        )


def _load_registry() -> dict[str, Any]:
    _ensure_registry()
    with _lock:
        try:
            payload = json.loads(REGISTRY_FILE.read_text(encoding="utf-8-sig"))
        except Exception as exc:
            raise RuntimeError(f"Cannot read specialist registry: {exc}") from exc

    if not isinstance(payload, dict):
        raise RuntimeError("Registry root must be a JSON object.")

    specialists = payload.get("specialists")
    if not isinstance(specialists, list):
        raise RuntimeError("Registry 'specialists' must be a list.")

    return payload


def _normalize_id(value: str) -> str:
    return str(value or "").strip().upper()


def _validate_payload(payload: dict[str, Any]) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    seen: set[str] = set()

    specialists = payload.get("specialists")
    if not isinstance(specialists, list):
        return {
            "valid": False,
            "errors": ["Registry 'specialists' must be a list."],
            "warnings": [],
        }

    required = {
        "id",
        "display_name",
        "enabled",
        "preferred_model",
        "fallback_models",
        "route_mode",
        "tools_policy",
    }

    for index, item in enumerate(specialists):
        prefix = f"specialists[{index}]"

        if not isinstance(item, dict):
            errors.append(f"{prefix} must be an object.")
            continue

        missing = sorted(required - set(item.keys()))
        if missing:
            errors.append(f"{prefix} missing: {', '.join(missing)}")
            continue

        sid = _normalize_id(item.get("id"))
        if not sid:
            errors.append(f"{prefix}.id is empty.")
        elif sid in seen:
            errors.append(f"Duplicate specialist id: {sid}")
        else:
            seen.add(sid)

        if not isinstance(item.get("enabled"), bool):
            errors.append(f"{sid or prefix}.enabled must be boolean.")

        preferred = item.get("preferred_model")
        if not isinstance(preferred, str) or not preferred.strip():
            errors.append(f"{sid or prefix}.preferred_model must be non-empty.")

        fallbacks = item.get("fallback_models")
        if not isinstance(fallbacks, list) or any(
            not isinstance(v, str) or not v.strip() for v in fallbacks
        ):
            errors.append(f"{sid or prefix}.fallback_models must be a list of model names.")

        policy = str(item.get("tools_policy") or "")
        if policy not in ALLOWED_TOOLS_POLICIES:
            errors.append(
                f"{sid or prefix}.tools_policy must be one of: "
                + ", ".join(sorted(ALLOWED_TOOLS_POLICIES))
            )

        route_mode = item.get("route_mode")
        if not isinstance(route_mode, str) or not route_mode.startswith("/"):
            errors.append(f"{sid or prefix}.route_mode must start with '/'.")

        temperature = item.get("temperature", 0.5)
        try:
            temperature_float = float(temperature)
            if temperature_float < 0 or temperature_float > 2:
                warnings.append(f"{sid or prefix}.temperature is outside 0..2.")
        except Exception:
            errors.append(f"{sid or prefix}.temperature must be numeric.")

        max_steps = item.get("max_steps", 0)
        if not isinstance(max_steps, int) or max_steps < 0:
            errors.append(f"{sid or prefix}.max_steps must be a non-negative integer.")

    return {
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
    }


def _installed_models() -> tuple[bool, list[str], str | None]:
    try:
        req = urllib.request.Request(
            OLLAMA_TAGS_URL,
            method="GET",
            headers={"Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=4) as response:
            payload = json.loads(response.read().decode("utf-8", errors="replace"))

        models: list[str] = []
        for item in payload.get("models") or []:
            if not isinstance(item, dict):
                continue
            name = item.get("name") or item.get("model")
            if isinstance(name, str) and name.strip():
                models.append(name.strip())

        return True, list(dict.fromkeys(models)), None
    except Exception as exc:
        return False, [], str(exc)


def _get_specialist(specialist_id: str) -> dict[str, Any]:
    sid = _normalize_id(specialist_id)
    payload = _load_registry()

    for item in payload["specialists"]:
        if isinstance(item, dict) and _normalize_id(item.get("id")) == sid:
            result = dict(item)
            result["id"] = sid
            return result

    raise HTTPException(status_code=404, detail=f"Unknown specialist: {sid}")


def _resolve_specialist(item: dict[str, Any]) -> dict[str, Any]:
    preferred = str(item["preferred_model"])
    fallbacks = [str(v) for v in item.get("fallback_models") or []]

    ollama_available, installed, ollama_error = _installed_models()

    candidates = [preferred] + fallbacks
    selected = preferred
    fallback_used = False
    model_available = False

    if ollama_available:
        for candidate in candidates:
            if candidate in installed:
                selected = candidate
                fallback_used = candidate != preferred
                model_available = True
                break

    return {
        "id": item["id"],
        "display_name": item["display_name"],
        "enabled": bool(item["enabled"]),
        "preferred_model": preferred,
        "selected_model": selected,
        "fallback_used": fallback_used,
        "model_available": model_available,
        "route_mode": item["route_mode"],
        "tools_policy": item["tools_policy"],
        "temperature": float(item.get("temperature", 0.5)),
        "max_steps": int(item.get("max_steps", 0)),
        "tags": list(item.get("tags") or []),
        "ollama_available": ollama_available,
        "ollama_error": ollama_error,
    }


app = FastAPI(
    title="WCKD Specialist Registry",
    description="Central registry for WCKD specialist profiles and model resolution.",
    version=VERSION,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8080", "http://127.0.0.1:8080"],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup() -> None:
    _ensure_registry()


@app.get("/health")
def health() -> dict[str, Any]:
    try:
        payload = _load_registry()
        validation = _validate_payload(payload)
    except Exception as exc:
        return {
            "status": "error",
            "version": VERSION,
            "registry_file": str(REGISTRY_FILE),
            "error": str(exc),
        }

    specialists = payload["specialists"]
    enabled = [
        _normalize_id(item.get("id"))
        for item in specialists
        if isinstance(item, dict) and item.get("enabled") is True
    ]

    return {
        "status": "ok" if validation["valid"] else "degraded",
        "version": VERSION,
        "schema_version": payload.get("schema_version", 1),
        "registry_file": str(REGISTRY_FILE),
        "specialists_total": len(specialists),
        "specialists_enabled": len(enabled),
        "enabled_ids": enabled,
        "valid": validation["valid"],
        "warnings": validation["warnings"],
    }


@app.get("/specialists")
def list_specialists(enabled_only: bool = False) -> dict[str, Any]:
    payload = _load_registry()
    validation = _validate_payload(payload)

    if not validation["valid"]:
        raise HTTPException(
            status_code=500,
            detail={"message": "Registry validation failed.", **validation},
        )

    specialists = []
    for item in payload["specialists"]:
        normalized = dict(item)
        normalized["id"] = _normalize_id(normalized.get("id"))
        if enabled_only and not normalized.get("enabled"):
            continue
        specialists.append(normalized)

    return {
        "status": "ok",
        "version": VERSION,
        "count": len(specialists),
        "specialists": specialists,
    }


@app.get("/specialists/{specialist_id}")
def get_specialist(specialist_id: str) -> dict[str, Any]:
    return {
        "status": "ok",
        "version": VERSION,
        "specialist": _get_specialist(specialist_id),
    }


@app.get("/resolve/{specialist_id}")
def resolve_specialist(
    specialist_id: str,
    allow_disabled: bool = False,
) -> dict[str, Any]:
    item = _get_specialist(specialist_id)

    if not item.get("enabled") and not allow_disabled:
        raise HTTPException(
            status_code=409,
            detail=f"Specialist {item['id']} is disabled.",
        )

    return {
        "status": "ok",
        "version": VERSION,
        "resolution": _resolve_specialist(item),
    }


@app.get("/validate")
def validate_registry() -> dict[str, Any]:
    payload = _load_registry()
    validation = _validate_payload(payload)

    ollama_available, installed, ollama_error = _installed_models()
    missing_models: list[dict[str, Any]] = []

    if ollama_available:
        for item in payload["specialists"]:
            if not isinstance(item, dict):
                continue

            preferred = str(item.get("preferred_model") or "")
            fallbacks = [str(v) for v in item.get("fallback_models") or []]
            candidates = [preferred] + fallbacks
            available_candidates = [m for m in candidates if m in installed]

            if not available_candidates:
                missing_models.append(
                    {
                        "id": _normalize_id(item.get("id")),
                        "candidates": candidates,
                    }
                )

    valid = bool(validation["valid"]) and not missing_models

    return {
        "status": "ok" if valid else "degraded",
        "version": VERSION,
        "valid": valid,
        "schema_valid": validation["valid"],
        "errors": validation["errors"],
        "warnings": validation["warnings"],
        "ollama_available": ollama_available,
        "ollama_error": ollama_error,
        "installed_models": installed,
        "missing_model_candidates": missing_models,
    }


@app.post("/reload")
def reload_registry() -> dict[str, Any]:
    payload = _load_registry()
    validation = _validate_payload(payload)

    if not validation["valid"]:
        raise HTTPException(
            status_code=500,
            detail={"message": "Registry validation failed.", **validation},
        )

    return {
        "status": "ok",
        "version": VERSION,
        "reloaded": True,
        "specialists_total": len(payload["specialists"]),
        "updated": payload.get("updated"),
    }
