"""Downloader against a local server that imitates Drive, WeTransfer, Dropbox, OneDrive and login walls."""
from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures"))

from fake_share_sites import PDF_BYTES, FakeShareSites  # noqa: E402

from ess.browser.downloader import download_link  # noqa: E402
from ess.browser.safety import (  # noqa: E402
    blocked_reason,
    filename_from_content_disposition,
    host_matches,
    sanitize_filename,
    sniff_mime,
)


@pytest.fixture(scope="module")
def sites():
    server = FakeShareSites().start()
    yield server
    server.stop()


def _leftovers(folder: Path) -> list[str]:
    return [p.name for p in folder.rglob("*.part")]


# --------------------------------------------------------------------------- safety helpers
def test_safety_helpers():
    assert sanitize_filename("../../etc/passwd") == "passwd"
    assert sanitize_filename('a<b>c:"d|e?.pdf') == "a_b_c__d_e_.pdf"
    assert sanitize_filename("CON.pdf") == "_CON.pdf"
    assert sanitize_filename("  .hidden.pdf. ") == "hidden.pdf"
    assert sanitize_filename("مخطط الطابق.pdf") == "مخطط الطابق.pdf"
    assert len(sanitize_filename("x" * 400 + ".pdf").encode()) <= 180
    assert blocked_reason("drawing.pdf.exe")
    assert blocked_reason("run.PS1")
    assert blocked_reason("plan.pdf", b"MZ\x90\x00")
    assert blocked_reason("plan.pdf", b"%PDF-1.7") is None
    assert filename_from_content_disposition("attachment; filename*=UTF-8''%D8%AA%D9%82.pdf; filename=\"x.pdf\"") == "تق.pdf"
    assert filename_from_content_disposition('attachment; filename="Tender \\"A\\".pdf"') == 'Tender "A".pdf'
    assert host_matches("dl.dropboxusercontent.com", ["*.dropboxusercontent.com"])
    assert host_matches("wetransfer.com", ["wetransfer.com"]) and not host_matches("evilwetransfer.com", ["wetransfer.com"])
    assert sniff_mime(b"PK\x03\x04", "BOQ.xlsx").endswith("spreadsheetml.sheet")
    assert sniff_mime(b"%PDF", "noext") == "application/pdf"


# --------------------------------------------------------------------------- HTTP strategies
async def test_direct_file_with_rfc5987_name(sites, tmp_path):
    result = await download_link(f"{sites.base}/files/report.pdf", "direct_file", tmp_path)
    assert result.status == "ok", result.log
    [f] = result.files
    assert f.name == "تقرير BMU.pdf"
    assert f.sha256 == hashlib.sha256(PDF_BYTES).hexdigest()
    assert f.size == len(PDF_BYTES) and f.mime == "application/pdf"
    assert Path(f.path).read_bytes() == PDF_BYTES
    assert result["status"] == "ok" and f["path"] == f.path  # dict-style access for the pipeline
    # same name again -> unique file name, nothing overwritten
    again = await download_link(f"{sites.base}/files/report.pdf", "direct_file", tmp_path)
    assert again.files[0].name == "تقرير BMU (2).pdf"


async def test_bare_response_gets_extension(sites, tmp_path):
    result = await download_link(f"{sites.base}/files/noname", None, tmp_path)
    assert result.status == "ok"
    assert result.files[0].name == "noname.pdf"


@pytest.mark.parametrize("path", ["/files/setup.exe", "/files/disguised.pdf"])
async def test_executables_are_refused(sites, tmp_path, path):
    result = await download_link(f"{sites.base}{path}", "direct_file", tmp_path)
    assert result.status == "blocked"
    assert not result.files and result.skipped
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("path", ["/files/big.bin", "/files/chunked"])
async def test_max_bytes_is_enforced(sites, tmp_path, path):
    result = await download_link(f"{sites.base}{path}", "direct_file", tmp_path, max_bytes=1024 * 1024)
    assert result.status == "failed"
    assert "limit" in result.error
    assert not result.files and not _leftovers(tmp_path)


async def test_allowed_hosts(sites, tmp_path):
    hits_before = len(sites.hits)
    result = await download_link(f"{sites.base}/files/report.pdf", "direct_file", tmp_path, allowed_hosts=["example.com"])
    assert result.status == "blocked"
    assert "outside the approved hosts" in result.error
    assert len(sites.hits) == hits_before  # the host was never contacted


async def test_drive_file_follows_redirect(sites, tmp_path):
    url = "https://drive.google.com/file/d/SMALLFILE123/view?usp=sharing"
    result = await download_link(url, "google_drive_file", tmp_path, endpoints=sites.endpoints)
    assert result.status == "ok", result.log
    assert result.files[0].name == "Drawing A-101.pdf"
    assert result.final_url.startswith("https://drive.usercontent.google.com/download")


async def test_drive_large_file_confirm_form(sites, tmp_path):
    url = "https://drive.google.com/open?id=LARGEFILE123"
    result = await download_link(url, "google_drive_file", tmp_path, endpoints=sites.endpoints)
    assert result.status == "ok", result.log
    assert result.files[0].name == "Specs.pdf"
    assert any("confirm=t" in hit and "uuid=5f0c-uuid" in hit for hit in sites.hits)
    assert any("confirmation page" in line for line in result.log)


async def test_drive_private_and_deleted(sites, tmp_path):
    private = await download_link("https://drive.google.com/file/d/PRIVATEFILE1/view", "google_drive_file", tmp_path,
                                  endpoints=sites.endpoints)
    assert private.status == "needs_login"
    deleted = await download_link("https://drive.google.com/file/d/DELETEDFILE1/view", "google_drive_file", tmp_path,
                                  endpoints=sites.endpoints)
    assert deleted.status == "expired"


async def test_google_docs_export(sites, tmp_path):
    result = await download_link("https://docs.google.com/document/d/DOCID1234567/edit?usp=sharing", "google_docs",
                                 tmp_path, endpoints=sites.endpoints)
    assert result.status == "ok", result.log
    assert result.files[0].name == "Scope Notes.pdf"
    sheet = await download_link("https://docs.google.com/spreadsheets/d/SHEETID12345/edit#gid=0", "google_docs",
                                tmp_path, endpoints=sites.endpoints)
    assert sheet.files[0].name == "Pricing.xlsx"


async def test_dropbox_forces_dl1_and_keeps_rlkey(sites, tmp_path):
    url = "https://www.dropbox.com/scl/fi/abc123/BOQ.xlsx?rlkey=xyz&dl=0"
    result = await download_link(url, "dropbox", tmp_path, endpoints=sites.endpoints)
    assert result.status == "ok", result.log
    assert result.files[0].name == "BOQ.xlsx"
    gone = await download_link("https://www.dropbox.com/s/gone/old.pdf?dl=0", "dropbox", tmp_path, endpoints=sites.endpoints)
    assert gone.status == "expired"


async def test_onedrive_login_wall_without_browser(sites, tmp_path):
    result = await download_link("https://1drv.ms/b/s!AbCdEf123", "onedrive", tmp_path, endpoints=sites.endpoints)
    assert result.status == "needs_login"
    assert not result.screenshots  # decided over HTTP, no browser needed


async def test_mega_is_unsupported(tmp_path):
    result = await download_link("https://mega.nz/file/AbCd#key", "mega", tmp_path)
    assert result.status == "unsupported"


# --------------------------------------------------------------------------- browser strategies
async def test_wetransfer_ui_flow_own_browser(sites, tmp_path):
    """Cookie banner -> terms dialog -> Download button -> browser download (launches its own Chromium)."""
    result = await download_link("https://we.tl/t-ShortCode1", "wetransfer", tmp_path, endpoints=sites.endpoints,
                                 timeout_s=60)
    assert result.status == "ok", result.log
    [f] = result.files
    assert f.name == "WeTransfer_abc123.zip" and f.mime == "application/zip"
    assert f.sha256 == hashlib.sha256(Path(f.path).read_bytes()).hexdigest()
    log = "\n".join(result.log)
    assert "short link -> https://wetransfer.com/downloads/abc123def456/0123456789ab" in log
    assert "clicked 'Accept all'" in log and "clicked 'I agree'" in log


async def test_browser_strategies_shared_browser(sites, tmp_path):
    from playwright.async_api import async_playwright

    from ess.chromium import launch_chromium

    async with async_playwright() as p:
        browser = await launch_chromium(p, headless=True)
        try:
            # expired transfer -> expired, with evidence
            expired = await download_link("https://wetransfer.com/downloads/e0e0e0e0e0e0/0123456789ab", "wetransfer",
                                          tmp_path / "wt-expired", endpoints=sites.endpoints, browser=browser)
            assert expired.status == "expired", expired.log
            assert expired.screenshots and Path(expired.screenshots[0]).exists()

            # page without a usable button -> public API flow with transfer id + security hash
            api = await download_link("https://wetransfer.com/downloads/a0a0a0a0a0a0/fedcba987654", "wetransfer",
                                      tmp_path / "wt-api", endpoints=sites.endpoints, browser=browser)
            assert api.status == "ok", api.log
            assert api.files[0].name == "direct-api.zip"
            assert sites.api_calls[-1] == {"payload": {"intent": "entire_transfer", "security_hash": "fedcba987654"},
                                           "csrf": "tok-456"}

            # Drive folder via the embedded folder view, nested folder + Google Doc export
            folder = await download_link("https://drive.google.com/drive/folders/FOLDER123456?usp=sharing",
                                         "google_drive_folder", tmp_path / "drive", endpoints=sites.endpoints,
                                         browser=browser)
            assert folder.status == "ok", folder.log
            assert sorted(f.rel_path for f in folder.files) == [
                "Drawing A-101.pdf", "Scope Notes.pdf", "Specs.pdf", "Structural/S-101.pdf"]

            # embedded view lists nothing -> "Download all" zip from the full Drive UI
            zipped = await download_link("https://drive.google.com/drive/folders/EMPTYFOLDER1", "google_drive_folder",
                                         tmp_path / "drive-all", endpoints=sites.endpoints, browser=browser)
            assert zipped.status == "ok", zipped.log
            assert [f.name for f in zipped.files] == ["drive-download-all.zip"]

            # generic page: evidence + obvious document links; the installer link is never even requested
            exe_hits = sites.hits.count("/files/setup.exe")
            other = await download_link(f"{sites.base}/tender/portal", "other", tmp_path / "portal", browser=browser)
            assert other.status == "ok", other.log
            assert [f.name for f in other.files] == ["Specification 11 24 23.pdf"]
            assert sites.hits.count("/files/setup.exe") == exe_hits
            assert other.screenshots and Path(other.screenshots[0]).exists() and other.evidence

            # login wall -> needs_login, never typed into
            wall = await download_link(f"{sites.base}/private/page", "other", tmp_path / "wall", browser=browser)
            assert wall.status == "needs_login"

            # nothing downloadable -> unsupported with evidence
            empty = await download_link(f"{sites.base}/tender/empty", "other", tmp_path / "empty", browser=browser)
            assert empty.status == "unsupported" and empty.screenshots

            # navigation outside allowed hosts is blocked
            blocked = await download_link("https://wetransfer.com/downloads/abc123def456/0123456789ab", "wetransfer",
                                          tmp_path / "blocked", endpoints=sites.endpoints, browser=browser,
                                          allowed_hosts=["dropbox.com"])
            assert blocked.status == "blocked"
        finally:
            await browser.close()
