import { useEffect, useState } from "react";
import { createBrowserRouter, Navigate, type RouteObject } from "react-router";
import { automationRoutes } from "@/features/automations/routes";
import { connectionSettingsRoutes, connectionSetupRoutes } from "@/features/connections/routes";
import { customerRoutes } from "@/features/customers/routes";
import { homeRoutes } from "@/features/home/routes";
import { inboxRoutes } from "@/features/inbox/routes";
import { knowledgeSettingsRoutes, knowledgeSetupRoutes } from "@/features/knowledge/routes";
import { projectRoutes } from "@/features/projects/routes";
import { quotationRoutes } from "@/features/quotations/routes";
import { workspaceSettingsRoutes } from "@/features/settings/routes";
import { EmptyState, Page } from "@/ui";
import { AppShell } from "./AppShell";
import { RouteError } from "./RouteError";
import { SettingsLayout } from "./SettingsLayout";
import { SetupLayout } from "./SetupLayout";

/** /settings on a wide screen opens the first section; on phones it shows the section list. */
function SettingsIndex() {
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 1024px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide ? <Navigate to="/settings/connections" replace /> : null;
}

function NotFound() {
  return (
    <Page>
      <EmptyState title="Page not found">The address does not match a screen. Use the menu to continue.</EmptyState>
    </Page>
  );
}

const routes: RouteObject[] = [
  {
    path: "/setup",
    element: <SetupLayout />,
    errorElement: <RouteError />,
    children: [{ index: true, element: <Navigate to="/setup/workspace" replace /> }, ...connectionSetupRoutes, ...knowledgeSetupRoutes],
  },
  {
    path: "/",
    element: <AppShell />,
    errorElement: <RouteError />,
    children: [
      ...homeRoutes,
      ...inboxRoutes,
      ...projectRoutes,
      ...quotationRoutes,
      ...customerRoutes,
      ...automationRoutes,
      { path: "approvals", element: <Navigate to="/quotations/approvals" replace /> },
      {
        path: "settings",
        element: <SettingsLayout />,
        children: [
          { index: true, element: <SettingsIndex /> },
          ...connectionSettingsRoutes,
          ...knowledgeSettingsRoutes,
          ...workspaceSettingsRoutes,
        ],
      },
      { path: "*", element: <NotFound /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
