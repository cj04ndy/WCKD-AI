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

$ErrorActionPreference = "SilentlyContinue"

$RecoveryVersion = "1.3.0"
$AI = $PSScriptRoot
$LOGS = Join-Path $AI "logs"
$RecoveryLog = Join-Path $LOGS "recovery.log"
$StateFile = Join-Path $LOGS "recovery-state.json"

$PythonExe = Join-Path $AI ".venv\Scripts\python.exe"
$UvxExe = (Get-Command uvx.exe,uvx -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)

New-Item -ItemType Directory -Force -Path $LOGS | Out-Null

function Write-RecoveryLog {
    param(
        [Parameter(Mandatory=$true)][string]$Level,
        [Parameter(Mandatory=$true)][string]$Message
    )

    $line = "{0} [{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level.ToUpper(), $Message
    Add-Content -Path $RecoveryLog -Value $line -Encoding UTF8
}

function Test-PortListening {
    param([Parameter(Mandatory=$true)][int]$Port)

    $connection = Get-NetTCPConnection `
        -LocalPort $Port `
        -State Listen `
        -ErrorAction SilentlyContinue |
        Select-Object -First 1

    return ($null -ne $connection)
}

function Get-PortPid {
    param([Parameter(Mandatory=$true)][int]$Port)

    $connection = Get-NetTCPConnection `
        -LocalPort $Port `
        -State Listen `
        -ErrorAction SilentlyContinue |
        Select-Object -First 1

    if ($connection) {
        return [int]$connection.OwningProcess
    }

    return $null
}

function Wait-PortState {
    param(
        [Parameter(Mandatory=$true)][int]$Port,
        [Parameter(Mandatory=$true)][bool]$Listening,
        [int]$TimeoutSeconds = 30
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

    while ((Get-Date) -lt $deadline) {
        $current = Test-PortListening -Port $Port

        if ($current -eq $Listening) {
            return $true
        }

        Start-Sleep -Milliseconds 500
    }

    return $false
}

function Get-Json {
    param(
        [Parameter(Mandatory=$true)][string]$Uri,
        [int]$TimeoutSec = 8
    )

    try {
        return Invoke-RestMethod `
            -Uri $Uri `
            -Method Get `
            -TimeoutSec $TimeoutSec `
            -ErrorAction Stop
    }
    catch {
        return $null
    }
}

function Test-ServiceHealth {
    param([Parameter(Mandatory=$true)]$Service)

    if (-not (Test-PortListening -Port $Service.Port)) {
        return [pscustomobject]@{
            Healthy = $false
            Detail = "port $($Service.Port) not listening"
        }
    }

    switch ($Service.Key) {
        "ollama" {
            $r = Get-Json "http://127.0.0.1:11434/api/tags"

            if ($null -ne $r) {
                return [pscustomobject]@{
                    Healthy = $true
                    Detail = "API reachable"
                }
            }

            return [pscustomobject]@{
                Healthy = $false
                Detail = "port open but /api/tags failed"
            }
        }

        "registry" {
            $r = Get-Json "http://127.0.0.1:8050/health"

            if ($r -and [string]$r.status -eq "ok" -and $r.valid -eq $true) {
                return [pscustomobject]@{
                    Healthy = $true
                    Detail = "health ok; v$($r.version); specialists=$($r.specialists_total)"
                }
            }

            return [pscustomobject]@{
                Healthy = $false
                Detail = "port open but /health not ok"
            }
        }

        "router" {
            $r = Get-Json "http://127.0.0.1:8002/health"

            if ($r -and [string]$r.status -eq "ok") {
                return [pscustomobject]@{
                    Healthy = $true
                    Detail = "health ok; v$($r.version)"
                }
            }

            return [pscustomobject]@{
                Healthy = $false
                Detail = "port open but /health not ok"
            }
        }

        "lab" {
            $r = Get-Json "http://127.0.0.1:8020/health"

            if ($r -and [string]$r.status -eq "ok") {
                return [pscustomobject]@{
                    Healthy = $true
                    Detail = "health ok; v$($r.version)"
                }
            }

            return [pscustomobject]@{
                Healthy = $false
                Detail = "port open but /health not ok"
            }
        }

        "agent" {
            $r = Get-Json "http://127.0.0.1:8030/health"

            if ($r -and [string]$r.status -eq "ok") {
                return [pscustomobject]@{
                    Healthy = $true
                    Detail = "health ok; v$($r.version)"
                }
            }

            return [pscustomobject]@{
                Healthy = $false
                Detail = "port open but /health not ok"
            }
        }

        "memory" {
            $r = Get-Json "http://127.0.0.1:8070/health"

            if ($r -and [string]$r.status -eq "ok" -and $r.database_ok -eq $true) {
                return [pscustomobject]@{
                    Healthy = $true
                    Detail = "health ok; v$($r.version); retrieval=$($r.retrieval)"
                }
            }

            return [pscustomobject]@{
                Healthy = $false
                Detail = "port open but /health not ok"
            }
        }

        "orchestrator" {
            $r = Get-Json "http://127.0.0.1:8060/health"

            if ($r -and [string]$r.status -eq "ok") {
                return [pscustomobject]@{
                    Healthy = $true
                    Detail = "health ok; v$($r.version); queued=$($r.queued)"
                }
            }

            return [pscustomobject]@{
                Healthy = $false
                Detail = "port open but /health not ok"
            }
        }

        "manager" {
            $r = Get-Json "http://127.0.0.1:8040/health"

            if ($r -and [string]$r.status -eq "ok") {
                return [pscustomobject]@{
                    Healthy = $true
                    Detail = "health ok; v$($r.version)"
                }
            }

            return [pscustomobject]@{
                Healthy = $false
                Detail = "port open but /health not ok"
            }
        }

        "tools" {
            return [pscustomobject]@{
                Healthy = $true
                Detail = "port 8001 listening"
            }
        }

        "webui" {
            return [pscustomobject]@{
                Healthy = $true
                Detail = "port 8080 listening"
            }
        }
    }

    return [pscustomobject]@{
        Healthy = $false
        Detail = "unknown service type"
    }
}

function Stop-ServiceProcess {
    param([Parameter(Mandatory=$true)]$Service)

    $pidOnPort = Get-PortPid -Port $Service.Port

    if (-not $pidOnPort) {
        return $true
    }

    Write-RecoveryLog "INFO" "Stopping $($Service.Name) PID=$pidOnPort port=$($Service.Port)"

    try {
        Stop-Process -Id $pidOnPort -Force -ErrorAction Stop
    }
    catch {
        Write-RecoveryLog "ERROR" "Failed to stop $($Service.Name) PID=$pidOnPort : $($_.Exception.Message)"
        return $false
    }

    return (Wait-PortState -Port $Service.Port -Listening $false -TimeoutSeconds 15)
}

function Start-UvicornRecoveryService {
    param([Parameter(Mandatory=$true)]$Service)

    if (-not (Test-Path $PythonExe)) {
        Write-RecoveryLog "ERROR" "Python missing: $PythonExe"
        return $false
    }

    $modulePy = Join-Path $AI ($Service.Module + ".py")
    $modulePyc = Join-Path $AI ($Service.Module + ".pyc")

    if (-not (Test-Path $modulePy) -and -not (Test-Path $modulePyc)) {
        Write-RecoveryLog "ERROR" "Module missing: $($Service.Module) (.py or .pyc)"
        return $false
    }

    Start-Process `
        -FilePath $PythonExe `
        -ArgumentList "-m uvicorn $($Service.Module):app --host 127.0.0.1 --port $($Service.Port)" `
        -WorkingDirectory $AI `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $LOGS "$($Service.LogName).log") `
        -RedirectStandardError (Join-Path $LOGS "$($Service.LogName)-error.log") |
        Out-Null

    return (Wait-PortState -Port $Service.Port -Listening $true -TimeoutSeconds $Service.StartTimeout)
}

function Start-RecoveryService {
    param([Parameter(Mandatory=$true)]$Service)

    switch ($Service.Kind) {
        "uvicorn" {
            return (Start-UvicornRecoveryService -Service $Service)
        }

        "ollama" {
            $ollamaExe = (Get-Command ollama.exe -ErrorAction SilentlyContinue).Source

            if (-not $ollamaExe) {
                Write-RecoveryLog "ERROR" "ollama.exe not found"
                return $false
            }

            $env:OLLAMA_CONTEXT_LENGTH = "32768"

            Start-Process `
                -FilePath $ollamaExe `
                -ArgumentList "serve" `
                -WorkingDirectory $AI `
                -WindowStyle Hidden `
                -RedirectStandardOutput (Join-Path $LOGS "ollama.log") `
                -RedirectStandardError (Join-Path $LOGS "ollama-error.log") |
                Out-Null

            return (Wait-PortState -Port $Service.Port -Listening $true -TimeoutSeconds $Service.StartTimeout)
        }

        "webui" {
            if (-not (Test-Path $UvxExe)) {
                Write-RecoveryLog "ERROR" "uvx.exe missing: $UvxExe"
                return $false
            }

            $env:WEBUI_NAME = "WCKD AI"
            $env:DATA_DIR = Join-Path $AI "open-webui-data"

            Start-Process `
                -FilePath $UvxExe `
                -ArgumentList "--python 3.11 open-webui@latest serve" `
                -WorkingDirectory $AI `
                -WindowStyle Hidden `
                -RedirectStandardOutput (Join-Path $LOGS "webui.log") `
                -RedirectStandardError (Join-Path $LOGS "webui-error.log") |
                Out-Null

            return (Wait-PortState -Port $Service.Port -Listening $true -TimeoutSeconds $Service.StartTimeout)
        }
    }

    return $false
}

function Recover-Service {
    param(
        [Parameter(Mandatory=$true)]$Service,
        [Parameter(Mandatory=$true)][int]$Attempts,
        [Parameter(Mandatory=$true)][int]$Cooldown
    )

    $initial = Test-ServiceHealth -Service $Service

    if ($initial.Healthy) {
        return [pscustomobject]@{
            Name = $Service.Name
            Key = $Service.Key
            Status = "HEALTHY"
            Attempts = 0
            Detail = $initial.Detail
        }
    }

    if ($DryRun) {
        Write-RecoveryLog "DRYRUN" "$($Service.Name) unhealthy: $($initial.Detail)"

        return [pscustomobject]@{
            Name = $Service.Name
            Key = $Service.Key
            Status = "WOULD_RECOVER"
            Attempts = 0
            Detail = $initial.Detail
        }
    }

    Write-RecoveryLog "WARN" "$($Service.Name) unhealthy: $($initial.Detail)"

    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        Write-RecoveryLog "INFO" "Recovery attempt $attempt/$Attempts for $($Service.Name)"

        if (Test-PortListening -Port $Service.Port) {
            $stopped = Stop-ServiceProcess -Service $Service

            if (-not $stopped) {
                Write-RecoveryLog "WARN" "$($Service.Name) did not stop cleanly"
            }
        }

        Start-Sleep -Milliseconds 500

        $started = Start-RecoveryService -Service $Service

        if ($started) {
            Start-Sleep -Seconds 1

            $health = Test-ServiceHealth -Service $Service

            if ($health.Healthy) {
                Write-RecoveryLog "PASS" "$($Service.Name) recovered on attempt $attempt"

                return [pscustomobject]@{
                    Name = $Service.Name
                    Key = $Service.Key
                    Status = "RECOVERED"
                    Attempts = $attempt
                    Detail = $health.Detail
                }
            }

            Write-RecoveryLog "WARN" "$($Service.Name) started but health check failed: $($health.Detail)"
        }
        else {
            Write-RecoveryLog "WARN" "$($Service.Name) failed to start/listen on port $($Service.Port)"
        }

        if ($attempt -lt $Attempts -and $Cooldown -gt 0) {
            Write-RecoveryLog "INFO" "Cooldown $Cooldown sec before retrying $($Service.Name)"
            Start-Sleep -Seconds $Cooldown
        }
    }

    $final = Test-ServiceHealth -Service $Service
    Write-RecoveryLog "ERROR" "$($Service.Name) recovery exhausted after $Attempts attempts: $($final.Detail)"

    return [pscustomobject]@{
        Name = $Service.Name
        Key = $Service.Key
        Status = "FAILED"
        Attempts = $Attempts
        Detail = $final.Detail
    }
}

# Recovery order is dependency-aware:
# Ollama -> Tools -> Lab -> Model Manager -> Specialist Registry -> Router -> Agent Runner -> Project Memory -> Agent Orchestrator -> Open WebUI
$Services = @(
    [pscustomobject]@{
        Key="ollama"; Name="Ollama"; Port=11434; Kind="ollama";
        Module=$null; LogName="ollama"; StartTimeout=30
    },
    [pscustomobject]@{
        Key="tools"; Name="WCKD Tools"; Port=8001; Kind="uvicorn";
        Module="wckd_tools"; LogName="tools"; StartTimeout=30
    },
    [pscustomobject]@{
        Key="lab"; Name="WCKD Lab"; Port=8020; Kind="uvicorn";
        Module="wckd_lab_agent"; LogName="lab-agent"; StartTimeout=60
    },
    [pscustomobject]@{
        Key="manager"; Name="Model Manager"; Port=8040; Kind="uvicorn";
        Module="wckd_model_manager"; LogName="model-manager"; StartTimeout=60
    },
    [pscustomobject]@{
        Key="registry"; Name="Specialist Registry"; Port=8050; Kind="uvicorn";
        Module="wckd_specialist_registry"; LogName="specialist-registry"; StartTimeout=60
    },
    [pscustomobject]@{
        Key="router"; Name="Auto Router"; Port=8002; Kind="uvicorn";
        Module="wckd_router"; LogName="router"; StartTimeout=60
    },
    [pscustomobject]@{
        Key="agent"; Name="Agent Runner"; Port=8030; Kind="uvicorn";
        Module="wckd_agent_runner"; LogName="agent-runner"; StartTimeout=60
    },
    [pscustomobject]@{
        Key="memory"; Name="Project Memory"; Port=8070; Kind="uvicorn";
        Module="wckd_memory"; LogName="memory"; StartTimeout=60
    },
    [pscustomobject]@{
        Key="orchestrator"; Name="Agent Orchestrator"; Port=8060; Kind="uvicorn";
        Module="wckd_orchestrator"; LogName="orchestrator"; StartTimeout=60
    },
    [pscustomobject]@{
        Key="webui"; Name="Open WebUI"; Port=8080; Kind="webui";
        Module=$null; LogName="webui"; StartTimeout=120
    }
)

$selected = if ($Target -eq "all") {
    @($Services)
}
else {
    @($Services | Where-Object { $_.Key -eq $Target })
}

if ($selected.Count -eq 0) {
    Write-Host "[ERROR] Unknown target: $Target" -ForegroundColor Red
    exit 2
}

Write-Host ""
Write-Host "WCKD AUTORECOVERY v$RecoveryVersion" -ForegroundColor Cyan
Write-Host "========================" -ForegroundColor DarkCyan
Write-Host ("Mode: {0}" -f $(if ($DryRun) { "DRY RUN" } else { "RECOVERY" }))
Write-Host ("Target: {0}" -f $Target)
Write-Host ("Max attempts/service: {0}" -f $MaxAttempts)
Write-Host ""

Write-RecoveryLog "INFO" "WCKD AutoRecovery v$RecoveryVersion start target=$Target dryrun=$DryRun attempts=$MaxAttempts"

$results = New-Object System.Collections.Generic.List[object]

foreach ($service in $selected) {
    $before = Test-ServiceHealth -Service $service

    if ($before.Healthy) {
        Write-Host ("[PASS] {0,-14} {1}" -f $service.Name, $before.Detail) -ForegroundColor Green

        $results.Add([pscustomobject]@{
            Name = $service.Name
            Key = $service.Key
            Status = "HEALTHY"
            Attempts = 0
            Detail = $before.Detail
        }) | Out-Null

        continue
    }

    Write-Host ("[FAIL] {0,-14} {1}" -f $service.Name, $before.Detail) -ForegroundColor Red

    $result = Recover-Service `
        -Service $service `
        -Attempts $MaxAttempts `
        -Cooldown $CooldownSeconds

    $results.Add($result) | Out-Null

    switch ($result.Status) {
        "RECOVERED" {
            Write-Host ("[RECOVERED] {0,-10} attempt {1}: {2}" -f $service.Name, $result.Attempts, $result.Detail) -ForegroundColor Green
        }
        "WOULD_RECOVER" {
            Write-Host ("[DRYRUN] {0,-13} would restart" -f $service.Name) -ForegroundColor Yellow
        }
        "FAILED" {
            Write-Host ("[FAILED] {0,-12} {1}" -f $service.Name, $result.Detail) -ForegroundColor Red
        }
    }
}

$healthyCount = @($results | Where-Object { $_.Status -eq "HEALTHY" }).Count
$recoveredCount = @($results | Where-Object { $_.Status -eq "RECOVERED" }).Count
$failedCount = @($results | Where-Object { $_.Status -eq "FAILED" }).Count
$dryCount = @($results | Where-Object { $_.Status -eq "WOULD_RECOVER" }).Count

$overall = if ($failedCount -gt 0) {
    "FAILED"
}
elseif ($DryRun -and $dryCount -gt 0) {
    "ACTION_NEEDED"
}
elseif ($recoveredCount -gt 0) {
    "RECOVERED"
}
else {
    "HEALTHY"
}

$state = [pscustomobject]@{
    version = $RecoveryVersion
    timestamp = (Get-Date).ToString("o")
    target = $Target
    dry_run = [bool]$DryRun
    overall = $overall
    healthy = $healthyCount
    recovered = $recoveredCount
    failed = $failedCount
    would_recover = $dryCount
    results = @($results)
}

$state |
    ConvertTo-Json -Depth 8 |
    Set-Content -Path $StateFile -Encoding UTF8

Write-RecoveryLog "INFO" "WCKD AutoRecovery end overall=$overall healthy=$healthyCount recovered=$recoveredCount failed=$failedCount"

Write-Host ""
Write-Host "========================" -ForegroundColor DarkCyan

$overallColor = switch ($overall) {
    "HEALTHY" { "Green" }
    "RECOVERED" { "Green" }
    "ACTION_NEEDED" { "Yellow" }
    default { "Red" }
}

Write-Host ("OVERALL: {0}" -f $overall) -ForegroundColor $overallColor
Write-Host ("Healthy {0} | Recovered {1} | Failed {2}" -f $healthyCount, $recoveredCount, $failedCount)
Write-Host ("Audit: {0}" -f $RecoveryLog)
Write-Host ""

if ($failedCount -gt 0) {
    exit 1
}

exit 0
