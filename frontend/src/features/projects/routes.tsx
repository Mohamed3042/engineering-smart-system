import type { RouteObject } from "react-router";
import { Placeholder } from "@/app/Placeholder";

export const projectRoutes: RouteObject[] = [
  { path: "projects", element: <Placeholder title="Projects" /> },
  { path: "projects/archive", element: <Placeholder title="Archive" /> },
  { path: "projects/:projectId/*", element: <Placeholder title="Project" /> },
  { path: "files/:fileId", element: <Placeholder title="File" /> },
];
