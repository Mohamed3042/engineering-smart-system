/**
 * Project overview (mockup 17): changes since the last review, summary facts, blockers,
 * the one next action, four separate status facts and the timeline.
 */
import { ArrowRight, CircleAlert, CircleCheck, FileText, Plus } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "@/api/client";
import { useCategoryLabel } from "@/api/session";
import type { Blocker } from "@/api/types";
import { formatDate, formatDateShort } from "@/lib/format";
import { quotationStatusInfo, requestKindLabel, reviewStatusInfo, stageInfo, workTypeLabel, type Tone } from "@/lib/labels";
import { customerHref, projectChangeHref, projectHref, quotationHref } from "@/lib/routes";
import {
  Banner,
  Button,
  ConfirmDialog,
  Input,
  KeyValue,
  Panel,
  PanelBody,
  PanelHeader,
  StatusChip,
  Timeline,
  type TimelineItem,
} from "@/ui";
import { useProjectMutation, type TimelineEntry } from "../api";
import {
  actionButtonLabel,
  actionSourceLabel,
  changeKindInfo,
  commercialFact,
  displayValue,
  openChangeIndexes,
  responseFact,
  sendFact,
  type Fact,
} from "../lib";
import { SourceQuote } from "../fileParts";
import { Bidi, DueDate, NextActionButton } from "../parts";
import type { TabProps } from "../ProjectLayout";

export function OverviewTab({ detail }: TabProps) {
  const p = detail.project;
  const open = openChangeIndexes(p.changes);
  return (
    <div className="space-y-6">
      {open.length ? <ChangesBanner detail={detail} indexes={open} /> : null}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:grid-rows-[auto_1fr]">
        <div className="space-y-6 lg:col-start-2 lg:row-start-1">
          <NextActionPanel detail={detail} />
          <StatusPanel detail={detail} />
        </div>
        <div className="space-y-6 lg:col-start-1 lg:row-span-2 lg:row-start-1">
          <SummaryPanel detail={detail} />
          <BlockersPanel detail={detail} />
          <QuotationsPanel detail={detail} />
        </div>
        <div className="space-y-6 lg:col-start-2 lg:row-start-2">
          <TimelinePanel detail={detail} />
          {detail.related.length ? <RelatedPanel detail={detail} /> : null}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ changes */

function ChangesBanner({ detail, indexes }: TabProps & { indexes: number[] }) {
  const p = detail.project;
  const shown = indexes.slice(-3).reverse();
  return (
    <Banner
      tone="review"
      title={indexes.length === 1 ? "Changed since last review" : `${indexes.length} changes since last review`}
      actions={
        <Button asChild size="sm" variant="secondary" className="w-full sm:w-auto">
          <Link to={projectChangeHref(p.id, shown[0])}>
            Review {indexes.length === 1 ? "change" : "latest change"}
            <ArrowRight aria-hidden />
          </Link>
        </Button>
      }
    >
      <ul className="mt-1.5 space-y-1.5">
        {shown.map((i) => {
          const c = p.changes[i];
          const hasValues = c.old_value != null || c.new_value != null;
          return (
            <li key={i}>
              <Link
                to={projectChangeHref(p.id, i)}
                className="group inline rounded text-ink-2 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-brand"
              >
                <span className="font-medium text-review">{changeKindInfo(c.kind).label}</span>
                <span aria-hidden> · </span>
                <Bidi text={c.title} className="group-hover:underline" />
                {hasValues && c.kind === "deadline_changed" ? (
                  <span className="tabular">
                    {" "}
                    ({displayValue(c.old_value)} → <strong className="font-semibold text-ink">{displayValue(c.new_value)}</strong>)
                  </span>
                ) : null}
                {c.date ? <span className="text-ink-3"> · {formatDateShort(c.date)}</span> : null}
              </Link>
            </li>
          );
        })}
        {indexes.length > shown.length ? (
          <li className="text-ink-3">
            and {indexes.length - shown.length} earlier {indexes.length - shown.length === 1 ? "change" : "changes"}
          </li>
        ) : null}
      </ul>
    </Banner>
  );
}

/* ------------------------------------------------------------------ next action */

function NextActionPanel({ detail }: TabProps) {
  const p = detail.project;
  const a = p.next_action ?? {};
  const label = String(a.label ?? "").trim();
  const source = actionSourceLabel(a.source);
  const setAt = typeof a.set_at === "string" ? a.set_at : null;
  const hasAction = !!actionButtonLabel(a) && !p.archived_at;
  return (
    <Panel>
      <PanelHeader title="Next action" />
      <PanelBody className="space-y-3">
        {label && a.kind !== "none" ? (
          <Bidi text={label} as="p" className="text-base font-medium text-ink" />
        ) : (
          <p className="text-ink-3">Nothing waits for you on this project.</p>
        )}
        {a.detail ? <Bidi text={String(a.detail)} as="p" className="text-sm text-ink-2" /> : null}
        {source ? (
          <p className="text-sm text-ink-3">
            {source}
            {setAt ? ` · ${formatDateShort(setAt)}` : ""}
          </p>
        ) : null}
        {hasAction ? <NextActionButton projectId={p.id} action={a} className="w-full" /> : null}
      </PanelBody>
    </Panel>
  );
}

/* ------------------------------------------------------------------ four status facts */

function engineeringFact(detail: TabProps["detail"]): Fact {
  const p = detail.project;
  const r = detail.review;
  const info = reviewStatusInfo(p.review_status);
  if (r?.decision === "approved") {
    return { info, detail: `By ${r.reviewer_name ?? "a reviewer"}${r.decided_at ? ` on ${formatDate(r.decided_at)}` : ""}` };
  }
  if (r?.decision === "changes_requested") {
    return { info, detail: `By ${r.reviewer_name ?? "a reviewer"}${r.decided_at ? ` on ${formatDate(r.decided_at)}` : ""}` };
  }
  if (r && r.checklist?.length) {
    const done = r.checklist.filter((i) => i.status === "checked").length;
    return { info, detail: `${done} of ${r.checklist.length} checklist items checked` };
  }
  return { info, detail: null };
}

function StatusPanel({ detail }: TabProps) {
  const rows: { label: string; fact: Fact; to: string }[] = [
    { label: "Engineering review", fact: engineeringFact(detail), to: projectHref(detail.project.id, "review") },
    { label: "Commercial review", fact: commercialFact(detail.quotations), to: projectHref(detail.project.id, "documents") },
    { label: "Send to customer", fact: sendFact(detail.quotations, detail.enquiries), to: projectHref(detail.project.id, "documents") },
    { label: "Customer response", fact: responseFact(detail.enquiries), to: projectHref(detail.project.id, "enquiries") },
  ];
  return (
    <Panel>
      <PanelHeader title="Current status" description="Four separate facts. Sent is not accepted." />
      <dl className="divide-y divide-line px-5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-start justify-between gap-3 py-3">
            <dt className="pt-0.5 text-sm text-ink-3">
              <Link to={r.to} className="rounded hover:text-ink hover:underline">
                {r.label}
              </Link>
            </dt>
            <dd className="flex min-w-0 flex-col items-end gap-1 text-right">
              <StatusChip info={r.fact.info} size="sm" />
              {r.fact.detail ? <span className="text-xs text-ink-3">{r.fact.detail}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

/* ------------------------------------------------------------------ summary */

function SummaryPanel({ detail }: TabProps) {
  const p = detail.project;
  const categoryLabel = useCategoryLabel();
  const mailbox = detail.emails.find((e) => e.direction !== "outbound")?.account;
  const firstReceived = detail.enquiries
    .map((e) => e.received_at)
    .filter(Boolean)
    .sort()[0];
  const more = detail.enquiries.length - 1;
  return (
    <Panel>
      <PanelHeader title="Project summary" />
      <PanelBody>
        {p.summary ? <Bidi text={p.summary} as="p" className="mb-3 max-w-[70ch] text-base leading-relaxed text-ink-2" /> : null}
        <KeyValue
          items={[
            {
              label: "Customer",
              value: detail.customer ? (
                <span>
                  <Link to={customerHref(detail.customer.id)} className="font-medium text-brand-ink hover:underline">
                    <Bidi text={detail.customer.name} />
                  </Link>
                  {more > 0 ? (
                    <>
                      {" "}
                      <Link to={projectHref(p.id, "enquiries")} className="text-sm text-ink-3 hover:text-ink hover:underline">
                        and {more} more {more === 1 ? "contractor" : "contractors"}
                      </Link>
                    </>
                  ) : null}
                </span>
              ) : null,
            },
            { label: "Owner / client", value: p.owner_client ? <Bidi text={p.owner_client} /> : null },
            { label: "Consultant", value: p.consultant ? <Bidi text={p.consultant} /> : null },
            { label: "Main contractor", value: p.main_contractor ? <Bidi text={p.main_contractor} /> : null },
            { label: "Location", value: p.location ? <Bidi text={p.location} /> : null },
            { label: "Tender number", value: p.tender_no || null },
            { label: "Service family", value: categoryLabel(p.service_family) },
            { label: "Work type", value: workTypeLabel(p.work_type) },
            { label: "Request kind", value: requestKindLabel(p.request_kind) },
            { label: "Closing date", value: <DueDate value={p.due_date} inline /> },
            { label: "Project owner", value: detail.owner?.name ?? <span className="text-ink-3">Nobody yet</span> },
            ...(mailbox ? [{ label: "Received in", value: mailbox, hint: firstReceived ? `First enquiry ${formatDate(firstReceived)}` : undefined }] : []),
          ]}
        />
      </PanelBody>
    </Panel>
  );
}

/* ------------------------------------------------------------------ blockers */

function blockerSource(b: Blocker): string {
  switch (b.source) {
    case "derived":
      return "Clears itself when the cause is fixed";
    case "scan":
      return "Found by the mailbox scan";
    case "ai":
      return "Found by analysis";
    case "user":
      return `Added by ${typeof b.by === "string" ? b.by : "a person"}`;
    default:
      return "";
  }
}

function BlockersPanel({ detail }: TabProps) {
  const p = detail.project;
  const [text, setText] = useState("");
  const [resolving, setResolving] = useState<number | null>(null);
  const add = useProjectMutation((t: string) => api.post(`/projects/${p.id}/blockers`, { kind: "user", text: t }), {
    projectId: p.id,
    success: "Blocker added",
    onSuccess: () => setText(""),
  });
  const resolve = useProjectMutation((i: number) => api.post(`/projects/${p.id}/blockers/${i}/resolve`), {
    projectId: p.id,
    success: "Blocker marked as resolved",
    onSuccess: () => setResolving(null),
  });
  const blockers = (p.blockers ?? []).map((b, i) => ({ b, i })).filter(({ b }) => !b.resolved);

  return (
    <Panel>
      <PanelHeader
        title={blockers.length ? `Blockers (${blockers.length})` : "Blockers"}
        description={blockers.length ? "What stops this project from moving on." : undefined}
      />
      <PanelBody className="space-y-4">
        {blockers.length === 0 ? (
          <p className="flex items-center gap-2 text-ink-2">
            <CircleCheck className="size-5 text-brand" aria-hidden />
            Nothing blocks this project right now.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {blockers.map(({ b, i }) => {
              const fixHref =
                b.source === "derived"
                  ? `${projectHref(p.id, "inputs")}${b.link_id ? `?link=${b.link_id}` : ""}`
                  : b.link_id
                    ? `${projectHref(p.id, "inputs")}?link=${b.link_id}`
                    : null;
              return (
                <li key={i} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start">
                  <CircleAlert className="hidden size-5 shrink-0 text-block sm:mt-0.5 sm:block" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="flex gap-2 text-ink">
                      <CircleAlert className="mt-0.5 size-5 shrink-0 text-block sm:hidden" aria-hidden />
                      <Bidi text={b.text} className="break-words" />
                    </p>
                    {blockerSource(b) ? <p className="mt-0.5 text-sm text-ink-3">{blockerSource(b)}</p> : null}
                    {b.evidence && typeof b.evidence === "object" && (b.evidence as { quote?: string }).quote ? (
                      <SourceQuote evidence={b.evidence} detail={detail} className="mt-2" />
                    ) : null}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {fixHref ? (
                      <Button asChild size="sm" variant="secondary">
                        <Link to={fixHref}>Fix in Inputs</Link>
                      </Button>
                    ) : null}
                    {b.source !== "derived" ? (
                      <Button size="sm" variant="ghost" onClick={() => setResolving(i)}>
                        Mark resolved
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {!p.archived_at ? (
          <form
            className="flex flex-col gap-2 border-t border-line pt-4 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) add.mutate(text.trim());
            }}
          >
            <Input
              aria-label="New blocker"
              placeholder="Note something that blocks this project"
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="flex-1"
            />
            <Button type="submit" variant="secondary" icon={<Plus />} loading={add.isPending} disabled={!text.trim()}>
              Add blocker
            </Button>
          </form>
        ) : null}
      </PanelBody>
      <ConfirmDialog
        open={resolving !== null}
        onOpenChange={(o) => !o && setResolving(null)}
        title="Mark this blocker as resolved?"
        description="It leaves the list. Add it again if the problem comes back."
        confirmLabel="Mark resolved"
        loading={resolve.isPending}
        onConfirm={() => resolving !== null && resolve.mutate(resolving)}
      >
        {resolving !== null ? <Bidi text={p.blockers[resolving]?.text} as="p" className="rounded-lg bg-sunken px-3 py-2 text-ink" /> : null}
      </ConfirmDialog>
    </Panel>
  );
}

/* ------------------------------------------------------------------ quotations */

function QuotationsPanel({ detail }: TabProps) {
  const p = detail.project;
  const live = detail.quotations.filter((q) => q.status !== "superseded");
  const byEnquiry = new Map(detail.enquiries.map((e) => [e.id, e]));
  return (
    <Panel>
      <PanelHeader
        title="Quotations"
        actions={
          <Button asChild size="sm" variant="ghost">
            <Link to={projectHref(p.id, "documents")}>
              All documents
              <ArrowRight aria-hidden />
            </Link>
          </Button>
        }
      />
      <PanelBody>
        {live.length === 0 ? (
          <p className="text-ink-3">No quotation yet. Create one per contractor under Documents; prices start empty.</p>
        ) : (
          <ul className="divide-y divide-line">
            {live.slice(0, 5).map((q) => {
              const enquiry = q.enquiry_id ? byEnquiry.get(q.enquiry_id) : undefined;
              return (
                <li key={q.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 first:pt-0 last:pb-0">
                  <FileText className="size-5 shrink-0 text-ink-3" aria-hidden />
                  <Link to={quotationHref(q.id)} className="font-medium text-brand-ink hover:underline">
                    {q.reference || "Draft quotation"}
                  </Link>
                  <span className="text-sm text-ink-3">v{q.version}</span>
                  {enquiry?.customer ? <Bidi text={enquiry.customer.name} className="min-w-0 truncate text-sm text-ink-3" /> : null}
                  <StatusChip info={quotationStatusInfo(q.status)} size="sm" className="ml-auto" />
                </li>
              );
            })}
            {live.length > 5 ? <li className="pt-2.5 text-sm text-ink-3">and {live.length - 5} more under Documents</li> : null}
          </ul>
        )}
      </PanelBody>
    </Panel>
  );
}

/* ------------------------------------------------------------------ timeline */

const severityTone: Record<string, Tone> = { success: "brand", warning: "review", error: "block", info: "neutral" };

function TimelinePanel({ detail }: TabProps) {
  const [all, setAll] = useState(false);
  const scan = ((detail.project.timeline ?? []) as TimelineEntry[]).map((t) => ({
    date: String(t.date ?? ""),
    title: String(t.title ?? ""),
    detail: t.detail ? String(t.detail) : undefined,
    tone: "neutral" as Tone,
  }));
  const activity = detail.activity.map((a) => ({
    date: a.created_at,
    title: a.title,
    detail: [a.detail, a.actor && !["system", "scan"].includes(a.actor) && !a.actor.startsWith("mcp:") ? `by ${a.actor}` : null]
      .filter(Boolean)
      .join(" · "),
    tone: severityTone[a.severity] ?? "neutral",
  }));
  const merged = [...scan, ...activity].filter((t) => t.title).sort((a, b) => b.date.localeCompare(a.date));
  const shown = all ? merged : merged.slice(0, 6);
  const items: TimelineItem[] = shown.map((t) => ({
    title: <Bidi text={t.title.trim()} />,
    when: t.date ? formatDateShort(t.date) : undefined,
    detail: t.detail ? <Bidi text={t.detail} as="span" className="line-clamp-3" /> : undefined,
    tone: t.tone,
  }));
  return (
    <Panel>
      <PanelHeader title="Timeline" />
      <PanelBody>
        {items.length ? <Timeline items={items} /> : <p className="text-ink-3">Events appear here as mail arrives and people act.</p>}
        {merged.length > 6 ? (
          <Button variant="link" className="mt-3" onClick={() => setAll((v) => !v)}>
            {all ? "Show fewer" : `Show all ${merged.length} events`}
          </Button>
        ) : null}
      </PanelBody>
    </Panel>
  );
}

function RelatedPanel({ detail }: TabProps) {
  const categoryLabel = useCategoryLabel();
  return (
    <Panel>
      <PanelHeader title="Related projects" />
      <PanelBody>
        <ul className="space-y-2">
          {detail.related.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2">
              <Link to={projectHref(r.id)} className="font-medium text-brand-ink hover:underline">
                <Bidi text={r.name} />
              </Link>
              <span className="text-sm text-ink-3">{categoryLabel(r.service_family)}</span>
              <StatusChip info={stageInfo(r.stage)} size="sm" />
            </li>
          ))}
        </ul>
      </PanelBody>
    </Panel>
  );
}
