/**
 * Qualification exams run in the background on the server (POST /api/ai/models/evaluate) and the
 * API has no progress endpoint. We remember which exams were started (module store mirrored to
 * sessionStorage) and treat a changed `evaluated_at` on the model as "finished".
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "@/ui";
import type { ExamRecord, ModelItem } from "./types";
import { pct } from "./vocab";

export interface ExamRun {
  key: string;
  provider: string;
  model_id: string;
  name: string;
  startedAt: number;
  /** evaluated_at of the model when the exam was started. */
  before: string | null;
}

const STORAGE = "ess.examRuns";
const GIVE_UP_MS = 30 * 60_000;

function load(): Record<string, ExamRun> {
  try {
    const raw = sessionStorage.getItem(STORAGE);
    return raw ? (JSON.parse(raw) as Record<string, ExamRun>) : {};
  } catch {
    return {};
  }
}

let runs: Record<string, ExamRun> = typeof window === "undefined" ? {} : load();
const listeners = new Set<() => void>();

function emit() {
  try {
    sessionStorage.setItem(STORAGE, JSON.stringify(runs));
  } catch {
    /* private mode: keep it in memory only */
  }
  listeners.forEach((l) => l());
}

export const examKey = (provider: string, model_id: string) => `${provider}:${model_id}`;

export function startExamRun(model: ModelItem) {
  const key = examKey(model.provider, model.model_id);
  runs = {
    ...runs,
    [key]: {
      key,
      provider: model.provider,
      model_id: model.model_id,
      name: model.display_name || model.model_id,
      startedAt: Date.now(),
      before: model.evaluated_at,
    },
  };
  emit();
}

function finish(key: string) {
  const { [key]: _gone, ...rest } = runs;
  runs = rest;
  emit();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useExamRuns(): Record<string, ExamRun> {
  return useSyncExternalStore(subscribe, () => runs, () => runs);
}

/** "exam could not run: …" records carry string failures and no score. */
export function examRunError(exam: ExamRecord | null | undefined): string | null {
  const first = exam?.critical_failures?.find((f) => typeof f === "string") as string | undefined;
  if (!first) return null;
  return first.replace(/^exam could not run:\s*/i, "");
}

export function criticalCount(exam: ExamRecord | null | undefined): number {
  return exam?.critical_failures?.length ?? 0;
}

/** Watch the model list for started exams that have finished; announce each result once. */
export function useExamWatcher(models: ModelItem[] | undefined) {
  const active = useExamRuns();
  useEffect(() => {
    if (!models) return;
    for (const run of Object.values(active)) {
      const m = models.find((x) => x.provider === run.provider && x.model_id === run.model_id);
      if (!m) continue;
      if (m.evaluated_at && m.evaluated_at !== run.before) {
        finish(run.key);
        const err = examRunError(m.exam);
        if (err) {
          toast.error(`The exam for ${run.name} could not run`, { description: err, duration: 10_000 });
        } else if (m.exam?.passed) {
          toast.success(`${run.name} passed the qualification exam`, {
            description: `Score ${pct(m.exam.score)}, no critical failures.`,
          });
        } else {
          toast(`${run.name} did not pass the exam`, {
            description: `Score ${pct(m.exam?.score)}, ${criticalCount(m.exam)} critical failure(s). It cannot be selected.`,
            duration: 10_000,
          });
        }
      } else if (Date.now() - run.startedAt > GIVE_UP_MS) {
        finish(run.key);
        toast("No exam result yet", { description: `${run.name}: check this page again later.` });
      }
    }
  }, [models, active]);
}

export function elapsed(since: number, now: number): string {
  const s = Math.max(0, Math.round((now - since) / 1000));
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

/** Current time, re-rendering every second while `on` is true. */
export function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [on]);
  return now;
}
