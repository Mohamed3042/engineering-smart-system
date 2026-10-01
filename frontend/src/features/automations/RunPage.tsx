/**
 * One run (mockup 38): every step with its state, time and message. A run stopped at a human gate
 * says "Waiting for approval"; Continue is a ConfirmDialog that spells out what the next step does.
 */
import { Check, Clock, LoaderCircle, Minus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { isApiError } from "@/api/client";
import { formatDateShort, formatDateTime, formatTime, humanize, pluralize } from "@/lib/format";
import { automationHref } from "@/lib/routes";
import {
  Banner,
  Button,
  Chip,
  ConfirmDialog,
  EmptyState,
  KeyValue,
  LoadingRows,
  Page,
  PageHeader,
  Panel,
  PanelBody,
  PanelHeader,
  QueryState,
  Spinner,
  StatusChip,
  Timeline,
  toast,
  toastError,
  type TimelineItem,
} from "@/ui";
import { useContinueRun, useRun, type RunDetail, type RunStep } from "./api";
import { formatDuration, runStateInfo, runTriggerLabel, stepDoes, targetHref, waitingStep } from "./lib";

/** Time of a step; the date too when it is not the day the run started (a run can wait for days). */
function stepWhen(iso: string | null | undefined, runStart: string): string | null {
  if (!iso) return null;
  const sameDay = new Date(iso).toDateString() === new Date(runStart).toDateString();
  return sameDay ? formatTime(iso) : `${formatDateShort(iso)}, ${formatTime(iso)}`;
}

function stepItem(s: RunStep, runStart: string): TimelineItem {
  const state = runStateInfo(s.status);
  const gate = !!s.requires_approval;
  const does = stepDoes(s.type);
  const icon =
    s.status === "done" ? (
      <Check />
    ) : s.status === "failed" ? (
      <X />
    ) : s.status === "waiting_approval" ? (
      <Clock />
    ) : s.status === "running" ? (
      <LoaderCircle className="animate-spin" />
    ) : s.status === "skipped" ? (
      <Minus />
    ) : undefined;
  const tone = s.status === "done" ? "brand" : s.status === "failed" ? "block" : s.status === "waiting_approval" ? "review" : "neutral";
  const showState = s.status !== "done" && s.status !== "pending";
  return {
    tone,
    icon,
    when: stepWhen(s.finished_at ?? s.started_at, runStart),
    title: (
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>
          <span className="sr-only">{state.label}: </span>
          {s.label}
        </span>
        {gate ? (
          <Chip tone="review" size="sm" icon={<Clock aria-hidden />}>
            Needs approval
          </Chip>
        ) : null}
        {showState ? <StatusChip info={state} size="sm" /> : null}
      </span>
    ),
    detail: (
      <>
        {s.message ? (
          <span className={s.status === "failed" ? "break-words text-block" : "break-words"}>{s.message}</span>
        ) : does ? (
          <span className="text-ink-3">{s.status === "skipped" ? "Switched off, so it was skipped." : does}</span>
        ) : null}
        {s.status === "waiting_approval" && does ? <span className="mt-1 block text-ink-2">{does}</span> : null}
        {s.approved_by ? <span className="mt-1 block text-xs text-ink-3">Approved by {s.approved_by}</span> : null}
      </>
    ),
  };
}

function ContinueDialog({
  open,
  onOpenChange,
  data,
  gate,
  onContinued,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  data: RunDetail;
  gate: RunStep;
  onContinued: (key: string) => void;
}) {
  const { run, automation } = data;
  const cont = useContinueRun(run.id, run.automation_id);
  const at = run.steps.findIndex((s) => s.key === gate.key);
  const later = run.steps.slice(at + 1).filter((s) => s.status === "pending");
  const nextGate = later.find((s) => s.requires_approval);
  const does = stepDoes(gate.type);

  const confirm = () =>
    cont.mutate(undefined, {
      onSuccess: () => {
        onContinued(gate.key);
        onOpenChange(false);
        toast.success("Run continued", { description: `“${gate.label}” is running now.` });
      },
      onError: (err) => toastError(err, "The run was not continued"),
    });

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Continue ${automation?.name ?? "this run"}?`}
      description="Your approval is recorded with your name and the time."
      confirmLabel="Continue run"
      loading={cont.isPending}
      onConfirm={confirm}
    >
      <div className="space-y-3 text-sm text-ink-2">
        <p>
          The run stopped before <span className="font-semibold text-ink">{gate.label}</span>. Continuing runs that step now:
        </p>
        <div className="rounded-lg border border-line bg-sunken px-3.5 py-2.5">
          <p className="font-medium text-ink">{gate.label}</p>
          <p className="mt-0.5">{does ?? gate.message ?? "Runs the next step of the workflow."}</p>
        </div>
        {later.length ? (
          <p>
            After it the run goes on with {later.map((s) => s.label).join(", ")}.{" "}
            {nextGate ? `It stops again before ${nextGate.label}.` : "None of those steps needs another approval."}
          </p>
        ) : (
          <p>It is the last step, so the run finishes afterwards.</p>
        )}
      </div>
    </ConfirmDialog>
  );
}

function Facts({ data }: { data: RunDetail }) {
  const { run, automation } = data;
  const target = targetHref(run.target_type, run.target_id);
  const paused = run.status === "waiting_approval";
  const took = paused ? null : formatDuration(run.started_at, run.finished_at);
  return (
    <Panel>
      <PanelHeader title="Run details" />
      <PanelBody className="py-1">
        <KeyValue
          labelWidth="sm"
          items={[
            {
              label: "Workflow",
              value: (
                <Link to={automationHref(run.automation_id)} className="font-medium text-brand-ink hover:underline">
                  {automation?.name ?? "Open workflow"}
                </Link>
              ),
            },
            { label: "Started by", value: runTriggerLabel(run.trigger) },
            {
              label: "Worked on",
              value: run.target_type ? (
                target ? (
                  <Link to={target} className="font-medium text-brand-ink hover:underline">
                    Open the {run.target_type}
                  </Link>
                ) : (
                  humanize(run.target_type)
                )
              ) : (
                "Recent mail and projects"
              ),
            },
            { label: "Started", value: <span className="tabular">{formatDateTime(run.started_at)}</span> },
            run.finished_at && run.status !== "running"
              ? { label: paused ? "Stopped at" : "Finished", value: <span className="tabular">{formatDateTime(run.finished_at)}</span> }
              : { label: "Finished", value: "Not finished yet" },
            { label: "Took", value: took ? <span className="tabular">{took}</span> : null },
          ]}
        />
      </PanelBody>
    </Panel>
  );
}

function RunView({ data, resumedFrom, onResumed }: { data: RunDetail; resumedFrom: string | null; onResumed: (key: string) => void }) {
  const { run, automation } = data;
  const [confirm, setConfirm] = useState(false);
  const gate = waitingStep(run.steps);
  const resuming = !!gate && gate.key === resumedFrom;
  const state = runStateInfo(run.status);
  const done = run.steps.filter((s) => s.status === "done").length;
  const active = run.steps.filter((s) => s.status !== "skipped").length;

  return (
    <>
      <PageHeader
        back={{ to: automationHref(run.automation_id), label: automation?.name ?? "Automation" }}
        title={`${automation?.name ?? "Automation"} run`}
        status={<StatusChip info={state} size="md" />}
        meta={
          <span className="tabular">
            Started {formatDateTime(run.started_at)} · {done} of {pluralize(active, "step")} done
          </span>
        }
      />

      {gate && !resuming ? (
        <Banner
          className="mb-6"
          tone="review"
          title="Waiting for approval"
          actions={
            <Button className="w-full sm:w-auto" onClick={() => setConfirm(true)}>
              Continue
            </Button>
          }
        >
          The run stopped before “{gate.label}”. It does not move on until a person continues it.
        </Banner>
      ) : null}
      {resuming ? (
        <Banner className="mb-6" tone="neutral" icon={<Spinner label="Continuing" />} title="Continuing the run">
          Your approval was saved. “{gate?.label}” is starting.
        </Banner>
      ) : null}
      {run.status === "failed" ? (
        <Banner className="mb-6" tone="block" title="The run stopped with an error">
          {run.error || "A step failed. Its message is below."} Nothing after the failed step ran.
        </Banner>
      ) : null}

      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <Panel>
          <PanelHeader title="Steps" description="What each step did and when. Times are your local time." />
          <PanelBody>
            {run.steps.length ? (
              <Timeline items={run.steps.map((s) => stepItem(s, run.started_at))} />
            ) : (
              <p className="text-sm text-ink-3">This run has no steps.</p>
            )}
          </PanelBody>
        </Panel>
        <div className="space-y-6">
          <Facts data={data} />
          {run.summary ? (
            <Panel>
              <PanelHeader title="Result" />
              <PanelBody>
                <p className="break-words text-sm text-ink-2">{run.summary}</p>
              </PanelBody>
            </Panel>
          ) : null}
        </div>
      </div>

      {gate ? <ContinueDialog open={confirm} onOpenChange={setConfirm} data={data} gate={gate} onContinued={onResumed} /> : null}
    </>
  );
}

export function RunPage() {
  const { runId = "" } = useParams();
  const [resumedFrom, setResumedFrom] = useState<string | null>(null);
  const q = useRun(runId, resumedFrom);

  // If the server never moves past the gate, give the Continue button back after half a minute.
  useEffect(() => {
    if (!resumedFrom) return;
    const t = window.setTimeout(() => setResumedFrom(null), 30_000);
    return () => window.clearTimeout(t);
  }, [resumedFrom]);

  if (q.isError && isApiError(q.error) && q.error.status === 404) {
    return (
      <Page>
        <EmptyState
          title="This run is not in the workspace"
          action={
            <Button variant="secondary" asChild>
              <Link to="/automations">Back to automations</Link>
            </Button>
          }
        >
          The link may be from another workspace.
        </EmptyState>
      </Page>
    );
  }

  return (
    <Page>
      <QueryState
        query={q}
        loading={
          <Panel>
            <LoadingRows rows={5} />
          </Panel>
        }
      >
        {(data) => <RunView data={data} resumedFrom={resumedFrom} onResumed={setResumedFrom} />}
      </QueryState>
    </Page>
  );
}
