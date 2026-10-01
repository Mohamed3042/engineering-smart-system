/**
 * Business learning progress (mockup 09) and mailbox scan progress. Learning steps come from
 * GET /api/knowledge/identity → learning; the scan from GET /api/scan/{id}.
 */
import { Check, CircleAlert, LoaderCircle, Minus, RefreshCw, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import type { ScanJob } from "@/api/types";
import { cn } from "@/lib/cn";
import { formatDateTime, formatNumber, formatRelative, pluralize } from "@/lib/format";
import { runStatusInfo } from "@/lib/labels";
import { Banner, Button, Panel, PanelBody, PanelHeader, ProgressBar, StatusChip } from "@/ui";
import type { IdentityInfo, LearningStep, useLearningProgress } from "../api";

type Progress = ReturnType<typeof useLearningProgress>;

interface StepDef {
  key: string;
  title: string;
  description: string;
  skippedWhy?: (o: { folders: number; web: boolean }) => string | null;
}

/** Backend order: mail → web → documents → mining → identity (api/knowledge.py run_discovery). */
const STEPS: StepDef[] = [
  { key: "mail", title: "Read mail", description: "Sent and received messages already in this workspace." },
  {
    key: "web",
    title: "Look at public web pages",
    description: "Pages about the company. Context only: they never prove a finding.",
    skippedWhy: (o) => (o.web ? null : "Off"),
  },
  {
    key: "documents",
    title: "Read company folders",
    description: "Old quotations, catalogues and company documents on this computer.",
    skippedWhy: (o) => (o.folders > 0 ? null : "No folders chosen"),
  },
  { key: "mining", title: "Find services, terms and standards", description: "Each finding keeps the sentences it came from." },
  { key: "identity", title: "Prepare your review", description: "Findings wait for the owner's decision." },
];

type StepState = "done" | "running" | "pending" | "skipped";

function stepState(_def: StepDef, step: LearningStep | undefined, finished: boolean): StepState {
  if (step?.status === "done") return "done";
  if (step?.status === "running") return finished ? "skipped" : "running";
  return finished ? "skipped" : "pending";
}

function StepList({ items }: { items: { def: StepDef; state: StepState; detail?: string; note?: string | null }[] }) {
  return (
    <ol className="relative">
      {items.map(({ def, state, detail, note }, i) => (
        <li key={def.key} className="relative flex gap-3 pb-5 last:pb-0">
          {i < items.length - 1 ? <span aria-hidden className="absolute bottom-0 left-[11px] top-7 w-px bg-line" /> : null}
          <span
            aria-hidden
            className={cn(
              "relative z-[1] mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-surface [&_svg]:size-3.5",
              state === "done" && "bg-brand text-white",
              state === "running" && "border-2 border-brand text-brand",
              state === "pending" && "border border-line-strong",
              state === "skipped" && "border border-dashed border-line-strong text-ink-3",
            )}
          >
            {state === "done" ? <Check /> : state === "running" ? <LoaderCircle className="animate-spin" /> : state === "skipped" ? <Minus /> : null}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <p className={cn("font-medium", state === "pending" || state === "skipped" ? "text-ink-2" : "text-ink")}>
                {def.title}
                <span className="sr-only">
                  {state === "done" ? " (done)" : state === "running" ? " (in progress)" : state === "skipped" ? " (skipped)" : " (waiting)"}
                </span>
              </p>
              {detail ? <p className="text-sm text-ink-2 tabular">{detail}</p> : note ? <p className="text-sm text-ink-3">{note}</p> : null}
            </div>
            <p className="mt-0.5 text-sm text-ink-3">{def.description}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function foundSummary(identity: IdentityInfo | undefined): string | null {
  if (!identity) return null;
  const parts = [
    identity.service_families.length ? pluralize(identity.service_families.length, "service family", "service families") : null,
    identity.work_types.length ? pluralize(identity.work_types.length, "work type") : null,
    identity.terms.length ? pluralize(identity.terms.length, "term") : null,
    identity.standards.length ? pluralize(identity.standards.length, "standard") : null,
    identity.conventions.length ? pluralize(identity.conventions.length, "document convention") : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** Steps, progress and the start / run-again action for business learning. */
export function DiscoveryProgress({
  progress,
  folders,
  web,
  canRun,
  doneAction,
  title = "Business learning",
  className,
}: {
  progress: Progress;
  folders: string[];
  web: boolean;
  canRun: boolean;
  /** Shown when learning has finished (e.g. "Review findings"). */
  doneAction?: ReactNode;
  title?: string;
  className?: string;
}) {
  const { phase, steps, learning, identity, start } = progress;
  const finished = phase === "done";
  const active = phase === "running" || phase === "starting" || phase === "stalled";
  const opts = { folders: folders.length, web };
  const items = STEPS.map((def) => {
    const step = phase === "starting" ? undefined : steps[def.key];
    const plannedSkip = def.skippedWhy?.(opts) ?? null;
    const state: StepState = phase === "never" ? (plannedSkip ? "skipped" : "pending") : stepState(def, step, finished);
    return {
      def,
      state,
      detail: state === "done" ? step?.detail : undefined,
      note: state === "skipped" ? (plannedSkip ?? "Skipped") : state === "pending" && plannedSkip ? plannedSkip : null,
    };
  });
  const applicable = items.filter((i) => i.state !== "skipped");
  const doneCount = applicable.filter((i) => i.state === "done").length;
  const runningCount = applicable.filter((i) => i.state === "running").length;
  const pct = finished ? 1 : applicable.length ? (doneCount + runningCount * 0.4) / applicable.length : 0;
  const run = () => start.mutate({ folders, web });
  const found = foundSummary(identity);

  return (
    <Panel className={className}>
      <PanelHeader
        title={title}
        description={
          phase === "never"
            ? "Reads your mail, company folders and, if you allow it, public web pages. Nothing is decided until you confirm it."
            : finished && learning?.finished_at
              ? `Last run finished ${formatDateTime(learning.finished_at)}.`
              : "Learning runs in the background. You can leave this page; progress is kept."
        }
        actions={
          canRun && !active ? (
            <Button
              variant={phase === "never" ? "primary" : "secondary"}
              size="sm"
              icon={phase === "never" ? <Sparkles /> : <RefreshCw />}
              loading={start.isPending}
              onClick={run}
            >
              {phase === "never" ? "Start learning" : "Run learning again"}
            </Button>
          ) : null
        }
      />
      <PanelBody className="space-y-5">
        {phase !== "never" ? (
          <div className="flex items-center gap-3">
            <ProgressBar value={pct} label="Learning progress" className="flex-1" />
            <span className="w-28 shrink-0 text-right text-sm text-ink-2 tabular">
              {finished ? "Finished" : phase === "starting" ? "Starting…" : `${Math.round(pct * 100)}% complete`}
            </span>
          </div>
        ) : null}

        {phase === "stalled" ? (
          <Banner
            tone="review"
            title="No progress for 30 minutes"
            actions={
              canRun ? (
                <Button size="sm" variant="secondary" icon={<RefreshCw />} loading={start.isPending} onClick={run}>
                  Run again
                </Button>
              ) : null
            }
          >
            If the local server was restarted, learning stopped. Run it again; confirmed and rejected findings are kept.
          </Banner>
        ) : null}

        {start.isError ? (
          <Banner tone="block" title="Learning did not start">
            {start.error instanceof Error ? start.error.message : "Try again."}
          </Banner>
        ) : null}

        <StepList items={items} />

        {finished ? (
          <div className="flex flex-col gap-3 rounded-lg border border-brand-line bg-brand-soft px-4 py-3 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-brand-ink">{found ? "Findings are ready for review" : "Learning found nothing new"}</p>
              <p className="mt-0.5 text-sm text-ink-2">
                {found ?? "Add company folders or scan more mail, then run learning again."}
              </p>
            </div>
            {doneAction ? <div className="flex shrink-0 flex-wrap gap-2">{doneAction}</div> : null}
          </div>
        ) : null}

        {!canRun && phase === "never" ? (
          <p className="flex items-start gap-2 text-sm text-ink-3">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            Only an owner or admin can start business learning.
          </p>
        ) : null}
      </PanelBody>
    </Panel>
  );
}

/* ------------------------------------------------------------------ scan */

const SCAN_COUNTS: { key: string; label: string }[] = [
  { key: "threads", label: "Conversations" },
  { key: "messages", label: "Messages" },
  { key: "new_messages", label: "New" },
  { key: "work", label: "Work messages" },
  { key: "projects", label: "Projects" },
];

export function ScanProgress({ job, action, className }: { job: ScanJob; action?: ReactNode; className?: string }) {
  const running = job.status === "running" || job.status === "queued";
  const pct = job.status === "done" ? 1 : job.progress ?? 0;
  return (
    <Panel className={className}>
      <PanelHeader
        title="Mailbox scan"
        description={
          running
            ? `Started ${formatRelative(job.started_at ?? job.created_at).toLowerCase()}. Mail is read, never changed.`
            : job.finished_at
              ? `Finished ${formatDateTime(job.finished_at)}.`
              : `Created ${formatDateTime(job.created_at)}.`
        }
        actions={<StatusChip info={job.status === "running" ? { label: "Scanning", tone: "neutral" } : runStatusInfo(job.status)} />}
      />
      <PanelBody className="space-y-4">
        <div className="flex items-center gap-3">
          <ProgressBar value={pct} tone={job.status === "failed" ? "block" : "brand"} label="Scan progress" className="flex-1" />
          <span className="w-12 shrink-0 text-right text-sm text-ink-2 tabular">{Math.round(pct * 100)}%</span>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-5">
          {SCAN_COUNTS.map((c) => (
            <div key={c.key}>
              <dt className="text-xs text-ink-3">{c.label}</dt>
              <dd className="text-lg font-semibold text-ink tabular">{formatNumber(job.counts?.[c.key] ?? 0)}</dd>
            </div>
          ))}
        </dl>
        {job.status === "failed" ? (
          <Banner tone="block" title="The scan stopped" actions={action}>
            {job.error || "The mailbox could not be read."}
          </Banner>
        ) : action ? (
          <div className="flex flex-wrap gap-2">{action}</div>
        ) : null}
      </PanelBody>
    </Panel>
  );
}
