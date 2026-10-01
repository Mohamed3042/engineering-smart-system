/**
 * Control center data: GET /api/dashboard (backend/ess/api/workspace.py dashboard() and _project_row()).
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { Activity, Blocker, NextAction, ProjectChange } from "@/api/types";
import { daysUntil, formatDateShort, humanize } from "@/lib/format";
import { PROJECT_STAGES } from "@/lib/labels";
import type { DateRangeValue } from "@/ui";

export type Bucket = "needs_attention" | "in_progress" | "completed";
export const BUCKETS: Bucket[] = ["needs_attention", "in_progress", "completed"];

export function isBucket(v: string | null): v is Bucket {
  return !!v && (BUCKETS as string[]).includes(v);
}

export interface DashboardRow {
  id: string;
  code: string;
  name: string;
  customer: string | null;
  customer_id: string | null;
  service_family: string;
  work_type: string;
  stage: string;
  stage_label: string;
  review_status: string;
  due_date: string | null;
  priority: string;
  next_action: NextAction | null;
  blockers: Blocker[];
  open_changes: ProjectChange[];
  updated_at: string;
  bucket: Bucket;
}

export interface Dashboard {
  workspace: { name: string; company_name: string; primary_email: string };
  range: { from: string | null; to: string | null };
  counts: Record<Bucket, number>;
  buckets: Record<Bucket, DashboardRow[]>;
  by_service_family: Record<string, number>;
  inbox: { total: number; work: number; unread_work: number };
  quotations: Record<string, number>;
  today: Activity[];
  sync: string | null;
}

export function useDashboard(range: DateRangeValue) {
  return useQuery({
    queryKey: ["dashboard", { from: range.from, to: range.to }],
    queryFn: () => api.get<Dashboard>("/dashboard", { date_from: range.from, date_to: range.to }),
    placeholderData: keepPreviousData,
  });
}

/* ------------------------------------------------------------------ latest update */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}/;

function valueText(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v);
  if (ISO_DAY.test(s) && s.length <= 25) return formatDateShort(s);
  return s.length > 48 ? null : s;
}

/** "8 Oct → 22 Oct" when the change carries both values and they are short. */
export function changeValues(c: ProjectChange): string | null {
  const before = valueText(c.old_value);
  const after = valueText(c.new_value);
  return before && after ? `${before} → ${after}` : null;
}

/** The newest change nobody has acknowledged yet. */
export function latestChange(row: DashboardRow): ProjectChange | null {
  const changes = row.open_changes ?? [];
  if (!changes.length) return null;
  return [...changes].sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")))[0];
}

/** Date used to sort by "latest update": the newest open change, else the last project update. */
export function updateDate(row: DashboardRow): string {
  return String(latestChange(row)?.date ?? row.updated_at ?? "");
}

/* ------------------------------------------------------------------ next action */

/** Short verbs for buttons when the stored label is a whole sentence (scanner / AI next steps). */
const KIND_VERB: Record<string, string> = {
  review_change: "Review change",
  resolve_link: "Fix file download",
  collect_files: "Collect files",
  analyze: "Study documents",
  wait: "View analysis",
  engineer_review: "Open engineer review",
  prepare_quotation: "Finish quotation",
  send: "Open quotation",
  follow_up: "Follow up",
  decide_bid: "Decide on bid",
  download_documents: "Get documents",
};

const BUTTON_MAX = 24;

/** Button text plus the full sentence when it does not fit on a button. */
export function nextActionText(a: NextAction | null | undefined): { button: string; detail: string | null } | null {
  if (!a || !a.kind || a.kind === "none") return null;
  const label = (a.label ?? "").trim();
  if (label && label.length <= BUTTON_MAX) return { button: label, detail: a.detail ? String(a.detail) : null };
  return { button: KIND_VERB[a.kind] ?? humanize(a.kind), detail: label || (a.detail ? String(a.detail) : null) };
}

/* ------------------------------------------------------------------ sorting */

export type SortKey = "due" | "priority" | "update" | "name" | "status" | "details";
export type SortState = { key: SortKey; dir: "asc" | "desc" };

export const SORT_OPTIONS: { value: SortKey; label: string; dir: "asc" | "desc" }[] = [
  { value: "due", label: "Due date", dir: "asc" },
  { value: "priority", label: "Priority", dir: "asc" },
  { value: "update", label: "Latest update", dir: "desc" },
  { value: "status", label: "Status", dir: "asc" },
  { value: "details", label: "Blockers and changes", dir: "desc" },
  { value: "name", label: "Project name", dir: "asc" },
];

const PRIORITY_ORDER: Record<string, number> = { high: 0, normal: 1, low: 2 };

function compare(a: DashboardRow, b: DashboardRow, key: SortKey): number {
  switch (key) {
    case "due": {
      // no due date sorts last in both directions of the natural order
      if (!a.due_date && !b.due_date) return 0;
      if (!a.due_date) return 1;
      if (!b.due_date) return -1;
      return (daysUntil(a.due_date) ?? 0) - (daysUntil(b.due_date) ?? 0);
    }
    case "priority":
      return (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1);
    case "update":
      return updateDate(a).localeCompare(updateDate(b));
    case "status":
      return (PROJECT_STAGES as readonly string[]).indexOf(a.stage) - (PROJECT_STAGES as readonly string[]).indexOf(b.stage);
    case "details":
      return a.blockers.length * 100 + a.open_changes.length - (b.blockers.length * 100 + b.open_changes.length);
    case "name":
      return a.name.localeCompare(b.name);
  }
}

export function sortRows(rows: DashboardRow[], sort: SortState): DashboardRow[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const primary = compare(a, b, sort.key);
    if (primary !== 0) {
      // keep rows without a due date at the end even when the order flips
      if (sort.key === "due" && (!a.due_date || !b.due_date)) return primary;
      return primary * sign;
    }
    return compare(a, b, "due") || a.name.localeCompare(b.name);
  });
}

/* ------------------------------------------------------------------ waiting for approval */

/** The backend words a pending link download "Download waits for approval: <host>" (pipeline/state.py _LINK_BLOCKING). */
const DOWNLOAD_WAITS = /waits? for approval/i;

/**
 * What waits for a person's approval. Quotations come straight from the dashboard counts; the
 * dashboard has no list of pending downloads, so they are read from the projects' blockers, which
 * carry the link id.
 */
export function approvalsWaiting(data: Dashboard): { quotations: number; downloads: { row: DashboardRow; blocker: Blocker }[] } {
  const downloads: { row: DashboardRow; blocker: Blocker }[] = [];
  for (const bucket of BUCKETS) {
    for (const row of data.buckets[bucket] ?? []) {
      for (const blocker of row.blockers ?? []) {
        if (blocker.link_id && DOWNLOAD_WAITS.test(blocker.text)) downloads.push({ row, blocker });
      }
    }
  }
  return { quotations: data.quotations?.needs_review ?? 0, downloads };
}
