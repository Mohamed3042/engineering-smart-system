#!/usr/bin/env bash
# One-command start: creates the Python environment, installs the browser, builds the UI when
# present, and opens the app on http://127.0.0.1:8765
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
PY="${PYTHON:-python3}"

if [ ! -x backend/.venv/bin/python ]; then
  echo "• Creating Python environment"
  if command -v uv >/dev/null 2>&1; then uv venv backend/.venv -p 3.11 -q; else "$PY" -m venv backend/.venv; fi
fi
if command -v uv >/dev/null 2>&1; then
  uv pip install -q --python backend/.venv/bin/python -e "backend[dev]"
else
  backend/.venv/bin/pip install -q -e "backend[dev]"
fi
backend/.venv/bin/python -c "import playwright" && { backend/.venv/bin/python -m playwright install chromium >/dev/null 2>&1 || echo "! Chromium download skipped (set ESS_CHROMIUM_PATH if you have Chrome)"; }

if [ -f frontend/package.json ] && command -v npm >/dev/null 2>&1; then
  echo "• Building the interface"
  (cd frontend && npm install --silent && npm run build --silent) \
    || echo "! Interface build failed (see docs/HANDOFF.md); the API and MCP endpoint still start"
fi

if [ -d ../medmack-quotation-builder/app/assets ] && [ ! -f data/private/letterhead/header.jpg ]; then
  echo "• Importing company letterhead from ../medmack-quotation-builder (stays in data/private, never committed)"
  backend/.venv/bin/python scripts/import_letterhead.py || true
fi

export ESS_DATA_DIR="${ESS_DATA_DIR:-$ROOT/data}"
echo "• Starting on http://${ESS_HOST:-127.0.0.1}:${ESS_PORT:-8765}  (MCP endpoint: /mcp/)"
cd backend && exec .venv/bin/python -m ess.main
