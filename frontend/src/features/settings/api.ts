/**
 * Queries and mutations for the workspace, the team and the export / import of a workspace.
 * Keys: ["team"], ["papers"] (plus the shared session key).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { sessionKey } from "@/api/session";
import type { TeamMember, Workspace } from "@/api/types";
import type { ImportResult, NewWorkspaceBody, PapersResponse } from "./types";

export const teamKey = ["team"] as const;
export const papersKey = ["papers"] as const;

export function useTeam() {
  return useQuery({ queryKey: teamKey, queryFn: () => api.get<TeamMember[]>("/team") });
}

/** Installed letterheads. Empty until a paper is added in Quotation setup. */
export function usePapers() {
  return useQuery({ queryKey: papersKey, queryFn: () => api.get<PapersResponse>("/papers"), staleTime: 60_000 });
}

export interface NewMember {
  name: string;
  email: string;
  role: string;
  initials?: string;
}

export function useAddMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewMember) => api.post<TeamMember>("/team", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: teamKey }),
  });
}

export type MemberPatch = Partial<Pick<TeamMember, "name" | "email" | "role" | "initials" | "active">>;

export function useUpdateMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: MemberPatch }) => api.patch<TeamMember>(`/team/${id}`, patch),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: teamKey }), qc.invalidateQueries({ queryKey: sessionKey })]),
  });
}

/** Local testing: use the app as another team member. Every role-gated screen changes, so refetch everything. */
export function useActAs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<TeamMember>(`/team/${id}/act-as`),
    onSuccess: () => qc.invalidateQueries(),
  });
}

/**
 * Creates a workspace (it becomes the active one) and moves its saved setup progress to the engine step.
 * The progress call is best effort: failing it must not make the person create the workspace twice.
 */
export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: NewWorkspaceBody) => {
      const ws = await api.post<Workspace>("/workspaces", body);
      try {
        await api.patch("/workspace", { setup_step: "engine" });
      } catch {
        /* the wizard saves progress again on the next step */
      }
      return ws;
    },
    // another company has its own sources and vocabulary: nothing cached may carry over
    onSuccess: () => qc.resetQueries(),
  });
}

/** Switches the active workspace (same call as the workspace menu). */
export function useActivateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<Workspace>(`/workspaces/${id}/activate`),
    onSuccess: () => qc.resetQueries(),
  });
}

export function useImportSnapshot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => api.upload<ImportResult>("/workspace/import", file),
    onSuccess: () => qc.invalidateQueries(),
  });
}

/** Downloads the workspace snapshot as a .json file (the person pressed Export). */
export async function downloadSnapshot(workspaceName: string): Promise<void> {
  const snapshot = await api.get<unknown>("/workspace/export");
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const slug = workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace";
  const a = document.createElement("a");
  a.href = url;
  a.download = `ess-${slug}-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
