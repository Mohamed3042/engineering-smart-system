/**
 * Projects: response shapes (narrowed from backend/ess/api/projects.py, workspace.py, learning.py)
 * and the query hooks / mutation helper every screen in this folder shares.
 */
import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api } from "@/api/client";
import type {
  Activity,
  Blocker,
  Customer,
  Email,
  Enquiry,
  NextAction,
  Project,
  ProjectChange,
  ProjectFile,
  ProjectLink,
  Quotation,
  Review,
  TeamMember,
  TemplateRule,
} from "@/api/types";
import { toast, toastError } from "@/ui";

/* ------------------------------------------------------------------ shapes */

/** Row of GET /api/projects. */
export interface ProjectSummary {
  id: string;
  code: string;
  ref: string;
  name: string;
  service_family: string;
  work_type: string;
  request_kind: string;
  stage: string;
  stage_label: string;
  review_status: string;
  customer: { id: string; name: string } | null;
  due_date: string | null;
  priority: string;
  tender_no: string | null;
  location: string | null;
  next_action: NextAction;
  blockers: Blocker[];
  open_changes: ProjectChange[];
  owner: { id: string; name: string; initials: string } | null;
  enquiries: number;
  bucket: string;
  updated_at: string;
  archived_at: string | null;
  status_note?: string;
}

export interface ProjectList {
  items: ProjectSummary[];
  total: number;
  by_service_family: Record<string, number>;
}

/** Emails in the project detail come without their body (body_text is absent). */
export type DetailEmail = Email;

export interface EnquiryRow extends Enquiry {
  customer: Customer | null;
}

/** Timeline entries written by the mailbox scan. */
export interface TimelineEntry {
  date?: string;
  title?: string;
  detail?: string;
  [k: string]: unknown;
}

/** GET /api/projects/{id}. */
export interface ProjectDetail {
  project: Project;
  stage_label: string;
  bucket: string;
  customer: Customer | null;
  owner: TeamMember | null;
  enquiries: EnquiryRow[];
  emails: DetailEmail[];
  files: ProjectFile[];
  links: ProjectLink[];
  quotations: Quotation[];
  review: Review | null;
  /** Every review round, newest first (superseded rounds included). */
  reviews: Review[];
  activity: Activity[];
  related: { id: string; name: string; service_family: string; stage: string }[];
}

export interface CustomerOption {
  id: string;
  name: string;
}

export interface TemplateInfo {
  key: string;
  label: { en?: string; ar?: string } | string;
  languages?: string[];
  applies_to?: { work_types?: string[]; service_families?: string[]; request_kinds?: string[] };
  [k: string]: unknown;
}

/** project.analysis as written by backend/ess/pipeline/analysis.py. */
export interface ProjectAnalysis {
  status?: "running" | "done" | "failed" | string;
  started_at?: string;
  ran_at?: string;
  by?: string;
  error?: string;
  notes?: string[];
  stats?: { files?: number; engine?: string; drawing_pages?: number };
}

/** Row of GET /api/quotations (the quotation plus its customer). */
export interface QuotationRow extends Quotation {
  customer: { id: string; name: string } | null;
}

/** One BOQ row read from a file (file.extraction.boq_relevant, backend/ess/documents/boq.py). */
export interface BoqRow {
  ref?: string | null;
  description?: string;
  qty?: number | null;
  qty_text?: string;
  unit?: string | null;
  section?: string | null;
  row?: number;
  sheet?: string;
  page?: number;
}

/* ------------------------------------------------------------------ polling */

/** The server remains authoritative for jobs that outlast the initial request. */
const busyUntil = new Map<string, number>();

export interface ProjectWork {
  attachments: boolean;
  downloads: string[];
  extracting: boolean;
  analyzing: boolean;
  busy: boolean;
}

export function markBusy(projectId: string, ms = 45_000) {
  busyUntil.set(projectId, Date.now() + ms);
}

function needsPolling(id: string, d: ProjectDetail | undefined): boolean {
  if ((busyUntil.get(id) ?? 0) > Date.now()) return true;
  if (!d) return false;
  if ((d.project.analysis as { status?: string } | undefined)?.status === "running") return true;
  if (d.links.some((l) => l.status === "approved" || l.status === "downloading")) return true;
  return d.files.some((f) => f.status === "downloading");
}

/* ------------------------------------------------------------------ queries */

export function useProjectList(params: { include_archived?: boolean } = {}) {
  return useQuery({
    queryKey: ["projects", params],
    queryFn: () => api.get<ProjectList>("/projects", params),
  });
}

export function useProject(id: string | undefined) {
  const work = useProjectWork(id);
  const qc = useQueryClient();
  const previouslyBusy = useRef(false);
  useEffect(() => {
    if (!work.data) return;
    if (previouslyBusy.current && !work.data.busy) {
      void qc.invalidateQueries({ queryKey: ["project", id] });
      void qc.invalidateQueries({ queryKey: ["file"] });
    }
    previouslyBusy.current = work.data.busy;
  }, [work.data, id, qc]);
  return useQuery({
    queryKey: ["project", id],
    queryFn: () => api.get<ProjectDetail>(`/projects/${encodeURIComponent(id ?? "")}`),
    enabled: !!id,
    // Continue checking while this project is open, including the final result after a job stops.
    refetchInterval: (q) => (id && (work.data?.busy || needsPolling(id, q.state.data)) ? 2500 : 15_000),
  });
}

export function useProjectWork(id: string | undefined) {
  return useQuery({
    queryKey: ["project-work", id],
    queryFn: () => api.get<ProjectWork>(`/projects/${encodeURIComponent(id ?? "")}/work`),
    enabled: !!id,
    refetchInterval: (q) => q.state.data?.busy || (id && (busyUntil.get(id) ?? 0) > Date.now()) ? 2500 : 15_000,
  });
}

export function useProjectQuotations(projectId: string) {
  return useQuery({
    queryKey: ["quotations", { project_id: projectId }],
    queryFn: () => api.get<{ items: QuotationRow[] }>("/quotations", { project_id: projectId }),
  });
}

export function useFile(id: string | undefined) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ["file", id],
    queryFn: () => api.get<ProjectFile>(`/files/${encodeURIComponent(id ?? "")}`),
    enabled: !!id,
    refetchInterval: (q) => {
      const f = q.state.data;
      const work = f ? qc.getQueryData<ProjectWork>(["project-work", f.project_id]) : undefined;
      return work?.busy || f?.status === "downloading" ? 2500 : 15_000;
    },
  });
}

export function useFileText(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["file", id, "text"],
    queryFn: () => api.get<{ text: string }>(`/files/${encodeURIComponent(id ?? "")}/text`),
    enabled: !!id && enabled,
    staleTime: 60_000,
    refetchInterval: (q) => !q.state.data?.text.trim() ? 15_000 : false,
  });
}

export function useTemplates() {
  return useQuery({ queryKey: ["templates"], queryFn: () => api.get<TemplateInfo[]>("/templates"), staleTime: 300_000 });
}

export function useTemplateRules() {
  return useQuery({ queryKey: ["template-rules"], queryFn: () => api.get<TemplateRule[]>("/template-rules") });
}

export function useCustomerOptions(enabled: boolean) {
  return useQuery({
    queryKey: ["customers", { work_only: true, sort: "name" }],
    queryFn: () => api.get<{ items: CustomerOption[] }>("/customers", { work_only: true, sort: "name" }),
    enabled,
    staleTime: 60_000,
  });
}

export function useTeam(enabled = true) {
  return useQuery({ queryKey: ["team"], queryFn: () => api.get<TeamMember[]>("/team"), enabled, staleTime: 300_000 });
}

/* ------------------------------------------------------------------ mutations */

/** Keys to refresh after a change to one project. */
export function projectKeys(projectId?: string, extra: QueryKey[] = []): QueryKey[] {
  return [...(projectId ? [["project", projectId] as QueryKey, ["project-work", projectId] as QueryKey] : []), ["projects"], ["dashboard"], ["notifications"], ...extra];
}

export interface ProjectMutationOptions<TVars, TResult> {
  /** Project whose views refresh afterwards. */
  projectId?: string;
  /** Additional query keys to refresh (quotations, enquiries, file, review…). */
  invalidate?: QueryKey[] | ((result: TResult, vars: TVars) => QueryKey[]);
  /** Success toast. */
  success?: string | ((result: TResult, vars: TVars) => string | null) | null;
  onSuccess?: (result: TResult, vars: TVars) => void;
  /** Toast errors (default). Turn off when the screen shows the error inline. */
  toastErrors?: boolean;
  errorTitle?: string;
}

/** useMutation with the folder's invalidation and toast rules. */
export function useProjectMutation<TVars = void, TResult = unknown>(
  fn: (vars: TVars) => Promise<TResult>,
  opts: ProjectMutationOptions<TVars, TResult> = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (result, vars) => {
      const extra = typeof opts.invalidate === "function" ? opts.invalidate(result, vars) : (opts.invalidate ?? []);
      await Promise.all(projectKeys(opts.projectId, extra).map((queryKey) => qc.invalidateQueries({ queryKey })));
      const msg = typeof opts.success === "function" ? opts.success(result, vars) : opts.success;
      if (msg) toastSuccess(msg);
      opts.onSuccess?.(result, vars);
    },
    onError: (err) => {
      if (opts.toastErrors !== false) toastError(err, opts.errorTitle);
    },
  });
}

export function toastSuccess(message: string, description?: string) {
  toast.success(message, description ? { description } : undefined);
}
