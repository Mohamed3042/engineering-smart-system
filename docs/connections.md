# Connections

The app needs two things: a **mailbox** and an **AI engine**. Each can be connected two ways.
Secrets (API keys, tokens, passwords) are stored encrypted in `data/secrets.enc.json` and never leave
your computer.

## Mailbox

### Gmail through Google sign-in (recommended)

1. Open <https://console.cloud.google.com/> → create (or pick) a project.
2. **APIs & Services → Library → Gmail API → Enable.**
3. **APIs & Services → OAuth consent screen**: type *Internal* for a Google Workspace domain
   (e.g. `@medmack.com`), otherwise *External* and add yourself as a test user.
4. **Credentials → Create credentials → OAuth client ID → Desktop app** (or *Web application* with
   the redirect URI `http://127.0.0.1:8765/api/oauth/google/callback`). Download the JSON.
5. In the app: **Settings → Connections → Gmail → Upload client JSON → Sign in with Google**.

Scopes asked: `gmail.readonly` (read mail and attachments) and `gmail.compose` (save a quotation
as a draft reply). The app never sends without a person pressing **Send** on an approved quotation.

### Any mailbox through IMAP

Host, port, username and an app password (Gmail: *Google Account → Security → App passwords*;
Microsoft 365: an app password or IMAP enabled for the account). Sending uses SMTP after approval.

### Gmail through MCP

Point the app at a Gmail MCP server (HTTP URL with a token, or a local command for a stdio server).
Reading works the same; attachments need a server that exposes an attachment tool.

## AI engine

### API (your own provider key)

OpenAI, Anthropic, Google Gemini, Azure OpenAI or any OpenAI-compatible endpoint. After you add the
key, the app lists the provider's models and marks each one:

| Status | Meaning |
|---|---|
| **Eligible** | Passes the workspace policy and its qualification exam. Can be selected. |
| **Needs evaluation** | Unknown or not examined in the last 30 days. Run the exam first. |
| **Failed evaluation** | Exam score below the floor or a critical failure (invented data, prices, fake quotes). |
| **Refused** | Light or non-chat models, deprecated models, blocked patterns. Cannot be used at all. |

Critical work (reading requests, studying drawings, drafting quotations, research) runs only on
frontier-tier models that passed the exam. The floor cannot be lowered from the UI or the API.

### MCP (an AI client drives the app)

Use this when the AI runs in Claude Desktop, Claude Code or another MCP client instead of an API key.

* HTTP endpoint: `http://127.0.0.1:8765/mcp/` (set `ESS_MCP_TOKEN` to require
  `Authorization: Bearer <token>`).
* stdio: `cd backend && .venv/bin/python -m ess.mcp_server`.

Claude Code example:

```bash
claude mcp add --transport http engineering-smart-system http://127.0.0.1:8765/mcp/
```

The client must call `declare_engine` with its real model first. The same eligibility policy
applies: a refused or unexamined model cannot submit critical work. Every submission is checked
(verbatim evidence, no prices, schema), and nothing in MCP can send mail or approve anything.

## Web search (customer research)

Optional: Brave, Tavily or SerpAPI keys. Without a key the app uses a best-effort DuckDuckGo
search. Web results are context for customer profiles only; they never decide what *your* company
does — that comes from your own quotations, sent mail and documents.
