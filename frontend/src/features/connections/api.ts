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
  kind: "ai" | "mail" | "search" | "reader";
  is_active?: boolean;
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

/** The backend switches the active connection atomically within its kind. */
export async function activateConnection(conn: ConnectionRow, _all: ConnectionRow[]) {
  await connectionApi.update(conn.id, { is_active: true });
}

export function useTestConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => connectionApi.test(id),
    onSettled: (res) => invalidateConnections(qc, { models: res?.connection.kind === "ai" }),
  });
}

/**
 * Starts Google sign-in for a Gmail connection. The browser leaves for Google and comes back to
 * /settings/connections?gmail=connected|error (the backend's fixed return address).
 */
export function useGoogleSignIn() {
  return useMutation({
    mutationFn: async (id: string) => {
      const { auth_url } = await connectionApi.oauthStart(id);
      window.location.assign(auth_url);
    },
  });
}

/** Make a saved connection the one in use for its kind (the others of that kind are switched off). */
export function useActivateConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ conn, all }: { conn: ConnectionRow; all: ConnectionRow[] }) => activateConnection(conn, all),
    onSettled: () => invalidateConnections(qc, { models: true }),
  });
}

/** Makes MCP the AI engine: reuses a saved MCP connection or adds one (the API key stays stored but unused). */
export function useEnableMcp(connections: ConnectionRow[]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const existing = connections.find((c) => c.kind === "ai" && c.method === "mcp");
      if (existing) await activateConnection(existing, connections);
      else await connectionApi.create({ kind: "ai", method: "mcp", provider: "mcp", name: "MCP client" });
    },
    onSettled: () => invalidateConnections(qc, { models: true }),
  });
}

/** One line about what a successful test found ("Signed in as … · 12,408 messages"). */
export function testSummary(res: TestResult): string {
  if (!res.ok) return res.error ?? "The test failed.";
  const bits: string[] = [];
  if (res.account) bits.push(`Signed in as ${res.account}`);
  if (typeof res.messages_total === "number") bits.push(`${res.messages_total.toLocaleString("en-GB")} messages in the mailbox`);
  else if (typeof res.inbox_messages === "number") bits.push(`${res.inbox_messages.toLocaleString("en-GB")} messages in the inbox`);
  if (res.tools?.length) bits.push(`${res.tools.length} mail tools found`);
  if (typeof res.results === "number") bits.push(`${res.results} results for a test search`);
  if (typeof res.models === "number") bits.push(`${res.models} models available`);
  return bits.join(" · ") || res.message || "The service answered.";
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
