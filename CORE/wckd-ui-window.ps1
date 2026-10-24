param(
    [switch]$ResetState
)

$ErrorActionPreference = "Stop"

$StateFile = Join-Path $PSScriptRoot "wckd-ui-state.json"
$LogFile   = Join-Path $PSScriptRoot "logs\wckd-ui-window.log"
$Shortcut = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Brave Apps\WCKD AI (Open WebUI).lnk"

New-Item -ItemType Directory -Force -Path (Split-Path $LogFile -Parent) | Out-Null

function Write-WckdUiLog {
    param([string]$Message)
    Add-Content -Path $LogFile -Value ("{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message) -Encoding UTF8
}

try {
    Write-WckdUiLog "Launcher started."

    if (-not (Test-Path $Shortcut)) {
        throw "WCKD AI Brave App shortcut not found: $Shortcut"
    }

    if ($ResetState) {
        Remove-Item $StateFile -Force -ErrorAction SilentlyContinue
        Write-WckdUiLog "Saved state removed."
        Write-Host "WCKD UI saved window state removed." -ForegroundColor Yellow
        exit 0
    }

    if (-not ("WckdWindow.NativeMethods" -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace WckdWindow {
    public static class NativeMethods {
        [StructLayout(LayoutKind.Sequential)]
        public struct RECT {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool IsZoomed(IntPtr hWnd);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetWindowPos(
            IntPtr hWnd,
            IntPtr hWndInsertAfter,
            int X,
            int Y,
            int cx,
            int cy,
            uint uFlags
        );

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetForegroundWindow(IntPtr hWnd);
    }
}
'@
    }

    function Get-WckdUiProcess {
        $matches = Get-Process brave -ErrorAction SilentlyContinue |
            Where-Object {
                $_.MainWindowHandle -ne 0 -and
                (
                    $_.MainWindowTitle -like "*WCKD AI*" -or
                    $_.MainWindowTitle -like "*Open WebUI*"
                )
            } |
            Sort-Object StartTime -Descending

        return ($matches | Select-Object -First 1)
    }

    function Get-WckdWindowState {
        param([Parameter(Mandatory=$true)][IntPtr]$Handle)

        $rect = New-Object WckdWindow.NativeMethods+RECT
        if (-not [WckdWindow.NativeMethods]::GetWindowRect($Handle, [ref]$rect)) {
            return $null
        }

        [pscustomobject]@{
            X         = [int]$rect.Left
            Y         = [int]$rect.Top
            Width     = [int]($rect.Right - $rect.Left)
            Height    = [int]($rect.Bottom - $rect.Top)
            Maximized = [bool][WckdWindow.NativeMethods]::IsZoomed($Handle)
            SavedAt   = (Get-Date).ToString("o")
        }
    }

    function Set-WckdWindowState {
        param(
            [Parameter(Mandatory=$true)][IntPtr]$Handle,
            [Parameter(Mandatory=$true)]$State
        )

        $SW_RESTORE     = 9
        $SW_MAXIMIZE    = 3
        $SWP_NOZORDER   = 0x0004
        $SWP_NOACTIVATE = 0x0010

        [void][WckdWindow.NativeMethods]::ShowWindow($Handle, $SW_RESTORE)

        [void][WckdWindow.NativeMethods]::SetWindowPos(
            $Handle,
            [IntPtr]::Zero,
            [int]$State.X,
            [int]$State.Y,
            [int]$State.Width,
            [int]$State.Height,
            ($SWP_NOZORDER -bor $SWP_NOACTIVATE)
        )

        if ([bool]$State.Maximized) {
            [void][WckdWindow.NativeMethods]::ShowWindow($Handle, $SW_MAXIMIZE)
        }

        [void][WckdWindow.NativeMethods]::SetForegroundWindow($Handle)
    }

    function Start-WckdBraveApp {
        $shell = New-Object -ComObject WScript.Shell
        $link  = $shell.CreateShortcut($Shortcut)

        $target = $link.TargetPath
        $args   = $link.Arguments
        $work   = $link.WorkingDirectory

        if (-not $target -or -not (Test-Path $target)) {
            throw "Brave target from shortcut is invalid: $target"
        }

        Write-WckdUiLog "Launching target: $target"
        Write-WckdUiLog "Arguments: $args"

        $params = @{
            FilePath     = $target
            ArgumentList = $args
        }

        if ($work -and (Test-Path $work)) {
            $params.WorkingDirectory = $work
        }

        Start-Process @params | Out-Null
    }

    $process = Get-WckdUiProcess

    if (-not $process) {
        Start-WckdBraveApp

        $deadline = (Get-Date).AddSeconds(20)
        do {
            Start-Sleep -Milliseconds 300
            $process = Get-WckdUiProcess
        } until ($process -or (Get-Date) -ge $deadline)
    }

    if (-not $process) {
        throw "WCKD AI window was not found within 20 seconds after launch."
    }

    $hWnd = [IntPtr]$process.MainWindowHandle
    Write-WckdUiLog ("Window found: {0}" -f $process.MainWindowTitle)

    if (Test-Path $StateFile) {
        try {
            $saved = Get-Content $StateFile -Raw | ConvertFrom-Json

            if ($saved.Width -gt 100 -and $saved.Height -gt 100) {
                Set-WckdWindowState -Handle $hWnd -State $saved
                Write-WckdUiLog ("Restored state X={0} Y={1} W={2} H={3} Maximized={4}" -f $saved.X, $saved.Y, $saved.Width, $saved.Height, $saved.Maximized)
            }
        }
        catch {
            Write-WckdUiLog ("State restore failed: {0}" -f $_.Exception.Message)
        }
    }
    else {
        [void][WckdWindow.NativeMethods]::SetForegroundWindow($hWnd)
        Write-WckdUiLog "No saved state yet. Move/resize the app and close it normally."
    }

    $lastGood = Get-WckdWindowState -Handle $hWnd

    while ([WckdWindow.NativeMethods]::IsWindow($hWnd)) {
        if (-not [WckdWindow.NativeMethods]::IsIconic($hWnd)) {
            $current = Get-WckdWindowState -Handle $hWnd
            if ($current -and $current.Width -gt 100 -and $current.Height -gt 100) {
                $lastGood = $current
            }
        }

        Start-Sleep -Milliseconds 500
    }

    if ($lastGood) {
        $lastGood | ConvertTo-Json | Set-Content -Path $StateFile -Encoding UTF8
        Write-WckdUiLog ("Saved state X={0} Y={1} W={2} H={3} Maximized={4}" -f $lastGood.X, $lastGood.Y, $lastGood.Width, $lastGood.Height, $lastGood.Maximized)
    }

    Write-WckdUiLog "Launcher finished."
}
catch {
    Write-WckdUiLog ("ERROR: {0}" -f $_.Exception.ToString())
    exit 1
}
