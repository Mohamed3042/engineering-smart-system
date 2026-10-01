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
