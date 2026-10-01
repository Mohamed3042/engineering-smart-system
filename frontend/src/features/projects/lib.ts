/**
 * Helpers for the project screens: next-action wording and targets, change kinds, checklist and
 * link vocabulary that labels.ts does not cover, and the four separate status facts.
 */
import type { Enquiry, Evidence, NextAction, ProjectChange, ProjectFile, ProjectLink, Quotation } from "@/api/types";
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
import type { DetailEmail } from "./api";

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

export type CheckStatus = "pending" | "checked" | "needs_review" | "failed" | "na";

/** The backend stores pending | checked | needs_review | failed; older data may say open / flagged. */
export function normalizeCheck(s: string | null | undefined): CheckStatus {
  if (s === "checked") return "checked";
  if (s === "na" || s === "not_applicable") return "na";
  if (s === "needs_review" || s === "flagged") return "needs_review";
  if (s === "failed") return "failed";
  return "pending";
}

const CHECK: Record<CheckStatus, StatusInfo> = {
  pending: { label: "Open", tone: "neutral" },
  checked: { label: "Checked", tone: "brand" },
  na: { label: "Not applicable", tone: "neutral" },
  needs_review: { label: "Needs review", tone: "review" },
  failed: { label: "Problem found", tone: "block" },
};
export const checklistStatusInfo = (s: string | null | undefined) => CHECK[normalizeCheck(s)];

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
