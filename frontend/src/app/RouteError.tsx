import { isRouteErrorResponse, useRouteError } from "react-router";
import { Button, EmptyState } from "@/ui";

/** Shown when a screen crashes. Keeps the person's data safe: nothing was sent or changed. */
export function RouteError() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : "Unknown error";
  return (
    <div className="grid min-h-dvh place-items-center bg-canvas px-4">
      <EmptyState
        title="This screen stopped working"
        action={
          <>
            <Button variant="secondary" onClick={() => window.history.back()}>
              Go back
            </Button>
            <Button onClick={() => window.location.reload()}>Reload</Button>
          </>
        }
      >
        <p>Nothing was sent or changed. Reload the page to continue.</p>
        <p className="mt-2 font-mono text-xs text-ink-3">{message}</p>
      </EmptyState>
    </div>
  );
}
