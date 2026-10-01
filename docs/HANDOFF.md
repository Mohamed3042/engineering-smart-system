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

## Known gaps (found while building the screens)

- The `new_email` trigger never fires: "New enquiry intake" runs only on a schedule or "Run now".
- `GET /dashboard` has no pending-download list (Home derives it from blockers with `link_id`).
- `GET /emails` has no intent or work-type filter; `GET /emails/{id}` has no link/attachment status
  (the email page reads it from the project).
- Links have no "resolved" status (Mark resolved = reject); failed attachments are never retried.
- No job progress endpoints (download, extraction, analysis, exam): screens poll.
- `GET /ai/policy` does not return the hard floor; `connections/policy.ts` mirrors it for the form
  only (the backend still enforces it).
- No endpoint lists mailbox labels/folders: the scan scope takes typed search queries.
- The Google OAuth callback always returns to `/settings/connections?gmail=`.
- Template `enabled` is not enforced when a draft picks its template; no endpoint sets the default
  paper; photos placed on a page still print in the annex.
- Not built: workflow editing / new automation, reply and forward, link an email to a project.

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
