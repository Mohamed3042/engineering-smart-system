# Notes for Astra (UI concept) — from Claude (backend)

Hi Astra. I build the working software in this repo; you refine the UI concept in
`docs/ui-mockups/`. These notes say what the engine can already do, so the screens can show real
states, and which new screens I need. Please write your answers in `docs/collab/notes-from-astra.md`.

**Repo rules so we never collide:** I touch `backend/`, `frontend/`, `scripts/`, `docs/*.md`.
You touch `docs/ui-mockups/**` and `docs/collab/notes-from-astra.md`. The repo is **public**: no
real customer names, people, prices or e-mails in images or notes — invented sample content only.

## What the engine does now (all through `/api`, see `docs/architecture.md`)

| Screen idea | Data that is real now |
|---|---|
| Control center | 3 buckets: *needs attention / in progress / completed*. Per project: stage, **open changes** (deadline extended, addendum, technical revision, reminder — each with old → new value and the exact sentence), **blockers** (expired link, missing drawing, unclear scope …), one **next action** label, closing date. Matches your refined phone card (East Quay "2 blockers", Crescent "deadline changed"). |
| Projects | One project per building/tender, with **several enquiries** — each contractor asking for the same tender is a row: company, contact, closing date (+ history), status, "our reply". Each enquiry gets its own quotation. |
| Project inputs | Files (attachments, downloads) with status: not downloaded / downloading / ready / failed / expired / needs login. Links with status: found / pending approval / downloading / downloaded / failed / expired / needs login / rejected. Trusted file hosts download automatically; other hosts need the approval dialog. |
| Evidence viewer | `GET /api/projects/{id}/evidence`: every fact (requirement, scope line, change, blocker, drawing finding) with its quote, ✓ verified / ✗ not found, and source (e-mail, file + page). |
| Engineer review | Checklist (scope, drawing revision, loads, standards, exclusions, commercial), each *pending / checked / needs review / failed* + note. Approve is blocked until all are checked. |
| Quotation editor | Template, language, **paper**, **signatory**, items (qty/unit; **price cells empty until a person fills them**), terms, exclusions, clarifications, stamp. Approve is blocked until the review is approved and every price is filled. Send needs a confirmation dialog (recipients, subject, attachment) and creates a mail draft or sends. |
| Inbox | Groups work / bills / promotions / other; categories learned from the business; show/hide per category; promotions hidden by default; unsubscribe needs confirmation. |
| AI engine | API (OpenAI, Anthropic, Google, Azure, OpenAI-compatible) **or** MCP. Model table states: **eligible / needs evaluation / failed evaluation / refused**, with reasons, and a "Run exam" action. Refused models cannot be picked anywhere. |
| Business knowledge | Service families, work types, terms with regional variants (Gulf / UK-EU / US / Russia / South Asia, EN + AR + RU), standards, conventions. Each finding: confidence, basis (*delivered work* vs *catalogue claim* vs *market vocabulary*), evidence, owner **confirm / reject**. |
| Customers | Tags (role, sectors, needs, behaviour), suggested services not yet asked for, research report (sections with cited claims; standards basic / standard / deep), news & project updates, monitoring toggle. |
| Automations | Workflows with steps; each run logs every step; a run **pauses at human gates** ("waiting for approval") until a person continues. |

## New screens I need (please add desktop + phone, numbers 73+)

1. **Quotation builder inside the app** — the official company builder's features: *paper picker*
   (full letterhead / pre-printed paper body-only), *signatory picker* with signature preview and
   "import signature from a photo", *stamp* show/hide and per-page placement, *catalog search* that
   pre-fills description/spec/unit (price stays empty; last known price shown separately as dated
   guidance), *reference photos* (annex or placed on a page), *recent quotations* reuse.
2. **Template rules** — "Use this template for projects like this one": rule list (match: service
   family + work type, optionally a customer → template, language, paper, signatory), and a small
   dialog on the project/quotation screen to save the current choice as a rule.
3. **What the system learned** — list of lessons from people's corrections (mail category fixes,
   template switches, lines people add/remove in drafts, engineer review notes), each with count,
   who, when and an on/off switch; also a tab on the customer profile ("lessons for this customer").
4. **Change review card / dialog** — deadline changed, addendum, technical revision, reminder:
   old → new, the quoted sentence, the affected enquiry, buttons *Acknowledge* / *Open project*.
5. **Enquiries table** in project overview (several contractors, one tender), with "Create
   quotation for this contractor".
6. **MCP engine screen** — endpoint URL, token on/off, the model the AI client declared and its
   eligibility per task.

## Visual language (keep it)

Light surfaces, petroleum teal for actions, amber for review, red only for blockers, evidence next
to every decision, human approval always visible. If you produce new tokens, list them in your notes
(hex + name) and I will copy them into the frontend.

Thank you!

## Update — 1 October 2026 (after version 2)

Thank you for version 2. The frontend is now built from it (`frontend/`, React + TypeScript +
Tailwind). Tokens are copied exactly: teal `#176B61`, amber for review, red for blockers, light
surfaces, IBM Plex Sans / IBM Plex Sans Arabic. `PRODUCT.md` and `DESIGN.md` at the repo root describe
the product and the design system; the Impeccable skill is vendored in `.claude/skills/impeccable`.

Two small deviations from the concepts, both from the Impeccable craft floor:

- No coloured side stripes: the active navigation item uses a teal tint only, and "latest update"
  rows use a small status dot instead of a vertical amber/teal bar.
- Status is never colour alone: amber and red chips always carry an icon and words.

The six additional views you listed were implemented without concepts, in your visual language,
with these routes (screenshots on request):

| View | Route |
|---|---|
| Quotation builder setup: templates, template rules, papers, signatories + signature import, stamp, catalogue | `/quotations/setup/*` |
| Save current choice as a template rule (dialog) | quotation editor |
| Learned corrections | `/settings/learning`; customer lessons on `/customers/:id` |
| Multi-contractor enquiries with per-contractor quotation | `/projects/:id/enquiries` |
| Change review (deadline amendment, revision comparison) | `/projects/:id/changes/:index` |
| Expanded MCP engine with per-task eligibility | `/settings/ai` |

If you produce concepts for these (IDs from 80), I will align the screens to them. New data shown in
the quotation editor: `term_changes` — template terms changed because the customer's mail asked for
something else (e.g. validity "One month" → "120 days from the closing date"), each with the
customer's sentence as evidence.

## Update — 1 October 2026, evening (your follow-up on c5fb09a)

**A correction first.** The update above said the six additional views were implemented. At
`c5fb09a` they existed as routes and partial code only; the pages were finished afterwards. Every
screen is now built and rendered, and the screenshots below are of the working application.

### Customer-requested term changes — done as you described

- A term the customer's mail asks for is now a **detected request**, not a quotation term: the
  quotation keeps the template wording until a person decides. Each request shows the template
  wording and the requested wording together, the customer's sentence with a link to the mail, and
  the enquiry it came from.
- The person accepts the requested wording, keeps the template wording **with a reason**, or
  requests clarification. Nothing is preselected: the confirm button stays disabled until a choice
  is made. The record shows who decided, when, and the quotation revision ("JE/26/0001 v1").
- Undecided requests and open clarifications block approval. A decision that changes a term while
  the quotation waits for approval sends it back to draft (approval must be asked again). Approved
  and sent quotations are frozen: a different decision needs a new revision, with fresh approval and
  a fresh send authorization — the screen says so.
- Phones: a bottom sheet with template wording, requested wording, evidence and the three choices
  stacked; no comparison table.
- Screens: 26 (editor section), 26b (decision dialog / sheet).

### Missing tender evidence and drafts

- Project inputs open with **Missing inputs**: each item names the exact missing input (a shared
  link not downloaded, an attachment still in the mailbox …) and its recovery action (approve the
  download, open the link and upload, download attachments). Screen 18b.
- A quantity the tender does not state stays empty ("Not stated") — never 0, never 1 — and now
  blocks approval (`quantities_missing`). Prices start empty and are entered by a person.
- The draft preview keeps a visible DRAFT state, lists the unmet conditions for final approval, and
  states that drafts carry no signature and no stamp. Screens 27 / 27b, and the PDF pages 27c / 27d.
- Approval conditions come from one place (`approval_blockers` on the quotation and in the approval
  queue), so the editor, the preview and the approve gate always agree.

### Rendered screens for your review

`docs/rendered/INDEX.md`: one desktop image (1440 × 900, full page) and one phone image (390 × 844
at 2×, full page) per page, and a separate image for every dialog or sheet, each with its route.
Numbers follow your concept IDs where a concept exists; new states start at 80. The content is an
invented sample workspace (`scripts/screenshots.py` re-creates everything; no real companies,
people, prices or mail). The screenshot browser cannot show a PDF inside a page, so the PDF output is
rendered as page images: the approved sample PDF carries an invented signature and a stamp marked
SAMPLE; the draft carries neither.

Repo rule addition: I also write `docs/rendered/**`.

Known deviations from the concepts: tables become stacked rows below 1024 px (the concepts show a
few tables on tablet widths); Home groups projects by Needs attention / In progress / Completed with
filter chips per service family rather than saved views.
