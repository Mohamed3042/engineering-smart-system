import { ExternalLink } from "lucide-react";
import type { CustomerUpdate } from "@/api/types";
import { cn } from "@/lib/cn";
import { formatDate, formatRelative } from "@/lib/format";
import { Button, Dot, StatusChip } from "@/ui";
import { hostOf, updateKindInfo } from "./lib";
import { CustomerLink } from "./parts";

/** One news / project / tender item. Unread items carry a dot and bold title. */
export function UpdateItem({
  update,
  read,
  onRead,
  onUnread,
  customer,
}: {
  update: CustomerUpdate;
  read: boolean;
  onRead: () => void;
  onUnread: () => void;
  customer?: { id: string; name: string };
}) {
  const site = hostOf(update.url);
  const when = update.published_at ?? update.found_at;
  return (
    <li className={cn("flex gap-3 px-5 py-4", !read && "bg-brand-soft/25")}>
      <span className="mt-2 w-2 shrink-0">{read ? null : <Dot tone="brand" label="Unread" />}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {customer ? <CustomerLink id={customer.id} name={customer.name} tab="updates" className="text-sm" /> : null}
          <StatusChip info={updateKindInfo(update.kind)} size="sm" />
          <span className="text-xs text-ink-3 tabular" title={update.published_at ? `Published ${formatDate(update.published_at)}` : `Found ${formatDate(update.found_at)}`}>
            {update.published_at ? formatDate(when) : `Found ${formatRelative(when).toLowerCase()}`}
          </span>
        </div>
        <h3 className={cn("mt-1 break-words text-base text-ink", read ? "font-medium" : "font-semibold")}>
          {update.url ? (
            <a href={update.url} target="_blank" rel="noreferrer" onClick={onRead} className="hover:text-brand-ink hover:underline">
              {update.title || site || "Untitled item"}
              <ExternalLink className="ml-1 inline size-3.5 align-[-2px] text-ink-3" aria-hidden />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : (
            update.title || "Untitled item"
          )}
        </h3>
        {update.summary ? <p className="mt-1 line-clamp-3 max-w-[75ch] break-words text-sm text-ink-2">{update.summary}</p> : null}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
          {site ? <span>{site}</span> : null}
          {update.source && update.source !== site ? <span>via {update.source}</span> : null}
          <span className="tabular" title="How closely it relates to this company and to our services">
            Relevance {Math.round((update.relevance ?? 0) * 100)}
          </span>
          <Button variant="link" size="sm" className="ml-auto text-xs" onClick={read ? onUnread : onRead}>
            {read ? "Mark as unread" : "Mark as read"}
          </Button>
        </div>
      </div>
    </li>
  );
}
