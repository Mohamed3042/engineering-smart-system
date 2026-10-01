/**
 * Automation vocabulary. Step descriptions follow backend/ess/automations/runner.py (STEPS), so a
 * person reads what each step really does before approving it.
 */
import type { Automation } from "@/api/types";
import { formatDateTime, humanize } from "@/lib/format";
import { runStatusInfo, type StatusInfo } from "@/lib/labels";
import { emailHref, projectHref } from "@/lib/routes";
import type { RunStep, TriggerStatus } from "./api";

/** What each step type does, in the words shown on the workflow and in the Continue dialog. */
const STEP_DOES: Record<string, string> = {
  sync_mail: "Reads new mail from the connected mailbox. Access is read-only.",
  classify: "Files new mail under Work, Bills, Promotions or Other.",
  link_project: "Links work mail to an existing project, or opens a new one.",
  fetch_attachments: "Saves the attachments of linked mail into the project.",
  fetch_links: "Downloads files from shared links on trusted hosts. Links from other hosts wait for a person to approve them.",
  extract_files: "Reads the text of the downloaded documents and drawings.",
  analyze_project: "Studies the documents and writes the scope, requirements and changes, with the source quote where the files give one.",
  draft_quotation: "Creates a draft quotation from the scope. Prices stay empty for a person to enter.",
  detect_changes: "Counts the closing-date changes, addenda and revisions nobody has reviewed yet on projects updated in the last day.",
  notify: "Adds an alert to Recent activity for each project with a change nobody reviewed yet.",
  monitor_customers: "Searches the web for news, projects and tenders about the customers you watch.",
  suggest_unsubscribe: "Lists promotion senders that could be unsubscribed. Nothing is unsubscribed here.",
  request_review: "Asks an engineer to review. The quotation stays locked until a person approves it. Nothing is sent to the customer.",
};

export const stepDoes = (type?: string | null) => (type ? (STEP_DOES[type] ?? null) : null);
export const stepTypeLabel = (type?: string | null) => (type ? humanize(type) : "Step");

/** Run and step states. "Waiting for approval" says what the run is doing, not what a person must do. */
export function runStateInfo(k?: string | null): StatusInfo {
  if (k === "waiting_approval") return { label: "Waiting for approval", tone: "review" };
  return runStatusInfo(k);
}

export function intervalLabel(minutes: number | null | undefined): string | null {
  if (!minutes) return null;
  if (minutes % 1440 === 0) {
    const d = minutes / 1440;
    return d === 1 ? "Every day" : d === 7 ? "Every week" : `Every ${d} days`;
  }
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return h === 1 ? "Every hour" : `Every ${h} hours`;
  }
  return `Every ${minutes} minutes`;
}

/** Where a person starts a new workflow (the route lives in this folder's routes.tsx). */
export const NEW_WORKFLOW_PATH = "/automations/new";

/** What the workflow is set to, in words: By hand, Every hour, When new mail arrives. Not whether it really starts by itself. */
export function configuredTrigger(a: Pick<Automation, "trigger" | "interval_minutes">): string {
  if (a.trigger === "schedule") return intervalLabel(a.interval_minutes) ?? "On a schedule";
  if (a.trigger === "new_email") return "When new mail arrives";
  if (a.trigger === "manual") return "By hand";
  return humanize(a.trigger);
}

export interface TriggerSummary {
  mode: string;
  /** True only when the server says the workflow starts by itself right now. */
  automatic: boolean;
  label: string;
  detail: string | null;
  /** ISO time of the next automatic run, when there is one. */
  next: string | null;
  /** What it is set to, when that is not what really happens ("Every hour" while background runs are off). */
  setTo: string | null;
}

/**
 * How a workflow starts, from the server's own answer (trigger_status). Without that answer the
 * safe words are used: it never says a workflow starts by itself unless the server said so.
 */
export function triggerSummary(a: Pick<Automation, "trigger" | "interval_minutes">, status?: TriggerStatus | null): TriggerSummary {
  const configured = configuredTrigger(a);
  if (!status) {
    return {
      mode: "manual",
      automatic: false,
      label: "Manual — Run now",
      detail: "Whether it starts by itself could not be checked.",
      next: null,
      setTo: a.trigger === "manual" ? null : configured,
    };
  }
  return {
    mode: status.mode,
    automatic: status.automatic === true,
    label: status.label,
    detail: status.detail ?? null,
    next: status.automatic ? (status.next_run_at ?? null) : null,
    setTo: status.automatic || a.trigger === "manual" ? null : configured,
  };
}

/** "any moment now", "in 12 min", or the date and time. */
export function formatNext(iso: string): string {
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return "soon";
  const mins = Math.round((at - Date.now()) / 60_000);
  if (mins <= 1) return "any moment now";
  if (mins < 60) return `in ${mins} min`;
  return formatDateTime(iso);
}

export const runTriggerLabel = (t?: string | null) =>
  t === "schedule" ? "On schedule" : t === "manual" ? "Run now" : t === "new_email" ? "New mail" : humanize(t);

/** Backend defaults omit `enabled` on steps; only an explicit false skips a step. */
export const stepEnabled = (s: { enabled?: boolean }) => s.enabled !== false;

/** The step a run is stopped at, if any. */
export const waitingStep = (steps: RunStep[]): RunStep | undefined => steps.find((s) => s.status === "waiting_approval");

export function formatDuration(from: string | null | undefined, to: string | null | undefined): string | null {
  if (!from || !to) return null;
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Where a run's target lives. */
export function targetHref(type: string | null | undefined, id: string | null | undefined): string | null {
  if (!type || !id) return null;
  if (type === "project") return projectHref(id);
  if (type === "email") return emailHref(id);
  return null;
}

export const isAdmin = (role?: string | null) => role === "admin" || role === "owner";
