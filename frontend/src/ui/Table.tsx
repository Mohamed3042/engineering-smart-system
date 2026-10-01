/**
 * Tables for desktop, stacked rows for phones. Use <Table> inside a Panel; on phones render the
 * same data with <ListRow> (see ResponsiveList) because wide tables do not fit a 390px screen.
 */
import { ArrowDown, ArrowUp, ChevronRight, ChevronsUpDown } from "lucide-react";
import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { Link } from "react-router";
import { cn } from "@/lib/cn";

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("w-full overflow-x-auto", className)}>
      <table className="w-full border-collapse text-left text-base">{children}</table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return <thead className="bg-sunken text-sm text-ink-2">{children}</thead>;
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-line">{children}</tbody>;
}

export function TR({
  children,
  className,
  onClick,
  selected,
  ...rest
}: HTMLAttributes<HTMLTableRowElement> & { selected?: boolean }) {
  return (
    <tr
      onClick={onClick}
      className={cn(
        "align-top transition-colors",
        onClick ? "cursor-pointer hover:bg-canvas" : "",
        selected ? "bg-brand-soft/60" : "",
        className,
      )}
      {...rest}
    >
      {children}
    </tr>
  );
}

export type SortDir = "asc" | "desc" | null;

export function TH({
  children,
  className,
  sort,
  onSort,
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement> & { sort?: SortDir; onSort?: () => void }) {
  const content = onSort ? (
    <button
      type="button"
      onClick={onSort}
      className="inline-flex items-center gap-1.5 rounded font-medium text-ink-2 hover:text-ink"
    >
      {children}
      {sort === "asc" ? (
        <ArrowUp className="size-3.5" aria-hidden />
      ) : sort === "desc" ? (
        <ArrowDown className="size-3.5" aria-hidden />
      ) : (
        <ChevronsUpDown className="size-3.5 text-ink-3" aria-hidden />
      )}
    </button>
  ) : (
    children
  );
  return (
    <th
      scope="col"
      aria-sort={sort === "asc" ? "ascending" : sort === "desc" ? "descending" : undefined}
      className={cn("whitespace-nowrap px-4 py-3 font-medium first:pl-5 last:pr-5", className)}
      {...rest}
    >
      {content}
    </th>
  );
}

export function TD({ children, className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cn("px-4 py-4 first:pl-5 last:pr-5", className)} {...rest}>
      {children}
    </td>
  );
}

/** Row-end chevron that signals the whole row opens a detail page. */
export function RowChevron() {
  return <ChevronRight className="size-5 text-ink-3" aria-hidden />;
}

/** Phone list row: title line, optional chip, meta lines, optional action. Links when `to` is set. */
export function ListRow({
  to,
  onClick,
  leading,
  title,
  subtitle,
  aside,
  children,
  footer,
  className,
}: {
  to?: string;
  onClick?: () => void;
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const head = (
    <div className="flex items-start gap-3">
      {leading}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 text-base font-semibold text-ink">{title}</p>
          {aside}
        </div>
        {subtitle ? <p className="mt-0.5 text-sm text-ink-3">{subtitle}</p> : null}
      </div>
      {to || onClick ? <ChevronRight className="mt-0.5 size-5 shrink-0 text-ink-3" aria-hidden /> : null}
    </div>
  );
  const cls = cn("block rounded-xl border border-line bg-surface p-4 shadow-panel", className);
  return (
    <div className={cls}>
      {to ? (
        <Link to={to} className="-m-1 block rounded-lg p-1 outline-none focus-visible:ring-2 focus-visible:ring-brand">
          {head}
        </Link>
      ) : onClick ? (
        <button type="button" onClick={onClick} className="-m-1 block w-[calc(100%+0.5rem)] rounded-lg p-1 text-left">
          {head}
        </button>
      ) : (
        head
      )}
      {children ? <div className="mt-3 text-sm text-ink-2">{children}</div> : null}
      {footer ? <div className="mt-3 border-t border-line pt-3">{footer}</div> : null}
    </div>
  );
}

/** Simple pager: "1–25 of 812" with previous/next. */
export function Pager({
  offset,
  limit,
  total,
  onChange,
}: {
  offset: number;
  limit: number;
  total: number;
  onChange: (offset: number) => void;
}) {
  if (total <= limit) return null;
  const end = Math.min(offset + limit, total);
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3 text-sm text-ink-2">
      <span className="tabular">
        {offset + 1}–{end} of {total}
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={offset === 0}
          onClick={() => onChange(Math.max(0, offset - limit))}
          className="h-8 rounded-md border border-line-strong px-3 font-medium hover:bg-hover disabled:opacity-40"
        >
          Previous
        </button>
        <button
          type="button"
          disabled={end >= total}
          onClick={() => onChange(offset + limit)}
          className="h-8 rounded-md border border-line-strong px-3 font-medium hover:bg-hover disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  );
}
