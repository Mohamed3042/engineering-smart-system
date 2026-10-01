/**
 * Evidence: the exact source sentence next to the decision it supports.
 * "Verified" means the quote was found word for word in the source — it verifies extraction,
 * not engineering adequacy.
 */
import { CircleCheck, CircleHelp, FileText, Mail, Quote } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { Evidence } from "@/api/types";
import { cn } from "@/lib/cn";
import { isRtl } from "@/lib/format";
import { Tooltip } from "./Overlay";

function sourceIcon(type?: string) {
  if (type === "email") return <Mail aria-hidden />;
  if (type === "file") return <FileText aria-hidden />;
  return <Quote aria-hidden />;
}

/** Default link for an evidence source (email detail or file viewer). */
export function evidenceHref(e: Evidence): string | null {
  if (!e.source_id) return null;
  if (e.source_type === "email") return `/inbox/${encodeURIComponent(e.source_id)}`;
  if (e.source_type === "file") return `/files/${encodeURIComponent(e.source_id)}${e.page ? `?page=${e.page}` : ""}`;
  if (e.url) return e.url;
  return null;
}

export function sourceLabel(e: Evidence): string {
  const where = [e.source_label, e.page ? `p${e.page}` : null, e.sheet ? `${e.sheet}${e.cell ? `!${e.cell}` : ""}` : null]
    .filter(Boolean)
    .join(" · ");
  if (where) return where;
  return e.source_type === "email" ? "Email" : e.source_type === "file" ? "File" : "Source";
}

export function VerifiedMark({ verified }: { verified?: boolean }) {
  if (verified === undefined) return null;
  return verified ? (
    <Tooltip content="Quote found word for word in the source">
      <span className="inline-flex items-center gap-1 text-xs font-medium text-brand-ink">
        <CircleCheck className="size-3.5" aria-hidden />
        Source found
      </span>
    </Tooltip>
  ) : (
    <Tooltip content="This quote was not found in the source. Check it before you rely on it.">
      <span className="inline-flex items-center gap-1 text-xs font-medium text-review">
        <CircleHelp className="size-3.5" aria-hidden />
        Not found in source
      </span>
    </Tooltip>
  );
}

export function EvidenceQuote({
  evidence,
  className,
  href,
  action,
}: {
  evidence: Evidence;
  className?: string;
  /** Override the source link (default: email / file viewer). */
  href?: string | null;
  action?: ReactNode;
}) {
  const link = href === undefined ? evidenceHref(evidence) : href;
  const quote = evidence.quote ?? "";
  const external = link?.startsWith("http");
  return (
    <figure className={cn("rounded-lg border border-line bg-sunken px-3.5 py-2.5", className)}>
      {quote ? (
        <blockquote dir={isRtl(quote) ? "rtl" : "auto"} className="text-sm leading-relaxed text-ink">
          “{quote}”
        </blockquote>
      ) : null}
      <figcaption className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
        <span className="inline-flex items-center gap-1.5 [&_svg]:size-3.5">
          {sourceIcon(evidence.source_type)}
          {link ? (
            external ? (
              <a href={link} target="_blank" rel="noreferrer" className="font-medium text-brand-ink hover:underline">
                {sourceLabel(evidence)}
              </a>
            ) : (
              <Link to={link} className="font-medium text-brand-ink hover:underline">
                {sourceLabel(evidence)}
              </Link>
            )
          ) : (
            sourceLabel(evidence)
          )}
        </span>
        <VerifiedMark verified={evidence.verified} />
        {action ? <span className="ml-auto">{action}</span> : null}
      </figcaption>
    </figure>
  );
}

export function EvidenceList({ items, empty = "No source quoted.", className }: { items?: Evidence[] | null; empty?: ReactNode; className?: string }) {
  if (!items || items.length === 0) return <p className={cn("text-sm text-ink-3", className)}>{empty}</p>;
  return (
    <div className={cn("space-y-2", className)}>
      {items.map((e, i) => (
        <EvidenceQuote key={i} evidence={e} />
      ))}
    </div>
  );
}
