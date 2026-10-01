"""A tiny MCP server that answers like Google's Gmail MCP server (canned data).

Run as a script for the stdio transport (``python fake_gmail_mcp_server.py``); tests also build
it in-process (``build_server()``) and serve it over streamable HTTP.
"""
from __future__ import annotations

try:  # MCP Python SDK 2.x
    from mcp.server.mcpserver import MCPServer as _Server
except ImportError:  # SDK 1.x
    from mcp.server.fastmcp import FastMCP as _Server

THREADS = {
    "t-1001": {
        "id": "t-1001",
        "messages": [
            {
                "id": "m-1", "threadId": "t-1001", "sender": "A. Engineer <a.engineer@contractor.example>",
                "toRecipients": ["Medmack Sales <sales@medmack.com>"], "ccRecipients": ["tenders@contractor.example"],
                "subject": "RFQ: BMU for Harbour Tower", "date": "2026-08-26T08:20:26Z",
                "plaintextBody": "Dear Sir,\nPlease quote BMU. Drawings: https://we.tl/t-AbCdEf1234\n",
                "attachments": [{"attachmentId": "att-1", "filename": "BOQ.pdf", "mimeType": "application/pdf",
                                 "size": 245760}],
                "labelIds": ["INBOX", "IMPORTANT"], "viewUrl": "https://mail.google.com/mail/u/0/#all/m-1",
            },
            {
                "id": "m-2", "threadId": "t-1001", "sender": "sales@medmack.com",
                "toRecipients": ["a.engineer@contractor.example"], "subject": "Re: RFQ: BMU for Harbour Tower",
                "date": "2026-08-26T09:02:10Z", "plaintextBody": "Received, thank you.", "labelIds": ["SENT"],
                "viewUrl": "https://mail.google.com/mail/u/0/#all/m-2",
            },
        ],
    },
    "t-1002": {"id": "t-1002", "messages": []},
    "t-1003": {"id": "t-1003", "messages": []},
}


def build_server():
    server = _Server("fake-gmail")

    @server.tool()
    def search_threads(query: str = "", pageSize: int = 20, pageToken: str = "", view: str = "") -> dict:
        """List threads (canned)."""
        if pageToken == "p2":
            return {"threads": [{"id": "t-1003", "messages": []}]}
        return {"threads": [{"id": "t-1001", "messages": [{"id": "m-1", "subject": "RFQ"}]},
                            {"id": "t-1002", "messages": []}], "nextPageToken": "p2"}

    @server.tool()
    def get_thread(threadId: str, messageFormat: str = "FULL_CONTENT") -> dict:
        """Get one thread (canned)."""
        return THREADS.get(threadId, {"id": threadId, "messages": []})

    @server.tool()
    def create_draft(to: list[str] | None = None, subject: str = "", body: str = "", cc: list[str] | None = None,
                     attachments: list[dict] | None = None, replyToMessageId: str = "") -> dict:
        """Create a draft (canned)."""
        return {"id": f"r-draft-{len(attachments or [])}-{replyToMessageId or 'new'}", "threadId": "t-1001",
                "viewUrl": "https://mail.google.com/mail/u/0/#drafts"}

    return server


if __name__ == "__main__":
    build_server().run("stdio")
