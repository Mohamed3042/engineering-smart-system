/**
 * Data hooks for business knowledge, learning progress, mailbox scans and learned corrections.
 * Query keys: ["knowledge", params], ["knowledge-identity"], ["knowledge-regions"],
 * ["standards-library"], ["learning", params], ["scan-jobs"], ["local-folders", path].
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import { sessionKey } from "@/api/session";
import type { KnowledgeItem, Lesson, ScanJob, SessionInfo, Workspace } from "@/api/types";
import { toast } from "@/ui";
import type { RegionDef } from "./model";

/* ------------------------------------------------------------------ knowledge items */

export interface KnowledgeList {
  items: KnowledgeItem[];
  counts: Record<string, number>;
}

export const KNOWLEDGE_ALL = ["knowledge", {}] as const;

/** All findings of the workspace (filtered on the client; a workspace holds a few hundred at most). */
export function useKnowledge() {
  return useQuery({ queryKey: KNOWLEDGE_ALL, queryFn: () => api.get<KnowledgeList>("/knowledge") });
}

function replaceItem(qc: QueryClient, item: KnowledgeItem) {
  qc.setQueryData<KnowledgeList>(KNOWLEDGE_ALL, (old) =>
    old ? { ...old, items: old.items.map((i) => (i.id === item.id ? item : i)) } : old,
  );
}

export type KnowledgePatch = Partial<
  Pick<KnowledgeItem, "label" | "label_ar" | "description" | "synonyms" | "region" | "language" | "value" | "status" | "apply_to_classification">
>;

export function useUpdateKnowledge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: KnowledgePatch }) => api.patch<KnowledgeItem>(`/knowledge/${id}`, patch),
    onSuccess: (item) => {
      replaceItem(qc, item);
      qc.invalidateQueries({ queryKey: ["knowledge"] });
      qc.invalidateQueries({ queryKey: ["knowledge-identity"] });
      // a confirmed decision is also a lesson; a finding used for sorting changes mail categories
      qc.invalidateQueries({ queryKey: ["learning"] });
      qc.invalidateQueries({ queryKey: ["categories"] });
    },
  });
}

export interface NewKnowledge {
  kind: string;
  label: string;
  key?: string;
  label_ar?: string;
  description?: string;
  synonyms?: string[];
  region?: string | null;
  language?: string | null;
}

export function useAddKnowledge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewKnowledge) => api.post<KnowledgeItem>("/knowledge", body),
    onSuccess: (item) => {
      qc.setQueryData<KnowledgeList>(KNOWLEDGE_ALL, (old) => (old ? { ...old, items: [item, ...old.items] } : old));
      qc.invalidateQueries({ queryKey: ["knowledge"] });
      qc.invalidateQueries({ queryKey: ["knowledge-identity"] });
    },
  });
}

export function useDeleteKnowledge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ deleted: string }>(`/knowledge/${id}`),
    onSuccess: (_r, id) => {
      qc.setQueryData<KnowledgeList>(KNOWLEDGE_ALL, (old) => (old ? { ...old, items: old.items.filter((i) => i.id !== id) } : old));
      qc.invalidateQueries({ queryKey: ["knowledge"] });
      qc.invalidateQueries({ queryKey: ["knowledge-identity"] });
    },
  });
}

/* ------------------------------------------------------------------ reference libraries */

export interface RegionTerm {
  term: string;
  region: string;
  language: string;
  usage: string;
}

export interface RegionConcept {
  key: string;
  canonical: string;
  category: string;
  terms: RegionTerm[];
  notes?: string;
}

export interface RegionsLibrary {
  version: number;
  regions: RegionDef[];
  concepts: RegionConcept[];
}

export function useRegions() {
  return useQuery({
    queryKey: ["knowledge-regions"],
    queryFn: () => api.get<RegionsLibrary>("/knowledge/regions"),
    staleTime: Infinity,
  });
}

export interface LibraryStandard {
  code: string;
  title: string;
  region: string[];
  applies_to: string[];
  notes?: string;
}

export function useStandardsLibrary(enabled = true) {
  return useQuery({
    queryKey: ["standards-library"],
    queryFn: () => api.get<{ version: number; standards: LibraryStandard[] }>("/knowledge/standards-library"),
    staleTime: Infinity,
    enabled,
  });
}

/* ------------------------------------------------------------------ identity & learning progress */

export interface LearningStep {
  status: string;
  detail?: string;
  at?: string;
}

export interface LearningState {
  status?: string;
  steps?: Record<string, LearningStep>;
  started_at?: string;
  finished_at?: string;
  identity_confidence?: number | null;
}

export interface PackedFinding {
  id: string;
  key: string;
  label: string;
  label_ar: string;
  status: string;
  confidence: number;
  claim_basis: string | null;
  description: string;
  evidence_count: number;
  synonyms: unknown[];
  region: string | null;
}

export interface IdentityInfo {
  company: {
    name: string;
    email: string;
    region: string;
    languages: string[];
    currency: string;
    details: Record<string, any> | null;
  };
  service_families: PackedFinding[];
  work_types: PackedFinding[];
  terms: PackedFinding[];
  standards: PackedFinding[];
  conventions: PackedFinding[];
  confirmed: number;
  total: number;
  learning: LearningState | null;
}

export const IDENTITY_KEY = ["knowledge-identity"] as const;

export type LearningPhase = "never" | "starting" | "running" | "stalled" | "done";

const STALL_MS = 30 * 60_000;
const ts = (s?: string | null) => (s ? Date.parse(s) : NaN);

/**
 * Business learning progress. The backend writes it to AppState `learning:<workspace>` and returns
 * it as `learning` on GET /api/knowledge/identity; this hook polls while it runs.
 * Steps left over from an earlier run (older than `started_at`) are ignored.
 */
export function useLearningProgress() {
  const qc = useQueryClient();
  const [requestedAt, setRequestedAt] = useState<number | null>(null);
  const query = useQuery({
    queryKey: IDENTITY_KEY,
    queryFn: () => api.get<IdentityInfo>("/knowledge/identity"),
    refetchInterval: (q) => {
      const l = q.state.data?.learning;
      if (l?.status === "running") return 1500;
      if (requestedAt && Date.now() - requestedAt < 60_000) return 1000;
      return false;
    },
  });
  const learning = query.data?.learning ?? null;

  const startedAt = ts(learning?.started_at);
  const waitingForJob = requestedAt !== null && (!learning || !(startedAt >= requestedAt - 2000)) && learning?.status !== "running";
  const steps: Record<string, LearningStep> = {};
  for (const [k, s] of Object.entries(learning?.steps ?? {})) {
    if (!(ts(s.at) < startedAt - 1000)) steps[k] = s; // keep steps of the current run only
  }
  const lastAt = Math.max(startedAt || 0, ...Object.values(steps).map((s) => ts(s.at) || 0));
  let phase: LearningPhase = "never";
  if (waitingForJob && requestedAt && Date.now() - requestedAt < 60_000) phase = "starting";
  else if (learning?.status === "running") phase = lastAt && Date.now() - lastAt > STALL_MS ? "stalled" : "running";
  else if (learning?.status === "done") phase = "done";

  // when a run finishes, load its findings
  const prev = useRef(phase);
  useEffect(() => {
    if ((prev.current === "running" || prev.current === "starting") && phase === "done") {
      qc.invalidateQueries({ queryKey: ["knowledge"] });
      qc.invalidateQueries({ queryKey: ["learning"] });
      setRequestedAt(null);
    }
    prev.current = phase;
  }, [phase, qc]);

  const start = useMutation({
    mutationFn: (body: { folders: string[]; web?: boolean }) =>
      api.post<{ started: boolean }>("/knowledge/discover", { folder_type: "auto", ...body }),
    onMutate: () => setRequestedAt(Date.now()),
    onSuccess: (res) => {
      if (!res.started) toast("Learning is already running", { description: "Progress shows below." });
      qc.invalidateQueries({ queryKey: IDENTITY_KEY });
    },
    onError: () => setRequestedAt(null),
  });

  return { query, identity: query.data, learning, steps, phase, start };
}

/* ------------------------------------------------------------------ local folders */

export interface LocalFolders {
  path: string;
  parent: string | null;
  folders: { name: string; path: string }[];
  documents_here: number;
}

export function useLocalFolders(path: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["local-folders", path],
    queryFn: () => api.get<LocalFolders>("/local-folders", { path: path ?? undefined }),
    enabled,
    staleTime: 10_000,
    retry: false,
  });
}

/* ------------------------------------------------------------------ workspace settings */

/** Saves workspace fields or a settings group (the backend merges settings one level deep). */
export function useSaveWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch<Workspace>("/workspace", patch),
    onSuccess: (ws) => {
      qc.setQueryData<SessionInfo>(sessionKey, (old) => (old ? { ...old, workspace: ws } : old));
      qc.invalidateQueries({ queryKey: sessionKey });
    },
  });
}

/** Where business learning reads company files (stored in workspace settings by this UI). */
export interface KnowledgeSources {
  folders: string[];
  web: boolean;
}

export function knowledgeSources(ws: Workspace | null | undefined): KnowledgeSources {
  const s = (ws?.settings?.knowledge_sources ?? {}) as Partial<KnowledgeSources>;
  return {
    folders: Array.isArray(s.folders) ? s.folders.filter((f): f is string => typeof f === "string" && f.length > 0) : [],
    web: Boolean(s.web),
  };
}

/* ------------------------------------------------------------------ mailbox scans */

export const SCAN_KEY = ["scan-jobs"] as const;
const scanActive = (j?: ScanJob | null) => j?.status === "queued" || j?.status === "running";

export function useScanJobs() {
  return useQuery({
    queryKey: SCAN_KEY,
    queryFn: () => api.get<ScanJob[]>("/scan/jobs"),
    refetchInterval: (q) => (q.state.data?.some((j) => scanActive(j)) ? 4000 : false),
  });
}

/** One scan job, polled while it runs. */
export function useScanJob(id: string | null | undefined) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ["scan-jobs", id],
    queryFn: async () => {
      const job = await api.get<ScanJob>(`/scan/${id}`);
      if (!scanActive(job)) qc.invalidateQueries({ queryKey: SCAN_KEY, exact: true });
      return job;
    },
    enabled: Boolean(id),
    refetchInterval: (q) => (scanActive(q.state.data) ? 1500 : false),
  });
}

export interface ScanBody {
  date_from?: string | null;
  date_to?: string | null;
  months?: number;
  include_sent?: boolean;
  max_threads?: number;
  queries?: string[];
}

export function useStartScan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ScanBody) => api.post<ScanJob>("/scan", body),
    onSuccess: (job) => {
      qc.setQueryData<ScanJob[]>(SCAN_KEY, (old) => [job, ...(old ?? []).filter((j) => j.id !== job.id)]);
      qc.invalidateQueries({ queryKey: SCAN_KEY });
    },
  });
}

/* ------------------------------------------------------------------ learned corrections */

export interface LessonSummary {
  total: number;
  active: number;
  by_kind: Record<string, number>;
  rules: number;
}

export interface LessonList {
  items: Lesson[];
  summary: LessonSummary;
}

export interface LessonParams {
  kind?: string;
  scope?: string;
}

export function useLessons(params: LessonParams) {
  return useQuery({
    queryKey: ["learning", params],
    queryFn: () => api.get<LessonList>("/learning", { kind: params.kind, scope: params.scope }),
  });
}

export function useUpdateLesson() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { active?: boolean; note?: string } }) =>
      api.patch<Lesson>(`/learning/${id}`, patch),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: ["learning"] });
      const snapshot = qc.getQueriesData<LessonList>({ queryKey: ["learning"] });
      qc.setQueriesData<LessonList>({ queryKey: ["learning"] }, (old) =>
        old ? { ...old, items: old.items.map((l) => (l.id === id ? { ...l, ...patch } : l)) } : old,
      );
      return { snapshot };
    },
    onError: (_e, _v, ctx) => ctx?.snapshot.forEach(([key, data]) => qc.setQueryData(key, data)),
    onSettled: () => qc.invalidateQueries({ queryKey: ["learning"] }),
  });
}

export function useDeleteLesson() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ deleted: string }>(`/learning/${id}`),
    onSuccess: (_r, id) => {
      qc.setQueriesData<LessonList>({ queryKey: ["learning"] }, (old) =>
        old ? { ...old, items: old.items.filter((l) => l.id !== id) } : old,
      );
      qc.invalidateQueries({ queryKey: ["learning"] });
    },
  });
}
