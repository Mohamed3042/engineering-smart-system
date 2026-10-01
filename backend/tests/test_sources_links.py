"""Link extraction: kinds, unwrapping, normalisation, dedupe and junk filtering on realistic URLs."""
from __future__ import annotations

import pytest

from ess.sources.links import classify_link, drive_id_from_url, drive_resource_key, extract_links, normalize_url

KIND_CASES = [
    # (text as it appears in a mail, expected kind, expected normalised url or None to skip the check)
    ("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUv/view?usp=sharing", "google_drive_file", None),
    ("https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp_", "google_drive_file",
     "https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp_"),
    ("https://drive.google.com/uc?export=download&id=1ZyXwVuTsRqPoNmLk", "google_drive_file", None),
    ("https://drive.google.com/drive/folders/1FolderIdAbCdEfGh?usp=sharing", "google_drive_folder", None),
    ("https://drive.google.com/drive/u/1/folders/1FolderIdXyZ12345", "google_drive_folder", None),
    ("https://docs.google.com/spreadsheets/d/1SheetIdAbCdEfGhIj/edit#gid=0", "google_docs", None),
    ("https://docs.google.com/document/d/1DocIdAbCdEfGhIjK/edit?usp=sharing", "google_docs", None),
    ("https://we.tl/t-AbCdEf1234", "wetransfer", "https://we.tl/t-AbCdEf1234"),
    ("https://wetransfer.com/downloads/4a5b6c7d8e9f0a1b2c3d/1a2b3c4d5e6f/abc123", "wetransfer", None),
    ("https://medmack.wetransfer.com/downloads/4a5b6c7d8e9f/abc123", "wetransfer", None),
    ("https://www.dropbox.com/scl/fi/abc123def/BOQ.xlsx?rlkey=xyz&dl=0", "dropbox", None),
    ("https://www.dropbox.com/sh/abc123/AADxyz?dl=0", "dropbox", None),
    ("https://1drv.ms/f/s!AbCdEfGhIj", "onedrive", None),
    ("https://onedrive.live.com/?authkey=%21ABC&id=123%21456&cid=789", "onedrive", None),
    ("https://contractor-my.sharepoint.com/:f:/g/personal/a_engineer_contractor_example/EaBcDeF?e=XyZ123", "sharepoint", None),
    ("https://app.box.com/s/abc123def456", "box", None),
    ("https://mega.nz/folder/AbCdEf#KeyKeyKey", "mega", "https://mega.nz/folder/AbCdEf#KeyKeyKey"),
    ("https://www.mediafire.com/file/abc123/drawings.zip/file", "mediafire", None),
    ("https://tenders.contractor.example/files/Addendum%202.pdf", "direct_file", None),
    ("https://etender.gov.kw/portal/tender/118", "other", None),
    # wrappers
    ("https://eur03.safelinks.protection.outlook.com/?url=https%3A%2F%2Fwe.tl%2Ft-SafeLink99&data=05%7C02%7C"
     "&sdata=abc&reserved=0", "wetransfer", "https://we.tl/t-SafeLink99"),
    ("https://urldefense.proofpoint.com/v2/url?u=https-3A__www.dropbox.com_s_abc123_plans.pdf-3Fdl-3D0&d=DwMFaQ&c=x",
     "dropbox", "https://www.dropbox.com/s/abc123/plans.pdf?dl=0"),
    ("https://urldefense.com/v3/__https://drive.google.com/file/d/1V3IdAbCdEfGhIjK/view__;!!ABC123!xyz$",
     "google_drive_file", "https://drive.google.com/file/d/1V3IdAbCdEfGhIjK/view"),
    ("https://www.google.com/url?q=https://we.tl/t-GoogleRedir&sa=D&source=editors", "wetransfer",
     "https://we.tl/t-GoogleRedir"),
    # how people paste links
    ("Drawings: we.tl/t-NoScheme123", "wetransfer", "https://we.tl/t-NoScheme123"),
    ("(see https://drive.google.com/drive/folders/1ParenFolderAbc).", "google_drive_folder",
     "https://drive.google.com/drive/folders/1ParenFolderAbc"),
    ("<https://www.dropbox.com/s/xyz789/specs.pdf?dl=0>", "dropbox", "https://www.dropbox.com/s/xyz789/specs.pdf?dl=0"),
    ("Specs at https://contractor.example/docs/spec.pdf?utm_source=mail&utm_medium=email.", "direct_file",
     "https://contractor.example/docs/spec.pdf"),
]

JUNK = [
    "https://www.linkedin.com/in/m-engineer",
    "https://twitter.com/contractorco",
    "https://www.facebook.com/contractorco",
    "https://www.instagram.com/contractorco/",
    "https://contractor.example/wp-content/uploads/2024/01/logo.png",
    "https://mailtrack.io/trace/mail/abc123.png",
    "https://email.contractor.example/unsubscribe?u=123",
    "https://news.example.com/manage-preferences?id=9",
    "www.contractor.example",
    "https://www.contractor.example/",
    "https://aka.ms/LearnAboutSenderIdentification",
    "https://www.avast.com/sig-email?utm_medium=email",
    "https://wa.me/96599999999",
    "https://wetransfer.com/legal/terms",
    "https://www.dropbox.com/home",
]


@pytest.mark.parametrize("text,kind,url", KIND_CASES)
def test_kinds_and_normalisation(text, kind, url):
    links = extract_links(text)
    assert len(links) == 1, links
    assert links[0]["kind"] == kind
    if url:
        assert links[0]["url"] == url


@pytest.mark.parametrize("url", JUNK)
def test_junk_is_dropped(url):
    assert extract_links(f"Regards,\nA. Engineer\n{url}\n") == []


def test_signature_junk_in_html_and_sender_site():
    html = """<p>Please download the tender documents
    <a href="https://eur03.safelinks.protection.outlook.com/?url=https%3A%2F%2Fwetransfer.com%2Fdownloads%2Fabc123def456%2F0123456789ab&amp;data=05%7C02">here</a>.</p>
    <p>Regards,<br>A. Engineer<br><a href="mailto:a.engineer@contractor.example">a.engineer@contractor.example</a> | <a href="tel:+96522223333">+965 2222 3333</a></p>
    <a href="https://www.contractor.example"><img src="https://contractor.example/logo.png" alt="UE logo"></a>
    <a href="https://contractor.example/contact">Contact us</a>
    <a href="https://www.linkedin.com/company/contractorco"><img src="https://contractor.example/li.png"></a>
    <img src="https://mailtrack.io/trace/mail/pixel.gif" width="1" height="1">"""
    links = extract_links("", html, sender_email="a.engineer@contractor.example")
    assert links == [{"url": "https://wetransfer.com/downloads/abc123def456/0123456789ab", "kind": "wetransfer",
                      "label": "here"}]


def test_dedupe_and_labels():
    text = (
        "BOQ: https://www.dropbox.com/s/lbl/BOQ.xlsx?dl=0\n"
        "Drawings https://drive.google.com/file/d/1DupIdAbCdEfGhIj/view and again "
        "https://drive.google.com/open?id=1DupIdAbCdEfGhIj\n"
        "Same BOQ with dl=1: https://www.dropbox.com/s/lbl/BOQ.xlsx?dl=1\n"
    )
    html = '<a href="https://we.tl/t-Label1234">Download tender drawings</a>'
    links = extract_links(text + "Also https://we.tl/t-Label1234\n", html)
    assert [l["kind"] for l in links] == ["wetransfer", "dropbox", "google_drive_file"]
    assert links[0]["label"] == "Download tender drawings"
    assert links[1]["label"] == "BOQ"
    assert links[2]["label"] == "Drawings"


def test_drive_ids_and_resource_keys():
    assert drive_id_from_url("https://drive.google.com/file/d/1AbCdEfGhIjKl_-x/view") == "1AbCdEfGhIjKl_-x"
    assert drive_id_from_url("https://drive.google.com/drive/folders/0B1abcDEFghiJKL?resourcekey=0-xyz") == "0B1abcDEFghiJKL"
    assert drive_id_from_url("https://docs.google.com/presentation/d/1SlidesIdAbCdEf/edit") == "1SlidesIdAbCdEf"
    assert drive_id_from_url("https://drive.google.com/uc?export=download&id=1ZyXwVuTsRqPoNmLk") == "1ZyXwVuTsRqPoNmLk"
    assert drive_id_from_url("https://example.com/x") is None
    assert drive_resource_key("https://drive.google.com/drive/folders/0B1abc?resourcekey=0-xyz") == "0-xyz"
    assert classify_link(normalize_url("drive.google.com/drive/folders/1AbCdEfGhIjK")) == "google_drive_folder"
