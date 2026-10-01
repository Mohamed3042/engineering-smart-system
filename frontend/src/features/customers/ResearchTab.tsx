/**
 * Research report (mockup 33). Every finding shows the sentence it came from; findings below the
 * chosen standard stay visible but marked, and everything missing is listed as a gap.
 */
import { Check, CircleAlert, Clock, FileSearch, History, RefreshCw, Search } from "lucide-react";
import { useMemo } from "react";
import { useSearchParams } from "react-router";
import type { ResearchReport } from "@/api/types";
import { cn } from "@/lib/cn";
import { formatDateTime, formatRelative, humanize, pluralize } from "@/lib/format";
import {
  Banner,
  Button,
  Chip,
  CollapsibleSection,
  Confidence,
  EmptyState,
  ErrorState,
  EvidenceQuote,
  Panel,
  PanelBody,
  PanelHeader,
  Skeleton,
  Spinner,
  StatusChip,
} from "@/ui";
import { gapsOf, sectionsOf, useResearchHistory, type ResearchClaim, type ResearchGap, type ResearchSource } from "./api";
import { useCustomerContext } from "./CustomerLayout";
import {
  gapKindInfo,
  RESEARCH_SECTIONS,
  researchSourceHref,
  researchSourceTitle,
  researchStatusInfo,
  sectionLabel,
  sectionStatusInfo,
  sourceKindLabel,
  standardInfo,
  verificationLabel,
} from "./lib";

export function ResearchTab() {
  const { detail, openResearch } = useCustomerContext();
  const c = detail.customer;
  const history = useResearchHistory(c.id);
  const [params, setParams] = useSearchParams();
  const reports = history.data ?? [];
  const selected = reports.find((r) => r.id === params.get("report")) ?? reports[0];

  if (history.isLoading) {
    return (
      <div className="space-y-4" role="status" aria-label="Loading research">
        <Skeleton className="h-32 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
      </div>
    );
  }
  if (history.isError) {
    return (
      <Panel>
        <ErrorState error={history.error} onRetry={() => history.refetch()} />
      </Panel>
    );
  }
  if (!selected) {
    return (
      <Panel>
        <EmptyState
          icon={<FileSearch />}
          title="No research yet"
          action={
            <Button icon={<Search />} onClick={openResearch}>
              Run research
            </Button>
          }
        >
          Research builds a profile from their website, news, registries and our own mail. Every finding quotes its source, and
          anything that misses the standard is listed as a gap instead of being hidden.
        </EmptyState>
      </Panel>
    );
  }

  const select = (id: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (id === reports[0]?.id) n.delete("report");
        else n.set("report", id);
        return n;
      },
      { replace: true },
    );

  return (
    <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start">
      <div className="min-w-0 space-y-6">
        {selected.status === "running" ? (
          <Panel>
            <PanelBody className="flex items-start gap-3 py-5">
              <Spinner className="mt-0.5" label="Researching" />
              <div>
                <p className="font-semibold text-ink">Researching at the {standardInfo(selected.standard).label.toLowerCase()} standard</p>
                <p className="mt-0.5 text-sm text-ink-3">
                  Started {formatRelative(selected.created_at).toLowerCase()}. This page updates by itself; you can leave it.
                </p>
              </div>
            </PanelBody>
          </Panel>
        ) : selected.status === "failed" ? (
          <Banner
            tone="block"
            title="This research did not finish"
            actions={
              <Button variant="secondary" icon={<RefreshCw />} onClick={openResearch}>
                Try again
              </Button>
            }
          >
            {selected.error || "The search or a page download failed."} Nothing in the profile was changed.
          </Banner>
        ) : (
          <ReportView report={selected} onRerun={openResearch} isLatest={selected.id === reports[0]?.id} />
        )}
      </div>

      <aside className="space-y-6">
        <StandardPanel standard={selected.standard} />
        {reports.length > 1 ? <HistoryPanel reports={reports} selectedId={selected.id} onSelect={select} /> : null}
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------------ report */

function ReportView({ report, onRerun, isLatest }: { report: ResearchReport; onRerun: () => void; isLatest: boolean }) {
  const sections = sectionsOf(report);
  const gaps = gapsOf(report);
  const info = standardInfo(report.standard);
  const withClaims = RESEARCH_SECTIONS.filter((s) => (sections[s.key]?.claims?.length ?? 0) > 0);
  const notFound = RESEARCH_SECTIONS.filter((s) => !(sections[s.key]?.claims?.length ?? 0));
  const blocking = gaps.filter((g) => g.kind === "identity_unconfirmed" || g.kind === "news_not_searched");
  const claimCount = withClaims.reduce((n, s) => n + (sections[s.key]?.claims.length ?? 0), 0);
  const below = withClaims.reduce((n, s) => n + (sections[s.key]?.claims.filter((c) => !c.meets_standard).length ?? 0), 0);

  return (
    <>
      <Panel>
        <PanelHeader
          title="Research summary"
          description={`${info.label} standard · ${formatDateTime(report.finished_at ?? report.created_at)}${report.provider ? ` · searched with ${humanize(report.provider)}` : ""}`}
          actions={
            isLatest ? (
              <Button variant="secondary" size="sm" icon={<RefreshCw />} onClick={onRerun}>
                Research again
              </Button>
            ) : (
              <Chip size="sm" tone="muted">
                Earlier report
              </Chip>
            )
          }
        />
        <PanelBody className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {report.met_standard ? (
              <Chip tone="brand" icon={<Check aria-hidden />}>
                {info.label} standard met
              </Chip>
            ) : (
              <Chip tone="review" icon={<Clock aria-hidden />}>
                {info.label} standard not met
              </Chip>
            )}
            <span className="text-sm text-ink-2 tabular">
              {pluralize(claimCount, "finding")} · {pluralize(report.evidence_count, "quoted source")}
              {below ? ` · ${below} below standard` : ""}
            </span>
          </div>
          {report.summary ? <p className="max-w-[75ch] text-base leading-relaxed text-ink">{report.summary}</p> : null}
          {blocking.map((g, i) => (
            <Banner key={i} tone="block" title={gapKindInfo(g.kind).label}>
              {g.message}
            </Banner>
          ))}
          <p className="rounded-lg border border-line bg-sunken px-3.5 py-2.5 text-sm text-ink-2">
            <span className="font-semibold text-ink">Web results are context, not proof.</span> Each finding shows the sentence it came
            from. “Quote found on the page” checks the wording, not whether the claim is true or still current.
          </p>
        </PanelBody>
      </Panel>

      {withClaims.map((s, i) => {
        const sec = sections[s.key];
        const n = sec.claims.length;
        const low = sec.claims.filter((c) => !c.meets_standard).length;
        return (
          <CollapsibleSection
            key={s.key}
            defaultOpen={i < 4}
            title={s.label}
            summary={
              <span className="inline-flex items-center gap-2">
                <StatusChip info={sectionStatusInfo(sec.status)} size="sm" />
                <span className="tabular">
                  {pluralize(n, "finding")}
                  {low ? ` · ${low} below standard` : ""}
                </span>
              </span>
            }
          >
            <ul className="-my-1 divide-y divide-line">
              {sec.claims.map((claim, j) => (
                <ClaimItem key={j} claim={claim} />
              ))}
            </ul>
          </CollapsibleSection>
        );
      })}

      {notFound.length ? (
        <p className="text-sm text-ink-3">
          <span className="font-medium text-ink-2">Not found:</span> {notFound.map((s) => s.label).join(", ")}.
        </p>
      ) : null}

      <GapsPanel gaps={gaps.filter((g) => !blocking.includes(g))} />
    </>
  );
}

function ClaimItem({ claim }: { claim: ResearchClaim }) {
  return (
    <li className="py-4 first:pt-1 last:pb-1">
      <p className="max-w-[75ch] text-base text-ink">{claim.text}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-3">
        {claim.meets_standard ? (
          <Chip size="sm" tone="brand" icon={<Check aria-hidden />}>
            Meets standard
          </Chip>
        ) : (
          <Chip size="sm" tone="review" icon={<Clock aria-hidden />}>
            Below standard
          </Chip>
        )}
        {claim.sources.length ? <Confidence value={claim.confidence} className="text-xs" /> : null}
        <span className="tabular">{pluralize(claim.independent_sources, "independent source")}</span>
        {claim.origin === "ai" ? <span>Worded by AI, quote checked</span> : null}
        {claim.derived ? <span>Derived from our tags</span> : null}
      </div>
      {claim.needs ? <p className="mt-1.5 text-sm text-review">To meet the standard: {claim.needs}</p> : null}
      {claim.sources.length ? (
        <div className="mt-3 space-y-2">
          {claim.sources.map((s, k) => (
            <SourceQuote key={k} source={s} />
          ))}
        </div>
      ) : null}
    </li>
  );
}

function SourceQuote({ source }: { source: ResearchSource }) {
  const href = researchSourceHref(source);
  const when = source.published ?? source.date;
  return (
    <EvidenceQuote
      href={href}
      evidence={{
        quote: source.quote,
        source_type: source.kind === "own_email" ? "email" : "web",
        source_label: researchSourceTitle(source),
        url: href ?? undefined,
      }}
      action={
        <span className="text-ink-3">
          {sourceKindLabel(source.kind)}
          {source.verification ? ` · ${verificationLabel(source.verification)}` : ""}
          {when ? ` · ${formatRelative(when)}` : ""}
        </span>
      }
    />
  );
}

function GapsPanel({ gaps }: { gaps: ResearchGap[] }) {
  const ordered = useMemo(() => {
    const rank = (g: ResearchGap) => ["below_standard", "no_search_provider", "not_found", "ai_gap"].indexOf(g.kind);
    return [...gaps].sort((a, b) => {
      const ra = rank(a) < 0 ? 9 : rank(a);
      const rb = rank(b) < 0 ? 9 : rank(b);
      return ra - rb;
    });
  }, [gaps]);
  if (gaps.length === 0) return null;
  const errors = gaps.filter((g) => g.kind === "source_error").length;
  return (
    <CollapsibleSection
      title="Gaps"
      summary={`${pluralize(gaps.length, "gap")}${errors ? ` · ${errors} source ${errors === 1 ? "error" : "errors"}` : ""}`}
    >
      <p className="mb-3 text-sm text-ink-3">What the research could not confirm. A gap is not a failure; it tells you what to check by hand.</p>
      <ul className="divide-y divide-line">
        {ordered.map((g, i) => {
          const k = gapKindInfo(g.kind);
          return (
            <li key={i} className="flex flex-col gap-1.5 py-2.5 sm:flex-row sm:items-start sm:gap-3">
              <span className="sm:w-40 sm:shrink-0">
                <StatusChip info={k} size="sm" />
              </span>
              <div className="min-w-0 text-sm">
                {g.section ? <span className="font-medium text-ink">{sectionLabel(g.section)}: </span> : null}
                <span className="break-words text-ink-2">{g.message}</span>
                {g.claim ? <p className="mt-0.5 break-words text-xs text-ink-3">“{g.claim}”</p> : null}
              </div>
            </li>
          );
        })}
      </ul>
    </CollapsibleSection>
  );
}

/* ------------------------------------------------------------------ side */

function StandardPanel({ standard }: { standard: string }) {
  const info = standardInfo(standard);
  return (
    <Panel>
      <PanelHeader title={`${info.label} standard`} description={info.summary} />
      <PanelBody>
        <ul className="space-y-2 text-sm text-ink-2">
          {info.needs.map((n) => (
            <li key={n} className="flex gap-2">
              <Check className="mt-0.5 size-4 shrink-0 text-brand-ink" aria-hidden />
              {n}
            </li>
          ))}
          <li className="flex gap-2">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
            Only fails when the company’s identity cannot be confirmed{info.value === "deep" ? " or the news search could not run" : ""}.
          </li>
        </ul>
        <p className="mt-3 text-xs text-ink-3">{info.effort}.</p>
      </PanelBody>
    </Panel>
  );
}

function HistoryPanel({ reports, selectedId, onSelect }: { reports: ResearchReport[]; selectedId: string; onSelect: (id: string) => void }) {
  return (
    <Panel>
      <PanelHeader title="Research history" description={pluralize(reports.length, "report")} />
      <ul className="p-2">
        {reports.map((r) => {
          const active = r.id === selectedId;
          const status =
            r.status === "done"
              ? r.met_standard
                ? { label: "Met", tone: "brand" as const }
                : { label: "Not met", tone: "review" as const }
              : researchStatusInfo(r.status);
          return (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => onSelect(r.id)}
                aria-current={active ? "true" : undefined}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand",
                  active ? "bg-brand-soft" : "hover:bg-hover",
                )}
              >
                <History className="size-4 shrink-0 text-ink-3" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className={cn("block text-sm font-medium", active ? "text-brand-ink" : "text-ink")}>
                    {standardInfo(r.standard).label} · {formatRelative(r.created_at)}
                  </span>
                  <span className="block text-xs text-ink-3 tabular">
                    {r.status === "done" ? pluralize(r.evidence_count, "quoted source") : researchStatusInfo(r.status).label}
                  </span>
                </span>
                <StatusChip info={status} size="sm" />
              </button>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
