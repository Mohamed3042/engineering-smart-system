/**
 * Customers: data access and mutations. Shapes follow backend/ess/api/customers.py; JSON columns
 * (tag evidence, opportunity evidence, research sections) are narrowed here because their real
 * shape differs from the shared Evidence type.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import type {
  Automation,
  Contact,
  Customer,
  CustomerTag,
  CustomerUpdate,
  Enquiry,
  Lesson,
  Opportunity,
  ResearchReport,
  OmitKnown,
} from "@/api/types";

/* ------------------------------------------------------------------ shapes */

export interface CustomerRow extends Customer {
  /** Suggested services not yet accepted or dismissed. */
  opportunities: number;
}

/** GET /api/customers: one page, filtered and sorted in SQL. */
export interface CustomerList {
  items: CustomerRow[];
  /** Companies matching the filters, over all pages. */
  total: number;
  page: number;
  page_size: number;
  /** [tag label, number of companies] over everything that matches (top 100), not just this page. */
  tags: [string, number][];
}

export interface CustomerProjectRef {
  id: string;
  name: string;
  service_family: string;
  stage: string;
  due_date: string | null;
}

export interface CustomerQuotationRef {
  id: string;
  reference: string;
  status: string;
  project_id: string;
}

export interface CustomerEmailRef {
  id: string;
  subject: string;
  date: string | null;
  category: string;
  from_email: string;
}

export interface CustomerDetail {
  customer: Customer;
  contacts: Contact[];
  enquiries: Enquiry[];
  projects: CustomerProjectRef[];
  quotations: CustomerQuotationRef[];
  emails: CustomerEmailRef[];
  opportunities: Opportunity[];
  research: ResearchReport | null;
  updates: CustomerUpdate[];
}

/** Evidence on a tag, as tagging.py writes it: {quote, source: email|project|rules|mail, ref, date}. */
export interface TagEvidence {
  quote?: string;
  source?: string;
  ref?: string | null;
  date?: string | null;
}

export interface Tag extends OmitKnown<CustomerTag, "evidence"> {
  tag: string;
  kind?: string;
  key?: string;
  confidence?: number;
  evidence?: TagEvidence[];
  source?: string; // auto | user | scan
  service_key?: string;
  offered?: boolean;
  subtype?: boolean;
}

/** Why a service was suggested (opportunities.py): adjacency to a service they asked for, their role, their sectors. */
export interface OpportunityReason {
  kind: "adjacency" | "adjacency_reverse" | "customer_kind" | "project_type" | string;
  from?: string;
  reason?: string;
  basis?: TagEvidence | null;
  sector?: string;
  customer_kind?: string;
}

export interface ResearchSource {
  url: string;
  quote: string;
  retrieved_at?: string;
  title?: string;
  kind?: string; // official | registry | news | directory | own_email | internal | other
  verification?: string; // page | snippet | own_email
  published?: string;
  date?: string | null;
}

export interface ResearchClaim {
  text: string;
  sources: ResearchSource[];
  confidence: number;
  meets_standard: boolean;
  independent_sources: number;
  fact?: string;
  derived?: boolean;
  origin?: string;
  needs?: string;
}

export interface ResearchSection {
  status: "found" | "partial" | "not_found" | string;
  claims: ResearchClaim[];
}

export interface ResearchGap {
  section: string | null;
  kind: string;
  message: string;
  claim?: string;
}

export function tagsOf(c: Customer): Tag[] {
  return (c.tags ?? []) as unknown as Tag[];
}

export function reasonsOf(o: Opportunity): OpportunityReason[] {
  return (o.evidence ?? []) as unknown as OpportunityReason[];
}

export function sectionsOf(r: ResearchReport): Record<string, ResearchSection> {
  return (r.sections ?? {}) as Record<string, ResearchSection>;
}

export function gapsOf(r: ResearchReport): ResearchGap[] {
  return (r.gaps ?? []) as ResearchGap[];
}

/* ------------------------------------------------------------------ queries */

export interface CustomerListParams {
  q?: string;
  kind?: string;
  tag?: string;
  status?: string;
  profile_status?: string;
  monitoring?: boolean;
  sort?: string;
  /** false includes suppliers and senders with no enquiries. */
  work_only?: boolean;
  page?: number;
  page_size?: number;
}

export function useCustomers(params: CustomerListParams) {
  return useQuery({
    queryKey: ["customers", "directory", params],
    queryFn: () => api.get<CustomerList>("/customers", { ...params }),
    placeholderData: keepPreviousData,
  });
}

export function useCustomer(id: string | undefined, opts: { refetchInterval?: number | false } = {}) {
  return useQuery({
    queryKey: ["customer", id],
    queryFn: () => api.get<CustomerDetail>(`/customers/${id}`),
    enabled: !!id,
    refetchInterval: opts.refetchInterval,
  });
}

export function useResearchHistory(customerId: string | undefined) {
  return useQuery({
    queryKey: ["research", customerId],
    queryFn: () => api.get<ResearchReport[]>(`/customers/${customerId}/research`),
    enabled: !!customerId,
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === "running") ? 4000 : false),
  });
}

export interface LessonParams {
  scope?: string;
  scope_key?: string;
  kind?: string;
}

export function useLessons(params: LessonParams, enabled = true) {
  return useQuery({
    queryKey: ["learning", params],
    queryFn: () => api.get<{ items: Lesson[] }>("/learning", { ...params }),
    enabled,
  });
}

export function useAutomationList() {
  return useQuery({
    queryKey: ["automations"],
    queryFn: () => api.get<(Automation & { last_run: unknown })[]>("/automations"),
    staleTime: 60_000,
  });
}

/* ------------------------------------------------------------------ mutations */

function useInvalidateCustomer() {
  const qc = useQueryClient();
  return (id?: string) => {
    qc.invalidateQueries({ queryKey: ["customers"] });
    qc.invalidateQueries({ queryKey: ["customer-updates"] });
    if (id) qc.invalidateQueries({ queryKey: ["customer", id] });
    else qc.invalidateQueries({ queryKey: ["customer"] });
  };
}

export interface NewCustomer {
  name: string;
  domain?: string;
  website?: string;
  kind?: string;
  country?: string;
  city?: string;
  notes?: string;
}

export function useAddCustomer() {
  const invalidate = useInvalidateCustomer();
  return useMutation({
    mutationFn: (body: NewCustomer) => api.post<Customer>("/customers", body),
    onSuccess: () => invalidate(),
  });
}

export type CustomerPatch = Partial<Pick<Customer, "name" | "domain" | "kind" | "country" | "city" | "website" | "notes" | "status" | "monitoring">> & {
  tags?: Tag[];
};

export function useUpdateCustomer(id: string) {
  const invalidate = useInvalidateCustomer();
  return useMutation({
    mutationFn: (patch: CustomerPatch) => api.patch<Customer>(`/customers/${id}`, patch),
    onSuccess: () => invalidate(id),
  });
}

export function useRetag(id: string) {
  const invalidate = useInvalidateCustomer();
  return useMutation({
    mutationFn: () => api.post<{ tags: Tag[]; opportunities: number }>(`/customers/${id}/retag`),
    onSuccess: () => invalidate(id),
  });
}

export function useRetagAll() {
  const invalidate = useInvalidateCustomer();
  return useMutation({
    mutationFn: () => api.post<{ retagged: number }>("/customers/retag-all"),
    onSuccess: () => invalidate(),
  });
}

export function useSetMonitoring(id: string) {
  const invalidate = useInvalidateCustomer();
  return useMutation({
    mutationFn: (enabled: boolean) => api.post<Customer>(`/customers/${id}/monitor`, { enabled }),
    onSuccess: () => invalidate(id),
  });
}

export type OpportunityStatus = "suggested" | "accepted" | "dismissed";

/** PATCH /opportunities/{id}: accept, dismiss, or put a suggestion back for review. */
export function useUpdateOpportunity(customerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: OpportunityStatus }) => api.patch<Opportunity>(`/opportunities/${id}`, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["customer", customerId] });
    },
  });
}

export function useStartResearch(id: string) {
  const qc = useQueryClient();
  const invalidate = useInvalidateCustomer();
  return useMutation({
    mutationFn: (body: { standard: string; monitor?: boolean }) => api.post<ResearchReport>(`/customers/${id}/research`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["research", id] });
      invalidate(id);
    },
  });
}

export function useResumeResearch(customerId: string) {
  const qc = useQueryClient();
  const invalidate = useInvalidateCustomer();
  return useMutation({
    mutationFn: (reportId: string) => api.post<ResearchReport>(`/customers/${customerId}/research/${reportId}/resume`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["research", customerId] });
      invalidate(customerId);
    },
  });
}

export function useCheckUpdates(id: string) {
  return useMutation({
    mutationFn: () => api.post<{ started: boolean }>(`/customers/${id}/updates/check`),
  });
}

export function useToggleLesson() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => api.patch<Lesson>(`/learning/${id}`, { active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["learning"] }),
  });
}
