import { CircleAlert, Clock } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { StatusInfo, Tone } from "@/lib/labels";

const chipTones: Record<Tone, string> = {
  neutral: "bg-hover text-ink-2",
  brand: "bg-brand-soft text-brand-ink",
  review: "bg-review-soft text-review",
  block: "bg-block-soft text-block",
  muted: "bg-sunken text-ink-3",
};

export interface ChipProps {
  tone?: Tone;
  icon?: ReactNode;
  children: ReactNode;
  size?: "sm" | "md";
  className?: string;
  title?: string;
}

/** Status / label chip. Amber = waits on a person, red = blocker, teal = done. */
export function Chip({ tone = "neutral", icon, children, size = "md", className, title }: ChipProps) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-md font-medium",
        size === "sm" ? "px-1.5 py-0.5 text-xs [&_svg]:size-3.5" : "px-2 py-1 text-sm [&_svg]:size-4",
        chipTones[tone],
        className,
      )}
    >
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** Chip from a StatusInfo; review and block tones get their icon so colour is never the only signal. */
export function StatusChip({ info, size, className, icon }: { info: StatusInfo; size?: "sm" | "md"; className?: string; icon?: ReactNode }) {
  const auto =
    icon ?? (info.tone === "review" ? <Clock aria-hidden /> : info.tone === "block" ? <CircleAlert aria-hidden /> : null);
  return (
    <Chip tone={info.tone} size={size} icon={auto} className={className}>
      {info.label}
    </Chip>
  );
}

/** Small round count next to a tab label. */
export function Count({ value, tone = "neutral", className }: { value: number | string; tone?: Tone; className?: string }) {
  return (
    <span
      className={cn(
        "inline-grid h-6 min-w-6 place-items-center rounded-full px-1.5 text-xs font-semibold tabular",
        tone === "review"
          ? "bg-review-soft text-review"
          : tone === "block"
            ? "bg-block-soft text-block"
            : tone === "brand"
              ? "bg-brand-soft text-brand-ink"
              : "bg-hover text-ink-2",
        className,
      )}
    >
      {value}
    </span>
  );
}

const dotTones: Record<Tone, string> = {
  neutral: "bg-ink-3",
  brand: "bg-brand",
  review: "bg-review-mark",
  block: "bg-block",
  muted: "bg-line-strong",
};

export function Dot({ tone = "neutral", className, label }: { tone?: Tone; className?: string; label?: string }) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("inline-block size-2 shrink-0 rounded-full", dotTones[tone], className)}
    />
  );
}


/** Confidence as a short meter with the number (0..1). */
export function Confidence({ value, className }: { value: number | null | undefined; className?: string }) {
  if (value === null || value === undefined) return <span className="text-ink-3">—</span>;
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const tone = pct >= 80 ? "bg-brand" : pct >= 55 ? "bg-review-mark" : "bg-block";
  return (
    <span className={cn("inline-flex items-center gap-2 text-sm text-ink-2 tabular", className)} title={`Confidence ${pct}%`}>
      <span className="relative h-1.5 w-12 overflow-hidden rounded-full bg-hover" aria-hidden>
        <span className={cn("absolute inset-y-0 left-0 rounded-full", tone)} style={{ width: `${pct}%` }} />
      </span>
      {pct}%
    </span>
  );
}
