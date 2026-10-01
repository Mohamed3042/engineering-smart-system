# Engineering Smart System on this PC: sets itself up on the first start, then opens the app in its
# own window. This console runs the app; close it to stop. Started by Start.cmd (double-click).
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$host.UI.RawUI.WindowTitle = "Engineering Smart System - close this window to stop"
$py = Join-Path $root "backend\.venv\Scripts\python.exe"
$uv = Join-Path $env:USERPROFILE ".local\bin\uv.exe"
$data = Join-Path $root "data"
New-Item -ItemType Directory -Force $data | Out-Null
function Step($text) { Write-Host "  $text" -ForegroundColor DarkCyan }

# Python environment and engine (again only when backend/pyproject.toml changes)
if (-not (Test-Path $py)) {
  Step "Creating the Python environment (first start only)"
  if (Test-Path $uv) { & $uv venv backend\.venv -p 3.12 -q } else { py -3.12 -m venv backend\.venv }
}
$stamp = Join-Path $root "backend\.venv\.installed"
if (-not (Test-Path $stamp) -or (Get-Item backend\pyproject.toml).LastWriteTime -gt (Get-Item $stamp).LastWriteTime) {
  Step "Installing the engine"
  if (Test-Path $uv) { & $uv pip install -q --python $py -e "backend[dev]" } else { & $py -m pip install -q -e "backend[dev]" }
  & $py -m playwright install chromium | Out-Null
  New-Item -ItemType File -Force $stamp | Out-Null
}

# Interface: rebuilt when its sources are newer than the last build
$dist = Join-Path $root "frontend\dist\index.html"
$newest = Get-ChildItem frontend\src, frontend\index.html, frontend\package.json -Recurse -File |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not (Test-Path $dist) -or $newest.LastWriteTime -gt (Get-Item $dist).LastWriteTime) {
  Step "Building the interface"
  Push-Location frontend
  if (-not (Test-Path node_modules)) { npm install --silent }
  npm run build --silent
  Pop-Location
}

# Port: chosen on the first start and remembered, so the address (and the MCP endpoint) stays the same
function Free($p) { -not (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) }
$portFile = Join-Path $data "port.txt"
$port = if (Test-Path $portFile) { [int](Get-Content $portFile) } else { 8765..8799 | Where-Object { Free $_ } | Select-Object -First 1 }
$url = "http://127.0.0.1:$port/"
function Healthy { try { (Invoke-WebRequest "$($url)api/health" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { $false } }
$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
function Open-App { if (Test-Path $edge) { Start-Process $edge "--app=$url --window-size=1440,900" } else { Start-Process $url } }

if (Healthy) { Open-App; exit }  # already running: just open another window
if (-not (Free $port)) {  # something else took the port: pick a new one and remember it
  $port = 8765..8799 | Where-Object { Free $_ } | Select-Object -First 1
  $url = "http://127.0.0.1:$port/"
}
Set-Content $portFile $port

$env:ESS_DATA_DIR = $data
$env:ESS_PORT = "$port"
$env:PYTHONUTF8 = "1"
Step "Starting on $url  (MCP endpoint: $($url)mcp/)"
$server = Start-Process -FilePath $py -ArgumentList "-m", "ess.main" -WorkingDirectory (Join-Path $root "backend") -NoNewWindow -PassThru
for ($i = 0; $i -lt 120 -and -not (Healthy); $i++) {
  if ($server.HasExited) { Write-Host "The app stopped while starting. See the messages above." -ForegroundColor Red; Read-Host "Press Enter to close"; exit 1 }
  Start-Sleep -Milliseconds 500
}
Open-App
Write-Host "`n  Engineering Smart System is running at $url" -ForegroundColor Green
Write-Host "  Your data stays in $data. Close this window to stop the app.`n"
$server.WaitForExit()
