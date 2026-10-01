# Completion evidence

This continuation completes the interrupted Inbox/Automations, Projects/source viewer and
Quotation editor work on `codex/complete-review-ui`, including Opus's five already-pushed commits.
The source retains the established design system and follows the vendored Impeccable guidance.

Project/company rows start closed; names reveal details and a labelled arrow opens the project.
Quotations expose paper, signatory/signature, catalogue prefill, reuse, template rules and reference
photos. Stamp and photo placement can be inspected on real rendered PDF pages. Pending terms
come first; completed decisions retain accessible history. Prices and approval remain human decisions.

## Checks

| Check | Result |
|---|---|
| Full backend suite | 618 passed, 58.90 seconds |
| TypeScript and Vite production build | Passed after the final source changes |
| Inbox/workflow browser checks | 16 passed |
| Quotation browser checks | 27 passed |
| Final Projects browser checks | 34 passed, no writes |
| Final project-type and unsaved-workflow controls | 8 passed, no writes |
| Viewport capture collection | 64 passed, zero failures or JavaScript exceptions |
| Whitespace/diff check | Passed |

The browser checks use Chromium at 1440 x 900 and 390 x 844. The collector checks the actual
viewport and document width. [The screenshot index](INDEX.md) links all 32 screen/form states for
both viewports; ten supplemental full-page images preserve the rest of selected long pages.
[The capture report](verification.json) records routes, dimensions and failures.

Backend regressions cover preserved source bytes/evidence when refiling mail, outbound enquiry
membership, downloaded link-owned files, distinct same-named attachments, workspace boundaries,
required review checks, N/A reasons and current customer/service/work-type correction memory.

## Local originals and limits

Original Medmack letterhead and body-only paper, watermark, stamp, signature and scaffolding
catalogue are available in the separate private local owner workspace. Its original paper is the
default. No originals, owner database or real company/customer information are included here.
Committed images use invented companies, people, prices and visibly fictional assets.

Correction feedback is stored locally and scoped to the applicable workspace/customer/service/work
type; it is not model-weight training. Live AI extraction, real mailbox delivery, installed mail
applications, the company Mac and physical phone gestures were not exercised. No owner quotation
was signed or sent. A sample preview server is not persistent deployment; the repository's
`Start.cmd` remains the Windows launcher.

Next AI-quality work: compare drawing/BOQ readings with their exact original page before relying
on the extracted quotation scope. See [the handoff](../HANDOFF.md) and
[Astra's notes](../collab/notes-for-astra.md).
