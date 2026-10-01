import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { serviceFamilyFallback } from "@/lib/labels";
import { api } from "./client";
import type { Category, SessionInfo, TeamMember, Workspace } from "./types";

export const sessionKey = ["session"] as const;

export function useSession() {
  return useQuery({ queryKey: sessionKey, queryFn: () => api.get<SessionInfo>("/session"), staleTime: 30_000 });
}

/** Active workspace. Only call inside the app shell (the shell guarantees a workspace). */
export function useWorkspace(): Workspace {
  const { data } = useSession();
  if (!data?.workspace) throw new Error("useWorkspace() used outside a workspace");
  return data.workspace;
}

export function useCurrentUser(): TeamMember | null {
  return useSession().data?.user ?? null;
}

export function useCategories() {
  return useQuery({ queryKey: ["categories"], queryFn: () => api.get<Category[]>("/categories"), staleTime: 60_000 });
}

/** key → the workspace's own label for a category / service family (falls back to built-in names). */
export function useCategoryLabel(): (key: string | null | undefined) => string {
  const { data } = useCategories();
  return useMemo(() => {
    const map = new Map((data ?? []).map((c) => [c.key, c.label]));
    return (key) => (key ? (map.get(key) ?? serviceFamilyFallback(key)) : "—");
  }, [data]);
}
