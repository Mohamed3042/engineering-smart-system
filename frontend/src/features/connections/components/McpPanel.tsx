import { Check, CircleDashed, CircleX, KeyRound, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { formatDateTime } from "@/lib/format";
import { modelStatusInfo } from "@/lib/labels";
import { cn } from "@/lib/cn";
import { Banner, Chip, EmptyState, ErrorState, KeyValue, Skeleton, StatusChip } from "@/ui";
import { useAiModels, useMcpInfo } from "../api";
import { criticalCount, examRunError } from "../exam";
import type { AiStatus, TaskVerdict } from "../types";
import { aiProviderLabel, cleanReason, pct, splitReasons, TASKS } from "../vocab";
import { CopyField } from "./bits";
import { ExamSummary } from "./ExamSummary";
import { TaskEligibility, taskRows } from "./TaskEligibility";

type Mcp = NonNullable<AiStatus["mcp"]>;

/** Per-task verdicts of the declared model: the declaration's own, completed from the model state. */
export function mcpVerdicts(mcp: Mcp | null | undefined): Record<string, TaskVerdict> {
  if (!mcp) return {};
  const fromState = splitReasons(mcp.reasons).tasks;
  const out: Record<string, TaskVerdict> = {};
  for (const [k, v] of Object.entries(fromState)) out[k] = { status: v, reasons: [] };
  return { ...out, ...(mcp.tasks ?? {}) };
}

export function mcpReadiness(mcp: Mcp | null | undefined) {
  const verdicts = mcpVerdicts(mcp);
  const values = Object.entries(verdicts);
  const eligible = values.filter(([, v]) => v.status === "eligible").map(([k]) => k);
  return {
    declared: !!mcp?.declared,
    examined: !!mcp?.exam && !examRunError(mcp.exam),
    passed: !!mcp?.exam?.passed,
    eligible,
    total: values.length,
    ready: eligible.length > 0,
    criticalReady: eligible.some((k) => TASKS.find((t) => t.key === k)?.critical),
  };
}

/* ------------------------------------------------------------------ endpoint + client setups */

function pretty(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/** Where the AI client connects, and ready-to-copy setups for common clients (state 04). */
export function McpEndpoint() {
  const info = useMcpInfo();
  if (info.isLoading) {
    return (
      <div className="space-y-3" aria-label="Loading">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (info.isError || !info.data) return <ErrorState error={info.error} onRetry={() => info.refetch()} compact />;
  const d = info.data;
  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <p className="text-sm font-medium text-ink">MCP endpoint</p>
          <Chip size="sm" tone={d.token_required ? "brand" : "neutral"} icon={<KeyRound aria-hidden />}>
            {d.token_required ? "Token required" : "No token"}
          </Chip>
        </div>
        <CopyField value={d.url} label="MCP endpoint address" />
        <p className="text-sm text-ink-3">
          {d.token_required
            ? "This server asks for a token: add the header Authorization: Bearer followed by the ESS_MCP_TOKEN value it was started with."
            : "No token is required: the endpoint only answers on this computer. To require one, start the server with ESS_MCP_TOKEN set."}
        </p>
      </div>
      {d.clients?.length ? (
        <div className="space-y-4">
          <p className="text-sm font-medium text-ink">Client setup</p>
          {d.clients.map((c) => (
            <div key={c.name} className="space-y-1.5">
              <p className="text-sm text-ink-2">{c.name}</p>
              <CopyField value={pretty(c.value)} label={`${c.name} setup`} multiline={c.kind === "json"} />
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-ink">Local command</p>
          <CopyField value={d.stdio_command} label="Local MCP command" />
          <p className="text-sm text-ink-3">Run it in the backend folder with its virtual environment.</p>
        </div>
      )}
      {d.rules.length ? (
        <div>
          <p className="mb-1.5 text-sm font-medium text-ink">What the client must do</p>
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-ink-2">
            {d.rules.map((r) => (
              <li key={r}>{r}</li>
            ))}
            <li>Take the qualification exam: get_qualification_exam, then submit_qualification_answers.</li>
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ live checklist */

function CheckItem({ state, title, children }: { state: "done" | "wait" | "fail" | "busy"; title: string; children: ReactNode }) {
  const icon =
    state === "done" ? (
      <Check className="size-3.5" aria-hidden />
    ) : state === "fail" ? (
      <CircleX className="size-4" aria-hidden />
    ) : state === "busy" ? (
      <LoaderCircle className="size-4 animate-spin" aria-hidden />
    ) : (
      <CircleDashed className="size-4" aria-hidden />
    );
  return (
    <li className="flex gap-3 py-3">
      <span
        className={cn(
          "mt-0.5 grid size-6 shrink-0 place-items-center rounded-full",
          state === "done" ? "bg-brand text-white" : state === "fail" ? "bg-block-soft text-block" : "bg-sunken text-ink-3",
        )}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <p className="font-medium text-ink">
          {title}
          <span className="sr-only">
            {state === "done" ? " (done)" : state === "fail" ? " (failed)" : " (waiting)"}
          </span>
        </p>
        <div className="text-sm text-ink-3">{children}</div>
      </div>
    </li>
  );
}

/** Live progress of the MCP client: declared → examined → eligible. */
export function McpChecklist({ status }: { status: AiStatus | undefined }) {
  const mcp = status?.mcp ?? null;
  const r = mcpReadiness(mcp);
  const d = mcp?.declared;
  const refused = mcp?.eligibility === "refused";
  const runErr = examRunError(mcp?.exam);
  return (
    <ul className="divide-y divide-line" aria-live="polite">
      <CheckItem state={d ? (refused ? "fail" : "done") : "busy"} title="The client declares its model">
        {d ? (
          <>
            {d.client || "An MCP client"} declared <span className="font-mono text-ink-2">{d.model_id}</span> (
            {aiProviderLabel(d.provider)}), {formatDateTime(d.declared_at)}.
            {refused ? " This model is refused: the client must declare an allowed model." : ""}
          </>
        ) : (
          "Waiting for a client. After adding the endpoint, ask it to call declare_engine with its real model."
        )}
      </CheckItem>
      <CheckItem
        state={r.passed ? "done" : runErr || (mcp?.exam && !mcp.exam.passed) ? "fail" : d && !refused ? "busy" : "wait"}
        title="It passes the qualification exam"
      >
        {r.passed && mcp?.exam
          ? `Score ${pct(mcp.exam.score)}, no critical failures, ${formatDateTime(mcp.exam.ran_at)}.`
          : runErr
            ? `The exam could not be scored: ${runErr}`
            : mcp?.exam
              ? `Score ${pct(mcp.exam.score)} with ${criticalCount(mcp.exam)} critical failure(s). The client can take the exam again.`
              : "The client calls get_qualification_exam, answers every case and calls submit_qualification_answers."}
      </CheckItem>
      <CheckItem state={r.criticalReady ? "done" : "wait"} title="It may do the work">
        {r.ready
          ? `Eligible for ${r.eligible.length} of ${r.total} tasks.${r.criticalReady ? "" : " Critical work needs a frontier model that passed the exam."}`
          : "Work is accepted only for tasks the model is eligible for. Every submission is checked."}
      </CheckItem>
    </ul>
  );
}

/* ------------------------------------------------------------------ expanded view */

/** The declared model, its exam and what it may do, task by task (the expanded MCP view). */
export function McpEngineDetails({ status, maxAgeDays, minScore }: { status: AiStatus; maxAgeDays?: number; minScore?: number }) {
  const mcp = status.mcp;
  const d = mcp?.declared ?? null;
  const models = useAiModels(d?.provider ?? null, { enabled: !!d });
  if (!mcp || !d) {
    return (
      <EmptyState compact title="No model declared yet">
        When an AI client connects, it declares its model here. The model must be allowed and pass the qualification exam
        before it can submit work.
      </EmptyState>
    );
  }
  const model = models.data?.items.find((m) => m.model_id === d.model_id && m.provider === d.provider);
  const general = splitReasons(mcp.reasons).general;
  const verdicts = mcpVerdicts(mcp);
  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <p className="text-lg font-semibold text-ink">{model?.display_name || d.model_id}</p>
          {mcp.eligibility ? <StatusChip info={modelStatusInfo(mcp.eligibility)} size="sm" /> : null}
        </div>
        <KeyValue
          className="mt-2"
          labelWidth="sm"
          items={[
            { label: "Model", value: <span className="font-mono text-sm">{d.model_id}</span> },
            { label: "Provider", value: aiProviderLabel(d.provider) },
            { label: "Client", value: d.client || "Not named by the client" },
            { label: "Declared", value: formatDateTime(d.declared_at) },
            ...(model?.tier ? [{ label: "Tier", value: model.tier === "frontier" ? "Frontier: may do critical work" : model.tier }] : []),
          ]}
        />
      </div>
      {mcp.eligibility && mcp.eligibility !== "eligible" && general.length ? (
        <Banner
          tone={mcp.eligibility === "needs_evaluation" ? "review" : "block"}
          title={mcp.eligibility === "refused" ? "This model is refused" : mcp.eligibility === "needs_evaluation" ? "The exam is still needed" : "The model failed the exam"}
        >
          <ul className="list-disc space-y-0.5 pl-5">
            {general.map((g) => (
              <li key={g}>{cleanReason(g)}</li>
            ))}
          </ul>
        </Banner>
      ) : null}
      <div>
        <h3 className="mb-2 text-base font-semibold text-ink">Qualification exam</h3>
        {mcp.exam ? (
          <ExamSummary exam={mcp.exam} provider={d.provider} maxAgeDays={maxAgeDays} minScore={minScore} />
        ) : (
          <p className="text-sm text-ink-3">
            Not taken yet. The client calls get_qualification_exam, answers every case, then submit_qualification_answers.
          </p>
        )}
      </div>
      <div>
        <h3 className="mb-1 text-base font-semibold text-ink">Eligibility per task</h3>
        <p className="mb-1 text-sm text-ink-3">The MCP tools accept work only for the tasks marked eligible.</p>
        <TaskEligibility rows={taskRows(verdicts, mcp.exam)} showTool caption="Eligibility of the declared model per task" />
      </div>
    </div>
  );
}
