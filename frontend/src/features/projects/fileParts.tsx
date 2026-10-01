/**
 * File pieces shared by the Inputs tab, the Analysis tab and the file viewer: the three separate
 * file facts, upload, mark reviewed, and what the AI read on a drawing sheet.
 */
import { Check, Download, ExternalLink, FileSearch, Upload } from "lucide-react";
import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { api } from "@/api/client";
import { useCurrentUser } from "@/api/session";
import type { Evidence, ProjectFile } from "@/api/types";
import { cn } from "@/lib/cn";
import { formatDateShort, humanize } from "@/lib/format";
import { extractionStatusInfo, fileStatusInfo } from "@/lib/labels";
import { fileHref } from "@/lib/routes";
import {
  Button,
  ConfirmDialog,
  EvidenceQuote,
  Field,
  InlineError,
  StatusChip,
  Textarea,
  VerifiedMark,
  toastError,
  type ButtonProps,
} from "@/ui";
import { useProjectMutation, type BoqRow, type ProjectDetail } from "./api";
import { baseName, displayValue, fileReviewInfo, firstEvidence, isPdfFile, pageNumber, readableEvidence } from "./lib";
import { Bidi } from "./parts";

/* ------------------------------------------------------------------ three facts */

export function reviewedLine(f: ProjectFile): string | null {
  if (!f.reviewed_by) return null;
  return `By ${f.reviewed_by}${f.reviewed_at ? ` · ${formatDateShort(f.reviewed_at)}` : ""}`;
}

/** Transfer, extraction and human review are three separate facts: three chips, never merged. */
export function FileFacts({ file, labelled }: { file: ProjectFile; labelled?: boolean }) {
  const facts = [
    { label: "Transfer", info: fileStatusInfo(file.status), detail: file.status === "ready" ? null : file.error },
    { label: "Extraction", info: extractionStatusInfo(file.extraction_status), detail: null },
    { label: "Human review", info: fileReviewInfo(file), detail: reviewedLine(file) },
  ];
  if (!labelled) {
    return (
      <span className="flex flex-wrap gap-1.5">
        {facts.map((f) => (
          <StatusChip key={f.label} info={f.info} size="sm" />
        ))}
      </span>
    );
  }
  return (
    <dl className="grid grid-cols-[7rem_minmax(0,1fr)] items-start gap-x-3 gap-y-2.5 text-sm">
      {facts.map((f) => (
        <Fragment key={f.label}>
          <dt className="pt-0.5 text-ink-3">{f.label}</dt>
          <dd className="min-w-0">
            <StatusChip info={f.info} size="sm" />
            {f.detail ? <p className="mt-1 break-words text-xs text-ink-3">{f.detail}</p> : null}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

export const fileContentUrl = (id: string) => `/api/files/${encodeURIComponent(id)}/content`;

/** Save the original file (the backend sends it as an attachment). */
export function downloadOriginal(id: string) {
  const a = document.createElement("a");
  a.href = fileContentUrl(id);
  a.download = "";
  a.click();
}

const PICTURE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

/** The type a browser can show in a tab: a PDF or a picture. Anything else (a spreadsheet, a ZIP) is only downloaded. */
function viewableType(file: Pick<ProjectFile, "name" | "mime">): string | null {
  if (isPdfFile(file)) return "application/pdf";
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? "";
  if (/^image\/(png|jpe?g|gif|webp|bmp)$/i.test(file.mime)) return file.mime.toLowerCase();
  return PICTURE_TYPES[ext] ?? null;
}

/**
 * Open the original file in a new tab: a PDF or a picture opens in the browser's own viewer (the
 * server sends it inline), other file types are downloaded for the computer to open.
 */
export async function openOriginal(file: Pick<ProjectFile, "id" | "name" | "mime">) {
  if (!viewableType(file)) {
    downloadOriginal(file.id);
    return;
  }
  // no "noopener" feature here: with it window.open returns null even when the tab opened
  const tab = window.open(`${fileContentUrl(file.id)}?inline=1`, "_blank");
  if (tab) tab.opener = null;
  else downloadOriginal(file.id); // pop-ups blocked: save it instead
}

export function OpenOriginalButton({ file, className }: { file: ProjectFile; className?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="secondary"
      icon={<ExternalLink />}
      loading={busy}
      className={className}
      onClick={async () => {
        setBusy(true);
        try {
          await openOriginal(file);
        } finally {
          setBusy(false);
        }
      }}
    >
      Open original
    </Button>
  );
}

export function DownloadButton({ file, className }: { file: ProjectFile; className?: string }) {
  return (
    <Button asChild variant="secondary" className={className}>
      <a href={fileContentUrl(file.id)} download={file.name}>
        <Download aria-hidden />
        Download
      </a>
    </Button>
  );
}

/* ------------------------------------------------------------------ upload */

/** Opens the file picker and uploads every chosen file. ZIP files are unpacked by the backend. */
export function UploadButton({
  projectId,
  docKind,
  children = "Add files",
  variant,
  size,
  className,
}: { projectId: string; docKind?: string; children?: ReactNode } & Pick<ButtonProps, "variant" | "size" | "className">) {
  const input = useRef<HTMLInputElement>(null);
  const upload = useProjectMutation(
    async (files: File[]) => {
      const path = `/projects/${encodeURIComponent(projectId)}/files${docKind ? `?doc_kind=${encodeURIComponent(docKind)}` : ""}`;
      const failed: { name: string; error: unknown }[] = [];
      for (const file of files) {
        try {
          await api.upload<ProjectFile>(path, file);
        } catch (error) {
          failed.push({ name: file.name, error });
        }
      }
      if (failed.length === files.length) throw failed[0].error;
      return { added: files.length - failed.length, failed };
    },
    {
      projectId,
      errorTitle: "Upload failed",
      success: ({ added }) => `${added} ${added === 1 ? "file" : "files"} added. ${added === 1 ? "It is" : "They are"} being read now.`,
      onSuccess: ({ failed }) => failed.forEach((f) => toastError(f.error, `Not added: ${f.name}`)),
    },
  );
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) upload.mutate(files);
        }}
      />
      <Button
        variant={variant}
        size={size}
        className={className}
        icon={<Upload />}
        loading={upload.isPending}
        onClick={() => input.current?.click()}
      >
        {upload.isPending ? "Uploading…" : children}
      </Button>
    </>
  );
}

/* ------------------------------------------------------------------ mark reviewed */

/** "I read this document": a person's confirmation, separate from downloaded and extracted. */
export function MarkReviewedDialog({ file, onClose }: { file: ProjectFile | null; onClose: () => void }) {
  const id = useId();
  const user = useCurrentUser();
  const [note, setNote] = useState("");
  const review = useProjectMutation(
    (f: ProjectFile) =>
      api.post<ProjectFile>(`/files/${encodeURIComponent(f.id)}/review`, note.trim() ? { note: note.trim() } : {}),
    {
      invalidate: (_r, f) => [["project", f.project_id], ["file", f.id]],
      toastErrors: false,
      success: (_r, f) => `Marked as reviewed: ${f.name}`,
      onSuccess: onClose,
    },
  );
  const fileId = file?.id;
  const { reset } = review;
  useEffect(() => {
    if (fileId) {
      setNote("");
      reset();
    }
  }, [fileId, reset]);

  return (
    <ConfirmDialog
      open={!!file}
      onOpenChange={(o) => !o && onClose()}
      title="Mark this file as reviewed?"
      description="Reviewed is its own fact, separate from downloaded and extracted. Your name and the time are recorded."
      confirmLabel="Mark reviewed"
      loading={review.isPending}
      onConfirm={() => file && review.mutate(file)}
    >
      {file ? (
        <div className="space-y-4">
          <p className="text-ink">
            {user ? `${user.name}, you confirm` : "You confirm"} that you read{" "}
            <Bidi text={file.name} className="break-all font-semibold" /> in full.
          </p>
          <p className="text-sm text-ink-3">It does not approve the design, the quantities or any price.</p>
          <Field label="What you checked" optional htmlFor={`${id}-note`}>
            <Textarea
              id={`${id}-note`}
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="For example: quantities on the Items sheet match the drawing"
            />
          </Field>
          <InlineError error={review.error} />
        </div>
      ) : null}
    </ConfirmDialog>
  );
}

/* ------------------------------------------------------------------ BOQ rows */

export function boqRows(f: ProjectFile): BoqRow[] {
  const rows = f.extraction?.boq_relevant;
  return Array.isArray(rows) ? (rows as BoqRow[]) : [];
}

/** Where a BOQ row was read, and whether that place can be opened as a page. */
export interface BoqSource {
  /** Plain text: "Div 11 - Equipment · row 7" for a spreadsheet, "Page 3" for a PDF. */
  text: string;
  /** The page of a PDF the row was read from. */
  page?: number;
  /** The PDF that page belongs to: this file, or a file of the project with the same name as the one inside a ZIP. */
  target?: ProjectFile;
  /** The file inside a ZIP that the row was read from, when that is not this file. */
  from?: string;
}

export function boqSource(r: BoqRow, file: ProjectFile, siblings: ProjectFile[]): BoqSource {
  const inner = r.source ? baseName(r.source) : null;
  const sameFile = !inner || inner.toLowerCase() === file.name.toLowerCase();
  const from = sameFile ? undefined : (r.source ?? undefined);
  const page = pageNumber(r.page);
  if (page) {
    const target = sameFile ? file : siblings.find((f) => f.name.toLowerCase() === inner?.toLowerCase());
    return { text: `Page ${page}`, page, target: target && target.status === "ready" && isPdfFile(target) ? target : undefined, from };
  }
  // a spreadsheet has sheets and rows, not pages: shown as text
  const where = [r.sheet, r.row ? `row ${r.row}` : ""].filter(Boolean).join(" · ");
  return { text: where || "—", from };
}

/**
 * A page reference that opens the page: a button that shows it in the viewer of this screen, or a
 * link to the page of another file. `current` marks the page that is on screen now.
 */
export function PageRef({
  page,
  to,
  onShow,
  current,
  label,
  className,
}: {
  page: number;
  /** A link to the page of another file. */
  to?: string;
  /** Shows the page in the viewer of this screen. */
  onShow?: () => void;
  /** The viewer shows this page now. */
  current?: boolean;
  /** What the reference is for, for screen readers: "BOQ row 11.1". */
  label?: string;
  className?: string;
}) {
  const cls = cn(
    "inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-sm font-medium transition-colors",
    current ? "border-brand-line bg-brand-soft text-brand-ink" : "border-line-strong bg-surface text-brand-ink hover:bg-hover",
    className,
  );
  const content = (
    <>
      {current ? <Check className="size-3.5" aria-hidden /> : <FileSearch className="size-3.5" aria-hidden />}
      Page {page}
    </>
  );
  const about = label ? ` for ${label}` : "";
  if (to) {
    return (
      <Link to={to} className={cls} aria-label={`Open page ${page}${about}`}>
        {content}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onShow} aria-current={current ? "true" : undefined} aria-label={`${current ? "Showing" : "Show"} page ${page}${about}`} className={cls}>
      {content}
    </button>
  );
}

/** The source of a BOQ row: a page reference that opens the page for a PDF, plain text for a spreadsheet. */
export function BoqSourceCell({
  source,
  file,
  shownPage,
  onShowPage,
  label,
}: {
  source: BoqSource;
  file: ProjectFile;
  /** The page the viewer of this screen shows. */
  shownPage?: number;
  onShowPage?: (page: number) => void;
  label: string;
}) {
  return (
    <div className="min-w-0">
      {source.from ? (
        <p className="mb-1 whitespace-nowrap text-xs text-ink-3" title={source.from}>
          {baseName(source.from)}
        </p>
      ) : null}
      {source.page && source.target ? (
        source.target.id === file.id && onShowPage ? (
          <PageRef page={source.page} current={shownPage === source.page} label={label} onShow={() => onShowPage(source.page!)} />
        ) : (
          <PageRef page={source.page} label={label} to={fileHref(source.target.id, source.page)} />
        )
      ) : (
        <span className="text-sm text-ink-2">{source.text}</span>
      )}
    </div>
  );
}

/**
 * The sentence a fact came from, with its source. A source in a PDF opens that exact page
 * (fileHref(id, page)); a spreadsheet source stays visible text (its sheet, cell or row).
 */
export function SourceQuote({ evidence, detail, className }: { evidence: unknown; detail: ProjectDetail; className?: string }) {
  const first = firstEvidence(evidence);
  if (!first) return null;
  const ev = readableEvidence(first, detail.emails, detail.files);
  const file = ev.source_type === "file" ? detail.files.find((f) => f.id === ev.source_id) : undefined;
  const page = file && isPdfFile(file) ? pageNumber(ev.page) : null;
  const href = file && page ? fileHref(file.id, page) : undefined;
  return (
    <EvidenceQuote
      evidence={ev}
      href={href}
      className={className}
      action={
        href ? (
          <Button asChild size="sm" variant="secondary">
            <Link to={href}>
              <FileSearch aria-hidden />
              Open page {page}
            </Link>
          </Button>
        ) : undefined
      }
    />
  );
}

/** A project fact (requirement or scope item) whose quote was read from one file. */
export interface SourcedFact {
  key: string;
  label: string;
  value: string | null;
  evidence: Evidence;
}

/** Requirements and scope items of the project that quote this file, in the order the project lists them. */
export function factsFromFile(detail: ProjectDetail, file: ProjectFile): SourcedFact[] {
  const out: SourcedFact[] = [];
  const take = (key: string, label: string, value: string | null, raw: unknown) => {
    const first = firstEvidence(raw);
    if (!first) return;
    const evidence = readableEvidence(first, detail.emails, detail.files);
    if (evidence.source_type === "file" && evidence.source_id === file.id) out.push({ key, label, value, evidence });
  };
  (detail.project.requirements ?? []).forEach((r, i) =>
    take(`requirement-${i}`, r.label || humanize(r.field), r.value === null || r.value === undefined || r.value === "" ? null : displayValue(r.value), r.evidence),
  );
  (detail.project.scope_items ?? []).forEach((s, i) =>
    take(`scope-${i}`, s.description, s.qty === null || s.qty === undefined ? null : `${s.qty}${s.unit ? ` ${s.unit}` : ""}`, s.evidence),
  );
  return out;
}

/** A missing quantity stays visibly unknown: never 0. */
export function QtyValue({ qty, text }: { qty: unknown; text?: string | null }) {
  if (qty === null || qty === undefined || qty === "") {
    return (
      <span className="text-review">
        Not stated{text ? <span className="block text-xs text-ink-3">Cell says “{text}”</span> : null}
      </span>
    );
  }
  return <span className="tabular text-ink">{String(qty)}</span>;
}

/* ------------------------------------------------------------------ drawing findings */

interface DrawingFact {
  value?: unknown;
  unit?: string | null;
  readable?: boolean;
  name?: string;
  label?: string;
  kind?: string;
  evidence?: { location?: string | null; transcription?: string | null; verified?: boolean | null };
}

export interface DrawingFinding {
  sheet?: Record<string, DrawingFact | null | undefined>;
  building?: Record<string, DrawingFact | null | undefined>;
  levels?: DrawingFact[];
  equipment_marks?: DrawingFact[];
  unreadable?: { item?: string; location?: string | null; reason?: string }[];
  notes?: string[];
  summary?: string;
}

/** Drawing analysis stored on a file as {"<page>": finding}. */
export function drawingPages(f: ProjectFile): { page: number; finding: DrawingFinding }[] {
  return Object.entries(f.analysis ?? {})
    .filter(([k, v]) => /^\d+$/.test(k) && !!v && typeof v === "object")
    .map(([k, v]) => ({ page: Number(k), finding: v as DrawingFinding }))
    .sort((a, b) => a.page - b.page);
}

function factValue(f: DrawingFact | null | undefined): string | null {
  if (!f || f.readable === false || f.value === null || f.value === undefined || f.value === "") return null;
  return `${String(f.value)}${f.unit ? ` ${f.unit}` : ""}`;
}

function FindingRow({ label, fact }: { label: string; fact: DrawingFact }) {
  const value = factValue(fact);
  const verified = fact.evidence?.verified;
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 py-2 sm:grid-cols-[9rem_minmax(0,1fr)]">
      <dt className="text-ink-3">{label}</dt>
      <dd className="min-w-0">
        {value ? <Bidi text={value} className="text-ink" /> : <span className="text-review">Not legible</span>}
        {fact.evidence?.location ? <span className="block text-xs text-ink-3">{fact.evidence.location}</span> : null}
        {verified === true || verified === false ? <VerifiedMark verified={verified} /> : null}
      </dd>
    </div>
  );
}

/** What the AI engine read on one sheet. Unreadable values stay unreadable; nothing is measured. */
export function DrawingFindings({ finding }: { finding: DrawingFinding }) {
  const sheet = finding.sheet ?? {};
  const sheetLine = [
    factValue(sheet.title),
    factValue(sheet.drawing_number) && `No. ${factValue(sheet.drawing_number)}`,
    factValue(sheet.revision) && `Rev ${factValue(sheet.revision)}`,
    factValue(sheet.scale) && `Scale ${factValue(sheet.scale)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const building = Object.entries(finding.building ?? {}).filter((e): e is [string, DrawingFact] => !!e[1]);
  const levels = finding.levels ?? [];
  const marks = (finding.equipment_marks ?? []).map((m) => m.label || factValue(m)).filter((m): m is string => !!m);
  const unreadable = finding.unreadable ?? [];
  const notes = finding.notes ?? [];
  const empty = !sheetLine && !finding.summary && !building.length && !levels.length && !marks.length && !unreadable.length;
  if (empty) return <p className="text-sm text-ink-3">Nothing legible was reported for this sheet.</p>;
  return (
    <div className="space-y-3 text-sm">
      {sheetLine ? <Bidi text={sheetLine} as="p" className="font-medium text-ink" /> : null}
      {finding.summary ? <Bidi text={finding.summary} as="p" className="text-ink-2" /> : null}
      {building.length || levels.length ? (
        <dl className="divide-y divide-line">
          {building.map(([key, fact]) => (
            <FindingRow key={key} label={humanize(key)} fact={fact} />
          ))}
          {levels.map((l, i) => (
            <FindingRow key={`level-${i}`} label={l.name || "Level"} fact={l} />
          ))}
        </dl>
      ) : null}
      {marks.length ? (
        <p>
          <span className="text-ink-3">Equipment marks: </span>
          <Bidi text={marks.join(", ")} className="text-ink" />
        </p>
      ) : null}
      {unreadable.length ? (
        <div>
          <p className="text-ink-3">Could not be read</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-2">
            {unreadable.map((u, i) => (
              <li key={i}>
                {u.item || "Item"}
                {u.location ? ` (${u.location})` : ""}
                {u.reason ? `: ${u.reason}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {notes.length ? (
        <ul className="list-disc space-y-0.5 pl-5 text-ink-3">
          {notes.map((n, i) => (
            <li key={i}>
              <Bidi text={n} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
