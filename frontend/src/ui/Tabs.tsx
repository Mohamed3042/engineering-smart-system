/**
 * Tabs: underline tabs with counts (in-page state or URL-driven) and a segmented control.
 */
import { Tabs as T, ToggleGroup } from "radix-ui";
import type { ReactNode } from "react";
import { NavLink } from "react-router";
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
      <T.List aria-label={label} className="flex gap-6 overflow-x-auto border-b border-line [scrollbar-width:none]">
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
  return (
    <nav aria-label={label} className={cn("flex gap-6 overflow-x-auto border-b border-line [scrollbar-width:none]", className)}>
      {tabs.map((t) => (
        <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => cn(tabCls, isActive && activeCls)}>
          {t.label}
          {t.count !== undefined ? <Count value={t.count} tone={t.countTone} /> : null}
        </NavLink>
      ))}
    </nav>
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
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(v) => v && onChange(v)}
      aria-label={label}
      className={cn("inline-flex max-w-full overflow-x-auto rounded-lg border border-line bg-sunken p-1 [scrollbar-width:none]", className)}
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
