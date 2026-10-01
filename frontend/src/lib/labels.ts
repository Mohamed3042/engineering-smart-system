/**
 * Shared vocabulary: every status the backend returns maps to one label and one tone.
 * Tones: brand = done/active (teal), review = waits on a person (amber),
 * block = blocker/failure (red), neutral = information, muted = inactive.
 */
import { humanize } from "./format";

export type Tone = "neutral" | "brand" | "review" | "block" | "muted";
export type StatusInfo = { label: string; tone: Tone };

function lookup(map: Record<string, StatusInfo>, key: string | null | undefined): StatusInfo {
  if (!key) return { label: "—", tone: "muted" };
  return map[key] ?? { label: humanize(key), tone: "neutral" };
}

export const PROJECT_STAGES = [
  "received",
  "files_ready",
  "analysis",
  "engineer_review",
  "quotation",
  "approved",
  "sent",
  "archived",
] as const;

const STAGE: Record<string, StatusInfo> = {
  received: { label: "Received", tone: "neutral" },
  files_ready: { label: "Files ready", tone: "neutral" },
  analysis: { label: "Analysis", tone: "neutral" },
  engineer_review: { label: "Engineer review", tone: "review" },
  quotation: { label: "Quotation", tone: "neutral" },
  approved: { label: "Approved", tone: "brand" },
  sent: { label: "Sent", tone: "brand" },
  archived: { label: "Archived", tone: "muted" },
};
export const stageInfo = (k?: string | null) => lookup(STAGE, k);

const REVIEW_STATUS: Record<string, StatusInfo> = {
  not_started: { label: "Not started", tone: "neutral" },
  in_review: { label: "Engineering review pending", tone: "review" },
  approved: { label: "Engineering approved", tone: "brand" },
  changes_requested: { label: "Changes requested", tone: "block" },
};
export const reviewStatusInfo = (k?: string | null) => lookup(REVIEW_STATUS, k);

const REVIEW_DECISION: Record<string, StatusInfo> = {
  approved: { label: "Approved", tone: "brand" },
  changes_requested: { label: "Changes requested", tone: "block" },
  superseded: { label: "Superseded", tone: "muted" },
};
export const reviewDecisionInfo = (k?: string | null) =>
  k ? lookup(REVIEW_DECISION, k) : ({ label: "Open", tone: "review" } as StatusInfo);

const QUOTATION_STATUS: Record<string, StatusInfo> = {
  draft: { label: "Draft", tone: "neutral" },
  needs_review: { label: "Needs review", tone: "review" },
  changes_requested: { label: "Changes requested", tone: "block" },
  approved: { label: "Approved", tone: "brand" },
  sent: { label: "Sent", tone: "brand" },
  superseded: { label: "Superseded", tone: "muted" },
};
export const quotationStatusInfo = (k?: string | null) => lookup(QUOTATION_STATUS, k);

const ENQUIRY_STATUS: Record<string, StatusInfo> = {
  open: { label: "Open", tone: "neutral" },
  quoted: { label: "Quoted", tone: "brand" },
  declined: { label: "Declined", tone: "muted" },
  lost: { label: "Lost", tone: "muted" },
  won: { label: "Won", tone: "brand" },
  closed: { label: "Closed", tone: "muted" },
};
export const enquiryStatusInfo = (k?: string | null) => lookup(ENQUIRY_STATUS, k);

/** The customer's answer after we sent our offer. Sent is not accepted. */
const CUSTOMER_RESPONSE: Record<string, StatusInfo> = {
  none: { label: "No response", tone: "muted" },
  awaiting: { label: "Awaiting customer", tone: "review" },
  clarification: { label: "Clarification asked", tone: "review" },
  accepted: { label: "Accepted", tone: "brand" },
  rejected: { label: "Rejected", tone: "block" },
};
export const customerResponseInfo = (k?: string | null) => lookup(CUSTOMER_RESPONSE, k);

/** File transfer status (downloaded is not extracted, extracted is not reviewed). */
const FILE_STATUS: Record<string, StatusInfo> = {
  not_downloaded: { label: "Not downloaded", tone: "neutral" },
  downloading: { label: "Downloading", tone: "neutral" },
  ready: { label: "Downloaded", tone: "brand" },
  failed: { label: "Download failed", tone: "block" },
  expired: { label: "Link expired", tone: "block" },
  needs_login: { label: "Needs login", tone: "block" },
};
export const fileStatusInfo = (k?: string | null) => lookup(FILE_STATUS, k);

const EXTRACTION_STATUS: Record<string, StatusInfo> = {
  pending: { label: "Not read yet", tone: "neutral" },
  extracted: { label: "Text extracted", tone: "brand" },
  partial: { label: "Partly extracted", tone: "review" },
  failed: { label: "Extraction failed", tone: "block" },
  not_supported: { label: "Not readable", tone: "muted" },
};
export const extractionStatusInfo = (k?: string | null) => lookup(EXTRACTION_STATUS, k);

const LINK_STATUS: Record<string, StatusInfo> = {
  found: { label: "Found", tone: "neutral" },
  pending_approval: { label: "Waits for approval", tone: "review" },
  approved: { label: "Approved", tone: "neutral" },
  downloading: { label: "Downloading", tone: "neutral" },
  downloaded: { label: "Downloaded", tone: "brand" },
  failed: { label: "Download failed", tone: "block" },
  expired: { label: "Link expired", tone: "block" },
  needs_login: { label: "Needs login", tone: "block" },
  blocked: { label: "Host blocked", tone: "block" },
  rejected: { label: "Rejected", tone: "muted" },
  resolved: { label: "Obtained another way", tone: "brand" },
};
export const linkStatusInfo = (k?: string | null) => lookup(LINK_STATUS, k);

const DOC_KIND: Record<string, string> = {
  drawing: "Drawing",
  boq: "BOQ",
  specification: "Specification",
  tender_doc: "Tender document",
  addendum: "Addendum",
  photo: "Photo",
  cad: "CAD file",
  correspondence: "Correspondence",
  other: "Other",
};
export const docKindLabel = (k?: string | null) => (k ? (DOC_KIND[k] ?? humanize(k)) : "—");

const FILE_SOURCE: Record<string, string> = {
  email_attachment: "Email attachment",
  google_drive: "Google Drive",
  wetransfer: "WeTransfer",
  dropbox: "Dropbox",
  onedrive: "OneDrive",
  link: "Shared link",
  upload: "Uploaded",
  scan: "Mailbox scan",
};
export const fileSourceLabel = (k?: string | null) => (k ? (FILE_SOURCE[k] ?? humanize(k)) : "—");

/** What a message is for, independent of the service family. */
const INTENT: Record<string, StatusInfo> = {
  rfq: { label: "Request for quotation", tone: "neutral" },
  addendum: { label: "Addendum", tone: "review" },
  deadline_change: { label: "Deadline change", tone: "review" },
  reminder: { label: "Reminder", tone: "neutral" },
  revision: { label: "Technical revision", tone: "review" },
  clarification: { label: "Clarification", tone: "neutral" },
  award: { label: "Award", tone: "brand" },
  purchase_order: { label: "Purchase order", tone: "brand" },
  invoice: { label: "Invoice", tone: "neutral" },
  offer: { label: "Supplier offer", tone: "neutral" },
  newsletter: { label: "Newsletter", tone: "muted" },
  notification: { label: "Notification", tone: "muted" },
  internal: { label: "Internal", tone: "neutral" },
  other: { label: "Other", tone: "muted" },
};
export const intentInfo = (k?: string | null) => lookup(INTENT, k);

const WORK_TYPE: Record<string, string> = {
  supply_installation: "Supply & installation",
  annual_maintenance: "Annual maintenance",
  maintenance: "Maintenance",
  service_repair: "Service & repair",
  inspection: "Inspection",
  inspection_repair: "Inspection & repair",
  modernization: "Modernisation",
  rental: "Rental",
  equipment_rental: "Equipment rental",
  tenders: "Tender",
  o_and_m: "Operation & maintenance",
};
export const workTypeLabel = (k?: string | null) => (k ? (WORK_TYPE[k] ?? humanize(k)) : "—");

const REQUEST_KIND: Record<string, string> = {
  tender_rfq: "Tender enquiry",
  direct_rfq: "Direct enquiry",
  revision: "Revision",
  o_and_m: "Operation & maintenance",
};
export const requestKindLabel = (k?: string | null) => (k ? (REQUEST_KIND[k] ?? humanize(k)) : "—");

/** Fallback service-family names; prefer the workspace's own category labels (useCategoryLabels). */
const SERVICE_FAMILY: Record<string, string> = {
  bmu: "Building Maintenance Units",
  wce: "Window Cleaning Equipment",
  cradle: "Suspended platforms / cradles",
  hoist: "Construction hoists",
  crane: "Cranes & lifting",
  access_rental: "Man lifts & access rental",
  scaffolding: "Scaffolding",
  space_frame: "Space frames & shades",
  other_work: "Other work requests",
};
export const serviceFamilyFallback = (k?: string | null) => (k ? (SERVICE_FAMILY[k] ?? humanize(k)) : "—");
/** Short codes used in tight spaces. */
export const serviceFamilyShort = (k?: string | null) =>
  k === "bmu" ? "BMU" : k === "wce" ? "WCE" : serviceFamilyFallback(k);

const MODEL_STATUS: Record<string, StatusInfo> = {
  eligible: { label: "Eligible", tone: "brand" },
  refused: { label: "Refused", tone: "block" },
  needs_evaluation: { label: "Needs qualification exam", tone: "review" },
  failed_evaluation: { label: "Failed exam", tone: "block" },
};
export const modelStatusInfo = (k?: string | null) => lookup(MODEL_STATUS, k);

const CONNECTION_STATUS: Record<string, StatusInfo> = {
  connected: { label: "Connected", tone: "brand" },
  error: { label: "Error", tone: "block" },
  not_connected: { label: "Not connected", tone: "neutral" },
  needs_auth: { label: "Needs sign-in", tone: "review" },
};
export const connectionStatusInfo = (k?: string | null) => lookup(CONNECTION_STATUS, k);

const KNOWLEDGE_STATUS: Record<string, StatusInfo> = {
  suggested: { label: "Suggested", tone: "review" },
  owner_confirmed: { label: "Confirmed by owner", tone: "brand" },
  rejected: { label: "Rejected", tone: "muted" },
};
export const knowledgeStatusInfo = (k?: string | null) => lookup(KNOWLEDGE_STATUS, k);

const CLAIM_BASIS: Record<string, string> = {
  delivered_work: "Delivered work",
  catalogue_claim: "Catalogue claim",
  market_vocabulary: "Market vocabulary",
  owner: "Stated by owner",
};
export const claimBasisLabel = (k?: string | null) => (k ? (CLAIM_BASIS[k] ?? humanize(k)) : "—");

const RUN_STATUS: Record<string, StatusInfo> = {
  running: { label: "Running", tone: "neutral" },
  succeeded: { label: "Succeeded", tone: "brand" },
  failed: { label: "Failed", tone: "block" },
  waiting_approval: { label: "Waits for approval", tone: "review" },
  cancelled: { label: "Cancelled", tone: "muted" },
  done: { label: "Done", tone: "brand" },
  skipped: { label: "Skipped", tone: "muted" },
  pending: { label: "Pending", tone: "neutral" },
  queued: { label: "Queued", tone: "neutral" },
};
export const runStatusInfo = (k?: string | null) => lookup(RUN_STATUS, k);

const CUSTOMER_KIND: Record<string, string> = {
  main_contractor: "Main contractor",
  contractor: "Contractor",
  subcontractor: "Subcontractor",
  consultant: "Consultant",
  developer: "Developer",
  owner: "Owner",
  facility_manager: "Facility manager",
  government: "Government",
  supplier: "Supplier",
  distributor: "Distributor",
  other: "Other",
};
export const customerKindLabel = (k?: string | null) => (k ? (CUSTOMER_KIND[k] ?? humanize(k)) : "—");

const ROLE: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  engineer: "Engineer",
  sales: "Sales",
  viewer: "Viewer",
};
export const roleLabel = (k?: string | null) => (k ? (ROLE[k] ?? humanize(k)) : "—");
