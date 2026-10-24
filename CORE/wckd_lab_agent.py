from __future__ import annotations

import os
import subprocess
import threading
import time
from pathlib import PurePosixPath
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

VERSION = "1.2.0"
DISTRO = "WCKD-LAB"
WSL_EXE = os.environ.get("WCKD_WSL_EXE", "wsl.exe")
MAX_OUTPUT = 80_000
DEFAULT_TIMEOUT = 120
MAX_TIMEOUT = 1800

WSL_LOCK = threading.RLock()

app = FastAPI(
    title="WCKD Lab Agent",
    description=(
        "Root-capable tool server for the isolated WCKD-LAB WSL2 distro. "
        "Use lab_exec for unrestricted root shell work. File helpers operate only "
        "inside WCKD-LAB and never on Windows drive mounts."
    ),
    version=VERSION,
)


class ExecRequest(BaseModel):
    command: str = Field(
        ...,
        min_length=1,
        max_length=50_000,
        description=(
            "Shell command to run as root inside WCKD-LAB. This is the preferred "
            "tool for apt, systemd, /etc, diagnostics and multi-step admin work."
        ),
    )
    timeout_seconds: int = Field(DEFAULT_TIMEOUT, ge=1, le=MAX_TIMEOUT)
    cwd: str = Field(
        "/workspace",
        min_length=1,
        max_length=4096,
        description="Linux working directory. Defaults to /workspace.",
    )


class ReadFileRequest(BaseModel):
    path: str = Field(
        ...,
        min_length=1,
        max_length=4096,
        description=(
            "Linux path inside WCKD-LAB. Relative paths are resolved under /workspace."
        ),
    )
    max_chars: int = Field(40_000, ge=1, le=MAX_OUTPUT)


class WriteFileRequest(BaseModel):
    path: str = Field(
        ...,
        min_length=1,
        max_length=4096,
        description=(
            "Linux path inside WCKD-LAB. Relative paths are resolved under /workspace. "
            "Absolute paths such as /etc/systemd/system/example.service are allowed."
        ),
    )
    content: str = Field(..., max_length=500_000)
    create_parent: bool = True


class ListRequest(BaseModel):
    path: str = Field("/workspace", min_length=1, max_length=4096)
    max_depth: int = Field(2, ge=1, le=6)


class MkdirRequest(BaseModel):
    path: str = Field(..., min_length=1, max_length=4096)
    parents: bool = True


class ServiceRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=256)
    action: Literal[
        "status", "start", "stop", "restart", "enable", "disable", "enable-now"
    ] = "status"


def _decode_windows_output(data: bytes | None) -> str:
    if not data:
        return ""

    sample = data[:512]
    if sample and sample.count(b"\x00") >= max(2, len(sample) // 6):
        try:
            return data.decode("utf-16-le", errors="replace").lstrip("\ufeff")
        except Exception:
            pass

    return data.decode("utf-8", errors="replace")


def _run_process(args: list[str], timeout: int) -> dict[str, Any]:
    try:
        proc = subprocess.run(
            args,
            capture_output=True,
            text=False,
            timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(
            status_code=408,
            detail=f"WCKD-LAB command timed out after {timeout}s.",
        ) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail="wsl.exe was not found.") from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"WSL execution failed: {exc}") from exc

    stdout = _decode_windows_output(proc.stdout)
    stderr = _decode_windows_output(proc.stderr)

    if len(stdout) > MAX_OUTPUT:
        stdout = stdout[:MAX_OUTPUT] + "\n...[stdout truncated]"
    if len(stderr) > MAX_OUTPUT:
        stderr = stderr[:MAX_OUTPUT] + "\n...[stderr truncated]"

    return {
        "exit_code": proc.returncode,
        "stdout": stdout,
        "stderr": stderr,
    }


def _run_wsl(command: str, timeout: int = DEFAULT_TIMEOUT) -> dict[str, Any]:
    args = [
        WSL_EXE,
        "--distribution",
        DISTRO,
        "--user",
        "root",
        "--exec",
        "bash",
        "-lc",
        command,
    ]

    with WSL_LOCK:
        last: dict[str, Any] | None = None
        for attempt in range(3):
            last = _run_process(args, timeout)
            combined = (last.get("stdout", "") + "\n" + last.get("stderr", "")).lower()

            if last["exit_code"] == 0:
                return last

            if "sharing_violation" not in combined and "being used by another process" not in combined:
                return last

            if attempt < 2:
                time.sleep(1.0 + attempt)

        return last or {"exit_code": -1, "stdout": "", "stderr": "Unknown WSL error"}


def _q(value: str) -> str:
    return "'" + value.replace("'", "'\\''") + "'"


def _lab_path(path: str, *, for_write: bool = False) -> str:
    """Normalize a Linux path while protecting the Windows host mounts.

    Relative paths are anchored at /workspace. Absolute paths are allowed because
    WCKD-LAB is intentionally a root-capable sandbox. Direct /mnt access is blocked
    so helper tools cannot cross into Windows even if a drive is mounted later.
    """
    p = PurePosixPath(path)
    if not p.is_absolute():
        p = PurePosixPath("/workspace") / p

    normalized = str(p)

    if normalized == "/mnt" or normalized.startswith("/mnt/"):
        raise HTTPException(
            status_code=400,
            detail="Access to /mnt is blocked by WCKD Lab file helpers. Use the isolated Linux filesystem.",
        )

    if for_write and (
        normalized in {"/proc", "/sys", "/dev"}
        or normalized.startswith("/proc/")
        or normalized.startswith("/sys/")
        or normalized.startswith("/dev/")
    ):
        raise HTTPException(
            status_code=400,
            detail="Direct writes to Linux virtual filesystems are blocked by file helpers. Use lab_exec if truly required.",
        )

    return normalized


@app.get("/health", operation_id="lab_health")
def health():
    check = _run_wsl(
        "printf 'user='; id -un; "
        "printf 'systemd='; systemctl is-system-running 2>/dev/null || true; "
        "printf 'drvfs='; findmnt -rn -t drvfs -o TARGET 2>/dev/null | tr '\\n' ',' || true; echo; "
        "printf 'workspace='; test -d /workspace && echo yes || echo no",
        timeout=20,
    )
    return {
        "status": "ok" if check["exit_code"] == 0 else "degraded",
        "version": VERSION,
        "distro": DISTRO,
        "root_shell": True,
        "probe": check,
    }


@app.get("/lab/status", operation_id="lab_status")
def lab_status():
    """Read WCKD-LAB OS, memory, disk, network and root identity without modifying it."""
    return _run_wsl(
        "echo '=== ID ==='; id; "
        "echo '=== OS ==='; cat /etc/os-release; "
        "echo '=== KERNEL ==='; uname -a; "
        "echo '=== UPTIME ==='; uptime; "
        "echo '=== MEMORY ==='; free -h; "
        "echo '=== DISK ==='; df -h /; "
        "echo '=== DRVFS ==='; findmnt -t drvfs || true; "
        "echo '=== IP ==='; ip -brief addr 2>/dev/null || hostname -I",
        timeout=30,
    )


@app.post("/lab/exec", operation_id="lab_exec")
def lab_exec(req: ExecRequest):
    """Run unrestricted root shell commands inside WCKD-LAB only."""
    cwd = req.cwd.strip() or "/workspace"
    command = f"cd {_q(cwd)} && {req.command}"
    return _run_wsl(command, timeout=req.timeout_seconds)


@app.post("/lab/list", operation_id="lab_list_files")
def lab_list_files(req: ListRequest):
    """List Linux files/directories in WCKD-LAB. Relative paths start at /workspace."""
    path = _lab_path(req.path)
    cmd = (
        f"test -e {_q(path)} || {{ echo 'Path not found' >&2; exit 2; }}; "
        f"find {_q(path)} -maxdepth {req.max_depth} -printf '%y %M %u:%g %s %TY-%Tm-%Td %TH:%TM %p\\n' | sort"
    )
    return _run_wsl(cmd, timeout=30)


@app.post("/lab/read", operation_id="lab_read_file")
def lab_read_file(req: ReadFileRequest):
    """Read a UTF-8/text file anywhere in WCKD-LAB except /mnt Windows mounts."""
    path = _lab_path(req.path)
    cmd = (
        "python3 - <<'PY'\n"
        "from pathlib import Path\n"
        f"p=Path({path!r})\n"
        "data=p.read_text(encoding='utf-8', errors='replace')\n"
        f"print(data[:{req.max_chars}])\n"
        "PY"
    )
    return _run_wsl(cmd, timeout=30)


@app.post("/lab/write", operation_id="lab_write_file")
def lab_write_file(req: WriteFileRequest):
    """Write any normal Linux text file in WCKD-LAB, including .service/.conf/.env files."""
    path = _lab_path(req.path, for_write=True)
    parent = str(PurePosixPath(path).parent)
    content_hex = req.content.encode("utf-8").hex()
    mkdir = f"mkdir -p {_q(parent)} && " if req.create_parent else ""
    cmd = (
        mkdir
        + "python3 - <<'PY'\n"
        + "from pathlib import Path\n"
        + f"p=Path({path!r})\n"
        + f"p.write_bytes(bytes.fromhex({content_hex!r}))\n"
        + "print(p)\n"
        + "PY"
    )
    return _run_wsl(cmd, timeout=30)


@app.post("/lab/mkdir", operation_id="lab_make_directory")
def lab_make_directory(req: MkdirRequest):
    """Create a directory inside WCKD-LAB. Relative paths start at /workspace."""
    path = _lab_path(req.path, for_write=True)
    flag = "-p" if req.parents else ""
    return _run_wsl(f"mkdir {flag} {_q(path)} && printf '%s\\n' {_q(path)}", timeout=30)


@app.post("/lab/service", operation_id="lab_service")
def lab_service(req: ServiceRequest):
    """Manage a systemd service in WCKD-LAB as root."""
    name = req.name.strip()
    if not name or not all(c.isalnum() or c in "@_.:-" for c in name):
        raise HTTPException(status_code=400, detail="Invalid systemd service name.")

    if req.action == "status":
        command = f"systemctl status {_q(name)} --no-pager --full"
    elif req.action == "enable-now":
        command = f"systemctl enable --now {_q(name)} && systemctl status {_q(name)} --no-pager --full"
    else:
        command = f"systemctl {req.action} {_q(name)}"

    return _run_wsl(command, timeout=60)


@app.post("/lab/bootstrap", operation_id="lab_bootstrap")
def lab_bootstrap():
    """Install the standard WCKD-LAB development/admin toolset."""
    cmd = (
        "export DEBIAN_FRONTEND=noninteractive; "
        "mkdir -p /workspace /opt/wckd-lab; "
        "apt-get update && "
        "apt-get install -y git curl wget jq unzip zip ca-certificates "
        "python3 python3-pip python3-venv build-essential iproute2 procps && "
        "printf 'WCKD-LAB READY\\n' > /workspace/README.txt; "
        "echo 'Bootstrap complete.'"
    )
    return _run_wsl(cmd, timeout=MAX_TIMEOUT)
