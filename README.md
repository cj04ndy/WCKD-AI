# WCKD-AI

WCKD-AI is a local-first AI orchestration stack for Windows, combining a multi-service AI core, an isolated WSL2 execution lab, persistent project memory, agentic execution, model routing, and a desktop Control Center.

The repository is a single monorepo:

- `CORE/` — WCKD AI runtime, orchestration, routing, memory, tools, Lab integration, diagnostics and operational PowerShell.
- `CC/` — WCKD Control Center desktop application.
- `install-wckd-shortcuts.ps1` — portable PowerShell integration for the WCKD command shortcuts.

WCKD-AI is currently focused on text/LLM workloads. Image, video, voice, TTS/STT and ComfyUI/F5-TTS components are intentionally not part of the active stack.

---

## Current validated baseline

| Component | Version / state |
|---|---|
| WCKD Control Center | v0.9.6 |
| WCKD Orchestrator | v1.2.3 |
| WCKD Agent Runner | v1.1.2 |
| WCKD Lab Agent | v1.2.0 |
| Specialist Registry | v1.0.0 |
| Model Manager | v1.0.0 |
| Project Memory | v1.0.0 |
| Core services | 9/9 |
| Open WebUI | Optional |
| WSL Lab distro | `WCKD-LAB` |
| WSL mode | WSL2 |

The protected Agent Runner is distributed as:

```text
CORE/wckd_agent_runner.pyc
```

Do not replace, regenerate, decompile or casually modify this file.

---

## Architecture

```text
                         +----------------------+
                         |  WCKD Control Center |
                         |        CC/           |
                         +----------+-----------+
                                    |
                                    v
+-------------+      +--------------+--------------+      +------------------+
|   Ollama    |<---->| Auto Router / Model Manager |<---->| Specialist       |
|   :11434    |      | :8002 / :8040               |      | Registry :8050   |
+-------------+      +--------------+--------------+      +------------------+
                                    |
               +--------------------+--------------------+
               |                    |                    |
               v                    v                    v
        +-------------+      +-------------+      +-------------+
        | Tools :8001 |      | Lab :8020   |      | Memory      |
        |             |      | WSL2        |      | :8070       |
        +-------------+      +------+------+      +-------------+
                                    |
                                    v
                              +-----------+
                              | WCKD-LAB  |
                              | /workspace|
                              +-----------+

                         +---------------------+
                         | Agent Runner :8030  |
                         +----------+----------+
                                    |
                                    v
                         +---------------------+
                         | Orchestrator :8060  |
                         | verification gate   |
                         | workspace preflight |
                         +---------------------+
```

---

## Core services and ports

Exactly nine services define the WCKD Core health baseline:

| # | Service | Address | Purpose |
|---:|---|---|---|
| 1 | Ollama | `127.0.0.1:11434` | Local model runtime |
| 2 | WCKD Tools | `127.0.0.1:8001` | Structured/local tools |
| 3 | Auto Router | `127.0.0.1:8002` | Request routing and role selection |
| 4 | WCKD Lab | `127.0.0.1:8020` | Root-capable isolated WSL2 execution environment |
| 5 | Agent Runner | `127.0.0.1:8030` | Verified multi-step execution |
| 6 | Model Manager | `127.0.0.1:8040` | Single-active-model policy and model state |
| 7 | Specialist Registry | `127.0.0.1:8050` | Specialist role/model registry |
| 8 | Agent Orchestrator | `127.0.0.1:8060` | Queue, preflight, verification and evidence |
| 9 | Project Memory | `127.0.0.1:8070` | Persistent project-scoped memory |

Optional:

| Service | Address |
|---|---|
| Open WebUI | `127.0.0.1:8080` |

Optional services do not count against the 9/9 core health baseline.

---

## Current model profile

The active WCKD model set is intentionally compact:

| Role | Preferred model |
|---|---|
| General | `qwen3.5:9b` |
| Writing | `qwen3.5:9b` |
| Agentic | `qwen3.5:9b` |
| Code | `gpt-oss:20b` |
| Reasoning | `gpt-oss:20b` |
| Tools / Fast | `nemotron-3-nano:4b` |
| Deep / agent fallback | `nemotron-3-nano:30b` |

The Specialist Registry and Model Manager should remain the source of truth for routing. Avoid hardcoding model selection unless a task explicitly requires it.

---

# Requirements

## Windows

Recommended host:

- Windows 11, or a supported Windows 10 build with WSL2.
- PowerShell 5.1-compatible operational scripts.
- Git.
- Python 3.11 for the WCKD Core virtual environment.
- Node.js/npm for WCKD Control Center.
- Rust/Cargo for Tauri desktop builds.
- Ollama.
- NVIDIA drivers / `nvidia-smi` when using NVIDIA GPU acceleration.
- WSL2 with a registered distro named exactly `WCKD-LAB`.

Microsoft WSL documentation:

- https://learn.microsoft.com/windows/wsl/install
- https://learn.microsoft.com/windows/wsl/reference

---

# WCKD Lab / WSL2

## Why WSL is required

WCKD Lab is not a Windows shell wrapper. The Lab service is a FastAPI bridge that calls:

```text
wsl.exe --distribution WCKD-LAB --user root --exec bash -lc ...
```

Therefore a working WSL installation and a distro registered as exactly:

```text
WCKD-LAB
```

are required for Lab health to pass.

The Lab runs as `root` inside the distro and uses:

```text
/workspace
```

as its default working directory.

The Windows environment variable `WCKD_WSL_EXE` can override the path/name of `wsl.exe`, but the distro name is currently fixed in the Lab implementation as `WCKD-LAB`.

## Install or update WSL

Open an elevated PowerShell:

```powershell
wsl --install
wsl --update
wsl --set-default-version 2
```

A reboot may be required after first-time WSL installation.

Check the installation:

```powershell
wsl --status
wsl --list --verbose
```

WCKD Lab expects WSL2.

## Provision the WCKD-LAB distro

The current repository assumes that `WCKD-LAB` already exists. It does not currently ship a destructive automatic distro provisioning script.

Because the Lab bootstrap uses `apt-get`, use an Ubuntu/Debian-compatible distro unless the bootstrap implementation is changed.

One safe approach is to create a normal Ubuntu distro, export it, then import a separate copy as `WCKD-LAB`.

Example:

```powershell
wsl --install -d Ubuntu
```

After Ubuntu has initialized successfully:

```powershell
New-Item -ItemType Directory -Force D:\WSL\WCKD-LAB | Out-Null
wsl --export Ubuntu D:\WSL\wckd-lab-base.tar
wsl --import WCKD-LAB D:\WSL\WCKD-LAB D:\WSL\wckd-lab-base.tar --version 2
```

Verify:

```powershell
wsl --list --verbose
```

Expected to include something similar to:

```text
WCKD-LAB    Stopped    2
```

Do not run `wsl --unregister` on an existing distro unless you intentionally want to permanently delete that distro and its data.

The exported `.tar` is only a provisioning artifact and should not be committed to Git.

## Test the WCKD-LAB shell

```powershell
wsl --distribution WCKD-LAB --user root --exec bash -lc "id && uname -a && test -d /workspace || mkdir -p /workspace"
```

The user should be `root`.

## WCKD Lab bootstrap

Once the WCKD Core is running, the Lab API exposes:

```text
POST http://127.0.0.1:8020/lab/bootstrap
```

The bootstrap prepares `/workspace` and `/opt/wckd-lab`, then installs the standard Lab toolset:

- git
- curl
- wget
- jq
- unzip / zip
- ca-certificates
- python3
- python3-pip
- python3-venv
- build-essential
- iproute2
- procps

It also writes:

```text
/workspace/README.txt
```

with a readiness marker.

## Lab security boundary

WCKD Lab is intentionally root-capable inside its own Linux distro.

The file helper APIs:

- resolve relative paths under `/workspace`;
- allow normal absolute Linux paths;
- block `/mnt` and `/mnt/*`, preventing helper-based access to mounted Windows drives;
- block direct helper writes to `/proc`, `/sys` and `/dev`.

`lab_exec` is intentionally more powerful and can execute unrestricted root shell commands inside `WCKD-LAB`.

Treat the distro as an isolated execution sandbox, not as a place for irreplaceable data.

## Lab API

Health:

```text
GET /health
```

Status:

```text
GET /lab/status
```

Root command execution:

```text
POST /lab/exec
```

Filesystem helpers:

```text
POST /lab/list
POST /lab/read
POST /lab/write
POST /lab/mkdir
```

systemd management:

```text
POST /lab/service
```

Bootstrap:

```text
POST /lab/bootstrap
```

The Lab supports command timeouts up to 1800 seconds. Standard command timeout is 120 seconds.

---

# Installation

## 1. Clone

```powershell
git clone https://github.com/cj04ndy/WCKD-AI.git D:\WCKD-AI
cd D:\WCKD-AI
```

The portable root is controlled through:

```text
WCKD_HOME
```

Example:

```powershell
[Environment]::SetEnvironmentVariable("WCKD_HOME", "D:\WCKD-AI", "User")
```

## 2. Install PowerShell shortcuts

From the repository root:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\install-wckd-shortcuts.ps1
```

This installs the lightweight PowerShell profile loader that resolves WCKD through `WCKD_HOME`.

Open a new PowerShell session afterward.

## 3. Prepare CORE Python environment

The local virtual environment is intentionally not stored in Git.

From `CORE/`, create a Python 3.11 venv and install the dependencies required by the WCKD services.

Expected interpreter path:

```text
%WCKD_HOME%\CORE\.venv\Scripts\python.exe
```

The launcher expects this exact local venv layout.

## 4. Install Ollama

Install Ollama and ensure:

```powershell
ollama --version
```

works from PowerShell.

The launcher sets:

```text
OLLAMA_CONTEXT_LENGTH=32768
```

before starting the Ollama server.

Install the WCKD model set separately through Ollama. Model weights are intentionally not committed to Git.

## 5. Prepare WCKD-LAB

Complete the WSL2 setup above and verify:

```powershell
wsl --distribution WCKD-LAB --user root --exec bash -lc "echo WCKD-LAB OK"
```

## 6. Install Control Center dependencies

```powershell
cd D:\WCKD-AI\CC
npm ci
```

Build check:

```powershell
npm run build
```

Generated Node, Vite, Rust and Tauri build output is ignored by Git.

---

# Starting WCKD

WCKD startup is manual by design.

After installing the PowerShell integration:

```powershell
start-wckd-suite
```

The core launcher starts the WCKD services in the background.

To stop the stack:

```powershell
kill-wckd-suite
```

Do not enable Windows autostart unless explicitly required.

---

# Health and diagnostics

Run:

```powershell
wckd-doctor
```

The doctor validates, among other things:

- core files;
- listening ports;
- Ollama and installed model inventory;
- Router role map;
- Specialist Registry;
- Model Manager single-active-model policy;
- Agent Runner safety features;
- Project Memory;
- Orchestrator dependencies and persistence;
- WCKD Lab API;
- `WCKD-LAB` WSL registration;
- NVIDIA / VRAM telemetry;
- optional Open WebUI;
- recent error-like log lines.

Healthy target:

```text
OVERALL: PASS
WCKD Suite is healthy.
```

## Useful health endpoints

```text
http://127.0.0.1:8002/health   Auto Router
http://127.0.0.1:8020/health   WCKD Lab
http://127.0.0.1:8030/health   Agent Runner
http://127.0.0.1:8040/health   Model Manager
http://127.0.0.1:8050/health   Specialist Registry
http://127.0.0.1:8060/health   Agent Orchestrator
http://127.0.0.1:8070/health   Project Memory
```

Ollama:

```text
http://127.0.0.1:11434
```

Optional Open WebUI:

```text
http://127.0.0.1:8080
```

---

# Agentic execution model

WCKD agentic workflows are built around:

1. Specialist selection.
2. Model routing.
3. Workspace preflight.
4. WCKD Lab availability.
5. Agent Runner execution.
6. Verification gate.
7. Audit/evidence collection.
8. Project Memory integration.

The Orchestrator is designed to prevent false completion. A task should not be reported as successful when verification fails.

The current Orchestrator mode is sequential / single-worker.

---

# Project Memory

Project Memory runs on:

```text
127.0.0.1:8070
```

Local database:

```text
%WCKD_HOME%\CORE\memory\memory.db
```

The SQLite database is persistent runtime state and is intentionally excluded from Git.

For a live database backup, prefer SQLite's online backup mechanism rather than copying arbitrary live DB/WAL files.

---

# Open WebUI

Open WebUI is optional and is not part of the 9-service health baseline.

The launcher can start Open WebUI on:

```text
127.0.0.1:8080
```

To skip Open WebUI for a session:

```powershell
$env:WCKD_SKIP_WEBUI = "1"
start-wckd-suite
```

Open WebUI data is stored locally and excluded from Git.

---

# Control Center

The Control Center lives in:

```text
CC/
```

Current baseline:

```text
v0.9.6
```

Technology stack includes:

- TypeScript
- React
- Vite
- Tauri / Rust

Development dependencies:

```powershell
cd CC
npm ci
```

Production build validation:

```powershell
npm run build
```

The repository ignores generated Tauri schemas under:

```text
CC/src-tauri/gen/
```

as well as `node_modules`, `dist` and Rust `target` output.

---

# Repository hygiene

The root `.gitignore` intentionally excludes local/runtime data such as:

- `MIGRATION-BACKUP/`
- Python virtual environments
- `node_modules/`
- Tauri/Rust build output
- generated Tauri schemas
- logs
- runtime jobs
- benchmarks
- workspace state
- Project Memory SQLite files
- Open WebUI data
- secrets and credentials
- model weights/checkpoints
- editor and OS metadata

Never commit:

- API keys or tokens;
- `.env` files;
- private keys;
- `memory.db`;
- model weights;
- WSL distro exports;
- local backup archives;
- generated runtime state.

---

# Portability

The repository is designed around:

```text
WCKD_HOME
```

rather than a fixed installation drive.

Example installation:

```text
D:\WCKD-AI
```

but scripts should derive paths through `$PSScriptRoot`, `WCKD_HOME`, Python `__file__`, Node `import.meta.url`, or other runtime-relative paths.

Avoid introducing new hard-coded machine-specific paths.

---

# Operational rules

- Startup remains manual.
- Keep the core at 9/9.
- Prefer restarting only the service being changed.
- Do not weaken the Agent Runner completion governor.
- Do not bypass the Orchestrator verification gate.
- Protect `wckd_agent_runner.pyc`.
- Treat Project Memory as persistent state.
- Treat WCKD-LAB as an isolated root-capable sandbox.
- Do not use WCKD Lab file helpers to cross into Windows mounts.
- Validate significant changes with syntax/build checks and live health tests.

---

# Quick verification checklist

```powershell
# WSL / Lab prerequisite
wsl --list --verbose

# Ollama
ollama list

# Start WCKD
start-wckd-suite

# Full WCKD health
wckd-doctor

# Control Center build
cd "$env:WCKD_HOME\CC"
npm run build
```

Expected WSL list must contain:

```text
WCKD-LAB
```

Expected WCKD target:

```text
9/9 core services healthy
```

---

## Notes

This repository contains the application code and operational configuration only.

Large models, local databases, secrets, generated build output, WSL distro images and machine-specific runtime state are deliberately kept outside version control.
