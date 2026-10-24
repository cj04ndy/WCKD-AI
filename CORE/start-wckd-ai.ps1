$ErrorActionPreference = "SilentlyContinue"

# ============================================================
# WCKD AI - Background Services Launcher
#
# DEFAULT:
#   Ollama         -> 11434
#   WCKD Tools     -> 8001
#   Auto Router    -> 8002
#   WCKD Lab       -> 8020
#   Agent Runner   -> 8030
#   Model Manager  -> 8040
#   Open WebUI     -> 8080
#
# OPTIONAL - NU pornesc automat:
# ============================================================

$AI   = $PSScriptRoot
$LOGS = Join-Path $AI "logs"

$OllamaPort = 11434
$ToolsPort  = 8001
$RouterPort = 8002
$LabPort    = 8020
$RunnerPort = 8030
$ModelManagerPort = 8040

$SpecialistRegistryPort = 8050
$OrchestratorPort = 8060
$MemoryPort = 8070
$WebUIPort  = 8080

$OllamaExe = (Get-Command ollama.exe -ErrorAction SilentlyContinue).Source
$PythonExe = Join-Path $AI ".venv\Scripts\python.exe"
$UvxExe = (Get-Command uvx.exe,uvx -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)

New-Item -ItemType Directory -Force -Path $LOGS | Out-Null

function Test-PortListening {
    param(
        [Parameter(Mandatory = $true)]
        [int]$Port
    )

    return $null -ne (
        Get-NetTCPConnection `
            -LocalPort $Port `
            -State Listen `
            -ErrorAction SilentlyContinue |
        Select-Object -First 1
    )
}

function Wait-Port {
    param(
        [Parameter(Mandatory = $true)]
        [int]$Port,

        [int]$TimeoutSeconds = 60
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

    while ((Get-Date) -lt $deadline) {
        if (Test-PortListening -Port $Port) {
            return $true
        }

        Start-Sleep -Milliseconds 500
    }

    return $false
}

function Start-UvicornService {
    param(
        [Parameter(Mandatory = $true)][string]$Module,
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$DisplayName,
        [Parameter(Mandatory = $true)][string]$LogName,
        [int]$TimeoutSeconds = 30
    )

    if (Test-PortListening -Port $Port) {
        return
    }

    if (-not (Test-Path $PythonExe)) {
        Add-Content `
            -Path "$LOGS\launcher-error.log" `
            -Value "$(Get-Date -Format s) - Python missing: $PythonExe"
        return
    }

    $modulePy  = Join-Path $AI ($Module + ".py")
    $modulePyc = Join-Path $AI ($Module + ".pyc")

    if (-not (Test-Path $modulePy) -and -not (Test-Path $modulePyc)) {
        Add-Content `
            -Path "$LOGS\launcher-error.log" `
            -Value "$(Get-Date -Format s) - Missing module: $Module (.py or .pyc)"
        return
    }

    Start-Process `
        -FilePath $PythonExe `
        -ArgumentList "-m uvicorn ${Module}:app --host 127.0.0.1 --port $Port" `
        -WorkingDirectory $AI `
        -WindowStyle Hidden `
        -RedirectStandardOutput "$LOGS\$LogName.log" `
        -RedirectStandardError "$LOGS\$LogName-error.log"

    if (-not (Wait-Port -Port $Port -TimeoutSeconds $TimeoutSeconds)) {
        Add-Content `
            -Path "$LOGS\launcher-error.log" `
            -Value "$(Get-Date -Format s) - $DisplayName failed on port $Port"
    }
}

# ============================================================
# OLLAMA
# ============================================================

if (-not (Test-PortListening -Port $OllamaPort)) {

    if (-not $OllamaExe) {
        Add-Content `
            -Path "$LOGS\launcher-error.log" `
            -Value "$(Get-Date -Format s) - Ollama executable not found."
    }
    else {
        $env:OLLAMA_CONTEXT_LENGTH = "32768"

        Start-Process `
            -FilePath $OllamaExe `
            -ArgumentList "serve" `
            -WorkingDirectory $AI `
            -WindowStyle Hidden `
            -RedirectStandardOutput "$LOGS\ollama.log" `
            -RedirectStandardError "$LOGS\ollama-error.log"

        Wait-Port -Port $OllamaPort -TimeoutSeconds 30 | Out-Null
    }
}

# ============================================================
# WCKD SERVICES
# ============================================================

Start-UvicornService `
    -Module "wckd_tools" `
    -Port $ToolsPort `
    -DisplayName "WCKD Tools" `
    -LogName "tools"

Start-UvicornService `
    -Module "wckd_router" `
    -Port $RouterPort `
    -DisplayName "Auto Router" `
    -LogName "router"

Start-UvicornService `
    -Module "wckd_lab_agent" `
    -Port $LabPort `
    -DisplayName "WCKD Lab" `
    -LogName "lab-agent" `
    -TimeoutSeconds 60

Start-UvicornService `
    -Module "wckd_agent_runner" `
    -Port $RunnerPort `
    -DisplayName "Agent Runner" `
    -LogName "agent-runner" `
    -TimeoutSeconds 60

Start-UvicornService `
    -Module "wckd_model_manager" `
    -Port $ModelManagerPort `
    -DisplayName "Model Manager" `
    -LogName "model-manager" `
    -TimeoutSeconds 60

Start-UvicornService `
    -Module "wckd_specialist_registry" `
    -Port $SpecialistRegistryPort `
    -DisplayName "Specialist Registry" `
    -LogName "specialist-registry" `
    -TimeoutSeconds 60
Start-UvicornService `
    -Module "wckd_orchestrator" `
    -Port $OrchestratorPort `
    -DisplayName "Agent Orchestrator" `
    -LogName "orchestrator" `
    -TimeoutSeconds 60
Start-UvicornService `
    -Module "wckd_memory" `
    -Port $MemoryPort `
    -DisplayName "Project Memory" `
    -LogName "memory" `
    -TimeoutSeconds 60
# ============================================================
# OPEN WEBUI
# ============================================================

if ($env:WCKD_SKIP_WEBUI -ne "1" -and -not (Test-PortListening -Port $WebUIPort)) {

    if (-not (Test-Path $UvxExe)) {
        Add-Content `
            -Path "$LOGS\launcher-error.log" `
            -Value "$(Get-Date -Format s) - uvx not found: $UvxExe"
    }
    else {
        $env:WEBUI_NAME = "WCKD AI"
        $env:DATA_DIR   = Join-Path $AI "open-webui-data"

        Start-Process `
            -FilePath $UvxExe `
            -ArgumentList "--python 3.11 open-webui@latest serve" `
            -WorkingDirectory $AI `
            -WindowStyle Hidden `
            -RedirectStandardOutput "$LOGS\webui.log" `
            -RedirectStandardError "$LOGS\webui-error.log"

        Wait-Port -Port $WebUIPort -TimeoutSeconds 120 | Out-Null
    }
}

# Voice NU este pornit aici.
