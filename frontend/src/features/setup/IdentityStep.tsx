import { Plus, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useWorkspace } from "@/api/session";
import type { KnowledgeItem } from "@/api/types";
import { useCanManage } from "@/features/connections/api";
import { useKnowledge } from "@/features/knowledge/api";
import { AddFindingDialog } from "@/features/knowledge/components/AddFindingDialog";
import { FindingCard } from "@/features/knowledge/components/FindingCard";
import { FindingEditor } from "@/features/knowledge/components/FindingEditor";
import { kindLabel, sortForReview } from "@/features/knowledge/model";
import { pluralize } from "@/lib/format";
import { Button, EmptyState, KeyValue, Panel, PanelBody, PanelHeader, ProgressBar, QueryState } from "@/ui";
import { StepHeader, StepNav } from "./StepFrame";

const GROUPS = [
  { kind: "service_family", title: "Service families", text: "The lines of work you quote. Each one keeps the sentences it came from." },
  { kind: "work_type", title: "Work types", text: "How you do the work." },
];

/**
 * Step 8: business discovery. The proposed service families and work types, each with its evidence, for the
 * owner to confirm or reject. Using a finding to sort mail is a separate choice, made later in Settings.
 */
export function IdentityStep() {
  const knowledge = useKnowledge();
  const canEdit = useCanManage();
  const workspace = useWorkspace();
  const [editing, setEditing] = useState<KnowledgeItem | null>(null);
  const [adding, setAdding] = useState<string | null>(null);

  const items = useMemo(() => knowledge.data?.items ?? [], [knowledge.data]);
  const decided = (k: string) => items.filter((i) => i.kind === k);
  const proposals = items.filter((i) => i.kind === "service_family" || i.kind === "work_type");
  const confirmed = proposals.filter((i) => i.status === "owner_confirmed").length;
  const waiting = proposals.filter((i) => i.status === "suggested").length;
  const others = (["term", "standard", "convention"] as const)
    .map((k) => ({ kind: k, n: decided(k).length }))
    .filter((x) => x.n > 0);

  return (
    <>
      <StepHeader
        title="Review what we learned"
        description="Confirm what your company really does, or reject what is wrong. Each finding shows the sentence it came from. Nothing counts as fact until you confirm it."
      />

      <div className="space-y-6">
        <Panel>
          <PanelHeader
            title="Your company"
            actions={
              <Button asChild variant="link" size="sm">
                <Link to="/setup/workspace">Change</Link>
              </Button>
            }
          />
          <PanelBody className="py-1">
            <KeyValue
              labelWidth="sm"
              items={[
                { label: "Company", value: workspace.company_name || workspace.name },
                { label: "Mailbox", value: workspace.primary_email || null },
                { label: "Region", value: [workspace.region, workspace.country].filter(Boolean).join(" · ") || null },
              ]}
            />
          </PanelBody>
        </Panel>

        <QueryState
          query={knowledge}
          isEmpty={() => proposals.length === 0}
          empty={
            <Panel>
              <EmptyState
                icon={<Sparkles />}
                title="Nothing to review yet"
                action={
                  <>
                    <Button asChild variant="secondary">
                      <Link to="/setup/learning">Go to learning</Link>
                    </Button>
                    {canEdit ? (
                      <Button icon={<Plus />} onClick={() => setAdding("service_family")}>
                        Add a service family
                      </Button>
                    ) : null}
                  </>
                }
              >
                Service families and work types appear here after learning has read your mail and company folders. You can also state what you do yourself.
              </EmptyState>
            </Panel>
          }
        >
          {() => (
            <>
              <div className="space-y-2" role="status" aria-live="polite">
                <p className="text-sm text-ink-2">
                  <span className="font-semibold text-ink tabular">
                    {confirmed} of {proposals.length}
                  </span>{" "}
                  confirmed{waiting > 0 ? `, ${waiting} waiting for you` : ""}
                </p>
                <ProgressBar value={proposals.length ? confirmed / proposals.length : 0} label="Findings confirmed" />
              </div>
              {GROUPS.map((g) => {
                const rows = sortForReview(decided(g.kind));
                if (rows.length === 0) return null;
                return (
                  <Panel key={g.kind}>
                    <PanelHeader
                      title={g.title}
                      description={g.text}
                      actions={
                        canEdit ? (
                          <Button variant="secondary" size="sm" icon={<Plus />} onClick={() => setAdding(g.kind)}>
                            Add
                          </Button>
                        ) : null
                      }
                    />
                    <ul className="divide-y divide-line" aria-label={g.title}>
                      {rows.map((item) => (
                        <FindingCard key={item.id} item={item} canEdit={canEdit} onEdit={setEditing} showSorting={false} />
                      ))}
                    </ul>
                  </Panel>
                );
              })}
            </>
          )}
        </QueryState>

        {others.length ? (
          <p className="text-sm text-ink-3">
            Also found: {others.map((o) => pluralize(o.n, kindLabel(o.kind).toLowerCase(), kindLabel(o.kind, true).toLowerCase())).join(", ")}. Review them, and decide which words may sort mail, in
            Settings under Business knowledge.
          </p>
        ) : null}
      </div>

      <FindingEditor item={editing} canEdit={canEdit} onClose={() => setEditing(null)} />
      <AddFindingDialog kind={adding ?? "service_family"} open={adding !== null} onOpenChange={(o) => !o && setAdding(null)} />

      <StepNav
        continueLabel="Finish setup"
        reason={undefined}
        skip={waiting > 0 ? "Decide later" : undefined}
        skipHint={waiting > 0 ? `${pluralize(waiting, "finding")} stay in review. You can confirm them any time in Settings, under Business knowledge.` : undefined}
      />
    </>
  );
}
