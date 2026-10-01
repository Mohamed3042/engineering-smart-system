import { Link } from "react-router";
import type { Activity } from "@/api/types";
import { formatRelative } from "@/lib/format";
import type { Tone } from "@/lib/labels";
import { customerHref, emailHref, projectHref, quotationHref } from "@/lib/routes";
import { Dot, Panel, PanelHeader } from "@/ui";

function activityHref(a: Activity): string | null {
  if (a.quotation_id) return quotationHref(a.quotation_id);
  if (a.project_id) return projectHref(a.project_id);
  if (a.email_id) return emailHref(a.email_id);
  if (a.customer_id) return customerHref(a.customer_id);
  return null;
}

/** Dot colour plus a word for the two severities that ask something of a person. */
const severity: Record<string, { tone: Tone; label: string; word?: string; wordClass?: string }> = {
  error: { tone: "block", label: "Problem", word: "Problem", wordClass: "text-block" },
  warning: { tone: "review", label: "Needs a person", word: "Needs a person", wordClass: "text-review" },
  success: { tone: "brand", label: "Done" },
  info: { tone: "neutral", label: "Information" },
};

/** Latest things the system and the team did (dashboard "today"). */
export function RecentActivity({ items, className, max = 6 }: { items: Activity[]; className?: string; max?: number }) {
  if (!items.length) return null;
  const shown = items.slice(0, max);
  return (
    <Panel className={className}>
      <PanelHeader title="Latest activity" description="What the system and your team did lately." />
      <ul className="divide-y divide-line">
        {shown.map((a) => {
          const to = activityHref(a);
          const sev = severity[a.severity] ?? severity.info;
          const body = (
            <div className="flex gap-3 px-5 py-3">
              <Dot tone={sev.tone} label={sev.word ? undefined : sev.label} className="mt-2" />
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 break-words text-[0.9375rem] text-ink">{a.title}</p>
                {a.detail ? <p className="mt-0.5 line-clamp-1 break-words text-sm text-ink-3">{a.detail}</p> : null}
                {sev.word ? <p className={`mt-0.5 text-xs font-medium ${sev.wordClass}`}>{sev.word}</p> : null}
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
