/**
 * Queries and mutations for connections, the AI engine and the AI policy.
 * Keys: ["connections"], ["ai-status"], ["ai-models", provider?], ["ai-policy"], ["ai-providers"], ["mcp-info"].
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { sessionKey, useCurrentUser } from "@/api/session";
import type { AiPolicy, AiProvider, AiStatus, ConnectionRow, McpInfo, ModelsResponse, TestResult } from "./types";

export const keys = {
  connections: ["connections"] as const,
  aiStatus: ["ai-status"] as const,
  aiModels: ["ai-models"] as const,
  aiModelsFor: (provider?: string | null) => (provider ? (["ai-models", provider] as const) : (["ai-models"] as const)),
  aiPolicy: ["ai-policy"] as const,
  aiProviders: ["ai-providers"] as const,
  mcpInfo: ["mcp-info"] as const,
};

/* ------------------------------------------------------------------ queries */

export function useConnections() {
  return useQuery({ queryKey: keys.connections, queryFn: () => api.get<ConnectionRow[]>("/connections") });
}

export function useAiStatus(options: { poll?: number | false } = {}) {
  return useQuery({
    queryKey: keys.aiStatus,
    queryFn: () => api.get<AiStatus>("/ai/status"),
    refetchInterval: options.poll ?? false,
  });
}

/** Models for one provider; without a provider the backend uses the active API connection (or lists all). */
export function useAiModels(provider?: string | null, options: { poll?: number | false; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: keys.aiModelsFor(provider),
    queryFn: () => api.get<ModelsResponse>("/ai/models", provider ? { provider } : undefined),
    refetchInterval: options.poll ?? false,
    enabled: options.enabled ?? true,
  });
}

export function useAiPolicy() {
  return useQuery({ queryKey: keys.aiPolicy, queryFn: () => api.get<AiPolicy>("/ai/policy") });
}

export function useAiProviders() {
  return useQuery({ queryKey: keys.aiProviders, queryFn: () => api.get<AiProvider[]>("/ai/providers"), staleTime: Infinity });
}

export function useMcpInfo() {
  return useQuery({ queryKey: keys.mcpInfo, queryFn: () => api.get<McpInfo>("/mcp/info"), staleTime: 5 * 60_000 });
}

/** Owners and admins may change connections, models and rules (the backend enforces it too). */
export function useCanManage(): boolean {
  const user = useCurrentUser();
  return !user || user.role === "owner" || user.role === "admin";
}

export const MANAGE_HINT = "Only an owner or admin can change this.";

/* ------------------------------------------------------------------ invalidation */

export function invalidateConnections(qc: QueryClient, opts: { session?: boolean; models?: boolean } = {}) {
  const jobs = [qc.invalidateQueries({ queryKey: keys.connections }), qc.invalidateQueries({ queryKey: keys.aiStatus })];
  if (opts.session !== false) jobs.push(qc.invalidateQueries({ queryKey: sessionKey }));
  if (opts.models) jobs.push(qc.invalidateQueries({ queryKey: keys.aiModels }));
  return Promise.all(jobs);
}

/* ------------------------------------------------------------------ connection mutations */

export interface ConnectionInput {
  kind: "ai" | "mail" | "search";
  method: string;
  provider: string;
  name?: string;
  config?: Record<string, unknown>;
  /** api_key | password | token | client_config — stored encrypted, never returned. */
  secrets?: Record<string, string>;
}

export const connectionApi = {
  create: (body: ConnectionInput) => api.post<ConnectionRow>("/connections", body),
  update: (id: string, body: { name?: string; config?: Record<string, unknown>; secrets?: Record<string, string>; is_active?: boolean }) =>
    api.patch<ConnectionRow>(`/connections/${id}`, body),
  remove: (id: string) => api.del<{ deleted: string }>(`/connections/${id}`),
  test: (id: string) => api.post<TestResult>(`/connections/${id}/test`),
  uploadClientConfig: (id: string, file: File) => api.upload<ConnectionRow>(`/connections/${id}/client-config`, file),
  oauthStart: (id: string) => api.post<{ auth_url: string; redirect_uri: string }>(`/connections/${id}/oauth/start`),
};

/** Make one connection the active one of its kind (the backend keeps one active per kind on create only). */
export async function activateConnection(conn: ConnectionRow, all: ConnectionRow[]) {
  for (const other of all) {
    if (other.id !== conn.id && other.kind === conn.kind && other.is_active) {
      await connectionApi.update(other.id, { is_active: false });
    }
  }
  if (!conn.is_active) await connectionApi.update(conn.id, { is_active: true });
}

export function useTestConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => connectionApi.test(id),
    onSettled: (res) => invalidateConnections(qc, { models: res?.connection.kind === "ai" }),
  });
}

export function useRemoveConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => connectionApi.remove(id),
    onSettled: () => invalidateConnections(qc, { models: true }),
  });
}

/* ------------------------------------------------------------------ model mutations */

export function useSelectModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { connection_id: string; model_id: string }) => api.post<{ selected: string }>("/ai/models/select", body),
    onSettled: () => invalidateConnections(qc, { models: true }),
  });
}

export function useRefreshModels() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (connection_id: string) => api.post<{ models: number; eligible: number }>("/ai/models/refresh", { connection_id }),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.aiModels }),
  });
}

export function usePutPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (policy: AiPolicy) => api.put<AiPolicy>("/ai/policy", policy),
    onSuccess: (saved) => qc.setQueryData(keys.aiPolicy, saved),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.aiPolicy }),
        qc.invalidateQueries({ queryKey: keys.aiModels }),
        qc.invalidateQueries({ queryKey: keys.aiStatus }),
        qc.invalidateQueries({ queryKey: sessionKey }),
      ]),
  });
}
