"""Bundled engine entry point. All runtime paths are relative to this app bundle."""
from __future__ import annotations

import atexit
import fcntl
import json
import os
from pathlib import Path
import signal
import socket
import sys
import threading
import time

RESOURCES = Path(__file__).resolve().parent
DATA = Path(os.environ["ESS_DATA_DIR"])
DATA.mkdir(parents=True, exist_ok=True)
os.umask(0o077)
sys.path.insert(0, str(RESOURCES / "backend"))
os.environ["ESS_FRONTEND_DIST"] = str(RESOURCES / "frontend")
os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(RESOURCES / "browsers")
browsers = list((RESOURCES / "browsers").glob("chromium-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"))
if not browsers:
    raise RuntimeError("The bundled document-rendering browser is missing.")
os.environ["ESS_CHROMIUM_PATH"] = str(browsers[0])
release = json.loads((RESOURCES / "release.json").read_text())


def available(port):
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def verify_runtime():
    """Acceptance command for the actual bundled interpreter, libraries and renderer."""
    import asyncio
    import certifi
    import cryptography
    import pypdf
    import pypdfium2
    import sqlmodel
    from ess.quotation import LetterheadAssets, default_quotation, render_quotation_pdf
    from ess.main import app
    from ess.db import init_db
    init_db()
    quotation = default_quotation("tenders", "en", None, None, None)
    quotation.update({"reference": "LOCAL/26/0001", "project_name": "Bundled runtime acceptance",
                      "status": "draft", "items": [], "to": {"company": "Example Company"}})
    assets = LetterheadAssets.load(DATA / "private", "Example Engineering", None)
    pdf = asyncio.run(render_quotation_pdf(quotation, {"company_name": "Example Engineering"}, None, assets, DATA / "runtime-check.pdf"))
    reader = pypdf.PdfReader(str(pdf))
    assert len(reader.pages) >= 1 and "LOCAL/26/0001" in "".join(p.extract_text() for p in reader.pages)
    assert str(RESOURCES / "python") in sys.executable
    assert Path(certifi.where()).is_relative_to(RESOURCES)
    external_modules = {name: str(module.__file__) for name, module in list(sys.modules.items())
                        if getattr(module, "__file__", None) and str(module.__file__).startswith("/")
                        and not Path(module.__file__).resolve().is_relative_to(RESOURCES)}
    assert not external_modules, external_modules
    print(json.dumps({"ok": True, "version": release["version"], "commit": release["commit"],
                      "python": sys.executable, "browser": str(browsers[0]),
                      "pdf_pages": len(reader.pages), "external_python_modules": external_modules,
                      "database_created": (DATA / "ess.sqlite3").is_file()}))


def run():
    lock = (DATA / ".native-engine.lock").open("a")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise RuntimeError("Engineering Smart System is already open for this workspace.")
    preferred = 8765
    try:
        preferred = int((DATA / "port.txt").read_text())
    except (OSError, ValueError):
        pass
    preferred = int(os.environ.get("ESS_DESKTOP_PORT", preferred))
    port = next((p for p in [preferred, *range(8765, 8800)] if 1024 <= p <= 65535 and available(p)), None)
    if port is None:
        raise RuntimeError("No local workspace port is available.")
    os.environ["ESS_PORT"] = str(port)
    os.environ["ESS_HOST"] = "127.0.0.1"
    os.environ["SSL_CERT_FILE"] = str(RESOURCES / "python/lib/python3.12/site-packages/certifi/cacert.pem")
    (DATA / "port.txt").write_text(str(port) + "\n")
    receipt = DATA / "desktop-runtime.json"
    receipt.write_text(json.dumps({"pid": os.getpid(), "port": port, "launch_id": os.environ["ESS_LAUNCH_ID"],
                                   "version": release["version"], "commit": release["commit"]}))
    atexit.register(lambda: receipt.unlink(missing_ok=True))
    parent = os.getppid()

    def watch_parent():
        while True:
            time.sleep(1)
            if os.getppid() != parent:
                os.kill(os.getpid(), signal.SIGTERM)
                return

    threading.Thread(target=watch_parent, daemon=True).start()
    import uvicorn
    from ess.main import app
    app.state.build_commit = release["commit"]
    app.state.desktop_build = release["desktop_build"]
    uvicorn.run(app, host="127.0.0.1", port=port, reload=False)


if __name__ == "__main__":
    if "--verify-runtime" in sys.argv:
        verify_runtime()
    else:
        run()
