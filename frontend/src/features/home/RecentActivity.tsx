import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { Activity } from "@/api/types";
import { formatRelative } from "@/lib/format";
import { customerHref, emailHref, projectHref, quotationHref } from "@/lib/routes";
import { Panel, PanelHeader } from "@/ui";

function activityHref(a: Activity): string | null {
  if (a.quotation_id) return quotationHref(a.quotation_id);
  if (a.project_id) return projectHref(a.project_id);
  if (a.email_id) return emailHref(a.email_id);
  if (a.customer_id) return customerHref(a.customer_id);
  return null;
}

const severityIcon: Record<string, ReactNode> = {
  error: <CircleAlert className="text-block" aria-label="Problem" />,
  warning: <TriangleAlert className="text-review" aria-label="Needs a person" />,
  success: <CircleCheck className="text-brand" aria-label="Done" />,
  info: <Info className="text-ink-3" aria-label="Information" />,
};

/** Latest things the system and the team did (dashboard "today"). */
export function RecentActivity({ items, className, max = 6 }: { items: Activity[]; className?: string; max?: number }) {
  if (!items.length) return null;
  const shown = items.slice(0, max);
  return (
    <Panel className={className}>
      <PanelHeader title="Recent activity" description="What the system and your team did lately." />
      <ul className="divide-y divide-line">
        {shown.map((a) => {
          const to = activityHref(a);
          const body = (
            <div className="flex gap-3 px-5 py-3">
              <span className="mt-0.5 shrink-0 [&_svg]:size-[18px]">{severityIcon[a.severity] ?? severityIcon.info}</span>
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 break-words text-[0.9375rem] text-ink">{a.title}</p>
                {a.detail ? <p className="mt-0.5 line-clamp-1 break-words text-sm text-ink-3">{a.detail}</p> : null}
              </div>
              <p className="shrink-0 text-right text-xs text-ink-3 tabular">
                {formatRelative(a.created_at)}
                {a.actor && a.actor !== "system" ? <span className="block">{a.actor}</span> : null}
              </p>
            </div>
          );
          return (
            <li key={a.id}>
              {to ? (
                <Link to={to} className="block hover:bg-canvas focus-visible:outline-offset-[-2px]">
                  {body}
                </Link>
              ) : (
                body
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
