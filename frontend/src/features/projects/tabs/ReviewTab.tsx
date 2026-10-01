/**
 * Engineer review (mockups 22, 75): the checklist gate. Approve needs every item checked and names the
 * revision and the reviewer. A new revision opens a new round; the earlier approval stays in the
 * history marked superseded.
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
  ConfirmDialog,
  CollapsibleSection,
  Dialog,
  EmptyState,
  EvidenceQuote,
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
import { drawingPages } from "../fileParts";
import { checklistStatusInfo, normalizeCheck, revisionText, ROLE_RANK, withSource, type CheckStatus } from "../lib";
import { Bidi } from "../parts";
import type { TabProps } from "../ProjectLayout";

const CHECK_OPTIONS: { value: CheckStatus; label: string }[] = [
  { value: "pending", label: "Open" },
  { value: "checked", label: "Checked" },
  { value: "needs_review", label: "Needs review" },
  { value: "failed", label: "Problem found" },
  { value: "na", label: "Not applicable — reason required" },
];

/** "Revision R03: mast 20 m → 24 m", or what is under review when no revision is recorded. */
function revisionLabel(r: Review | null | undefined): string {
  return revisionText(r?.revision) ?? "the current documents (no revision number recorded)";
}

export function ReviewTab({ detail }: TabProps) {
  const review = detail.review;
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <div className="min-w-0 space-y-6">
        {!review ? (
          <NoReview detail={detail} />
        ) : review.decision === "changes_requested" ? (
          <ChangesRequested detail={detail} review={review} />
        ) : (
          <ReviewRound key={review.id} detail={detail} review={review} />
        )}
      </div>
      <HistoryPanel detail={detail} />
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

function ChangesRequested({ detail, review }: TabProps & { review: Review }) {
  const start = useStartRound(detail.project.id);
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
      <Panel>
        <PanelHeader title="Checklist of that round" />
        <ul className="divide-y divide-line">
          {(review.checklist ?? []).map((item, i) => (
            <ChecklistRow key={item.key || i} item={item} detail={detail} />
          ))}
        </ul>
      </Panel>
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
    items: (r.checklist ?? []).map((i) => ({ ...i, status: normalizeCheck(i.status), note: i.note ?? "" })),
    note: r.note ?? "",
  };
}

/** A missing drawing revision needs an explicit explanation, never an unqualified Checked label. */
function needsRevisionReason(item: ChecklistItem, detail: ProjectDetail): boolean {
  if (item.key !== "drawings" && !/revision/i.test(item.key)) return false;
  return !(item.evidence ?? []).some((ev) => ev.quote?.trim()) && !detail.files.some((file) => drawingPages(file).some(({ finding }) => {
    const revision = finding.sheet?.revision;
    return revision?.readable !== false && revision?.value != null && String(revision.value).trim() !== "";
  }));
}

function completed(item: ChecklistItem, detail: ProjectDetail): boolean {
  return item.status === "na" ? !!item.note?.trim() : item.status === "checked" && (!needsRevisionReason(item, detail) || !!item.note?.trim());
}

function ReviewRound({ detail, review }: TabProps & { review: Review }) {
  const p = detail.project;
  const id = useId();
  const user = useCurrentUser();
  const approved = review.decision === "approved";
  const [draft, setDraft] = useState<Draft>(() => toDraft(review));
  const saved = useMemo(() => JSON.stringify(toDraft(review)), [review]);
  const dirty = !approved && JSON.stringify(draft) !== saved;
  const [approveOpen, setApproveOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);

  const put = () =>
    api.put<Review>(`/projects/${encodeURIComponent(p.id)}/review`, { checklist: draft.items, note: draft.note });
  const save = useProjectMutation(put, { projectId: p.id, success: "Review saved" });
  const approve = useProjectMutation(
    async () => {
      if (dirty) await put();
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

  const items = draft.items;
  const open = items.filter((i) => !completed(i, detail));
  const role = user?.role ?? "";
  const canApprove = (ROLE_RANK[role] ?? 0) >= ROLE_RANK.engineer;
  const blockReason = !items.length
    ? "The checklist has no items, so there is nothing to approve."
    : open.length
      ? `Complete every item. Not applicable and missing revision evidence need a reason. Still open: ${open.map((i) => i.label).join(", ")}.`
      : !canApprove
        ? `Approving the technical scope needs the engineer role. You are signed in as ${roleLabel(role).toLowerCase()}.`
        : null;

  const update = (index: number, patch: Partial<ChecklistItem>) =>
    setDraft((d) => ({ ...d, items: d.items.map((it, i) => (i === index ? { ...it, ...patch } : it)) }));

  if (approved) {
    return (
      <>
        <Banner tone="brand" title="Technical scope approved">
          By {review.reviewer_name ?? "a reviewer"}
          {review.decided_at ? ` on ${formatDateTime(review.decided_at)}` : ""}. Covers {revisionLabel(review)}. A new technical
          revision or addendum opens a new review round.
        </Banner>
        <Panel>
          <PanelHeader title="Checklist" description={`${items.filter((i) => i.status === "checked").length} checked · ${items.filter((i) => i.status === "na").length} not applicable with a reason`} />
          <ul className="divide-y divide-line">
            {items.map((item, i) => (
              <ChecklistRow key={item.key || i} item={item} detail={detail} />
            ))}
          </ul>
          {review.note ? (
            <div className="border-t border-line px-5 py-4">
              <p className="text-sm text-ink-3">Reviewer note</p>
              <Bidi text={review.note} as="p" className="mt-1 text-ink" />
            </div>
          ) : null}
        </Panel>
      </>
    );
  }

  return (
    <>
      {review.supersedes_id ? (
        <Banner tone="review" title="New revision needs another review">
          The earlier approval does not cover {revisionLabel(review)}. Check every item again before the quotation goes out.
        </Banner>
      ) : null}
      <Panel>
        <PanelHeader
          title="Checklist"
          description={`${items.length - open.length} of ${items.length} complete · Reviewing ${revisionLabel(review)}`}
        />
        {items.length ? (
          <ul className="divide-y divide-line">
            {items.map((item, i) => (
              <ChecklistRow key={item.key || i} item={item} detail={detail} onChange={(patch) => update(i, patch)} />
            ))}
          </ul>
        ) : (
          <PanelBody>
            <p className="text-ink-3">The workspace has no review checklist, so this round has no items.</p>
          </PanelBody>
        )}
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
        <div className="flex flex-col gap-3 border-t border-line px-5 py-4 lg:flex-row lg:items-center">
          <p className={cn("flex items-start gap-2 text-sm lg:mr-auto", blockReason ? "text-review" : "text-ink-3")}>
            {blockReason ? <Lock className="mt-0.5 size-4 shrink-0" aria-hidden /> : null}
            {blockReason ?? "Every item is checked or not applicable with a reason. You can approve this revision."}
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
      </Panel>

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
              { label: "Checklist", value: `${items.length} complete: ${items.filter((i) => i.status === "checked").length} checked, ${items.filter((i) => i.status === "na").length} not applicable` },
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

function ChecklistRow({
  item,
  detail,
  onChange,
}: {
  item: ChecklistItem;
  detail: ProjectDetail;
  /** Editable when set. */
  onChange?: (patch: Partial<ChecklistItem>) => void;
}) {
  const evidence = Array.isArray(item.evidence) ? item.evidence : [];
  const needsReason = normalizeCheck(item.status) === "na" || (normalizeCheck(item.status) === "checked" && needsRevisionReason(item, detail));
  const missingRevision = normalizeCheck(item.status) === "checked" && needsRevisionReason(item, detail);
  const info = missingRevision ? { label: item.note?.trim() ? "No revision evidence — reason recorded" : "No revision evidence — reason needed", tone: "review" as const } : checklistStatusInfo(item.status);
  return (
    <li className="px-5 py-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="font-semibold text-ink">{item.label}</p>
          <StatusChip info={info} size="sm" />
        </div>
        {onChange ? (
          <Select
            aria-label={`Status of ${item.label}`}
            value={normalizeCheck(item.status)}
            onChange={(e) => onChange({ status: e.target.value })}
            options={CHECK_OPTIONS}
            className="sm:w-44 sm:shrink-0"
          />
        ) : null}
      </div>
      {onChange ? (
        <Field label={needsReason ? "Reason" : "Review note"} required={needsReason} className="mt-2" error={needsReason && !item.note?.trim() ? "Record why this is not applicable or why no revision evidence is available." : undefined}>
        <Textarea
          aria-label={`${needsReason ? "Reason" : "Note"} for ${item.label}`}
          rows={2}
          value={item.note ?? ""}
          invalid={needsReason && !item.note?.trim()}
          placeholder={needsReason ? "Explain why, with the document or scope you checked" : "What you checked, or what is missing"}
          onChange={(e) => onChange({ note: e.target.value })}
        />
        </Field>
      ) : item.note ? (
        <Bidi text={item.note} as="p" className="mt-1.5 text-sm text-ink-2" />
      ) : null}
      {evidence.map((ev, i) => (
        <EvidenceQuote key={i} evidence={withSource(ev, detail.emails, detail.files)} className="mt-2" />
      ))}
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

function HistoryPanel({ detail }: TabProps) {
  const replaced = new Set(detail.reviews.map((r) => r.supersedes_id).filter(Boolean));
  const decided = detail.reviews.filter((r) => r.decision);
  return (
    <CollapsibleSection title="Review history" summary={`${decided.length} decisions`}>
        {decided.length ? (
          <Timeline items={decided.map((r) => historyItem(r, replaced.has(r.id), detail.review))} />
        ) : (
          <p className="text-sm text-ink-3">No decisions yet. Approvals and change requests appear here with who decided and when.</p>
        )}
    </CollapsibleSection>
  );
}
