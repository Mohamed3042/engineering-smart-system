import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CheckCheck, CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "@/api/client";
import type { Activity } from "@/api/types";
import { cn } from "@/lib/cn";
import { formatRelative } from "@/lib/format";
import { Button, Drawer, EmptyState, ErrorState, LoadingRows } from "@/ui";

interface NotificationsResponse {
  unread: number;
  items: Activity[];
}

export function useNotifications() {
  return useQuery({
    queryKey: ["notifications"],
    queryFn: () => api.get<NotificationsResponse>("/notifications", { limit: 50 }),
    refetchInterval: 60_000,
  });
}

function activityLink(a: Activity): string | null {
  if (a.quotation_id) return `/quotations/${a.quotation_id}`;
  if (a.project_id) return `/projects/${a.project_id}`;
  if (a.email_id) return `/inbox/${encodeURIComponent(a.email_id)}`;
  if (a.customer_id) return `/customers/${a.customer_id}`;
  return null;
}

const severityIcon = {
  error: <CircleAlert className="text-block" aria-hidden />,
  warning: <TriangleAlert className="text-review" aria-hidden />,
  success: <CircleCheck className="text-brand" aria-hidden />,
  info: <Info className="text-ink-3" aria-hidden />,
} as const;

/** Bell button + drawer with the latest activity. */
export function NotificationsButton({ className, compact }: { className?: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const q = useNotifications();
  const qc = useQueryClient();
  const readAll = useMutation({
    mutationFn: () => api.post("/notifications/read-all"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const unread = q.data?.unread ?? 0;

  return (
    <Drawer
      open={open}
      onOpenChange={setOpen}
      title="Notifications"
      description="What the system did and what waits for a person."
      trigger={
        <button
          type="button"
          aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
          className={cn(
            "relative inline-flex items-center gap-3 rounded-lg text-ink-2 hover:bg-hover hover:text-ink",
            compact ? "size-10 justify-center" : "h-10 w-full px-3 text-[0.9375rem] font-medium",
            className,
          )}
        >
          <Bell className="size-5 shrink-0" aria-hidden />
          {!compact && <span className="flex-1 text-left">Notifications</span>}
          {unread > 0 ? (
            compact ? (
              <span className="absolute right-2 top-2 size-2.5 rounded-full border-2 border-surface bg-block" aria-hidden />
            ) : (
              <span className="rounded-full bg-block-soft px-2 text-xs font-semibold text-block tabular">{unread}</span>
            )
          ) : null}
        </button>
      }
      footer={
        <Button
          variant="secondary"
          icon={<CheckCheck />}
          onClick={() => readAll.mutate()}
          loading={readAll.isPending}
          disabled={!unread}
          className="w-full"
        >
          Mark all as read
        </Button>
      }
    >
      {q.isLoading ? (
        <LoadingRows rows={6} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} compact />
      ) : !q.data?.items.length ? (
        <EmptyState icon={<Bell />} title="No notifications yet" compact>
          Scans, downloads, reviews and approvals appear here.
        </EmptyState>
      ) : (
        <ul className="-mx-2 divide-y divide-line">
          {q.data.items.map((a) => {
            const to = activityLink(a);
            const body = (
              <div className="flex gap-3 px-2 py-3">
                <span className="mt-0.5 [&_svg]:size-[18px]">{severityIcon[a.severity as keyof typeof severityIcon] ?? severityIcon.info}</span>
                <div className="min-w-0 flex-1">
                  <p className={cn("text-[0.9375rem] text-ink", !a.is_read && "font-semibold")}>{a.title}</p>
                  {a.detail ? <p className="mt-0.5 line-clamp-2 text-sm text-ink-3">{a.detail}</p> : null}
                  <p className="mt-1 text-xs text-ink-3">
                    {formatRelative(a.created_at)}
                    {a.actor && a.actor !== "system" ? ` · ${a.actor}` : ""}
                  </p>
                </div>
                {!a.is_read ? <span className="mt-2 size-2 shrink-0 rounded-full bg-brand" aria-label="Unread" /> : null}
              </div>
            );
            return (
              <li key={a.id}>
                {to ? (
                  <Link to={to} onClick={() => setOpen(false)} className="block rounded-lg hover:bg-hover">
                    {body}
                  </Link>
                ) : (
                  body
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Drawer>
  );
}
