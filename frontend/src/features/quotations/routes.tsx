import type { RouteObject } from "react-router";
import { Placeholder } from "@/app/Placeholder";

export const quotationRoutes: RouteObject[] = [
  { path: "quotations", element: <Placeholder title="Quotations" /> },
  { path: "quotations/approvals", element: <Placeholder title="Approvals" /> },
  { path: "quotations/setup/*", element: <Placeholder title="Quotation setup" /> },
  { path: "quotations/:quotationId/*", element: <Placeholder title="Quotation" /> },
];
