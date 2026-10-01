# Engineering Smart System

Local-first automation for engineering contractors: it reads the company mailbox, learns what the
company does, sorts mail, turns enquiries into projects, collects every file the customer sent
(attachments, Google Drive, WeTransfer, Dropbox, OneDrive), studies documents and drawings, and
drafts the company's **official quotation PDF** — then stops at a **human engineer gate**. Nothing
leaves the company until a person approves it.

First workspace: Medmack (`sales@medmack.com`) — Building Maintenance Units (BMU) and Window
Cleaning Equipment (WCE). The engine is generic: connect any company mailbox and it learns that
company's services, names and regional vocabulary.

## What it does

| Area | What happens |
|---|---|
| **Smart setup** | Pick the AI engine (API key **or** MCP), connect the mailbox, add local company folders (old quotations, catalogues). The app mines sent mail, quotations and documents to propose the company's **service families**, **work types**, terms (with regional variants: Gulf / UK-EU / US / Russia / South Asia), standards and document conventions. Own quotations and sent mail are strong evidence; web results are context only. The owner confirms or rejects every finding. |
| **Inbox control** | Every message gets a category from the learned business (BMU, window cleaning, hoists…) or a non-work group (bills, supplier offers, promotions, notifications). Show/hide per category; promotions are hidden by default; unsubscribe needs a confirmation. |
| **Projects** | One project per building/tender, one **enquiry per contractor** asking for it (Kuwait tenders bring several). Closing dates, extensions, addenda, reminders and technical revisions are detected with the exact sentence as evidence. Each project shows its blockers and one *next action*. |
| **Files** | Attachments are saved; shared links are downloaded by browser automation (trusted file hosts automatically, other hosts after approval). PDFs, DOCX, XLSX BOQs, ZIPs, e-mails are read; drawing pages are rendered for the vision model. |
| **Analysis** | The AI extracts scope, requirements and open questions with verbatim evidence, studies drawings, and builds an engineer review checklist. |
| **Quotations** | Templates follow the company's official paper (Tenders, Supply & Installation, Annual Maintenance, Equipment Rental, Service & Repair; EN/AR), reference numbers like `AA/26/0118`, the selected signatory. AI never writes prices. Approval requires an approved technical review and every price filled in; sending creates a mail draft or sends only on explicit confirmation. |
| **Customers** | Tags for role, sectors, needs and behaviour; suggested services the customer has not asked for yet; deep research profiles with achievable evidence standards (basic / standard / deep); news and project monitoring. |
| **Automations** | Enquiry intake, deadline & revision watch, customer updates, inbox hygiene — every run is logged step by step and pauses at human gates. |
| **AI quality rules** | Models are checked against a workspace policy plus a qualification exam. Light, deprecated or non-chat models are refused for critical work — through the UI, the API and MCP. The floor cannot be lowered. |

## Run it

```bash
./run.sh            # creates backend/.venv, installs Chromium, starts http://127.0.0.1:8765
```

Then follow [docs/connections.md](docs/connections.md) to connect Gmail (Google sign-in, IMAP or MCP)
and an AI engine (OpenAI / Anthropic / Google / Azure / OpenAI-compatible key, or an MCP client such as
Claude Desktop/Code via `http://127.0.0.1:8765/mcp/`).

Useful commands (from `backend/` with the venv active):

```bash
python -m ess.seed demo                         # neutral sample workspace
python -m ess.seed import snapshot.json         # load a scan snapshot (docs/snapshot-format.md)
python -m ess.seed knowledge knowledge.json     # load mined business knowledge
python -m ess.seed signatory --initials AA --name "…" --default
python -m ess.report brief.html --families bmu,wce
python -m ess.mcp_server                        # MCP over stdio
python -m pytest -q                             # tests
```

The company letterhead, stamp and signatures are private: `python scripts/import_letterhead.py`
copies them from a local `medmack-quotation-builder` checkout into `data/private/` (git-ignored).
Without them the PDF uses a neutral letterhead marked *specimen*.

## Privacy

All mail, files, quotations, letterheads, signatures and secrets live in `data/` (git-ignored).
Secrets are encrypted at rest. The repository contains code and invented sample data only.

## Project layout

See [docs/architecture.md](docs/architecture.md). Backend: Python 3.11, FastAPI, SQLite, Playwright.
The UI concept screens are in [docs/ui-mockups](docs/ui-mockups/SCREEN-INDEX.md); the interface is
built from the refined concept once it is final.
