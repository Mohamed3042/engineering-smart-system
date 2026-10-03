import { BookOpen, Building2, ChevronRight, CircleAlert, FileSearch, FolderOpen } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { useSession } from "@/api/session";
import { cn } from "@/lib/cn";
import { formatDateShort, pluralize } from "@/lib/format";
import { stageInfo } from "@/lib/labels";
import { nextActionHref, projectHref } from "@/lib/routes";
import { Button, EvidenceQuote, Panel, PanelBody, PanelHeader, StatusChip } from "@/ui";
import { useKnowledge } from "@/features/knowledge/api";
import { changeValues, latestChange, nextActionText, type DashboardRow } from "./dashboard";

/** A selected decision stays beside its original evidence. No generated summaries or invented state. */
export function DecisionDesk({ rows, heading }: { rows: DashboardRow[]; heading: string }) {
  const [selectedId, setSelectedId] = useState<string>();
  const selected = rows.find(r => r.id === selectedId) ?? rows[0];
  if (!selected) return null;
  const change = latestChange(selected);
  const action = nextActionText(selected.next_action);
  const activeId = selected.id;
  return <div className="hidden items-start gap-4 lg:grid min-[1150px]:grid-cols-[minmax(0,1fr)_285px]">
    <Panel className="min-w-0 overflow-hidden">
      <PanelHeader title={heading} />
      <div className="grid grid-cols-[1fr_1.2fr_.85fr] gap-4 border-b border-line bg-sunken/60 px-5 py-3 text-xs text-ink-3" aria-hidden="true">
        <span>Project</span><span>What changed</span><span>Next step</span>
      </div>
      <ul className="divide-y divide-line">
        {rows.map(row => {
          const latest = latestChange(row);
          const values = latest ? changeValues(latest) : null;
          const selected = row.id === activeId;
          return <li key={row.id}>
            <button type="button" aria-pressed={selected} onClick={() => setSelectedId(row.id)} className={cn("grid w-full grid-cols-[1fr_1.2fr_.85fr] items-start gap-4 px-5 py-5 text-left transition-colors hover:bg-hover", selected && "ess-decision-selected bg-brand-soft/45")}>
              <span className="flex min-w-0 gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand"><Building2 className="size-5" aria-hidden /></span><span className="min-w-0"><bdi dir="auto" className="block font-semibold text-ink">{row.name}</bdi><span className="mt-1 block text-xs text-ink-3">{row.customer || row.code || "No customer linked"}</span></span></span>
              <span className="min-w-0"><span className="block text-sm font-medium">{latest?.title || row.blockers[0]?.text || "No open changes"}</span>{values && <span className="mt-1 block text-sm text-ink-2">{values}</span>}<span className="mt-1 block text-xs text-ink-3">{formatDateShort(latest?.date || row.updated_at)}</span></span>
              <span className="space-y-2"><StatusChip info={stageInfo(row.stage)} size="sm" /><span className="block text-xs text-ink-2">{nextActionText(row.next_action)?.button || "View project"}</span></span>
            </button>
          </li>;
        })}
      </ul>
    </Panel>
    <Panel className="min-w-0 min-[1150px]:sticky min-[1150px]:top-5" aria-live="polite">
      <PanelHeader title={<bdi dir="auto">{selected.name}</bdi>} description="Selected project" />
      <PanelBody className="space-y-5">
        <div><h3 className="mb-2 font-semibold">Decision needed</h3><div className="rounded-lg border border-review-line bg-review-soft p-3"><p className="font-medium text-review">{action?.button || "Review project"}</p><p className="mt-1 text-sm text-ink-2">{action?.detail || change?.title || "Open the project to review its scope and current status."}</p></div></div>
        {change?.evidence && <div><h3 className="mb-2 font-semibold">Evidence</h3><EvidenceQuote evidence={change.evidence} /></div>}
        {!!selected.blockers.length && <div><h3 className="mb-2 font-semibold">Open blockers</h3><ul className="space-y-2">{selected.blockers.slice(0, 3).map((b,i) => <li key={i} className="flex gap-2 text-sm text-ink-2"><CircleAlert className="mt-0.5 size-4 shrink-0 text-block" aria-hidden />{b.text}</li>)}</ul></div>}
        <div className="space-y-2"><Button asChild className="w-full"><Link to={nextActionHref(selected.id, selected.next_action)}>{action?.button || "Open project"}<ChevronRight aria-hidden /></Link></Button><Button asChild variant="secondary" className="w-full"><Link to={projectHref(selected.id)}><FolderOpen aria-hidden />Project overview</Link></Button></div>
      </PanelBody>
    </Panel>
  </div>;
}

/** Real setup progress makes an empty installation useful without demo projects. */
export function CompanyStartingPoint() {
  const { data: session } = useSession();
  const knowledge = useKnowledge();
  if (!session?.workspace) return null;
  const items = knowledge.data?.items.filter(i => i.status !== "rejected") ?? [];
  const services = items.filter(i => i.kind === "service_family");
  const suggested = items.filter(i => i.status === "suggested").length;
  return <div className="mb-6 grid gap-4 md:grid-cols-[1.5fr_1fr]">
    <Panel><PanelHeader title="Your company workspace" description={session.workspace.company_name} /><PanelBody>
      {knowledge.isError ? <p className="text-sm text-block">Company knowledge could not be loaded. <button onClick={() => knowledge.refetch()} className="underline">Retry</button></p> : knowledge.isLoading ? <p className="text-sm text-ink-3">Loading company knowledge…</p> : <><p className="text-sm text-ink-2">{services.length ? `${pluralize(services.length, "service family")} found in your company sources.` : "Start with company documents to build your service vocabulary."} {suggested > 0 ? `${suggested} findings await your review.` : ""}</p>{services.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{services.slice(0,6).map(s => <span key={s.id} className="rounded-md border border-brand-line bg-brand-soft px-2 py-1 text-xs text-brand-ink">{s.label}</span>)}{services.length > 6 && <span className="self-center text-xs text-ink-3">+{services.length-6} more</span>}</div>}</>}
      <Button asChild variant="link" className="mt-4"><Link to="/settings/knowledge"><BookOpen aria-hidden />Review business knowledge<ChevronRight aria-hidden /></Link></Button>
    </PanelBody></Panel>
    <Panel><PanelHeader title="Bring in your first enquiry" description="From source documents to a reviewed quotation." /><PanelBody><p className="mb-4 text-sm text-ink-2">Create a project and attach its files. Scope, engineering review and pricing remain separate steps.</p><Button asChild variant="secondary"><Link to="/projects"><FileSearch aria-hidden />Open projects<ChevronRight aria-hidden /></Link></Button></PanelBody></Panel>
  </div>;
}
