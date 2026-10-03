import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Plus, Settings } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { api } from "@/api/client";
import { useSession } from "@/api/session";
import { cn } from "@/lib/cn";
import { roleLabel } from "@/lib/labels";
import { Popover, Spinner, toastError } from "@/ui";

/** Brand block + workspace switcher. Each company keeps separate sources and vocabulary. */
export function WorkspaceSwitcher({ className, size = "lg" }: { className?: string; size?: "lg" | "sm" }) {
  const { data } = useSession();
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const activate = useMutation({
    mutationFn: (id: string) => api.post(`/workspaces/${id}/activate`),
    onSuccess: async () => {
      setOpen(false);
      await qc.resetQueries();
      navigate("/");
    },
    onError: (e) => toastError(e, "Could not switch workspace"),
  });
  const ws = data?.workspace;
  if (!ws) return null;
  const brand = ws.name || ws.company_name;

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      className="w-72 p-2"
      trigger={
        <button
          type="button"
          className={cn("group flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-hover", className)}
          aria-label={`Workspace: ${ws.name}. Switch workspace`}
        >
          <span className="min-w-0 flex-1">
            <span className={cn("block truncate font-bold tracking-[-0.01em] text-brand-ink", size === "lg" ? "text-lg" : "text-lg")}>
              {brand}
            </span>
            <span className="block truncate text-sm text-ink-3">{size === "lg" ? "Company workspace" : (ws.primary_email || ws.name)}</span>
          </span>
          <ChevronDown className="size-4 shrink-0 text-ink-3 transition-transform group-data-[state=open]:rotate-180" aria-hidden />
        </button>
      }
    >
      <p className="px-2 pb-2 pt-1 text-sm font-semibold text-ink">Switch workspace</p>
      <ul className="space-y-0.5">
        {(data?.workspaces ?? []).map((w) => {
          const current = w.id === ws.id;
          return (
            <li key={w.id}>
              <button
                type="button"
                disabled={current || activate.isPending}
                onClick={() => activate.mutate(w.id)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-md px-2 py-2 text-left",
                  current ? "bg-brand-soft" : "hover:bg-hover",
                )}
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-md bg-brand text-sm font-semibold text-white">
                  {(w.company_name || w.name).slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-ink">{w.company_name || w.name}</span>
                  <span className="block truncate text-xs text-ink-3">{w.primary_email}</span>
                </span>
                {current ? <Check className="size-4 text-brand" aria-label="Current" /> : null}
                {activate.isPending && activate.variables === w.id ? <Spinner className="size-4" /> : null}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 border-t border-line px-2 pt-2 text-xs text-ink-3">Each company has separate sources and vocabulary.</p>
      {data?.user ? (
        <p className="flex justify-between px-2 py-2 text-sm text-ink-2">
          <span>Your role</span>
          <span className="font-medium text-ink">{roleLabel(data.user.role)}</span>
        </p>
      ) : null}
      <div className="border-t border-line pt-1">
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            navigate("/setup/workspace?new=1");
          }}
          className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-sm text-ink hover:bg-hover"
        >
          <Plus className="size-4 text-ink-3" aria-hidden /> Create workspace
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            navigate("/settings/account");
          }}
          className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-sm text-ink hover:bg-hover"
        >
          <Settings className="size-4 text-ink-3" aria-hidden /> Account settings
        </button>
      </div>
    </Popover>
  );
}
