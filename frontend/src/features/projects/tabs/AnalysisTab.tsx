/**
 * Analysis (mockup 21): what the customer asks for, each fact with the sentence it came from; scope
 * items with stated quantities only; open questions and drawing findings. "Source found" confirms the
 * quote was found in the source, not that the design is adequate.
 */
import { CircleHelp, FileSearch, Info, ListChecks, LoaderCircle, Play, RefreshCw, ScrollText } from "lucide-react";
import { Link } from "react-router";
import { api } from "@/api/client";
import type { Evidence } from "@/api/types";
import { cn } from "@/lib/cn";
import { formatDateTime, formatRelative, humanize } from "@/lib/format";
import type { StatusInfo } from "@/lib/labels";
import { fileHref } from "@/lib/routes";
import {
  Button,
  EmptyState,
  EvidenceQuote,
  KeyValue,
  Panel,
  PanelBody,
  PanelHeader,
  StatusChip,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/ui";
import { markBusy, useProjectMutation, type ProjectAnalysis, type ProjectDetail } from "../api";
import { DrawingFindings, drawingPages, QtyValue } from "../fileParts";
import { displayValue, firstEvidence, withSource } from "../lib";
import { Bidi } from "../parts";
import type { TabProps } from "../ProjectLayout";

export function AnalysisTab({ detail }: TabProps) {
  return (
    <div className="space-y-6">
      <AnalysisStatus detail={detail} />
      <div className="grid gap-6 lg:grid-cols-2">
        <SummaryPanel detail={detail} />
        <QuestionsPanel detail={detail} />
      </div>
      <RequirementsPanel detail={detail} />
      <ScopePanel detail={detail} />
      <DrawingsPanel detail={detail} />
    </div>
  );
}

function evidenceOf(ev: unknown, detail: ProjectDetail): Evidence | null {
  const e = firstEvidence(ev);
  return e ? withSource(e, detail.emails, detail.files) : null;
}

/* ------------------------------------------------------------------ status + run */

function engineText(engine?: string): string | null {
  if (!engine) return null;
  return engine === "rules" ? "rules only, no AI engine" : `engine ${engine}`;
}

function AnalysisStatus({ detail }: TabProps) {
  const p = detail.project;
  const a = (p.analysis ?? {}) as ProjectAnalysis;
  const running = a.status === "running";
  const done = a.status === "done";
  const ready = detail.files.filter((f) => f.status === "ready");
  const unread = ready.filter((f) => f.extraction_status === "pending");

  const run = useProjectMutation(
    async () => {
      const r = await api.post<{ started: boolean; running?: boolean }>(`/projects/${encodeURIComponent(p.id)}/analyze`);
      markBusy(p.id, 120_000);
      return r;
    },
    {
      projectId: p.id,
      success: (r) => (r.started ? "Analysis started. Results appear here when it finishes." : "The analysis is already running."),
    },
  );
  const extract = useProjectMutation(
    async () => {
      const r = await api.post<{ started: boolean }>(`/projects/${encodeURIComponent(p.id)}/extract`);
      markBusy(p.id);
      return r;
    },
    {
      projectId: p.id,
      success: (r) =>
        r.started ? `Reading ${unread.length} ${unread.length === 1 ? "file" : "files"} now.` : "The files are already being read.",
    },
  );

  const info: StatusInfo = running
    ? { label: "Running", tone: "neutral" }
    : done
      ? { label: "Done", tone: "brand" }
      : a.status === "failed"
        ? { label: "Failed", tone: "block" }
        : { label: "Not run yet", tone: "neutral" };
  const line = running
    ? `Started ${formatRelative(a.started_at)}. Results appear here when it finishes.`
    : done
      ? [
          `Ran ${formatDateTime(a.ran_at)}`,
          a.by && a.by !== "system" ? `by ${a.by}` : null,
          typeof a.stats?.files === "number" ? `${a.stats.files} ${a.stats.files === 1 ? "file" : "files"} read` : null,
          engineText(a.stats?.engine),
        ]
          .filter(Boolean)
          .join(" · ")
      : a.status === "failed"
        ? a.error || "The analysis stopped with an error."
        : ready.length
          ? "Reads the emails and downloaded files and extracts requirements, scope items and open questions."
          : "No downloaded files yet. The analysis can read the emails now, and the files once they are in.";

  return (
    <Panel>
      <div className="flex flex-col gap-4 px-5 py-4 md:flex-row md:items-center">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-ink">Scope analysis</h2>
            <StatusChip
              info={info}
              size="sm"
              icon={running ? <LoaderCircle className="animate-spin" aria-hidden /> : undefined}
            />
          </div>
          <p className={cn("mt-1 text-sm", a.status === "failed" ? "text-block" : "text-ink-2")}>{line}</p>
          {a.notes?.length && !running ? (
            <ul className="mt-2 space-y-1 text-sm text-ink-3">
              {a.notes.map((n, i) => (
                <li key={i} className="flex gap-2">
                  <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <Bidi text={n} />
                </li>
              ))}
            </ul>
          ) : null}
          {unread.length ? (
            <p className="mt-1 text-sm text-ink-3">
              {unread.length} downloaded {unread.length === 1 ? "file has" : "files have"} not been read yet.
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row md:shrink-0">
          {unread.length ? (
            <Button variant="secondary" icon={<FileSearch />} loading={extract.isPending} onClick={() => extract.mutate()}>
              Extract files
            </Button>
          ) : null}
          <Button
            variant={done ? "secondary" : "primary"}
            icon={done ? <RefreshCw /> : <Play />}
            loading={run.isPending}
            disabled={running}
            onClick={() => run.mutate()}
          >
            {running ? "Analysis running" : done ? "Run again" : "Run analysis"}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ summary + questions */

function SummaryPanel({ detail }: TabProps) {
  const s = detail.project.summary?.trim();
  return (
    <Panel>
      <PanelHeader title="Summary" />
      <PanelBody>
        {s ? (
          <Bidi text={s} as="p" className="max-w-[70ch] leading-relaxed text-ink-2" />
        ) : (
          <p className="text-ink-3">No summary yet. The analysis writes a short summary of what the customer asks for.</p>
        )}
      </PanelBody>
    </Panel>
  );
}

function questionText(q: unknown): string {
  if (typeof q === "string") return q;
  if (q && typeof q === "object") {
    const o = q as Record<string, unknown>;
    return String(o.question ?? o.text ?? o.label ?? "");
  }
  return "";
}

function QuestionsPanel({ detail }: TabProps) {
  const qs = (detail.project.unresolved_questions ?? []).map(questionText).filter(Boolean);
  return (
    <Panel>
      <PanelHeader
        title={qs.length ? `Open questions (${qs.length})` : "Open questions"}
        description="What the engineer must ask before quoting."
      />
      <PanelBody>
        {qs.length ? (
          <ul className="space-y-2.5">
            {qs.map((q, i) => (
              <li key={i} className="flex gap-2.5">
                <CircleHelp className="mt-0.5 size-5 shrink-0 text-review" aria-hidden />
                <Bidi text={q} className="text-ink" />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-3">No open questions. Questions the documents do not answer appear here after the analysis.</p>
        )}
      </PanelBody>
    </Panel>
  );
}

/* ------------------------------------------------------------------ requirements */

function ValueText({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "") return <span className="text-review">Not stated</span>;
  return <Bidi text={displayValue(value)} className="font-medium text-ink" />;
}

function RequirementsPanel({ detail }: TabProps) {
  const reqs = detail.project.requirements ?? [];
  return (
    <Panel>
      <PanelHeader
        title={`Requirements (${reqs.length})`}
        description="What the customer asks for, each with the sentence it came from. Source found confirms the quote, not the design."
      />
      <PanelBody>
        {reqs.length ? (
          <KeyValue
            labelWidth="lg"
            items={reqs.map((r) => {
              const ev = evidenceOf(r.evidence, detail);
              return {
                label: <Bidi text={r.label || humanize(r.field)} />,
                value: (
                  <>
                    <ValueText value={r.value} />
                    {ev?.quote ? <EvidenceQuote evidence={ev} className="mt-2" /> : <p className="mt-1 text-xs text-ink-3">No source quoted.</p>}
                  </>
                ),
              };
            })}
          />
        ) : (
          <EmptyState compact icon={<ScrollText />} title="No requirements yet">
            Run the analysis once the files are in. Each requirement will show the sentence it came from.
          </EmptyState>
        )}
      </PanelBody>
    </Panel>
  );
}

/* ------------------------------------------------------------------ scope items */

function ScopePanel({ detail }: TabProps) {
  const items = detail.project.scope_items ?? [];
  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title={`Scope items (${items.length})`}
        description="Quantities only as the documents state them; a missing one stays “Not stated”. Prices are entered by a person in the quotation."
      />
      {items.length === 0 ? (
        <EmptyState compact icon={<ListChecks />} title="No scope items yet">
          They come from the customer's request and the BOQ once the analysis has run.
        </EmptyState>
      ) : (
        <>
          <div className="hidden lg:block">
            <Table>
              <THead>
                <tr>
                  <TH className="w-12">#</TH>
                  <TH>Description</TH>
                  <TH className="w-32 text-right">Quantity</TH>
                  <TH className="w-28">Unit</TH>
                </tr>
              </THead>
              <TBody>
                {items.map((s, i) => {
                  const ev = evidenceOf(s.evidence, detail);
                  return (
                    <TR key={i}>
                      <TD className="tabular text-ink-3">{String(s.no ?? i + 1)}</TD>
                      <TD>
                        <Bidi text={s.description} as="p" className="text-ink" />
                        {ev?.quote ? <EvidenceQuote evidence={ev} className="mt-2" /> : null}
                      </TD>
                      <TD className="text-right">
                        <QtyValue qty={s.qty} />
                      </TD>
                      <TD>{s.unit ? <Bidi text={s.unit} /> : <span className="text-ink-3">—</span>}</TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </div>
          <ul className="divide-y divide-line lg:hidden">
            {items.map((s, i) => {
              const ev = evidenceOf(s.evidence, detail);
              return (
                <li key={i} className="px-5 py-4">
                  <Bidi text={s.description} as="p" className="font-medium text-ink" />
                  <dl className="mt-2 grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                    <dt className="text-ink-3">Quantity</dt>
                    <dd>
                      <QtyValue qty={s.qty} />
                    </dd>
                    <dt className="text-ink-3">Unit</dt>
                    <dd className="text-ink">{s.unit || "—"}</dd>
                  </dl>
                  {ev?.quote ? <EvidenceQuote evidence={ev} className="mt-2" /> : null}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ drawings */

function DrawingsPanel({ detail }: TabProps) {
  const sheets = detail.files.flatMap((f) => drawingPages(f).map((d) => ({ file: f, ...d })));
  if (!sheets.length) return null;
  return (
    <Panel>
      <PanelHeader
        title={`Drawing findings (${sheets.length} ${sheets.length === 1 ? "sheet" : "sheets"})`}
        description="Read from the sheets by the AI engine. Nothing was measured; dimensions need engineer verification."
      />
      <ul className="divide-y divide-line">
        {sheets.map(({ file, page, finding }) => (
          <li key={`${file.id}-${page}`} className="px-5 py-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="min-w-0 font-semibold text-ink">
                <Bidi text={file.name} className="break-all" /> · page {page}
              </p>
              <Button asChild size="sm" variant="secondary">
                <Link to={fileHref(file.id, page)}>Open page {page}</Link>
              </Button>
            </div>
            <DrawingFindings finding={finding} />
          </li>
        ))}
      </ul>
    </Panel>
  );
}
