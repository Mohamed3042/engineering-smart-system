import { CalendarDays, ChevronRight, CircleAlert, Clock, Hash } from "lucide-react";
import type { MouseEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useCategoryLabel } from "@/api/session";
import { cn } from "@/lib/cn";
import { daysUntil, dueLabel, formatDate, formatDateShort, pluralize } from "@/lib/format";
import { reviewStatusInfo, stageInfo, workTypeLabel } from "@/lib/labels";
import { nextActionHref, projectHref } from "@/lib/routes";
import { Button, Chip, Dot, ListRow, RowChevron, StatusChip, Table, TBody, TD, TH, THead, TR, Tooltip } from "@/ui";
import { useCategoryIcon } from "@/features/inbox/categoryIcon";
import {
  changeValues,
  latestChange,
  nextActionText,
  type Bucket,
  type DashboardRow,
  type SortKey,
  type SortState,
} from "./dashboard";

const stop = (e: MouseEvent) => e.stopPropagation();

/* ------------------------------------------------------------------ cells */

function LatestUpdate({ row }: { row: DashboardRow }) {
  const change = latestChange(row);
  if (!change) {
    return (
      <div className="flex gap-2.5">
        <Dot tone="muted" className="mt-2" />
        <div className="min-w-0">
          <p className="text-sm text-ink-2">No open changes</p>
          <p className="text-xs text-ink-3 tabular">Updated {formatDateShort(row.updated_at)}</p>
        </div>
      </div>
    );
  }
  const values = changeValues(change);
  const more = row.open_changes.length - 1;
  return (
    <div className="flex gap-2.5">
      <Dot tone="review" className="mt-2" label="Open change" />
      <div className="min-w-0">
        <p className="line-clamp-3 break-words text-sm font-medium text-ink" title={change.title}>
          {change.title}
        </p>
        {values ? <p className="text-sm text-ink-2 tabular">{values}</p> : null}
        <p className="text-xs text-ink-3 tabular">
          {formatDateShort(change.date)}
          {more > 0 ? ` · ${pluralize(more, "more change")}` : ""}
        </p>
      </div>
    </div>
  );
}

function BlockerLink({ row, className }: { row: DashboardRow; className?: string }) {
  const n = row.blockers.length;
  if (!n) return null;
  const list = row.blockers.slice(0, 3);
  return (
    <Tooltip
      content={
        <ul className="space-y-1">
          {list.map((b, i) => (
            <li key={i} className="line-clamp-3">
              {b.text}
            </li>
          ))}
          {n > list.length ? <li>and {n - list.length} more</li> : null}
        </ul>
      }
    >
      <Link
        to={projectHref(row.id)}
        onClick={stop}
        className={cn("inline-flex items-center gap-1.5 rounded text-sm font-medium text-block hover:underline", className)}
      >
        <CircleAlert className="size-4 shrink-0" aria-hidden />
        {pluralize(n, "blocker")}
      </Link>
    </Tooltip>
  );
}

function KeyDetails({ row }: { row: DashboardRow }) {
  const label = useCategoryLabel();
  const iconOf = useCategoryIcon();
  const Icon = iconOf(row.service_family);
  return (
    <div className="flex gap-2.5">
      <Icon className="mt-0.5 size-[18px] shrink-0 text-ink-3" aria-hidden />
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm text-ink">{label(row.service_family)}</p>
        <p className="text-sm text-ink-3">{workTypeLabel(row.work_type)}</p>
        {row.open_changes.length ? (
          <p className="flex items-center gap-1.5 pt-1 text-sm text-review">
            <Clock className="size-4 shrink-0" aria-hidden />
            {pluralize(row.open_changes.length, "open change")}
          </p>
        ) : null}
        {row.blockers.length ? (
          <div className="pt-0.5">
            <BlockerLink row={row} />
            <p className="mt-0.5 line-clamp-2 break-words text-xs text-ink-3">{row.blockers[0].text}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function StatusCell({ row }: { row: DashboardRow }) {
  const review = row.review_status && row.review_status !== "not_started" ? reviewStatusInfo(row.review_status) : null;
  return (
    <div className="space-y-1.5">
      <StatusChip info={stageInfo(row.stage)} size="sm" />
      {review ? <p className="text-xs text-ink-2">{review.label}</p> : null}
      {row.code ? <p className="font-mono text-xs text-ink-3">{row.code}</p> : null}
    </div>
  );
}

function NextAction({ row, block }: { row: DashboardRow; block?: boolean }) {
  const text = nextActionText(row.next_action);
  if (!text) return <span className="text-sm text-ink-3">—</span>;
  return (
    <div className={cn("flex flex-col gap-2", block ? "items-stretch md:items-start" : "items-start")}>
      {text.detail ? (
        <p className={cn("break-words text-sm text-ink-2", !block && "line-clamp-3")} title={text.detail}>
          {block ? <span className="font-medium text-ink">Next: </span> : null}
          {text.detail}
        </p>
      ) : null}
      <Button asChild size={block ? "md" : "sm"} className={block ? "w-full md:w-auto" : undefined}>
        <Link to={nextActionHref(row.id, row.next_action)} onClick={stop}>
          {text.button}
          <ChevronRight aria-hidden />
        </Link>
      </Button>
    </div>
  );
}

function dueTone(row: DashboardRow, bucket: Bucket): string {
  if (bucket === "completed") return "text-ink-3";
  const n = daysUntil(row.due_date);
  if (n === null) return "text-ink-3";
  if (n < 0) return "text-block";
  if (n <= 7) return "text-review";
  return "text-ink-3";
}

function DueCell({ row, bucket }: { row: DashboardRow; bucket: Bucket }) {
  if (!row.due_date) return <span className="text-sm text-ink-3">No due date</span>;
  return (
    <div>
      <p className="whitespace-nowrap text-sm text-ink tabular">{formatDate(row.due_date)}</p>
      {bucket !== "completed" ? (
        <p className={cn("whitespace-nowrap text-xs font-medium", dueTone(row, bucket))}>{dueLabel(row.due_date)}</p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ desktop table */

export function ProjectTable({
  rows,
  bucket,
  sort,
  onSort,
}: {
  rows: DashboardRow[];
  bucket: Bucket;
  sort: SortState;
  onSort: (key: SortKey) => void;
}) {
  const navigate = useNavigate();
  const dir = (key: SortKey) => (sort.key === key ? sort.dir : null);
  return (
    <Table>
      <THead>
        <tr>
          <TH sort={dir("name")} onSort={() => onSort("name")}>
            Project
          </TH>
          <TH sort={dir("update")} onSort={() => onSort("update")}>
            Latest update
          </TH>
          <TH sort={dir("details")} onSort={() => onSort("details")}>
            Key details
          </TH>
          <TH sort={dir("status")} onSort={() => onSort("status")}>
            Status
          </TH>
          <TH>Next action</TH>
          <TH sort={dir("due")} onSort={() => onSort("due")}>
            Due date
          </TH>
          <TH className="w-12">
            <span className="sr-only">Open project</span>
          </TH>
        </tr>
      </THead>
      <TBody>
        {rows.map((row) => (
          <TR key={row.id} onClick={() => navigate(projectHref(row.id))}>
            <TD className="min-w-[13rem] max-w-[19rem] px-3">
              <Link
                to={projectHref(row.id)}
                onClick={stop}
                title={row.name}
                className="line-clamp-3 break-words rounded font-semibold text-ink hover:underline"
              >
                {row.name}
              </Link>
              {row.customer ? <p className="mt-0.5 line-clamp-2 text-sm text-ink-3">{row.customer}</p> : null}
            </TD>
            <TD className="min-w-[10rem] max-w-[15rem] px-3">
              <LatestUpdate row={row} />
            </TD>
            <TD className="min-w-[10rem] max-w-[13rem] px-3">
              <KeyDetails row={row} />
            </TD>
            <TD className="px-3">
              <StatusCell row={row} />
            </TD>
            <TD className="min-w-[11rem] max-w-[16rem] px-3">
              <NextAction row={row} />
            </TD>
            <TD className="px-3">
              <DueCell row={row} bucket={bucket} />
            </TD>
            <TD className="w-12 px-3 align-middle">
              <RowChevron />
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

/* ------------------------------------------------------------------ phone / narrow cards */

function AttentionChip({ row }: { row: DashboardRow }) {
  if (row.blockers.length)
    return (
      <Chip tone="block" size="sm" icon={<CircleAlert aria-hidden />} className="shrink-0">
        {pluralize(row.blockers.length, "blocker")}
      </Chip>
    );
  if (row.open_changes.length)
    return (
      <Chip tone="review" size="sm" icon={<Clock aria-hidden />} className="shrink-0">
        {pluralize(row.open_changes.length, "open change")}
      </Chip>
    );
  return <StatusChip info={stageInfo(row.stage)} size="sm" className="shrink-0" />;
}

export function ProjectCard({ row, bucket }: { row: DashboardRow; bucket: Bucket }) {
  const label = useCategoryLabel();
  const iconOf = useCategoryIcon();
  const Icon = iconOf(row.service_family);
  const change = latestChange(row);
  const values = change ? changeValues(change) : null;
  return (
    <ListRow
      to={projectHref(row.id)}
      leading={
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-sunken text-ink-2" aria-hidden>
          <Icon className="size-5" />
        </span>
      }
      title={<span className="line-clamp-3 break-words">{row.name}</span>}
      subtitle={row.customer ?? undefined}
      aside={<AttentionChip row={row} />}
      footer={<NextAction row={row} block />}
    >
      {change ? (
        <div className="mb-3">
          <p className="font-medium text-ink">{change.title}</p>
          <p className="text-ink-2 tabular">
            {values ? `${values} · ` : ""}
            {formatDateShort(change.date)}
          </p>
        </div>
      ) : null}
      <ul className="space-y-1.5 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-ink-3">
        <li className="flex items-start gap-2">
          <Icon className="mt-0.5" aria-hidden />
          <span>
            {label(row.service_family)} · {workTypeLabel(row.work_type)}
          </span>
        </li>
        <li className="flex items-start gap-2">
          <Hash className="mt-0.5" aria-hidden />
          <span>
            {row.code ? <span className="font-mono text-xs">{row.code}</span> : null}
            {row.code ? " · " : ""}
            {stageInfo(row.stage).label}
          </span>
        </li>
        <li className="flex items-start gap-2">
          <CalendarDays className="mt-0.5" aria-hidden />
          {row.due_date ? (
            <span className="tabular">
              Due {formatDate(row.due_date)}
              {bucket !== "completed" ? <span className={cn("font-medium", dueTone(row, bucket))}> · {dueLabel(row.due_date)}</span> : null}
            </span>
          ) : (
            <span>No due date</span>
          )}
        </li>
        {row.blockers.length ? (
          <li className="flex items-start gap-2 text-block">
            <CircleAlert className="mt-0.5 !text-block" aria-hidden />
            <span className="line-clamp-2">{row.blockers[0].text}</span>
          </li>
        ) : null}
      </ul>
    </ListRow>
  );
}
