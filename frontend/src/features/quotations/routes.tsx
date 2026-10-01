import type { RouteObject } from "react-router";
import { Page, Skeleton } from "@/ui";

/** Shown while a screen's code loads (also on the first load straight into a quotation URL). */
function RouteLoading() {
  return (
    <Page>
      <div role="status" aria-label="Loading" className="space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-4 w-96 max-w-full" />
        <div className="space-y-3 rounded-xl border border-line bg-surface p-5">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      </div>
    </Page>
  );
}

export const quotationRoutes: RouteObject[] = [
  {
    path: "quotations",
    HydrateFallback: RouteLoading,
    lazy: () => import("./library/LibraryPage").then((m) => ({ Component: m.LibraryPage })),
  },
  {
    path: "quotations/approvals",
    HydrateFallback: RouteLoading,
    lazy: () => import("./approvals/ApprovalsPage").then((m) => ({ Component: m.ApprovalsPage })),
  },
  {
    path: "quotations/setup/*",
    HydrateFallback: RouteLoading,
    lazy: () => import("./setup/SetupArea").then((m) => ({ Component: m.SetupArea })),
  },
  {
    path: "quotations/:quotationId/*",
    HydrateFallback: RouteLoading,
    lazy: () => import("./editor/QuotationArea").then((m) => ({ Component: m.QuotationArea })),
  },
];
