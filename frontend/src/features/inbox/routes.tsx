import type { RouteObject } from "react-router";
import { Placeholder } from "@/app/Placeholder";

export const inboxRoutes: RouteObject[] = [
  { path: "inbox", element: <Placeholder title="Inbox" /> },
  { path: "inbox/:emailId", element: <Placeholder title="Email" /> },
];
