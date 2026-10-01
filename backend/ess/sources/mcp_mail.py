"""Mailbox over an MCP server (e.g. Google's Gmail MCP server) using the ``mcp`` Python SDK.

Transports: streamable HTTP (``url`` + optional ``headers`` such as ``Authorization``) or stdio
(``command`` + ``args`` + ``env``). Works with SDK 2.x (``mcp.Client``) and 1.x
(``ClientSession`` + ``initialize``).

The default ``tool_map`` matches Google's Gmail MCP server::

    search_threads(query, pageSize<=50, pageToken, view)
        -> {threads: [{id, messages: [{id, sender, toRecipients, ccRecipients, subject,
                                         snippet, date, labelIds, viewUrl}]}], nextPageToken}
    get_thread(threadId, messageFormat="PLAIN_TEXT")
        -> {messages: [{id, threadId, sender, toRecipients, ccRecipients, subject, date,
                        plaintextBody, attachments: [{attachmentId?, filename, mimeType, size}],
                        labelIds, viewUrl}]}
    create_draft(to[], cc[], subject, body, attachments[{content(b64), filename, mimeType}],
                 replyToMessageId) -> {id, threadId, viewUrl}

That server has no attachment-download or send-draft tool, so those raise
:class:`~ess.sources.base.NotSupported` unless ``tool_map`` names tools that do it.
snake_case field variants (``to_recipients``, ``plaintext_body`` ...) are accepted too.

``tool_map`` values are a tool name, ``None`` (unsupported) or
``{"name": "...", "args": {"query": "q", ...}, "extra": {...}}`` to rename/add arguments.
All public methods have an async twin (``asearch``, ``aget_thread`` ...); the sync ones work
inside or outside a running event loop. ``async with source:`` keeps one session open.
"""
from __future__ import annotations

import asyncio
import base64
import concurrent.futures
import json
from contextlib import AsyncExitStack, asynccontextmanager
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Callable, Coroutine, Sequence, TypeVar

from .base import (
    MailAttachment,
    MailMessage,
    MailSourceError,
    NotSupported,
    build_gmail_query,
    default_own_domains,
    html_to_text,
    infer_direction,
    parse_address,
    parse_address_list,
    parse_mail_date,
    pick_headers,
)
from .mime import looks_like_message_id

__all__ = ["DEFAULT_TOOL_MAP", "McpMailSource", "mcp_message_to_mail", "run_sync", "tool_result_payload"]

T = TypeVar("T")

DEFAULT_TOOL_MAP: dict[str, Any] = {
    "search": "search_threads",
    "get_thread": "get_thread",
    "get_message": "get_message",
    "create_draft": "create_draft",
    "download_attachment": None,  # Google's Gmail MCP server exposes no attachment download
    "send_draft": None,  # ... and no "send this draft" tool: the user sends it from Gmail
}
_REQUIRED_OPS = ("search", "get_thread")
_GMAIL_PAGE_MAX = 50


def run_sync(coro: Coroutine[Any, Any, T]) -> T:
    """Run ``coro`` to completion from sync code, even when an event loop is already running."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


def _attr(obj: Any, *names: str, default: Any = None) -> Any:
    for name in names:
        if isinstance(obj, dict):
            if name in obj and obj[name] is not None:
                return obj[name]
        elif getattr(obj, name, None) is not None:
            return getattr(obj, name)
    return default


def tool_result_payload(result: Any) -> Any:
    """Turn an MCP ``CallToolResult`` (SDK 1.x/2.x object or plain dict) into JSON data."""
    if result is None:
        return {}
    if isinstance(result, dict):
        looks_like_result = isinstance(result.get("content"), list) or any(
            k in result for k in ("structuredContent", "structured_content", "isError", "is_error")
        )
        if not looks_like_result:
            return result  # already a payload (plain dict from a custom session)
    content = _attr(result, "content", default=[]) or []
    texts: list[str] = []
    for block in content:
        text = _attr(block, "text")
        if text:
            texts.append(str(text))
    if _attr(result, "is_error", "isError", default=False):
        raise MailSourceError("MCP tool error: " + (" ".join(texts) or "unknown error"))
    structured = _attr(result, "structured_content", "structuredContent")
    if structured is not None:
        if isinstance(structured, dict) and set(structured) == {"result"}:
            return structured["result"]  # SDKs wrap non-object returns as {"result": ...}
        return structured
    for text in texts:
        try:
            return json.loads(text)
        except (TypeError, ValueError):
            continue
    return {"text": "\n".join(texts)} if texts else {}


def _first(d: dict, *keys: str, default: Any = None) -> Any:
    for key in keys:
        if key in d and d[key] not in (None, ""):
            return d[key]
    return default


def mcp_message_to_mail(
    data: dict,
    *,
    thread_id: str | None = None,
    account: str | None = None,
    own_domains: Sequence[str] = (),
) -> MailMessage:
    """Map one Gmail-MCP message (camelCase or snake_case) to :class:`MailMessage`."""
    mid = str(_first(data, "id", "messageId", "message_id", default=""))
    sender = _first(data, "sender", "from", "fromAddress", default="")
    if isinstance(sender, dict):
        sender = f"{sender.get('name') or ''} <{sender.get('email') or sender.get('address') or ''}>"
    from_name, from_email = parse_address(str(sender))
    labels = list(_first(data, "labelIds", "label_ids", "labels", default=[]) or [])
    when = parse_mail_date(_first(data, "date", "internalDate", "internal_date", "timestamp", "receivedAt"))
    headers = data.get("headers") if isinstance(data.get("headers"), dict) else {}
    headers = pick_headers(headers.items()) if headers else {}
    if when is None:
        when = datetime.now(timezone.utc)
        headers["X-ESS-Date-Estimated"] = "1"
    body_text = _first(data, "plaintextBody", "plaintext_body", "plainTextBody", "body", "text", default="") or ""
    body_html = _first(data, "htmlBody", "html_body")
    if not body_text and body_html:
        body_text = html_to_text(body_html)

    attachments: list[MailAttachment] = []
    for idx, att in enumerate(_first(data, "attachments", default=[]) or [], start=1):
        if not isinstance(att, dict):
            continue
        attachments.append(
            MailAttachment(
                attachment_id=_first(att, "attachmentId", "attachment_id", "id"),
                filename=str(_first(att, "filename", "fileName", "name", default=f"attachment-{idx}")),
                mime=str(_first(att, "mimeType", "mime_type", "contentType", default="application/octet-stream")),
                size=int(_first(att, "size", "sizeBytes", default=0) or 0),
                content_id=_first(att, "contentId", "content_id"),
                inline=bool(_first(att, "inline", default=False)),
            )
        )
    if not attachments:
        for idx, aid in enumerate(_first(data, "attachmentIds", "attachment_ids", default=[]) or [], start=1):
            attachments.append(MailAttachment(attachment_id=str(aid), filename=f"attachment-{idx}"))

    domains = default_own_domains(account, own_domains)
    return MailMessage(
        id=mid,
        thread_id=str(_first(data, "threadId", "thread_id", default=thread_id or mid)),
        account=account,
        direction=infer_direction(from_email, account, domains, labels),
        from_name=from_name,
        from_email=from_email,
        to=parse_address_list(_first(data, "toRecipients", "to_recipients", "to", default=[])),
        cc=parse_address_list(_first(data, "ccRecipients", "cc_recipients", "cc", default=[])),
        subject=str(_first(data, "subject", default="") or "").strip(),
        date=when,
        snippet=str(_first(data, "snippet", default="") or ""),
        body_text=str(body_text).replace("\r\n", "\n"),
        body_html=body_html,
        labels=labels,
        attachments=attachments,
        list_unsubscribe=headers.get("List-Unsubscribe"),
        list_unsubscribe_post=headers.get("List-Unsubscribe-Post"),
        headers=headers,
        view_url=_first(data, "viewUrl", "view_url"),
    )


class McpMailSource:
    """:class:`~ess.sources.base.MailSource` backed by an MCP mail server."""

    kind = "mcp"

    def __init__(
        self,
        transport: str = "http",
        url: str | None = None,
        headers: dict[str, str] | None = None,
        command: str | None = None,
        args: Sequence[str] | None = None,
        env: dict[str, str] | None = None,
        tool_map: dict[str, Any] | None = None,
        *,
        account: str | None = None,
        own_domains: Sequence[str] = (),
        timeout_s: float = 60.0,
        page_size: int = _GMAIL_PAGE_MAX,
        message_format: str = "PLAIN_TEXT",
        session_factory: Callable[[], Any] | None = None,
    ) -> None:
        if transport not in ("http", "stdio"):
            raise ValueError("transport must be 'http' or 'stdio'")
        if session_factory is None and transport == "http" and not url:
            raise ValueError("an http MCP mail source needs a url")
        if session_factory is None and transport == "stdio" and not command:
            raise ValueError("a stdio MCP mail source needs a command")
        self.transport = transport
        self.url = url
        self.headers = dict(headers or {})
        self.command = command
        self.args = list(args or [])
        self.env = dict(env) if env else None
        self.tool_map = {**DEFAULT_TOOL_MAP, **(tool_map or {})}
        self.account = account.lower() if account else None
        self._own_domains = tuple(own_domains)
        self.timeout_s = timeout_s
        self.page_size = max(1, min(page_size, 500))
        self.message_format = message_format
        self._session_factory = session_factory
        self._session: Any = None
        self._stack: AsyncExitStack | None = None
        self.thread_previews: dict[str, dict] = {}

    # ------------------------------------------------------------------ sessions
    async def __aenter__(self) -> "McpMailSource":
        self._stack = AsyncExitStack()
        self._session = await self._stack.enter_async_context(self._open_session())
        return self

    async def __aexit__(self, *exc: Any) -> None:
        stack, self._stack, self._session = self._stack, None, None
        if stack is not None:
            await stack.aclose()

    @asynccontextmanager
    async def _session_ctx(self) -> AsyncIterator[Any]:
        if self._session is not None:
            yield self._session
            return
        async with self._open_session() as session:
            yield session

    @asynccontextmanager
    async def _open_session(self) -> AsyncIterator[Any]:
        if self._session_factory is not None:
            made = self._session_factory()
            if hasattr(made, "__aenter__"):
                async with made as session:
                    yield session
            else:
                yield made
            return
        async with AsyncExitStack() as stack:
            yield await self._sdk_session(stack)

    def _http_transport(self):
        import mcp.client.streamable_http as sh

        new_api = getattr(sh, "streamable_http_client", None)
        if new_api is not None:
            try:
                from mcp.shared._httpx_utils import create_mcp_http_client

                http_client = create_mcp_http_client(headers=self.headers or None)
                return new_api(self.url, http_client=http_client), http_client
            except (ImportError, TypeError):
                pass
        legacy = sh.streamablehttp_client
        return legacy(self.url, headers=self.headers or None, timeout=self.timeout_s), None

    async def _sdk_session(self, stack: AsyncExitStack) -> Any:
        try:
            import mcp
        except ImportError as exc:  # pragma: no cover - dependency is declared
            raise MailSourceError("the 'mcp' package is not installed") from exc
        if self.transport == "http":
            transport, http_client = self._http_transport()
            if http_client is not None:
                await stack.enter_async_context(http_client)
        else:
            from mcp.client.stdio import StdioServerParameters, stdio_client

            params = StdioServerParameters(command=self.command, args=self.args, env=self.env)
            transport = stdio_client(params)
        client_cls = getattr(mcp, "Client", None)
        if client_cls is not None:  # SDK 2.x: negotiates modern or legacy protocol versions
            return await stack.enter_async_context(client_cls(transport, read_timeout_seconds=self.timeout_s))
        streams = await stack.enter_async_context(transport)
        session = await stack.enter_async_context(mcp.ClientSession(streams[0], streams[1]))
        await session.initialize()
        return session

    # ------------------------------------------------------------------ tool calls
    def _tool(self, op: str) -> tuple[str, dict[str, str], dict[str, Any]]:
        spec = self.tool_map.get(op)
        if not spec:
            raise NotSupported(_unsupported_message(op))
        if isinstance(spec, str):
            return spec, {}, {}
        return spec["name"], dict(spec.get("args") or {}), dict(spec.get("extra") or {})

    async def _call(self, op: str, arguments: dict[str, Any]) -> Any:
        name, renames, extra = self._tool(op)
        args = {renames.get(k, k): v for k, v in arguments.items() if v is not None}
        args.update(extra)
        async with self._session_ctx() as session:
            try:
                result = await asyncio.wait_for(session.call_tool(name, args), timeout=self.timeout_s)
            except asyncio.TimeoutError as exc:
                raise MailSourceError(f"MCP tool {name} timed out after {self.timeout_s:.0f}s") from exc
            except MailSourceError:
                raise
            except Exception as exc:
                raise MailSourceError(f"MCP tool {name} failed: {exc}") from exc
        return tool_result_payload(result)

    # ------------------------------------------------------------------ async API
    async def asearch(self, query: str, after=None, before=None, max_results: int = 500) -> list[str]:
        q = build_gmail_query(query, after, before)
        ids: list[str] = []
        token: str | None = None
        while len(ids) < max_results:
            data = await self._call(
                "search",
                {"query": q or None, "pageSize": min(self.page_size, max_results - len(ids)), "pageToken": token},
            )
            data = data if isinstance(data, dict) else {}
            threads = data.get("threads") or []
            for item in threads:
                tid = str(_first(item, "id", "threadId", "thread_id", default=""))
                if tid and tid not in ids:
                    ids.append(tid)
                    self.thread_previews[tid] = item
            token = data.get("nextPageToken") or data.get("next_page_token")
            if not token or not threads:
                break
        return ids[:max_results]

    async def aget_thread(self, thread_id: str) -> list[MailMessage]:
        data = await self._call("get_thread", {"threadId": thread_id, "messageFormat": self.message_format})
        data = data if isinstance(data, dict) else {}
        raw_messages = data.get("messages") or []
        if not raw_messages and isinstance(data.get("thread"), dict):
            raw_messages = data["thread"].get("messages") or []
        messages = [
            mcp_message_to_mail(m, thread_id=thread_id, account=self.account, own_domains=self._own_domains)
            for m in raw_messages
            if isinstance(m, dict)
        ]
        messages.sort(key=lambda m: m.date)
        return messages

    async def aget_message(self, message_id: str) -> MailMessage:
        data = await self._call("get_message", {"messageId": message_id, "messageFormat": self.message_format})
        data = data.get("message", data) if isinstance(data, dict) else {}
        return mcp_message_to_mail(data, account=self.account, own_domains=self._own_domains)

    async def adownload_attachment(self, message_id: str, attachment_id: str) -> bytes:
        data = await self._call("download_attachment", {"messageId": message_id, "attachmentId": attachment_id})
        if isinstance(data, dict):
            encoded = _first(data, "data", "content", "bytes", "base64")
        else:
            encoded = data
        if not encoded:
            raise MailSourceError(f"MCP server returned no data for attachment {attachment_id}")
        encoded = str(encoded).strip()
        return base64.urlsafe_b64decode(encoded.replace("+", "-").replace("/", "_") + "=" * (-len(encoded) % 4))

    async def acreate_draft(
        self,
        to: str | Sequence[str],
        subject: str,
        body_text: str,
        attachments: Sequence[tuple[str, bytes, str]] = (),
        in_reply_to: str | None = None,
        thread_id: str | None = None,
        *,
        cc: Sequence[str] | None = None,
    ) -> str:
        recipients = [to] if isinstance(to, str) else list(to)
        args: dict[str, Any] = {
            "to": parse_address_list(recipients) or recipients,
            "cc": parse_address_list(list(cc or [])) or None,
            "subject": subject,
            "body": body_text,
        }
        if attachments:
            args["attachments"] = [
                {"content": base64.b64encode(data).decode("ascii"), "filename": name, "mimeType": mime or "application/octet-stream"}
                for name, data, mime in attachments
            ]
        if in_reply_to and not looks_like_message_id(in_reply_to):
            args["replyToMessageId"] = in_reply_to  # Gmail MCP threads the draft from this id
        data = await self._call("create_draft", args)
        data = data if isinstance(data, dict) else {}
        draft_id = _first(data, "id", "draftId", "draft_id")
        if not draft_id and isinstance(data.get("draft"), dict):
            draft_id = _first(data["draft"], "id", "draftId")
        if not draft_id:
            raise MailSourceError("the MCP server did not return a draft id")
        return str(draft_id)

    async def asend_draft(self, draft_id: str) -> str:
        data = await self._call("send_draft", {"draftId": draft_id})
        data = data if isinstance(data, dict) else {}
        return str(_first(data, "id", "messageId", "message_id", default=draft_id))

    async def alist_tools(self) -> list[dict[str, Any]]:
        async with self._session_ctx() as session:
            result = await asyncio.wait_for(session.list_tools(), timeout=self.timeout_s)
        tools = _attr(result, "tools", default=None)
        if tools is None and isinstance(result, list):
            tools = result
        out = []
        for tool in tools or []:
            out.append(
                {
                    "name": _attr(tool, "name"),
                    "description": (_attr(tool, "description") or "")[:300],
                    "input_schema": _attr(tool, "input_schema", "inputSchema", default={}),
                }
            )
        return out

    async def atest(self) -> dict[str, Any]:
        try:
            tools = await self.alist_tools()
        except Exception as exc:
            return {"ok": False, "account": self.account, "error": f"cannot connect to the MCP server: {exc}"}
        names = {t["name"] for t in tools}
        capabilities: dict[str, bool] = {}
        for op, spec in self.tool_map.items():
            name = spec if isinstance(spec, str) else (spec or {}).get("name") if isinstance(spec, dict) else None
            capabilities[op] = bool(name) and name in names
        missing = [op for op in _REQUIRED_OPS if not capabilities.get(op)]
        return {
            "ok": not missing,
            "account": self.account,
            "error": (f"the server lacks tools for: {', '.join(missing)}" if missing else None),
            "tools": sorted(n for n in names if n),
            "capabilities": capabilities,
        }

    # ------------------------------------------------------------------ sync API
    def search(self, query: str, after=None, before=None, max_results: int = 500) -> list[str]:
        return run_sync(self.asearch(query, after, before, max_results))

    def get_thread(self, thread_id: str) -> list[MailMessage]:
        return run_sync(self.aget_thread(thread_id))

    def get_message(self, message_id: str) -> MailMessage:
        return run_sync(self.aget_message(message_id))

    def download_attachment(self, message_id: str, attachment_id: str) -> bytes:
        return run_sync(self.adownload_attachment(message_id, attachment_id))

    def create_draft(self, to, subject, body_text, attachments=(), in_reply_to=None, thread_id=None, *, cc=None) -> str:
        return run_sync(self.acreate_draft(to, subject, body_text, attachments, in_reply_to, thread_id, cc=cc))

    def send_draft(self, draft_id: str) -> str:
        return run_sync(self.asend_draft(draft_id))

    def list_tools(self) -> list[dict[str, Any]]:
        return run_sync(self.alist_tools())

    def test(self) -> dict[str, Any]:
        return run_sync(self.atest())


def _unsupported_message(op: str) -> str:
    if op == "download_attachment":
        return (
            "The connected MCP mail server has no attachment-download tool (Google's Gmail MCP server "
            "does not expose one). Connect the mailbox through the Gmail API or IMAP to fetch attachment "
            "files, or map 'download_attachment' in tool_map to a tool that returns base64 data."
        )
    if op == "send_draft":
        return (
            "The connected MCP mail server cannot send an existing draft. The approved draft is in the "
            "mailbox: open it in Gmail and press Send, or connect through the Gmail API / IMAP+SMTP."
        )
    return f"The connected MCP mail server has no tool mapped for '{op}'."
