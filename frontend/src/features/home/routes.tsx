import type { RouteObject } from "react-router";
import { PageLoading } from "@/ui";

export const homeRoutes: RouteObject[] = [
  {
    index: true,
    HydrateFallback: PageLoading,
    lazy: async () => ({ Component: (await import("./HomePage")).HomePage }),
  },
];
