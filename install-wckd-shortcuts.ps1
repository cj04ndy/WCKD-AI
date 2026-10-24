# WCKD portable PowerShell shortcut installer

$WckdRoot = $PSScriptRoot
$CoreRoot = Join-Path $WckdRoot "CORE"
$ShellFile = Join-Path $CoreRoot "wckd-shell.ps1"

if (-not (Test-Path $ShellFile)) {
    throw "Missing WCKD shell: $ShellFile"
}

# Persist installation location for the current user
[Environment]::SetEnvironmentVariable("WCKD_HOME", $WckdRoot, "User")
$env:WCKD_HOME = $WckdRoot

$ProfilePath = $PROFILE.CurrentUserCurrentHost
$ProfileDir = Split-Path $ProfilePath -Parent

if (-not (Test-Path $ProfileDir)) {
    New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null
}

# Backup existing PowerShell profile
if (Test-Path $ProfilePath) {
    $Backup = "$ProfilePath.wckd-backup-$(Get-Date -Format yyyyMMdd-HHmmss)"
    Copy-Item $ProfilePath $Backup -Force
    Write-Host "Profile backup: $Backup" -ForegroundColor DarkGray
}

# Portable WCKD loader
$ProfileLines = @(
    "# >>> WCKD PORTABLE LOADER >>>",
    '$WckdHome = [Environment]::GetEnvironmentVariable("WCKD_HOME", "User")',
    'if (-not [string]::IsNullOrWhiteSpace($WckdHome)) {',
    '    $WckdShell = Join-Path $WckdHome "CORE\wckd-shell.ps1"',
    '    if (Test-Path $WckdShell) {',
    '        . $WckdShell',
    '    }',
    '}',
    "# <<< WCKD PORTABLE LOADER <<<"
)

$ProfileLines | Set-Content $ProfilePath -Encoding UTF8

# Load immediately in installer process
. $ShellFile

Write-Host ""
Write-Host "WCKD portable shortcuts installed." -ForegroundColor Green
Write-Host "WCKD_HOME = $WckdRoot" -ForegroundColor Cyan
Write-Host "Profile   = $ProfilePath" -ForegroundColor Cyan
Write-Host ""

Get-Command start-wckd-suite,kill-wckd-suite,wckd-root |
    Select-Object Name,CommandType |
    Format-Table -AutoSize
