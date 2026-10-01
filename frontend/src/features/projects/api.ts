/**
 * Projects: response shapes (narrowed from backend/ess/api/projects.py, workspace.py, learning.py)
 * and the query hooks / mutation helper every screen in this folder shares.
 */
import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
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
  /** For a file inside a ZIP: its path in the archive ("Tender/Drawings-and-specs.pdf"). */
  source?: string | null;
}

/* ------------------------------------------------------------------ background work */

/** GET /api/projects/{id}/work: what is still running for a project. */
export interface ProjectWork {
  attachments: boolean;
  /** Ids of the links being downloaded. */
  downloads: string[];
  extracting: boolean;
  analyzing: boolean;
  busy: boolean;
}

/**
 * Downloads, reading files and the analysis run in the background for as long as they need. The
 * work status is asked for every few seconds while something runs and the project is refreshed with
 * it; when nothing runs any more the polling stops and the project is refreshed one last time.
 */
const WORK_POLL_MS = 3_000;
const PROJECT_POLL_MS = 5_000;

const workKey = (id: string | undefined) => ["project-work", id] as const;

/** When each project was first seen busy: how long it has been working. */
const busySince = new Map<string, number>();
/** When a project was last refreshed because its work ended (several screens watch the same project). */
const refreshedAfterWork = new Map<string, number>();

/** What a finished piece of work changes. */
const afterWorkKeys = (projectId: string): QueryKey[] => [
  ["project", projectId],
  ["file"],
  ["projects"],
  ["dashboard"],
  ["notifications"],
  ["quotations"],
];

export function useProjectWork(projectId: string | undefined) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: workKey(projectId),
    queryFn: async () => {
      const work = await api.get<ProjectWork>(`/projects/${encodeURIComponent(projectId ?? "")}/work`);
      if (projectId) {
        if (!work.busy) busySince.delete(projectId);
        else if (!busySince.has(projectId)) busySince.set(projectId, Date.now());
      }
      return work;
    },
    enabled: !!projectId,
    staleTime: 0,
    refetchInterval: (q) => (q.state.data?.busy ? WORK_POLL_MS : false),
  });

  // busy -> idle: the work is over, so show what it did
  const busy = query.data?.busy;
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (projectId && wasBusy.current && busy === false && Date.now() - (refreshedAfterWork.get(projectId) ?? 0) > 2_000) {
      refreshedAfterWork.set(projectId, Date.now());
      for (const queryKey of afterWorkKeys(projectId)) void qc.invalidateQueries({ queryKey });
    }
    wasBusy.current = busy;
  }, [busy, projectId, qc]);

  /** Manual refresh: the project and the work status, whatever they say. */
  const refresh = useCallback(async () => {
    if (!projectId) return;
    await Promise.all([workKey(projectId), ...afterWorkKeys(projectId)].map((queryKey) => qc.invalidateQueries({ queryKey })));
  }, [projectId, qc]);

  return {
    work: query.data,
    /** Timestamp of the last answer (0 before the first). */
    checkedAt: query.dataUpdatedAt,
    /** When the work that is running now was first seen. */
    since: busy && projectId ? (busySince.get(projectId) ?? null) : null,
    failed: query.isError,
    refresh,
  };
}

/** Fallback when the work status cannot be read: what the project itself says is running. */
function looksBusy(d: ProjectDetail | undefined): boolean {
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
  const { work, failed } = useProjectWork(id);
  return useQuery({
    queryKey: ["project", id],
    queryFn: () => api.get<ProjectDetail>(`/projects/${encodeURIComponent(id ?? "")}`),
    enabled: !!id,
    refetchInterval: (q) => (work?.busy || (failed && looksBusy(q.state.data)) ? PROJECT_POLL_MS : false),
  });
}

export function useProjectQuotations(projectId: string) {
  return useQuery({
    queryKey: ["quotations", { project_id: projectId }],
    queryFn: () => api.get<{ items: QuotationRow[] }>("/quotations", { project_id: projectId }),
  });
}

export function useFile(id: string | undefined) {
  return useQuery({
    queryKey: ["file", id],
    queryFn: () => api.get<ProjectFile>(`/files/${encodeURIComponent(id ?? "")}`),
    enabled: !!id,
  });
}

export function useFileText(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["file", id, "text"],
    queryFn: () => api.get<{ text: string }>(`/files/${encodeURIComponent(id ?? "")}/text`),
    enabled: !!id && enabled,
    staleTime: 60_000,
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

/**
 * Keys to refresh after a change to one project. The work status is one of them: a change often
 * starts a background job, and the screen then waits for it.
 */
export function projectKeys(projectId?: string, extra: QueryKey[] = []): QueryKey[] {
  return [
    ...(projectId ? ([["project", projectId], workKey(projectId)] as QueryKey[]) : []),
    ["projects"],
    ["dashboard"],
    ["notifications"],
    ...extra,
  ];
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
