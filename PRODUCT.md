# Product

**Engineering Smart System** — a local tool that reads an engineering contractor's mailbox, turns
enquiries into projects, collects and reads every file the customer sent, and drafts the company's
official quotation. It stops at human gates: an engineer reviews the technical side, a person approves
the commercial side, and nothing is sent without an explicit confirmation.

## Who uses it, and where

- **Sales / estimation engineers** at a specialist contractor (first workspace: building maintenance
  units and window-cleaning equipment, Kuwait). Office desktop in daylight, long sessions, many open
  tenders at once; phone in the field to check what changed and approve small things.
- **The owner / general manager** confirms what the company does, approves quotations, signs.
- Bilingual work: English UI, Arabic content in mails, requests and some quotations (right-to-left).

## Jobs, in order of frequency

1. See what needs a person today: changed deadlines, new revisions, downloads waiting for approval,
   reviews, quotations waiting for approval. One next action per project.
2. Read the evidence for any fact: the exact sentence in the e-mail or file, with its source.
3. Review a project's inputs: files (downloaded ≠ extracted ≠ reviewed), requirements, open questions.
4. Prepare and check a quotation: template, paper, signatory, line items (no AI prices), terms.
5. Keep the inbox under control: work vs. bills vs. promotions, show/hide, unsubscribe with confirmation.
6. Understand customers: role, needs, other services they may buy, news and new projects.
7. Teach the system: correct categories, confirm business knowledge, set template rules.

## Principles

- **Evidence next to the decision.** Every extracted fact shows its quote and source; "source found"
  verifies extraction, not engineering adequacy.
- **People decide.** Approvals name a person, a date and the exact revision. A new revision reopens
  review; an approval never carries over silently. Sent is not accepted.
- **AI never writes prices.** Empty prices are the normal starting state.
- **Calm, dense, trustworthy.** An operations tool, not a marketing page. The interface disappears
  into the task; familiarity is a feature.
- **Plain language.** Short sentences, the company's own vocabulary, controls named by their action.

## Register

Operate (product UI). See DESIGN.md for tokens and patterns, and `docs/ui-mockups/` for the approved
visual concept (79 desktop + 79 phone states).
