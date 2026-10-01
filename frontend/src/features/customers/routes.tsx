import type { RouteObject } from "react-router";
import { Placeholder } from "@/app/Placeholder";

export const customerRoutes: RouteObject[] = [
  { path: "customers", element: <Placeholder title="Customers" /> },
  { path: "customers/:customerId/*", element: <Placeholder title="Customer" /> },
];
