import { StatusChip } from "@/ui";
import { TASKS, cleanReason, taskStatusInfo, type TaskDef } from "../vocab";
import type { ExamRecord, TaskVerdict } from "../types";

export interface TaskRow {
  task: TaskDef;
  verdict: TaskVerdict | null;
  cases?: { cases: number; passed: number };
}

/** Build rows from per-task verdicts (MCP declaration) or "task: status" pairs (model state). */
export function taskRows(
  verdicts: Record<string, TaskVerdict | string>,
  exam?: ExamRecord | null,
  only?: string[],
): TaskRow[] {
  return TASKS.filter((t) => (only ? only.includes(t.key) : t.key in verdicts)).map((t) => {
    const v = verdicts[t.key];
    return {
      task: t,
      verdict: v === undefined ? null : typeof v === "string" ? { status: v, reasons: [] } : v,
      cases: exam?.task_results?.[t.key],
    };
  });
}

/** What the model may do, task by task, with the exam cases behind each answer. */
export function TaskEligibility({ rows, showTool, caption }: { rows: TaskRow[]; showTool?: boolean; caption?: string }) {
  if (!rows.length) return null;
  return (
    <ul className="divide-y divide-line" aria-label={caption ?? "Eligibility per task"}>
      {rows.map(({ task, verdict, cases }) => {
        const info = taskStatusInfo(verdict?.status);
        return (
          <li key={task.key} className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 py-3 sm:grid-cols-[minmax(0,1fr)_8.5rem_9.5rem] sm:items-start">
            <div className="min-w-0">
              <p className="font-medium text-ink">
                {task.label}
                {!task.critical ? <span className="ml-2 text-xs font-normal text-ink-3">standard models allowed</span> : null}
              </p>
              <p className="text-sm text-ink-3">{task.detail}</p>
              {showTool && task.tool ? (
                <p className="mt-0.5 text-xs text-ink-3">
                  MCP tool <code className="font-mono text-ink-2">{task.tool}</code>
                </p>
              ) : null}
              {verdict && verdict.status !== "eligible" && verdict.reasons.length ? (
                <ul className="mt-1 space-y-0.5 text-sm text-ink-2">
                  {verdict.reasons.map((r) => (
                    <li key={r} className="break-words">
                      {cleanReason(r)}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <p className="col-start-1 row-start-2 text-sm text-ink-3 tabular sm:col-start-2 sm:row-start-1 sm:pt-0.5">
              {cases ? `${cases.passed} of ${cases.cases} exam cases` : "Not examined"}
            </p>
            <div className="col-start-2 row-start-1 justify-self-end sm:col-start-3">
              <StatusChip info={info} size="sm" />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
