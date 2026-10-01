/**
 * Small pieces shared by the project screens.
 */
import {
  ArrowRight,
  CircleAlert,
  File,
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  FolderSearch,
  LoaderCircle,
  PencilRuler,
  RefreshCw,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { ApiError } from "@/api/client";
import type { Blocker, NextAction, ProjectChange, ProjectFile } from "@/api/types";
import { cn } from "@/lib/cn";
import { daysUntil, dueLabel, formatDate, isRtl } from "@/lib/format";
import { Banner, Button, Chip, EmptyState, ErrorState, Page, Skeleton, Tooltip, type ButtonProps } from "@/ui";
import { useProjectWork, type ProjectWork } from "./api";
import { formatElapsed, useElapsed } from "./hooks";
import { actionButtonLabel, actionHref, dueTone } from "./lib";

/* ------------------------------------------------------------------ text */

/** User content (names, quotes, notes): Arabic gets dir="rtl", everything else dir="auto". */
export function Bidi({
  text,
  as: As = "span",
  className,
  title,
}: {
  text: string | null | undefined;
  as?: "span" | "p" | "div";
  className?: string;
  title?: string;
}) {
  if (!text) return null;
  return (
    <As dir={isRtl(text) ? "rtl" : "auto"} className={className} title={title}>
      {text}
    </As>
  );
}

/* ------------------------------------------------------------------ due date */

const toneText: Record<string, string> = {
  block: "text-block",
  review: "text-review",
  neutral: "text-ink-3",
  muted: "text-ink-3",
  brand: "text-brand-ink",
};

/** Date with "Due in 3 days" / "5 days overdue" under it. */
export function DueDate({ value, className, inline }: { value: string | null | undefined; className?: string; inline?: boolean }) {
  if (!value) return <span className={cn("text-ink-3", className)}>No closing date</span>;
  const days = daysUntil(value);
  const label = dueLabel(value);
  const tone = dueTone(days);
  if (inline) {
    return (
      <span className={cn("tabular", className)}>
        <span className="text-ink">{formatDate(value)}</span>
        {label ? <span className={cn("ml-2 text-sm", toneText[tone])}>{label}</span> : null}
      </span>
    );
  }
  return (
    <div className={cn("tabular", className)}>
      <div className="whitespace-nowrap text-ink">{formatDate(value)}</div>
      {label ? (
        <div className={cn("flex items-center gap-1 whitespace-nowrap text-sm", toneText[tone])}>
          {tone === "block" ? <CircleAlert className="size-3.5" aria-hidden /> : null}
          {label}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ next action */

export function NextActionButton({
  projectId,
  action,
  size = "md",
  className,
  variant = "primary",
}: {
  projectId: string;
  action: NextAction | null | undefined;
  size?: ButtonProps["size"];
  className?: string;
  variant?: ButtonProps["variant"];
}) {
  const label = actionButtonLabel(action);
  if (!label) return null;
  return (
    <Button asChild size={size} variant={variant} className={className}>
      <Link to={actionHref(projectId, action)} onClick={(e) => e.stopPropagation()}>
        <Bidi text={label} className="truncate" />
        <ArrowRight aria-hidden />
      </Link>
    </Button>
  );
}

/* ------------------------------------------------------------------ chips */

/** "3 blockers" with the texts in a tooltip. */
export function BlockersChip({ blockers, size = "sm" }: { blockers: Blocker[] | null | undefined; size?: "sm" | "md" }) {
  const open = (blockers ?? []).filter((b) => !b.resolved);
  if (!open.length) return null;
  return (
    <Tooltip
      content={
        <ul className="space-y-1">
          {open.slice(0, 6).map((b, i) => (
            <li key={i} dir={isRtl(b.text) ? "rtl" : "auto"}>
              {b.text}
            </li>
          ))}
          {open.length > 6 ? <li>and {open.length - 6} more</li> : null}
        </ul>
      }
    >
      <span tabIndex={0} className="inline-flex rounded-md outline-none focus-visible:ring-2 focus-visible:ring-brand">
        <Chip tone="block" size={size} icon={<CircleAlert aria-hidden />}>
          {open.length} {open.length === 1 ? "blocker" : "blockers"}
        </Chip>
      </span>
    </Tooltip>
  );
}

export function ChangesChip({ changes, size = "sm" }: { changes: ProjectChange[] | null | undefined; size?: "sm" | "md" }) {
  const open = (changes ?? []).filter((c) => !c.acknowledged);
  if (!open.length) return null;
  return (
    <Chip tone="review" size={size} icon={<PencilRuler aria-hidden />}>
      {open.length} {open.length === 1 ? "change" : "changes"} to review
    </Chip>
  );
}

/* ------------------------------------------------------------------ background work */

function workText(w: ProjectWork): string {
  const parts: string[] = [];
  if (w.attachments) parts.push("Downloading attachments from the mailbox");
  if (w.downloads.length) {
    parts.push(w.downloads.length === 1 ? "Downloading the files of a shared link" : `Downloading the files of ${w.downloads.length} shared links`);
  }
  if (w.extracting) parts.push("Reading the files");
  if (w.analyzing) parts.push("Studying the documents");
  return parts.join(" · ");
}

/**
 * Shown while anything runs in the background for the project: what, and for how long. The screen
 * refreshes itself until the work is over; Refresh does it by hand.
 */
export function WorkStatus({ projectId, className }: { projectId: string; className?: string }) {
  const { work, since, refresh } = useProjectWork(projectId);
  const elapsed = useElapsed(since);
  const [refreshing, setRefreshing] = useState(false);
  if (!work?.busy) return null;
  const long = (elapsed ?? 0) >= 5 * 60_000;
  return (
    <Banner
      tone="neutral"
      className={className}
      icon={<LoaderCircle className="animate-spin" aria-hidden />}
      title={
        <>
          Still working…
          {elapsed !== null ? (
            <>
              {" "}
              <span aria-live="off" className="font-normal text-ink-3 tabular">
                ({formatElapsed(elapsed)})
              </span>
            </>
          ) : null}
        </>
      }
      actions={
        <Button
          size="sm"
          variant="secondary"
          icon={<RefreshCw />}
          loading={refreshing}
          className="w-full sm:w-auto"
          onClick={async () => {
            setRefreshing(true);
            try {
              await refresh();
            } finally {
              setRefreshing(false);
            }
          }}
        >
          Refresh
        </Button>
      }
    >
      {workText(work)}.{" "}
      {long ? "This takes longer than usual. It keeps running if you leave this page." : "This page updates by itself."}
    </Banner>
  );
}

/* ------------------------------------------------------------------ files */

export function FileIcon({ file, className }: { file: Pick<ProjectFile, "name" | "mime" | "doc_kind">; className?: string }) {
  const name = file.name.toLowerCase();
  const mime = file.mime || "";
  const cls = cn("size-5 shrink-0 text-ink-3", className);
  if (/\.(xlsx?|xlsm|csv|ods)$/.test(name) || mime.includes("spreadsheet") || mime.includes("excel"))
    return <FileSpreadsheet className={cls} aria-hidden />;
  if (/\.(zip|rar|7z|tar|gz)$/.test(name) || mime.includes("zip") || mime.includes("compressed"))
    return <FileArchive className={cls} aria-hidden />;
  if (/\.(png|jpe?g|gif|webp|tiff?|bmp|heic)$/.test(name) || mime.startsWith("image/"))
    return <FileImage className={cls} aria-hidden />;
  if (/\.(pdf|docx?|txt|rtf)$/.test(name) || mime.includes("pdf") || mime.includes("word")) return <FileText className={cls} aria-hidden />;
  return <File className={cls} aria-hidden />;
}

/* ------------------------------------------------------------------ states */

export function PanelSkeleton({ lines = 4, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn("space-y-3 rounded-xl border border-line bg-surface p-5", className)} role="status" aria-label="Loading">
      <Skeleton className="h-5 w-40" />
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={cn("h-4", i % 3 === 0 ? "w-3/4" : i % 3 === 1 ? "w-1/2" : "w-2/3")} />
      ))}
    </div>
  );
}

export function NotFoundOrError({ error, onRetry, what = "project" }: { error: unknown; onRetry: () => void; what?: string }) {
  if (error instanceof ApiError && error.status === 404) {
    return (
      <Page>
        <EmptyState
          icon={<FolderSearch />}
          title={`This ${what} does not exist`}
          action={
            <Button asChild variant="secondary">
              <Link to="/projects">Back to projects</Link>
            </Button>
          }
        >
          It may have been removed, or the address is wrong.
        </EmptyState>
      </Page>
    );
  }
  return (
    <Page>
      <ErrorState error={error} onRetry={onRetry} />
    </Page>
  );
}
