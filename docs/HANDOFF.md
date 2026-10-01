# Handoff — 1 October 2026

Working branch: `codex/complete-review-ui`, continuing Opus's completed backend work and the three
interrupted frontend tasks. The integrated implementation, production build, backend suite and
desktop/phone captures have passed. This branch is prepared for review against `main`.

The failed workers' edits remained in their unavailable VM. This continuation reconstructed their
frontend work from the pushed branch, backend endpoints, review notes and visible task transcripts;
it does not claim to have recovered those unpushed files.

Read `PRODUCT.md`, `DESIGN.md`, `docs/architecture.md` and
`docs/collab/notes-from-astra.md` before changing the product. Preserve the existing light surfaces,
teal actions, evidence beside decisions and explicit human approvals.

## Completed implementation

- **Inbox:** file a message and its conversation under a selected project and enquiry, or open a
  project with editable prefill. The unmatched-message action is visible in the header. Reply and
  forward prepare editable drafts for the person's mail application or clipboard; the workspace
  does not send them. Sender names, addresses and dates are isolated for Arabic/LTR reading order.
  Purpose and work-type filters survive navigation in the URL. A failed status request says
  **Status unavailable**, with Retry; failed files and links have recovery actions.
- **Automations:** create, edit, reorder and delete custom workflows, change their intervals and
  supported step settings, and retain the required engineer-review gate. List and detail screens
  use the server's actual `trigger_status`, including on phones. New-mail workflows start after a
  mailbox check discovers inbound mail when the background service and mailbox are available.
  A configured trigger alone does not prove that automatic runs are active.
- **Projects and source files:** page links and BOQ source jumps, zoom and fullscreen viewing,
  failed-attachment retry, links obtained another way, and polling that follows actual background
  work. Change review keeps a proposed closing date separate from the confirmed date and history.
  Checklist **Not applicable** and unsupported revision checks need a recorded reason. Removing
  required checks cannot bypass approval. The phone review puts decisions before completed history.
  Project briefs and project/company title rows open collapsed.
- **Quotations:** phone section navigation and collapsed sections; disabled templates cannot be
  selected for new drafts. Paper and signatory selection, signature import, stamp placement,
  catalogue description/specification/unit prefill, reference photos, reuse and template rules are
  integrated into the editor. Stamp/photo placement uses rendered source pages. Drafts omit stamps
  and signatures. Prices remain empty until a person enters them; sending needs the appropriate
  mailbox connection and explicit approval.
- **Relationship integrity:** refiling preserves downloaded attachment/link files and their source
  evidence, binds outbound replies to the destination enquiry, and retains distinct same-named
  attachments. Email-based project creation requires an explicit work type. Unsaved workflow edits
  disable Run now. Pending quotation term decisions appear before collapsed completed decisions.
- **Shared surfaces:** active tabs stay in view, overflow is indicated, field help is associated
  with its input, and confidence uses neutral styling. Home and customer summaries use compact
  phone ordering; company/project names open their details through concise rows.
- **Corrections and template choices:** company/customer-scoped local memory records corrections
  and guides later categorisation and template selection. Lessons and rules have review controls.
  This is stored correction feedback, not model-weight retraining or evidence of silent neural
  reinforcement learning.

## Validation and evidence

The final integrated backend suite passed **618 tests in 58.90 seconds**, up from the reproduced
596-test baseline. TypeScript checking and the Vite production build passed after the final UI
changes. Regression tests cover enquiry/file refiling, same-named attachments, required review
checks and customer/service/work-type memory boundaries.

Headless Chromium checks passed at **1440 × 900** and **390 × 844**: 16 Inbox/Automation checks,
27 quotation checks and 34 read-only Projects checks, with no browser exceptions. They cover
project/enquiry filing, workflow CRUD, truthful triggers, status recovery, disabled templates,
stamp/photo saved-page tools, section navigation, source zoom/page/fullscreen and review guards.
Eight final read-only control checks additionally verified explicit project work-type selection
and disabled workflow runs while editing. Reports live in ignored `data/`.

The authoritative new screenshots are indexed in `docs/ui-review/INDEX.md`. The final collector
passed **64 viewport captures with zero failures**, including workflow create/edit forms, the
project picker/new-project form, reply/forward sheets and quotation setup/placement controls.
`docs/ui-review/verification.json` records each route, viewport and page-width measurement.
Selected long pages also have full-page captures. Older `docs/rendered/` captures remain historical.

Only invented companies, people and sample assets may appear in committed screenshots. Browser
emulation does not verify physical phone gestures, installed mail applications, real mailbox
delivery, live AI extraction quality or operation on the company's Mac.

## Private assets and owner setup

The recovered original Medmack Quotation Builder contains header/footer, watermark, stamp, the
original signatory's signature and the scaffolding catalogue. They are configured separately in ignored
`data/private/` and the owner workspace through `scripts/import_letterhead.py`; the fictional review
fixture does not use them. Keep genuine company papers, signatures, quotations, customer mail
and downloaded tender files out of the public repository and review fixture. Sample papers and
signatures in screenshots are invented; do not present them as the company's originals.

Owner setup still needs its own verified mailbox/AI connection, any inaccessible tender downloads,
and calibration against the owner's quotation corpus. A temporary review server is not a persistent
desktop installation. Source-document accuracy is the recommended next AI quality check: verify a
drawing or BOQ reading against its original page before trusting the resulting quotation scope.

## Rules for whoever continues

Use `@/ui`, `lib/labels.ts` and `lib/routes.ts`; test desktop and phone states, with loading, empty
and recovery paths. Never generate prices automatically. Approval names the person, date and exact
revision; revisions reopen review and do not inherit send authorization. Keep proposed customer
terms pending until a person decides. Use `OmitKnown` rather than `Omit` on API entity types.
