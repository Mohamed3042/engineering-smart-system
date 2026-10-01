import type { RouteObject } from "react-router";
import { EngineStep } from "@/features/setup/EngineStep";
import { MailStep } from "@/features/setup/MailStep";
import { ModelStep } from "@/features/setup/ModelStep";
import { WorkspaceStep } from "@/features/setup/WorkspaceStep";
import { AiEnginePage } from "./pages/AiEnginePage";
import { AiRulesPage } from "./pages/AiRulesPage";
import { ConnectionsPage } from "./pages/ConnectionsPage";

/** Children of /settings */
export const connectionSettingsRoutes: RouteObject[] = [
  { path: "connections", element: <ConnectionsPage /> },
  { path: "ai", element: <AiEnginePage /> },
  { path: "ai-rules", element: <AiRulesPage /> },
];

/** Children of /setup */
export const connectionSetupRoutes: RouteObject[] = [
  { path: "workspace", element: <WorkspaceStep /> },
  { path: "engine", element: <EngineStep /> },
  { path: "model", element: <ModelStep /> },
  { path: "mail", element: <MailStep /> },
];
