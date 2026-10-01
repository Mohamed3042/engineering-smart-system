/**
 * Setup wizard: workspace → engine → model → mail → documents → scope → learning → identity → done.
 * The step order matches Workspace.setup_step in the backend.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import { useNavigate } from "react-router";
import { api } from "@/api/client";
import { sessionKey, useSession } from "@/api/session";
import type { Step } from "@/ui";

export const SETUP_STEPS: Step[] = [
  { key: "workspace", label: "Company workspace", hint: "Name, mailbox, region" },
  { key: "engine", label: "AI engine", hint: "API key or MCP" },
  { key: "model", label: "Model", hint: "Only eligible models" },
  { key: "mail", label: "Mailbox", hint: "Read-only access" },
  { key: "documents", label: "Company documents", hint: "Quotations and catalogues" },
  { key: "scope", label: "Scan scope", hint: "Dates and folders" },
  { key: "learning", label: "Learning", hint: "Mail and documents" },
  { key: "identity", label: "Business discovery", hint: "Confirm what you do" },
];

export const SETUP_ORDER = [...SETUP_STEPS.map((s) => s.key), "done"];

export function stepIndex(key: string | null | undefined) {
  const i = SETUP_ORDER.indexOf(key ?? "workspace");
  return i < 0 ? 0 : i;
}

interface SetupNav {
  /** Current step key from the URL. */
  step: string;
  /** Save progress (setup_step) and go to the next step. */
  next: () => Promise<void>;
  back: () => void;
  /** Skip to a later step without finishing this one. */
  goTo: (key: string) => void;
  isSaving: boolean;
}

export const SetupNavContext = createContext<SetupNav | null>(null);

/** Navigation for setup step components: `const { next, back } = useSetupNav();` */
export function useSetupNav(): SetupNav {
  const ctx = useContext(SetupNavContext);
  if (!ctx) throw new Error("useSetupNav() must be used inside the setup wizard");
  return ctx;
}

export function useSetupNavValue(step: string): SetupNav {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const session = useSession();
  const save = useMutation({
    mutationFn: (setup_step: string) => api.patch("/workspace", { setup_step }),
  });
  const idx = stepIndex(step);
  return {
    step,
    isSaving: save.isPending,
    next: async () => {
      const nextKey = SETUP_ORDER[idx + 1] ?? "done";
      const current = session.data?.workspace?.setup_step;
      // only move the saved progress forward
      if (session.data?.workspace && stepIndex(current) < stepIndex(nextKey)) {
        await save.mutateAsync(nextKey);
        await qc.invalidateQueries({ queryKey: sessionKey });
      }
      navigate(nextKey === "done" ? "/" : `/setup/${nextKey}`);
    },
    back: () => {
      const prev = SETUP_ORDER[idx - 1];
      if (prev) navigate(`/setup/${prev}`);
    },
    goTo: (key: string) => navigate(key === "done" ? "/" : `/setup/${key}`),
  };
}
