# WCKD Control Center — Codex project instructions

## Project role
This folder is the WCKD Control Center desktop UI and local backend.

Primary path:
- `%WCKD_HOME%\CC`

Related WCKD AI services live in:
- `%WCKD_HOME%\CORE`

Treat both folders as one WCKD system when they are opened together in the `WCKD.code-workspace` VS Code workspace.

## Stable baseline — do not regress
Current validated stable baseline:
- WCKD Control Center: `v0.9.6`
- WCKD Orchestrator: `v1.2.3`
- Agent Runner: `v1.1.2`
- Core services: `9/9 ONLINE`
- Workspace Preflight: enabled
- Verified Execution Gate: enabled
- Verified Recovery Observability: enabled

Execution classifications:
- `VERIFIED` = verification gate PASS and `0` failed tool results
- `VERIFIED WITH RECOVERY` = verification gate PASS and one or more recovered intermediate tool failures
- `UNVERIFIED` = verification gate did not pass

Do not silently remove or weaken these guarantees.

## Control Center architecture
Control Center project:
- React 19
- Vite 8
- Tauri 2
- local backend: `127.0.0.1:17888`

Important UI architecture:
- Chat on the left
- Session Console on the right
- toolbar at the top
- composer at the bottom-left
- independent scrolling
- console can collapse
- narrow layouts use overlay behavior

This split layout is considered stable and should be preserved unless a task explicitly changes it.

Preferred UI zoom:
- `115%`

## WCKD Core services
The core is exactly 9 services:
1. Ollama — `11434`
2. Tools — `8001`
3. Auto Router — `8002`
4. Lab — `8020`
5. Agent Runner — `8030`
6. Model Manager — `8040`
7. Specialist Registry — `8050`
8. Agent Orchestrator — `8060`
9. Project Memory — `8070`

Optional services are not part of the 9/9 core:
- Open WebUI — `8080`

Do not make Open WebUI mandatory for core health.

## Stable execution flow
Expected agentic flow:

`WCKD Auto -> Orchestrator -> Workspace Preflight -> Agent Runner -> WCKD Lab -> Verification Gate -> Evidence -> Review`

Workspace Preflight must ensure the workspace exists before Agent Runner begins filesystem work.

## Evidence UI requirements
For verified execution, preserve:
- verification badge
- successful/failed tool counters
- Runner ID
- Orchestrator ID
- workspace
- verification gate state
- verification turn state
- evidence source
- evidence events
- raw evidence packet when available
- Session Console completion classification

Failure evidence should remain observable even if an intermediate failure was later recovered.

## Development rules
- Use Windows PowerShell 5.1-compatible commands in scripts.
- Do not use PowerShell 7-only syntax such as `??` or the ternary operator.
- Prefer small, reversible patches.
- Preserve existing behavior unless the task explicitly requests a change.
- Never declare a change complete solely because code compiles.
- Run the relevant live/static tests.
- If a test fails, inspect the actual output before changing unrelated components.
- Do not hardcode a one-off fix when a generic fix is possible.
- Avoid changing stable backend contracts without updating the UI and tests together.

## Patch workflow
When creating a WCKD Control Center patch:
1. Back up the files that will change.
2. Apply the smallest necessary change.
3. Build/test.
4. Roll back automatically if the build fails.
5. Preserve current stable functionality.
6. Report exact files changed.

Patch/release files are placed directly in:
- `%WCKD_HOME%\CC`

Do not create versioned patch subfolders unless explicitly requested.

## Startup
WCKD is intentionally manual-start only.

Primary commands:
- `start-wckd-suite`
- `kill-wckd-suite`

Do not enable Windows autostart unless explicitly requested.

## Validation targets
Useful health endpoints:
- Control Center: `http://127.0.0.1:17888/api/health`
- Control Center stack: `http://127.0.0.1:17888/api/stack`
- Orchestrator: `http://127.0.0.1:8060/health`
- Agent Runner: `http://127.0.0.1:8030/health`

A healthy stable stack should report:
- Control Center `v0.9.6`
- Orchestrator `v1.2.3`
- Agent Runner `v1.1.2`
- Core `9/9 ONLINE`

## Before editing
Before making a non-trivial change:
1. Inspect the relevant files.
2. Identify the current implementation.
3. State which files you plan to change.
4. Preserve the stable baseline.
5. Prefer a test that reproduces the problem before changing behavior.

## After editing
Before declaring completion:
1. Run syntax/build checks.
2. Run the relevant WCKD test script or API checks.
3. Confirm core health is still `9/9 ONLINE` when the suite is running.
4. Summarize exactly what changed and what was verified.

## Do not assume
Do not assume historical ChatGPT conversation context exists. Treat this `AGENTS.md`, repository files, logs, health endpoints, and explicit user instructions as the source of truth for the current task.
