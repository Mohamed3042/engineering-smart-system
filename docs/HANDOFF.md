# Handoff — 1 October 2026 (evening)

Branch `claude/determined-feynman-r5zrdn`, draft PR Mohamed3042/engineering-smart-system#1.
Read `PRODUCT.md`, `DESIGN.md`, `docs/architecture.md`, `docs/collab/notes-from-astra.md` first.

## State

- **Backend** (Python/FastAPI/SQLite): mail scan + classification, projects/enquiries, change
  detection (deadline needs human confirmation; technical revision reopens review), file download
  and extraction, analysis, engineer review, quotation builder (templates with the company's own
  wording, papers, signatories, signature import, stamp, catalogue, photos), approval/send gates,
  customers, automations, learning from corrections, template rules, AI model policy + 18-case
  exam, MCP server. `cd backend && .venv/Scripts/python -m pytest -q` (Windows) or
  `.venv/bin/python -m pytest -q` → 584 passed.
- **Frontend**: every screen is built (no placeholders left): home, inbox, projects (overview,
  enquiries, inputs, analysis, review, documents, change review, file viewer), quotations (library,
  editor, requested-term decisions, preview, approvals, setup), customers, automations, settings,
  setup wizard. `cd frontend && npm run build` is green (strict TypeScript, zero errors).
- **Rendered screens**: `docs/rendered/INDEX.md` — desktop and phone images of every page and a
  separate image of every dialog, on an invented sample workspace. Re-create them with
  `backend/.venv/Scripts/python scripts/screenshots.py` (Windows) or `backend/.venv/bin/python …`.
- **Real Medmack data** stays private (only in `data/` on the machine that scanned it, never
  committed).

## Rules that are now code

- A term the customer asks for is a pending request until a person accepts it, keeps the template
  wording with a reason, or asks for clarification (`POST /quotations/{id}/term-changes/{key}/decide`);
  undecided requests block approval; the decision records who, when and the revision.
- `GET /quotations/{id}` and the approval queue return `approval_blockers` — the same list the
  approve gate checks (`review_required`, `impact_review`, `prices_missing`, `quantities_missing`,
  `terms_pending`). The interface shows them; it does not repeat the rules.
- A quantity the tender does not state stays empty and blocks approval; prices start empty.
- Text files are read and written as UTF-8 on every platform (Windows' cp1252 broke Arabic and
  ZIP extraction).

## Fixed after the rendered-UI review (Astra, pinned fa2dbfd)

- Unmatched mail: `POST /emails/{id}/link` + "File under a project" / "Create project from this
  message"; reply and forward hand off to the mail program (the app never sends mail by itself).
- Automations: `new_email` workflows really start after a mailbox check finds new mail (the
  background scheduler checks mailboxes with such workflows every 15 minutes); every workflow shows
  `trigger_status` (how it really starts); workflows can be created, edited and deleted.
- Templates switched off in Quotation setup are never picked by drafting (fallback with reason);
  choosing one on purpose is refused.
- Source inspection: zoom up to 300 %, full screen, page jump, page links from BOQ rows and facts.
- Phone order: quotation editor 7,272 → 4,005 CSS px with a sticky next step and jump chips; Home,
  customer profile, engineering review, papers and letterhead put the task first.
- Links "Obtained another way" (resolved) vs rejected; failed attachments can be retried;
  `/projects/{id}/work` replaces fixed polling; `/emails` intent / work type / unlinked filters;
  `/ai/policy` returns the hard floor; quotation pages and photos as images.

## Known gaps

- `GET /dashboard` has no pending-download list (Home derives it from blockers with `link_id`).
- No endpoint lists mailbox labels/folders: the scan scope takes typed search queries.
- The Google OAuth callback always returns to `/settings/connections?gmail=`.
- The stamp marker is not drawn when a paper's own stamp position applies (paper geometry is not
  exposed by the API).
- Pinch-zoom was tested with synthetic touch events in Chromium, not on a physical phone.

## Open items outside the UI

- Download the tender files of the two open tenders (closing 11 and 18 Oct 2026) on a normal
  machine (the sandbox blocks Drive/WeTransfer/SharePoint). Names stay in the private workspace.
- Connect Gmail (OAuth or IMAP) and an AI engine (API key or MCP) on the owner's machine:
  `./run.sh` (Git Bash on Windows works), then follow `docs/connections.md`.
- Calibrate templates against the company's local quotation folder.
- Update the PR description.
- GitHub may still keep old SHAs of a squashed early commit that held real names; only GitHub
  support can purge them.

## Rules for whoever continues

Use `@/ui` components and `lib/labels.ts` wording; link only via `lib/routes.ts`; desktop + phone
(390 px) for every screen; loading / empty / error states; AI never writes prices; approvals and
sending are explicit human gates; never put real customer data in code, tests or screenshots (the
repository is public). Use `OmitKnown` (not `Omit`) on API entity types.
