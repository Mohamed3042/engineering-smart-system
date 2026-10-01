import type { RouteObject } from "react-router";
import { Placeholder } from "@/app/Placeholder";

/** Children of /settings */
export const knowledgeSettingsRoutes: RouteObject[] = [
  { path: "knowledge/*", element: <Placeholder title="Business knowledge" /> },
  { path: "learning", element: <Placeholder title="Learned corrections" /> },
];

/** Children of /setup */
export const knowledgeSetupRoutes: RouteObject[] = [
  { path: "documents", element: <Placeholder title="Company documents" /> },
  { path: "scope", element: <Placeholder title="Scan scope" /> },
  { path: "learning", element: <Placeholder title="Learning" /> },
  { path: "identity", element: <Placeholder title="Business discovery" /> },
];
