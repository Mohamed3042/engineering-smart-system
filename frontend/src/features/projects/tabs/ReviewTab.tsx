/**
 * Engineer review (mockups 22, 75): the checklist gate. Approve needs every item checked and names the
 * revision and the reviewer. A check needs something to stand on: evidence, a recorded value or a
 * note of what was checked; "Not applicable" needs its reason. A new revision opens a new round; the
 * earlier approval stays in the history marked superseded. On phones what still needs a person comes
 * first, with the actions; completed items and the history are folded away.
 */
import { Check, ClipboardCheck, Lock, ShieldCheck, X } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Link } from "react-router";
import { api } from "@/api/client";
import { useCurrentUser } from "@/api/session";
import type { ChecklistItem, Review } from "@/api/types";
import { cn } from "@/lib/cn";
import { formatDate, formatDateShort, formatDateTime } from "@/lib/format";
import { roleLabel } from "@/lib/labels";
import { projectHref } from "@/lib/routes";
import {
  Banner,
  Button,
  CollapsibleSection,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  InlineError,
  KeyValue,
  Panel,
  PanelBody,
  PanelHeader,
  Select,
  StatusChip,
  Textarea,
  Timeline,
  type TimelineItem,
} from "@/ui";
import { useProjectMutation, type ProjectDetail } from "../api";
import { SourceQuote } from "../fileParts";
import { useStacked } from "../hooks";
import {
  checkChoice,
  checklistBasis,
  checklistIssue,
  checklistItemForSave,
  checklistItemInfo,
  choicePatch,
  normalizeCheck,
  ownNote,
  revisionText,
  ROLE_RANK,
  type ChecklistBasis,
  type ChecklistIssue,
  type CheckChoice,
} from "../lib";
import { Bidi } from "../parts";
import type { TabProps } from "../ProjectLayout";

const CHECK_OPTIONS: { value: CheckChoice; label: string }[] = [
  { value: "pending", label: "Open" },
  { value: "checked", label: "Checked" },
  { value: "not_applicable", label: "Not applicable" },
  { value: "needs_review", label: "Needs review" },
  { value: "failed", label: "Problem found" },
];

/** "Revision R03: mast 20 m → 24 m", or what is under review when no revision is recorded. */
function revisionLabel(r: Review | null | undefined): string {
  return revisionText(r?.revision) ?? "the current documents (no revision number recorded)";
}

export function ReviewTab({ detail }: TabProps) {
  const review = detail.review;
  const stacked = useStacked();
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <div className="min-w-0 space-y-6">
        {!review ? (
          <NoReview detail={detail} />
        ) : review.decision === "changes_requested" ? (
          <ChangesRequested detail={detail} review={review} stacked={stacked} />
        ) : (
          <ReviewRound key={review.id} detail={detail} review={review} stacked={stacked} />
        )}
      </div>
      <HistoryPanel detail={detail} folded={stacked} />
    </div>
  );
}

/** GET /review opens a new round when there is none, or when the last one asked for changes. */
function useStartRound(projectId: string) {
  return useProjectMutation(() => api.get<Review>(`/projects/${encodeURIComponent(projectId)}/review`), {
    projectId,
    success: "Review round started",
  });
}

function NoReview({ detail }: TabProps) {
  const p = detail.project;
  const start = useStartRound(p.id);
  return (
    <Panel>
      <EmptyState
        icon={<ClipboardCheck />}
        title="No review round yet"
        action={
          <>
            <Button asChild variant="secondary">
              <Link to={projectHref(p.id, "analysis")}>Open analysis</Link>
            </Button>
            <Button icon={<ClipboardCheck />} loading={start.isPending} onClick={() => start.mutate()}>
              Start review
            </Button>
          </>
        }
      >
        The engineer checks the technical scope item by item here, then approves one revision of it. A round opens when the
        analysis finishes, or start one now.
      </EmptyState>
    </Panel>
  );
}

function ChangesRequested({ detail, review, stacked }: TabProps & { review: Review; stacked: boolean }) {
  const start = useStartRound(detail.project.id);
  const rows = (review.checklist ?? []).map((item) => ({ item, basis: checklistBasis(item, detail, review) }));
  const list = (
    <ul className={cn("divide-y divide-line", stacked && "-mx-5 -my-4")}>
      {rows.map(({ item, basis }, i) => (
        <ChecklistRow key={item.key || i} item={item} basis={basis} issue={checklistIssue(item, basis)} detail={detail} />
      ))}
    </ul>
  );
  return (
    <>
      <Banner
        tone="block"
        title="Changes requested"
        actions={
          <Button size="sm" loading={start.isPending} onClick={() => start.mutate()} className="w-full sm:w-auto">
            Start new review round
          </Button>
        }
      >
        <p>
          By {review.reviewer_name ?? "a reviewer"}
          {review.decided_at ? ` on ${formatDateTime(review.decided_at)}` : ""} · {revisionLabel(review)}
        </p>
        {review.note ? <Bidi text={review.note} as="p" className="mt-1 text-ink" /> : null}
      </Banner>
      {stacked ? (
        <CollapsibleSection title="Checklist of that round" summary={`${rows.length} items`}>
          {list}
        </CollapsibleSection>
      ) : (
        <Panel>
          <PanelHeader title="Checklist of that round" />
          {list}
        </Panel>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ the open (or approved) round */

interface Draft {
  items: ChecklistItem[];
  note: string;
}

function toDraft(r: Review): Draft {
  return {
    items: (r.checklist ?? []).map((i) => ({ ...i, status: normalizeCheck(i.status), note: i.note ?? "", not_applicable: i.not_applicable === true })),
    note: r.note ?? "",
  };
}

/** One checklist item with what backs it up and what it still lacks. */
interface Row {
  item: ChecklistItem;
  index: number;
  basis: ChecklistBasis;
  issue: ChecklistIssue | null;
  /** The note the item carried while it was not checked. */
  flag?: string;
  /** Checked (or not applicable) with nothing missing. */
  done: boolean;
}

function ReviewRound({ detail, review, stacked }: TabProps & { review: Review; stacked: boolean }) {
  const p = detail.project;
  const id = useId();
  const user = useCurrentUser();
  const approved = review.decision === "approved";
  const [draft, setDraft] = useState<Draft>(() => toDraft(review));

  // the note an item carried while it was not checked is the flag the system raised, not what was checked
  const flagNotes = useMemo(
    () => Object.fromEntries((review.checklist ?? []).filter((i) => normalizeCheck(i.status) !== "checked").map((i) => [i.key, (i.note ?? "").trim()])),
    [review],
  );
  const rowsOf = (items: ChecklistItem[]): Row[] =>
    items.map((item, index) => {
      const basis = checklistBasis(item, detail, review);
      const flag = flagNotes[item.key];
      const issue = checklistIssue(item, basis, flag);
      return { item, index, basis, issue, flag, done: normalizeCheck(item.status) === "checked" && !issue };
    });
  /** What is sent: an item without its note or reason goes as open, so a check nobody stood behind is never stored. */
  const payload = (items: ChecklistItem[], note: string) => ({
    checklist: rowsOf(items).map((r) => checklistItemForSave(r.item, r.basis, r.flag)),
    note,
  });
  const saved = useMemo(() => {
    const server = toDraft(review);
    return JSON.stringify(payload(server.items, server.note));
  }, [review, detail]);
  const dirty = !approved && JSON.stringify(payload(draft.items, draft.note)) !== saved;
  const [approveOpen, setApproveOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);

  const put = () => api.put<Review>(`/projects/${encodeURIComponent(p.id)}/review`, payload(draft.items, draft.note));
  const save = useProjectMutation(put, { projectId: p.id, success: "Review saved" });
  const approve = useProjectMutation(
    async () => {
      // always saved first: what the server holds must be what is on screen
      await put();
      return api.post<Review>(`/projects/${encodeURIComponent(p.id)}/review/approve`);
    },
    {
      projectId: p.id,
      invalidate: [["approvals"], ["quotations"]],
      toastErrors: false,
      success: "Technical scope approved",
      onSuccess: () => setApproveOpen(false),
    },
  );
  const requestChanges = useProjectMutation(
    async (note: string) => {
      if (dirty) await put();
      return api.post<Review>(`/projects/${encodeURIComponent(p.id)}/review/request-changes`, { note });
    },
    {
      projectId: p.id,
      invalidate: [["approvals"]],
      toastErrors: false,
      success: "Changes requested",
      onSuccess: () => setChangesOpen(false),
    },
  );

  const rows = rowsOf(draft.items);
  const items = draft.items;
  const waiting = rows.filter((r) => !r.done);
  const finished = rows.filter((r) => r.done);
  const lacking = waiting.filter((r) => r.issue);
  const unchecked = waiting.filter((r) => !r.issue);
  // On a phone the list is split by what is SAVED as done, not by the draft: a row that moved away
  // the moment its note became valid would take the field the person is typing in with it.
  const settled = new Set(rowsOf(toDraft(review).items).filter((r) => r.done).map((r) => r.item.key));
  const active = rows.filter((r) => !settled.has(r.item.key));
  const folded = rows.filter((r) => settled.has(r.item.key));
  const role = user?.role ?? "";
  const canApprove = (ROLE_RANK[role] ?? 0) >= ROLE_RANK.engineer;
  const names = (list: Row[]) => list.map((r) => r.item.label).join(", ");
  const blockReason = !items.length
    ? "The checklist has no items, so there is nothing to approve."
    : waiting.length
      ? `Check every item first.${unchecked.length ? ` Still open: ${names(unchecked)}.` : ""}${lacking.length ? ` Add a note or a reason for: ${names(lacking)}.` : ""}`
      : !canApprove
        ? `Approving the technical scope needs the engineer role. You are signed in as ${roleLabel(role).toLowerCase()}.`
        : null;

  const update = (index: number, patch: Partial<ChecklistItem>) =>
    setDraft((d) => ({ ...d, items: d.items.map((it, i) => (i === index ? { ...it, ...patch } : it)) }));

  if (approved) {
    const list = (
      <ul className={cn("divide-y divide-line", stacked && "-mx-5 -my-4")}>
        {rows.map((r) => (
          <ChecklistRow key={r.item.key || r.index} item={r.item} basis={r.basis} issue={r.issue} detail={detail} />
        ))}
      </ul>
    );
    return (
      <>
        <Banner tone="brand" title="Technical scope approved">
          By {review.reviewer_name ?? "a reviewer"}
          {review.decided_at ? ` on ${formatDateTime(review.decided_at)}` : ""}. Covers {revisionLabel(review)}. A new technical
          revision or addendum opens a new review round.
        </Banner>
        {review.note ? (
          <Panel>
            <PanelBody>
              <p className="text-sm text-ink-3">Reviewer note</p>
              <Bidi text={review.note} as="p" className="mt-1 text-ink" />
            </PanelBody>
          </Panel>
        ) : null}
        {stacked ? (
          <CollapsibleSection title="Checklist" summary={`${finished.length} of ${items.length} checked`}>
            {list}
          </CollapsibleSection>
        ) : (
          <Panel>
            <PanelHeader title="Checklist" description={`${finished.length} of ${items.length} checked`} />
            {list}
            {review.note ? (
              <div className="border-t border-line px-5 py-4">
                <p className="text-sm text-ink-3">Reviewer note</p>
                <Bidi text={review.note} as="p" className="mt-1 text-ink" />
              </div>
            ) : null}
          </Panel>
        )}
      </>
    );
  }

  const row = (r: Row) => (
    <ChecklistRow
      key={r.item.key || r.index}
      item={r.item}
      basis={r.basis}
      issue={r.issue}
      flag={r.flag}
      detail={detail}
      onChange={(patch) => update(r.index, patch)}
    />
  );
  const note = (
    <div className="border-t border-line px-5 py-4">
      <Field label="Reviewer note" optional htmlFor={`${id}-note`}>
        <Textarea
          id={`${id}-note`}
          rows={3}
          value={draft.note}
          onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
          placeholder="What you checked and what the quotation must respect"
        />
      </Field>
    </div>
  );
  const actions = (
    <div className="flex flex-col gap-3 border-t border-line px-5 py-4 lg:flex-row lg:items-center">
      <p className={cn("flex items-start gap-2 text-sm lg:mr-auto", blockReason ? "text-review" : "text-ink-3")}>
        {blockReason ? <Lock className="mt-0.5 size-4 shrink-0" aria-hidden /> : null}
        {blockReason ?? "Every item is checked. You can approve this revision."}
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end lg:shrink-0">
        <Button variant="secondary" loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>
          {dirty ? "Save review" : "Saved"}
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            requestChanges.reset();
            setChangesOpen(true);
          }}
        >
          Request changes
        </Button>
        <Button
          icon={<ShieldCheck />}
          disabled={!!blockReason}
          onClick={() => {
            approve.reset();
            setApproveOpen(true);
          }}
        >
          Approve technical scope
        </Button>
      </div>
    </div>
  );

  return (
    <>
      {review.supersedes_id ? (
        <Banner tone="review" title="New revision needs another review">
          The earlier approval does not cover {revisionLabel(review)}. Check every item again before the quotation goes out.
        </Banner>
      ) : null}

      {stacked ? (
        <>
          <Panel>
            <PanelHeader
              title="Checklist"
              description={`${finished.length} of ${items.length} checked${waiting.length ? ` · ${waiting.length} need${waiting.length === 1 ? "s" : ""} you` : ""} · Reviewing ${revisionLabel(review)}`}
            />
            {!items.length ? (
              <PanelBody>
                <p className="text-ink-3">The workspace has no review checklist, so this round has no items.</p>
              </PanelBody>
            ) : active.length ? (
              <ul className="divide-y divide-line">{active.map(row)}</ul>
            ) : (
              <PanelBody>
                <p className="text-ink-2">{waiting.length ? "Nothing else needs you here. The items you reopened are under Completed." : "Every item is checked."}</p>
              </PanelBody>
            )}
            {note}
            {actions}
          </Panel>
          {folded.length ? (
            <CollapsibleSection title={`Completed (${folded.length})`}>
              <ul className="-mx-5 -my-4 divide-y divide-line">{folded.map(row)}</ul>
            </CollapsibleSection>
          ) : null}
        </>
      ) : (
        <Panel>
          <PanelHeader
            title="Checklist"
            description={`${finished.length} of ${items.length} checked · Reviewing ${revisionLabel(review)}`}
          />
          {items.length ? (
            <ul className="divide-y divide-line">{rows.map(row)}</ul>
          ) : (
            <PanelBody>
              <p className="text-ink-3">The workspace has no review checklist, so this round has no items.</p>
            </PanelBody>
          )}
          {note}
          {actions}
        </Panel>
      )}

      <ConfirmDialog
        open={approveOpen}
        onOpenChange={setApproveOpen}
        title="Approve the technical scope?"
        description="Your approval is recorded with your name, the date and this revision. It does not cover later revisions."
        confirmLabel="Approve technical scope"
        loading={approve.isPending}
        onConfirm={() => approve.mutate()}
      >
        <div className="space-y-3">
          <KeyValue
            labelWidth="sm"
            items={[
              { label: "Project", value: <Bidi text={p.name} /> },
              { label: "Revision", value: <Bidi text={revisionLabel(review)} /> },
              { label: "Reviewer", value: user ? `${user.name} (${roleLabel(user.role)})` : "You" },
              { label: "Checklist", value: `${items.length} of ${items.length} items checked` },
              { label: "Date", value: formatDate(new Date()) },
            ]}
          />
          {dirty ? <p className="text-sm text-ink-3">Your unsaved checklist changes are saved first.</p> : null}
          <InlineError error={approve.error} />
        </div>
      </ConfirmDialog>
      <RequestChangesDialog
        open={changesOpen}
        onOpenChange={setChangesOpen}
        loading={requestChanges.isPending}
        error={requestChanges.error}
        onSubmit={(note) => requestChanges.mutate(note)}
      />
    </>
  );
}

/**
 * One checklist item. A check needs something to stand on: evidence, a value the system recorded,
 * or a note of what was checked; "Not applicable" needs the reason. Without it the item does not
 * count as checked and says what it needs.
 */
function ChecklistRow({
  item,
  basis,
  issue,
  flag,
  detail,
  onChange,
}: {
  item: ChecklistItem;
  basis: ChecklistBasis;
  issue: ChecklistIssue | null;
  /** The note the item carried while it was not checked. */
  flag?: string;
  detail: ProjectDetail;
  /** Editable when set. */
  onChange?: (patch: Partial<ChecklistItem>) => void;
}) {
  const choice = checkChoice(item);
  const note = (item.note ?? "").trim();
  const ownText = ownNote(item, flag);
  const supported = basis.evidence.length > 0 || basis.recorded.length > 0;
  const info = checklistItemInfo(item, issue);

  const basisBlock = (
    <>
      {basis.recorded.map((line) => (
        <p key={line} className="mt-2 text-sm text-ink-2">
          <span className="text-ink-3">Recorded: </span>
          {line}
        </p>
      ))}
      {basis.evidence.map((ev, i) => (
        <SourceQuote key={i} evidence={ev} detail={detail} className="mt-2" />
      ))}
    </>
  );

  if (!onChange) {
    return (
      <li className="px-5 py-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="font-semibold text-ink">{item.label}</p>
          <StatusChip info={info} size="sm" />
        </div>
        {note ? (
          <p className="mt-1.5 text-sm text-ink-2">
            <span className="text-ink-3">{choice === "not_applicable" ? "Reason: " : "Note: "}</span>
            <Bidi text={item.note} />
          </p>
        ) : choice === "checked" && !supported ? (
          <p className="mt-1.5 text-sm text-ink-3">No note or evidence was recorded for this item.</p>
        ) : null}
        {basisBlock}
      </li>
    );
  }

  const needsNote = choice === "checked" && !supported;
  const required = needsNote || choice === "not_applicable";
  const label = choice === "not_applicable" ? "Why it does not apply" : needsNote ? "What you checked" : "Note";
  const flagged = !!note && !ownText && (required || choice === "checked");
  const hint = flagged
    ? "This note was added when the item was flagged. Write what you checked instead; until then the item stays open."
    : choice === "not_applicable"
      ? "Counts as checked for approval. Your reason is saved with the item."
      : needsNote
        ? "This item has no evidence or recorded value, so say what you checked. Without a note it stays open."
        : undefined;
  return (
    <li className="px-5 py-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="font-semibold text-ink">{item.label}</p>
          <StatusChip info={info} size="sm" />
        </div>
        <Select
          aria-label={`Status of ${item.label}`}
          value={choice}
          onChange={(e) => onChange(choicePatch(e.target.value as CheckChoice))}
          options={CHECK_OPTIONS}
          className="sm:w-48 sm:shrink-0"
        />
      </div>
      {basisBlock}
      <Field label={label} required={required} optional={!required} hint={hint} className="mt-3">
        <Textarea
          rows={2}
          value={item.note ?? ""}
          placeholder={choice === "not_applicable" ? "For example: no roof loads on this job, the unit is floor-mounted" : "What you checked, or what is missing"}
          onChange={(e) => onChange({ note: e.target.value })}
        />
      </Field>
    </li>
  );
}

function RequestChangesDialog({
  open,
  onOpenChange,
  loading,
  error,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  loading: boolean;
  error: unknown;
  onSubmit: (note: string) => void;
}) {
  const id = useId();
  const [note, setNote] = useState("");
  const [missing, setMissing] = useState(false);
  const submit = () => {
    if (!note.trim()) {
      setMissing(true);
      return;
    }
    onSubmit(note.trim());
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !loading && onOpenChange(o)}
      title="Request changes"
      description="This closes the review round with your note. A new round starts when the inputs are updated."
      hideClose={loading}
      footer={
        <>
          <Button variant="secondary" disabled={loading} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button loading={loading} onClick={submit}>
            Request changes
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field
          label="What must change"
          required
          htmlFor={`${id}-note`}
          error={missing ? "Say what must change before the scope can be approved." : null}
        >
          <Textarea
            id={`${id}-note`}
            rows={4}
            value={note}
            invalid={missing}
            onChange={(e) => {
              setNote(e.target.value);
              if (missing) setMissing(false);
            }}
            placeholder="For example: confirm the mast height of the new revision with the customer"
          />
        </Field>
        <InlineError error={error} />
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ history */

function coverText(r: Review | null): string {
  const t = revisionText(r?.revision);
  if (!t) return "the current review round";
  return /^rev/i.test(t) ? t : `revision ${t}`;
}

/** One decided review round. A round a newer round supersedes stays visible but no longer covers the work. */
function historyItem(r: Review, superseded: boolean, current: Review | null): TimelineItem {
  const approval = r.decision === "approved";
  const rev = revisionText(r.revision);
  return {
    title: approval ? (superseded ? "Approved, superseded" : "Approved") : r.decision === "changes_requested" ? "Changes requested" : "Superseded",
    when: formatDateShort(r.decided_at),
    tone: superseded ? "muted" : approval ? "brand" : "block",
    icon: approval ? <Check aria-hidden /> : <X aria-hidden />,
    detail: (
      <>
        <p>
          {r.reviewer_name ?? "—"} · {rev ?? "no revision number"}
        </p>
        {superseded ? <p className="mt-0.5 font-medium text-ink">Superseded — does not cover {coverText(current)}</p> : null}
        {r.note ? <Bidi text={r.note} as="p" className="mt-0.5 line-clamp-3 text-ink-3" /> : null}
      </>
    ),
  };
}

function HistoryPanel({ detail, folded }: TabProps & { folded: boolean }) {
  const replaced = new Set(detail.reviews.map((r) => r.supersedes_id).filter(Boolean));
  const decided = detail.reviews.filter((r) => r.decision);
  const body = decided.length ? (
    <Timeline items={decided.map((r) => historyItem(r, replaced.has(r.id), detail.review))} />
  ) : (
    <p className="text-sm text-ink-3">No decisions yet. Approvals and change requests appear here with who decided and when.</p>
  );
  if (folded) {
    return (
      <CollapsibleSection title="Review history" summary={decided.length ? `${decided.length} ${decided.length === 1 ? "decision" : "decisions"}` : "No decisions yet"}>
        {body}
      </CollapsibleSection>
    );
  }
  return (
    <Panel>
      <PanelHeader title="Review history" description="Each decision with the person, the date and the revision." />
      <PanelBody>{body}</PanelBody>
    </Panel>
  );
}
