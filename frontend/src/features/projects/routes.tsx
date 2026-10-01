import type { RouteObject } from "react-router";
import { Page, Skeleton } from "@/ui";

/** Shown while a page's code loads on first visit. */
function RouteFallback() {
  return (
    <Page>
      <div className="space-y-4" role="status" aria-label="Loading">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-9 w-72 max-w-full" />
        <Skeleton className="h-4 w-96 max-w-full" />
        <Skeleton className="mt-6 h-40 w-full" />
      </div>
    </Page>
  );
}

export const projectRoutes: RouteObject[] = [
  {
    path: "projects",
    HydrateFallback: RouteFallback,
    lazy: async () => ({ Component: (await import("./ProjectsPage")).ProjectsPage }),
  },
  {
    path: "projects/archive",
    HydrateFallback: RouteFallback,
    lazy: async () => ({ Component: (await import("./ArchivePage")).ArchivePage }),
  },
  {
    path: "projects/:projectId/*",
    HydrateFallback: RouteFallback,
    lazy: async () => ({ Component: (await import("./ProjectLayout")).ProjectLayout }),
  },
  {
    path: "files/:fileId",
    HydrateFallback: RouteFallback,
    lazy: async () => ({ Component: (await import("./FilePage")).FilePage }),
  },
];
