[CmdletBinding()]
param(
    [switch]$Detailed,
    [switch]$Json
)

$ErrorActionPreference = "SilentlyContinue"

$DoctorVersion = "1.3.0"
$AiRoot = $PSScriptRoot
$PythonExe = Join-Path $AiRoot ".venv\Scripts\python.exe"

$script:Checks = New-Object System.Collections.Generic.List[object]

function Add-Check {
    param(
        [Parameter(Mandatory=$true)][string]$Category,
        [Parameter(Mandatory=$true)][string]$Name,
        [Parameter(Mandatory=$true)][ValidateSet("PASS","WARN","FAIL","INFO")][string]$Status,
        [Parameter(Mandatory=$true)][string]$Detail
    )

    $script:Checks.Add([pscustomobject]@{
        Category = $Category
        Name     = $Name
        Status   = $Status
        Detail   = $Detail
    }) | Out-Null
}

function Test-Port {
    param([Parameter(Mandatory=$true)][int]$Port)

    $c = Get-NetTCPConnection `
        -LocalPort $Port `
        -State Listen `
        -ErrorAction SilentlyContinue |
        Select-Object -First 1

    return ($null -ne $c)
}

function Get-Json {
    param(
        [Parameter(Mandatory=$true)][string]$Uri,
        [int]$TimeoutSec = 15
    )

    try {
        return Invoke-RestMethod -Uri $Uri -TimeoutSec $TimeoutSec -ErrorAction Stop
    }
    catch {
        return $null
    }
}

function Has-Property {
    param(
        $Object,
        [Parameter(Mandatory=$true)][string]$Name
    )

    if ($null -eq $Object) {
        return $false
    }

    return ($null -ne $Object.PSObject.Properties[$Name])
}

function Format-ModelList {
    param([object[]]$Models)

    if (-not $Models -or $Models.Count -eq 0) {
        return "(none)"
    }

    return (($Models | ForEach-Object { [string]$_ }) -join ", ")
}

function Write-CheckLine {
    param($Check)

    $color = switch ($Check.Status) {
        "PASS" { "Green" }
        "WARN" { "Yellow" }
        "FAIL" { "Red" }
        default { "Cyan" }
    }

    Write-Host ("[{0}] {1,-18} {2}" -f $Check.Status, $Check.Name, $Check.Detail) -ForegroundColor $color
}

# ============================================================
# HEADER / HOST
# ============================================================

$timestamp = Get-Date
$psVersion = $PSVersionTable.PSVersion.ToString()

Add-Check "Host" "PowerShell" "INFO" ("v{0}" -f $psVersion)
Add-Check "Host" "AI root" ($(if (Test-Path $AiRoot) { "PASS" } else { "FAIL" })) $AiRoot

if (Test-Path $PythonExe) {
    $pyVersion = (& $PythonExe -c "import sys; print(sys.version.split()[0])" 2>$null | Select-Object -First 1)
    if ($pyVersion) {
        Add-Check "Host" "Python venv" "PASS" ("Python {0}" -f $pyVersion)
    }
    else {
        Add-Check "Host" "Python venv" "WARN" "python.exe exists but version probe failed"
    }
}
else {
    Add-Check "Host" "Python venv" "FAIL" ("Missing: {0}" -f $PythonExe)
}

# ============================================================
# CRITICAL FILES
# ============================================================

$requiredFiles = @(
    @{ Name="Auto Router";      Paths=@((Join-Path $AiRoot "wckd_router.py")) },
    @{ Name="Model Manager";    Paths=@((Join-Path $AiRoot "wckd_model_manager.py")) },
    @{ Name="Specialist Registry"; Paths=@((Join-Path $AiRoot "wckd_specialist_registry.py")) },
    @{ Name="Agent Orchestrator"; Paths=@((Join-Path $AiRoot "wckd_orchestrator.py")) },
    @{ Name="Project Memory";    Paths=@((Join-Path $AiRoot "wckd_memory.py")) },
    @{ Name="WCKD Tools";       Paths=@((Join-Path $AiRoot "wckd_tools.py")) },
    @{ Name="WCKD Lab Agent";   Paths=@((Join-Path $AiRoot "wckd_lab_agent.py")) },
    @{ Name="Agent Runner";     Paths=@((Join-Path $AiRoot "wckd_agent_runner.py"),(Join-Path $AiRoot "wckd_agent_runner.pyc")) },
    @{ Name="Main launcher";    Paths=@((Join-Path $AiRoot "start-wckd-ai.ps1")) },
    @{ Name="WCKD shell";       Paths=@((Join-Path $AiRoot "wckd-shell.ps1")) }
)

foreach ($item in $requiredFiles) {
    $found = @($item.Paths | Where-Object { Test-Path $_ })
    if ($found.Count -gt 0) {
        Add-Check "Files" $item.Name "PASS" (($found | ForEach-Object { Split-Path $_ -Leaf }) -join ", ")
    }
    else {
        Add-Check "Files" $item.Name "FAIL" ("Missing: {0}" -f ($item.Paths -join " OR "))
    }
}

# Verify launcher contains the current integration and Agent Runner .pyc compatibility.
$launcherPath = (Join-Path $AiRoot "start-wckd-ai.ps1")
if (Test-Path $launcherPath) {
    $launcherText = Get-Content $launcherPath -Raw -ErrorAction SilentlyContinue

    if ($launcherText -match 'ModelManagerPort\s*=\s*8040' -and $launcherText -match 'wckd_model_manager') {
        Add-Check "Files" "Launcher 8040" "PASS" "Model Manager startup integration present"
    }
    else {
        Add-Check "Files" "Launcher 8040" "FAIL" "Model Manager startup integration missing"
    }

    if ($launcherText -match 'SpecialistRegistryPort\s*=\s*8050' -and $launcherText -match 'wckd_specialist_registry') {
        Add-Check "Files" "Launcher 8050" "PASS" "Specialist Registry startup integration present"
    }
    else {
        Add-Check "Files" "Launcher 8050" "FAIL" "Specialist Registry startup integration missing"
    }

    if ($launcherText -match 'OrchestratorPort\s*=\s*8060' -and $launcherText -match 'wckd_orchestrator') {
        Add-Check "Files" "Launcher 8060" "PASS" "Agent Orchestrator startup integration present"
    }
    else {
        Add-Check "Files" "Launcher 8060" "FAIL" "Agent Orchestrator startup integration missing"
    }

    if ($launcherText -match 'MemoryPort\s*=\s*8070' -and $launcherText -match 'wckd_memory') {
        Add-Check "Files" "Launcher 8070" "PASS" "Project Memory startup integration present"
    }
    else {
        Add-Check "Files" "Launcher 8070" "FAIL" "Project Memory startup integration missing"
    }

    if ($launcherText -match '\.pyc') {
        Add-Check "Files" "Runner .pyc fix" "PASS" "Launcher accepts compiled Agent Runner module"
    }
    else {
        Add-Check "Files" "Runner .pyc fix" "WARN" "Launcher does not appear to accept .pyc modules"
    }
}

$shellPath = (Join-Path $AiRoot "wckd-shell.ps1")
if (Test-Path $shellPath) {
    $shellText = Get-Content $shellPath -Raw -ErrorAction SilentlyContinue

    if ($shellText -match '8040' -and $shellText -match 'wckd-model-status') {
        Add-Check "Files" "Shell 8040" "PASS" "Model Manager startup/status/killswitch integration present"
    }
    else {
        Add-Check "Files" "Shell 8040" "FAIL" "Model Manager shell integration incomplete"
    }

    if ($shellText -match '8050' -and $shellText -match 'wckd-specialists') {
        Add-Check "Files" "Shell 8050" "PASS" "Specialist Registry status/killswitch/helpers integration present"
    }
    else {
        Add-Check "Files" "Shell 8050" "FAIL" "Specialist Registry shell integration incomplete"
    }


    if ($shellText -match '8060' -and $shellText -match 'wckd-orchestrate') {
        Add-Check "Files" "Shell 8060" "PASS" "Agent Orchestrator status/killswitch/helpers integration present"
    }
    else {
        Add-Check "Files" "Shell 8060" "FAIL" "Agent Orchestrator shell integration incomplete"
    }


    if ($shellText -match '8070' -and $shellText -match 'wckd-memory-search') {
        Add-Check "Files" "Shell 8070" "PASS" "Project Memory status/killswitch/helpers integration present"
    }
    else {
        Add-Check "Files" "Shell 8070" "FAIL" "Project Memory shell integration incomplete"
    }
}

# ============================================================
# CORE PORTS
# ============================================================

$corePorts = [ordered]@{
    "Ollama"        = 11434
    "WCKD Tools"    = 8001
    "Auto Router"   = 8002
    "WCKD Lab"      = 8020
    "Agent Runner"  = 8030
    "Model Manager" = 8040
    "Specialist Registry" = 8050
    "Agent Orchestrator" = 8060
    "Project Memory" = 8070
}

foreach ($name in $corePorts.Keys) {
    $port = [int]$corePorts[$name]
    if (Test-Port $port) {
        Add-Check "Ports" $name "PASS" ("127.0.0.1:{0} listening" -f $port)
    }
    else {
        Add-Check "Ports" $name "FAIL" ("port {0} not listening" -f $port)
    }
}

$optionalPorts = [ordered]@{
}

foreach ($name in $optionalPorts.Keys) {
    $port = [int]$optionalPorts[$name]
    if (Test-Port $port) {
        Add-Check "Optional" $name "INFO" ("ONLINE on {0}" -f $port)
    }
    else {
        Add-Check "Optional" $name "INFO" "OFF (optional)"
    }
}

# ============================================================
# OLLAMA
# ============================================================

$tags = Get-Json "http://127.0.0.1:11434/api/tags"
$psApi = Get-Json "http://127.0.0.1:11434/api/ps"

$expectedModels = @(
    "qwen3.5:9b",
    "gpt-oss:20b",
    "nemotron-3-nano:4b",
    "nemotron-3-nano:30b"
)

if ($tags) {
    $installed = @(
        $tags.models |
        ForEach-Object {
            if ($_.name) { [string]$_.name }
            elseif ($_.model) { [string]$_.model }
        } |
        Where-Object { $_ }
    )

    Add-Check "Ollama" "API" "PASS" ("{0} installed models" -f $installed.Count)

    $missingModels = @($expectedModels | Where-Object { $installed -notcontains $_ })
    if ($missingModels.Count -eq 0) {
        Add-Check "Ollama" "Model inventory" "PASS" ("all {0} expected WCKD models installed" -f $expectedModels.Count)
    }
    else {
        Add-Check "Ollama" "Model inventory" "FAIL" ("Missing: {0}" -f ($missingModels -join ", "))
    }
}
else {
    $installed = @()
    Add-Check "Ollama" "API" "FAIL" "/api/tags unavailable"
    Add-Check "Ollama" "Model inventory" "FAIL" "cannot read installed models"
}

if ($psApi) {
    $runningModels = @(
        $psApi.models |
        ForEach-Object {
            if ($_.name) { [string]$_.name }
            elseif ($_.model) { [string]$_.model }
        } |
        Where-Object { $_ }
    )

    if ($runningModels.Count -le 1) {
        Add-Check "Ollama" "Running models" "PASS" ("single-active policy OK: {0}" -f (Format-ModelList $runningModels))
    }
    else {
        Add-Check "Ollama" "Running models" "FAIL" ("multiple models active: {0}" -f (Format-ModelList $runningModels))
    }
}
else {
    $runningModels = @()
    Add-Check "Ollama" "Running models" "WARN" "/api/ps unavailable"
}

# ============================================================
# AUTO ROUTER
# ============================================================

$router = Get-Json "http://127.0.0.1:8002/health"
$routerState = Get-Json "http://127.0.0.1:8002/router/status"

if ($router) {
    if ([string]$router.version -eq "1.7.0") {
        Add-Check "Router" "Version" "PASS" "v1.7.0"
    }
    else {
        Add-Check "Router" "Version" "WARN" ("expected 1.7.0, got {0}" -f $router.version)
    }

    if ($router.model_manager_integration -eq $true) {
        Add-Check "Router" "MM integration" "PASS" "enabled"
    }
    else {
        Add-Check "Router" "MM integration" "FAIL" "disabled or missing"
    }

    if ($router.model_manager -and $router.model_manager.available -eq $true) {
        Add-Check "Router" "MM reachable" "PASS" ("manager v{0}" -f $router.model_manager.version)
    }
    else {
        $detail = "Model Manager unavailable through router"
        if ($router.model_manager -and $router.model_manager.error) {
            $detail = [string]$router.model_manager.error
        }
        Add-Check "Router" "MM reachable" "FAIL" $detail
    }

    if ($router.specialist_registry_integration -eq $true) {
        Add-Check "Router" "Registry integration" "PASS" "enabled"
    }
    else {
        Add-Check "Router" "Registry integration" "FAIL" "disabled or missing"
    }

    if ($router.specialist_registry -and $router.specialist_registry.available -eq $true) {
        Add-Check "Router" "Registry reachable" "PASS" ("registry v{0}; specialists={1}" -f $router.specialist_registry.version,$router.specialist_registry.specialists_total)
    }
    else {
        $detail = "Specialist Registry unavailable through router"
        if ($router.specialist_registry -and $router.specialist_registry.error) {
            $detail = [string]$router.specialist_registry.error
        }
        Add-Check "Router" "Registry reachable" "FAIL" $detail
    }

    $routerModels = Get-Json "http://127.0.0.1:8002/router/models"

    $routeChecks = @(
        @{ Key="GENERAL";   Expected="qwen3.5:9b" },
        @{ Key="CODE";      Expected="gpt-oss:20b" },
        @{ Key="REASONING"; Expected="gpt-oss:20b" },
        @{ Key="WRITING";   Expected="qwen3.5:9b" },
        @{ Key="TOOLS";     Expected="nemotron-3-nano:4b" },
        @{ Key="AGENTIC";   Expected="qwen3.5:9b" }
    )

    $routeErrors = @()

    if (-not $routerModels) {
        $routeErrors += "/router/models unavailable"
    }
    elseif ($routerModels.specialist_registry_integration -ne $true) {
        $routeErrors += "/router/models is not registry-backed"
    }
    else {
        foreach ($rc in $routeChecks) {
            $actual = $null
            if ($routerModels.automatic) {
                $prop = $routerModels.automatic.PSObject.Properties[$rc.Key]
                if ($prop) {
                    $actual = [string]$prop.Value
                }
            }

            if ($actual -ne $rc.Expected) {
                $routeErrors += ("{0}={1} expected {2}" -f $rc.Key, $actual, $rc.Expected)
            }
        }
    }

    if ($routeErrors.Count -eq 0) {
        Add-Check "Router" "Role map" "PASS" "registry-backed automatic model map matches expected profile"
    }
    else {
        Add-Check "Router" "Role map" "FAIL" ($routeErrors -join "; ")
    }
}
else {
    Add-Check "Router" "Health" "FAIL" "/health unavailable"
}

if ($routerState) {
    Add-Check "Router" "State" "INFO" ("{0} / task={1} / model={2}" -f $routerState.status, $routerState.task, $routerState.active_model)

    if ($routerState.model_manager -and $routerState.model_manager.fallback_direct_ollama -eq $true) {
        Add-Check "Router" "Last MM path" "WARN" "last request used direct-Ollama fallback"
    }
    elseif ($routerState.model_manager) {
        Add-Check "Router" "Last MM path" "PASS" ("action={0}" -f $routerState.model_manager.action)
    }


    if ($routerState.specialist_registry -and $routerState.specialist_registry.fallback_direct_router -eq $true) {
        Add-Check "Router" "Last Registry path" "WARN" "last request used built-in Router fallback"
    }
    elseif ($routerState.specialist_registry -and $routerState.specialist_registry.source -eq "specialist-registry") {
        Add-Check "Router" "Last Registry path" "PASS" ("role={0}; model={1}" -f $routerState.specialist_registry.role,$routerState.specialist_registry.selected_model)
    }
}

# ============================================================
# SPECIALIST REGISTRY
# ============================================================

$registryHealth = Get-Json "http://127.0.0.1:8050/health"
$registryValidate = Get-Json "http://127.0.0.1:8050/validate"

if ($registryHealth) {
    if ([string]$registryHealth.version -eq "1.0.0") {
        Add-Check "Registry" "Version" "PASS" "v1.0.0"
    }
    else {
        Add-Check "Registry" "Version" "WARN" ("expected 1.0.0, got {0}" -f $registryHealth.version)
    }

    if ([string]$registryHealth.status -eq "ok" -and $registryHealth.valid -eq $true) {
        Add-Check "Registry" "Health" "PASS" ("{0} specialists; {1} enabled" -f $registryHealth.specialists_total,$registryHealth.specialists_enabled)
    }
    else {
        Add-Check "Registry" "Health" "FAIL" ("status={0}; valid={1}" -f $registryHealth.status,$registryHealth.valid)
    }
}
else {
    Add-Check "Registry" "Health" "FAIL" "/health unavailable"
}

if ($registryValidate) {
    if ($registryValidate.valid -eq $true) {
        Add-Check "Registry" "Validation" "PASS" ("schema/models valid; installed={0}" -f @($registryValidate.installed_models).Count)
    }
    else {
        $missing = @($registryValidate.missing_model_candidates)
        Add-Check "Registry" "Validation" "FAIL" ("valid=False; missing candidate sets={0}" -f $missing.Count)
    }
}
else {
    Add-Check "Registry" "Validation" "FAIL" "/validate unavailable"
}

# ============================================================
# MODEL MANAGER
# ============================================================

$mmHealth = Get-Json "http://127.0.0.1:8040/health"
$mmStatus = Get-Json "http://127.0.0.1:8040/status"

if ($mmHealth) {
    if ([string]$mmHealth.version -eq "1.0.0") {
        Add-Check "Manager" "Version" "PASS" "v1.0.0"
    }
    else {
        Add-Check "Manager" "Version" "WARN" ("expected 1.0.0, got {0}" -f $mmHealth.version)
    }

    if ([string]$mmHealth.policy -eq "single-active-model") {
        Add-Check "Manager" "Policy" "PASS" "single-active-model"
    }
    else {
        Add-Check "Manager" "Policy" "FAIL" ("unexpected policy: {0}" -f $mmHealth.policy)
    }
}
else {
    Add-Check "Manager" "Health" "FAIL" "/health unavailable"
}

if ($mmStatus) {
    $mmRunning = @(
        $mmStatus.running_models |
        ForEach-Object {
            if ($_.name) { [string]$_.name }
            elseif ($_.model) { [string]$_.model }
        } |
        Where-Object { $_ }
    )

    if ($mmRunning.Count -le 1) {
        Add-Check "Manager" "Runtime policy" "PASS" ("active={0}; running={1}" -f $mmStatus.active_model, (Format-ModelList $mmRunning))
    }
    else {
        Add-Check "Manager" "Runtime policy" "FAIL" ("multiple running models: {0}" -f (Format-ModelList $mmRunning))
    }

    if ($mmRunning.Count -eq 1 -and [string]$mmStatus.active_model -ne [string]$mmRunning[0]) {
        Add-Check "Manager" "Active consistency" "FAIL" ("state={0}; Ollama={1}" -f $mmStatus.active_model, $mmRunning[0])
    }
    elseif ($mmRunning.Count -eq 0 -and $mmStatus.active_model) {
        Add-Check "Manager" "Active consistency" "WARN" ("state says {0} but Ollama has no running model" -f $mmStatus.active_model)
    }
    else {
        Add-Check "Manager" "Active consistency" "PASS" "state matches Ollama runtime"
    }
}

# ============================================================
# AGENT RUNNER
# ============================================================

$agent = Get-Json "http://127.0.0.1:8030/health"

if ($agent) {
    if ([string]$agent.version -eq "1.1.2") {
        Add-Check "Agent" "Version" "PASS" "v1.1.2"
    }
    else {
        Add-Check "Agent" "Version" "WARN" ("expected 1.1.2, got {0}" -f $agent.version)
    }

    $agentFlags = @(
        @{ Name="router"; Value=$agent.router },
        @{ Name="lab"; Value=$agent.lab },
        @{ Name="audit_logs"; Value=$agent.audit_logs },
        @{ Name="completion_governor"; Value=$agent.completion_governor },
        @{ Name="verification_requires_success"; Value=$agent.verification_requires_success },
        @{ Name="disk_backed_job_lookup"; Value=$agent.disk_backed_job_lookup },
        @{ Name="log_api_disk_fallback"; Value=$agent.log_api_disk_fallback }
    )

    $badFlags = @($agentFlags | Where-Object { $_.Value -ne $true } | ForEach-Object { $_.Name })

    if ($badFlags.Count -eq 0) {
        Add-Check "Agent" "Safety features" "PASS" "audit/governor/verification/persistence enabled"
    }
    else {
        Add-Check "Agent" "Safety features" "FAIL" ("disabled/missing: {0}" -f ($badFlags -join ", "))
    }

    if ([string]$agent.route_mode -eq "/agentic" -and [string]$agent.preferred_model -eq "qwen3.5:9b") {
        Add-Check "Agent" "Route profile" "PASS" "/agentic -> qwen3.5:9b"
    }
    else {
        Add-Check "Agent" "Route profile" "FAIL" ("route={0}; model={1}" -f $agent.route_mode, $agent.preferred_model)
    }

    Add-Check "Agent" "Running jobs" "INFO" ([string]$agent.running_jobs)
    $auditRootRaw = [string]$agent.audit_root
    $auditRootPath = $auditRootRaw

    if ($auditRootRaw -and -not [System.IO.Path]::IsPathRooted($auditRootRaw)) {
        $auditRootPath = Join-Path $AiRoot $auditRootRaw
    }

    if ($auditRootRaw -and (Test-Path $auditRootPath)) {
        Add-Check "Agent" "Audit root" "PASS" $auditRootPath
    }
    else {
        Add-Check "Agent" "Audit root" "WARN" ("not accessible: {0}" -f $auditRootPath)
    }
}
else {
    Add-Check "Agent" "Health" "FAIL" "/health unavailable"
}

# ============================================================
# PROJECT MEMORY
# ============================================================

$memoryHealth = Get-Json "http://127.0.0.1:8070/health"

if ($memoryHealth) {
    if ([string]$memoryHealth.version -eq "1.0.0") {
        Add-Check "Memory" "Version" "PASS" "v1.0.0"
    }
    else {
        Add-Check "Memory" "Version" "WARN" ("expected 1.0.0, got {0}" -f $memoryHealth.version)
    }

    if ([string]$memoryHealth.status -eq "ok" -and $memoryHealth.database_ok -eq $true) {
        Add-Check "Memory" "Health" "PASS" ("backend={0}; retrieval={1}" -f $memoryHealth.backend,$memoryHealth.retrieval)
    }
    else {
        Add-Check "Memory" "Health" "FAIL" ("status={0}; database_ok={1}" -f $memoryHealth.status,$memoryHealth.database_ok)
    }

    if ($memoryHealth.project_scoped -eq $true -and $memoryHealth.persistence -eq $true) {
        Add-Check "Memory" "Policy" "PASS" "project-scoped persistent memory"
    }
    else {
        Add-Check "Memory" "Policy" "FAIL" "project scoping or persistence disabled"
    }

    if ($memoryHealth.fts5 -eq $true) {
        Add-Check "Memory" "Retrieval" "PASS" "SQLite FTS5 enabled"
    }
    else {
        Add-Check "Memory" "Retrieval" "WARN" ("fallback retrieval active: {0}" -f $memoryHealth.retrieval)
    }

    Add-Check "Memory" "Inventory" "INFO" ("projects={0}; memories={1}" -f $memoryHealth.projects,$memoryHealth.memories)
}
else {
    Add-Check "Memory" "Health" "FAIL" "/health unavailable"
}

# ============================================================
# ORCHESTRATOR
# ============================================================

$orchHealth = Get-Json "http://127.0.0.1:8060/health"

if ($orchHealth) {
    if ([string]$orchHealth.version -eq "1.2.3") {
        Add-Check "Orchestrator" "Version" "PASS" "v1.2.3"
    }
    else {
        Add-Check "Orchestrator" "Version" "WARN" ("expected 1.2.3, got {0}" -f $orchHealth.version)
    }

    if ([string]$orchHealth.status -eq "ok") {
        Add-Check "Orchestrator" "Health" "PASS" "dependencies healthy"
    }
    else {
        Add-Check "Orchestrator" "Health" "FAIL" ("status={0}" -f $orchHealth.status)
    }

    if ([string]$orchHealth.mode -eq "sequential-single-worker") {
        Add-Check "Orchestrator" "Mode" "PASS" "sequential-single-worker"
    }
    else {
        Add-Check "Orchestrator" "Mode" "WARN" ("unexpected mode: {0}" -f $orchHealth.mode)
    }

    $orchDependencyErrors = @()

    foreach ($dependencyName in @("router","runner","registry","memory")) {
        $dep = $null
        if ($orchHealth.dependencies) {
            $prop = $orchHealth.dependencies.PSObject.Properties[$dependencyName]
            if ($prop) {
                $dep = $prop.Value
            }
        }

        if (-not $dep -or $dep.available -ne $true -or [string]$dep.status -ne "ok") {
            $orchDependencyErrors += $dependencyName
        }
    }

    if ($orchDependencyErrors.Count -eq 0) {
        Add-Check "Orchestrator" "Dependencies" "PASS" "router/runner/registry/memory available"
    }
    else {
        Add-Check "Orchestrator" "Dependencies" "FAIL" ("unhealthy: {0}" -f ($orchDependencyErrors -join ", "))
    }

    if ($orchHealth.persistence -eq $true -and $orchHealth.audit_logs -eq $true) {
        Add-Check "Orchestrator" "Persistence" "PASS" "job persistence and audit logs enabled"
    }
    else {
        Add-Check "Orchestrator" "Persistence" "FAIL" "persistence or audit logging disabled"
    }

    if ($orchHealth.memory_integration -eq $true) {
        Add-Check "Orchestrator" "Memory integration" "PASS" "Project Memory integration enabled"
    }
    else {
        Add-Check "Orchestrator" "Memory integration" "FAIL" "Project Memory integration missing"
    }

    $activeText = if ($orchHealth.active_job_id) { [string]$orchHealth.active_job_id } else { "(none)" }
    Add-Check "Orchestrator" "Queue" "INFO" ("queued={0}; active={1}" -f $orchHealth.queued,$activeText)
}
else {
    Add-Check "Orchestrator" "Health" "FAIL" "/health unavailable"
}

# ============================================================
# WCKD LAB
# ============================================================

$lab = Get-Json "http://127.0.0.1:8020/health"

if ($lab) {
    if ([string]$lab.status -eq "ok") {
        Add-Check "Lab" "Health" "PASS" ("v{0}; distro={1}; root_shell={2}" -f $lab.version, $lab.distro, $lab.root_shell)
    }
    else {
        Add-Check "Lab" "Health" "FAIL" ("status={0}" -f $lab.status)
    }

    if ([string]$lab.version -ne "1.2.0") {
        Add-Check "Lab" "Version" "WARN" ("expected 1.2.2, got {0}" -f $lab.version)
    }
}
else {
    Add-Check "Lab" "Health" "FAIL" "/health unavailable"
}

# WSL distro existence. Registry-first avoids the UTF-16 / capture quirks
# of wsl.exe -l -q under Windows PowerShell 5.1. This is read-only.
$wslNames = @()

$lxssRoot = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss"
if (Test-Path $lxssRoot) {
    $wslNames = @(
        Get-ChildItem $lxssRoot -ErrorAction SilentlyContinue |
        ForEach-Object {
            try {
                [string](Get-ItemProperty $_.PSPath -ErrorAction Stop).DistributionName
            }
            catch {
                $null
            }
        } |
        Where-Object { $_ -and $_.Trim() } |
        ForEach-Object { $_.Trim() }
    )
}

# CLI fallback only when registry enumeration returned nothing.
if ($wslNames.Count -eq 0 -and (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    $rawWsl = @(& wsl.exe --list --quiet 2>$null)
    $wslNames = @(
        $rawWsl |
        ForEach-Object {
            ([string]$_).Replace([char]0,"").Trim()
        } |
        Where-Object { $_ }
    )
}

if ($wslNames -contains "WCKD-LAB") {
    Add-Check "Lab" "WSL distro" "PASS" "WCKD-LAB registered"
}
elseif ($lab -and [string]$lab.distro -eq "WCKD-LAB" -and $lab.root_shell -eq $true) {
    # The live Lab API is stronger evidence than a broken PowerShell capture of
    # wsl.exe output. Keep this as WARN rather than a false hard failure.
    Add-Check "Lab" "WSL distro" "WARN" "Lab API confirms WCKD-LAB, but Windows registration enumeration returned no names"
}
else {
    Add-Check "Lab" "WSL distro" "FAIL" ("WCKD-LAB not found; distros: {0}" -f (Format-ModelList $wslNames))
}

# ============================================================
# GPU / VRAM
# ============================================================

$nvidia = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue

if ($nvidia) {
    $gpuLine = & $nvidia.Source `
        --query-gpu=name,memory.total,memory.used,memory.free `
        --format=csv,noheader,nounits 2>$null |
        Select-Object -First 1

    if ($gpuLine) {
        $parts = @($gpuLine -split "," | ForEach-Object { $_.Trim() })
        if ($parts.Count -ge 4) {
            $gpuName = $parts[0]
            $vramTotal = [int]$parts[1]
            $vramUsed = [int]$parts[2]
            $vramFree = [int]$parts[3]

            Add-Check "GPU" "NVIDIA" "PASS" $gpuName
            Add-Check "GPU" "VRAM" "INFO" ("used {0} MB / free {1} MB / total {2} MB" -f $vramUsed, $vramFree, $vramTotal)

            if ($mmStatus -and $mmStatus.gpu -and $mmStatus.gpu.available -eq $true) {
                $delta = [math]::Abs([int]$mmStatus.gpu.memory_used_mb - $vramUsed)
                if ($delta -le 512) {
                    Add-Check "GPU" "Manager telemetry" "PASS" ("VRAM delta {0} MB vs nvidia-smi" -f $delta)
                }
                else {
                    Add-Check "GPU" "Manager telemetry" "WARN" ("VRAM delta {0} MB vs nvidia-smi" -f $delta)
                }
            }
        }
        else {
            Add-Check "GPU" "NVIDIA" "WARN" ("unexpected nvidia-smi output: {0}" -f $gpuLine)
        }
    }
    else {
        Add-Check "GPU" "NVIDIA" "FAIL" "nvidia-smi returned no data"
    }
}
else {
    Add-Check "GPU" "NVIDIA" "FAIL" "nvidia-smi.exe not found"
}

# ============================================================
# OPEN WEBUI
# ============================================================

if (Test-Port 8080) {
    Add-Check "WebUI" "Open WebUI" "PASS" "port 8080 listening"
}
else {
    Add-Check "WebUI" "Open WebUI" "INFO" "OFF (optional)"
}

# ============================================================
# RECENT LOG ERRORS (NON-FATAL INFORMATION)
# ============================================================

$logFiles = @(
    (Join-Path $AiRoot "logs\launcher-error.log"),
    (Join-Path $AiRoot "logs\router-error.log"),
    (Join-Path $AiRoot "logs\model-manager-error.log"),
    (Join-Path $AiRoot "logs\agent-runner-error.log"),
    (Join-Path $AiRoot "logs\lab-agent-error.log")
)

foreach ($log in $logFiles) {
    if (-not (Test-Path $log)) {
        continue
    }

    $item = Get-Item $log -ErrorAction SilentlyContinue
    $tail = @(Get-Content $log -Tail 20 -ErrorAction SilentlyContinue)
    $interesting = @(
        $tail | Where-Object {
            $_ -match '(?i)\b(error|exception|traceback|failed|fatal)\b'
        }
    )

    if ($interesting.Count -gt 0) {
        $ageMinutes = if ($item) {
            [math]::Round(((Get-Date) - $item.LastWriteTime).TotalMinutes, 1)
        }
        else {
            0
        }

        if ($ageMinutes -le 15) {
            Add-Check "Logs" (Split-Path $log -Leaf) "WARN" ("error-like lines in active/recent log: {0}; file age {1} min" -f $interesting.Count, $ageMinutes)
        }
        elseif ($Detailed) {
            Add-Check "Logs" (Split-Path $log -Leaf) "INFO" ("historical error-like lines: {0}; last write {1} min ago" -f $interesting.Count, $ageMinutes)
        }
    }
    elseif ($Detailed) {
        Add-Check "Logs" (Split-Path $log -Leaf) "PASS" "no error-like lines in last 20"
    }
}

# ============================================================
# SUMMARY
# ============================================================

$passCount = @($script:Checks | Where-Object Status -eq "PASS").Count
$warnCount = @($script:Checks | Where-Object Status -eq "WARN").Count
$failCount = @($script:Checks | Where-Object Status -eq "FAIL").Count
$infoCount = @($script:Checks | Where-Object Status -eq "INFO").Count

$overall = if ($failCount -gt 0) {
    "FAIL"
}
elseif ($warnCount -gt 0) {
    "WARN"
}
else {
    "PASS"
}

if ($Json) {
    [pscustomobject]@{
        doctor_version = $DoctorVersion
        timestamp = $timestamp.ToString("o")
        overall = $overall
        summary = [pscustomobject]@{
            pass = $passCount
            warn = $warnCount
            fail = $failCount
            info = $infoCount
        }
        checks = @($script:Checks)
    } | ConvertTo-Json -Depth 10

    return
}

Write-Host ""
Write-Host ("WCKD DOCTOR v{0}" -f $DoctorVersion) -ForegroundColor Cyan
Write-Host "==================" -ForegroundColor DarkCyan
Write-Host ("Time: {0}" -f $timestamp.ToString("yyyy-MM-dd HH:mm:ss"))
Write-Host ""

$categoryOrder = @(
    "Host","Files","Ports","Optional","Ollama","Router","Registry","Manager",
    "Agent","Memory","Orchestrator","Lab","GPU","WebUI","Logs"
)

foreach ($category in $categoryOrder) {
    $items = @($script:Checks | Where-Object Category -eq $category)
    if ($items.Count -eq 0) {
        continue
    }

    Write-Host ("--- {0} ---" -f $category) -ForegroundColor DarkCyan
    foreach ($check in $items) {
        Write-CheckLine $check
    }
    Write-Host ""
}

$overallColor = switch ($overall) {
    "PASS" { "Green" }
    "WARN" { "Yellow" }
    default { "Red" }
}

Write-Host "==================" -ForegroundColor DarkCyan
Write-Host ("OVERALL: {0}" -f $overall) -ForegroundColor $overallColor
Write-Host ("PASS {0} | WARN {1} | FAIL {2} | INFO {3}" -f $passCount, $warnCount, $failCount, $infoCount)
Write-Host ""

if ($failCount -gt 0) {
    Write-Host "Failures:" -ForegroundColor Red
    $script:Checks |
        Where-Object Status -eq "FAIL" |
        ForEach-Object {
            Write-Host (" - [{0}] {1}: {2}" -f $_.Category, $_.Name, $_.Detail) -ForegroundColor Red
        }
    Write-Host ""
}
elseif ($warnCount -gt 0) {
    Write-Host "Core checks passed; review WARN items above." -ForegroundColor Yellow
    Write-Host ""
}
else {
    Write-Host "WCKD Suite is healthy." -ForegroundColor Green
    Write-Host ""
}
