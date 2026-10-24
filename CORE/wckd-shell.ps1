# === WCKD PORTABLE PATHS ===
$script:WckdCoreRoot = $PSScriptRoot
$script:WckdRoot = Split-Path $script:WckdCoreRoot -Parent
$script:WckdCcRoot = Join-Path $script:WckdRoot "CC"

function wckd-root {
    [pscustomobject]@{
        WCKD_ROOT = $script:WckdRoot
        CORE      = $script:WckdCoreRoot
        CC        = $script:WckdCcRoot
    } | Format-List
}

# === END WCKD PORTABLE PATHS ===
# WCKD Suite PowerShell commands
#
# Core:
#   start-wckd-suite
#   start-wckd-suite -UI
#
# Optional:
#   start-wckd-suite -WebUI
#
# UI:
#   wckd-ui
#   wckd-ui-reset
#
# Agent Runner:
#   wckd-agent-jobs
#   wckd-agent-status <job_id>
#   wckd-agent-result <job_id>
#   wckd-agent-cancel <job_id>
#   wckd-agent-continue <job_id> "instruction"
#   wckd-agent-watch <job_id>
#   wckd-agent-watch                 # follows latest running/recent job
#
# Shutdown:
#   kill-wckd-suite

function Test-WckdPort {
    param([Parameter(Mandatory=$true)][int]$Port)

    $connection = Get-NetTCPConnection `
        -LocalPort $Port `
        -State Listen `
        -ErrorAction SilentlyContinue |
        Select-Object -First 1

    return ($null -ne $connection)
}

function Wait-WckdPort {
    param(
        [Parameter(Mandatory=$true)][int]$Port,
        [int]$TimeoutSeconds = 120
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

    while ((Get-Date) -lt $deadline) {
        if (Test-WckdPort -Port $Port) {
            return $true
        }
        Start-Sleep -Milliseconds 500
    }

    return $false
}

# Optional Voice command
function wckd-ui {
    $Launcher = Join-Path $script:WckdCoreRoot "wckd-ui-window.ps1"

    if (-not (Test-Path $Launcher)) {
        Write-Host "Lipseste: $Launcher" -ForegroundColor Red
        return
    }

    Start-Process `
        -FilePath "powershell.exe" `
        -ArgumentList "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Launcher`"" `
        -WindowStyle Hidden | Out-Null
}

function wckd-ui-reset {
    $Launcher = Join-Path $script:WckdCoreRoot "wckd-ui-window.ps1"

    if (-not (Test-Path $Launcher)) {
        Write-Host "Lipseste: $Launcher" -ForegroundColor Red
        return
    }

    & powershell.exe `
        -NoLogo `
        -NoProfile `
        -ExecutionPolicy Bypass `
        -File $Launcher `
        -ResetState
}

function wckd-agent-jobs {
    [CmdletBinding()]
    param([ValidateRange(1,100)][int]$Limit = 20)

    try {
        $result = Invoke-RestMethod -Uri "http://127.0.0.1:8030/agent/list?limit=$Limit" -TimeoutSec 15
        $jobs = @($result.jobs)

        if ($jobs.Count -eq 0) {
            Write-Host "No WCKD Agent Runner jobs." -ForegroundColor DarkGray
            return
        }

        $jobs |
            Select-Object job_id,status,step,max_steps,last_model,last_activity,created,updated |
            Format-Table -AutoSize
    }
    catch {
        Write-Host ("Agent Runner unavailable: {0}" -f $_.Exception.Message) -ForegroundColor Red
    }
}

function wckd-agent-status {
    [CmdletBinding()]
    param([Parameter(Mandatory=$true,Position=0)][string]$JobId)

    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:8030/agent/status/$JobId" -TimeoutSec 15 |
            ConvertTo-Json -Depth 20
    }
    catch {
        Write-Host ("agent-status failed: {0}" -f $_.Exception.Message) -ForegroundColor Red
    }
}

function wckd-agent-result {
    [CmdletBinding()]
    param([Parameter(Mandatory=$true,Position=0)][string]$JobId)

    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:8030/agent/result/$JobId" -TimeoutSec 15 |
            ConvertTo-Json -Depth 20
    }
    catch {
        Write-Host ("agent-result failed: {0}" -f $_.Exception.Message) -ForegroundColor Red
    }
}

function wckd-agent-cancel {
    [CmdletBinding()]
    param([Parameter(Mandatory=$true,Position=0)][string]$JobId)

    try {
        Invoke-RestMethod `
            -Uri "http://127.0.0.1:8030/agent/cancel/$JobId" `
            -Method Post `
            -ContentType "application/json" `
            -Body "{}" `
            -TimeoutSec 15 |
            ConvertTo-Json -Depth 10
    }
    catch {
        Write-Host ("agent-cancel failed: {0}" -f $_.Exception.Message) -ForegroundColor Red
    }
}

function wckd-agent-continue {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true,Position=0)][string]$JobId,
        [Parameter(Mandatory=$true,Position=1)][string]$Instruction,
        [ValidateRange(1,150)][int]$AdditionalSteps = 60,
        [ValidateRange(1,180)][int]$AdditionalMinutes = 60
    )

    $body = @{
        instruction = $Instruction
        additional_steps = $AdditionalSteps
        additional_minutes = $AdditionalMinutes
    } | ConvertTo-Json

    try {
        Invoke-RestMethod `
            -Uri "http://127.0.0.1:8030/agent/continue/$JobId" `
            -Method Post `
            -ContentType "application/json" `
            -Body $body `
            -TimeoutSec 15 |
            ConvertTo-Json -Depth 10
    }
    catch {
        Write-Host ("agent-continue failed: {0}" -f $_.Exception.Message) -ForegroundColor Red
    }
}

function Format-WckdAgentAuditEvent {
    param([Parameter(Mandatory=$true)]$Event)

    $ts = ""
    try {
        $ts = ([datetimeoffset]$Event.timestamp).ToLocalTime().ToString("HH:mm:ss")
    }
    catch {
        $ts = [string]$Event.timestamp
    }

    $step = [string]$Event.step
    $name = [string]$Event.event

    switch ($name) {
        "job_created" {
            Write-Host ""
            Write-Host "[$ts] JOB CREATED  $($Event.job_id)" -ForegroundColor Cyan
            Write-Host ("  workspace: {0}" -f $Event.workspace) -ForegroundColor DarkGray
            Write-Host ("  route:     {0}" -f $Event.route_mode) -ForegroundColor DarkGray
            Write-Host ("  objective: {0}" -f $Event.objective)
        }
        "job_started" {
            Write-Host "[$ts] JOB STARTED" -ForegroundColor Green
        }
        "job_resumed" {
            Write-Host "[$ts] JOB RESUMED" -ForegroundColor Green
            Write-Host ("  {0}" -f $Event.instruction)
        }
        "model_call" {
            Write-Host ""
            Write-Host "[$ts] STEP $step  MODEL CALL" -ForegroundColor Magenta
            Write-Host ("  route: {0} | messages: {1} | context chars: {2}" -f $Event.route_mode,$Event.message_count,$Event.history_chars) -ForegroundColor DarkGray
        }
        "model_response" {
            Write-Host "[$ts] STEP $step  MODEL RESPONSE  $($Event.model)" -ForegroundColor Magenta
            if ($Event.content) {
                Write-Host $Event.content
            }
            if ($Event.tool_calls) {
                foreach ($tc in @($Event.tool_calls)) {
                    if ($null -ne $tc) {
                        Write-Host "  -> TOOL REQUEST: $($tc.function.name)" -ForegroundColor Cyan
                        Write-Host ($tc.function.arguments | Out-String)
                    }
                }
            }
        }
        "tool_call" {
            Write-Host ""
            Write-Host "[$ts] STEP $step  TOOL CALL  $($Event.tool)" -ForegroundColor Cyan
            if ($null -ne $Event.arguments) {
                Write-Host ($Event.arguments | ConvertTo-Json -Depth 50)
            }
        }
        "tool_result" {
            Write-Host "[$ts] STEP $step  TOOL RESULT  $($Event.tool)  $($Event.duration_s)s" -ForegroundColor Green
            if ($null -ne $Event.result) {
                Write-Host ($Event.result | ConvertTo-Json -Depth 50)
            }
        }
        "tool_error" {
            Write-Host "[$ts] STEP $step  TOOL ERROR  $($Event.tool)  $($Event.duration_s)s" -ForegroundColor Red
            Write-Host $Event.error -ForegroundColor Red
        }
        "model_error" {
            Write-Host "[$ts] STEP $step  MODEL ERROR attempt=$($Event.attempt)" -ForegroundColor Red
            Write-Host $Event.error -ForegroundColor Red
        }
        "auto_continue" {
            Write-Host "[$ts] STEP $step  AUTO CONTINUE #$($Event.idle_turn)" -ForegroundColor Yellow
        }
        "history_compacted" {
            Write-Host "[$ts] STEP $step  HISTORY COMPACTED" -ForegroundColor Yellow
        }
        "final_audit_requested" {
            Write-Host "[$ts] STEP $step  FINAL AUDIT REQUESTED" -ForegroundColor Yellow
        }
        "verification_tools_required" {
            Write-Host "[$ts] STEP $step  VERIFICATION TOOLS REQUIRED" -ForegroundColor Yellow
        }
        "job_completed" {
            Write-Host ""
            Write-Host "[$ts] COMPLETED + VERIFIED  model=$($Event.model)" -ForegroundColor Green
            if ($Event.final_response) {
                Write-Host $Event.final_response
            }
        }
        "job_blocked" {
            Write-Host "[$ts] BLOCKED" -ForegroundColor Yellow
            Write-Host $Event.final_response
        }
        "job_failed" {
            Write-Host "[$ts] FAILED" -ForegroundColor Red
            Write-Host $Event.error -ForegroundColor Red
        }
        "job_cancelled" {
            Write-Host "[$ts] CANCELLED" -ForegroundColor Yellow
        }
        "job_timeout" {
            Write-Host "[$ts] TIMEOUT" -ForegroundColor Red
            Write-Host $Event.error -ForegroundColor Red
        }
        "job_step_limit" {
            Write-Host "[$ts] STEP LIMIT" -ForegroundColor Red
            Write-Host $Event.error -ForegroundColor Red
        }
        "job_stalled" {
            Write-Host "[$ts] STALLED" -ForegroundColor Red
            Write-Host $Event.error -ForegroundColor Red
        }
        default {
            Write-Host "[$ts] STEP $step  $name" -ForegroundColor DarkGray
            Write-Host ($Event | ConvertTo-Json -Depth 50)
        }
    }
}

function wckd-agent-watch {
    [CmdletBinding()]
    param(
        [Parameter(Position=0)][string]$JobId,
        [ValidateRange(1,1000)][int]$Tail = 30
    )

    if (-not $JobId) {
        try {
            $list = Invoke-RestMethod -Uri "http://127.0.0.1:8030/agent/list?limit=20" -TimeoutSec 15
            $jobs = @($list.jobs)
            $selected = $jobs | Where-Object { $_.status -in @("running","starting") } | Select-Object -First 1
            if (-not $selected) {
                $selected = $jobs | Select-Object -First 1
            }
            if (-not $selected) {
                Write-Host "No Agent Runner jobs found." -ForegroundColor DarkGray
                return
            }
            $JobId = [string]$selected.job_id
        }
        catch {
            Write-Host ("Agent Runner unavailable: {0}" -f $_.Exception.Message) -ForegroundColor Red
            return
        }
    }

    $path = Join-Path $script:WckdCoreRoot ("agent-runner\logs\{0}.jsonl" -f $JobId)
    $deadline = (Get-Date).AddSeconds(30)

    while (-not (Test-Path $path) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
    }

    if (-not (Test-Path $path)) {
        Write-Host "Audit log not found: $path" -ForegroundColor Red
        return
    }

    Write-Host ""
    Write-Host "WCKD AGENT WATCH" -ForegroundColor Cyan
    Write-Host "================" -ForegroundColor DarkCyan
    Write-Host ("Job: {0}" -f $JobId) -ForegroundColor Cyan
    Write-Host ("Log: {0}" -f $path) -ForegroundColor DarkGray
    Write-Host "Ctrl+C to stop watching. The agent job keeps running." -ForegroundColor DarkGray
    Write-Host ""

    Get-Content -Path $path -Encoding UTF8 -Tail $Tail -Wait |
        ForEach-Object {
            if (-not $_) { return }
            try {
                $event = $_ | ConvertFrom-Json
                Format-WckdAgentAuditEvent -Event $event
            }
            catch {
                Write-Host $_ -ForegroundColor DarkGray
            }
        }
}


function wckd-model-status {
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:8040/status" -TimeoutSec 20 |
            ConvertTo-Json -Depth 20
    }
    catch {
        Write-Host ("Model Manager unavailable: {0}" -f $_.Exception.Message) -ForegroundColor Red
    }
}

function wckd-models {
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:8040/models" -TimeoutSec 20 |
            ConvertTo-Json -Depth 20
    }
    catch {
        Write-Host ("Model Manager unavailable: {0}" -f $_.Exception.Message) -ForegroundColor Red
    }
}

function wckd-model-switch {
    [CmdletBinding()]
    param([Parameter(Mandatory=$true,Position=0)][string]$Model)

    try {
        Invoke-RestMethod `
            -Uri ("http://127.0.0.1:8040/switch/{0}" -f $Model) `
            -Method Post `
            -TimeoutSec 240 |
            ConvertTo-Json -Depth 20
    }
    catch {
        Write-Host ("model-switch failed: {0}" -f $_.Exception.Message) -ForegroundColor Red
    }
}

function wckd-model-unload {
    try {
        Invoke-RestMethod `
            -Uri "http://127.0.0.1:8040/unload" `
            -Method Post `
            -TimeoutSec 120 |
            ConvertTo-Json -Depth 20
    }
    catch {
        Write-Host ("model-unload failed: {0}" -f $_.Exception.Message) -ForegroundColor Red
    }
}


function wckd-doctor {
    [CmdletBinding()]
    param(
        [switch]$Detailed,
        [switch]$Json
    )

    $DoctorScript = Join-Path $script:WckdCoreRoot "wckd-doctor.ps1"

    if (-not (Test-Path $DoctorScript)) {
        Write-Host "Lipseste: $DoctorScript" -ForegroundColor Red
        return
    }

    $arguments = @(
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $DoctorScript
    )

    if ($Detailed) {
        $arguments += "-Detailed"
    }

    if ($Json) {
        $arguments += "-Json"
    }

    & powershell.exe @arguments
}

function wckd-recovery {
    [CmdletBinding()]
    param(
        [ValidateSet("all","ollama","tools","lab","manager","registry","router","agent","memory","orchestrator","webui")]
        [string]$Target = "all",

        [ValidateRange(1,2)]
        [int]$MaxAttempts = 2,

        [ValidateRange(0,30)]
        [int]$CooldownSeconds = 3,

        [switch]$DryRun
    )

    $RecoveryScript = Join-Path $script:WckdCoreRoot "wckd-recovery.ps1"

    if (-not (Test-Path $RecoveryScript)) {
        Write-Host "Lipseste: $RecoveryScript" -ForegroundColor Red
        return
    }

    $arguments = @(
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $RecoveryScript,
        "-Target", $Target,
        "-MaxAttempts", $MaxAttempts,
        "-CooldownSeconds", $CooldownSeconds
    )

    if ($DryRun) {
        $arguments += "-DryRun"
    }

    & powershell.exe @arguments
}

function wckd-specialists {
    try {
        $r = Invoke-RestMethod `
            -Uri "http://127.0.0.1:8050/specialists" `
            -Method Get `
            -TimeoutSec 20

        $r.specialists |
            Select-Object id,display_name,enabled,preferred_model,route_mode,tools_policy |
            Format-Table -AutoSize
    }
    catch {
        Write-Host ("Specialist Registry unavailable: {0}" -f $_.Exception.Message) -ForegroundColor Red
    }
}

function wckd-specialist {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true,Position=0)]
        [string]$Id
    )

    try {
        Invoke-RestMethod `
            -Uri ("http://127.0.0.1:8050/resolve/{0}" -f $Id) `
            -Method Get `
            -TimeoutSec 20 |
            ConvertTo-Json -Depth 20
    }
    catch {
        Write-Host ("Specialist resolve failed: {0}" -f $_.Exception.Message) -ForegroundColor Red
    }
}

function wckd-specialist-validate {
    try {
        Invoke-RestMethod `
            -Uri "http://127.0.0.1:8050/validate" `
            -Method Get `
            -TimeoutSec 20 |
            ConvertTo-Json -Depth 20
    }
    catch {
        Write-Host ("Specialist validation failed: {0}" -f $_.Exception.Message) -ForegroundColor Red
    }
}

function wckd-orchestrate {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true,Position=0,ValueFromRemainingArguments=$true)]
        [string[]]$Objective
    )

    $objectiveText = ($Objective -join " ").Trim()

    if (-not $objectiveText) {
        Write-Host "Objective is required." -ForegroundColor Red
        return
    }

    $body = @{
        objective = $objectiveText
    } | ConvertTo-Json -Depth 10

    try {
        Invoke-RestMethod `
            -Uri "http://127.0.0.1:8060/orchestrator/start" `
            -Method Post `
            -ContentType "application/json" `
            -Body $body `
            -TimeoutSec 30 |
            Format-List
    }
    catch {
        Write-Host ("Orchestrator start failed: {0}" -f $_.Exception.Message) -ForegroundColor Red
    }
}

function wckd-orchestrator-jobs {
    try {
        Invoke-RestMethod `
            -Uri "http://127.0.0.1:8060/orchestrator/list?limit=20" `
            -Method Get `
            -TimeoutSec 20 |
            Select-Object -ExpandProperty jobs |
            Format-Table job_id,status,current_stage,workspace,updated -AutoSize
    }
    catch {
        Write-Host ("Orchestrator unavailable: {0}" -f $_.Exception.Message) -ForegroundColor Red
    }
}

function wckd-orchestrator-status {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true,Position=0)]
        [string]$JobId
    )

    try {
        Invoke-RestMethod `
            -Uri ("http://127.0.0.1:8060/orchestrator/status/{0}" -f $JobId) `
            -Method Get `
            -TimeoutSec 20 |
            ConvertTo-Json -Depth 20
    }
    catch {
        Write-Host ("Orchestrator status failed: {0}" -f $_.Exception.Message) -ForegroundColor Red
    }
}

function wckd-orchestrator-result {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true,Position=0)]
        [string]$JobId
    )

    try {
        Invoke-RestMethod `
            -Uri ("http://127.0.0.1:8060/orchestrator/result/{0}" -f $JobId) `
            -Method Get `
            -TimeoutSec 20 |
            ConvertTo-Json -Depth 30
    }
    catch {
        Write-Host ("Orchestrator result failed: {0}" -f $_.Exception.Message) -ForegroundColor Red
    }
}

function wckd-memory-search {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]
        [string]$Project,

        [Parameter(Mandatory=$true,Position=0)]
        [string]$Query,

        [ValidateRange(1,50)]
        [int]$Limit = 8
    )

    $body = @{
        project_id = $Project
        query = $Query.Trim()
        limit = $Limit
    } | ConvertTo-Json -Depth 10

    try {
        $r = Invoke-RestMethod `
            -Uri "http://127.0.0.1:8070/memory/search" `
            -Method Post `
            -ContentType "application/json" `
            -Body $body `
            -TimeoutSec 30

        $r.memories |
            Select-Object memory_id,kind,title,source,rank,text |
            Format-Table -Wrap -AutoSize
    }
    catch {
        Write-Host ("Memory search failed: {0}" -f $_.Exception.Message) -ForegroundColor Red
    }
}

function wckd-memory-add {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]
        [string]$Project,

        [Parameter(Mandatory=$true,Position=0)]
        [string]$Text,

        [string]$Title = "",
        [string]$Kind = "note",
        [string]$Source = "powershell"
    )

    $body = @{
        project_id = $Project
        text = $Text.Trim()
        title = $Title
        kind = $Kind
        source = $Source
    } | ConvertTo-Json -Depth 10

    try {
        Invoke-RestMethod `
            -Uri "http://127.0.0.1:8070/memory/add" `
            -Method Post `
            -ContentType "application/json" `
            -Body $body `
            -TimeoutSec 30 |
            ConvertTo-Json -Depth 20
    }
    catch {
        Write-Host ("Memory add failed: {0}" -f $_.Exception.Message) -ForegroundColor Red
    }
}

function wckd-memory-projects {
    try {
        Invoke-RestMethod `
            -Uri "http://127.0.0.1:8070/memory/projects" `
            -Method Get `
            -TimeoutSec 20 |
            Select-Object -ExpandProperty projects |
            Format-Table project_id,memories,updated_at -AutoSize
    }
    catch {
        Write-Host ("Project Memory unavailable: {0}" -f $_.Exception.Message) -ForegroundColor Red
    }
}

# === WCKD KILLSWITCH v2.1 ===
function kill-wckd-suite {
    [CmdletBinding()]
    param()

    Write-Host ""
    Write-Host "WCKD SUITE KILLSWITCH" -ForegroundColor Red
    Write-Host "======================" -ForegroundColor DarkRed

    $ports = @(
        11434,
        8001,
        8002,
        8020,
        8030,
        8040,
        8050,
        8060,
        8070,
        8080

    )

    Write-Host "[STOP] Ollama tray + server..." -ForegroundColor Yellow

    for ($ollamaPass = 1; $ollamaPass -le 10; $ollamaPass++) {
        $ollamaTargets = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object {
                $_.Name -ieq "ollama.exe" -or
                $_.Name -ieq "ollama app.exe" -or
                (
                    $_.Name -ieq "llama-server.exe" -and
                    (
                        $_.ExecutablePath -like "*\Ollama\lib\ollama\llama-server.exe" -or
                        $_.CommandLine -match '(?i)\\Ollama\\lib\\ollama\\llama-server\.exe'
                    )
                ) -or
                $_.CommandLine -match '(?i)ollama app\.exe.*fast-startup'
            }

        foreach ($ollamaProcess in $ollamaTargets) {
            if ($ollamaProcess.ProcessId -and $ollamaProcess.ProcessId -ne $PID) {
                Stop-Process -Id $ollamaProcess.ProcessId -Force -ErrorAction SilentlyContinue
            }
        }

        Start-Sleep -Milliseconds 300

        if (-not (Test-WckdPort -Port 11434)) {
            break
        }
    }

    Write-Host "[STOP] WCKD services..." -ForegroundColor Yellow

    1..3 | ForEach-Object {
        $pids = Get-NetTCPConnection `
            -LocalPort $ports `
            -State Listen `
            -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique

        foreach ($processId in $pids) {
            if ($processId -and $processId -ne $PID) {
                Stop-Process `
                    -Id $processId `
                    -Force `
                    -ErrorAction SilentlyContinue
            }
        }

        Start-Sleep -Milliseconds 700
    }

    for ($ollamaCleanupPass = 1; $ollamaCleanupPass -le 5; $ollamaCleanupPass++) {
        $ollamaTargets = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object {
                $_.Name -ieq "ollama.exe" -or
                $_.Name -ieq "ollama app.exe" -or
                (
                    $_.Name -ieq "llama-server.exe" -and
                    (
                        $_.ExecutablePath -like "*\Ollama\lib\ollama\llama-server.exe" -or
                        $_.CommandLine -match '(?i)\\Ollama\\lib\\ollama\\llama-server\.exe'
                    )
                ) -or
                $_.CommandLine -match '(?i)ollama app\.exe.*fast-startup'
            }

        foreach ($ollamaProcess in $ollamaTargets) {
            if ($ollamaProcess.ProcessId -and $ollamaProcess.ProcessId -ne $PID) {
                Stop-Process -Id $ollamaProcess.ProcessId -Force -ErrorAction SilentlyContinue
            }
        }

        Start-Sleep -Milliseconds 300
    }

    $remaining = Get-NetTCPConnection `
        -LocalPort $ports `
        -State Listen `
        -ErrorAction SilentlyContinue

    Write-Host ""

    if (-not $remaining) {
        Write-Host "WCKD Suite OFFLINE." -ForegroundColor Green
    }
    else {
        Write-Host "Some WCKD ports are still active:" -ForegroundColor Red

        $remaining |
            Select-Object LocalAddress, LocalPort, OwningProcess |
            Sort-Object LocalPort |
            Format-Table -AutoSize
    }

    $nvidiaSmi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue

    if ($nvidiaSmi) {
        Start-Sleep -Seconds 1

        try {
            $used = & $nvidiaSmi.Source `
                --query-gpu=memory.used `
                --format=csv,noheader,nounits 2>$null |
                Select-Object -First 1

            if ($used -match '^\s*(\d+)\s*$') {
                Write-Host ("GPU VRAM used: {0} MB" -f $Matches[1]) -ForegroundColor Cyan
            }
        }
        catch {
        }
    }

    Write-Host ""
}

# === WCKD_START_OVERRIDE_V2_2_BEGIN ===
# Open WebUI is optional. Default WCKD Core = 9 services.

function start-wckd-suite {
    [CmdletBinding()]
    param(
        [switch]$WebUI,
        [switch]$UI
    )

    $AiRoot = $script:WckdCoreRoot
    $MainLauncher = Join-Path $AiRoot "start-wckd-ai.ps1"

    $coreServices = @(
        [pscustomobject]@{ Name="Ollama";              Port=11434; Timeout=60  },
        [pscustomobject]@{ Name="WCKD Tools";          Port=8001;  Timeout=60  },
        [pscustomobject]@{ Name="WCKD Lab";            Port=8020;  Timeout=120 },
        [pscustomobject]@{ Name="Model Manager";       Port=8040;  Timeout=120 },
        [pscustomobject]@{ Name="Specialist Registry"; Port=8050;  Timeout=120 },
        [pscustomobject]@{ Name="Auto Router";         Port=8002;  Timeout=120 },
        [pscustomobject]@{ Name="Agent Runner";        Port=8030;  Timeout=120 },
        [pscustomobject]@{ Name="Project Memory";      Port=8070;  Timeout=120 },
        [pscustomobject]@{ Name="Agent Orchestrator";  Port=8060;  Timeout=120 }
    )

    function Wait-WckdStartupServiceV22 {
        param(
            [Parameter(Mandatory=$true)]$Service,
            [Parameter(Mandatory=$true)][System.Diagnostics.Stopwatch]$SuiteWatch
        )

        $name = [string]$Service.Name
        $port = [int]$Service.Port
        $timeout = [int]$Service.Timeout

        if (Test-WckdPort -Port $port) {
            Write-Host (
                "[READY]   {0,-22} :{1,-5} already online   total {2,6:N1}s" -f `
                $name,
                $port,
                $SuiteWatch.Elapsed.TotalSeconds
            ) -ForegroundColor Green

            return [pscustomobject]@{
                Name = $name
                Port = $port
                Online = $true
                Seconds = 0.0
                AlreadyOnline = $true
            }
        }

        Write-Host ("[WAIT]    {0,-22} :{1,-5} starting..." -f $name,$port) -ForegroundColor Yellow

        $watch = [System.Diagnostics.Stopwatch]::StartNew()
        $nextProgress = 2.0

        while ($watch.Elapsed.TotalSeconds -lt $timeout) {
            if (Test-WckdPort -Port $port) {
                $watch.Stop()

                Write-Host (
                    "[ONLINE]  {0,-22} :{1,-5} {2,6:N1}s   total {3,6:N1}s" -f `
                    $name,
                    $port,
                    $watch.Elapsed.TotalSeconds,
                    $SuiteWatch.Elapsed.TotalSeconds
                ) -ForegroundColor Green

                return [pscustomobject]@{
                    Name = $name
                    Port = $port
                    Online = $true
                    Seconds = $watch.Elapsed.TotalSeconds
                    AlreadyOnline = $false
                }
            }

            if ($watch.Elapsed.TotalSeconds -ge $nextProgress) {
                Write-Host (
                    "[WAIT]    {0,-22} :{1,-5} {2,6:N1}s..." -f `
                    $name,
                    $port,
                    $watch.Elapsed.TotalSeconds
                ) -ForegroundColor DarkYellow

                $nextProgress += 2.0
            }

            Start-Sleep -Milliseconds 250
        }

        $watch.Stop()

        Write-Host (
            "[TIMEOUT] {0,-22} :{1,-5} after {2,6:N1}s" -f `
            $name,
            $port,
            $watch.Elapsed.TotalSeconds
        ) -ForegroundColor Red

        return [pscustomobject]@{
            Name = $name
            Port = $port
            Online = $false
            Seconds = $watch.Elapsed.TotalSeconds
            AlreadyOnline = $false
        }
    }

    Write-Host ""
    Write-Host "WCKD SUITE START" -ForegroundColor Cyan
    Write-Host "================" -ForegroundColor DarkCyan
    Write-Host "Startup telemetry v2.2: ON" -ForegroundColor DarkGray

    if ($WebUI) {
        Write-Host "Open WebUI: requested (-WebUI)" -ForegroundColor DarkGray
    }
    else {
        Write-Host "Open WebUI: optional / skipped" -ForegroundColor DarkGray
    }

    Write-Host ""

    $suiteWatch = [System.Diagnostics.Stopwatch]::StartNew()

    $needStart = $false

    foreach ($service in $coreServices) {
        if (-not (Test-WckdPort -Port $service.Port)) {
            $needStart = $true
            break
        }
    }

    if ($WebUI -and -not (Test-WckdPort -Port 8080)) {
        $needStart = $true
    }

    if ($needStart) {
        if (-not (Test-Path $MainLauncher)) {
            Write-Host "[ERROR] Missing: $MainLauncher" -ForegroundColor Red
            return
        }

        $oldSkipWebUI = $env:WCKD_SKIP_WEBUI

        try {
            if ($WebUI) {
                $env:WCKD_SKIP_WEBUI = "0"
            }
            else {
                $env:WCKD_SKIP_WEBUI = "1"
            }

            Write-Host "[LAUNCH]  WCKD core stack -> start-wckd-ai.ps1" -ForegroundColor Cyan

            Start-Process `
                -FilePath "powershell.exe" `
                -ArgumentList "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$MainLauncher`"" `
                -WorkingDirectory $AiRoot `
                -WindowStyle Hidden | Out-Null
        }
        finally {
            if ($null -eq $oldSkipWebUI) {
                Remove-Item Env:\WCKD_SKIP_WEBUI -ErrorAction SilentlyContinue
            }
            else {
                $env:WCKD_SKIP_WEBUI = $oldSkipWebUI
            }
        }
    }
    else {
        Write-Host "[INFO]    Requested services already listening." -ForegroundColor DarkGray
    }

    Write-Host ""
    Write-Host "CORE STARTUP" -ForegroundColor Cyan
    Write-Host "------------" -ForegroundColor DarkCyan

    $coreResults = @()

    foreach ($service in $coreServices) {
        $result = Wait-WckdStartupServiceV22 -Service $service -SuiteWatch $suiteWatch
        $coreResults += $result
    }

    # --------------------------------------------------------
    # OPTIONAL: OPEN WEBUI
    # --------------------------------------------------------

    if ($WebUI) {
        $webService = [pscustomobject]@{
            Name = "Open WebUI"
            Port = 8080
            Timeout = 180
        }

        [void](Wait-WckdStartupServiceV22 -Service $webService -SuiteWatch $suiteWatch)
    }
    else {
        if (Test-WckdPort -Port 8080) {
            Write-Host ("[READY]   {0,-22} :{1,-5} already online (optional)" -f "Open WebUI",8080) -ForegroundColor Green
        }
        else {
            Write-Host ("[OFF]     {0,-22} :{1,-5} optional (use -WebUI)" -f "Open WebUI",8080) -ForegroundColor DarkGray
        }
    }

    # --------------------------------------------------------
    # --------------------------------------------------------



    $suiteWatch.Stop()

    Write-Host ""
    Write-Host "STARTUP SUMMARY" -ForegroundColor Cyan
    Write-Host "---------------" -ForegroundColor DarkCyan

    foreach ($result in $coreResults) {
        if ($result.Online -eq $true) {
            if ($result.AlreadyOnline -eq $true) {
                $marker = "READY"
            }
            else {
                $marker = "ONLINE"
            }

            Write-Host (
                "[{0}] {1,-22} {2,6:N1}s" -f `
                $marker,
                $result.Name,
                $result.Seconds
            ) -ForegroundColor Green
        }
        else {
            Write-Host (
                "[FAIL]  {0,-22} {1,6:N1}s" -f `
                $result.Name,
                $result.Seconds
            ) -ForegroundColor Red
        }
    }

    $onlineCount = 0

    foreach ($startupResult in $coreResults) {
        if ($startupResult.Online -eq $true) {
            $onlineCount = $onlineCount + 1
        }
    }

    $coreCount = [int]$coreServices.Count

    Write-Host ""

    if ($onlineCount -eq $coreCount) {
        Write-Host (
            "WCKD Core ready: {0}/{1} online in {2:N1}s." -f `
            $onlineCount,
            $coreCount,
            $suiteWatch.Elapsed.TotalSeconds
        ) -ForegroundColor Cyan
    }
    else {
        Write-Host (
            "WCKD Core degraded: {0}/{1} online after {2:N1}s." -f `
            $onlineCount,
            $coreCount,
            $suiteWatch.Elapsed.TotalSeconds
        ) -ForegroundColor Yellow

        Write-Host "Run: wckd-doctor -Detailed" -ForegroundColor Yellow
    }

    if ($WebUI) {
        if (Test-WckdPort -Port 8080) {
            Write-Host "Open WebUI: ONLINE (optional)" -ForegroundColor Green
        }
        else {
            Write-Host "Open WebUI: FAILED to start" -ForegroundColor Red
        }
    }

    if ($UI) {
        wckd-ui
    }

    Write-Host ""
}

# === WCKD_START_OVERRIDE_V2_2_END ===
