import type { RouteObject } from "react-router";
import { AccountPage } from "./AccountPage";
import { TeamPage } from "./TeamPage";
import { WorkspacePage } from "./WorkspacePage";

/** Children of /settings */
export const workspaceSettingsRoutes: RouteObject[] = [
  { path: "workspace", element: <WorkspacePage /> },
  { path: "team", element: <TeamPage /> },
  { path: "account", element: <AccountPage /> },
];
