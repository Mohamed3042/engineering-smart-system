#!/usr/bin/env bash
# One-command start: creates the Python environment, installs the browser, builds the UI when
# present, and opens the app on http://127.0.0.1:8765  (macOS, Linux, and Git Bash on Windows)
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
PY="${PYTHON:-python3}"
export PATH="$HOME/.local/bin:$PATH"  # where the uv installer puts uv

# The environment's interpreter: bin/python on macOS/Linux, Scripts/python.exe on Windows.
venv_py() { if [ -f backend/.venv/Scripts/python.exe ]; then echo backend/.venv/Scripts/python.exe; else echo backend/.venv/bin/python; fi; }

if [ ! -f "$(venv_py)" ]; then
  echo "• Creating Python environment"
  if command -v uv >/dev/null 2>&1; then uv venv backend/.venv -p 3.11 -q; else "$PY" -m venv backend/.venv; fi
fi
VPY="$(venv_py)"
if command -v uv >/dev/null 2>&1; then
  uv pip install -q --python "$VPY" -e "backend[dev]"
else
  "$VPY" -m pip install -q -e "backend[dev]"
fi
"$VPY" -c "import playwright" && { "$VPY" -m playwright install chromium >/dev/null 2>&1 || echo "! Chromium download skipped (set ESS_CHROMIUM_PATH if you have Chrome)"; }

if [ -f frontend/package.json ] && command -v npm >/dev/null 2>&1; then
  echo "• Building the interface"
  (cd frontend && npm install --silent && npm run build --silent) \
    || echo "! Interface build failed (see docs/HANDOFF.md); the API and MCP endpoint still start"
fi

if [ -d ../medmack-quotation-builder/app/assets ] && [ ! -f data/private/letterhead/header.jpg ]; then
  echo "• Importing company letterhead from ../medmack-quotation-builder (stays in data/private, never committed)"
  "$VPY" scripts/import_letterhead.py || true
fi

export ESS_DATA_DIR="${ESS_DATA_DIR:-$ROOT/data}"
export PYTHONUTF8=1
echo "• Starting on http://${ESS_HOST:-127.0.0.1}:${ESS_PORT:-8765}  (MCP endpoint: /mcp/)"
cd backend && exec "../$VPY" -m ess.main
