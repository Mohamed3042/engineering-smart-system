import type { RouteObject } from "react-router";
import { Placeholder } from "@/app/Placeholder";

/** Children of /settings */
export const connectionSettingsRoutes: RouteObject[] = [
  { path: "connections", element: <Placeholder title="Mailbox & services" /> },
  { path: "ai", element: <Placeholder title="AI engine" /> },
  { path: "ai-rules", element: <Placeholder title="AI quality rules" /> },
];

/** Children of /setup */
export const connectionSetupRoutes: RouteObject[] = [
  { path: "workspace", element: <Placeholder title="Company workspace" /> },
  { path: "engine", element: <Placeholder title="AI engine" /> },
  { path: "model", element: <Placeholder title="Model" /> },
  { path: "mail", element: <Placeholder title="Mailbox" /> },
];
