# ──────────────────────────────────────────────────────────────────────
# Grok Agent — Native Messaging Host installer for Windows
# Run as Administrator (right-click → Run as administrator)
# ──────────────────────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$HostName   = "com.grok.agent"
$HostScript = Join-Path $ScriptDir "grok_agent_host.py"

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Grok Agent - Native Host Installer"         -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# ── Locate Python ────────────────────────────────────────────────────

$Python = $null
foreach ($name in @("python3", "python")) {
    $found = Get-Command $name -ErrorAction SilentlyContinue
    if ($found) { $Python = $found; break }
}
if (-not $Python) {
    Write-Host "ERROR: Python 3 is required but was not found in PATH." -ForegroundColor Red
    exit 1
}
$PythonPath = $Python.Source
Write-Host "Python found: $PythonPath"

# ── Create batch wrapper ─────────────────────────────────────────────
# Chrome on Windows requires an executable (not a .py), so we wrap it.

$BatWrapper = Join-Path $ScriptDir "grok_agent_host.bat"
@"
@echo off
"$PythonPath" "$HostScript" %*
"@ | Set-Content -Path $BatWrapper -Encoding ASCII

Write-Host "Batch wrapper: $BatWrapper"
Write-Host ""

# ── Collect extension ID ─────────────────────────────────────────────

Write-Host "Load the extension first, then find its ID at:"
Write-Host "  chrome://extensions  or  edge://extensions"
Write-Host ""
$ExtId = Read-Host "Extension ID (leave blank to allow all origins)"

if ([string]::IsNullOrWhiteSpace($ExtId)) {
    $AllowedOrigin = "chrome-extension://*/"
    Write-Host ""
    Write-Host "NOTE: Allowing all extension origins." -ForegroundColor Yellow
    Write-Host "      Re-run with a specific ID for better security."
} else {
    $AllowedOrigin = "chrome-extension://$ExtId/"
}

# ── Write manifest JSON ──────────────────────────────────────────────

$ManifestDir = Join-Path $ScriptDir "manifests"
New-Item -ItemType Directory -Force -Path $ManifestDir | Out-Null

$ManifestPath = Join-Path $ManifestDir "$HostName.json"
$EscapedBat   = $BatWrapper -replace '\\', '\\'

$ManifestJson = @"
{
  "name": "$HostName",
  "description": "Grok Agent Native Messaging Host",
  "path": "$EscapedBat",
  "type": "stdio",
  "allowed_origins": ["$AllowedOrigin"]
}
"@

$ManifestJson | Set-Content -Path $ManifestPath -Encoding UTF8
Write-Host "Manifest written: $ManifestPath"

# ── Register in Windows registry ─────────────────────────────────────

$RegPaths = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
)

foreach ($RegPath in $RegPaths) {
    $Parent = Split-Path $RegPath
    if (-not (Test-Path $Parent)) {
        New-Item -Path $Parent -Force | Out-Null
    }
    New-Item -Path $RegPath -Force | Out-Null
    Set-ItemProperty -Path $RegPath -Name "(Default)" -Value $ManifestPath
    Write-Host "  Registered -> $RegPath" -ForegroundColor Green
}

Write-Host ""
Write-Host "Installation complete." -ForegroundColor Green
Write-Host "Restart your browser, then click 'Test Connection' in the extension popup."
