/**
 * Inbox data: shapes returned by backend/ess/api/inbox.py and the hooks that read and change them.
 * Mail access is read-only: nothing here sends, replies to, labels or deletes a Gmail message.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { Attachment, Category, Customer, Email, Enquiry, OmitKnown, Project, ProjectFile, ProjectLink } from "@/api/types";

/* ------------------------------------------------------------------ shapes */

/** GET /api/emails item: the Email row without body_text, plus small joins. */
export interface EmailListItem extends OmitKnown<Email, "body_text"> {
  project: { id: string; name: string; service_family: string; work_type?: string } | null;
  customer: { id: string; name: string } | null;
  category_label: string;
}

export interface EmailList {
  total: number;
  page: number;
  page_size: number;
  items: EmailListItem[];
}

export interface SummaryCategory {
  key: string;
  label: string;
  icon: string;
  visible: boolean;
  count: number;
  new: number;
}

export interface SummaryGroup {
  total: number;
  new: number;
  categories: SummaryCategory[];
}

export interface UnsubscribeCandidate {
  sender: string;
  name: string;
  count: number;
  sample_subject: string;
  email_id: string;
  can_unsubscribe: boolean;
}

/** GET /api/inbox/summary */
export interface InboxSummary {
  groups: Partial<Record<string, SummaryGroup>>;
  unsubscribe_candidates: UnsubscribeCandidate[];
  group_visibility: Record<string, boolean>;
}

/** GET /api/visibility */
export interface Visibility {
  groups: Record<string, boolean>;
  categories: Record<string, boolean>;
}

export interface ThreadMessage {
  id: string;
  from_name: string;
  from_email: string;
  date: string | null;
  subject: string;
  direction: string;
  snippet: string;
  body_text: string;
  attachments: Attachment[];
}

/**
 * GET /api/emails/{id}. `files` and `links` are what came with this message (saved attachments and
 * registered shared links, with their transfer, extraction and review state). They are optional on
 * purpose: when the server does not send them the page says "Status unavailable" instead of guessing.
 */
export interface EmailDetail {
  email: Email;
  files?: ProjectFile[];
  links?: ProjectLink[];
  enquiry?: Enquiry | null;
  thread: ThreadMessage[];
  category: Category | null;
  project: Project | null;
  customer: Customer | null;
}

export type UnsubscribeMethod = "one_click" | "link" | "mailto" | "none";

export interface UnsubscribeCheck {
  needs_confirmation: true;
  sender: string;
  method: UnsubscribeMethod;
}

export interface UnsubscribeResult {
  status: "done" | "failed" | "open_link" | "needs_mail" | "not_available";
  method: UnsubscribeMethod;
  http_status?: number;
  error?: string;
  url?: string | null;
  message?: string;
}

export type EmailQuery = {
  group?: string;
  category?: string;
  state?: string;
  q?: string;
  sort?: "newest" | "oldest";
  page?: number;
  page_size?: number;
  include_hidden?: boolean;
  thread_id?: string;
  /** Comma list of mail intents (what the message is for). */
  intent?: string;
  /** Comma list of work types of the project a message is filed under. */
  work_type?: string;
  /** Inbound mail that is not filed under a project. */
  unlinked?: boolean;
};

/** Row of GET /api/projects, as far as the project picker needs it. */
export interface ProjectChoice {
  id: string;
  code: string;
  name: string;
  service_family: string;
  stage: string;
  customer: { id: string; name: string } | null;
  due_date: string | null;
  tender_no: string | null;
  location: string | null;
  archived_at: string | null;
}

/** Body of POST /api/emails/{id}/link: file under an existing project, or open a new one from the message. */
export interface NewProjectSpec {
  name: string;
  service_family: string;
  work_type: string;
  request_kind: string;
  tender_no?: string;
  due_date?: string;
  location?: string;
}
export type LinkTarget = { project_id: string } | { create: NewProjectSpec };

export interface LinkResult {
  email: Email;
  project: Project;
  enquiry: Enquiry | null;
  created: boolean;
}

/* ------------------------------------------------------------------ reads */

export function useEmails(params: EmailQuery, enabled = true) {
  return useQuery({
    queryKey: ["emails", params],
    queryFn: () => api.get<EmailList>("/emails", params),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useInboxSummary() {
  return useQuery({ queryKey: ["inbox-summary"], queryFn: () => api.get<InboxSummary>("/inbox/summary") });
}

export function useVisibility(enabled = true) {
  return useQuery({ queryKey: ["visibility"], queryFn: () => api.get<Visibility>("/visibility"), enabled });
}

/**
 * A download runs in the background and reports no progress of its own, so after a retry the message
 * is looked at again every few seconds (and while a file or link says it is downloading).
 */
const busyUntil = new Map<string, number>();

export function markEmailBusy(id: string, ms = 45_000) {
  busyUntil.set(id, Date.now() + ms);
}

function needsPolling(id: string, d: EmailDetail | undefined): boolean {
  if ((busyUntil.get(id) ?? 0) > Date.now()) return true;
  if (!d) return false;
  return !!d.files?.some((f) => f.status === "downloading") || !!d.links?.some((l) => l.status === "downloading");
}

export function useEmail(id: string) {
  return useQuery({
    queryKey: ["email", id],
    queryFn: () => api.get<EmailDetail>(`/emails/${encodeURIComponent(id)}`),
    enabled: !!id,
    refetchInterval: (q) => (id && needsPolling(id, q.state.data) ? 2500 : false),
  });
}

export function useProjectEnquiries(projectId: string | null | undefined) {
  return useQuery({
    queryKey: ["enquiries", { project_id: projectId }],
    queryFn: () => api.get<Enquiry[]>("/enquiries", { project_id: projectId }),
    enabled: !!projectId,
    staleTime: 60_000,
  });
}

/**
 * Open (not archived) projects, for filing a message under one. Same request and cache key as the
 * project list, so the list opens at once when the Projects page was visited.
 */
export function useProjectChoices(enabled: boolean) {
  return useQuery({
    queryKey: ["projects", {}],
    queryFn: () => api.get<{ items: ProjectChoice[]; total: number }>("/projects", {}),
    enabled,
    staleTime: 15_000,
  });
}

/* ------------------------------------------------------------------ writes */

/** Everything an email change can affect: lists, the detail, counts, the control center, activity. */
const MAIL_KEYS = ["emails", "email", "inbox-summary", "categories", "dashboard", "notifications", "learning"] as const;

export function useInvalidateMail() {
  const qc = useQueryClient();
  return (extra: readonly string[] = []) =>
    Promise.all([...MAIL_KEYS, ...extra].map((k) => qc.invalidateQueries({ queryKey: [k] })));
}

export type EmailPatch = { category?: string; state?: string };

export function useUpdateEmail() {
  const invalidate = useInvalidateMail();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: EmailPatch }) =>
      api.patch<Email>(`/emails/${encodeURIComponent(id)}`, patch),
    onSettled: () => invalidate(),
  });
}

/**
 * A person files a message under a project, or opens a new project from it (POST /emails/{id}/link).
 * The whole conversation follows, with the sender's enquiry, attachments and shared links; filing
 * non-work mail also corrects its category. Everything that shows mail or projects is refreshed.
 */
export function useLinkEmail() {
  const invalidate = useInvalidateMail();
  return useMutation({
    mutationFn: ({ id, target }: { id: string; target: LinkTarget }) =>
      api.post<LinkResult>(`/emails/${encodeURIComponent(id)}/link`, target),
    onSuccess: () => invalidate(["projects", "project", "enquiries", "customers", "customer", "approvals"]),
  });
}

/**
 * Try a failed download again: POST /files/{id}/retry for an attachment (or the link it came from),
 * POST /links/{id}/retry for a shared link without files. The server starts the download in the
 * background; the message is looked at again at once and then while it runs.
 */
export function useRetryDownload(emailId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ kind, id }: { kind: "file" | "link"; id: string }) =>
      api.post<{ started: boolean }>(`/${kind === "file" ? "files" : "links"}/${encodeURIComponent(id)}/retry`),
    onSuccess: () => {
      markEmailBusy(emailId);
      qc.invalidateQueries({ queryKey: ["email", emailId] });
      qc.invalidateQueries({ queryKey: ["project"] });
      // The server needs a moment to start; look again shortly, then the page polls while it runs.
      window.setTimeout(() => qc.invalidateQueries({ queryKey: ["email", emailId] }), 1200);
    },
  });
}

/** "mark_reviewed" moves mail back to open: Linked when it has a project, else Needs review. A bulk category change teaches like a single one. */
export type BulkAction =
  | { ids: string[]; action: "archive" }
  | { ids: string[]; action: "mark_reviewed" }
  | { ids: string[]; action: "set_category"; category: string };

export function useBulkEmails() {
  const invalidate = useInvalidateMail();
  return useMutation({
    mutationFn: (body: BulkAction) => api.post<{ updated: number }>("/emails/bulk", body),
    onSettled: () => invalidate(),
  });
}

/** First call asks the backend what unsubscribing would do; nothing is contacted. */
export function useUnsubscribeCheck() {
  return useMutation({
    mutationFn: (id: string) => api.post<UnsubscribeCheck>(`/emails/${encodeURIComponent(id)}/unsubscribe`, {}),
  });
}

/** Second call, only after a person confirmed in the dialog. */
export function useUnsubscribe() {
  const invalidate = useInvalidateMail();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<UnsubscribeResult>(`/emails/${encodeURIComponent(id)}/unsubscribe`, { confirm: true }),
    onSettled: () => invalidate(),
  });
}

export function useSetGroupVisibility() {
  const qc = useQueryClient();
  const invalidate = useInvalidateMail();
  return useMutation({
    mutationFn: ({ group, visible }: { group: string; visible: boolean }) =>
      api.put<Visibility>("/visibility", { groups: { [group]: visible } }),
    onMutate: async ({ group, visible }) => {
      await qc.cancelQueries({ queryKey: ["visibility"] });
      const prev = qc.getQueryData<Visibility>(["visibility"]);
      if (prev) qc.setQueryData<Visibility>(["visibility"], { ...prev, groups: { ...prev.groups, [group]: visible } });
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["visibility"], ctx.prev);
    },
    onSettled: () => invalidate(["visibility"]),
  });
}

export function useSetCategoryVisibility() {
  const qc = useQueryClient();
  const invalidate = useInvalidateMail();
  return useMutation({
    mutationFn: ({ key, visible }: { key: string; visible: boolean }) =>
      api.put<Visibility>("/visibility", { categories: { [key]: visible } }),
    onMutate: async ({ key, visible }) => {
      await qc.cancelQueries({ queryKey: ["visibility"] });
      const prev = qc.getQueryData<Visibility>(["visibility"]);
      if (prev) qc.setQueryData<Visibility>(["visibility"], { ...prev, categories: { ...prev.categories, [key]: visible } });
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["visibility"], ctx.prev);
    },
    onSettled: () => invalidate(["visibility"]),
  });
}

/* ------------------------------------------------------------------ helpers */

/** Count the inbox shows for a group: hidden categories drop out unless the group itself is hidden
 *  (then its tab shows everything, as the backend does) or hidden mail is included. */
export function groupCount(summary: InboxSummary | undefined, group: string, includeHidden: boolean): number | undefined {
  const g = summary?.groups[group];
  if (!g) return summary ? 0 : undefined;
  const groupVisible = summary?.group_visibility[group] !== false;
  if (includeHidden || !groupVisible) return g.total;
  return g.categories.reduce((n, c) => n + (c.visible ? c.count : 0), 0);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * The addresses in a List-Unsubscribe header (RFC 2369: <https://…>, <mailto:…>). The backend only
 * ever uses the first https address (backend/ess/api/inbox.py _first_https).
 */
export function parseUnsubscribe(header: string | null | undefined): { https: string | null; mailto: string | null } {
  const parts = (header ?? "").split(",").map((p) => p.trim().replace(/^<|>$/g, ""));
  return {
    https: parts.find((p) => p.startsWith("https://")) ?? null,
    mailto: parts.find((p) => p.toLowerCase().startsWith("mailto:")) ?? null,
  };
}

export function canUnsubscribe(e: Pick<Email, "list_unsubscribe" | "unsubscribed_at">): boolean {
  return !!e.list_unsubscribe && !e.unsubscribed_at;
}
