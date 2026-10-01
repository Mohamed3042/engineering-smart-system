# Handoff — 1 October 2026

Branch `claude/determined-feynman-r5zrdn`, draft PR Mohamed3042/engineering-smart-system#1.
Read `PRODUCT.md`, `DESIGN.md`, `docs/architecture.md`, `docs/collab/notes-from-astra.md` first.

## Done and tested

- **Backend** (Python/FastAPI/SQLite): mail scan + classification, projects/enquiries, change
  detection (deadline needs human confirmation; technical revision reopens review), file download
  and extraction, analysis, engineer review, quotation builder (templates, papers, signatories,
  signature import, stamp, catalogue, photos), approval/send gates, customers (tags, opportunities,
  research, monitoring), automations, learning from corrections, template rules, AI model policy +
  18-case exam, MCP server. `cd backend && .venv/bin/python -m pytest -q` → 579 passed.
- Latest backend additions in this session:
  - `ess/pipeline/terms.py`: quotation terms follow the customer's request (validity, contract
    period, spare parts) with the verbatim sentence in `data.term_changes`; MCP `propose_quotation`
    accepts `terms` (quote must be found in the project's mail; no prices).
  - `GET /api/ai/status` → `mcp.declared`, `mcp.tasks` (eligibility per task), `mcp.exam`.
  - `GET /api/mcp/info` → `clients` (copy-ready setups for Claude Code, HTTP JSON, stdio JSON).
  - `GET /api/customers` paged in SQL (`page`, `page_size`, `status`, `profile_status`,
    `monitoring`, `tag`, `sort`), ~50 ms per page at 10,000 companies.
- **Frontend foundation** (`frontend/src/app`, `ui`, `api`, `lib`): tokens, component kit, shell
  (sidebar ≥1024 px; phone header + tabs Home/Inbox/Projects/More), router, setup wizard frame,
  settings frame, global search (⌘K), notifications, workspace switcher, access-token gate,
  URL contract `lib/routes.ts`. Impeccable skill vendored in `.claude/skills/impeccable`.
- **Real Medmack data** (private, only in `data/` of the original container, never committed):
  812 mails, 34 customers, 17 projects, 32 enquiries, 88 knowledge items; 18 draft quotations
  AA/26/0001–0018 (no prices, DRAFT, unsigned) — already sent to the owner as a zip.

## Not finished — frontend screens (work in progress, committed as WIP)

Six parallel builders were stopped mid-way. Their partial code is in `frontend/src/features/*`.
**The frontend does not typecheck yet** (`cd frontend && npx tsc -p tsconfig.app.json`), so
`npm run build` fails; `run.sh` now continues and starts the API anyway.

| Feature folder | State when stopped | Remaining |
|---|---|---|
| `home` | dashboard data + project list | Home page (mockups 11, 55, 56), footer, setup banner |
| `inbox` | api, labels, list pieces; routes point to pages not written yet | visibility drawer, email detail (12–14, 47, 51–54) |
| `projects` | api, lib, shared parts | all pages (15–22, 49, 50, 60, 63, 64, 68, 73–78) + enquiries tab + `/files/:id` |
| `quotations` | api, lib, library | editor sections (incl. `term_changes`), preview, approvals/send, setup tabs, rules (23–29, 67, 79) |
| `customers` | directory, add-company, research dialog, api | switch directory to server paging; profile, projects, research, updates, opportunities (30–35, 59, 61) |
| `automations` | stub only | list, workflow editor, run log (36–38) |
| `connections` | api, issues, vocab, components | setup steps 01–06, `/settings/connections`, `/settings/ai` (+ MCP view), `/settings/ai-rules` (39, 42, 48, 72) |
| `knowledge` + `settings` | started shared review list | setup 07–10, knowledge tabs (40, 57, 58, 71), `/settings/learning`, team, workspace, account (41, 43, 62, 65, 70) |

Rules for whoever continues: use `@/ui` components and `lib/labels.ts` wording; link only via
`lib/routes.ts`; desktop + phone (390 px) for every screen; loading / empty / error states;
AI never writes prices; approvals and sending are explicit human gates; never put real customer
data in code or tests (the repository is public). If a folder is too far gone, restore its stub
`routes.tsx` (each exports the same route names) to get a green build, then rebuild it.

## Open items outside the UI

- Download the tender files on a normal machine (the sandbox blocks Drive/WeTransfer/SharePoint):
  New Ahmadi Hospital (KOC RFP-2143588) closes **11 Oct 2026**; Egaila schools closes 18 Oct.
- Connect Gmail (OAuth or IMAP) and an AI engine (API key or MCP) on the owner's machine:
  `./run.sh`, then follow `docs/connections.md`.
- Calibrate templates against the company's local quotation folder.
- Update the PR description when the UI lands.
- GitHub may still keep old SHAs of a squashed early commit that held real names; only GitHub
  support can purge them.
