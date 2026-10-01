import type { RouteObject } from "react-router";
import { PageLoading } from "@/ui";

export const inboxRoutes: RouteObject[] = [
  {
    path: "inbox",
    HydrateFallback: PageLoading,
    lazy: async () => ({ Component: (await import("./InboxPage")).InboxPage }),
  },
  {
    path: "inbox/:emailId",
    HydrateFallback: PageLoading,
    lazy: async () => ({ Component: (await import("./EmailPage")).EmailPage }),
  },
];
