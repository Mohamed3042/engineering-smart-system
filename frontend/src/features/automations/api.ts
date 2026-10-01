/**
 * Automations: shapes from backend/ess/api/automations.py and the hooks that read and change them.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { Automation, AutomationRun, AutomationRunStep, AutomationStep, OmitKnown } from "@/api/types";

/** A run's steps also carry the step type, its gate flag and who approved it (runner.py start_run / resume_run). */
export interface RunStep extends AutomationRunStep {
  type?: string;
  requires_approval?: boolean;
  approved_by?: string;
}

export interface Run extends OmitKnown<AutomationRun, "steps"> {
  steps: RunStep[];
}

/** GET /api/automations: each row carries its latest run. */
export interface AutomationRow extends Automation {
  last_run: Run | null;
  trigger_status: TriggerStatus;
  built_in: boolean;
}

export interface TriggerStatus { mode: string; automatic: boolean; label: string; detail: string; next_run_at?: string }
export interface StepCatalogItem { type: string; label: string; description: string; locked?: boolean; config?: { key: string; label: string; type: "number"; default: number }[] }
export interface WorkflowInput { name: string; description: string; trigger: string; interval_minutes: number | null; enabled: boolean; steps: AutomationStep[] }

/** GET /api/automations/{id}: the workflow and its 30 newest runs. */
export interface AutomationDetail {
  automation: Automation;
  runs: Run[];
  trigger_status: TriggerStatus;
  built_in: boolean;
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

export function useStepCatalog() {
  return useQuery({ queryKey: ["automation-step-catalog"], queryFn: () => api.get<StepCatalogItem[]>("/automations/step-catalog"), staleTime: 300_000 });
}

export function useSaveWorkflow() {
  const invalidate = useInvalidateAutomations();
  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body: WorkflowInput }) => id
      ? api.patch<AutomationRow>(`/automations/${encodeURIComponent(id)}`, body)
      : api.post<AutomationRow>("/automations", body),
    onSuccess: (a) => invalidate(a.id),
  });
}

export function useDeleteWorkflow() {
  const invalidate = useInvalidateAutomations();
  return useMutation({ mutationFn: (id: string) => api.del(`/automations/${encodeURIComponent(id)}`), onSuccess: () => invalidate() });
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
