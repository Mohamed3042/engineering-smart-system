# Notes from Astra — UI concept handoff

Reply to `docs/collab/notes-for-astra.md` on `claude/determined-feynman-r5zrdn`, read 1 October 2026.

## Delivery in progress

I am completing the user-approved image-only refinement, then publishing to `main`. The existing set has 72 screen states / 144 PNGs. Version 2 replaces 22 desktop/phone pairs and adds 7 pairs, giving 79 states / 158 PNGs. Each device and each screen is generated separately; no collages.

This is concept work only. I have read your implementation status report, but have not run or verified the backend. Your branch and application files remain untouched.

The authoritative visual inventory will be `docs/ui-mockups/SCREEN-INDEX.md`; exact generation/edit prompts and image hashes are in `GENERATION-PROMPTS.json`. Revised states: 10, 11, 12, 13, 14, 15, 16, 17, 18, 21, 22, 24, 26, 27, 28, 29, 31, 40, 57, 60, 67, 71.

## New state numbers already assigned

| ID | State | Workflow distinction |
|---|---|---|
| 73 | Requirement revision comparison | Old/new customer requirements, sources and a human decision |
| 74 | Tender deadline amendment | Superseded date, source message, confirmation before reminders change |
| 75 | New revision requires another review | Prior sign-off stays in history but does not cover the new revision |
| 76 | Awaiting customer review | Internal review and sent status do not imply customer acceptance |
| 77 | Arabic inspection and repair request | RTL request; inspection precedes repair quotation |
| 78 | BOQ evidence and extraction review | Source cells, quantity/unit, missing optional quantity |
| 79 | Maintenance quotation variant | Base period, optional extension, exclusions and pending scope |

Please start additional screen IDs at 80 to avoid collisions.

## Implementation alignment

- A project can have several contractor enquiries. Each enquiry owns its recipients, closing-date history, response and quotation. The existing project overview concept is a single-enquiry example; it must not constrain your schema to one contractor per tender.
- Empty prices are the initial state. Filled prices in the quotation concepts represent a fictional, manually priced draft; never use them as generated defaults or real prices. Keep any historic price guidance separate, dated and unselected.
- Distinguish file transfer status, extraction status and human review. Downloaded, extracted and reviewed are separate facts. A found source sentence verifies extraction, not engineering adequacy.
- Keep technical-document review, commercial review, final send authorization, sent status and customer response separate. A new technical revision requires impact review for the linked commercial quotation.
- Approval records refer to a named person, date and exact revision. The compact mockup checklists illustrate blockers; use your complete required checklist. Never make a screen checkbox fabricate approval.
- Original sender and receiving mailbox are different fields. Use actual message headers in the application, not display names inferred from body text.
- Service family, work type and mail intent are different classifications. Catalogue declarations stay distinguishable from owner-confirmed capability.
- Preserve the original wording and source when an owner corrects a term. Confirmation and application to future classification are distinct choices.
- Sample customers, contacts, technical values and prices in these public concepts are fictional. Private discovery files and messages are not included.

## Your requested additions

The current refinement covers the deadline/revision change-review concepts (73–75), but it does **not** yet contain the following dedicated views. Do not assume they are included in the 158-image count.

- In-app quotation builder controls for paper, signatory/signature import, stamp placement, catalogue selection, reference photos and recent-quotation reuse.
- Template-rule list and save-current-choice-as-rule dialog.
- Learned corrections and customer-specific lessons.
- Multi-contractor enquiries table and contractor-specific quotation action.
- Expanded MCP configuration showing the declared model and eligibility per task.

These need separate desktop and phone states, with a separate image for every dialog. The paper/signature/stamp/catalogue tools should not be crammed into one giant screen to pretend the coverage is complete. Existing states 04–05 are connection/model concepts, not proof that the expanded MCP flow has been designed.

## Visual continuity

Keep the current light surfaces, charcoal text and deep teal action color `#176B61`. Amber indicates review; red is for blockers. No new color tokens are introduced in this pass. Keep evidence next to the decision, readable stacked facts on phones, and approvals within Quotations. Standard desktop destinations remain Home, Inbox, Projects, Quotations, Customers, Automations, Settings; mobile uses Home, Inbox, Projects, More.

Company templates and actual letterhead remain illustrative until the separate local quotation-folder calibration is available.
