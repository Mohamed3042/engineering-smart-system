"""MCP mail source: Gmail-MCP mapping with a fake session, then the real SDK (in-process, stdio, HTTP)."""
from __future__ import annotations

import base64
import json
import socket
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from ess.sources.base import MailSourceError, NotSupported
from ess.sources.mcp_mail import McpMailSource, mcp_message_to_mail, tool_result_payload

FIXTURES = Path(__file__).resolve().parent / "fixtures"
sys.path.insert(0, str(FIXTURES))


def _result(payload, *, style="v2", error=False):
    text = [SimpleNamespace(type="text", text=json.dumps(payload) if not isinstance(payload, str) else payload)]
    if style == "v1":  # SDK 1.x attribute names, text-only content
        return SimpleNamespace(content=text, structuredContent=None, isError=error)
    return SimpleNamespace(content=text, structured_content=None if error else payload, is_error=error)


class FakeSession:
    """Answers like Google's Gmail MCP server; records every call."""

    def __init__(self, style="v2"):
        self.style = style
        self.calls: list[tuple[str, dict]] = []

    async def call_tool(self, name, arguments=None):
        args = arguments or {}
        self.calls.append((name, args))
        if name == "search_threads":
            if args.get("pageToken") == "next-1":
                return _result({"threads": [{"id": "19a00000000000c3", "messages": []}]}, style=self.style)
            return _result({"threads": [{"id": "19a00000000000a1", "messages": [{"id": "m1", "subject": "RFQ"}]},
                                        {"id": "19a00000000000b2", "messages": []}],
                            "nextPageToken": "next-1"}, style=self.style)
        if name == "get_thread":
            return _result({"messages": [
                {"id": "m1", "threadId": args["threadId"], "sender": "\"A. Engineer\" <A.Engineer@contractor.example>",
                 "toRecipients": ["Medmack Sales <sales@medmack.com>"], "ccRecipients": ["Ali <ali@contractor.example>"],
                 "subject": "RFQ: BMU", "date": "Wed, 26 Aug 2026 11:20:26 +0300", "snippet": "Please quote",
                 "plaintextBody": "Dear Sir,\nPlease quote the BMU.\n",
                 "attachments": [{"attachmentId": "att-1", "filename": "BOQ.pdf", "mimeType": "application/pdf",
                                  "size": 1234}, {"filename": "Drawings.zip", "mimeType": "application/zip", "size": 9}],
                 "labelIds": ["INBOX", "UNREAD"], "viewUrl": "https://mail.google.com/mail/u/0/#all/m1"},
                {"id": "m2", "thread_id": args["threadId"], "sender": "sales@medmack.com",
                 "to_recipients": ["a.engineer@contractor.example"], "subject": "Re: RFQ: BMU", "date": "1787735000000",
                 "plaintext_body": "Received.", "label_ids": ["SENT"], "view_url": "https://mail.google.com/x"},
            ]}, style=self.style)
        if name == "create_draft":
            return _result({"id": "r-555", "threadId": "19a00000000000a1", "viewUrl": "https://mail.google.com/d"},
                           style=self.style)
        if name == "boom":
            return _result("quota exceeded", style=self.style, error=True)
        raise AssertionError(f"unexpected tool {name}")

    async def list_tools(self):
        names = ["search_threads", "get_thread", "get_message", "create_draft", "list_labels"]
        return SimpleNamespace(tools=[SimpleNamespace(name=n, description=f"{n} tool", inputSchema={}) for n in names])


def make(style="v2", **kwargs):
    session = FakeSession(style)
    return McpMailSource(session_factory=lambda: session, account="sales@medmack.com", **kwargs), session


def test_payload_parsing_variants():
    assert tool_result_payload(_result({"a": 1})) == {"a": 1}
    assert tool_result_payload(_result({"a": 1}, style="v1")) == {"a": 1}
    assert tool_result_payload(SimpleNamespace(content=[], structured_content={"result": [1, 2]}, is_error=False)) == [1, 2]
    assert tool_result_payload({"threads": []}) == {"threads": []}
    assert tool_result_payload({"content": "QUJD"}) == {"content": "QUJD"}  # plain payload with a 'content' key
    with pytest.raises(MailSourceError, match="quota exceeded"):
        tool_result_payload(_result("quota exceeded", error=True))


@pytest.mark.parametrize("style", ["v1", "v2"])
def test_search_paginates_and_builds_gmail_query(style):
    source, session = make(style)
    ids = source.search("BMU OR gondola", after="2026-08-01", before="2026-10-01", max_results=10)
    assert ids == ["19a00000000000a1", "19a00000000000b2", "19a00000000000c3"]
    first, second = session.calls
    assert first == ("search_threads", {"query": "BMU OR gondola after:2026/08/01 before:2026/10/01", "pageSize": 10})
    assert second[1]["pageToken"] == "next-1" and second[1]["pageSize"] == 8
    assert source.thread_previews["19a00000000000a1"]["messages"][0]["subject"] == "RFQ"
    assert make()[0].search("", max_results=1) == ["19a00000000000a1"]


def test_get_thread_maps_messages():
    source, session = make()
    first, reply = source.get_thread("19a00000000000a1")
    assert session.calls[0] == ("get_thread", {"threadId": "19a00000000000a1", "messageFormat": "PLAIN_TEXT"})
    assert first.from_name == "A. Engineer" and first.from_email == "a.engineer@contractor.example"
    assert first.to == ["sales@medmack.com"] and first.cc == ["ali@contractor.example"]
    assert first.date == datetime(2026, 8, 26, 8, 20, 26, tzinfo=timezone.utc)
    assert first.body_text.startswith("Dear Sir") and first.labels == ["INBOX", "UNREAD"]
    assert first.direction == "inbound" and first.view_url.endswith("#all/m1")
    assert [(a.attachment_id, a.filename, a.size) for a in first.attachments] == [
        ("att-1", "BOQ.pdf", 1234), (None, "Drawings.zip", 9)]
    assert reply.direction == "outbound" and reply.thread_id == "19a00000000000a1"  # snake_case variant
    assert reply.to == ["a.engineer@contractor.example"] and reply.body_text == "Received."


def test_unsupported_operations_are_explicit():
    source, _ = make()
    with pytest.raises(NotSupported, match="attachment-download tool"):
        source.download_attachment("m1", "att-1")
    with pytest.raises(NotSupported, match="open it in Gmail and press Send"):
        source.send_draft("r-555")


def test_create_draft_arguments():
    source, session = make()
    draft = source.create_draft("A. Engineer <a.engineer@contractor.example>", "Re: RFQ: BMU", "Offer attached.",
                                attachments=[("Offer.pdf", b"%PDF-1.4", "application/pdf")], in_reply_to="m1")
    assert draft == "r-555"
    name, args = session.calls[-1]
    assert name == "create_draft" and args["to"] == ["a.engineer@contractor.example"] and args["replyToMessageId"] == "m1"
    assert args["attachments"] == [{"content": base64.b64encode(b"%PDF-1.4").decode(), "filename": "Offer.pdf",
                                    "mimeType": "application/pdf"}]
    source.create_draft(["x@y.com"], "s", "b", in_reply_to="<CAF1@mail.com>")  # RFC ids are not Gmail ids
    assert "replyToMessageId" not in session.calls[-1][1]


def test_tool_map_overrides_and_test_report():
    session = FakeSession()

    async def call_tool(name, arguments=None):
        session.calls.append((name, arguments))
        return _result({"data": base64.urlsafe_b64encode(b"file-bytes").decode().rstrip("=")})

    session.call_tool = call_tool
    source = McpMailSource(session_factory=lambda: session, tool_map={
        "download_attachment": {"name": "get_attachment", "args": {"messageId": "message_id"}, "extra": {"raw": True}}})
    assert source.download_attachment("m1", "att-1") == b"file-bytes"
    assert session.calls[-1] == ("get_attachment", {"message_id": "m1", "attachmentId": "att-1", "raw": True})

    report = make()[0].test()
    assert report["ok"] and report["capabilities"]["search"] and report["capabilities"]["create_draft"]
    assert report["capabilities"]["download_attachment"] is False and "list_labels" in report["tools"]
    missing = McpMailSource(session_factory=lambda: FakeSession(), tool_map={"search": "find_mail"}).test()
    assert missing["ok"] is False and "search" in missing["error"]


async def test_sync_wrappers_work_inside_a_running_loop():
    source, _ = make()
    assert source.search("BMU", max_results=2) == ["19a00000000000a1", "19a00000000000b2"]  # sync call from async code
    async with source:  # one session for several calls
        assert len(await source.aget_thread("19a00000000000a1")) == 2
        assert await source.asearch("x", max_results=1) == ["19a00000000000a1"]


def test_mapping_tolerates_missing_fields():
    msg = mcp_message_to_mail({"id": "m9", "sender": {"name": "Ali", "email": "ali@contractor.example"}}, thread_id="t9")
    assert msg.thread_id == "t9" and msg.from_email == "ali@contractor.example" and msg.from_name == "Ali"
    assert msg.headers.get("X-ESS-Date-Estimated") == "1"


# --------------------------------------------------------------------------- real SDK paths
def _check_real_results(ids, messages):
    assert ids == ["t-1001", "t-1002", "t-1003"]
    first, reply = messages
    assert first.from_email == "a.engineer@contractor.example" and first.attachments[0].filename == "BOQ.pdf"
    assert first.cc == ["tenders@contractor.example"] and reply.direction == "outbound"


async def test_real_sdk_in_process():
    mcp = pytest.importorskip("mcp")
    if not hasattr(mcp, "Client"):
        pytest.skip("in-process client needs MCP SDK 2.x")
    from fake_gmail_mcp_server import build_server

    server = build_server()
    source = McpMailSource(session_factory=lambda: mcp.Client(server), account="sales@medmack.com")
    async with source:
        ids = await source.asearch("BMU")
        messages = await source.aget_thread("t-1001")
        draft = await source.acreate_draft(["a.engineer@contractor.example"], "Re", "Body",
                                           attachments=[("a.pdf", b"x", "application/pdf")], in_reply_to="m-1")
        tools = {t["name"] for t in await source.alist_tools()}
    _check_real_results(ids, messages)
    assert draft == "r-draft-1-m-1" and {"search_threads", "get_thread", "create_draft"} <= tools


def test_real_sdk_over_stdio():
    source = McpMailSource(transport="stdio", command=sys.executable,
                           args=[str(FIXTURES / "fake_gmail_mcp_server.py")], account="sales@medmack.com",
                           timeout_s=30)

    async def run():
        async with source:
            return await source.asearch("BMU"), await source.aget_thread("t-1001"), await source.atest()

    from ess.sources.mcp_mail import run_sync

    ids, messages, report = run_sync(run())
    _check_real_results(ids, messages)
    assert report["ok"] and report["capabilities"]["get_thread"]


def test_real_sdk_over_streamable_http():
    uvicorn = pytest.importorskip("uvicorn")
    from fake_gmail_mcp_server import build_server

    seen_headers: list[dict] = []
    app = build_server().streamable_http_app()

    async def recording_app(scope, receive, send):
        if scope["type"] == "http":
            seen_headers.append({k.decode(): v.decode() for k, v in scope["headers"]})
        await app(scope, receive, send)

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(recording_app, host="127.0.0.1", port=port, log_level="error",
                                           lifespan="on"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        for _ in range(100):
            if server.started:
                break
            time.sleep(0.05)
        source = McpMailSource(transport="http", url=f"http://127.0.0.1:{port}/mcp",
                               headers={"Authorization": "Bearer test-token"}, account="sales@medmack.com",
                               timeout_s=30)
        ids = source.search("BMU")
        messages = source.get_thread("t-1001")
        report = source.test()
    finally:
        server.should_exit = True
        thread.join(timeout=10)
    _check_real_results(ids, messages)
    assert report["ok"]
    assert any(h.get("authorization") == "Bearer test-token" for h in seen_headers)
