# WCKD Control Center — Tauri/React/Node

## Architecture

- Tauri 2: native desktop shell
- React + TypeScript + Vite: UI
- Node.js local API: WCKD Core during development
- Ollama: first integrated AI backend
- Video / Audio backends: next phases

## Prerequisites on Windows

Install:
1. Node.js (current LTS)
2. Rust / rustup
3. Microsoft C++ Build Tools / Visual Studio Build Tools with Desktop development with C++
4. WebView2 (normally already present on Windows 11)

## First run

Open PowerShell in this folder:

```powershell
npm install
npm run tauri dev
```

Tauri will:
- start Vite on port 5173
- start WCKD Core Node API on 127.0.0.1:17888
- compile/open the native desktop window

## Current functionality

- Modern standalone Full-AI UI
- Home / Chat & Agents / Image / Video / Audio / Models / Services / Settings
- WCKD Core health
- Ollama online/offline detection
- Start / stop Ollama
- Installed Ollama model discovery
- Reads model parameters, quantization and max context

## Next

Phase 2:
- Native Chat page using Ollama API
- model + context selection
- streaming tokens
- conversation sessions

Phase 3:

Phase 4:
- Node backend packaged as a Tauri sidecar
- no Node installation required on the final user's PC
- installer/MSI or NSIS bundle
