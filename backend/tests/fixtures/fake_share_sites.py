"""A local HTTP server that imitates the file-share sites the downloader talks to.

Start it with ``FakeShareSites().start()``; ``endpoints`` maps the real hosts to it so the
downloader's real URLs (drive.google.com, wetransfer.com, ...) are served locally.
"""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlsplit

PDF_BYTES = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n" + b"0" * 2048
ZIP_BYTES = b"PK\x03\x04" + b"\x00" * 26 + b"fake-zip-payload" * 64

WT_PAGE = """<!doctype html><html><head><meta name="csrf-token" content="tok-123"><title>WeTransfer</title>
<style>#cookie{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10}
#terms{display:none;position:fixed;inset:20%;background:#fff;z-index:9}#dl{display:none}</style></head>
<body><main><h1>Ready when you are</h1><p>3 files, 12.4 MB, expires in 6 days</p>
<button id="dl" onclick="window.location.href='/wt-files/WeTransfer_abc123.zip'">Download</button></main>
<div id="terms"><p>By using WeTransfer you agree to our terms of service.</p>
<button onclick="document.getElementById('terms').style.display='none';document.getElementById('dl').style.display='inline-block'">I agree</button></div>
<div id="cookie"><div style="background:#fff;margin:30%;padding:20px"><p>We use cookies.</p>
<button onclick="document.getElementById('cookie').remove();document.getElementById('terms').style.display='block'">Accept all</button></div></div>
</body></html>"""

WT_EXPIRED = """<!doctype html><html><body><div id="cookie"><button onclick="this.parentNode.remove()">Accept all</button></div>
<h1>This transfer expired</h1><p>Transfers are available for 7 days. Ask the sender to send it again.</p></body></html>"""

WT_API_PAGE = """<!doctype html><html><head><meta name="csrf-token" content="tok-456"></head>
<body><div id="app"><p>Loading your transfer…</p></div></body></html>"""

DRIVE_CONFIRM = """<!DOCTYPE html><html><head><title>Google Drive - Virus scan warning</title></head><body>
<p>Google Drive can't scan this file for viruses.</p><p>Specs.pdf (128M) is too large for Google to scan for viruses.
Would you still like to download this file?</p>
<form id="download-form" action="https://drive.usercontent.google.com/download" method="get">
<input type="submit" id="uc-download-link" value="Download anyway"/>
<input type="hidden" name="id" value="LARGEFILE123"><input type="hidden" name="export" value="download">
<input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="5f0c-uuid"></form></body></html>"""

DRIVE_MISSING = """<html><body><p>Sorry, the file you have requested does not exist.</p>
<p>Make sure that you have the correct URL and that the file exists.</p></body></html>"""


def _entry(kind: str, ident: str, title: str) -> str:
    href = {
        "file": f"https://drive.google.com/file/d/{ident}/view?usp=drive_web",
        "folder": f"https://drive.google.com/drive/folders/{ident}",
        "docs": f"https://docs.google.com/document/d/{ident}/edit?usp=drive_web",
    }[kind]
    return (f'<div class="flip-entry" id="entry-{ident}" tabindex="0" role="link"><div class="flip-entry-info">'
            f'<a href="{href}" target="_blank"><div class="flip-entry-list-icon"></div>'
            f'<div class="flip-entry-title">{title}</div></a></div>'
            f'<div class="flip-entry-last-modified"><div>Aug 26</div></div></div>')


FOLDERS = {
    "FOLDER123456": [("file", "SMALLFILE123", "Drawing A-101.pdf"), ("file", "LARGEFILE123", "Specs.pdf"),
                     ("folder", "SUBFOLDER123", "Structural"), ("docs", "DOCID1234567", "Scope Notes")],
    "SUBFOLDER123": [("file", "SUBFILE12345", "S-101.pdf")],
    "EMPTYFOLDER1": [],
}
DRIVE_FILES = {"SMALLFILE123": "Drawing A-101.pdf", "LARGEFILE123": "Specs.pdf", "SUBFILE12345": "S-101.pdf"}


class _Handler(BaseHTTPRequestHandler):
    server_version = "FakeShare/1.0"

    def log_message(self, *args):  # keep test output quiet
        pass

    # ---- helpers
    def _send(self, status: int, body: bytes | str, ctype: str = "text/html; charset=utf-8", headers: dict | None = None):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _file(self, name: str, data: bytes, ctype: str = "application/pdf", rfc5987: bool = False):
        disposition = (f"attachment; filename*=UTF-8''{quote(name)}" if rfc5987
                       else f'attachment; filename="{name}"')
        self._send(200, data, ctype, {"Content-Disposition": disposition})

    def _redirect(self, location: str, status: int = 302):
        self.send_response(status)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---- routes
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):  # noqa: C901 - a router
        parts = urlsplit(self.path)
        path, q = parts.path, {k: v[0] for k, v in parse_qs(parts.query).items()}
        self.server.hits.append(self.path)
        # direct files
        if path == "/files/report.pdf":
            return self._file("تقرير BMU.pdf", PDF_BYTES, rfc5987=True)
        if path == "/files/spec.pdf":
            return self._file("Specification 11 24 23.pdf", PDF_BYTES)
        if path == "/files/setup.exe":
            return self._file("setup.exe", b"MZ\x90\x00" + b"\x00" * 100, "application/octet-stream")
        if path == "/files/disguised.pdf":
            return self._send(200, b"MZ\x90\x00" + b"\x00" * 100, "application/pdf")
        if path == "/files/big.bin":
            return self._file("big.zip", b"PK\x03\x04" + b"\x00" * (3 * 1024 * 1024), "application/zip")
        if path == "/files/chunked":
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Disposition", 'attachment; filename="stream.zip"')
            self.end_headers()  # no Content-Length: the size limit must be enforced while streaming
            self.wfile.write(b"PK\x03\x04")
            for _ in range(48):
                self.wfile.write(b"\x00" * 65536)
            return
        if path == "/files/noname":
            return self._send(200, PDF_BYTES, "application/pdf")
        # Google Drive
        if path == "/uc":
            fid = q.get("id", "")
            if fid == "PRIVATEFILE1":
                return self._redirect("https://accounts.google.com/ServiceLogin?continue=https://drive.google.com/uc")
            if fid == "DELETEDFILE1":
                return self._send(404, DRIVE_MISSING)
            if fid == "LARGEFILE123":
                return self._send(200, DRIVE_CONFIRM)
            if fid in DRIVE_FILES:
                return self._redirect(f"https://drive.usercontent.google.com/download?id={fid}&export=download", 303)
            return self._send(404, DRIVE_MISSING)
        if path == "/download":
            fid = q.get("id", "")
            if fid == "LARGEFILE123" and q.get("confirm") != "t":
                return self._send(200, DRIVE_CONFIRM)
            if fid in DRIVE_FILES:
                return self._file(DRIVE_FILES[fid], PDF_BYTES)
            return self._send(404, DRIVE_MISSING)
        if path == "/embeddedfolderview":
            fid = q.get("id", "")
            if fid not in FOLDERS:
                return self._send(404, DRIVE_MISSING)
            entries = "".join(_entry(*e) for e in FOLDERS[fid])
            return self._send(200, f"<html><body><div class='flip-entries'>{entries}</div></body></html>")
        if path == "/drive/folders/EMPTYFOLDER1":  # the full Drive UI with its "Download all" button
            return self._send(200, "<html><body><h2>Tender drawings</h2><div role='toolbar'>"
                                   "<button aria-label='Download all' onclick=\"location.href='/wt-files/"
                                   "drive-download-all.zip'\">Download all</button></div></body></html>")
        if path.startswith("/document/d/DOCID1234567/export"):
            return self._file("Scope Notes.pdf", PDF_BYTES)
        if path.startswith("/spreadsheets/d/SHEETID12345/export"):
            return self._file("Pricing.xlsx", ZIP_BYTES,
                              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        # WeTransfer
        if path == "/t-ShortCode1":
            return self._redirect("https://wetransfer.com/downloads/abc123def456/0123456789ab")
        if path == "/downloads/abc123def456/0123456789ab":
            return self._send(200, WT_PAGE)
        if path.startswith("/downloads/e0e0e0e0e0e0/"):
            return self._send(200, WT_EXPIRED)
        if path == "/downloads/a0a0a0a0a0a0/fedcba987654":
            return self._send(200, WT_API_PAGE)
        if path.startswith("/wt-files/"):
            return self._file(path.rsplit("/", 1)[-1], ZIP_BYTES, "application/zip")
        # Dropbox
        if path == "/scl/fi/abc123/BOQ.xlsx":
            if q.get("dl") == "1" and q.get("rlkey") == "xyz":
                return self._file("BOQ.xlsx", ZIP_BYTES, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            return self._send(200, "<html><body>Dropbox preview</body></html>")
        if path == "/s/gone/old.pdf":
            return self._send(404, "<html><body>This item was deleted</body></html>")
        # OneDrive / login walls
        if path.startswith("/b/s!"):
            return self._redirect("https://login.live.com/login.srf?wa=wsignin1.0")
        if path.startswith("/v1.0/shares/"):
            return self._send(401, '{"error":{"code":"unauthenticated"}}', "application/json")
        if path == "/private/page":
            return self._send(200, "<html><body><h1>Sign in to continue</h1><form>"
                                   "<input name='email'><input type='password' name='pw'><button>Sign in</button>"
                                   "</form></body></html>")
        if path == "/tender/portal":
            return self._send(200, "<html><body><h1>Tender 118 documents</h1>"
                                   "<a href='/files/spec.pdf'>Specification</a> <a href='/about'>About us</a>"
                                   "<a href='/files/setup.exe'>Viewer installer</a></body></html>")
        if path == "/tender/empty":
            return self._send(200, "<html><body><h1>Nothing to see</h1><a href='/about'>About</a></body></html>")
        return self._send(404, "<html><body>not found</body></html>")

    def do_POST(self):
        parts = urlsplit(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        self.server.hits.append("POST " + self.path)
        if parts.path == "/api/v4/transfers/a0a0a0a0a0a0/download":
            payload = json.loads(body or b"{}")
            self.server.api_calls.append({"payload": payload, "csrf": self.headers.get("x-csrf-token")})
            if payload.get("security_hash") != "fedcba987654":
                return self._send(403, '{"error":"invalid security hash"}', "application/json")
            base = f"http://127.0.0.1:{self.server.server_address[1]}"
            return self._send(200, json.dumps({"direct_link": f"{base}/wt-files/direct-api.zip"}), "application/json")
        return self._send(404, "{}", "application/json")


class _QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        pass  # the downloader aborts oversized streams on purpose; don't print the broken pipe


class FakeShareSites:
    def __init__(self) -> None:
        self.server = _QuietServer(("127.0.0.1", 0), _Handler)
        self.server.hits = []
        self.server.api_calls = []
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    @property
    def endpoints(self) -> dict[str, str]:
        hosts = ("drive.google.com", "drive.usercontent.google.com", "docs.google.com", "wetransfer.com", "we.tl",
                 "dropbox.com", "www.dropbox.com", "1drv.ms", "api.onedrive.com")
        return {h: self.base for h in hosts}

    @property
    def hits(self) -> list[str]:
        return self.server.hits

    @property
    def api_calls(self) -> list[dict]:
        return self.server.api_calls

    def start(self) -> "FakeShareSites":
        self.thread.start()
        return self

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()
