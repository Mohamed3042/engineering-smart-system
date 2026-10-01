import { Ellipsis, Pencil, RefreshCw, Trash2, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { formatRelative } from "@/lib/format";
import { connectionStatusInfo } from "@/lib/labels";
import { Button, Chip, IconButton, Menu, StatusChip, toast, toastError } from "@/ui";
import { MANAGE_HINT, testSummary, useTestConnection } from "../api";
import { connectionIssue, type Recovery } from "../issues";
import type { ConnectionRow } from "../types";
import { IconTile } from "./bits";
import { IssueBanner } from "./IssueBanner";

/**
 * One saved connection: what it is, whether it works, when it was last tested, and what to do when it
 * does not. Test, edit, make-active and remove live here so every kind of connection behaves the same.
 */
export function ConnectionRowView({
  conn,
  icon,
  title,
  subtitle,
  description,
  canManage,
  showActive,
  onEdit,
  onRemove,
  onMakeActive,
  recovery,
  recoveryBusy,
  hideIssue,
  children,
}: {
  conn: ConnectionRow;
  icon: ReactNode;
  title: ReactNode;
  /** Account or provider line. */
  subtitle?: ReactNode;
  description: ReactNode;
  canManage: boolean;
  /** Mark the connection in use / not in use (only when several of the same kind exist). */
  showActive?: boolean;
  onEdit?: () => void;
  onRemove?: () => void;
  onMakeActive?: () => void;
  /** Handlers for the recovery buttons of the problem banner (Test again is built in). */
  recovery?: Partial<Record<Recovery, () => void>>;
  recoveryBusy?: Recovery | null;
  /** The screen already shows the problem elsewhere (the form right above the list). */
  hideIssue?: boolean;
  children?: ReactNode;
}) {
  const test = useTestConnection();
  const issue = hideIssue ? null : connectionIssue(conn);
  const info = connectionStatusInfo(conn.status);

  const runTest = () =>
    test.mutate(conn.id, {
      onSuccess: (res) => {
        if (res.ok) toast.success("Connection works", { description: testSummary(res) });
        else toast.error("The test failed", { description: "What went wrong, and how to fix it, is shown on the connection." });
      },
      onError: (err) => toastError(err, "The test could not run"),
    });

  const checked =
    conn.status === "not_connected" && !conn.last_checked_at
      ? "Not tested yet"
      : conn.last_checked_at
        ? `${conn.status === "error" ? "Last test failed" : "Checked"} ${formatRelative(conn.last_checked_at).toLowerCase()}`
        : null;

  const items = [
    ...(onEdit ? [{ label: "Edit settings", icon: <Pencil />, disabled: !canManage, onSelect: onEdit }] : []),
    ...(onMakeActive && !conn.is_active ? [{ label: "Use this one", icon: <Zap />, disabled: !canManage, onSelect: onMakeActive }] : []),
    ...(onRemove ? [{ label: "Remove connection", icon: <Trash2 />, danger: true, disabled: !canManage, separatorBefore: true, onSelect: onRemove }] : []),
  ];

  return (
    <li className="px-5 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 items-start gap-4">
          <IconTile tone={conn.status === "connected" ? "brand" : "neutral"}>{icon}</IconTile>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <p className="font-semibold text-ink">{title}</p>
              <StatusChip info={info} size="sm" />
              {showActive ? (
                conn.is_active ? (
                  <Chip size="sm" tone="neutral">
                    In use
                  </Chip>
                ) : (
                  <Chip size="sm" tone="muted">
                    Not in use
                  </Chip>
                )
              ) : null}
            </div>
            {subtitle ? <p className="mt-0.5 break-all text-sm text-ink-2">{subtitle}</p> : null}
            <p className="mt-0.5 text-sm text-ink-3">{description}</p>
            {checked ? <p className="mt-1 text-sm text-ink-3">{checked}</p> : null}
          </div>
        </div>
        <div className="flex items-center gap-2 sm:shrink-0">
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw />}
            loading={test.isPending}
            disabled={!canManage}
            title={canManage ? undefined : MANAGE_HINT}
            onClick={runTest}
            className="flex-1 sm:flex-none"
          >
            Test connection
          </Button>
          {items.length ? (
            <Menu
              trigger={
                <IconButton label={`More actions for ${typeof title === "string" ? title : "this connection"}`} variant="secondary" size="sm">
                  <Ellipsis />
                </IconButton>
              }
              items={items}
            />
          ) : null}
        </div>
      </div>
      {issue ? (
        <IssueBanner
          className="mt-3"
          issue={issue}
          raw={conn.last_error}
          busy={test.isPending ? "test" : (recoveryBusy ?? null)}
          disabled={!canManage}
          on={{ ...recovery, test: runTest }}
        />
      ) : null}
      {children}
    </li>
  );
}
