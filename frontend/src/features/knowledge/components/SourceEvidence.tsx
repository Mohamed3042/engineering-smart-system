/**
 * Evidence for a business finding: the exact sentence, where it came from, and how much that kind
 * of source counts. Web pages are labelled "context only": they never prove a finding.
 */
import { FileText, Globe, Mail, Quote, UserRound } from "lucide-react";
import type { Evidence } from "@/api/types";
import { cn } from "@/lib/cn";
import { Chip, EvidenceQuote, Tooltip } from "@/ui";
import { evidenceGroups, evidenceLink, evidenceWeight, formatWeight, sortEvidence, sourceInfo } from "../model";

function SourceIcon({ type, className }: { type?: string; className?: string }) {
  const cls = cn("size-3.5 shrink-0", className);
  if (type === "sent_email" || type === "inbound_email" || type === "email") return <Mail className={cls} aria-hidden />;
  if (type === "web") return <Globe className={cls} aria-hidden />;
  if (type === "owner") return <UserRound className={cls} aria-hidden />;
  if (type === "own_quotation" || type === "quotation_corpus" || type === "company_doc") return <FileText className={cls} aria-hidden />;
  return <Quote className={cls} aria-hidden />;
}

/** "Own quotation · weight 1.0" or "Web page · context only". */
export function SourceTypeChip({ evidence }: { evidence: Evidence }) {
  const info = sourceInfo(evidence.source_type);
  const weight = evidenceWeight(evidence);
  return (
    <Tooltip
      content={
        info.contextOnly
          ? "Web pages give context only. They never count as proof of what you do."
          : `This kind of source counts ${formatWeight(weight)} (own quotations count 1.0).`
      }
    >
      <span className="inline-flex">
        <Chip size="sm" tone={info.contextOnly ? "muted" : "neutral"} icon={<SourceIcon type={evidence.source_type} />}>
          {info.label} · {info.contextOnly ? "context only" : `weight ${formatWeight(weight)}`}
        </Chip>
      </span>
    </Tooltip>
  );
}

/** One line: "3 sources: Own quotations ×2 · Received mail ×1". */
export function EvidenceSummary({ evidence, className }: { evidence: Evidence[] | null | undefined; className?: string }) {
  const groups = evidenceGroups(evidence);
  if (groups.length === 0) return <p className={cn("text-sm text-ink-3", className)}>No source quoted</p>;
  return (
    <p className={cn("flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-ink-2", className)}>
      {groups.map((g) => (
        <span key={g.info.plural} className="inline-flex items-center gap-1.5">
          <SourceIcon type={g.type} className="text-ink-3" />
          <span>
            {g.info.plural}
            {g.count > 1 ? <span className="tabular text-ink-3"> ×{g.count}</span> : null}
            {g.info.contextOnly ? <span className="text-ink-3"> (context only)</span> : null}
          </span>
        </span>
      ))}
    </p>
  );
}

/** The quotes, strongest source first. */
export function EvidenceDetails({
  evidence,
  limit,
  className,
}: {
  evidence: Evidence[] | null | undefined;
  limit?: number;
  className?: string;
}) {
  const sorted = sortEvidence(evidence);
  if (sorted.length === 0) return <p className={cn("text-sm text-ink-3", className)}>No source quoted.</p>;
  const shown = limit ? sorted.slice(0, limit) : sorted;
  return (
    <div className={cn("space-y-2", className)}>
      {shown.map((e, i) => (
        <EvidenceQuote key={i} evidence={e} href={evidenceLink(e)} action={<SourceTypeChip evidence={e} />} />
      ))}
      {limit && sorted.length > limit ? (
        <p className="text-xs text-ink-3">
          {sorted.length - limit} more {sorted.length - limit === 1 ? "source" : "sources"}
        </p>
      ) : null}
    </div>
  );
}
