from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
import urllib.parse
from datetime import datetime
from pathlib import Path
from threading import Lock

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse

AI_ROOT = Path(__file__).resolve().parent
OLLAMA_OPENAI_URL = "http://127.0.0.1:11434/v1/chat/completions"
STATE_FILE = AI_ROOT / "router-state.json"

AGENT_RUNNER_BASE_URL = "http://127.0.0.1:8030"
AGENT_DEFAULT_MAX_STEPS = 180
AGENT_DEFAULT_MAX_MINUTES = 180

SPECIALIST_REGISTRY_BASE_URL = "http://127.0.0.1:8050"
SPECIALIST_REGISTRY_TIMEOUT_SECONDS = 4

MODEL_MANAGER_BASE_URL = "http://127.0.0.1:8040"
MODEL_MANAGER_STATUS_TIMEOUT_SECONDS = 5
MODEL_MANAGER_SWITCH_TIMEOUT_SECONDS = 300

ROUTER_MODEL_ID = "wckd-auto"
ROUTER_MODEL_NAME = "WCKD AI Auto"

# ============================================================
# INSTALLED MODEL ROLES
# ============================================================
# Auto routing prefers models that fit comfortably on the RTX 4070 Ti SUPER.
# The large Nemotron models stay available as explicit sticky modes until they
# are benchmarked locally for speed/RAM/VRAM.
MODEL_GENERAL = "qwen3.5:9b"
MODEL_FAST = "nemotron-3-nano:4b"
MODEL_SMART = "gpt-oss:20b"

# v1.6 benchmark-driven automatic roles.
# - GPT-OSS is the best speed/quality choice for hard coding/reasoning.
# - Qwen3.5 is the most reliable general/agentic model in WCKD HARD v3.
# - Nemotron Nano 4B is kept narrowly scoped to low-risk structured tool execution.
MODEL_CODE = "gpt-oss:20b"
MODEL_AGENTIC = "qwen3.5:9b"
MODEL_TOOL = "nemotron-3-nano:4b"
MODEL_WRITING = "qwen3.5:9b"

MODEL_NEMOTRON_FAST = "nemotron-3-nano:4b"
MODEL_NEMOTRON_AGENT = "nemotron-3-nano:30b"
ALL_KNOWN_MODELS = [
    MODEL_GENERAL,
    MODEL_FAST,
    MODEL_SMART,
    MODEL_NEMOTRON_FAST,
    MODEL_NEMOTRON_AGENT,
]

OLLAMA_TAGS_URL = "http://127.0.0.1:11434/api/tags"
MODEL_CACHE_SECONDS = 5

UPSTREAM_TIMEOUT_SECONDS = 900

ALLOWED_OPENAI_FIELDS = {
    "model", "messages", "frequency_penalty", "presence_penalty",
    "response_format", "seed", "stop", "stream", "stream_options",
    "temperature", "top_p", "max_tokens", "tools",
    "reasoning_effort", "reasoning",
}

CODE_KEYWORDS = {
    "scrie cod", "scrie un script", "scrie script", "genereaza cod",
    "genereazÄƒ cod", "modifica cod", "modificÄƒ cod", "refactor",
    "debug", "debugging", "depanare", "stack trace", "stacktrace",
    "exception", "traceback", "compile", "compilare", "bug",
    "eroare in cod", "eroare Ã®n cod", "optimize code", "optimizare cod",
    "fix code", "fixeaza cod", "fixeazÄƒ cod",
}

REASONING_KEYWORDS = {
    "analizeaza", "analizeazÄƒ", "analiza in detaliu", "analizÄƒ Ã®n detaliu",
    "compara in detaliu", "comparÄƒ Ã®n detaliu", "reasoning",
    "deep analysis", "strategie", "strategy", "arhitectura", "arhitecturÄƒ",
    "architecture", "plan detaliat", "tradeoff", "trade-off",
    "avantaje si dezavantaje", "avantaje È™i dezavantaje", "diagnostic",
    "investigheaza", "investigheazÄƒ", "root cause", "cauza radacina",
    "cauza rÄƒdÄƒcinÄƒ", "benchmark", "optimizeaza", "optimizeazÄƒ",
}

WRITING_KEYWORDS = {
    "rezuma", "rezumÄƒ", "rezumat", "sumarizeaza", "sumarizeazÄƒ",
    "summarize", "summary", "rescrie", "rewrite", "reformuleaza",
    "reformuleazÄƒ", "rephrase", "corecteaza text", "corecteazÄƒ text",
    "proofread", "traducere", "tradu", "translate",
}


TOOL_ACTION_KEYWORDS = {
    "creeaza", "creeazÄƒ", "scrie fisier", "scrie fiÈ™ier", "modifica fisier",
    "modificÄƒ fiÈ™ier", "citeste fisier", "citeÈ™te fiÈ™ier", "listeaza fisiere",
    "listeazÄƒ fiÈ™iere", "muta fisier", "mutÄƒ fiÈ™ier", "redenumeÈ™te",
    "redenumeste", "verifica serviciul", "verificÄƒ serviciul",
    "verifica status", "verificÄƒ status", "verifica statusul", "verificÄƒ statusul",
    "verifica starea", "verificÄƒ starea", "statusul serviciului", "starea serviciului",
    "porneste", "porneÈ™te", "opreste", "opreÈ™te",
    "restart", "reporneÈ™te", "reporneste", "create file", "write file",
    "edit file", "read file", "list files", "move file", "rename file",
    "check service", "check status", "start service", "stop service",
    "restart service", "restart container", "start container", "stop container",
}

# Multi-step / autonomous tool work should remain on GPT-OSS for the whole
# conversation. These are deliberately high-signal phrases rather than generic
# verbs so ordinary one-shot tool calls can stay on Qwen.
AGENTIC_KEYWORDS = {
    "wckd-lab", "lab_exec", "lab_write_file", "systemd",
    "pana functioneaza", "pÃ¢nÄƒ funcÈ›ioneazÄƒ", "pana cand functioneaza",
    "pÃ¢nÄƒ cÃ¢nd funcÈ›ioneazÄƒ", "repara singur", "reparÄƒ singur",
    "investigheaza si repara", "investigheazÄƒ È™i reparÄƒ",
    "continua autonom", "continuÄƒ autonom", "autonom",
    "nu te opri la prima eroare", "retesteaza", "retesteazÄƒ",
    "instaleaza singur", "instaleazÄƒ singur", "configureaza", "configureazÄƒ",
    "testeaza singur", "testeazÄƒ singur", "until it works",
    "fix it until", "self-correct", "self correct", "multi-step", "multistep",
}

MANUAL_ROUTES = {
    "/fast": (MODEL_FAST, "FAST"),
    "/balanced": (MODEL_GENERAL, "GENERAL"),
    "/smart": (MODEL_SMART, "SMART"),
    "/agentic": (MODEL_AGENTIC, "AGENTIC"),
    "/tools": (MODEL_TOOL, "TOOLS"),
    "/code": (MODEL_CODE, "CODE"),
    "/write": (MODEL_WRITING, "WRITING"),
    "/deep": (MODEL_NEMOTRON_AGENT, "DEEP"),
    "/nano": (MODEL_NEMOTRON_FAST, "NANO"),
    "/qwen35": (MODEL_GENERAL, "GENERAL"),
    "/gptoss": (MODEL_SMART, "SMART"),
    "/nemotron4": (MODEL_NEMOTRON_FAST, "NANO"),
    "/nemotron30": (MODEL_NEMOTRON_AGENT, "DEEP"),
    "/auto": (None, "AUTO"),
}

_state_lock = Lock()
_model_cache_lock = Lock()
_model_cache = {"timestamp": 0.0, "models": []}

app = FastAPI(
    title="WCKD AI Auto Router",
    description=(
        "Local OpenAI-compatible model router for Ollama. "
        "v1.7.0 adds WCKD Specialist Registry integration on top of Model Manager, with fail-safe fallback to the built-in routing profile."
    ),
    version="1.7.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8080", "http://127.0.0.1:8080"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _write_state(data: dict) -> None:
    AI_ROOT.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".json.tmp")
    with _state_lock:
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(STATE_FILE)


def _read_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {
            "status": "idle",
            "router_model": ROUTER_MODEL_ID,
            "active_model": MODEL_GENERAL,
            "task": "GENERAL",
            "reason": "default",
            "sticky": False,
            "updated": _now_iso(),
        }



def _installed_models(force: bool = False) -> list[str]:
    now = time.monotonic()
    with _model_cache_lock:
        if (
            not force
            and _model_cache["models"]
            and now - float(_model_cache["timestamp"]) < MODEL_CACHE_SECONDS
        ):
            return list(_model_cache["models"])

    models: list[str] = []
    try:
        req = urllib.request.Request(
            OLLAMA_TAGS_URL,
            method="GET",
            headers={"Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=3) as response:
            payload = json.loads(response.read().decode("utf-8", errors="replace"))
        for item in payload.get("models") or []:
            if not isinstance(item, dict):
                continue
            name = item.get("name") or item.get("model")
            if isinstance(name, str) and name.strip():
                models.append(name.strip())
    except Exception:
        models = []

    unique = list(dict.fromkeys(models))
    with _model_cache_lock:
        _model_cache["timestamp"] = now
        _model_cache["models"] = unique
    return unique


def _resolve_model(preferred: str, *fallbacks: str) -> tuple[str, bool]:
    installed = _installed_models()
    if not installed:
        return preferred, False
    for candidate in (preferred, *fallbacks):
        if candidate and candidate in installed:
            return candidate, candidate != preferred
    return preferred, False



def _specialist_registry_json(
    path: str,
    method: str = "GET",
    timeout: int = SPECIALIST_REGISTRY_TIMEOUT_SECONDS,
) -> dict:
    url = SPECIALIST_REGISTRY_BASE_URL.rstrip("/") + "/" + path.lstrip("/")
    request = urllib.request.Request(
        url,
        method=method,
        headers={"Accept": "application/json"},
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read().decode("utf-8", errors="replace")
        except Exception:
            detail = ""
        raise RuntimeError(
            f"Specialist Registry HTTP {exc.code}: {detail or exc.reason}"
        ) from exc

    try:
        payload = json.loads(raw or "{}")
    except json.JSONDecodeError as exc:
        raise RuntimeError("Specialist Registry returned invalid JSON.") from exc

    if not isinstance(payload, dict):
        raise RuntimeError("Specialist Registry returned a non-object JSON response.")

    return payload


def _specialist_registry_health() -> dict:
    try:
        payload = _specialist_registry_json("/health")
        return {
            "available": True,
            "status": payload.get("status"),
            "version": payload.get("version"),
            "specialists_total": payload.get("specialists_total"),
            "specialists_enabled": payload.get("specialists_enabled"),
            "valid": payload.get("valid"),
        }
    except Exception as exc:
        return {
            "available": False,
            "error": str(exc),
        }


def _specialist_role_for_route(route: dict) -> str | None:
    task = str(route.get("task") or "").upper()
    reason = str(route.get("reason") or "")

    # Automatic routes are always eligible for Specialist Registry resolution.
    if not route.get("manual"):
        if task == "LONG_CONTEXT":
            return "GENERAL"
        if task in {
            "GENERAL",
            "CODE",
            "REASONING",
            "WRITING",
            "TOOLS",
            "AGENTIC",
        }:
            return task
        return None

    # Role-style manual commands follow the registry.
    # Exact-model aliases (/qwen35, /gptoss, /model, etc.) remain exact.
    manual_role_map = {
        "sticky-manual:/balanced": "GENERAL",
        "sticky-manual:/smart": "REASONING",
        "sticky-manual:/agentic": "AGENTIC",
        "sticky-manual:/tools": "TOOLS",
        "sticky-manual:/code": "CODE",
        "sticky-manual:/write": "WRITING",
    }

    for prefix, role in manual_role_map.items():
        if reason.startswith(prefix):
            # /smart may be promoted to AGENTIC when tool history requires it.
            if task == "AGENTIC":
                return "AGENTIC"
            return role

    return None


def _apply_specialist_registry(route: dict) -> dict:
    result = dict(route)
    role = _specialist_role_for_route(result)

    telemetry = {
        "integration": True,
        "role": role,
        "available": False,
        "source": "router-fallback",
        "fallback_direct_router": False,
        "selected_model": result.get("model"),
    }

    if not role:
        telemetry["source"] = "not-applicable"
        result["specialist_registry"] = telemetry
        return result

    try:
        payload = _specialist_registry_json(
            f"/resolve/{urllib.parse.quote(role, safe='')}"
        )
        resolution = payload.get("resolution")

        if not isinstance(resolution, dict):
            raise RuntimeError("Specialist Registry response has no resolution object.")

        selected_model = resolution.get("selected_model")
        model_available = resolution.get("model_available")

        if not isinstance(selected_model, str) or not selected_model.strip():
            raise RuntimeError("Specialist Registry returned an empty selected_model.")

        if model_available is not True:
            raise RuntimeError(
                f"Specialist {role} has no available model candidate."
            )

        selected_model = selected_model.strip()
        previous_model = result.get("model")
        result["model"] = selected_model

        telemetry.update({
            "available": True,
            "source": "specialist-registry",
            "registry_version": payload.get("version"),
            "preferred_model": resolution.get("preferred_model"),
            "selected_model": selected_model,
            "fallback_used": bool(resolution.get("fallback_used")),
            "model_available": True,
            "route_mode": resolution.get("route_mode"),
            "tools_policy": resolution.get("tools_policy"),
            "temperature": resolution.get("temperature"),
            "max_steps": resolution.get("max_steps"),
            "router_fallback_model": previous_model,
        })

    except Exception as exc:
        telemetry.update({
            "fallback_direct_router": True,
            "error": str(exc),
        })

    result["specialist_registry"] = telemetry
    return result


def _dynamic_model_directive(text: str) -> tuple[str | None, str | None]:
    normalized = text.strip().replace("\r\n", "\n").replace("\r", "\n")
    match = re.match(r"^/model(?!s)(?:\s+)([^\s]+)", normalized, flags=re.IGNORECASE)
    if not match:
        return None, None
    return "/model", match.group(1).strip()


def _strip_dynamic_model_prefix(value: str) -> str:
    normalized = value.replace("\r\n", "\n").replace("\r", "\n")
    return re.sub(
        r"^(\s*)/model(?!s)\s+[^\s]+[ \t]*(?:\n)?",
        r"\1",
        normalized,
        count=1,
        flags=re.IGNORECASE,
    ).lstrip()


def _content_to_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if not isinstance(item, dict):
                continue
            if str(item.get("type", "")).lower() in {"text", "input_text"}:
                value = item.get("text")
                if isinstance(value, str):
                    parts.append(value)
        return "\n".join(parts)
    return ""




def _user_texts(messages: list) -> list[str]:
    result: list[str] = []
    for message in messages:
        if isinstance(message, dict) and message.get("role") == "user":
            text = _content_to_text(message.get("content"))
            if text:
                result.append(text)
    return result


def _latest_user_text(messages: list) -> str:
    texts = _user_texts(messages)
    return texts[-1] if texts else ""


def _has_keyword(text: str, keywords: set[str]) -> bool:
    for keyword in keywords:
        pattern = r"(?<!\w)" + re.escape(keyword) + r"(?!\w)"
        if re.search(pattern, text, flags=re.IGNORECASE):
            return True
    return False


def _message_has_tool_history(messages: list) -> bool:
    for message in messages:
        if not isinstance(message, dict):
            continue
        if message.get("role") == "tool":
            return True
        if message.get("role") == "assistant" and message.get("tool_calls"):
            return True
    return False


def _manual_directive(messages: list) -> tuple[str | None, str | None, str | None]:
    """Return the latest sticky manual routing directive across the chat."""
    latest_prefix: str | None = None
    latest_model: str | None = None
    latest_task: str | None = None

    for text_value in _user_texts(messages):
        stripped = text_value.lstrip()
        lower = stripped.lower()

        dynamic_prefix, dynamic_model = _dynamic_model_directive(stripped)
        if dynamic_prefix and dynamic_model:
            latest_prefix = dynamic_prefix
            latest_model = dynamic_model
            latest_task = "MANUAL"
            continue

        for prefix, (model, task) in MANUAL_ROUTES.items():
            if re.match(r"^" + re.escape(prefix) + r"(?:\s|$)", lower):
                latest_prefix = prefix
                latest_model = model
                latest_task = task
                break

    return latest_prefix, latest_model, latest_task


def _strip_manual_prefixes(messages: list) -> None:
    """Remove WCKD routing commands before forwarding messages to Ollama."""
    prefixes = tuple(MANUAL_ROUTES.keys())

    def strip_value(value: str) -> str:
        dynamic_prefix, dynamic_model = _dynamic_model_directive(value.lstrip())
        if dynamic_prefix and dynamic_model:
            return _strip_dynamic_model_prefix(value)

        stripped = value.lstrip()
        lower = stripped.lower()
        for prefix in prefixes:
            if re.match(r"^" + re.escape(prefix) + r"(?:\s|$)", lower):
                rest = stripped[len(prefix):]
                return rest.lstrip()
        return value

    for message in messages:
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            message["content"] = strip_value(content)
            continue
        if isinstance(content, list):
            for item in content:
                if not isinstance(item, dict):
                    continue
                if str(item.get("type", "")).lower() not in {"text", "input_text"}:
                    continue
                value = item.get("text")
                if isinstance(value, str):
                    item["text"] = strip_value(value)


def choose_route(body: dict) -> dict:
    messages = body.get("messages") or []
    if not isinstance(messages, list):
        messages = []

    prompt = _latest_user_text(messages)
    prompt_lower = prompt.lower().strip()
    prompt_chars = len(prompt)
    all_user_text = "\n".join(_user_texts(messages)).lower()
    has_tools = bool(body.get("tools"))
    has_image = False
    has_tool_history = _message_has_tool_history(messages)

    directive, manual_model, manual_task = _manual_directive(messages)

    # Manual model locks are conversation-sticky. /auto clears the lock.
    if directive and directive != "/auto":
        task = manual_task or "MANUAL"
        selected = manual_model or MODEL_GENERAL
        if directive == "/smart" and has_tools and (
            has_tool_history or _has_keyword(all_user_text, AGENTIC_KEYWORDS)
        ):
            task = "AGENTIC"

        fallback_used = False
        if directive != "/model":
            if selected == MODEL_NEMOTRON_AGENT:
                selected, fallback_used = _resolve_model(selected, MODEL_SMART, MODEL_GENERAL)
            elif selected == MODEL_NEMOTRON_FAST:
                selected, fallback_used = _resolve_model(selected, MODEL_FAST, MODEL_GENERAL)
            elif selected == MODEL_WRITING:
                selected, fallback_used = _resolve_model(selected, MODEL_GENERAL, MODEL_FAST)
            elif selected == MODEL_SMART:
                selected, fallback_used = _resolve_model(selected, MODEL_GENERAL, MODEL_FAST)
            else:
                selected, fallback_used = _resolve_model(selected, MODEL_GENERAL, MODEL_FAST)

        reason = f"sticky-manual:{directive}" + (":fallback" if fallback_used else "")
        return {
            "model": selected,
            "task": task,
            "reason": reason,
            "manual": True,
            "sticky": True,
            "prompt_chars": prompt_chars,
            "has_tools": has_tools,
            "has_image": has_image,
            "has_tool_history": has_tool_history,
        }

    # /auto means the conversation is explicitly back in automatic routing.
    manual_cleared = directive == "/auto"


    # Complex multi-step tool work stays on GPT-OSS across tool continuations.
    if has_tools and _has_keyword(all_user_text, AGENTIC_KEYWORDS):
        return {
            "model": _resolve_model(MODEL_AGENTIC, MODEL_SMART, MODEL_GENERAL)[0],
            "task": "AGENTIC",
            "reason": "benchmark-agentic-recovery",
            "manual": False,
            "sticky": True,
            "prompt_chars": prompt_chars,
            "has_tools": True,
            "has_image": False,
            "has_tool_history": has_tool_history,
        }

    if _has_keyword(prompt_lower, CODE_KEYWORDS):
        return {
            "model": _resolve_model(MODEL_CODE, MODEL_SMART, MODEL_GENERAL)[0],
            "task": "CODE",
            "reason": "coding-intent",
            "manual": False,
            "sticky": False,
            "prompt_chars": prompt_chars,
            "has_tools": has_tools,
            "has_image": False,
            "has_tool_history": has_tool_history,
        }

    if _has_keyword(prompt_lower, REASONING_KEYWORDS):
        return {
            "model": _resolve_model(MODEL_SMART, MODEL_GENERAL, MODEL_FAST)[0],
            "task": "REASONING",
            "reason": "reasoning-intent",
            "manual": False,
            "sticky": False,
            "prompt_chars": prompt_chars,
            "has_tools": has_tools,
            "has_image": False,
            "has_tool_history": has_tool_history,
        }

    if _has_keyword(prompt_lower, WRITING_KEYWORDS):
        return {
            "model": _resolve_model(MODEL_WRITING, MODEL_GENERAL, MODEL_FAST)[0],
            "task": "WRITING",
            "reason": "writing-intent",
            "manual": False,
            "sticky": False,
            "prompt_chars": prompt_chars,
            "has_tools": has_tools,
            "has_image": False,
            "has_tool_history": has_tool_history,
        }


    # One-shot / simple tool actions stay fast on Qwen.
    if has_tools and _has_keyword(prompt_lower, TOOL_ACTION_KEYWORDS):
        return {
            "model": _resolve_model(MODEL_TOOL, MODEL_FAST, MODEL_GENERAL)[0],
            "task": "TOOLS",
            "reason": "benchmark-fast-tools",
            "manual": False,
            "sticky": False,
            "prompt_chars": prompt_chars,
            "has_tools": True,
            "has_image": False,
            "has_tool_history": has_tool_history,
        }

    if prompt_chars >= 1800:
        return {
            "model": _resolve_model(MODEL_GENERAL, MODEL_SMART, MODEL_FAST)[0],
            "task": "LONG_CONTEXT",
            "reason": "long-prompt",
            "manual": False,
            "sticky": False,
            "prompt_chars": prompt_chars,
            "has_tools": has_tools,
            "has_image": False,
            "has_tool_history": has_tool_history,
        }

    return {
        "model": _resolve_model(MODEL_GENERAL, MODEL_FAST)[0],
        "task": "GENERAL",
        "reason": "default-balanced" if not manual_cleared else "auto-reset-default",
        "manual": False,
        "sticky": False,
        "prompt_chars": prompt_chars,
        "has_tools": has_tools,
        "has_image": False,
        "has_tool_history": has_tool_history,
    }


def _prepare_body(original: dict, route: dict) -> dict:
    body = {k: v for k, v in original.items() if k in ALLOWED_OPENAI_FIELDS}

    if "max_tokens" not in body and original.get("max_completion_tokens") is not None:
        body["max_tokens"] = original["max_completion_tokens"]

    # Work on a copied message list so routing directives are never sent to Ollama.
    messages = json.loads(json.dumps(body.get("messages", []), ensure_ascii=False))
    _strip_manual_prefixes(messages)
    body["messages"] = messages

    body["model"] = route["model"]

    if body.get("stream"):
        options = body.get("stream_options")
        if not isinstance(options, dict):
            options = {}
        options["include_usage"] = True
        body["stream_options"] = options

    if route["model"] == MODEL_SMART and "reasoning_effort" not in body and "reasoning" not in body:
        body["reasoning_effort"] = "medium"

    return body


def _make_request(body: dict) -> urllib.request.Request:
    return urllib.request.Request(
        OLLAMA_OPENAI_URL,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "text/event-stream, application/json",
        },
    )


def _error_detail(exc: Exception) -> str:
    if isinstance(exc, urllib.error.HTTPError):
        try:
            details = exc.read().decode("utf-8", errors="replace")
        except Exception:
            details = ""
        return f"Ollama HTTP {exc.code}: {details or exc.reason}"
    return str(exc)



def _http_json(
    url: str,
    method: str = "GET",
    payload: dict | None = None,
    timeout: int = 30,
) -> dict:
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = urllib.request.Request(url, data=data, method=method, headers=headers)

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read().decode("utf-8", errors="replace")
        except Exception:
            detail = ""
        raise RuntimeError(f"Agent Runner HTTP {exc.code}: {detail or exc.reason}") from exc

    parsed = json.loads(raw or "{}")
    if not isinstance(parsed, dict):
        raise RuntimeError("Agent Runner returned a non-object JSON response.")
    return parsed



def _model_manager_json(
    path: str,
    method: str = "GET",
    timeout: int = MODEL_MANAGER_STATUS_TIMEOUT_SECONDS,
) -> dict:
    url = MODEL_MANAGER_BASE_URL.rstrip("/") + path
    request = urllib.request.Request(
        url,
        method=method,
        headers={"Accept": "application/json"},
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read().decode("utf-8", errors="replace")
        except Exception:
            detail = ""
        raise RuntimeError(
            f"Model Manager HTTP {exc.code}: {detail or exc.reason}"
        ) from exc
    except Exception as exc:
        raise RuntimeError(f"Model Manager unavailable: {exc}") from exc

    try:
        payload = json.loads(raw or "{}")
    except json.JSONDecodeError as exc:
        raise RuntimeError("Model Manager returned invalid JSON.") from exc

    if not isinstance(payload, dict):
        raise RuntimeError("Model Manager returned a non-object JSON response.")

    return payload


def _model_manager_health() -> dict:
    try:
        payload = _model_manager_json(
            "/health",
            timeout=MODEL_MANAGER_STATUS_TIMEOUT_SECONDS,
        )
        return {
            "available": True,
            "status": payload.get("status"),
            "version": payload.get("version"),
            "policy": payload.get("policy"),
            "active_model": payload.get("active_model"),
            "running_models": payload.get("running_models"),
        }
    except Exception as exc:
        return {
            "available": False,
            "error": str(exc),
        }


def _running_model_names(status_payload: dict) -> list[str]:
    result: list[str] = []
    for item in status_payload.get("running_models") or []:
        if not isinstance(item, dict):
            continue
        name = item.get("name") or item.get("model")
        if isinstance(name, str) and name.strip():
            result.append(name.strip())
    return result


def _ensure_model_active(model: str) -> dict:
    """Best-effort Model Manager integration.

    The router asks Model Manager to enforce the single-active-model policy
    before forwarding inference to Ollama. If Model Manager is unavailable,
    routing falls back to the pre-v1.6.1 direct-Ollama behavior instead of
    failing the user request.
    """
    result = {
        "available": False,
        "requested_model": model,
        "active_before": None,
        "active_after": None,
        "action": "fallback-direct-ollama",
        "switched": False,
        "unloaded": [],
        "fallback_direct_ollama": False,
    }

    try:
        status = _model_manager_json(
            "/status",
            timeout=MODEL_MANAGER_STATUS_TIMEOUT_SECONDS,
        )
        result["available"] = True

        active_before = status.get("active_model")
        running_before = _running_model_names(status)

        result["active_before"] = active_before
        result["running_before"] = running_before

        # Fast path: do not prewarm/reload a model that is already the one and
        # only Ollama model in memory.
        if active_before == model and running_before == [model]:
            result["active_after"] = model
            result["running_after"] = running_before
            result["action"] = "already-active"
            return result

        quoted_model = urllib.parse.quote(model, safe="")
        switched = _model_manager_json(
            f"/switch/{quoted_model}",
            method="POST",
            timeout=MODEL_MANAGER_SWITCH_TIMEOUT_SECONDS,
        )

        running_after = switched.get("running_after") or []
        result["active_after"] = switched.get("model") or model
        result["running_after"] = running_after
        result["action"] = "switch"
        result["switched"] = True
        result["unloaded"] = switched.get("unloaded") or []
        return result

    except Exception as exc:
        result["fallback_direct_ollama"] = True
        result["error"] = str(exc)
        return result

def _extract_workspace(text: str) -> str:
    match = re.search(r"(?<![\\w-])(/workspace(?:/[^\\s`\\\"'<>]+)*)", text)
    if not match:
        return "/workspace"
    value = match.group(1).rstrip(".,;:!?)]}")
    return value or "/workspace"



def _direct_models_command(messages: list) -> bool:
    latest = _latest_user_text(messages).strip()
    return bool(re.match(r"^/models(?:\s|$)", latest, flags=re.IGNORECASE))


def _models_text() -> str:
    installed = _installed_models(force=True)
    if not installed:
        return "Nu am putut citi lista Ollama de pe 127.0.0.1:11434."
    lines = ["Modele Ollama instalate:"]
    lines.extend(f"- `{name}`" for name in installed)
    lines += [
        "",
        "Comenzi WCKD:",
        "- `/balanced` â†’ qwen3.5:9b",
        "- `/fast` â†’ nemotron-3-nano:4b",
        "- `/smart` â†’ gpt-oss:20b",
        "- `/agentic` â†’ qwen3.5:9b",
        "- `/tools` â†’ nemotron-3-nano:4b",
        "- `/code` â†’ gpt-oss:20b",
        "- `/write` â†’ qwen3.5:9b",
        "- `/nano` â†’ nemotron-3-nano:4b",
        "- `/deep` â†’ nemotron-3-nano:30b",
        "- `/model <name>` â†’ orice model Ollama instalat",
        "- `/auto` â†’ revine la WCKD Auto",
    ]
    return "\n".join(lines)


def _direct_agent_command(messages: list) -> tuple[str, str] | None:
    """Intercept explicit Agent Runner commands before any LLM call.

    Accepts LF, CRLF, tabs or spaces after /agent. Status/result/cancel/list
    commands are checked first so /agent does not swallow /agent-status etc.
    """
    latest = _latest_user_text(messages).strip()
    if not latest:
        return None

    normalized = latest.replace("\r\n", "\n").replace("\r", "\n")
    lower = normalized.lower()

    if re.match(r"^/agent-jobs(?:\s|$)", lower):
        return ("jobs", "")

    for prefix, command in (
        ("/agent-status", "status"),
        ("/agent-result", "result"),
        ("/agent-cancel", "cancel"),
    ):
        match = re.match(
            r"^" + re.escape(prefix) + r"(?:\s+(.+))?$",
            normalized,
            flags=re.IGNORECASE | re.DOTALL,
        )
        if match:
            return (command, (match.group(1) or "").strip())

    match = re.match(
        r"^/agent(?:\s+|$)(.*)$",
        normalized,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if match:
        return ("start", (match.group(1) or "").strip())

    return None


def _openai_text_response(text_content: str, stream: bool, model: str = ROUTER_MODEL_ID):
    created = int(datetime.now().timestamp())
    completion_id = f"chatcmpl-wckd-{created}"

    if stream:
        def generate():
            first = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [{
                    "index": 0,
                    "delta": {"role": "assistant", "content": text_content},
                    "finish_reason": None,
                }],
            }
            last = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            }
            yield ("data: " + json.dumps(first, ensure_ascii=False) + "\n\n").encode("utf-8")
            yield ("data: " + json.dumps(last, ensure_ascii=False) + "\n\n").encode("utf-8")
            yield b"data: [DONE]\n\n"

        return StreamingResponse(
            generate(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-WCKD-Task": "AGENT_RUNNER"},
        )

    payload = {
        "id": completion_id,
        "object": "chat.completion",
        "created": created,
        "model": model,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": text_content},
            "finish_reason": "stop",
        }],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }
    return Response(
        content=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        media_type="application/json",
        headers={"X-WCKD-Task": "AGENT_RUNNER"},
    )


def _handle_direct_agent_command(command: str, argument: str, original: dict):
    stream = bool(original.get("stream"))
    state = {
        "status": "agent-command",
        "router_model": ROUTER_MODEL_ID,
        "active_model": "gpt-oss:20b",
        "task": "AGENT_RUNNER",
        "reason": f"direct-agent:{command}",
        "manual": True,
        "sticky": True,
        "prompt_chars": len(argument),
        "has_tools": False,
        "has_image": False,
        "has_tool_history": False,
        "started": _now_iso(),
        "updated": _now_iso(),
    }
    _write_state(state)

    try:
        if command == "start":
            if not argument.strip():
                return _openai_text_response(
                    "WCKD Agent Runner nu a fost pornit: dupÄƒ `/agent` trebuie sÄƒ existe obiectivul taskului.",
                    stream,
                )

            workspace = _extract_workspace(argument)
            result = _http_json(
                AGENT_RUNNER_BASE_URL + "/agent/start",
                method="POST",
                payload={
                    "objective": argument,
                    "workspace": workspace,
                    "max_steps": AGENT_DEFAULT_MAX_STEPS,
                    "max_minutes": AGENT_DEFAULT_MAX_MINUTES,
                },
                timeout=30,
            )
            job_id = str(result.get("job_id") or "")
            message = (
                "WCKD Agent Runner job pornit.\n\n"
                f"Job ID: `{job_id}`\n"
                f"Status: `{result.get('status', 'started')}`\n"
                f"Workspace: `{workspace}`\n\n"
                "Jobul ruleazÄƒ persistent Ã®n background. "
                f"Verificare: `/agent-status {job_id}`"
            )

        elif command == "jobs":
            result = _http_json(AGENT_RUNNER_BASE_URL + "/agent/list?limit=20", timeout=15)
            jobs = result.get("jobs") or []
            if not jobs:
                message = "Nu existÄƒ joburi WCKD Agent Runner."
            else:
                lines = ["Joburi WCKD Agent Runner:"]
                for job in jobs[:20]:
                    lines.append(
                        "- `{}` â€” {} â€” step {}/{} â€” {}".format(
                            job.get("job_id", "?"),
                            job.get("status", "?"),
                            job.get("step", 0),
                            job.get("max_steps", "?"),
                            job.get("last_activity") or "-",
                        )
                    )
                message = "\n".join(lines)

        else:
            job_id = argument.strip().split()[0] if argument.strip() else ""
            if not job_id:
                return _openai_text_response(f"LipseÈ™te Job ID pentru `/agent-{command}`.", stream)

            quoted = urllib.parse.quote(job_id)
            if command == "status":
                result = _http_json(AGENT_RUNNER_BASE_URL + f"/agent/status/{quoted}", timeout=15)
                message = (
                    f"Job ID: `{job_id}`\n"
                    f"Status: `{result.get('status')}`\n"
                    f"Step: `{result.get('step')}/{result.get('max_steps')}`\n"
                    f"Activity: `{result.get('last_activity')}`\n"
                    f"Last tool: `{result.get('last_tool')}`\n"
                    f"Last error: `{result.get('last_error')}`"
                )
            elif command == "result":
                result = _http_json(AGENT_RUNNER_BASE_URL + f"/agent/result/{quoted}", timeout=15)
                final_response = result.get("final_response")
                message = (
                    f"Job ID: `{job_id}`\n"
                    f"Status: `{result.get('status')}`\n"
                    f"Step: `{result.get('step')}/{result.get('max_steps')}`\n\n"
                    + (str(final_response) if final_response else str(result.get("message") or "Jobul nu are Ã®ncÄƒ rezultat final."))
                )
            elif command == "cancel":
                result = _http_json(
                    AGENT_RUNNER_BASE_URL + f"/agent/cancel/{quoted}",
                    method="POST",
                    payload={},
                    timeout=15,
                )
                message = f"Cancel solicitat pentru job `{job_id}`. Status: `{result.get('status', 'cancel-requested')}`"
            else:
                raise RuntimeError(f"Unknown direct agent command: {command}")

        state["status"] = "idle"
        state["completed"] = _now_iso()
        state["updated"] = _now_iso()
        _write_state(state)
        return _openai_text_response(message, stream)

    except Exception as exc:
        state["status"] = "error"
        state["error"] = str(exc)
        state["updated"] = _now_iso()
        _write_state(state)
        return _openai_text_response(f"WCKD Agent Runner command failed: {exc}", stream)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "version": app.version,
        "router_model": ROUTER_MODEL_ID,
        "models": {
            "general": MODEL_GENERAL,
            "fast": MODEL_FAST,
            "smart": MODEL_SMART,
            "code": MODEL_CODE,
            "agentic": MODEL_AGENTIC,
            "tools": MODEL_TOOL,
            "writing": MODEL_WRITING,
            "nemotron_fast": MODEL_NEMOTRON_FAST,
            "nemotron_agent": MODEL_NEMOTRON_AGENT,
        },
        "benchmark_profile": {
            "source": "WCKD Model Benchmark v3 HARD / Quick / ctx8192",
            "general": "qwen3.5:9b",
            "code": "gpt-oss:20b",
            "reasoning": "gpt-oss:20b",
            "writing": "qwen3.5:9b",
            "tools": "nemotron-3-nano:4b",
            "agentic": "qwen3.5:9b",
        },
        "installed_models": _installed_models(),
        "model_manager_integration": True,
        "model_manager": _model_manager_health(),
        "specialist_registry_integration": True,
        "specialist_registry": _specialist_registry_health(),
        "manual_commands": {
            "/balanced": "sticky Qwen3.5 9B until /auto",
            "/fast": "sticky Nemotron 3 Nano 4B until /auto",
            "/smart": "sticky GPT-OSS 20B until /auto",
            "/agentic": "sticky Qwen3.5 9B agentic mode until /auto",
            "/tools": "sticky Nemotron Nano 4B tool mode until /auto",
            "/code": "sticky GPT-OSS 20B coding mode until /auto",
            "/write": "sticky Qwen3.5 9B high-quality writing mode until /auto",
            "/nano": "sticky Nemotron 3 Nano 4B until /auto",
            "/deep": "sticky Nemotron 3 Nano 30B until /auto",
            "/qwen35": "exact alias for qwen3.5:9b",
            "/gptoss": "exact alias for gpt-oss:20b",
            "/nemotron4": "exact alias for nemotron-3-nano:4b",
            "/nemotron30": "exact alias for nemotron-3-nano:30b",
            "/model <name>": "sticky exact Ollama model until /auto",
            "/models": "list installed Ollama models and WCKD aliases",
            "/auto": "clear manual model lock",
            "/agent": "launch a persistent Agent Runner job directly; bypasses LLM tool selection",
            "/agent-status <job_id>": "read persistent job status directly",
            "/agent-result <job_id>": "read persistent job result directly",
            "/agent-cancel <job_id>": "cancel persistent job directly",
            "/agent-jobs": "list recent Agent Runner jobs directly",
        },
        "state": _read_state(),
    }



@app.get("/router/models")
def router_models():
    fallback_profile = {
        "GENERAL": MODEL_GENERAL,
        "TOOLS": MODEL_TOOL,
        "CODE": MODEL_CODE,
        "REASONING": MODEL_SMART,
        "AGENTIC": MODEL_AGENTIC,
        "WRITING": MODEL_WRITING,
    }

    resolved = {}
    telemetry = {}

    for role, fallback_model in fallback_profile.items():
        route = _apply_specialist_registry({
            "model": fallback_model,
            "task": role,
            "reason": "models-endpoint",
            "manual": False,
            "sticky": False,
        })
        resolved[role] = route["model"]
        telemetry[role] = route.get("specialist_registry")

    return {
        "installed": _installed_models(force=True),
        "known": ALL_KNOWN_MODELS,
        "automatic": resolved,
        "automatic_fallback_profile": fallback_profile,
        "specialist_registry_integration": True,
        "specialist_registry": _specialist_registry_health(),
        "specialist_resolution": telemetry,
    }


@app.get("/router/status")
def router_status():
    return _read_state()


@app.post("/router/route")
async def route_preview(request: Request):
    return _apply_specialist_registry(choose_route(await request.json()))


@app.get("/v1/models")
def models():
    return {
        "object": "list",
        "data": [{
            "id": ROUTER_MODEL_ID,
            "object": "model",
            "created": 0,
            "owned_by": "wckd",
            "name": ROUTER_MODEL_NAME,
        }],
    }


@app.get("/v1/models/{model_id}")
def model_detail(model_id: str):
    if model_id != ROUTER_MODEL_ID:
        raise HTTPException(status_code=404, detail="Model not found")
    return {
        "id": ROUTER_MODEL_ID,
        "object": "model",
        "created": 0,
        "owned_by": "wckd",
        "name": ROUTER_MODEL_NAME,
    }


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    try:
        original = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid JSON: {exc}")

    if not isinstance(original, dict):
        raise HTTPException(status_code=400, detail="JSON body must be an object")

    if not isinstance(original.get("messages"), list) or not original["messages"]:
        raise HTTPException(status_code=400, detail="messages must be a non-empty list")

    if _direct_models_command(original["messages"]):
        return _openai_text_response(_models_text(), bool(original.get("stream")))

    direct_agent = _direct_agent_command(original["messages"])
    if direct_agent is not None:
        command, argument = direct_agent
        return _handle_direct_agent_command(command, argument, original)

    route = _apply_specialist_registry(choose_route(original))
    upstream_body = _prepare_body(original, route)

    state = {
        "status": "preparing-model",
        "router_model": ROUTER_MODEL_ID,
        "active_model": route["model"],
        "task": route["task"],
        "reason": route["reason"],
        "manual": route["manual"],
        "sticky": route["sticky"],
        "prompt_chars": route["prompt_chars"],
        "has_tools": route["has_tools"],
        "has_image": route["has_image"],
        "has_tool_history": route["has_tool_history"],
        "specialist_registry": route.get("specialist_registry"),
        "started": _now_iso(),
        "updated": _now_iso(),
    }
    _write_state(state)

    model_manager = _ensure_model_active(route["model"])
    state["model_manager"] = model_manager
    state["status"] = "routing"
    state["updated"] = _now_iso()
    _write_state(state)

    upstream_request = _make_request(upstream_body)

    if upstream_body.get("stream"):
        def stream():
            try:
                with urllib.request.urlopen(upstream_request, timeout=UPSTREAM_TIMEOUT_SECONDS) as response:
                    while True:
                        line = response.readline()
                        if not line:
                            break
                        yield line

                state["status"] = "idle"
                state["completed"] = _now_iso()
                state["updated"] = _now_iso()
                _write_state(state)

            except Exception as exc:
                state["status"] = "error"
                state["error"] = _error_detail(exc)
                state["updated"] = _now_iso()
                _write_state(state)
                payload = {"error": {"message": state["error"], "type": "wckd_router_error"}}
                yield ("data: " + json.dumps(payload, ensure_ascii=False) + "\n\n").encode("utf-8")

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-WCKD-Routed-Model": route["model"],
                "X-WCKD-Task": route["task"],
                "X-WCKD-Specialist": str((route.get("specialist_registry") or {}).get("role") or ""),
                "X-WCKD-Sticky": str(route["sticky"]).lower(),
            },
        )

    try:
        with urllib.request.urlopen(upstream_request, timeout=UPSTREAM_TIMEOUT_SECONDS) as response:
            raw = response.read()
            media_type = response.headers.get_content_type() or "application/json"

        state["status"] = "idle"
        state["completed"] = _now_iso()
        state["updated"] = _now_iso()
        _write_state(state)

        return Response(
            content=raw,
            media_type=media_type,
            headers={
                "X-WCKD-Routed-Model": route["model"],
                "X-WCKD-Task": route["task"],
                "X-WCKD-Specialist": str((route.get("specialist_registry") or {}).get("role") or ""),
                "X-WCKD-Sticky": str(route["sticky"]).lower(),
            },
        )
    except Exception as exc:
        state["status"] = "error"
        state["error"] = _error_detail(exc)
        state["updated"] = _now_iso()
        _write_state(state)
        raise HTTPException(status_code=502, detail=state["error"])
