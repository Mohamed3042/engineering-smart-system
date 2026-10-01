/**
 * Helpers for the project screens: next-action wording and targets, change kinds, checklist and
 * link vocabulary that labels.ts does not cover, and the four separate status facts.
 */
import type {
  ChecklistItem,
  Enquiry,
  Evidence,
  NextAction,
  ProjectChange,
  ProjectFile,
  ProjectLink,
  Quotation,
  Review,
} from "@/api/types";
import { formatDate, formatDateShort, humanize } from "@/lib/format";
import {
  customerResponseInfo,
  fileSourceLabel,
  intentInfo,
  quotationStatusInfo,
  type StatusInfo,
  type Tone,
} from "@/lib/labels";
import { nextActionHref, projectHref } from "@/lib/routes";
import type { DetailEmail, ProjectDetail } from "./api";

/* ------------------------------------------------------------------ service families */

/** Tab / table label for a service family: the two main families get short names. */
export function familyLabel(key: string | null | undefined, categoryLabel: (k: string) => string): string {
  if (key === "bmu") return "BMU";
  if (key === "wce") return "Window cleaning";
  return key ? categoryLabel(key) : "—";
}

/** Work types and request kinds the backend classifies into (ess/ai/tasks.py). */
export const WORK_TYPES = ["supply_installation", "annual_maintenance", "equipment_rental", "service_repair", "inspection_certification"];
export const REQUEST_KINDS = ["tender_rfq", "direct_rfq", "o_and_m", "info_request", "revision"];

/* ------------------------------------------------------------------ next action */

const ACTION_SHORT: Record<string, string> = {
  review_change: "Review change",
  resolve_link: "Fix download",
  collect_files: "Collect files",
  analyze: "Study documents",
  wait: "View analysis",
  engineer_review: "Open review",
  prepare_quotation: "Prepare quotation",
  send: "Send quotation",
  follow_up: "Follow up",
  clarify_scope: "Clarify scope",
  confirm_deadline: "Confirm deadline",
  download_documents: "Get documents",
  review_documents: "Review documents",
  decide_bid: "Decide on bid",
  resolve_dispute: "Resolve dispute",
};

const SHORT_LABEL = 30;

/** Button text for a next action: its own label when short, else a verb for its kind. */
export function actionButtonLabel(a: NextAction | null | undefined): string | null {
  if (!a || a.kind === "none") return null;
  const label = String(a.label ?? "").trim();
  if (label && label.length <= SHORT_LABEL) return label;
  if (a.kind && ACTION_SHORT[a.kind]) return ACTION_SHORT[a.kind];
  return label ? "Open next step" : null;
}

/** The full sentence when it does not fit on the button. */
export function actionSentence(a: NextAction | null | undefined): string | null {
  const label = String(a?.label ?? "").trim();
  return label.length > SHORT_LABEL ? label : null;
}

/** Where a next action is done. Scan-written kinds map to the tab that serves them. */
export function actionHref(projectId: string, a: NextAction | null | undefined): string {
  switch (a?.kind) {
    case "clarify_scope":
      return projectHref(projectId, "analysis");
    case "confirm_deadline":
      return projectHref(projectId, "enquiries");
    case "download_documents":
    case "review_documents":
      return projectHref(projectId, "inputs");
    default:
      return nextActionHref(projectId, a);
  }
}

export function actionSourceLabel(source: unknown): string | null {
  switch (source) {
    case "scan":
      return "Set by the mailbox scan";
    case "user":
      return "Set by a person";
    case "ai":
    case "mcp":
      return "Suggested by the AI engine";
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ changes */

export function changeKindInfo(kind?: string | null): StatusInfo {
  switch (kind) {
    case "deadline_changed":
      return intentInfo("deadline_change");
    case "technical_revision":
      return intentInfo("revision");
    case "addendum":
      return intentInfo("addendum");
    case "reminder":
      return intentInfo("reminder");
    case "scope_change":
      return { label: "Scope change", tone: "review" };
    default:
      return { label: humanize(kind) || "Change", tone: "neutral" };
  }
}

/** "2026-10-22" → "22 Oct 2026"; other values as written. */
export function displayValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return formatDate(v.slice(0, 10));
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function openChangeIndexes(changes: ProjectChange[] | null | undefined): number[] {
  return (changes ?? []).map((c, i) => (c.acknowledged ? -1 : i)).filter((i) => i >= 0);
}

/* ------------------------------------------------------------------ checklist */

export type CheckStatus = "pending" | "checked" | "needs_review" | "failed";

/** What a person picks. "Not applicable" is stored as a checked item that carries `not_applicable: true`. */
export type CheckChoice = CheckStatus | "not_applicable";

/** The backend stores pending | checked | needs_review | failed; older data may say open / flagged. */
export function normalizeCheck(s: string | null | undefined): CheckStatus {
  if (s === "checked") return "checked";
  if (s === "needs_review" || s === "flagged") return "needs_review";
  if (s === "failed") return "failed";
  return "pending";
}

/** The server knows four statuses and approval needs every item "checked", so Not applicable is a checked item with a flag and a reason. */
export function checkChoice(item: { status?: string | null; not_applicable?: unknown }): CheckChoice {
  const s = normalizeCheck(item.status);
  return s === "checked" && item.not_applicable === true ? "not_applicable" : s;
}

/** The item fields that a choice writes. */
export function choicePatch(choice: CheckChoice): Partial<ChecklistItem> {
  return choice === "not_applicable" ? { status: "checked", not_applicable: true } : { status: choice, not_applicable: false };
}

const CHECK: Record<CheckChoice, StatusInfo> = {
  pending: { label: "Open", tone: "neutral" },
  checked: { label: "Checked", tone: "brand" },
  not_applicable: { label: "Not applicable", tone: "neutral" },
  needs_review: { label: "Needs review", tone: "review" },
  failed: { label: "Problem found", tone: "block" },
};

/** What an item still lacks before it counts as checked. */
export type ChecklistIssue = "needs_note" | "needs_reason";

/** The chip of an item: a check that nobody stood behind is not shown as Checked. */
export function checklistItemInfo(item: ChecklistItem, issue: ChecklistIssue | null): StatusInfo {
  if (issue === "needs_note") return { label: "Needs a note", tone: "review" };
  if (issue === "needs_reason") return { label: "Needs a reason", tone: "review" };
  return CHECK[checkChoice(item)];
}

/** What backs a checklist item up: quotes the system attached, or values it recorded for it. */
export interface ChecklistBasis {
  evidence: Evidence[];
  /** Short lines, e.g. "Revision R03 read on Hoist-layout-R03.pdf, page 1". */
  recorded: string[];
}

export const hasBasis = (b: ChecklistBasis) => b.evidence.length > 0 || b.recorded.length > 0;

/** Revisions read from drawing sheets. */
function drawingRevisions(files: ProjectFile[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    for (const [page, finding] of Object.entries(f.analysis ?? {})) {
      if (!/^\d+$/.test(page) || !finding || typeof finding !== "object") continue;
      const rev = (finding as { sheet?: { revision?: { value?: unknown; readable?: boolean } | null } }).sheet?.revision;
      const value = rev && rev.readable !== false && rev.value !== null && rev.value !== undefined ? String(rev.value).trim() : "";
      if (value) out.push(`Revision ${value} read on ${f.name}, page ${page}`);
    }
  }
  return out;
}

export function checklistBasis(item: ChecklistItem, detail: ProjectDetail, review: Review | null | undefined): ChecklistBasis {
  const evidence = (Array.isArray(item.evidence) ? item.evidence : []).filter((e) => !!e && (!!e.quote || !!e.source_id));
  const recorded: string[] = [];
  const value = item.value;
  if ((typeof value === "string" || typeof value === "number") && String(value).trim()) recorded.push(String(value).trim());
  if (item.key === "drawings") {
    const rev = revisionText(review?.revision);
    if (rev) recorded.push(`This round covers ${rev}`);
    recorded.push(...drawingRevisions(detail.files));
  }
  if (item.key === "scope") {
    const scope = detail.project.scope_items ?? [];
    const sourced = scope.filter((s) => firstEvidence(s.evidence)?.verified === true);
    if (scope.length > 0 && sourced.length === scope.length) {
      recorded.push(`${scope.length} scope ${scope.length === 1 ? "item" : "items"}, each with its quote found in the source`);
    }
  }
  return { evidence, recorded };
}

/**
 * The note a person wrote. The system also puts a note on an item it flags ("No drawing received");
 * that note, left as it is when the item is checked, is not what was checked, so it does not count.
 */
export function ownNote(item: ChecklistItem, flagNote?: string | null): string {
  const note = (item.note ?? "").trim();
  return note && note !== (flagNote ?? "").trim() ? note : "";
}

/**
 * A checked item needs something to stand on: evidence, a recorded value or a note of what was
 * checked. "Not applicable" needs the reason. A checkbox alone never counts as approval.
 */
export function checklistIssue(item: ChecklistItem, basis: ChecklistBasis, flagNote?: string | null): ChecklistIssue | null {
  const note = ownNote(item, flagNote);
  const choice = checkChoice(item);
  if (choice === "not_applicable") return note ? null : "needs_reason";
  if (choice === "checked" && !hasBasis(basis) && !note) return "needs_note";
  return null;
}

/** What is saved: an item without its note or reason is saved as open, so the server never holds a check nobody stood behind. */
export function checklistItemForSave(item: ChecklistItem, basis: ChecklistBasis, flagNote?: string | null): ChecklistItem {
  const out: ChecklistItem = { ...item };
  delete out.not_applicable;
  if (checklistIssue(item, basis, flagNote)) return { ...out, status: "pending" };
  return checkChoice(item) === "not_applicable" ? { ...out, not_applicable: true } : out;
}

export const ROLE_RANK: Record<string, number> = { viewer: 0, sales: 1, engineer: 2, admin: 3, owner: 4 };

/** Review rounds store "revision" as text, or the review id when nothing better is known. */
export function revisionText(rev: string | null | undefined): string | null {
  if (!rev || /^rev_[0-9a-f]{6,}$/i.test(rev)) return null;
  return rev;
}

/* ------------------------------------------------------------------ links & files */

export function linkSourceLabel(kind: string | null | undefined): string {
  const k = (kind ?? "").toLowerCase();
  const folder = k.includes("folder") ? " folder" : "";
  if (k.startsWith("google")) return fileSourceLabel("google_drive") + folder;
  if (k.startsWith("sharepoint")) return `SharePoint${folder}`;
  if (k.startsWith("onedrive")) return fileSourceLabel("onedrive") + folder;
  if (k.startsWith("dropbox")) return fileSourceLabel("dropbox") + folder;
  if (k.startsWith("wetransfer")) return fileSourceLabel("wetransfer");
  return fileSourceLabel("link");
}

/** Best guess of the file host for a pasted link (the server decides the final kind). */
export function detectHost(url: string): { host: string; label: string } | null {
  let host = "";
  try {
    host = new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
  const label = /(^|\.)drive\.google\.com$|(^|\.)docs\.google\.com$/.test(host)
    ? fileSourceLabel("google_drive")
    : /(^|\.)we\.tl$|(^|\.)wetransfer\.com$/.test(host)
      ? fileSourceLabel("wetransfer")
      : /(^|\.)dropbox\.com$|(^|\.)dropboxusercontent\.com$/.test(host)
        ? fileSourceLabel("dropbox")
        : /(^|\.)sharepoint\.com$/.test(host)
          ? "SharePoint"
          : /(^|\.)onedrive\.live\.com$|(^|\.)1drv\.ms$/.test(host)
            ? fileSourceLabel("onedrive")
            : "Web page";
  return { host, label };
}

export const LINK_NEEDS_DECISION = new Set(["found", "pending_approval"]);
export const LINK_NEEDS_RECOVERY = new Set(["failed", "expired", "needs_login", "blocked"]);

export function linkRecoveryText(link: ProjectLink): string {
  switch (link.status) {
    case "expired":
      return "The shared link has expired. Ask the sender for a new link, or upload the files directly.";
    case "needs_login":
      return "The host asks for a sign-in. Open the link in your browser, download the files, then upload them here.";
    case "blocked":
      return "The download policy blocks this host. Open the link yourself and upload the files here.";
    default:
      return `The download did not finish${link.error ? `: ${link.error}` : "."} Try again, or upload the files directly.`;
  }
}

export function fileReviewInfo(f: ProjectFile): StatusInfo {
  return f.reviewed_by ? { label: "Reviewed", tone: "brand" } : { label: "Not reviewed", tone: "muted" };
}

/** A PDF has pages the viewer can show one by one. */
export const isPdfFile = (f: Pick<ProjectFile, "mime" | "name">) => /pdf/i.test(f.mime) || /\.pdf$/i.test(f.name);
/** An image is shown whole. */
export const isImageFile = (f: Pick<ProjectFile, "mime" | "name">) =>
  f.mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name);

/** The last part of a path: "Tender/Drawings.pdf" → "Drawings.pdf". */
export const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** A page number written as 3, "3" or "p. 3"; anything else is no page. */
export function pageNumber(v: unknown): number | null {
  const found = typeof v === "number" ? [String(Math.trunc(v))] : typeof v === "string" ? v.match(/\d+/) : null;
  const n = found ? Number(found[0]) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/* ------------------------------------------------------------------ evidence */

/** Fill in a readable source label and resolve file names / thread ids to linkable ids. */
export function withSource(ev: Evidence, emails: DetailEmail[], files: ProjectFile[]): Evidence {
  if (!ev) return ev;
  const sid = String(ev.source_id ?? "");
  if (ev.source_type === "email" || (!ev.source_type && emails.some((e) => e.id === sid || e.thread_id === sid))) {
    const e = emails.find((x) => x.id === sid) ?? emails.find((x) => x.thread_id === sid);
    if (e) {
      const who = e.from_name || e.from_email;
      return {
        ...ev,
        source_type: "email",
        source_id: e.id,
        source_label: ev.source_label || `${who}${e.date ? ` · ${formatDateShort(e.date)}` : ""}`,
      };
    }
  }
  if (ev.source_type === "file" || (!ev.source_type && files.some((f) => f.id === sid || f.name === sid))) {
    const f = files.find((x) => x.id === sid) ?? files.find((x) => x.name === sid || x.name === ev.source_label);
    if (f) return { ...ev, source_type: "file", source_id: f.id, source_label: ev.source_label || f.name };
  }
  return ev;
}

export function firstEvidence(ev: unknown): Evidence | null {
  if (!ev) return null;
  if (Array.isArray(ev)) return (ev[0] as Evidence) ?? null;
  if (typeof ev === "object") return ev as Evidence;
  return null;
}

/**
 * Evidence as the screens show it. A page reference is a whole number and only a PDF has pages:
 * for a spreadsheet the number that the analysis stored is a row, so it reads "row 7", not "p7".
 */
export function readableEvidence(ev: Evidence, emails: DetailEmail[], files: ProjectFile[]): Evidence {
  const e = withSource(ev, emails, files);
  if (e.source_type !== "file") return e;
  const file = files.find((f) => f.id === e.source_id);
  const page = pageNumber(e.page);
  if (!file || isPdfFile(file)) return { ...e, page };
  // spreadsheets: newer analyses store "row" (and "sheet"); older ones stored the row in "page"
  const row = pageNumber(typeof e.row === "number" || typeof e.row === "string" ? e.row : e.page);
  if (isImageFile(file) || row === null) return { ...e, page: null };
  const sheet = typeof e.sheet === "string" && e.sheet ? ` · ${e.sheet}` : "";
  return { ...e, page: null, source_label: `${e.source_label || file.name}${sheet} · row ${row}` };
}

/* ------------------------------------------------------------------ closing-date history */

/** One replaced closing date: `value` is the earlier date; the rest says when, by whom and why it changed. */
export interface DateHistoryEntry {
  value?: string | null;
  changed_at?: string;
  confirmed_by?: string;
  source?: string;
  note?: string;
  evidence?: Evidence;
}

/** The dates an enquiry had before, newest first. */
export function replacedDates(e: Pick<Enquiry, "due_date" | "due_date_history">): DateHistoryEntry[] {
  return ((e.due_date_history ?? []) as DateHistoryEntry[]).filter((h) => h.value && h.value !== e.due_date).reverse();
}

/** Where an earlier date was replaced: "changed 29 Sep by Sarah". */
export function historySource(h: DateHistoryEntry): string {
  const when = h.changed_at ? `changed ${formatDateShort(h.changed_at)}` : null;
  const who = h.confirmed_by ? `by ${h.confirmed_by}` : h.source ? `by ${humanize(h.source)}` : null;
  return [when, who].filter(Boolean).join(" ") || "earlier date";
}

/* ------------------------------------------------------------------ four status facts */

export interface Fact {
  info: StatusInfo;
  detail?: string | null;
}

const Q_ORDER = ["changes_requested", "needs_review", "approved", "draft", "sent"];

function countBy<T>(items: T[], key: (t: T) => string): string {
  const counts = new Map<string, number>();
  items.forEach((i) => counts.set(key(i), (counts.get(key(i)) ?? 0) + 1));
  return [...counts.entries()].map(([k, n]) => `${n} ${k.toLowerCase()}`).join(", ");
}

/** Commercial review = the quotation's own approval, separate from the engineering review. */
export function commercialFact(quotations: Quotation[]): Fact {
  const live = quotations.filter((q) => q.status !== "superseded");
  if (!live.length) return { info: { label: "No quotation yet", tone: "muted" }, detail: "Create one under Documents." };
  const top = Q_ORDER.find((s) => live.some((q) => q.status === s)) ?? live[0].status;
  const lead = live.find((q) => q.status === top) ?? live[0];
  const detail =
    live.length > 1
      ? `${live.length} quotations: ${countBy(live, (q) => quotationStatusInfo(q.status).label)}`
      : lead.status === "approved" || lead.status === "sent"
        ? `${lead.reference}${lead.approved_by ? ` · approved by ${lead.approved_by}` : ""}${lead.approved_at ? ` on ${formatDate(lead.approved_at)}` : ""}`
        : lead.reference || null;
  return { info: quotationStatusInfo(top), detail };
}

function enquirySent(e: Enquiry, quotations: Quotation[]): boolean {
  if (["quoted", "won", "lost"].includes(e.status)) return true;
  if ((e.our_response as { status?: string } | undefined)?.status === "quoted") return true;
  return quotations.some((q) => q.enquiry_id === e.id && (q.status === "sent" || !!q.sent_at));
}

/** Whether our offer went out. Sent is a fact of its own; it is not acceptance. */
export function sendFact(quotations: Quotation[], enquiries: Enquiry[]): Fact {
  const sentQuotes = quotations.filter((q) => q.status === "sent" || !!q.sent_at);
  const lastSent = sentQuotes.map((q) => q.sent_at).filter(Boolean).sort().pop();
  const approved = quotations.some((q) => q.status === "approved");
  if (enquiries.length) {
    const sent = enquiries.filter((e) => enquirySent(e, quotations));
    if (!sent.length) {
      return approved
        ? { info: { label: "Ready to send", tone: "review" }, detail: "An approved quotation waits for the send confirmation." }
        : { info: { label: "Not sent", tone: "neutral" }, detail: null };
    }
    return {
      info: { label: "Sent", tone: "brand" },
      detail:
        enquiries.length > 1
          ? `To ${sent.length} of ${enquiries.length} contractors${lastSent ? ` · last ${formatDate(lastSent)}` : ""}`
          : lastSent
            ? `On ${formatDate(lastSent)}`
            : "Offer sent",
    };
  }
  if (sentQuotes.length) return { info: { label: "Sent", tone: "brand" }, detail: lastSent ? `On ${formatDate(lastSent)}` : null };
  return approved
    ? { info: { label: "Ready to send", tone: "review" }, detail: "An approved quotation waits for the send confirmation." }
    : { info: { label: "Not sent", tone: "neutral" }, detail: null };
}

const R_ORDER = ["accepted", "rejected", "clarification", "awaiting", "none"];

/** The customer's answer, per enquiry. */
export function responseFact(enquiries: Enquiry[]): Fact {
  if (!enquiries.length) return { info: customerResponseInfo("none"), detail: null };
  const top = R_ORDER.find((r) => enquiries.some((e) => (e.customer_response || "none") === r)) ?? "none";
  const detail =
    enquiries.length > 1 ? countBy(enquiries, (e) => customerResponseInfo(e.customer_response || "none").label) : null;
  return { info: customerResponseInfo(top), detail };
}

/* ------------------------------------------------------------------ dates */

export function dueTone(days: number | null): Tone {
  if (days === null) return "muted";
  if (days < 0) return "block";
  if (days <= 7) return "review";
  return "neutral";
}
