/**
 * Entity types as the backend serialises them (SQLModel tables in backend/ess/models.py).
 * Dates are ISO strings. JSON columns are typed loosely where their shape varies;
 * feature folders may narrow them locally.
 */

export type ID = string;
export type ISODate = string; // "2026-10-11"
export type ISODateTime = string; // "2026-10-01T09:41:00Z"

export interface Evidence {
  quote?: string;
  source_type?: string; // email | file | web | user
  source_id?: string;
  source_label?: string;
  page?: number | null;
  sheet?: string | null;
  cell?: string | null;
  verified?: boolean;
  url?: string;
  [k: string]: unknown;
}

export interface Workspace {
  id: ID;
  name: string;
  company_name: string;
  primary_email: string;
  region: string;
  country: string;
  languages: string[];
  currency: string;
  timezone: string;
  own_domains: string[];
  setup_step: string;
  settings: Record<string, any>;
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

export interface TeamMember {
  id: ID;
  workspace_id: ID;
  name: string;
  email: string;
  role: "owner" | "admin" | "engineer" | "sales" | "viewer" | string;
  initials: string;
  active: boolean;
  created_at: ISODateTime;
}

export interface SessionInfo {
  workspace: Workspace | null;
  user: TeamMember | null;
  workspaces: { id: ID; name: string; company_name: string; primary_email: string }[];
  setup_step: string;
  mail?: { status: string; account: string | null; provider: string; last_sync?: string | null } | null;
  ai?: { status: string; provider: string; method: string; model?: string | null } | null;
}

export interface Connection {
  id: ID;
  workspace_id: ID;
  kind: "ai" | "mail" | "drive" | "search" | string;
  method: "api" | "mcp" | "oauth" | "imap" | string;
  provider: string;
  name: string;
  config: Record<string, any>;
  secret_names: string[];
  status: "connected" | "error" | "not_connected" | "needs_auth" | string;
  account: string | null;
  is_active: boolean;
  last_checked_at: ISODateTime | null;
  last_error: string | null;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  [k: string]: unknown;
}

export interface AIModelState {
  id: string;
  workspace_id: ID;
  provider: string;
  model_id: string;
  display_name: string;
  tier: string;
  capabilities: Record<string, any>;
  status: "eligible" | "refused" | "needs_evaluation" | "failed_evaluation" | string;
  reasons: string[];
  exam: Record<string, any>;
  evaluated_at: ISODateTime | null;
  source: string;
  is_selected: boolean;
  updated_at: ISODateTime;
  [k: string]: unknown;
}

export interface Approval {
  id: ID;
  workspace_id: ID;
  action: string;
  target_type: string;
  target_id: ID;
  decided_by: string;
  decision: "approved" | "rejected" | string;
  revision: string | null;
  note: string;
  created_at: ISODateTime;
}

export interface Activity {
  id: ID;
  workspace_id: ID;
  kind: string;
  title: string;
  detail: string;
  severity: "info" | "success" | "warning" | "error" | string;
  actor: string;
  project_id: ID | null;
  customer_id: ID | null;
  email_id: ID | null;
  quotation_id: ID | null;
  is_read: boolean;
  created_at: ISODateTime;
}

export interface Category {
  id: string;
  workspace_id: ID;
  key: string;
  label: string;
  label_ar: string;
  group: "work" | "bills" | "promotions" | "other" | string;
  icon: string;
  visible: boolean;
  is_work_type: boolean;
  description: string;
  keywords: Record<string, any>;
  negative_keywords: Record<string, any>;
  order: number;
  source: string;
  evidence: Evidence[];
  [k: string]: unknown;
}

export interface Attachment {
  attachment_id?: string;
  filename: string;
  mime?: string;
  size?: number;
  [k: string]: unknown;
}

export interface Email {
  id: ID;
  workspace_id: ID;
  thread_id: string;
  account: string;
  direction: "inbound" | "outbound" | string;
  from_name: string;
  from_email: string;
  to: string[];
  cc: string[];
  subject: string;
  date: ISODateTime | null;
  snippet: string;
  body_text?: string;
  labels: string[];
  attachments: Attachment[];
  links: { url: string; kind?: string; host?: string; [k: string]: unknown }[];
  list_unsubscribe: string | null;
  list_unsubscribe_post: string | null;
  view_url: string | null;
  message_count: number;
  answered_by_us: boolean;
  category: string;
  category_confidence: number;
  category_reason: string;
  category_evidence: Evidence[];
  category_source: "rules" | "ai" | "mcp" | "user" | "import" | "learned" | string;
  intent: string;
  priority: "high" | "normal" | "low" | string;
  state: string;
  project_id: ID | null;
  enquiry_id: ID | null;
  customer_id: ID | null;
  unsubscribed_at: ISODateTime | null;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  [k: string]: unknown;
}

export interface ScanJob {
  id: ID;
  workspace_id: ID;
  scope: Record<string, any>;
  status: "queued" | "running" | "done" | "failed" | "cancelled" | string;
  progress: number;
  counts: Record<string, number>;
  log: any[];
  error: string | null;
  started_at: ISODateTime | null;
  finished_at: ISODateTime | null;
  created_at: ISODateTime;
}

export interface CustomerTag {
  tag: string;
  kind?: string;
  confidence?: number;
  evidence?: Evidence[];
  [k: string]: unknown;
}

export interface Customer {
  id: ID;
  workspace_id: ID;
  ref: string;
  name: string;
  domain: string;
  kind: string;
  kind_confidence: number;
  country: string;
  city: string;
  website: string;
  tags: CustomerTag[];
  notes: string;
  first_seen: ISODateTime | null;
  last_seen: ISODateTime | null;
  email_count: number;
  enquiry_count: number;
  project_count: number;
  status: "active" | "prospect" | "dormant" | string;
  profile_status: "none" | "researching" | "ready" | "partial" | string;
  monitoring: boolean;
  last_checked_at: ISODateTime | null;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  [k: string]: unknown;
}

export interface Contact {
  id: ID;
  customer_id: ID;
  name: string;
  email: string;
  phone: string | null;
  title: string | null;
  last_seen: ISODateTime | null;
}

export interface ResearchReport {
  id: ID;
  customer_id: ID;
  standard: "basic" | "standard" | "deep" | string;
  status: "running" | "done" | "failed" | string;
  provider: string;
  sections: Record<string, any>;
  gaps: any[];
  met_standard: boolean;
  evidence_count: number;
  summary: string;
  error: string | null;
  created_at: ISODateTime;
  finished_at: ISODateTime | null;
}

export interface CustomerUpdate {
  id: ID;
  customer_id: ID;
  kind: string;
  title: string;
  summary: string;
  url: string;
  source: string;
  published_at: ISODateTime | null;
  found_at: ISODateTime;
  relevance: number;
  is_read: boolean;
}

export interface Opportunity {
  id: ID;
  customer_id: ID;
  service_key: string;
  score: number;
  reason: string;
  evidence: Evidence[];
  status: "suggested" | "accepted" | "dismissed" | string;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  [k: string]: unknown;
}

export interface ScopeItem {
  no?: number | string;
  description: string;
  qty?: number | null;
  unit?: string | null;
  unit_price?: number | null;
  total?: number | null;
  evidence?: Evidence | Evidence[];
  [k: string]: unknown;
}

export interface Requirement {
  field: string;
  label: string;
  value: unknown;
  evidence?: Evidence;
  [k: string]: unknown;
}

export interface ProjectChange {
  kind: "deadline_changed" | "addendum" | "technical_revision" | "reminder" | "scope_change" | string;
  title: string;
  date?: ISODateTime;
  old_value?: unknown;
  new_value?: unknown;
  evidence?: Evidence;
  email_id?: ID;
  enquiry_id?: ID;
  acknowledged?: boolean;
  acknowledged_by?: string;
  acknowledged_at?: ISODateTime;
  pending_confirmation?: boolean;
  [k: string]: unknown;
}

export interface Blocker {
  kind?: string;
  title: string;
  detail?: string;
  severity?: string;
  resolved?: boolean;
  [k: string]: unknown;
}

export interface NextAction {
  kind?: string;
  label?: string;
  detail?: string;
  source?: string;
  target?: string;
  [k: string]: unknown;
}

export interface Project {
  id: ID;
  workspace_id: ID;
  ref: string;
  code: string;
  name: string;
  service_family: string;
  work_type: string;
  request_kind: string;
  customer_id: ID | null;
  stage: string;
  status_note: string;
  priority: string;
  due_date: ISODate | null;
  tender_no: string | null;
  location: string | null;
  owner_client: string | null;
  consultant: string | null;
  main_contractor: string | null;
  summary: string;
  scope_items: ScopeItem[];
  requirements: Requirement[];
  unresolved_questions: any[];
  changes: ProjectChange[];
  blockers: Blocker[];
  next_action: NextAction;
  timeline: any[];
  analysis: Record<string, any>;
  recommended_template: string | null;
  related_project_ids: ID[];
  assigned_to: ID | null;
  review_status: "not_started" | "in_review" | "approved" | "changes_requested" | string;
  source: string;
  archived_at: ISODateTime | null;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  [k: string]: unknown;
}

export interface Enquiry {
  id: ID;
  workspace_id: ID;
  project_id: ID;
  customer_id: ID | null;
  ref: string;
  contact: { name?: string; email?: string; phone?: string; title?: string; [k: string]: unknown };
  email_ids: ID[];
  thread_ids: string[];
  received_at: ISODateTime | null;
  due_date: ISODate | null;
  due_date_history: { value: ISODate; changed_at?: ISODateTime; source?: string; [k: string]: unknown }[];
  status: "open" | "quoted" | "declined" | "lost" | "won" | "closed" | string;
  our_response: Record<string, any>;
  customer_response: "none" | "awaiting" | "clarification" | "accepted" | "rejected" | string;
  customer_response_at: ISODateTime | null;
  quotation_id: ID | null;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  [k: string]: unknown;
}

export interface ProjectLink {
  id: ID;
  project_id: ID;
  email_id: ID | null;
  url: string;
  kind: string;
  host: string;
  status: string;
  note: string;
  error: string | null;
  files_count: number;
  approved_by: string | null;
  approved_at: ISODateTime | null;
  result: Record<string, any>;
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

export interface ProjectFile {
  id: ID;
  project_id: ID;
  enquiry_id: ID | null;
  name: string;
  doc_kind: string;
  source: string;
  source_url: string | null;
  email_id: ID | null;
  attachment_id: string | null;
  link_id: ID | null;
  path: string | null;
  size: number;
  sha256: string | null;
  mime: string;
  status: string;
  error: string | null;
  pages: number;
  summary: string;
  extraction_status: "pending" | "extracted" | "partial" | "failed" | "not_supported" | string;
  reviewed_by: string | null;
  reviewed_at: ISODateTime | null;
  extraction: Record<string, any>;
  analysis: Record<string, any>;
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

export interface ChecklistItem {
  key: string;
  label: string;
  status: "open" | "checked" | "flagged" | "na" | string;
  note?: string;
  evidence?: Evidence[];
  [k: string]: unknown;
}

export interface Review {
  id: ID;
  project_id: ID;
  quotation_id: ID | null;
  checklist: ChecklistItem[];
  reviewer_id: ID | null;
  reviewer_name: string | null;
  note: string;
  decision: "approved" | "changes_requested" | "superseded" | null;
  decided_at: ISODateTime | null;
  revision: string;
  supersedes_id: ID | null;
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

export interface Signatory {
  id: ID;
  workspace_id: ID;
  initials: string;
  full_name: string;
  title: string;
  company: string;
  city: string;
  email: string;
  phone: string | null;
  is_default: boolean;
  created_at: ISODateTime;
  [k: string]: unknown;
}

export interface QuotationLine {
  no?: number | string;
  description: string;
  qty?: number | null;
  unit?: string | null;
  unit_price?: number | null;
  total?: number | null;
  source?: Evidence | string | null;
  optional?: boolean;
  [k: string]: unknown;
}

export interface Quotation {
  id: ID;
  workspace_id: ID;
  project_id: ID;
  enquiry_id: ID | null;
  customer_id: ID | null;
  reference: string;
  template_key: string;
  template_reason: string;
  language: "en" | "ar" | string;
  signatory_id: ID | null;
  status: "draft" | "needs_review" | "changes_requested" | "approved" | "sent" | "superseded" | string;
  version: number;
  data: Record<string, any> & { items?: QuotationLine[]; exclusions?: string[]; paper_id?: string };
  pdf_path: string | null;
  pdf_rendered_at: ISODateTime | null;
  assets_status: Record<string, any>;
  created_by: string;
  approved_by: string | null;
  approved_at: ISODateTime | null;
  sent_at: ISODateTime | null;
  sent_via: string | null;
  mail_draft_id: string | null;
  impact_review: { required?: boolean; reason?: string; change?: unknown; since?: ISODateTime; [k: string]: unknown };
  change_requests: any[];
  created_at: ISODateTime;
  updated_at: ISODateTime;
  missing_prices?: unknown[];
  [k: string]: unknown;
}

export interface KnowledgeItem {
  id: ID;
  workspace_id: ID;
  kind: "service_family" | "work_type" | "term" | "standard" | "convention" | "identity" | string;
  key: string;
  label: string;
  label_ar: string;
  description: string;
  synonyms: any[];
  region: string | null;
  language: string | null;
  claim_basis: string | null;
  evidence: Evidence[];
  value: unknown;
  score: number;
  confidence: number;
  status: "suggested" | "owner_confirmed" | "rejected" | string;
  apply_to_classification: boolean;
  original: Record<string, any>;
  source: string;
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

export interface TemplateRule {
  id: ID;
  workspace_id: ID;
  name: string;
  match: { service_family?: string; work_type?: string; request_kind?: string; customer_id?: ID };
  template_key: string;
  language: string | null;
  paper_id: string | null;
  signatory_id: ID | null;
  priority: number;
  enabled: boolean;
  source: "user" | "learned" | string;
  hits: number;
  created_by: string;
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

export interface Lesson {
  id: ID;
  workspace_id: ID;
  kind: string;
  scope: "workspace" | "customer" | "sender" | "domain" | "service_family" | string;
  scope_key: string;
  subject: string;
  before: unknown;
  after: unknown;
  note: string;
  count: number;
  weight: number;
  active: boolean;
  created_by: string;
  created_at: ISODateTime;
  last_seen_at: ISODateTime;
}

export interface AutomationStep {
  key: string;
  label: string;
  type: string;
  enabled: boolean;
  requires_approval: boolean;
  config: Record<string, any>;
}

export interface Automation {
  id: ID;
  workspace_id: ID;
  key: string;
  name: string;
  description: string;
  trigger: "new_email" | "schedule" | "manual" | string;
  interval_minutes: number | null;
  steps: AutomationStep[];
  enabled: boolean;
  last_run_at: ISODateTime | null;
  runs_count: number;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  [k: string]: unknown;
}

export interface AutomationRunStep {
  key: string;
  label: string;
  status: string;
  started_at?: ISODateTime | null;
  finished_at?: ISODateTime | null;
  message?: string;
  details?: unknown;
}

export interface AutomationRun {
  id: ID;
  workspace_id: ID;
  automation_id: ID;
  status: "running" | "succeeded" | "failed" | "waiting_approval" | "cancelled" | string;
  trigger: string;
  target_type: string | null;
  target_id: ID | null;
  steps: AutomationRunStep[];
  summary: string;
  error: string | null;
  started_at: ISODateTime;
  finished_at: ISODateTime | null;
}

export interface Paged<T> {
  items: T[];
  total: number;
  [k: string]: unknown;
}
