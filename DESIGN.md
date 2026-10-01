# Design system

Code: `frontend/src/index.css` (tokens), `frontend/src/ui/` (components), `frontend/src/lib/labels.ts`
(status vocabulary). Visual reference: `docs/ui-mockups/` (version 2). Design rules: the vendored
Impeccable skill in `.claude/skills/impeccable` (Operate register, craft floor).

## World

Light surfaces for daylight office work, charcoal text, one deep teal for action. Amber means "waits for
a person". Red means "blocked". Nothing else is coloured. Calm, dense, exact — like a well-kept
engineering file.

## Colour tokens (Tailwind names)

| Token | Use |
|---|---|
| `canvas` #F6F7F6 | app background |
| `surface` #FFFFFF | panels, sidebar, dialogs |
| `sunken` #F3F5F4 / `hover` #EEF1F0 | table headers, quotes, hover |
| `line` #E2E6E4 / `line-strong` #CDD3D0 | borders, input borders |
| `ink` #1C2321 / `ink-2` #4A5552 / `ink-3` #5F6B67 | text: primary / secondary / muted (all ≥4.5:1) |
| `brand` #176B61 (+ `-hover`, `-press`, `-soft`, `-line`, `-ink`) | primary actions, current selection, done/approved |
| `review` #7A4A00 on `review-soft` #FCEFD9 (`review-line`, `review-mark`) | waits for a person: review, approval, confirmation |
| `block` #B3261E on `block-soft` #FCE9E7 (`block-line`) | blockers, failures, destructive actions |

No other hues. No gradients. Status is never colour alone: amber and red chips carry an icon and words.

## Type

IBM Plex Sans (self-hosted) for everything; IBM Plex Sans Arabic for Arabic (`dir="rtl"` on Arabic
content blocks, see `isRtl()`); IBM Plex Mono only for codes, hashes and file paths. Fixed rem scale
(base 15px): xs 13 · sm 14 · base 15 · lg 17 · xl 20 · 2xl 24 · 3xl 30 · 4xl 36. Page titles 28px on
phones, 36px on desktop, bold, tracking −0.01em. Numbers in tables use `tabular`.

## Layout

- Desktop (≥1024px): fixed sidebar (workspace switcher, search ⌘K, 7 destinations, notifications,
  account). Content in `<Page>` (max 1360px; `medium` 1040px; `narrow` 760px for forms).
- Phone: top header (workspace, search, bell) and bottom tabs Home / Inbox / Projects / More.
  Tables become stacked `ListRow`s; key/value facts stack; primary action full width at the bottom
  of each card.
- Spacing: tight inside groups (8–12px), generous between sections (24–32px), more space above a
  heading than below it.

## Components (use these; do not restyle per screen)

`Button` (primary / secondary / ghost / danger / quiet-danger / link; sm md lg) · `IconButton` (always
labelled) · `Chip` / `StatusChip` / `Count` / `Dot` / `Confidence` · `Panel` + `PanelHeader` +
`PanelBody` · `Section` · `PageHeader` · `Page` · `KeyValue` · `Banner` · `Timeline` ·
`CollapsibleSection` · `Stepper` · `ProgressBar` · `Avatar` · `Table` `THead` `TBody` `TR` `TH` `TD`
`RowChevron` · `ListRow` · `Pager` · `Tabs` / `TabsContent` / `LinkTabs` / `Segmented` / `FilterChips` ·
`Field` `Input` `Textarea` `Select` `SearchInput` `Checkbox` `Switch` `ChoiceCards` `DateInput`
`DateRangePicker` · `Dialog` / `ConfirmDialog` / `Drawer` / `Popover` / `Menu` / `Tooltip` ·
`EmptyState` / `ErrorState` / `InlineError` / `LoadingRows` / `Skeleton` / `QueryState` · `EvidenceQuote`
/ `EvidenceList` / `VerifiedMark` · `toast` / `toastError`.

## Patterns

- **Next action** — one solid teal button per row/card naming the action ("Review R03", "Approve
  download"). Secondary actions are secondary/ghost buttons or a `Menu`.
- **Evidence** — `EvidenceQuote` under the fact it supports, never in a separate tab only.
- **Three file facts** — transfer status, extraction status and human review are three separate chips.
- **Gates** — approval and sending use `ConfirmDialog` with the exact revision and recipients spelled
  out; never pre-checked; disabled with a reason when a precondition is missing.
- **Empty states teach** — say what will appear and how to get it; offer the action.
- **Loading** — skeleton rows (`LoadingRows`), not spinners in the middle of content.
- **Errors** — name the problem and the recovery; keep what the person typed.

## Refuse

Card grids of icon + heading + text as page structure; nested cards; eyebrow labels above headings;
hero metrics; gradient text; coloured side stripes (>1px border-left/right) on cards, rows or alerts;
glass/blur decoration; emoji as icons; decorative motion; modals for tasks that do not need focus.

## Motion

150–250 ms ease-out for state changes (hover, open, close). Sheets slide from the bottom on phones,
drawers from the right on desktop. `prefers-reduced-motion` turns animation off.

## Copy

Short sentences, active voice, the company's own words. Buttons say what happens ("Approve download",
"Request changes", "Send quotation"). Dates as "11 Oct 2026". Never claim something was checked when it
was only extracted.
