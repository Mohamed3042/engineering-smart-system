import { Clock, Hand, Pause, PowerOff, Zap, type LucideIcon } from "lucide-react";
import type { MouseEvent } from "react";
import { Link } from "react-router";
import type { Automation } from "@/api/types";
import { cn } from "@/lib/cn";
import { formatRelative } from "@/lib/format";
import { runHref } from "@/lib/routes";
import { Chip, StatusChip, Switch, toast, toastError } from "@/ui";
import { useToggleAutomation, type Run } from "./api";
import { formatNext, runStateInfo, stepEnabled, type TriggerSummary } from "./lib";

export const stop = (e: MouseEvent) => e.stopPropagation();

/** On / off for one workflow. The label says the state in words ("Switched on", "Switched off"); changing it needs the admin role. */
export function EnabledSwitch({
  automation: a,
  canEdit,
  className,
}: {
  automation: Pick<Automation, "id" | "name" | "enabled">;
  canEdit: boolean;
  className?: string;
}) {
  const toggle = useToggleAutomation();
  return (
    <Switch
      checked={a.enabled}
      disabled={!canEdit || toggle.isPending}
      className={className}
      label={
        <>
          {a.enabled ? "Switched on" : "Switched off"}
          <span className="sr-only"> {a.name}</span>
        </>
      }
      onChange={(enabled) =>
        toggle.mutate(
          { id: a.id, enabled },
          {
            onSuccess: () => toast.success(enabled ? `${a.name} switched on` : `${a.name} switched off`),
            onError: (err) => toastError(err, "The automation was not changed"),
          },
        )
      }
    />
  );
}

const MODE_ICON: Record<string, LucideIcon> = { automatic: Zap, manual: Hand, off: PowerOff, paused: Pause };

/**
 * How the workflow starts, in the server's words, with the reason: "Manual — Run now" and why it is
 * not automatic. Shown on desktop and phone alike. It never implies automatic processing when the
 * server says the workflow does not start by itself.
 */
export function TriggerStatusBlock({ summary, className }: { summary: TriggerSummary; className?: string }) {
  const Icon = MODE_ICON[summary.mode] ?? Hand;
  return (
    <div className={cn("space-y-0.5", className)}>
      <p className="flex items-start gap-1.5 font-medium text-ink">
        <Icon className={cn("mt-0.5 size-4 shrink-0", summary.automatic ? "text-brand" : summary.mode === "paused" ? "text-review" : "text-ink-3")} aria-hidden />
        <span className="min-w-0 break-words">{summary.label}</span>
      </p>
      {summary.detail ? <p className="text-sm text-ink-3">{summary.detail}</p> : null}
      {summary.next ? <p className="text-sm text-ink-3">Next run {formatNext(summary.next)}</p> : null}
      {summary.setTo ? <p className="text-sm text-ink-3">Set to: {summary.setTo}</p> : null}
    </div>
  );
}

/** Steps that stop the run until a person continues it. */
export function gateLabels(a: Pick<Automation, "steps">): string[] {
  return a.steps.filter((s) => s.requires_approval && stepEnabled(s)).map((s) => s.label);
}

export function NeedsApproval({ labels }: { labels: string[] }) {
  if (labels.length === 0) return null;
  const text = labels.join(", ");
  return (
    <Chip tone="review" size="sm" icon={<Clock aria-hidden />} title={`Stops for a person at: ${text}`}>
      Needs approval: {text}
    </Chip>
  );
}

/** Status of a workflow's latest run, linked to it. */
export function LastRun({ run, link = true }: { run: Run | null | undefined; link?: boolean }) {
  if (!run) return <span className="text-sm text-ink-3">Not run yet</span>;
  const when = formatRelative(run.started_at);
  return (
    <div className="space-y-1">
      <StatusChip info={runStateInfo(run.status)} size="sm" />
      <p className="text-xs text-ink-3 tabular">
        {link ? (
          <Link to={runHref(run.id)} onClick={stop} className="hover:text-brand-ink hover:underline">
            {when}
          </Link>
        ) : (
          when
        )}
      </p>
    </div>
  );
}
