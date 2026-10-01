/**
 * Automations: shapes from backend/ess/api/automations.py and the hooks that read and change them.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { Automation, AutomationRun, AutomationRunStep, OmitKnown } from "@/api/types";

/** A run's steps also carry the step type, its gate flag and who approved it (runner.py start_run / resume_run). */
export interface RunStep extends AutomationRunStep {
  type?: string;
  requires_approval?: boolean;
  approved_by?: string;
}

export interface Run extends OmitKnown<AutomationRun, "steps"> {
  steps: RunStep[];
}

/**
 * How a workflow really starts on this installation right now (backend/ess/automations/runner.py
 * trigger_status): never more than the truth. `automatic` is false for "Manual — Run now", for a
 * workflow that is switched off, and for one the workspace has paused.
 */
export interface TriggerStatus {
  mode: "automatic" | "manual" | "off" | "paused" | string;
  automatic: boolean;
  label: string;
  /** Why: "Background runs are off: the server was started without the scheduler." */
  detail?: string;
  next_run_at?: string;
}

/** GET /api/automations: each row carries its latest run and how it starts. */
export interface AutomationRow extends Automation {
  last_run: Run | null;
  trigger_status?: TriggerStatus;
  /** Built-in workflows can be switched off but not deleted. */
  built_in?: boolean;
}

/** GET /api/automations/{id}: the workflow, its 30 newest runs and how it starts. */
export interface AutomationDetail {
  automation: Automation;
  runs: Run[];
  trigger_status?: TriggerStatus;
  built_in?: boolean;
}

/** One setting of a step, as GET /api/automations/step-catalog describes it. */
export interface CatalogConfig {
  key: string;
  label: string;
  type: "number" | "text" | "boolean" | string;
  default?: unknown;
}

/** A step type a person can add to a workflow, with plain words. `locked` steps keep their human gate. */
export interface CatalogStep {
  type: string;
  label: string;
  description: string;
  config?: CatalogConfig[];
  locked?: boolean;
}

/** GET /api/runs/{id} */
export interface RunDetail {
  run: Run;
  automation: Automation | null;
}

const isRunning = (r?: { status: string } | null) => r?.status === "running";

export function useAutomations() {
  return useQuery({
    queryKey: ["automations"],
    queryFn: () => api.get<AutomationRow[]>("/automations"),
    refetchInterval: (q) => (q.state.data?.some((a) => isRunning(a.last_run)) ? 3000 : false),
  });
}

export function useAutomation(id: string) {
  return useQuery({
    queryKey: ["automation", id],
    queryFn: () => api.get<AutomationDetail>(`/automations/${encodeURIComponent(id)}`),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data?.runs.some(isRunning) ? 3000 : false),
  });
}

/** `waitingFor`: the gate a person just approved; the run is polled until it moves past it. */
export function useRun(id: string, waitingFor: string | null) {
  return useQuery({
    queryKey: ["run", id],
    queryFn: () => api.get<RunDetail>(`/runs/${encodeURIComponent(id)}`),
    enabled: !!id,
    refetchInterval: (q) => {
      const run = q.state.data?.run;
      if (!run) return false;
      if (isRunning(run)) return 2000;
      const gate = run.steps.find((s) => s.status === "waiting_approval");
      return waitingFor && gate?.key === waitingFor ? 1500 : false;
    },
  });
}

function useInvalidateAutomations() {
  const qc = useQueryClient();
  return (id?: string, runId?: string) => {
    qc.invalidateQueries({ queryKey: ["automations"] });
    qc.invalidateQueries({ queryKey: id ? ["automation", id] : ["automation"] });
    if (runId) qc.invalidateQueries({ queryKey: ["run", runId] });
  };
}

/** PATCH /automations/{id}: needs the admin role. */
export function useToggleAutomation() {
  const invalidate = useInvalidateAutomations();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.patch<Automation>(`/automations/${encodeURIComponent(id)}`, { enabled }),
    onSuccess: (_a, v) => invalidate(v.id),
  });
}

export function useStepCatalog() {
  return useQuery({
    queryKey: ["automation-step-catalog"],
    queryFn: () => api.get<CatalogStep[]>("/automations/step-catalog"),
    staleTime: 5 * 60_000,
  });
}

/** A step as the server takes it. A step that was already in the workflow keeps its `key`; a new one has none. */
export interface StepPayload {
  key?: string;
  type: string;
  label: string;
  enabled: boolean;
  requires_approval: boolean;
  config: Record<string, unknown>;
}

export interface WorkflowPayload {
  name: string;
  description: string;
  trigger: "manual" | "schedule" | "new_email";
  /** Minutes, at least 15; null unless the workflow runs on a schedule. */
  interval_minutes: number | null;
  steps: StepPayload[];
  enabled?: boolean;
}

/** POST /automations: needs the admin role. Errors (name_required, steps_required, bad_step, bad_trigger) come back with a message. */
export function useCreateAutomation() {
  const invalidate = useInvalidateAutomations();
  return useMutation({
    mutationFn: (body: WorkflowPayload) => api.post<Automation>("/automations", body),
    onSuccess: (a) => invalidate(a.id),
  });
}

/** PATCH /automations/{id}: name, description, trigger, interval and the whole step list. The engineer review step is always kept on by the server. */
export function useUpdateAutomation(id: string) {
  const invalidate = useInvalidateAutomations();
  return useMutation({
    mutationFn: (body: Partial<WorkflowPayload>) => api.patch<Automation>(`/automations/${encodeURIComponent(id)}`, body),
    onSuccess: () => invalidate(id),
  });
}

/** DELETE /automations/{id}: custom workflows only (409 built_in otherwise). */
export function useDeleteAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ deleted: boolean }>(`/automations/${encodeURIComponent(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["automations"] }),
  });
}

/** POST /automations/{id}/run: starts a run in the background and returns its id. */
export function useRunNow(id: string) {
  const invalidate = useInvalidateAutomations();
  return useMutation({
    mutationFn: () => api.post<{ run_id: string }>(`/automations/${encodeURIComponent(id)}/run`),
    onSuccess: () => invalidate(id),
  });
}

/** POST /runs/{id}/continue: a person lets a run pass its approval gate. */
export function useContinueRun(runId: string, automationId?: string) {
  const invalidate = useInvalidateAutomations();
  return useMutation({
    mutationFn: () => api.post<{ resumed: boolean }>(`/runs/${encodeURIComponent(runId)}/continue`),
    onSuccess: () => invalidate(automationId, runId),
  });
}
