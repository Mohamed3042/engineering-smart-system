import type { RouteObject } from "react-router";
import { Placeholder } from "@/app/Placeholder";

/** Children of /settings */
export const workspaceSettingsRoutes: RouteObject[] = [
  { path: "workspace", element: <Placeholder title="Workspace" /> },
  { path: "team", element: <Placeholder title="Team & permissions" /> },
  { path: "account", element: <Placeholder title="Your account" /> },
];
