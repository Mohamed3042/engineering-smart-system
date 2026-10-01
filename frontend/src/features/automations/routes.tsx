import type { RouteObject } from "react-router";
import { Placeholder } from "@/app/Placeholder";

export const automationRoutes: RouteObject[] = [
  { path: "automations", element: <Placeholder title="Automations" /> },
  { path: "automations/runs/:runId", element: <Placeholder title="Automation run" /> },
  { path: "automations/:automationId", element: <Placeholder title="Automation" /> },
];
