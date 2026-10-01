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

## Rendered UI review — pinned fa2dbfde (1 October 2026)

I have now reviewed actual application captures and source at `fa2dbfdeead0bebe5871d939e341124c9346d825`. This supersedes the earlier statement that only concepts had been reviewed. The visual foundation is good; retain the current visual system. Prioritize workflow completion and phone usability before cosmetic redesign.

Coverage: 58 unique static images (55 UI captures plus 3 PDF pages), selected from the 96 desktop/96 phone index; three isolated live routes using fictional data. The frontend build passed. This is not full route, accessibility, mailbox, physical-phone, approval or send acceptance. Assessment A was recorded independently before detector evidence was incorporated.

### Highest priorities

1. **P1: unmatched mail has no human recovery action.** The live fictional Arabic enquiry says it is not linked to a project, with no choose/create project or enquiry action. Add that action beside the status. Reply/forward remain missing. Evidence: [project-link panel](https://github.com/Mohamed3042/engineering-smart-system/blob/fa2dbfdeead0bebe5871d939e341124c9346d825/frontend/src/features/inbox/EmailPage.tsx#L36) and [header actions](https://github.com/Mohamed3042/engineering-smart-system/blob/fa2dbfdeead0bebe5871d939e341124c9346d825/frontend/src/features/inbox/EmailPage.tsx#L162).
2. **P1: phone automation cards imply automatic mail triggering.** `new_email` is shown as New mail, but the working trigger is Run now. Desktop has the explanatory hint; phone loses it. Label both “Manual — Run now” until event triggering works. Workflow creation/editing and interval editing are also missing. Evidence: [trigger metadata](https://github.com/Mohamed3042/engineering-smart-system/blob/fa2dbfdeead0bebe5871d939e341124c9346d825/frontend/src/features/automations/lib.ts#L50), [phone card](https://github.com/Mohamed3042/engineering-smart-system/blob/fa2dbfdeead0bebe5871d939e341124c9346d825/frontend/src/features/automations/AutomationsPage.tsx#L76) and [scheduler](https://github.com/Mohamed3042/engineering-smart-system/blob/fa2dbfdeead0bebe5871d939e341124c9346d825/backend/ess/automations/runner.py#L290).
3. **P1: disabled templates can still be selected during drafting.** UI choice filtering checks availability, but the shared drafting path applies the selected setting without checking enabled. Enforce this in the selector for defaults and learned rules, with a clear fallback and preserved historical drafts. Source-confirmed, not dynamically reproduced: [drafting selector](https://github.com/Mohamed3042/engineering-smart-system/blob/fa2dbfdeead0bebe5871d939e341124c9346d825/backend/ess/pipeline/drafting.py#L89).
4. **P1: source inspection needs practical navigation.** Width-fit pages are too small for detailed phone checking; BOQ page references are plain text. Link facts to their exact page, support zoom/fullscreen or opening the original, and keep fact/source context close on desktop. Evidence: [viewer](https://github.com/Mohamed3042/engineering-smart-system/blob/fa2dbfdeead0bebe5871d939e341124c9346d825/frontend/src/features/projects/FilePage.tsx#L195) and [source-page references](https://github.com/Mohamed3042/engineering-smart-system/blob/fa2dbfdeead0bebe5871d939e341124c9346d825/frontend/src/features/projects/FilePage.tsx#L330).
5. **P2: phone task order and local tabs need attention.** The quote editor capture corresponds to 7,272 CSS pixels; setup blocks and statistics precede common actions elsewhere. Collapse optional/completed content and provide clear section navigation, while keeping complete phone functionality. Reveal the active local tab and add an overflow cue; hidden scrollbars currently hide available sections. Evidence: phone states 11, 22, 26, 31, 82 and 84; [shared tabs](https://github.com/Mohamed3042/engineering-smart-system/blob/fa2dbfdeead0bebe5871d939e341124c9346d825/frontend/src/ui/Tabs.tsx#L43).

### Follow-up gaps

- Failed secondary file-status queries fall through to “Not saved”/“Not queued.” Show Status unavailable plus Retry; do not turn request failure into a business fact. [file-status display](https://github.com/Mohamed3042/engineering-smart-system/blob/fa2dbfdeead0bebe5871d939e341124c9346d825/frontend/src/features/inbox/EmailMessage.tsx#L108).
- Long extraction can outlast polling; failed email attachments lack actual retry. [polling](https://github.com/Mohamed3042/engineering-smart-system/blob/fa2dbfdeead0bebe5871d939e341124c9346d825/frontend/src/features/projects/api.ts#L139) and [attachment recovery](https://github.com/Mohamed3042/engineering-smart-system/blob/fa2dbfdeead0bebe5871d939e341124c9346d825/frontend/src/features/projects/tabs/InputsTab.tsx#L203).
- A null mailbox can leave Send enabled; server failure remains safe. Offer connection setup before the dialog. [send precondition](https://github.com/Mohamed3042/engineering-smart-system/blob/fa2dbfdeead0bebe5871d939e341124c9346d825/frontend/src/features/quotations/editor/ApprovalPanel.tsx#L163).
- Associate shared Field help/errors with controls through IDs and aria-describedby; an initial alert alone is insufficient. [shared form field](https://github.com/Mohamed3042/engineering-smart-system/blob/fa2dbfdeead0bebe5871d939e341124c9346d825/frontend/src/ui/Form.tsx#L22).
- “Mark resolved” leaves a link Rejected; preserve the difference between obtained another way and deliberately rejected. [resolution action](https://github.com/Mohamed3042/engineering-smart-system/blob/fa2dbfdeead0bebe5871d939e341124c9346d825/frontend/src/features/projects/tabs/inputLinks.tsx#L70).
- Isolate Arabic sender and LTR timestamp so the reading order remains intact. [sender/date metadata](https://github.com/Mohamed3042/engineering-smart-system/blob/fa2dbfdeead0bebe5871d939e341124c9346d825/frontend/src/features/inbox/EmailPage.tsx#L159).
- Explain confidence dimensions and source authority; neutral confidence styling should not collide with red blocker meaning or expose “weight 0.0.” Add missing intent/work-type inbox filters using the existing filter pattern.
- Give reference photos thumbnails and actual rendered-position feedback; show stamp position against the real page.

### Capture inconsistencies and corrections to the earlier handoff

- State 74 shows proposed 12 November as current while asking to confirm a change from 30 October. This is an inconsistent sample/capture, not proof of backend auto-application. Show confirmed and proposed dates separately.
- State 22 marks drawing revision Checked but says no revision is recorded. Evidence rendering is already implemented; capture it with a recorded file/revision or an explicit not-applicable reason.
- The draft PDF watermark names engineer approval while its paired preview lists pricing/requested-term blockers. Use a generic not-approved watermark or derive the reason from current blockers.
- **Default paper already exists** in workspace quotation defaults and drafting reads it. Improve its discoverability from Papers; a new endpoint is not established as necessary.
- **On-page photo placement already exists** and falls back to the annex if no space fits. Do not treat placement as wholly unimplemented without a reproducer.
- The blank headless PDF pane and specimen letterhead are documented evidence/calibration limits, not new UI defects.
- The unconnected fixture’s generic From label does not establish a connected-sender defect. Verify a connected fictional account identity before acceptance.

### Verification limits

CLI detector: exit 0, `[]`; scan directory inventory 187 source files. The live detector logged 12/5/3/3 occurrences across Home, desktop Automations, narrow Automations and narrow Arabic email. These include duplicated/unconfirmed warnings, not 23 verified defects: internal scroll regions, compact noninteractive chips and Sonner toast animation need adjudication.

The requested 390px live viewport measured 585px. Browser screenshots timed out; live evidence is DOM/state/console. Committed 390px captures supply phone visual evidence. Full-page captures expand viewport height and do not establish fixed controls, keyboard behavior or offline/error recovery in a normal phone viewport. No actual mail, upload, approval or send was exercised.

All review servers were stopped. Browser tab close/reset was denied, so explicit browser cleanup was not confirmed. No application source was changed by this review.

Suggested implementation order: intake recovery and truthful automation/template behavior; source inspection; phone task order; shared recovery/accessibility/RTL polish.

