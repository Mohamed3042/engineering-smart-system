/**
 * Page structure: PageHeader, Panel, Section, KeyValue, Banner, Timeline, CollapsibleSection, Stepper.
 */
import { ArrowLeft, Check, ChevronDown, CircleAlert, Info, TriangleAlert } from "lucide-react";
import { Collapsible } from "radix-ui";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "@/lib/cn";
import type { Tone } from "@/lib/labels";

/* ------------------------------------------------------------------ Page header */

export interface PageHeaderProps {
  title: ReactNode;
  /** One line under the title: source mailbox, date range, reference. */
  meta?: ReactNode;
  /** Chips next to the title (status). */
  status?: ReactNode;
  actions?: ReactNode;
  back?: { to: string; label: string };
  className?: string;
}

export function PageHeader({ title, meta, status, actions, back, className }: PageHeaderProps) {
  return (
    <header className={cn("mb-6 flex flex-col gap-4 md:mb-8 md:flex-row md:items-end md:justify-between", className)}>
      <div className="min-w-0">
        {back && (
          <Link
            to={back.to}
            className="mb-3 inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-ink-3 hover:text-ink"
          >
            <ArrowLeft className="size-4" aria-hidden />
            {back.label}
          </Link>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-[1.75rem] font-bold leading-tight tracking-[-0.01em] text-ink md:text-4xl">{title}</h1>
          {status}
        </div>
        {meta ? <div className="mt-1.5 text-base text-ink-3">{meta}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2 md:justify-end">{actions}</div> : null}
    </header>
  );
}

/** Centred page container. Wide for tables, narrow for forms. */
export function Page({ children, width = "wide", className }: { children: ReactNode; width?: "wide" | "medium" | "narrow"; className?: string }) {
  return (
    <div
      className={cn(
        "mx-auto w-full px-4 pb-24 pt-5 sm:px-6 md:pb-12 md:pt-10 lg:px-10",
        width === "wide" ? "max-w-[1360px]" : width === "medium" ? "max-w-[1040px]" : "max-w-[760px]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ Panel */

export function Panel({ children, className, as: As = "section" }: { children: ReactNode; className?: string; as?: "section" | "div" | "article" }) {
  return <As className={cn("rounded-xl border border-line bg-surface shadow-panel", className)}>{children}</As>;
}

export function PanelHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4", className)}>
      <div className="min-w-0">
        <h2 className="text-lg font-semibold text-ink">{title}</h2>
        {description ? <p className="mt-0.5 text-sm text-ink-3">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function PanelBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("px-5 py-4", className)}>{children}</div>;
}

/** Heading + content without a frame. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("space-y-3", className)}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-ink">{title}</h2>
          {description ? <p className="mt-0.5 text-sm text-ink-3">{description}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ Key / value */

export interface KV {
  label: ReactNode;
  value: ReactNode;
  /** Optional note under the value (source, evidence link). */
  hint?: ReactNode;
}

/** Facts as label/value rows. Stacks on phones so long values stay readable. */
export function KeyValue({ items, className, labelWidth = "md" }: { items: KV[]; className?: string; labelWidth?: "sm" | "md" | "lg" }) {
  const w = labelWidth === "sm" ? "sm:grid-cols-[8rem_1fr]" : labelWidth === "lg" ? "sm:grid-cols-[14rem_1fr]" : "sm:grid-cols-[11rem_1fr]";
  return (
    <dl className={cn("divide-y divide-line", className)}>
      {items.map((it, i) => (
        <div key={i} className={cn("grid grid-cols-1 gap-x-6 gap-y-0.5 py-2.5", w)}>
          <dt className="text-sm text-ink-3">{it.label}</dt>
          <dd className="min-w-0 break-words text-base text-ink">
            {it.value ?? <span className="text-ink-3">—</span>}
            {it.hint ? <div className="mt-0.5 text-xs text-ink-3">{it.hint}</div> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* ------------------------------------------------------------------ Banner */

const bannerTones: Record<Exclude<Tone, "muted">, { box: string; icon: ReactNode }> = {
  review: { box: "border-review-line bg-review-soft text-review", icon: <TriangleAlert aria-hidden /> },
  block: { box: "border-block-line bg-block-soft text-block", icon: <CircleAlert aria-hidden /> },
  brand: { box: "border-brand-line bg-brand-soft text-brand-ink", icon: <Check aria-hidden /> },
  neutral: { box: "border-line bg-sunken text-ink-2", icon: <Info aria-hidden /> },
};

export function Banner({
  tone = "neutral",
  title,
  children,
  actions,
  icon,
  className,
}: {
  tone?: Exclude<Tone, "muted">;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  const t = bannerTones[tone];
  return (
    <div
      role={tone === "block" ? "alert" : "status"}
      className={cn("flex flex-col gap-3 rounded-lg border px-4 py-3 sm:flex-row sm:items-center", t.box, className)}
    >
      <div className="flex min-w-0 flex-1 gap-3">
        <span className="mt-0.5 shrink-0 [&_svg]:size-5">{icon ?? t.icon}</span>
        <div className="min-w-0">
          <p className="font-semibold">{title}</p>
          {children ? <div className="mt-0.5 text-sm text-ink-2">{children}</div> : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2 sm:ml-auto">{actions}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ Timeline */

export interface TimelineItem {
  title: ReactNode;
  when?: ReactNode;
  detail?: ReactNode;
  tone?: Tone;
  icon?: ReactNode;
}

export function Timeline({ items, className }: { items: TimelineItem[]; className?: string }) {
  return (
    <ol className={cn("relative", className)}>
      {items.map((it, i) => (
        <li key={i} className="relative flex gap-3 pb-5 last:pb-0">
          {i < items.length - 1 && <span aria-hidden className="absolute left-[11px] top-6 bottom-0 w-px bg-line" />}
          <span
            aria-hidden
            className={cn(
              "relative z-[1] mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border-2 bg-surface [&_svg]:size-3.5",
              it.tone === "review"
                ? "border-review-mark text-review"
                : it.tone === "block"
                  ? "border-block text-block"
                  : it.tone === "brand"
                    ? "border-brand bg-brand text-white"
                    : "border-line-strong text-ink-3",
            )}
          >
            {it.icon}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <p className="font-medium text-ink">{it.title}</p>
              {it.when ? <p className="text-xs text-ink-3 tabular">{it.when}</p> : null}
            </div>
            {it.detail ? <div className="mt-0.5 text-sm text-ink-2">{it.detail}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/* ------------------------------------------------------------------ Collapsible */

export function CollapsibleSection({
  title,
  summary,
  defaultOpen = false,
  children,
  actions,
  className,
}: {
  title: ReactNode;
  /** Shown on the header row while closed (count, short status). */
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className={cn("rounded-xl border border-line bg-surface", className)}>
      <div className="flex items-center gap-2 pr-3">
        <Collapsible.Trigger className="flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-xl px-5 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand">
          <ChevronDown
            aria-hidden
            className={cn("size-5 shrink-0 text-ink-3 transition-transform duration-200", open ? "rotate-0" : "-rotate-90")}
          />
          <span className="font-semibold text-ink">{title}</span>
          {summary ? <span className="min-w-0 truncate text-sm text-ink-3">{summary}</span> : null}
        </Collapsible.Trigger>
        {actions}
      </div>
      <Collapsible.Content className="border-t border-line px-5 py-4">{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}

/* ------------------------------------------------------------------ Stepper */

export interface Step {
  key: string;
  label: string;
  hint?: string;
}

/** Wizard progress. Vertical list on wide screens, "Step 3 of 10" bar on phones. */
export function Stepper({ steps, current, done, onSelect }: { steps: Step[]; current: string; done: Set<string>; onSelect?: (key: string) => void }) {
  const idx = Math.max(0, steps.findIndex((s) => s.key === current));
  return (
    <>
      <div className="lg:hidden">
        <p className="text-sm font-medium text-ink-2">
          Step {idx + 1} of {steps.length} · <span className="text-ink">{steps[idx]?.label}</span>
        </p>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-hover" aria-hidden>
          <div className="h-full rounded-full bg-brand transition-[width] duration-300" style={{ width: `${((idx + 1) / steps.length) * 100}%` }} />
        </div>
      </div>
      <ol className="hidden space-y-1 lg:block" aria-label="Setup steps">
        {steps.map((s, i) => {
          const isDone = done.has(s.key);
          const isCurrent = s.key === current;
          const clickable = onSelect && (isDone || i <= idx);
          return (
            <li key={s.key}>
              <button
                type="button"
                disabled={!clickable}
                onClick={() => clickable && onSelect?.(s.key)}
                aria-current={isCurrent ? "step" : undefined}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                  isCurrent ? "bg-brand-soft font-semibold text-brand-ink" : "text-ink-2",
                  clickable && !isCurrent ? "hover:bg-hover" : "",
                  !clickable ? "cursor-default" : "",
                )}
              >
                <span
                  className={cn(
                    "grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold tabular",
                    isDone ? "bg-brand text-white" : isCurrent ? "border-2 border-brand text-brand-ink" : "border border-line-strong text-ink-3",
                  )}
                >
                  {isDone ? <Check className="size-3.5" aria-hidden /> : i + 1}
                </span>
                <span className="min-w-0">
                  <span className="block truncate">{s.label}</span>
                  {s.hint && isCurrent ? <span className="block text-xs font-normal text-ink-3">{s.hint}</span> : null}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </>
  );
}

/* ------------------------------------------------------------------ Progress */

export function ProgressBar({ value, tone = "brand", label, className }: { value: number; tone?: Tone; label?: string; className?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className={className}>
      <div
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        className="h-2 overflow-hidden rounded-full bg-hover"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-300 ease-out",
            tone === "review" ? "bg-review-mark" : tone === "block" ? "bg-block" : "bg-brand",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function Avatar({ name, initials: given, size = "md", className }: { name?: string | null; initials?: string; size?: "sm" | "md" | "lg"; className?: string }) {
  const text = given || (name ? name.trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase() : "?");
  return (
    <span
      aria-hidden
      className={cn(
        "inline-grid shrink-0 place-items-center rounded-full bg-brand-soft font-semibold text-brand-ink",
        size === "sm" ? "size-7 text-xs" : size === "lg" ? "size-12 text-base" : "size-9 text-sm",
        className,
      )}
    >
      {text}
    </span>
  );
}
