import type { RouteObject } from "react-router";
import { PageLoading } from "@/ui";

export const automationRoutes: RouteObject[] = [
  {
    path: "automations",
    HydrateFallback: PageLoading,
    lazy: async () => ({ Component: (await import("./AutomationsPage")).AutomationsPage }),
  },
  {
    path: "automations/new",
    HydrateFallback: PageLoading,
    lazy: async () => ({ Component: (await import("./NewAutomationPage")).NewAutomationPage }),
  },
  {
    path: "automations/runs/:runId",
    HydrateFallback: PageLoading,
    lazy: async () => ({ Component: (await import("./RunPage")).RunPage }),
  },
  {
    path: "automations/:automationId",
    HydrateFallback: PageLoading,
    lazy: async () => ({ Component: (await import("./AutomationPage")).AutomationPage }),
  },
];
