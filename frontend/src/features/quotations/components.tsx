/**
 * Small building blocks shared by the quotation screens.
 */
import { useMutation } from "@tanstack/react-query";
import {
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Clock,
  FileText,
  Mail,
  MessageCircleQuestionMark,
  Quote as QuoteIcon,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Collapsible } from "radix-ui";
import { Link } from "react-router";
import { api } from "@/api/client";
import type { Evidence } from "@/api/types";
import { cn } from "@/lib/cn";
import { quotationStatusInfo } from "@/lib/labels";
import { emailHref, fileHref } from "@/lib/routes";
import { Button, Chip, EvidenceQuote, InlineError, Popover, Skeleton, StatusChip, sourceLabel } from "@/ui";
import type { Quote, TemplateInfo, TermChange } from "./api";
import { jumpTo } from "./editor/sections";
import { explainError, languageLabel, switchedOffTemplates, TEMPLATES_SETUP, TERM_STATUS, termStatus, type Gate } from "./lib";

/* ------------------------------------------------------------------ status */

export function QuoteStatusChip({ q, size }: { q: Pick<Quote, "status">; size?: "sm" | "md" }) {
  return <StatusChip info={quotationStatusInfo(q.status)} size={size} />;
}

export function ImpactChip({ q, size = "sm" }: { q: Pick<Quote, "impact_review">; size?: "sm" | "md" }) {
  if (!q.impact_review?.required) return null;
  return (
    <Chip tone="review" size={size} icon={<TriangleAlert aria-hidden />} title={String(q.impact_review.reason ?? "")}>
      Impact review
    </Chip>
  );
}

const gateIcon = {
  done: <CircleCheck className="text-brand" aria-hidden />,
  open: <CircleDashed className="text-review-mark" aria-hidden />,
  blocked: <CircleAlert className="text-block" aria-hidden />,
};

const gateWord = { done: "Done", open: "Open", blocked: "Blocked" };

const fixCls = "text-sm font-medium text-brand-ink underline-offset-4 hover:underline";

/** Checklist of what blocks approval and sending; each open item links to where it is fixed. */
export function GateList({ gates, className, compact }: { gates: Gate[]; className?: string; compact?: boolean }) {
  return (
    <ul className={cn("divide-y divide-line", className)}>
      {gates.map((g) => (
        <li key={g.key} className={cn("flex items-start gap-3", compact ? "py-2" : "py-3")}>
          <span className="mt-0.5 shrink-0 [&_svg]:size-5" title={gateWord[g.state]}>
            {gateIcon[g.state]}
            <span className="sr-only">{gateWord[g.state]}: </span>
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-ink">{g.label}</p>
            <p className="text-sm text-ink-3">{g.detail}</p>
            {g.fix ? (
              g.fix.to.startsWith("#") ? (
                // A link to a section of this page: open it if it is folded, scroll below the sticky bars, then focus.
                <a
                  href={g.fix.to}
                  onClick={(e) => {
                    e.preventDefault();
                    jumpTo(g.fix!.to.slice(1), { focus: g.fix!.focus });
                  }}
                  className={cn(fixCls, "mt-1 inline-block")}
                >
                  {g.fix.label}
                </a>
              ) : (
                <Link to={g.fix.to} className={cn(fixCls, "mt-1 inline-block")}>
                  {g.fix.label}
                </Link>
              )
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ term changes */

const termIcons = {
  pending: <Clock aria-hidden />,
  accepted: <CircleCheck aria-hidden />,
  retained: <RotateCcw aria-hidden />,
  clarification: <MessageCircleQuestionMark aria-hidden />,
};

/** Detected request vs agreed term, always in words and with an icon. */
export function TermStatusChip({ change, size }: { change: TermChange; size?: "sm" | "md" }) {
  const s = termStatus(change);
  return <StatusChip info={TERM_STATUS[s]} icon={termIcons[s]} size={size} />;
}

/* ------------------------------------------------------------------ templates switched off */

const textLink = "font-medium text-brand-ink underline-offset-4 hover:underline";

/**
 * Says which templates the company switched off for a language: they cannot be chosen, with the reason and
 * a link to where they are switched on again. `current` is the template the quotation already uses; it keeps
 * working for that quotation, but a change to it is refused (`changed`).
 */
export function SwitchedOffNote({
  templates,
  language,
  current,
  changed,
  rule,
  className,
}: {
  templates: TemplateInfo[] | undefined;
  language: string;
  current?: string | null;
  /** The template or language was changed on screen and is not saved yet. */
  changed?: boolean;
  /** The picker is in a template rule, not a quotation. */
  rule?: boolean;
  className?: string;
}) {
  const off = switchedOffTemplates(templates, language);
  if (!off.length) return null;
  const own = current ? off.find((t) => t.key === current) : undefined;
  const others = off.filter((t) => t.key !== own?.key).map((t) => t.label.en);
  const lang = languageLabel(language);
  return (
    <div className={cn("flex items-start gap-2 text-sm text-ink-2", className)}>
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-review" aria-hidden />
      <p>
        {own
          ? rule
            ? `${own.label.en} is switched off for ${lang} in Quotation setup. New quotations that match this rule use another template until it is switched on.`
            : changed
              ? `${own.label.en} is switched off for ${lang} in Quotation setup. Saving is refused until it is switched on or you choose another template.`
              : `${own.label.en} is switched off in Quotation setup. This quotation keeps it; new quotations cannot use it.`
          : null}
        {own && others.length ? " " : null}
        {others.length ? `Switched off in Quotation setup, so it cannot be chosen: ${others.join(", ")}.` : null}{" "}
        <Link to={TEMPLATES_SETUP} className={textLink}>
          Open Templates
        </Link>
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ errors */

/** A refused action in plain words, with the way to fix it; unknown errors fall back to the message. */
export function ExplainedError({
  error,
  q,
  className,
  action,
}: {
  error: unknown;
  q?: Pick<Quote, "id" | "project_id"> | null;
  className?: string;
  action?: ReactNode;
}) {
  if (!error) return null;
  const e = explainError(error, q);
  if (!e) return <InlineError error={error} className={className} />;
  return (
    <div role="alert" className={cn("rounded-lg border border-block-line bg-block-soft px-4 py-3 text-sm", className)}>
      <p className="flex items-center gap-2 font-semibold text-block">
        <CircleAlert className="size-4 shrink-0" aria-hidden />
        {e.title}
      </p>
      <p className="mt-0.5 text-ink-2">{e.message}</p>
      {e.fix || action ? (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          {e.fix ? (
            <Link to={e.fix.to} className={fixCls}>
              {e.fix.label}
            </Link>
          ) : null}
          {action}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ evidence */

export function evidenceLink(e: Evidence): string | null {
  if (!e.source_id) return e.url ?? null;
  if (e.source_type === "email") return emailHref(e.source_id);
  if (e.source_type === "file") return fileHref(e.source_id, e.page ?? undefined);
  return e.url ?? null;
}

/** Compact source link for a table cell; opens the quoted sentence in a popover. */
export function EvidenceButton({ evidence, className }: { evidence: Evidence | null; className?: string }) {
  if (!evidence) return <span className={cn("text-sm text-ink-3", className)}>—</span>;
  const label = sourceLabel(evidence);
  const Icon = evidence.source_type === "email" ? Mail : evidence.source_type === "file" ? FileText : QuoteIcon;
  return (
    <Popover
      align="start"
      className="w-[min(26rem,calc(100vw-2rem))]"
      trigger={
        <button
          type="button"
          className={cn(
            "inline-flex max-w-full items-center gap-1.5 rounded text-left text-sm font-medium text-brand-ink underline-offset-4 hover:underline",
            className,
          )}
          aria-label={`Source: ${label}. Show the quoted sentence`}
        >
          <Icon className="size-4 shrink-0" aria-hidden />
          <span className="truncate">{label}</span>
        </button>
      }
    >
      <p className="mb-2 text-xs font-medium text-ink-3">Source of this line</p>
      <EvidenceQuote evidence={evidence} href={evidenceLink(evidence)} />
      <p className="mt-2 text-xs text-ink-3">Source found verifies the extraction, not the engineering.</p>
    </Popover>
  );
}

/* ------------------------------------------------------------------ template preview */

const PREVIEW_WIDTH = 830; // 210 mm page + the preview's own margins
const PREVIEW_HEIGHT = 1180;

/** The backend's self-contained quotation HTML in a sandboxed frame, scaled to the column. */
export function HtmlPreview({ html, title, className, height = PREVIEW_HEIGHT }: { html: string; title: string; className?: string; height?: number }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const update = () => setScale(Math.min(1, el.clientWidth / PREVIEW_WIDTH));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const doc = useMemo(
    () => html.replace("</head>", "<style>body{background:#eef1f0 !important}</style></head>"),
    [html],
  );
  return (
    <div ref={wrap} className={cn("w-full overflow-hidden rounded-lg border border-line bg-hover", className)} style={{ height: height * scale }}>
      <iframe
        title={title}
        srcDoc={doc}
        sandbox="allow-scripts"
        className="origin-top-left border-0"
        style={{ width: PREVIEW_WIDTH, height, transform: `scale(${scale})` }}
      />
    </div>
  );
}

/** Live preview of an official template with a sample project (POST /api/templates/preview). */
export function TemplatePreview({
  templateKey,
  language,
  signatoryId,
  className,
  height,
}: {
  templateKey: string;
  language: string;
  signatoryId?: string | null;
  className?: string;
  height?: number;
}) {
  const preview = useMutation({
    mutationFn: (body: { template_key: string; language: string; signatory_id?: string | null }) =>
      api.post<{ html: string }>("/templates/preview", body),
  });
  const { mutate } = preview;
  useEffect(() => {
    mutate({ template_key: templateKey, language, signatory_id: signatoryId || undefined });
  }, [templateKey, language, signatoryId, mutate]);

  if (preview.isError)
    return (
      <div className={cn("rounded-lg border border-line bg-sunken p-4", className)}>
        <InlineError error={preview.error} />
        <Button
          variant="secondary"
          size="sm"
          className="mt-3"
          onClick={() => mutate({ template_key: templateKey, language, signatory_id: signatoryId || undefined })}
        >
          Try again
        </Button>
      </div>
    );
  if (!preview.data)
    return (
      <div className={cn("space-y-3 rounded-lg border border-line bg-surface p-6", className)} role="status" aria-label="Loading preview">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    );
  return (
    <div className={cn("relative", className)}>
      <HtmlPreview html={preview.data.html} title="Template preview" height={height} />
      {preview.isPending ? <span className="absolute right-3 top-3 rounded bg-surface px-2 py-1 text-xs text-ink-3 shadow-panel">Updating…</span> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ paper schematic */

/**
 * Drawn A4 sheet showing what prints: header and footer bands for a full letterhead, dashed
 * areas for pre-printed paper, the stamp position. Not a picture of the private letterhead.
 */
export function PaperSchematic({
  mode = "letterhead",
  files,
  stamp,
  className,
  label,
}: {
  mode?: string;
  files?: { header?: boolean; footer?: boolean; stamp?: boolean; watermark?: boolean };
  stamp?: { x: number; y: number; width: number; show?: boolean } | null;
  className?: string;
  label?: string;
}) {
  const pre = mode === "preprinted";
  const headerReal = !pre && files?.header !== false;
  const footerReal = !pre && files?.footer !== false;
  return (
    <svg viewBox="0 0 210 297" role="img" aria-label={label ?? (pre ? "Pre-printed paper" : "Full letterhead")} className={cn("h-auto w-full", className)}>
      <rect x="0.5" y="0.5" width="209" height="296" rx="2" className="fill-surface stroke-line-strong" strokeWidth="1" />
      {/* header */}
      <rect
        x="8"
        y="6"
        width="194"
        height="36"
        rx="1.5"
        className={headerReal ? "fill-brand-soft stroke-brand-line" : "fill-none stroke-line-strong"}
        strokeDasharray={headerReal ? undefined : "4 3"}
        strokeWidth="1"
      />
      {headerReal ? <rect x="14" y="16" width="52" height="8" rx="1" className="fill-brand/40" /> : null}
      {/* body text */}
      {[58, 66, 74, 82].map((y, i) => (
        <rect key={y} x="18" y={y} width={i === 0 ? 90 : 174 - i * 14} height="3.2" rx="1" className="fill-line" />
      ))}
      <rect x="18" y="96" width="174" height="44" rx="1.5" className="fill-sunken stroke-line" strokeWidth="0.8" />
      {[150, 158, 166].map((y, i) => (
        <rect key={y} x="18" y={y} width={160 - i * 22} height="3.2" rx="1" className="fill-line" />
      ))}
      {/* footer */}
      <rect
        x="8"
        y="262"
        width="194"
        height="28"
        rx="1.5"
        className={footerReal ? "fill-brand-soft stroke-brand-line" : "fill-none stroke-line-strong"}
        strokeDasharray={footerReal ? undefined : "4 3"}
        strokeWidth="1"
      />
      {stamp && stamp.show !== false ? (
        <circle
          cx={stamp.x + stamp.width / 2}
          cy={stamp.y + stamp.width / 2}
          r={stamp.width / 2}
          className="fill-review-soft stroke-review-mark"
          strokeWidth="1.2"
          strokeDasharray="3 2"
        />
      ) : null}
    </svg>
  );
}

/* ------------------------------------------------------------------ files */

/** A button that opens the file chooser. */
export function FileButton({
  accept,
  onFile,
  children,
  variant = "secondary",
  size = "md",
  icon,
  disabled,
  loading,
  className,
  title,
}: {
  accept?: string;
  onFile: (file: File) => void;
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
  icon?: ReactNode;
  disabled?: boolean;
  loading?: boolean;
  className?: string;
  title?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={accept}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
      <Button
        variant={variant}
        size={size}
        icon={icon}
        disabled={disabled}
        loading={loading}
        className={className}
        title={title}
        onClick={() => input.current?.click()}
      >
        {children}
      </Button>
    </>
  );
}

/**
 * Joins short facts with a middle dot. Text a person wrote (an Arabic subject, a company name) goes in
 * <bdi> by the caller, so it cannot reorder the English words around it.
 */
export function dotted(parts: (ReactNode | null | undefined | false)[]): ReactNode {
  const items = parts.filter(Boolean);
  return items.map((part, i) => (
    <Fragment key={i}>
      {i ? " · " : null}
      {part}
    </Fragment>
  ));
}

/* ------------------------------------------------------------------ disclosure */

/**
 * A heading that opens and closes its content, without a frame: for explanations and details inside a
 * card that should not be the first thing a phone shows.
 */
export function Disclosure({
  title,
  defaultOpen,
  children,
  className,
}: {
  title: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Collapsible.Root defaultOpen={defaultOpen} className={className}>
      <Collapsible.Trigger className="group flex min-h-10 w-full items-center gap-2 rounded-md py-1 text-left text-sm font-medium text-ink-2 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-brand">
        <ChevronDown aria-hidden className="size-4 shrink-0 text-ink-3 transition-transform duration-200 group-data-[state=closed]:-rotate-90" />
        {title}
      </Collapsible.Trigger>
      <Collapsible.Content className="space-y-2 pb-1 pl-6 pt-1">{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}

/* ------------------------------------------------------------------ facts */

/** Label above value; used in header fact rows (customer, project, template...). */
export function Fact({ label, children, hint, className }: { label: ReactNode; children: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <p className="text-sm text-ink-3">{label}</p>
      <div className="mt-0.5 min-w-0 break-words text-base text-ink">{children}</div>
      {hint ? <div className="mt-0.5 text-xs text-ink-3 [overflow-wrap:anywhere]">{hint}</div> : null}
    </div>
  );
}

/** "Disabled because…" line under a gated button. */
export function Reason({ children, className }: { children: ReactNode; className?: string }) {
  if (!children) return null;
  return <p className={cn("text-sm text-ink-3", className)}>{children}</p>;
}
