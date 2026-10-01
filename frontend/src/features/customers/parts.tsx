/**
 * Small building blocks shared by the customer screens.
 */
import { Eye } from "lucide-react";
import { Link } from "react-router";
import { cn } from "@/lib/cn";
import { customerKindLabel } from "@/lib/labels";
import { customerHref } from "@/lib/routes";
import { Chip, Confidence, EvidenceQuote, StatusChip, Tooltip } from "@/ui";
import type { CustomerProjectRef, Tag, TagEvidence } from "./api";
import { fitInfo, profileStatusInfo, tagEvidence } from "./lib";

/** "2 suggested services" opens the customer's Suggested services tab. Words, not only colour. */
export function SuggestedLink({ customerId, count }: { customerId: string; count: number }) {
  if (!count) return null;
  return (
    <Link
      to={customerHref(customerId, "opportunities")}
      onClick={(e) => e.stopPropagation()}
      className="text-xs font-medium text-review hover:underline"
    >
      {count === 1 ? "1 suggested service" : `${count} suggested services`}
    </Link>
  );
}

export function ProfileChip({ status, size = "sm" }: { status: string | null | undefined; size?: "sm" | "md" }) {
  return <StatusChip info={profileStatusInfo(status)} size={size} />;
}

export function WatchingMark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-medium text-ink-3", className)}>
      <Eye className="size-3.5" aria-hidden />
      Watching
    </span>
  );
}

/** Kind (role) with how sure the system is. */
export function KindLabel({ kind, confidence, className }: { kind: string; confidence?: number | null; className?: string }) {
  return (
    <div className={cn("space-y-1", className)}>
      <p className="text-base text-ink">{customerKindLabel(kind || "other")}</p>
      {confidence !== undefined && confidence !== null ? <Confidence value={confidence} className="text-xs" /> : null}
    </div>
  );
}

/** First `max` tags as chips, the rest behind "+N". */
export function TagChips({ tags, max = 3, className }: { tags: Tag[]; max?: number; className?: string }) {
  if (tags.length === 0) return <span className="text-sm text-ink-3">No tags yet</span>;
  const shown = tags.slice(0, max);
  const rest = tags.slice(max);
  return (
    <div className={cn("flex min-w-0 flex-wrap gap-1.5", className)}>
      {shown.map((t, i) => (
        <Chip key={`${t.tag}-${i}`} size="sm" tone={t.source === "user" ? "brand" : "neutral"} className="max-w-[14rem]" title={t.tag}>
          {t.tag}
        </Chip>
      ))}
      {rest.length > 0 ? (
        <Tooltip content={rest.map((t) => t.tag).join(", ")}>
          <span
            tabIndex={0}
            aria-label={`${rest.length} more tags: ${rest.map((t) => t.tag).join(", ")}`}
            className="inline-flex items-center rounded-md border border-line px-1.5 py-0.5 text-xs font-medium text-ink-3 tabular outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            +{rest.length}
          </span>
        </Tooltip>
      ) : null}
    </div>
  );
}

export function FitChip({ score, size = "sm" }: { score: number; size?: "sm" | "md" }) {
  const info = fitInfo(score);
  return (
    <Chip tone={info.tone} size={size} title={`Score ${Math.round(score * 100)} of 100`}>
      {info.label}
      <span className="ml-1 font-normal tabular opacity-80">{Math.round(score * 100)}</span>
    </Chip>
  );
}

/** Evidence under a tag: quotes link to the mail or project; rule reasons read as reasons. */
export function TagEvidenceList({ items, projects }: { items: TagEvidence[] | undefined; projects?: CustomerProjectRef[] }) {
  if (!items || items.length === 0) {
    return <p className="text-sm text-ink-3">No source recorded for this tag.</p>;
  }
  return (
    <div className="space-y-2">
      {items.map((e, i) => {
        const { evidence, href, isQuote } = tagEvidence(e, projects);
        if (!isQuote) {
          return (
            <p key={i} className="rounded-lg border border-line bg-sunken px-3.5 py-2.5 text-sm text-ink-2">
              <span className="font-medium text-ink">{evidence.source_label}: </span>
              {e.quote || "—"}
            </p>
          );
        }
        return <EvidenceQuote key={i} evidence={evidence} href={href} />;
      })}
    </div>
  );
}

export function CustomerLink({
  id,
  name,
  tab,
  className,
}: {
  id: string;
  name: string;
  tab?: Parameters<typeof customerHref>[1];
  className?: string;
}) {
  return (
    <Link to={customerHref(id, tab)} className={cn("font-medium text-ink hover:text-brand-ink hover:underline", className)}>
      {name}
    </Link>
  );
}
