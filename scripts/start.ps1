# Engineering Smart System on this PC: sets itself up on the first start, then opens the app in its
# own window. Press Ctrl+C in this console to stop. Started by Start.cmd (double-click).
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$host.UI.RawUI.WindowTitle = "Engineering Smart System - Ctrl+C to stop"
$py = Join-Path $root "backend\.venv\Scripts\python.exe"
$uv = Join-Path $env:USERPROFILE ".local\bin\uv.exe"
$data = Join-Path $root "data"
New-Item -ItemType Directory -Force $data | Out-Null
function Step($text) { Write-Host "  $text" -ForegroundColor DarkCyan }
function Assert-Native($operation) {
  if ($LASTEXITCODE -ne 0) { throw "$operation failed (exit code $LASTEXITCODE). The app was not opened. Fix the error above and start it again." }
}

# Python environment and engine (again only when backend/pyproject.toml changes)
if (-not (Test-Path $py)) {
  Step "Creating the Python environment (first start only)"
  if (Test-Path $uv) { & $uv venv backend\.venv -p 3.12 -q } else { py -3.12 -m venv backend\.venv }
  Assert-Native "Creating the Python environment"
}
$stamp = Join-Path $root "backend\.venv\.installed"
if (-not (Test-Path $stamp) -or (Get-Item backend\pyproject.toml).LastWriteTime -gt (Get-Item $stamp).LastWriteTime) {
  Step "Installing the engine"
  if (Test-Path $uv) { & $uv pip install -q --python $py -e "backend[dev]" } else { & $py -m pip install -q -e "backend[dev]" }
  Assert-Native "Installing the engine"
  & $py -m playwright install chromium | Out-Null
  Assert-Native "Installing the page renderer"
  New-Item -ItemType File -Force $stamp | Out-Null
}

# Interface: rebuilt when its sources are newer than the last build
$dist = Join-Path $root "frontend\dist\index.html"
$newest = Get-ChildItem frontend\src, frontend\index.html, frontend\package.json, frontend\package-lock.json, frontend\vite.config.ts, frontend\tsconfig*.json -Recurse -File |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not (Test-Path $dist) -or $newest.LastWriteTime -gt (Get-Item $dist).LastWriteTime) {
  Step "Building the interface"
  Push-Location frontend
  try {
    if (-not (Test-Path node_modules)) {
      npm.cmd ci --silent
      Assert-Native "Installing interface dependencies"
    }
    npm.cmd run build --silent
    Assert-Native "Building the interface"
  } finally { Pop-Location }
}

Push-Location backend
try {
  $identity = & $py -c "import json; from ess.version import VERSION, get_build_commit; print(json.dumps({'version': VERSION, 'build_commit': get_build_commit()}))"
  Assert-Native "Reading the installed release identity"
  $expected = $identity | ConvertFrom-Json
} finally { Pop-Location }

# Port: chosen on the first start and remembered, so the address (and the MCP endpoint) stays the same
function Free($p) { -not (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) }
$portFile = Join-Path $data "port.txt"
$port = if (Test-Path $portFile) { [int](Get-Content $portFile) } else { 8765..8799 | Where-Object { Free $_ } | Select-Object -First 1 }
$url = "http://127.0.0.1:$port/"
function Read-Health { try { Invoke-RestMethod "$($url)api/health" -TimeoutSec 2 } catch { $null } }
function Healthy {
  $health = Read-Health
  $health -and $health.ok -eq $true -and $health.version -eq $expected.version -and
    ($expected.build_commit -eq "unknown" -or $health.build_commit -eq $expected.build_commit)
}
$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
function Open-App { if (Test-Path $edge) { Start-Process $edge "--app=$url --window-size=1440,900" } else { Start-Process $url } }

$running = Read-Health
if ($running -and $running.ok -eq $true) {
  if (-not (Healthy)) { throw "A different app version is already running at $url. Close its launcher window, then start this version again." }
  Open-App
  exit
}
if (-not (Free $port)) {  # something else took the port: pick a new one and remember it
  $port = 8765..8799 | Where-Object { Free $_ } | Select-Object -First 1
  $url = "http://127.0.0.1:$port/"
}
Set-Content $portFile $port

$env:ESS_DATA_DIR = $data
$env:ESS_PORT = "$port"
$env:PYTHONUTF8 = "1"
Step "Starting on $url  (MCP endpoint: $($url)mcp/)"
$server = Start-Process -FilePath $py -ArgumentList "-m", "ess.main" -WorkingDirectory (Join-Path $root "backend") -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $data "server.stdout.log") -RedirectStandardError (Join-Path $data "server.stderr.log")
try {
  for ($i = 0; $i -lt 120 -and -not (Healthy); $i++) {
    if ($server.HasExited) { throw "The app stopped while starting. Check data\server.stderr.log, then start it again." }
    Start-Sleep -Milliseconds 500
  }
  if (-not (Healthy)) { throw "The app did not become ready. Check data\server.stderr.log, then start it again." }
  Open-App
  Write-Host "`n  Engineering Smart System is running at $url" -ForegroundColor Green
  Write-Host "  Your data stays in $data. Press Ctrl+C here to stop the app.`n"
  while (-not $server.HasExited) { Start-Sleep -Milliseconds 500 }
} finally {
  if (-not $server.HasExited) { Stop-Process -Id $server.Id -ErrorAction SilentlyContinue }
}
if ($server.ExitCode -ne 0) { throw "The app stopped (exit code $($server.ExitCode)). Check data\server.stderr.log." }
