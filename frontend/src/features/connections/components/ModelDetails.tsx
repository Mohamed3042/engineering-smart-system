import { useMutation } from "@tanstack/react-query";
import { FlaskConical, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { api } from "@/api/client";
import { modelStatusInfo } from "@/lib/labels";
import { Banner, Button, Chip, ConfirmDialog, KeyValue, StatusChip, toast, toastError } from "@/ui";
import { MANAGE_HINT, useCanManage, useSelectModel } from "../api";
import { elapsed, examKey, examRunError, startExamRun, useExamRuns, useNow } from "../exam";
import type { ModelItem } from "../types";
import { aiProviderLabel, cleanReason, formatTokens, splitReasons, TASKS, tierLabel, yesNo } from "../vocab";
import { ExamSummary } from "./ExamSummary";
import { TaskEligibility, taskRows } from "./TaskEligibility";

export function eligibleTasks(m: ModelItem): string[] {
  const t = splitReasons(m.reasons).tasks;
  return Object.keys(t).filter((k) => t[k] === "eligible");
}

/** Eligible, but only for mail sorting (a standard-tier model): critical work stays off. */
export function sortingOnly(m: ModelItem): boolean {
  if (m.status !== "eligible") return false;
  const ok = eligibleTasks(m);
  return ok.length > 0 && !ok.some((k) => TASKS.find((t) => t.key === k)?.critical);
}

const STATUS_COPY: Record<string, { title: string; tone: "brand" | "review" | "block" }> = {
  eligible: { title: "Eligible", tone: "brand" },
  needs_evaluation: { title: "Run the qualification exam first", tone: "review" },
  failed_evaluation: { title: "Did not pass the exam", tone: "block" },
  refused: { title: "Refused by policy", tone: "block" },
};

const SELECT_BLOCKED: Record<string, string> = {
  needs_evaluation: "It cannot be selected until it passes the qualification exam.",
  failed_evaluation: "It cannot be selected: it did not pass the exam. You can run the exam again.",
  refused: "It cannot be selected: the workspace rules refuse it, and the rules cannot be lowered.",
};

/** Everything about one model: why it has its status, what it may do, its exam, and the next action. */
export function ModelDetails({
  model,
  connectionId,
  inUse,
  maxAgeDays,
  minScore,
  onSelected,
  readOnlyNote,
  hideHeader,
}: {
  model: ModelItem;
  /** Active API connection; without one the model can be read about but not examined or chosen. */
  connectionId: string | null;
  inUse: boolean;
  maxAgeDays?: number;
  minScore?: number;
  onSelected?: (m: ModelItem) => void;
  readOnlyNote?: string;
  hideHeader?: boolean;
}) {
  const canManage = useCanManage();
  const runs = useExamRuns();
  const running = !!runs[examKey(model.provider, model.model_id)];
  const now = useNow(running);
  const select = useSelectModel();
  const [confirmSorting, setConfirmSorting] = useState(false);
  const name = model.display_name || model.model_id;
  const { general, tasks } = splitReasons(model.reasons);
  const okTasks = eligibleTasks(model);
  const onlySorting = sortingOnly(model);
  const runErr = examRunError(model.exam);
  const hasExam = !!model.exam && (!!model.exam.ran_at || !!runErr);

  const evaluate = useMutation({
    mutationFn: () => api.post<{ started: boolean }>("/ai/models/evaluate", { connection_id: connectionId, model_id: model.model_id }),
    onSuccess: (r) => {
      startExamRun(model);
      if (r.started) {
        toast("Exam started", { description: `${name} answers invented cases for every task. It usually takes a few minutes.` });
      } else {
        toast("An exam for this model is already running", { description: "The result appears here when it is scored." });
      }
    },
    onError: (err) => toastError(err, "The exam could not start"),
  });

  const doSelect = () =>
    select.mutate(
      { connection_id: connectionId!, model_id: model.model_id },
      {
        onSuccess: () => {
          setConfirmSorting(false);
          toast.success(`${name} is now the AI model`);
          onSelected?.(model);
        },
        onError: (err) => {
          setConfirmSorting(false);
          toastError(err, "The model could not be selected");
        },
      },
    );

  const copy = STATUS_COPY[model.status] ?? { title: modelStatusInfo(model.status).label, tone: "review" as const };
  const caps = model.capabilities ?? {};

  return (
    <div className="space-y-5">
      {hideHeader ? null : (
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold text-ink">{name}</h3>
            <StatusChip info={modelStatusInfo(model.status)} size="sm" />
            {inUse ? (
              <Chip size="sm" tone="brand">
                In use
              </Chip>
            ) : null}
          </div>
          <p className="mt-0.5 break-all text-sm text-ink-3">
            <span className="font-mono">{model.model_id}</span> · {aiProviderLabel(model.provider)} · {tierLabel(model.tier)}
          </p>
        </div>
      )}

      {model.status === "eligible" ? (
        <Banner tone={onlySorting ? "review" : "brand"} title={onlySorting ? "Eligible for mail sorting only" : "Eligible"}>
          {onlySorting
            ? "Reading requests, studying files and drawings, drafting quotations and research need a frontier model that passed the exam."
            : `Passed the workspace rules and the exam. It may do ${okTasks.length} of ${Object.keys(tasks).length || TASKS.length} tasks.`}
        </Banner>
      ) : (
        <Banner tone={copy.tone === "brand" ? "neutral" : copy.tone} title={copy.title}>
          {general.length ? (
            <ul className="list-disc space-y-0.5 pl-5">
              {general.map((g) => (
                <li key={g} className="break-words">
                  {cleanReason(g)}
                </li>
              ))}
            </ul>
          ) : null}
          {model.status === "refused" ? (
            <p className="mt-1.5">It cannot be selected or examined. The safety floor cannot be lowered.</p>
          ) : model.status === "needs_evaluation" ? (
            <p className="mt-1.5">The exam uses invented enquiries, documents and a drawing. It runs on your provider account.</p>
          ) : null}
        </Banner>
      )}

      {/* next action */}
      {running ? (
        <div role="status" className="flex items-start gap-3 rounded-lg border border-line bg-sunken px-4 py-3">
          <LoaderCircle className="mt-0.5 size-5 shrink-0 animate-spin text-brand" aria-hidden />
          <div className="min-w-0 text-sm">
            <p className="font-medium text-ink">Exam running · {elapsed(runs[examKey(model.provider, model.model_id)].startedAt, now)}</p>
            <p className="text-ink-3">You can leave this page. The result appears here when it is scored.</p>
          </div>
        </div>
      ) : connectionId ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          {/* always shown: a model that cannot be selected says why, right here */}
          <Button
            disabled={!canManage || inUse || model.status !== "eligible"}
            loading={select.isPending}
            onClick={() => (onlySorting ? setConfirmSorting(true) : doSelect())}
            className="w-full sm:w-auto"
          >
            {inUse ? "In use" : "Use this model"}
          </Button>
          {model.status !== "refused" ? (
            <Button
              variant={model.status === "eligible" ? "secondary" : "primary"}
              icon={<FlaskConical aria-hidden />}
              disabled={!canManage}
              loading={evaluate.isPending}
              onClick={() => evaluate.mutate()}
              className="w-full sm:w-auto"
            >
              {hasExam ? "Run the exam again" : "Run qualification exam"}
            </Button>
          ) : null}
          {model.status !== "eligible" ? <p className="w-full text-sm text-ink-3">{SELECT_BLOCKED[model.status] ?? "It cannot be selected yet."}</p> : null}
          {!canManage ? <p className="w-full text-sm text-ink-3">{MANAGE_HINT}</p> : null}
        </div>
      ) : readOnlyNote ? (
        <p className="text-sm text-ink-3">{readOnlyNote}</p>
      ) : null}

      <div>
        <h4 className="mb-1 text-sm font-semibold text-ink">Capabilities</h4>
        <KeyValue
          labelWidth="sm"
          items={[
            { label: "Structured output", value: yesNo(caps.structured_output) },
            { label: "Vision", value: yesNo(caps.vision), hint: "Needed to study drawings." },
            {
              label: "Context window",
              value: caps.context_tokens ? `${caps.context_tokens.toLocaleString("en-GB")} tokens (${formatTokens(caps.context_tokens)})` : "Unknown",
            },
            { label: "Tool use", value: yesNo(caps.tool_use, "Unknown") },
            { label: "PDF input", value: yesNo(caps.pdf_input, "Unknown") },
          ]}
        />
      </div>

      {Object.keys(tasks).length ? (
        <div>
          <h4 className="mb-1 text-sm font-semibold text-ink">What it may do</h4>
          <TaskEligibility rows={taskRows(tasks, model.exam)} caption={`Eligibility of ${name} per task`} />
        </div>
      ) : null}

      {hasExam ? (
        <div>
          <h4 className="mb-2 text-sm font-semibold text-ink">Latest exam</h4>
          <ExamSummary exam={model.exam} provider={model.provider} maxAgeDays={maxAgeDays} minScore={minScore} />
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmSorting}
        onOpenChange={setConfirmSorting}
        title={`Use ${name} for mail sorting only?`}
        confirmLabel="Use for mail sorting"
        loading={select.isPending}
        onConfirm={doSelect}
      >
        <p className="text-base text-ink-2">
          This model may only sort mail. Reading requests, studying files and drawings, drafting quotations and research stay
          off until you choose a frontier model that passed the exam.
        </p>
      </ConfirmDialog>
    </div>
  );
}
