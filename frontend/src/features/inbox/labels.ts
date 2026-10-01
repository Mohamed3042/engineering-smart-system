/**
 * Inbox vocabulary that lib/labels.ts does not cover yet (email state, classification source,
 * link kinds, mail groups). Kept here so the inbox screens use one wording.
 */
import { humanize } from "@/lib/format";
import type { StatusInfo } from "@/lib/labels";

export type MailGroup = "work" | "bills" | "promotions" | "other";
export const MAIL_GROUPS: MailGroup[] = ["work", "bills", "promotions", "other"];

export const GROUP_LABEL: Record<MailGroup, string> = {
  work: "Work",
  bills: "Bills",
  promotions: "Promotions",
  other: "Other",
};

export const GROUP_HINT: Record<MailGroup, string> = {
  work: "Enquiries, tenders and project mail",
  bills: "Invoices, statements and payments",
  promotions: "Newsletters and marketing mail",
  other: "Supplier offers, internal and system mail",
};

export function isMailGroup(v: string | null | undefined): v is MailGroup {
  return !!v && (MAIL_GROUPS as string[]).includes(v);
}

/** Email.state: new | needs_review | linked | update | archived | ignored */
const EMAIL_STATE: Record<string, StatusInfo> = {
  new: { label: "New", tone: "neutral" },
  needs_review: { label: "Needs review", tone: "review" },
  linked: { label: "Linked to project", tone: "brand" },
  update: { label: "Project update", tone: "neutral" },
  archived: { label: "Archived", tone: "muted" },
  ignored: { label: "Ignored", tone: "muted" },
};
export const emailStateInfo = (k?: string | null): StatusInfo =>
  k ? (EMAIL_STATE[k] ?? { label: humanize(k), tone: "neutral" }) : { label: "—", tone: "muted" };

/** State filter choices. "open" hides archived and ignored mail (the default view). */
export const STATE_FILTERS: { value: string; label: string; param?: string }[] = [
  { value: "open", label: "Open mail", param: "new,needs_review,linked,update" },
  { value: "new", label: "New", param: "new" },
  { value: "needs_review", label: "Needs review", param: "needs_review" },
  { value: "linked", label: "Linked to project", param: "linked" },
  { value: "update", label: "Project update", param: "update" },
  { value: "archived", label: "Archived", param: "archived" },
  { value: "ignored", label: "Ignored", param: "ignored" },
  { value: "all", label: "All mail" },
];

/** Mail intents in the order the filter offers them: work signals first. Labels come from lib/labels intentInfo(). */
export const INTENT_FILTERS = [
  "rfq",
  "addendum",
  "deadline_change",
  "revision",
  "reminder",
  "clarification",
  "award",
  "purchase_order",
  "invoice",
  "offer",
  "newsletter",
  "notification",
  "internal",
  "other",
] as const;

/** Work types and request kinds a project can have (backend/ess/ai/tasks.py WORK_TYPES, REQUEST_KINDS). */
export const WORK_TYPES = ["supply_installation", "annual_maintenance", "equipment_rental", "service_repair", "inspection_certification"];
export const REQUEST_KINDS = ["tender_rfq", "direct_rfq", "o_and_m", "info_request", "revision"];

/** Who decided the category (Email.category_source). */
const CATEGORY_SOURCE: Record<string, string> = {
  rules: "Keyword rules",
  ai: "AI engine",
  mcp: "AI engine (MCP)",
  user: "A person",
  import: "Imported",
  learned: "Learned from a correction",
};
export const categorySourceLabel = (k?: string | null) => (k ? (CATEGORY_SOURCE[k] ?? humanize(k)) : "—");

/** Kinds from backend/ess/sources/links.py LINK_KINDS. */
const LINK_KIND: Record<string, string> = {
  google_drive_file: "Google Drive file",
  google_drive_folder: "Google Drive folder",
  google_docs: "Google Docs",
  wetransfer: "WeTransfer",
  dropbox: "Dropbox",
  onedrive: "OneDrive",
  sharepoint: "SharePoint",
  box: "Box",
  mega: "MEGA",
  mediafire: "MediaFire",
  direct_file: "Direct file link",
  other: "Web link",
};
export const linkKindLabel = (k?: string | null) => (k ? (LINK_KIND[k] ?? humanize(k)) : "Link");

/** Below this the classification is shown as uncertain. */
export const LOW_CONFIDENCE = 0.6;
