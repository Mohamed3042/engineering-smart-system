import { CircleCheck, CircleX } from "lucide-react";
import { formatDate, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Banner, Chip, KeyValue, StatusChip } from "@/ui";
import { criticalCount, examRunError } from "../exam";
import { examRunIssue } from "../issues";
import type { CriticalFailure, ExamRecord } from "../types";
import { pct, TASKS, taskLabel } from "../vocab";
import { Disclosure } from "./bits";

function validUntil(ranAt: string | undefined, days: number): Date | null {
  if (!ranAt) return null;
  const d = new Date(ranAt);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + days * 86_400_000);
}

/** Result of one qualification exam: score, critical failures, dates and every case. */
export function ExamSummary({
  exam,
  provider,
  maxAgeDays = 30,
  minScore = 0.9,
  showCases = true,
}: {
  exam: ExamRecord;
  provider: string;
  maxAgeDays?: number;
  minScore?: number;
  showCases?: boolean;
}) {
  const runError = examRunError(exam);
  if (runError) {
    const issue = examRunIssue(runError, provider);
    return (
      <Banner tone="block" title="The last exam could not run">
        <p>{issue.title}. Nothing was recorded about the model's quality.</p>
        {issue.steps.length ? (
          <ol className="mt-2 list-decimal space-y-0.5 pl-5">
            {issue.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        ) : null}
        <p className="mt-2 break-words font-mono text-xs text-ink-3">Reported: {runError}</p>
      </Banner>
    );
  }

  const cases = exam.cases ?? [];
  const passedCases = cases.filter((c) => c.passed).length;
  const crit = (exam.critical_failures ?? []).filter((f): f is CriticalFailure => typeof f === "object" && f !== null);
  const until = validUntil(exam.ran_at, maxAgeDays);
  const expired = until ? until.getTime() < Date.now() : false;
  const threshold = typeof exam.threshold === "number" ? Math.max(exam.threshold, minScore) : minScore;

  return (
    <div className="space-y-4">
      <KeyValue
        labelWidth="sm"
        items={[
          {
            label: "Result",
            value: exam.passed ? (
              <StatusChip info={{ label: "Passed", tone: "brand" }} icon={<CircleCheck aria-hidden />} size="sm" />
            ) : (
              <StatusChip info={{ label: "Not passed", tone: "block" }} size="sm" />
            ),
          },
          {
            label: "Score",
            value: (
              <span className="tabular">
                {pct(exam.score)} <span className="text-ink-3">· minimum {pct(threshold)}</span>
              </span>
            ),
          },
          {
            label: "Critical failures",
            value: <span className="tabular">{criticalCount(exam) === 0 ? "None" : criticalCount(exam)}</span>,
            hint: "Invented facts, prices or quotes fail the exam outright. None are allowed.",
          },
          {
            label: "Taken",
            value: formatDateTime(exam.ran_at),
            hint: exam.mode === "external" ? "Answered by the MCP client, scored by this app." : "Run and scored by this app.",
          },
          {
            label: expired ? "Expired" : "Valid until",
            value: until ? (
              <span className={cn(expired && "font-medium text-review")}>{formatDate(until)}</span>
            ) : (
              "—"
            ),
            hint: expired ? "Run the exam again to use this model." : `Exams count for ${maxAgeDays} days.`,
          },
          ...(cases.length
            ? [{ label: "Cases", value: <span className="tabular">{`${passedCases} of ${cases.length} passed`}</span> }]
            : []),
        ]}
      />

      {crit.length ? (
        <div>
          <p className="mb-1.5 text-sm font-semibold text-block">Critical failures</p>
          <ul className="space-y-1.5 text-sm">
            {crit.map((f, i) => (
              <li key={i} className="rounded-md bg-block-soft px-3 py-2 text-ink-2">
                <span className="font-mono text-xs text-ink">{f.case}</span> · {f.check}
                {f.detail ? <span className="block text-xs text-ink-3">{f.detail}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {showCases && cases.length ? (
        <Disclosure title="Exam cases" summary={`${cases.length} invented cases`}>
          <div className="space-y-4">
            {TASKS.filter((t) => cases.some((c) => c.task === t.key)).map((t) => (
              <div key={t.key}>
                <p className="mb-1 text-sm font-semibold text-ink">{t.label}</p>
                <ul className="divide-y divide-line">
                  {cases
                    .filter((c) => c.task === t.key)
                    .map((c) => {
                      const failed = c.details.filter((d) => !d.passed);
                      return (
                        <li key={c.id} className="flex gap-2.5 py-2">
                          {c.passed ? (
                            <CircleCheck className="mt-0.5 size-4 shrink-0 text-brand" aria-label="Passed" />
                          ) : (
                            <CircleX className="mt-0.5 size-4 shrink-0 text-block" aria-label="Failed" />
                          )}
                          <div className="min-w-0 flex-1">
                            <p className="text-sm text-ink">{c.title}</p>
                            {failed.length ? (
                              <ul className="mt-1 space-y-0.5 text-xs text-ink-3">
                                {failed.map((d) => (
                                  <li key={d.check} className="break-words">
                                    {d.critical ? <span className="font-semibold text-block">Critical · </span> : null}
                                    {d.check} — {d.info}
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                          </div>
                          <span className="shrink-0 text-sm text-ink-3 tabular">{pct(c.score)}</span>
                        </li>
                      );
                    })}
                </ul>
              </div>
            ))}
            {cases.some((c) => !TASKS.some((t) => t.key === c.task)) ? (
              <p className="text-sm text-ink-3">
                Other cases: {cases.filter((c) => !TASKS.some((t) => t.key === c.task)).map((c) => taskLabel(c.task)).join(", ")}
              </p>
            ) : null}
          </div>
        </Disclosure>
      ) : null}
      {exam.exam_version ? (
        <p className="text-xs text-ink-3">
          Exam suite <span className="font-mono">{exam.exam_version}</span>
        </p>
      ) : null}
    </div>
  );
}

/** Short inline summary for list rows: "Exam 96% · 1 Oct". */
export function ExamChip({ exam }: { exam: ExamRecord | null | undefined }) {
  if (!exam || (!exam.ran_at && !exam.critical_failures?.length)) return null;
  if (examRunError(exam)) return <StatusChip size="sm" info={{ label: "Exam could not run", tone: "block" }} />;
  if (!exam.passed) return <StatusChip size="sm" info={{ label: `Exam ${pct(exam.score)} · not passed`, tone: "block" }} />;
  return (
    <Chip size="sm" tone="neutral">
      Exam {pct(exam.score)} · {formatDate(exam.ran_at)}
    </Chip>
  );
}
