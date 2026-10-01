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
| **Quotations** | The company's own quotation-builder features inside the app: official templates (Tenders, Supply & Installation, Annual Maintenance, Equipment Rental, Service & Repair; EN/AR), selectable **papers** (full letterhead or pre-printed paper), **signatory** selection with signature import from a signed letter, per-page **stamp** placement, **catalog** prefill (old prices shown only as dated guidance), reference **photos**, `AA/26/0118` references. **Template rules** say which template/paper/language/signatory to use for each kind of project or customer. AI never writes prices. Drafts carry no signature or stamp. Approval needs an approved technical review, no unreviewed revision, and every price filled in; sending needs an explicit confirmation. |
| **Learning from corrections** | Every correction a person makes (mail category, template switch, lines added or removed in a draft, engineer notes, wrong facts, rejected findings) is stored as a lesson for the company and for each customer. Lessons silently decide repeat cases (same sender → same category; a template chosen repeatedly becomes the default) and are added to the AI's prompts. Each lesson can be switched off. No model is retrained; the memory stays local. |
| **Customers** | Tags for role, sectors, needs and behaviour; suggested services the customer has not asked for yet; deep research profiles with achievable evidence standards (basic / standard / deep); news and project monitoring. |
| **Automations** | Enquiry intake, deadline & revision watch, customer updates, inbox hygiene — every run is logged step by step and pauses at human gates. |
| **AI quality rules** | Models are checked against a workspace policy plus an 18-case qualification exam (invented cases: evidence traps, price traps, deadline changes, Arabic RFQs, a drawing). Light, deprecated or non-chat models are refused for critical work — through the UI, the API and MCP. An AI client connected over MCP must declare its model and pass the same exam. Exam records are signed per installation; the floor cannot be lowered. |
| **Review discipline** | Downloaded, extracted and reviewed are separate facts for every file. A new technical revision opens a fresh engineer review (the old sign-off stays in history) and blocks linked quotations. Detected deadline extensions change the closing date only after a person confirms them. Approvals record the exact revision. Sent is not accepted: the customer's answer is tracked separately. |

## Run it

```bash
./run.sh            # creates backend/.venv, installs Chromium, starts http://127.0.0.1:8765
```

Then follow [docs/connections.md](docs/connections.md) to connect Gmail (Google sign-in, IMAP or MCP)
and an AI engine (OpenAI / Anthropic / Google / Azure / OpenAI-compatible key, or an MCP client such as
Claude Desktop/Code via `http://127.0.0.1:8765/mcp/`).

Frontend development: `cd frontend && npm install && npm run dev` (http://127.0.0.1:5173, proxies the
API to the backend on :8765). Design system: [DESIGN.md](DESIGN.md); product brief: [PRODUCT.md](PRODUCT.md).

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

## UI concept

**158 independently generated mockups: 79 desktop screens and 79 phone screens** (version 2) —
[browse every screen](docs/ui-mockups/SCREEN-INDEX.md), [refinement notes](docs/ui-mockups/REFINEMENT-NOTES.md),
[desktop](docs/ui-mockups/Desktop), [phone](docs/ui-mockups/Phone),
[generation prompts](docs/ui-mockups/GENERATION-PROMPTS.json). The concepts cover onboarding, AI connections,
inbox classification, projects, drawings, engineer review, quotations, customers, research, automations,
settings, dialogs and recovery states; version 2 adds requirement revisions, deadline amendments, renewed
approval, customer-response tracking, Arabic inspection requests, BOQ evidence and maintenance quotations.
They are generated visual concepts with fictional sample content; the visual direction applies Impeccable
Operate principles. Collaboration notes: [for the concept author](docs/collab/notes-for-astra.md) ·
[from the concept author](docs/collab/notes-from-astra.md).

## Project layout

See [docs/architecture.md](docs/architecture.md). Backend: Python 3.11, FastAPI, SQLite, Playwright.
Frontend: React, TypeScript, Vite, Tailwind, Radix, TanStack Query.
