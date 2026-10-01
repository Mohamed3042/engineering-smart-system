/**
 * What the mailbox scan reads: how far back, which searches, how many conversations. Saved in the workspace as
 * settings.scan_scope, which POST /api/scan uses as its default.
 */
import { useMemo, useState } from "react";
import { useWorkspace } from "@/api/session";
import { formatDate } from "@/lib/format";
import { DateRangePicker, Field, Segmented, Select } from "@/ui";
import { useSaveWorkspace } from "../api";
import { TagInput } from "./TagInput";

interface ScanScopeSettings {
  months?: number;
  date_from?: string | null;
  date_to?: string | null;
  max_threads?: number;
  queries?: string[];
}

export interface ScopeDraft {
  /** "2" | "6" | "12" | "24" | "600" months, or "custom" for dates. */
  period: string;
  from: string;
  to: string;
  queries: string[];
  maxThreads: string;
}

const PERIODS = [
  { value: "2", label: "Last 2 months" },
  { value: "6", label: "Last 6 months" },
  { value: "12", label: "Last 12 months" },
  { value: "24", label: "Last 24 months" },
  { value: "600", label: "All mail" },
  { value: "custom", label: "Choose dates" },
];

const THREAD_CHOICES = [500, 1000, 2000, 5000, 10000];

/** A sensible first day when someone switches to "Choose dates": two months back. */
function twoMonthsAgo(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 2);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function draftFromScope(scope: ScanScopeSettings | undefined): ScopeDraft {
  const s = scope ?? {};
  return {
    period: s.date_from || s.date_to ? "custom" : String(s.months ?? 2),
    from: s.date_from ?? "",
    to: s.date_to ?? "",
    queries: Array.isArray(s.queries) ? s.queries : [],
    maxThreads: String(s.max_threads ?? 2000),
  };
}

/** The part of the scope the backend stores. Dates and months exclude each other, so the unused one is cleared. */
export function scopeBody(d: ScopeDraft): Record<string, unknown> {
  const base = { queries: d.queries, max_threads: Number(d.maxThreads) };
  return d.period === "custom"
    ? { ...base, date_from: d.from || null, date_to: d.to || null }
    : { ...base, months: Number(d.period), date_from: null, date_to: null };
}

export function validateScope(d: ScopeDraft): string | null {
  if (d.period !== "custom") return null;
  if (!d.from) return "Choose the first day to read from, or pick one of the periods above.";
  if (d.to && d.to < d.from) return "The end date is before the start date.";
  return null;
}

/** "Mail from 11 Aug 2026 to today", "The last 6 months of mail". */
export function describeScope(d: ScopeDraft): string {
  if (d.period === "custom") return d.from ? `Mail from ${formatDate(d.from)} ${d.to ? `to ${formatDate(d.to)}` : "to today"}` : "No start date chosen";
  if (d.period === "600") return "All mail in the mailbox";
  return `The last ${d.period} months of mail`;
}

/** Draft state and saving for the scope. `persist` writes only when something changed. */
export function useScope() {
  const workspace = useWorkspace();
  const save = useSaveWorkspace();
  const saved = workspace.settings?.scan_scope as ScanScopeSettings | undefined;
  const initial = useMemo(() => draftFromScope(saved), [saved]);
  const [draft, setDraft] = useState<ScopeDraft>(initial);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  return {
    draft,
    setDraft,
    dirty,
    problem: validateScope(draft),
    saving: save.isPending,
    error: save.error,
    persist: async () => {
      if (dirty) await save.mutateAsync({ settings: { scan_scope: scopeBody(draft) } });
    },
  };
}

export function ScopeFields({
  draft,
  onChange,
  disabled,
  problem,
}: {
  draft: ScopeDraft;
  onChange: (d: ScopeDraft) => void;
  disabled?: boolean;
  problem?: string | null;
}) {
  const set = <K extends keyof ScopeDraft>(k: K, v: ScopeDraft[K]) => onChange({ ...draft, [k]: v });
  const periods = PERIODS.some((p) => p.value === draft.period) ? PERIODS : [{ value: draft.period, label: `Last ${draft.period} months` }, ...PERIODS];
  const threads = [...new Set([...THREAD_CHOICES, Number(draft.maxThreads)])].sort((a, b) => a - b);

  return (
    <div className="space-y-6">
      <div role="group" aria-labelledby="scope-period" className="space-y-3">
        <p id="scope-period" className="text-sm font-medium text-ink">
          Read mail from
        </p>
        <Segmented
          label="Period"
          value={draft.period}
          onChange={(v) => onChange(v === "custom" && !draft.from ? { ...draft, period: v, from: twoMonthsAgo() } : { ...draft, period: v })}
          options={periods}
          className={disabled ? "pointer-events-none opacity-60" : undefined}
        />
        {draft.period === "custom" ? (
          <div className="space-y-1.5">
            <DateRangePicker value={{ from: draft.from, to: draft.to }} onChange={(r) => onChange({ ...draft, from: r.from, to: r.to })} />
            {problem ? (
              <p className="text-sm text-block" role="alert">
                {problem}
              </p>
            ) : (
              <p className="text-sm text-ink-3">The end date is optional: leave it open to read up to today.</p>
            )}
          </div>
        ) : null}
      </div>

      <Field
        label="Only mail that matches these searches"
        htmlFor="scope-queries"
        optional
        hint="Search words in the mailbox's own syntax, for example label:Tenders or from:consultant.example.com. Leave empty to read everything in the period."
      >
        <TagInput id="scope-queries" value={draft.queries} disabled={disabled} placeholder="label:Tenders" normalize={(s) => s.trim()} onChange={(v) => set("queries", v)} />
      </Field>

      <Field label="Most conversations to read" htmlFor="scope-max" hint="A first run with fewer conversations finishes sooner. You can scan again for more.">
        <Select
          id="scope-max"
          className="sm:max-w-56"
          value={draft.maxThreads}
          disabled={disabled}
          options={threads.map((n) => ({ value: String(n), label: n.toLocaleString("en-GB") }))}
          onChange={(e) => set("maxThreads", e.target.value)}
        />
      </Field>
    </div>
  );
}
