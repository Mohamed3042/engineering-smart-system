/**
 * Loading, empty and error states. Every data view handles all three.
 */
import { CircleAlert, LoaderCircle, RefreshCw, WifiOff } from "lucide-react";
import type { ReactNode } from "react";
import { ApiError, errorMessage } from "@/api/client";
import { cn } from "@/lib/cn";
import { Button } from "./Button";

export function Spinner({ className, label = "Loading" }: { className?: string; label?: string }) {
  return <LoaderCircle role="status" aria-label={label} className={cn("size-5 animate-spin text-ink-3", className)} />;
}

export function EmptyState({
  icon,
  title,
  children,
  action,
  className,
  compact,
}: {
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div className={cn("flex flex-col items-center text-center", compact ? "px-4 py-8" : "px-6 py-14", className)}>
      {icon ? (
        <span className="mb-4 grid size-12 place-items-center rounded-full bg-sunken text-ink-3 [&_svg]:size-6" aria-hidden>
          {icon}
        </span>
      ) : null}
      <p className="text-lg font-semibold text-ink">{title}</p>
      {children ? <div className="mt-1.5 max-w-md text-base text-ink-3">{children}</div> : null}
      {action ? <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  title,
  className,
  compact,
}: {
  error: unknown;
  onRetry?: () => void;
  title?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  const offline = error instanceof ApiError && error.code === "offline";
  return (
    <EmptyState
      compact={compact}
      className={className}
      icon={offline ? <WifiOff /> : <CircleAlert />}
      title={title ?? (offline ? "Local server is not responding" : "This view could not load")}
      action={
        onRetry ? (
          <Button variant="secondary" icon={<RefreshCw />} onClick={onRetry}>
            Try again
          </Button>
        ) : null
      }
    >
      {offline ? "Start it with ./run.sh, then try again." : errorMessage(error)}
    </EmptyState>
  );
}

/** Inline error under a form or action. */
export function InlineError({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  return (
    <p role="alert" className={cn("flex items-start gap-2 text-sm text-block", className)}>
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      {errorMessage(error)}
    </p>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("skeleton h-4", className)} />;
}

/** Placeholder rows that match a table or list while data loads. */
export function LoadingRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("divide-y divide-line", className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-5 py-4">
          <Skeleton className="h-4 w-1/4" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="ml-auto h-8 w-24" />
        </div>
      ))}
    </div>
  );
}

export function PageLoading() {
  return (
    <div className="grid min-h-[50vh] place-items-center">
      <Spinner className="size-6" />
    </div>
  );
}

/**
 * Renders loading / error / empty / content for one query.
 * <QueryState query={q} empty={...}>{(data) => ...}</QueryState>
 */
export function QueryState<T>({
  query,
  children,
  loading,
  empty,
  isEmpty,
  compact,
}: {
  query: { data: T | undefined; isLoading: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  children: (data: T) => ReactNode;
  loading?: ReactNode;
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
  compact?: boolean;
}) {
  if (query.isLoading) return <>{loading ?? <LoadingRows />}</>;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} compact={compact} />;
  if (query.data === undefined) return null;
  if (empty && isEmpty?.(query.data)) return <>{empty}</>;
  return <>{children(query.data)}</>;
}
