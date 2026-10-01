/**
 * Tabs: underline tabs with counts (in-page state or URL-driven) and a segmented control.
 */
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Tabs as T, ToggleGroup } from "radix-ui";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router";
import { cn } from "@/lib/cn";
import type { Tone } from "@/lib/labels";
import { Count } from "./Badge";

export interface TabDef {
  value: string;
  label: ReactNode;
  count?: number;
  countTone?: Tone;
  disabled?: boolean;
}

const tabCls =
  "relative inline-flex h-11 shrink-0 items-center gap-2 px-1 text-base font-medium text-ink-3 outline-none transition-colors hover:text-ink " +
  "after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-transparent " +
  "focus-visible:ring-2 focus-visible:ring-brand rounded-t-md";
const activeCls = "text-brand-ink after:bg-brand";

/**
 * Horizontal scroller for tab rows: keeps the active item in view and shows a fade plus a
 * chevron on the side where more items are hidden (phones rarely fit every tab).
 */
function ScrollRow({
  children,
  className,
  activeKey,
  innerClassName,
}: {
  children: ReactNode;
  className?: string;
  /** Changes when the active item changes, so it is scrolled into view. */
  activeKey?: string;
  innerClassName: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setEdges({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const active = el.querySelector<HTMLElement>('[data-state="active"], [aria-current="page"], [data-state="on"]');
    if (active) {
      const left = active.offsetLeft - el.offsetLeft;
      const right = left + active.offsetWidth;
      if (left < el.scrollLeft + 24) el.scrollLeft = Math.max(0, left - 24);
      else if (right > el.scrollLeft + el.clientWidth - 24) el.scrollLeft = right - el.clientWidth + 24;
    }
    measure();
  }, [activeKey, measure]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);
  const nudge = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.7, behavior: "smooth" });
  const fade = "pointer-events-none absolute inset-y-0 w-10 from-canvas to-transparent";
  const btn =
    "pointer-events-auto absolute top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-full border border-line bg-surface text-ink-2 shadow-panel hover:text-ink";
  return (
    <div className={cn("relative", className)}>
      <div ref={ref} onScroll={measure} className={cn(innerClassName, "overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden")}>
        {children}
      </div>
      {edges.left ? (
        <div className={cn(fade, "left-0 bg-gradient-to-r")} aria-hidden>
          <button type="button" tabIndex={-1} onClick={() => nudge(-1)} className={cn(btn, "left-0")}>
            <ChevronLeft className="size-4" />
          </button>
        </div>
      ) : null}
      {edges.right ? (
        <div className={cn(fade, "right-0 bg-gradient-to-l")} aria-hidden>
          <button type="button" tabIndex={-1} onClick={() => nudge(1)} className={cn(btn, "right-0")}>
            <ChevronRight className="size-4" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** In-page tabs. Pass panels as children of <TabsContent>. */
export function Tabs({
  value,
  onChange,
  tabs,
  children,
  className,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  tabs: TabDef[];
  children?: ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <T.Root value={value} onValueChange={onChange} className={className}>
      <ScrollRow activeKey={value} innerClassName="border-b border-line">
        <T.List aria-label={label} className="flex w-max min-w-full gap-6">
          {tabs.map((t) => (
            <T.Trigger
              key={t.value}
              value={t.value}
              disabled={t.disabled}
              className={cn(tabCls, "data-[state=active]:text-brand-ink data-[state=active]:after:bg-brand disabled:opacity-40")}
            >
              {t.label}
              {t.count !== undefined ? <Count value={t.count} tone={t.countTone} /> : null}
            </T.Trigger>
          ))}
        </T.List>
      </ScrollRow>
      {children}
    </T.Root>
  );
}

export function TabsContent({ value, children, className }: { value: string; children: ReactNode; className?: string }) {
  return (
    <T.Content value={value} className={cn("pt-5 outline-none", className)}>
      {children}
    </T.Content>
  );
}

/** URL-driven tabs (each tab is a route). `end` matches exactly. */
export function LinkTabs({
  tabs,
  className,
  label,
}: {
  tabs: { to: string; label: ReactNode; count?: number; countTone?: Tone; end?: boolean }[];
  className?: string;
  label?: string;
}) {
  const { pathname } = useLocation();
  return (
    <ScrollRow activeKey={pathname} className={className} innerClassName="border-b border-line">
      <nav aria-label={label} className="flex w-max min-w-full gap-6">
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => cn(tabCls, isActive && activeCls)}>
            {t.label}
            {t.count !== undefined ? <Count value={t.count} tone={t.countTone} /> : null}
          </NavLink>
        ))}
      </nav>
    </ScrollRow>
  );
}

/** Segmented control (single choice), e.g. Work / Bills / Promotions / Other. */
export function Segmented({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: ReactNode; count?: number }[];
  label: string;
  className?: string;
}) {
  return (
    <ScrollRow activeKey={value} className={cn("inline-flex max-w-full align-top", className)} innerClassName="max-w-full rounded-lg border border-line bg-sunken p-1">
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(v) => v && onChange(v)}
      aria-label={label}
      className="inline-flex w-max min-w-full"
    >
      {options.map((o) => (
        <ToggleGroup.Item
          key={o.value}
          value={o.value}
          className={cn(
            "inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-medium text-ink-2 transition-colors",
            "hover:text-ink data-[state=on]:bg-surface data-[state=on]:text-ink data-[state=on]:shadow-panel",
          )}
        >
          {o.label}
          {o.count !== undefined ? <span className="text-xs text-ink-3 tabular">{o.count}</span> : null}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
    </ScrollRow>
  );
}

/** Toggle chips for filters (multi-select). */
export function FilterChips({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  options: { value: string; label: ReactNode; count?: number }[];
  label: string;
  className?: string;
}) {
  return (
    <ToggleGroup.Root
      type="multiple"
      value={value}
      onValueChange={onChange}
      aria-label={label}
      className={cn("flex flex-wrap gap-2", className)}
    >
      {options.map((o) => (
        <ToggleGroup.Item
          key={o.value}
          value={o.value}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 text-sm text-ink-2 transition-colors",
            "hover:border-ink-3 hover:text-ink data-[state=on]:border-brand data-[state=on]:bg-brand-soft data-[state=on]:text-brand-ink",
          )}
        >
          {o.label}
          {o.count !== undefined ? <span className="text-xs tabular opacity-80">{o.count}</span> : null}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
