/**
 * Quotation builder API: response shapes (narrowed from backend/ess/api/quotations.py and
 * backend/ess/api/learning.py) and the query hooks every screen in this folder shares.
 */
import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useCallback } from "react";
import { api } from "@/api/client";
import type {
  Approval,
  Customer,
  Enquiry,
  Evidence,
  Lesson,
  Paged,
  Project,
  Quotation,
  QuotationLine,
  Review,
  Signatory,
  TemplateRule,
  OmitKnown,
} from "@/api/types";

/* ------------------------------------------------------------------ shapes */

/** A line as the builder stores it (backend default_quotation / catalog_item). */
export interface Line extends QuotationLine {
  spec?: string | null;
  price_unit?: string | null;
  /** Priced inside another line or the contract value: prints "Included". */
  included?: boolean;
  /** Offered separately; kept out of the total in this editor. */
  optional?: boolean;
  catalog_id?: string | null;
}

export interface Term {
  key: string;
  label: string;
  text: string | null;
}

export type TermDecision = "accept" | "retain" | "clarify";
export type TermChangeStatus = "pending" | "accepted" | "retained" | "clarification";

/**
 * A term wording the customer asked for (detected in their mail). It is a request, not part of the
 * quotation, until a person accepts it; only "accepted" changes the agreed text in `data.terms`.
 */
export interface TermChange {
  key: string;
  label?: string;
  /** Template wording. */
  from?: string | null;
  /** Customer-requested wording. */
  to?: string | null;
  /** Who detected it: "rules" or "mcp:<model>". */
  by?: string;
  evidence?: Evidence | null;
  enquiry_id?: string | null;
  /** Older drafts have no status: treat as "pending". */
  status?: TermChangeStatus | string;
  decided_by?: string | null;
  decided_at?: string | null;
  /** e.g. "AA/26/0118 v1". */
  revision?: string | null;
  reason?: string | null;
  detected_at?: string | null;
}

/** Unknown future codes are shown by their message. */
export type BlockerCode = "review_required" | "impact_review" | "prices_missing" | "quantities_missing" | "terms_pending";

/** One unmet condition for final approval (GET /quotations/{id}; the approve endpoint refuses with the same codes). */
export interface ApprovalBlocker {
  code: BlockerCode | string;
  message: string;
}

export interface ChangeRequest {
  by?: string;
  at?: string;
  note?: string;
  items?: unknown[];
}

export interface Photo {
  path?: string;
  caption?: string;
  placement?: "annex" | { page?: number; x_mm?: number; y_mm?: number; width_mm?: number; mode?: string } | string;
}

export interface StampPlacement {
  x_mm?: number | null;
  y_mm?: number | null;
  width_mm?: number | null;
  show?: boolean;
}

export interface StampSettings extends StampPlacement {
  show?: boolean;
  default?: StampPlacement;
  pages?: Record<string, StampPlacement>;
}

export interface Addressee {
  company?: string | null;
  attention?: string | null;
  address?: string | null;
  email?: string | null;
  phone?: string | null;
}

/** quotation.data, as far as the editor reads it. */
export interface QuotationData {
  reference?: string;
  date?: string | null;
  language?: string;
  template_key?: string;
  to?: Addressee;
  project_name?: string | null;
  subject?: string | null;
  tender_no?: string | null;
  enquiry_ref?: string | null;
  intro?: string | string[] | null;
  variables?: Record<string, string>;
  items?: Line[];
  currency?: string;
  price_unit?: string | null;
  terms?: Term[];
  term_changes?: TermChange[];
  exclusions?: string[];
  notes?: string | null;
  show_total?: boolean;
  stamp?: StampSettings;
  clarifications?: unknown[];
  paper_id?: string | null;
  photos?: Photo[];
  signatory_initials?: string | null;
  [k: string]: unknown;
}

export interface AssetsStatus {
  paper_id?: string;
  paper_name?: string | null;
  paper_found?: boolean;
  mode?: string;
  header?: string;
  footer?: string;
  watermark?: string;
  stamp?: string;
  signature?: string;
  signature_initials?: string | null;
  letterhead_installed?: boolean;
  warnings?: string[];
  [k: string]: unknown;
}

export interface Quote extends OmitKnown<Quotation, "data" | "missing_prices" | "assets_status" | "change_requests"> {
  data: QuotationData;
  missing_prices: (number | string)[];
  assets_status: AssetsStatus;
  change_requests: ChangeRequest[];
  /** Present when the backend puts the blockers on the quotation itself. */
  approval_blockers?: ApprovalBlocker[];
}

export interface QuoteListItem extends Quote {
  project: { id: string; name: string; service_family: string } | null;
  customer: { id: string; name: string } | null;
}

export interface QuoteList {
  items: QuoteListItem[];
  counts: Record<string, number>;
}

export interface SendDefaults {
  to: string[];
  subject: string;
  body: string;
}

export interface QuoteDetail {
  quotation: Quote;
  project: Project | null;
  enquiry: Enquiry | null;
  customer: Customer | null;
  signatory: Signatory | null;
  approvals: Approval[];
  send_defaults: SendDefaults;
  /** Unmet conditions for final approval; empty = approval possible. Missing on older backends. */
  approval_blockers?: ApprovalBlocker[];
}

export interface SendResult {
  draft_id: string | null;
  sent: boolean;
}

export interface ApprovalQueue {
  pending: (Quote & { project: Project | null })[];
  history: Approval[];
}

export interface TemplateColumn {
  key: string;
  label: string;
}

export interface TemplateCopy {
  salutation: string;
  intro: string[];
  table_title: string;
  terms_title: string;
  scope: string[];
  closing: string[];
  signoff: string;
  subject: string;
  columns: TemplateColumn[];
  terms: Term[];
  exclusions: string[];
  price_units: string[];
  default_price_unit: string;
  total_label: string | null;
}

export interface TemplateOverrides {
  intro?: string | null;
  terms?: Term[] | null;
  exclusions?: string[] | null;
  price_unit?: string | null;
  closing?: string | null;
}

export interface TemplateSettingRow {
  id: string;
  key: string;
  language: string;
  enabled: boolean;
  overrides: TemplateOverrides;
  applies_to: Record<string, unknown>;
  updated_at: string;
}

export interface TemplateInfo {
  key: string;
  label: Record<string, string>;
  languages: string[];
  applies_to: { service_families?: string[]; work_types?: string[]; request_kinds?: string[] };
  builder_type: string;
  builder_ids: Record<string, string>;
  layout: "letter" | "purpose" | string;
  show_total: boolean;
  variables: { key: string; label: Record<string, string>; hint: string }[];
  copy: Record<string, TemplateCopy>;
  settings: Record<string, TemplateSettingRow | null>;
}

export interface SignatoryRow extends Signatory {
  has_signature_image: boolean;
}

export interface Paper {
  id: string;
  name: string;
  mode: "letterhead" | "preprinted" | string;
  company_name: string | null;
  languages: string[];
  source: string;
  files: { header?: boolean; footer?: boolean; stamp?: boolean; watermark?: boolean };
  complete: boolean;
  warnings: string[];
}

export interface PaperList {
  items: Paper[];
  default: string | null;
}

export type LetterheadAsset = "header" | "footer" | "stamp" | "watermark";

export interface LetterheadStatus {
  assets: Record<LetterheadAsset, string | null>;
  private_dir: string;
  complete: boolean;
}

export interface PriceHint {
  year?: number | string;
  amount: number;
  currency: string;
  unit?: string;
  unit_label?: string;
  transaction?: string;
  context?: string;
  text: string;
}

export interface CatalogItem {
  product_id: string;
  family: string;
  description: string;
  spec: string | null;
  unit: string;
  price_unit: string | null;
  transactions: string[];
  score: number;
  price_hint: PriceHint | null;
}

export type Box = [number, number, number, number];

export interface SignatureDetection {
  signature: Box | null;
  stamp: Box | null;
  confidence: number;
  notes: string[];
  ink_pixels: number;
  size: [number, number];
}

export interface ProjectDetail {
  project: Project;
  customer: Customer | null;
  enquiries: (Enquiry & { customer: Customer | null })[];
  quotations: Quotation[];
  review: Review | null;
  [k: string]: unknown;
}

export interface ProjectSummary {
  id: string;
  name: string;
  code?: string;
  service_family: string;
  work_type?: string;
  request_kind?: string;
  /** GET /projects returns the customer as {id, name}. */
  customer?: { id: string; name: string } | null;
  stage?: string;
  due_date?: string | null;
  [k: string]: unknown;
}

/* ------------------------------------------------------------------ constants */

export const ALL_STATUSES = "draft,needs_review,changes_requested,approved,sent,superseded";

/* ------------------------------------------------------------------ queries */

export type ListParams = { status?: string; project_id?: string };

export function useQuotations(params: ListParams = {}, enabled = true) {
  return useQuery({
    queryKey: ["quotations", params],
    queryFn: () => api.get<QuoteList>("/quotations", params),
    enabled,
  });
}

export function useQuotation(id: string | undefined) {
  return useQuery({
    queryKey: ["quotation", id],
    queryFn: () => api.get<QuoteDetail>(`/quotations/${id}`),
    enabled: Boolean(id),
  });
}

export function useApprovals() {
  return useQuery({ queryKey: ["approvals"], queryFn: () => api.get<ApprovalQueue>("/approvals") });
}

export function useTemplates() {
  return useQuery({ queryKey: ["templates"], queryFn: () => api.get<TemplateInfo[]>("/templates"), staleTime: 300_000 });
}

export function useTemplateRules() {
  return useQuery({ queryKey: ["template-rules"], queryFn: () => api.get<TemplateRule[]>("/template-rules") });
}

export function useSignatories() {
  return useQuery({ queryKey: ["signatories"], queryFn: () => api.get<SignatoryRow[]>("/signatories"), staleTime: 60_000 });
}

export function usePapers() {
  return useQuery({ queryKey: ["papers"], queryFn: () => api.get<PaperList>("/papers"), staleTime: 60_000 });
}

export function useLetterhead() {
  return useQuery({ queryKey: ["letterhead"], queryFn: () => api.get<LetterheadStatus>("/letterhead") });
}

export function useCatalog(q: string, opts: { language?: string; transaction?: string; limit?: number; enabled?: boolean } = {}) {
  const { enabled = true, ...rest } = opts;
  const params = { language: rest.language ?? "en", transaction: rest.transaction, limit: rest.limit ?? 50 };
  return useQuery({
    queryKey: ["catalog", q, params],
    queryFn: () => api.get<{ items: CatalogItem[] }>("/catalog", { q, ...params }),
    enabled,
    staleTime: 60_000,
  });
}

export function useProject(id: string | null | undefined) {
  return useQuery({
    queryKey: ["project", id],
    queryFn: () => api.get<ProjectDetail>(`/projects/${id}`),
    enabled: Boolean(id),
  });
}

export function useProjects(enabled = true) {
  return useQuery({
    queryKey: ["projects", {}],
    queryFn: () => api.get<Paged<ProjectSummary>>("/projects"),
    enabled,
  });
}

export function useCustomers(enabled = true) {
  return useQuery({
    queryKey: ["customers", {}],
    queryFn: () => api.get<Paged<Customer>>("/customers"),
    enabled,
    staleTime: 60_000,
  });
}

export function useTemplateLessons() {
  return useQuery({
    queryKey: ["learning", { kind: "template_choice" }],
    queryFn: () => api.get<{ items: Lesson[]; summary: Record<string, unknown> }>("/learning", { kind: "template_choice" }),
  });
}

/** Invalidate several query keys (prefix match) after a mutation. */
export function useInvalidate() {
  const qc = useQueryClient();
  return useCallback(
    (...keys: QueryKey[]) => Promise.all(keys.map((queryKey) => qc.invalidateQueries({ queryKey }))),
    [qc],
  );
}

/** Keys touched by anything that changes a quotation's status or content. */
export function quoteKeys(id: string, projectId?: string | null): QueryKey[] {
  const keys: QueryKey[] = [["quotation", id], ["quotations"], ["approvals"], ["dashboard"]];
  if (projectId) keys.push(["project", projectId]);
  return keys;
}

/** After a mutation that returns the public quotation: show it at once, then refetch what it touches. */
export function useQuoteUpdated() {
  const qc = useQueryClient();
  return useCallback(
    async (q: Quote) => {
      qc.setQueryData<QuoteDetail>(["quotation", q.id], (d) => (d ? { ...d, quotation: { ...d.quotation, ...q } } : d));
      await Promise.all(quoteKeys(q.id, q.project_id).map((queryKey) => qc.invalidateQueries({ queryKey })));
    },
    [qc],
  );
}

/** Absolute URL of the quotation PDF (served inline by the local backend). */
export function pdfUrl(id: string, version?: string | null): string {
  return `/api/quotations/${encodeURIComponent(id)}/pdf${version ? `?v=${encodeURIComponent(version)}` : ""}`;
}
