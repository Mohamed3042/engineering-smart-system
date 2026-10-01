import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router";
import { queryClient } from "@/api/query";
import { Toaster, TooltipProvider } from "@/ui";
import { AccessGate } from "./AccessGate";
import { router } from "./router";

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
        <AccessGate />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
