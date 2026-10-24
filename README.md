# WCKD-AI

Local AI orchestration, agent execution and desktop control stack.

## Repository structure

- `CORE/` ? WCKD AI runtime and orchestration services
- `CC/` ? WCKD Control Center desktop application
- `install-wckd-shortcuts.ps1` ? portable PowerShell integration

## Current baseline

- WCKD Control Center: v0.9.6
- WCKD Orchestrator: v1.2.3
- Agent Runner: v1.1.2
- Core services: 9/9
- Open WebUI: optional

WCKD is text/LLM focused. Runtime databases, logs, secrets, model weights,
build output and local environment files are intentionally excluded from Git.
