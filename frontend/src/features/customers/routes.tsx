import { Navigate, useParams, type RouteObject } from "react-router";
import { customerHref } from "@/lib/routes";
import { PageLoading } from "@/ui";

/** /customers/:id/<unknown> falls back to the profile. */
function ToProfile() {
  const { customerId = "" } = useParams();
  return <Navigate to={customerHref(customerId)} replace />;
}

/**
 * Tabs are routes (lib/routes.ts customerHref): profile is the index; projects, research, updates and
 * opportunities match customerHref(id, tab); lessons is /customers/:id/lessons.
 */
export const customerRoutes: RouteObject[] = [
  {
    path: "customers",
    HydrateFallback: PageLoading,
    lazy: async () => ({ Component: (await import("./DirectoryPage")).DirectoryPage }),
  },
  // no company is called "opportunities" or "updates": these addresses open the directory
  { path: "customers/opportunities", element: <Navigate to="/customers" replace /> },
  { path: "customers/updates", element: <Navigate to="/customers" replace /> },
  {
    path: "customers/:customerId",
    HydrateFallback: PageLoading,
    lazy: async () => ({ Component: (await import("./CustomerLayout")).CustomerLayout }),
    children: [
      { index: true, lazy: async () => ({ Component: (await import("./ProfileTab")).ProfileTab }) },
      { path: "projects", lazy: async () => ({ Component: (await import("./ProjectsTab")).ProjectsTab }) },
      { path: "research", lazy: async () => ({ Component: (await import("./ResearchTab")).ResearchTab }) },
      { path: "updates", lazy: async () => ({ Component: (await import("./UpdatesTab")).UpdatesTab }) },
      { path: "opportunities", lazy: async () => ({ Component: (await import("./OpportunitiesTab")).OpportunitiesTab }) },
      { path: "lessons", lazy: async () => ({ Component: (await import("./LessonsTab")).LessonsTab }) },
      { path: "*", element: <ToProfile /> },
    ],
  },
];
