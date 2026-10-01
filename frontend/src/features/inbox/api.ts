/**
 * Inbox data: shapes returned by backend/ess/api/inbox.py and the hooks that read and change them.
 * Mail access is read-only: nothing here sends, replies to, labels or deletes a Gmail message.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { Attachment, Category, Customer, Email, Enquiry, OmitKnown, Project } from "@/api/types";

/* ------------------------------------------------------------------ shapes */

/** GET /api/emails item: the Email row without body_text, plus small joins. */
export interface EmailListItem extends OmitKnown<Email, "body_text"> {
  project: { id: string; name: string; service_family: string } | null;
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

/** GET /api/emails/{id} */
export interface EmailDetail {
  email: Email;
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
};

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

export function useEmail(id: string) {
  return useQuery({
    queryKey: ["email", id],
    queryFn: () => api.get<EmailDetail>(`/emails/${encodeURIComponent(id)}`),
    enabled: !!id,
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

/* ------------------------------------------------------------------ writes */

/** Everything an email change can affect: lists, the detail, counts, the control center, activity. */
const MAIL_KEYS = ["emails", "email", "inbox-summary", "categories", "dashboard", "notifications"] as const;

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

export type BulkAction = { ids: string[]; action: "archive" } | { ids: string[]; action: "set_category"; category: string };

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
      api.patch<Category>(`/categories/${encodeURIComponent(key)}`, { visible }),
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

export function canUnsubscribe(e: Pick<Email, "list_unsubscribe" | "unsubscribed_at">): boolean {
  return !!e.list_unsubscribe && !e.unsubscribed_at;
}
