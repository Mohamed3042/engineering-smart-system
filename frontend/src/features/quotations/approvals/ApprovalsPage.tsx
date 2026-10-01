/**
 * /quotations/approvals (mockup 28): quotations waiting for commercial approval with their open
 * conditions, and the history of decisions (who, what, which revision, note, when).
 */
import { Check, CircleCheck, CircleDashed, CircleX, ClipboardCheck } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router";
import { useCategoryLabel, useWorkspace } from "@/api/session";
import type { Approval, Project, Workspace } from "@/api/types";
import { formatDateShort, formatDateTime, formatRelative, isRtl } from "@/lib/format";
import { reviewStatusInfo } from "@/lib/labels";
import { quotationHref } from "@/lib/routes";
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  ListRow,
  LoadingRows,
  Page,
  PageHeader,
  Panel,
  Section,
  StatusChip,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/ui";
import { ALL_STATUSES, useApprovals, useQuotations, type Quote } from "../api";
import { QuoteStatusChip } from "../components";
import { BLOCKER_LABEL, blockersOf, describeApproval, engineeringRequired, revisionLabel } from "../lib";

type Pending = Quote & { project: Project | null };

function Conditions({ q }: { q: Pending }) {
  const blockers = blockersOf(q);
  if (!blockers.length)
    return (
      <Chip tone="brand" size="sm" icon={<CircleCheck aria-hidden />}>
        Ready to approve
      </Chip>
    );
  return (
    <ul className="space-y-1">
      {blockers.map((b) => (
        <li key={b.code} className="flex items-start gap-1.5 text-sm text-ink-2" title={b.message}>
          <CircleDashed className="mt-0.5 size-4 shrink-0 text-review-mark" aria-hidden />
          <span>
            <span className="sr-only">Open: </span>
            {BLOCKER_LABEL[b.code] ?? b.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

function EngineeringChip({ project, ws }: { project: Project | null; ws: Workspace }) {
  if (!engineeringRequired(ws)) return <span className="text-sm text-ink-3">Not required</span>;
  return <StatusChip info={reviewStatusInfo(project?.review_status ?? "not_started")} size="sm" />;
}

function reviewLabel(q: Pending) {
  return blockersOf(q).length ? "Review" : "Review and approve";
}

function PendingQueue({ items, ws }: { items: Pending[]; ws: Workspace }) {
  const familyLabel = useCategoryLabel();
  if (!items.length)
    return (
      <Panel>
        <EmptyState icon={<ClipboardCheck />} title="Nothing waits for approval">
          A quotation appears here when someone submits it for approval in the editor. Its open conditions show next to it.
        </EmptyState>
      </Panel>
    );
  return (
    <>
      <Panel className="hidden lg:block">
        <Table>
          <THead>
            <tr>
              <TH>Quotation</TH>
              <TH>Project</TH>
              <TH>Contractor</TH>
              <TH>Engineering review</TH>
              <TH>Open conditions</TH>
              <TH>Waiting since</TH>
              <TH>
                <span className="sr-only">Action</span>
              </TH>
            </tr>
          </THead>
          <TBody>
            {items.map((q) => (
              <TR key={q.id}>
                <TD className="whitespace-nowrap">
                  <Link to={quotationHref(q.id)} className="font-semibold text-brand-ink tabular underline-offset-4 hover:underline">
                    {revisionLabel(q)}
                  </Link>
                </TD>
                <TD className="max-w-64">
                  <p className="line-clamp-2 text-ink">{q.project?.name ?? "—"}</p>
                  {q.project ? <p className="text-sm text-ink-3">{familyLabel(q.project.service_family)}</p> : null}
                </TD>
                <TD className="max-w-56">
                  <p dir={isRtl(q.data.to?.company) ? "rtl" : "auto"} className="line-clamp-2 text-ink-2">
                    {q.data.to?.company || "—"}
                  </p>
                </TD>
                <TD>
                  <EngineeringChip project={q.project} ws={ws} />
                </TD>
                <TD>
                  <Conditions q={q} />
                </TD>
                <TD className="whitespace-nowrap text-sm" title={formatDateTime(q.updated_at)}>
                  <p className="text-ink-2">{formatDateShort(q.updated_at)}</p>
                  <p className="text-ink-3">{formatRelative(q.updated_at)}</p>
                </TD>
                <TD className="text-right">
                  <Button size="sm" asChild>
                    <Link to={quotationHref(q.id)} aria-label={`${reviewLabel(q)} ${revisionLabel(q)}`}>
                      {reviewLabel(q)}
                    </Link>
                  </Button>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Panel>

      <ul className="space-y-3 lg:hidden">
        {items.map((q) => (
          <li key={q.id}>
            <ListRow
              title={<span className="tabular">{revisionLabel(q)}</span>}
              subtitle={q.project?.name ?? "No project"}
              aside={<QuoteStatusChip q={q} size="sm" />}
              footer={
                <Button className="w-full" asChild>
                  <Link to={quotationHref(q.id)}>{reviewLabel(q)}</Link>
                </Button>
              }
            >
              <dl className="space-y-3">
                <div>
                  <dt className="text-ink-3">Contractor</dt>
                  <dd dir={isRtl(q.data.to?.company) ? "rtl" : "auto"} className="text-ink">
                    {q.data.to?.company || "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-ink-3">Engineering review</dt>
                  <dd className="mt-0.5">
                    <EngineeringChip project={q.project} ws={ws} />
                  </dd>
                </div>
                <div>
                  <dt className="text-ink-3">Open conditions</dt>
                  <dd className="mt-0.5">
                    <Conditions q={q} />
                  </dd>
                </div>
                <div>
                  <dt className="text-ink-3">Waiting since</dt>
                  <dd className="text-ink">
                    {formatDateShort(q.updated_at)} <span className="text-ink-3">({formatRelative(q.updated_at)})</span>
                  </dd>
                </div>
              </dl>
            </ListRow>
          </li>
        ))}
      </ul>
    </>
  );
}

function DecisionChip({ a }: { a: Approval }) {
  const d = describeApproval(a);
  return (
    <Chip tone={d.tone} size="sm" icon={d.tone === "block" ? <CircleX aria-hidden /> : <Check aria-hidden />}>
      {d.label}
    </Chip>
  );
}

function History({ rows, labelFor }: { rows: Approval[]; labelFor: (a: Approval) => string }) {
  if (!rows.length)
    return (
      <Panel>
        <EmptyState compact title="No decisions yet">
          Approvals, change requests and sends are recorded here with the person, the date and the exact revision.
        </EmptyState>
      </Panel>
    );
  const noteOf = (a: Approval) => {
    const d = describeApproval(a);
    return a.action === "send_quotation" ? (d.recipients.length ? `To ${d.recipients.join(", ")}` : "") : a.note;
  };
  return (
    <>
      <Panel className="hidden lg:block">
        <Table>
          <THead>
            <tr>
              <TH>When</TH>
              <TH>Quotation</TH>
              <TH>Decision</TH>
              <TH>By</TH>
              <TH>Note</TH>
            </tr>
          </THead>
          <TBody>
            {rows.map((a) => (
              <TR key={a.id}>
                <TD className="whitespace-nowrap text-sm text-ink-2">{formatDateTime(a.created_at)}</TD>
                <TD className="whitespace-nowrap">
                  <Link to={quotationHref(a.target_id)} className="font-medium text-brand-ink tabular underline-offset-4 hover:underline">
                    {labelFor(a)}
                  </Link>
                </TD>
                <TD>
                  <DecisionChip a={a} />
                </TD>
                <TD className="whitespace-nowrap text-ink-2">{a.decided_by || "—"}</TD>
                <TD className="max-w-md">
                  <p dir={isRtl(noteOf(a)) ? "rtl" : "auto"} className="line-clamp-3 whitespace-pre-line text-sm text-ink-2">
                    {noteOf(a) || <span className="text-ink-3">—</span>}
                  </p>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Panel>
      <ul className="space-y-3 lg:hidden">
        {rows.map((a) => (
          <li key={a.id}>
            <ListRow
              to={quotationHref(a.target_id)}
              title={<span className="tabular">{labelFor(a)}</span>}
              subtitle={`${a.decided_by || "—"} · ${formatDateTime(a.created_at)}`}
              aside={<DecisionChip a={a} />}
            >
              {noteOf(a) ? (
                <p dir={isRtl(noteOf(a)) ? "rtl" : "auto"} className="whitespace-pre-line">
                  {noteOf(a)}
                </p>
              ) : null}
            </ListRow>
          </li>
        ))}
      </ul>
    </>
  );
}

export function ApprovalsPage() {
  const ws = useWorkspace();
  const queue = useApprovals();
  const all = useQuotations({ status: ALL_STATUSES });
  const byId = useMemo(() => new Map((all.data?.items ?? []).map((x) => [x.id, x])), [all.data]);
  const history = (queue.data?.history ?? []).filter((a) => a.target_type === "quotation");
  const labelFor = (a: Approval) => {
    const rev = (a.revision ?? "").split(" pdf:")[0];
    if (rev) return rev;
    const q = byId.get(a.target_id);
    return q ? revisionLabel(q) : "Quotation";
  };

  return (
    <Page>
      <PageHeader
        back={{ to: "/quotations", label: "Quotations" }}
        title="Approvals"
        meta="Commercial approval of quotations. Every decision names the person, the date and the exact revision."
      />
      {queue.isLoading ? (
        <Panel>
          <LoadingRows rows={4} />
        </Panel>
      ) : queue.isError ? (
        <Panel>
          <ErrorState error={queue.error} onRetry={() => queue.refetch()} />
        </Panel>
      ) : (
        <div className="space-y-10">
          <Section title="Waiting for approval" description="Oldest first. Approval stays blocked while a condition is open.">
            <PendingQueue items={queue.data?.pending ?? []} ws={ws} />
          </Section>
          <Section title="Decision history" description="The latest 50 decisions on quotations.">
            <History rows={history} labelFor={labelFor} />
          </Section>
        </div>
      )}
    </Page>
  );
}
