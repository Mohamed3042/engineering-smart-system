/**
 * Suggested services (mockup 35): services we offer that this company has not asked us for yet,
 * each with the reason, the evidence behind it and a fit score. A suggestion is a lead for a
 * person to judge; nothing is added to a quotation by accepting it.
 */
import { Lightbulb } from "lucide-react";
import { useMemo, useState } from "react";
import { useCategoryLabel } from "@/api/session";
import type { Opportunity } from "@/api/types";
import { cn } from "@/lib/cn";
import { humanize, pluralize } from "@/lib/format";
import { customerKindLabel } from "@/lib/labels";
import { Button, EmptyState, ListRow, Panel, Segmented, Table, TBody, TD, TH, THead, TR, toast, toastError } from "@/ui";
import { reasonsOf, tagsOf, useUpdateOpportunity, type CustomerProjectRef, type OpportunityReason, type OpportunityStatus } from "./api";
import { useCustomerContext } from "./CustomerLayout";
import { FitChip, TagEvidenceList } from "./parts";

const VIEWS: { value: OpportunityStatus; label: string }[] = [
  { value: "suggested", label: "To review" },
  { value: "accepted", label: "Accepted" },
  { value: "dismissed", label: "Dismissed" },
];

/** One line saying what the suggestion rests on. */
function basisLine(r: OpportunityReason, label: (key: string) => string): string {
  switch (r.kind) {
    case "adjacency":
      return `They asked us for ${label(r.from ?? "")}`;
    case "adjacency_reverse":
      return `Goes with ${label(r.from ?? "")}, which they asked for`;
    case "customer_kind":
      return `Typical need of a ${customerKindLabel(r.customer_kind).toLowerCase()}`;
    case "project_type":
      return `Common in ${humanize(r.sector).toLowerCase()} projects`;
    default:
      return r.reason || humanize(r.kind);
  }
}

/** The reason in words, then each basis with its quote directly under it. Rules say so; they are not quotes. */
function Why({ o, projects }: { o: Opportunity; projects: CustomerProjectRef[] }) {
  const label = useCategoryLabel();
  const reasons = reasonsOf(o);
  return (
    <div className="space-y-2.5">
      {o.reason ? <p className="max-w-[60ch] break-words text-base text-ink">{o.reason}</p> : null}
      {reasons.length ? (
        <ul className="space-y-2.5">
          {reasons.map((r, i) => {
            const fromMail = r.kind === "adjacency" || r.kind === "adjacency_reverse";
            return (
              <li key={i}>
                <p className="text-xs font-medium text-ink-3">{basisLine(r, label)}</p>
                {r.basis?.quote ? (
                  <div className="mt-1">
                    <TagEvidenceList items={[r.basis]} projects={projects} />
                  </div>
                ) : (
                  <p className="text-xs text-ink-3">{fromMail ? "No quote was saved for this." : "A rule of thumb, not a quote from their mail."}</p>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function Actions({
  o,
  busy,
  onSet,
  block,
}: {
  o: Opportunity;
  busy: boolean;
  onSet: (o: Opportunity, status: OpportunityStatus) => void;
  block?: boolean;
}) {
  const size = block ? "md" : "sm";
  const width = block ? "w-full" : undefined;
  if (o.status === "suggested") {
    return (
      <div className={cn("flex gap-2", block ? "flex-col" : "flex-wrap")}>
        <Button size={size} className={width} loading={busy} onClick={() => onSet(o, "accepted")}>
          Accept
        </Button>
        <Button size={size} className={width} variant="secondary" disabled={busy} onClick={() => onSet(o, "dismissed")}>
          Dismiss
        </Button>
      </div>
    );
  }
  return (
    <Button size={size} className={width} variant="secondary" loading={busy} onClick={() => onSet(o, "suggested")}>
      {o.status === "dismissed" ? "Suggest again" : "Move back to review"}
    </Button>
  );
}

export function OpportunitiesTab() {
  const { detail } = useCustomerContext();
  const c = detail.customer;
  const label = useCategoryLabel();
  const update = useUpdateOpportunity(c.id);
  const [view, setView] = useState<OpportunityStatus>("suggested");

  const counts = useMemo(() => {
    const n: Record<OpportunityStatus, number> = { suggested: 0, accepted: 0, dismissed: 0 };
    for (const o of detail.opportunities) if (o.status in n) n[o.status as OpportunityStatus]++;
    return n;
  }, [detail.opportunities]);
  const shown = detail.opportunities.filter((o) => o.status === view).sort((a, b) => b.score - a.score);

  const set = (o: Opportunity, status: OpportunityStatus) =>
    update.mutate(
      { id: o.id, status },
      {
        onSuccess: () => {
          const name = label(o.service_key);
          toast.success(status === "accepted" ? `${name} accepted` : status === "dismissed" ? `${name} dismissed` : `${name} is back for review`, {
            description: status === "dismissed" ? "Re-tagging will not suggest it again." : undefined,
            action: { label: "Undo", onClick: () => update.mutate({ id: o.id, status: o.status as OpportunityStatus }) },
          });
        },
        onError: (err) => toastError(err, "The suggestion was not changed"),
      },
    );
  const busy = (o: Opportunity) => update.isPending && update.variables?.id === o.id;

  const empty =
    view === "suggested"
      ? tagsOf(c).length === 0
        ? {
            title: "Nothing to suggest yet",
            body: "Suggestions are built from this company’s tags, and it has none yet. Press Re-tag to read its mail and projects.",
          }
        : {
            title: "Nothing to review",
            body: "Suggestions come from the services this company already asked for, its kind of business and its sectors, limited to services we offer. Press Re-tag to look again after new mail arrives.",
          }
      : view === "accepted"
        ? { title: "Nothing accepted yet", body: "Accept a suggestion that is worth following up. It stays listed here." }
        : { title: "Nothing dismissed", body: "A dismissed suggestion is not suggested again when the company is re-tagged. You can bring it back from here." };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">Suggested services</h2>
          <p className="max-w-[70ch] text-sm text-ink-3">
            Services we offer that {c.name} has not asked us for. A suggestion is a lead for a person to judge; accepting one does not add
            anything to a quotation.
          </p>
        </div>
        <Segmented
          label="Show"
          value={view}
          onChange={(v) => setView(v as OpportunityStatus)}
          options={VIEWS.map((v) => ({ value: v.value, label: v.label, count: counts[v.value] }))}
        />
      </div>

      {shown.length === 0 ? (
        <Panel>
          <EmptyState icon={<Lightbulb />} title={empty.title}>
            {empty.body}
          </EmptyState>
        </Panel>
      ) : (
        <>
          <Panel className="hidden overflow-hidden lg:block">
            <Table>
              <THead>
                <tr>
                  <TH>Service</TH>
                  <TH>Why we suggest it</TH>
                  <TH>Fit</TH>
                  <TH>
                    <span className="sr-only">Actions</span>
                  </TH>
                </tr>
              </THead>
              <TBody>
                {shown.map((o) => (
                  <TR key={o.id}>
                    <TD className="min-w-[11rem] max-w-[15rem] font-semibold text-ink">{label(o.service_key)}</TD>
                    <TD className="min-w-[20rem] max-w-[34rem]">
                      <Why o={o} projects={detail.projects} />
                    </TD>
                    <TD>
                      <FitChip score={o.score} />
                    </TD>
                    <TD className="min-w-[12rem]">
                      <Actions o={o} busy={busy(o)} onSet={set} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Panel>

          <div className="space-y-3 lg:hidden">
            {shown.map((o) => (
              <ListRow
                key={o.id}
                title={label(o.service_key)}
                subtitle={reasonsOf(o).length ? pluralize(reasonsOf(o).length, "reason") : undefined}
                aside={<FitChip score={o.score} />}
                footer={<Actions o={o} busy={busy(o)} onSet={set} block />}
              >
                <Why o={o} projects={detail.projects} />
              </ListRow>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
