# WCKD AI Core — Codex project instructions

## Project role
This folder contains the local WCKD AI services and operational scripts.

Primary path:
- `%WCKD_HOME%\CORE`

Related Control Center:
- `%WCKD_HOME%\CC`

Treat both folders as one system when opened together in `WCKD.code-workspace`.

## Stable baseline — protect it
Validated stable baseline:
- WCKD Control Center `v0.9.6`
- Orchestrator `v1.2.3`
- Agent Runner `v1.1.2`
- Core services `9/9 ONLINE`
- Workspace Preflight enabled
- Verified Execution Gate enabled

Do not regress or bypass the verification gate.

## Critical protection
The active Agent Runner is compiled and operational:
- `%WCKD_HOME%\CORE\wckd_agent_runner.pyc`

Do NOT replace, delete, decompile, regenerate, or casually modify this file.

If a task appears to require changing Agent Runner behavior:
1. inspect available source/history/tests first;
2. explain why the Runner must change;
3. prefer changing Orchestrator/Control Center around it when possible;
4. require explicit user approval before replacing the stable compiled Runner.

## Core services
Exactly 9 services define WCKD Core:
1. Ollama — `127.0.0.1:11434`
2. Tools — `127.0.0.1:8001`
3. Auto Router — `127.0.0.1:8002`
4. Lab — `127.0.0.1:8020`
5. Agent Runner — `127.0.0.1:8030`
6. Model Manager — `127.0.0.1:8040`
7. Specialist Registry — `127.0.0.1:8050`
8. Agent Orchestrator — `127.0.0.1:8060`
9. Project Memory — `127.0.0.1:8070`

Optional:
- Open WebUI `8080`

Optional services must never reduce core health below 9/9.

## Orchestrator
Stable version:
- `v1.2.3`

Required behavior:
- workspace preflight before Runner start
- verified execution hard gate
- Runner audit evidence
- evidence packet for review
- Project Memory integration
- no false completion without successful verification

Preflight behavior:
- use WCKD Lab to ensure the workspace exists before the Runner begins
- do not create a synthetic Runner failure merely to discover that a workspace is missing

## Agent Runner
Stable version:
- `v1.1.2`

Expected health capabilities include:
- completion governor
- verification required for success
- persistent/disk-backed job lookup
- audit logs
- successful/failed tool result counters
- verification success/failure state

Do not weaken completion or verification requirements.

## WCKD Lab
Lab is the execution environment used by agentic workflows.

For filesystem tasks:
- create required workspaces/directories before accessing them;
- verify final artifacts by reading/inspecting them;
- distinguish a successful tool transport call from a command that returned a non-zero `exit_code`.

## Project Memory
Database:
- `%WCKD_HOME%\CORE\memory\memory.db`

Treat it as persistent application state.

For backups of the live database:
- use SQLite's online backup mechanism;
- do not rely on copying a live `memory.db` together with arbitrary WAL state.

## Ollama
Endpoint:
- `127.0.0.1:11434`

Models are managed by Ollama and should not be duplicated into WCKD backups by default.

For restore:
- capture `ollama list`;
- compare installed model names;
- run `ollama pull <model>` only for missing models.

## Current specialist roles
Current logical roles:
- GENERAL
- CODE
- REASONING
- WRITING
- TOOLS
- AGENTIC

Do not hardcode routing to a model unless the task explicitly requires it. Prefer Specialist Registry / Model Manager.

## PowerShell requirements
Operational scripts must be compatible with Windows PowerShell 5.1.
Avoid PowerShell 7-only features such as:
- `??`
- ternary expressions
- other syntax unavailable in 5.1

## Operational rules
- WCKD startup is manual.
- Do not enable Windows autostart unless explicitly requested.
- `start-wckd-suite` starts the core stack.
- `kill-wckd-suite` stops core and optional WCKD services intentionally.
- Prefer restarting only the service being changed, not the whole suite.

## Testing philosophy
For every significant change:
1. reproduce or identify the current behavior;
2. make the smallest change;
3. run syntax/unit/static checks;
4. run a live integration test if the change affects service behavior;
5. inspect actual service output;
6. verify no regression in the 9-service core.

A passing build is not sufficient evidence of functional correctness.

## Useful health endpoints
- Router: `http://127.0.0.1:8002/health`
- Lab: `http://127.0.0.1:8020/health`
- Runner: `http://127.0.0.1:8030/health`
- Model Manager: `http://127.0.0.1:8040/health`
- Specialist Registry: `http://127.0.0.1:8050/health`
- Orchestrator: `http://127.0.0.1:8060/health`
- Project Memory: `http://127.0.0.1:8070/health`

## Before editing
Before modifying a service:
1. inspect its active source and startup path;
2. identify its current version and health response;
3. inspect the test script that validates it;
4. preserve a rollback copy;
5. avoid touching neighboring stable services without evidence.

## After editing
Before declaring success:
1. verify the service version/health;
2. run its dedicated test;
3. confirm dependent services still work;
4. when applicable, confirm Control Center still reports `9/9 ONLINE`;
5. provide exact evidence from the executed test.

## Do not assume
Codex does not inherit prior ChatGPT conversation history. Use this file, local project files, logs, service APIs, and the current user request as the working source of truth.
