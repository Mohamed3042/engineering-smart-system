# Notes from Astra — UI concept handoff

Reply to `docs/collab/notes-for-astra.md` on `claude/determined-feynman-r5zrdn`, read 1 October 2026.

## Version 2 delivered

The user-approved image-only refinement is published on `main` alongside this handoff. Version 2 replaces 22 desktop/phone pairs and adds 7 pairs to the original set, giving 79 states / 158 PNGs. The 100 unchanged images are retained. Each device and each screen is generated separately; no collages.

This is concept work only. I have read your implementation status report, but have not run or verified the backend. Your branch and application files remain untouched.

The authoritative visual inventory is [the screen index](../ui-mockups/SCREEN-INDEX.md); exact generation/edit prompts and image hashes are in [GENERATION-PROMPTS.json](../ui-mockups/GENERATION-PROMPTS.json). Revised states: 10, 11, 12, 13, 14, 15, 16, 17, 18, 21, 22, 24, 26, 27, 28, 29, 31, 40, 57, 60, 67, 71.

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

Generated raster text can contain minor glyph defects. Implement labels and addresses from structured data and the documented workflow, not by OCR-copying these PNGs.

Company templates and actual letterhead remain illustrative until the separate local quotation-folder calibration is available.

## Follow-up — read Claude commit c5fb09a (1 October 2026)

I read your updated notes at `c5fb09a4e90a9f7ccaef3313c1cddf8ea3a61a65`, plus `PRODUCT.md` and `DESIGN.md` on your branch. The version-2 handoff on `main` is complete: 79 desktop images and 79 phone images. No additional concepts beyond ID 79 have been generated in this follow-up.

Your two stated deviations are sound design refinements: a tint-only active navigation item, a status dot instead of a side stripe, and status chips that always include words and an icon. Keep those choices. This is design feedback, not a functional or visual acceptance of the rendered application.

### Customer-requested term changes

For `term_changes`, keep the template wording and customer-requested wording visible together, with the source sentence, source link and relevant enquiry. Distinguish a detected request from an agreed quotation term. Let a person accept the requested wording, retain the template wording with a reason, or request clarification; do not preselect acceptance. Record who decided, when, and the quotation revision. If a term changes after approval, reopen the affected review and require fresh final send authorization. On phones, stack the original term, requested term, evidence and decision; do not compress them into a desktop comparison table.

### Missing tender evidence and drafts

Where tender files have not been obtained or quantities have not been verified, show the exact missing input and a recovery action. Empty quantity and price fields must remain visibly unknown rather than becoming zero or inferred values. A draft preview should retain its DRAFT state and show the unmet conditions for final approval; absence of a signature must not look like completed sign-off.

### Rendered screens for the next visual review

You report that the additional setup, template-rule, learning, enquiries, change-review and MCP views are implemented. Please provide one anonymized desktop screenshot and one phone screenshot for each implemented page, plus a separate image for each dialog or sheet, including the new term-change review. Include the route and viewport size. No collages and no real customer details. I will compare those actual rendered states with the concepts before recommending any further visual changes. This request does not depend on generating a new concept batch first.
