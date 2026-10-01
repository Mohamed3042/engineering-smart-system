/**
 * File pieces shared by the Inputs tab, the Analysis tab and the file viewer: the three separate
 * file facts, upload, mark reviewed, and what the AI read on a drawing sheet.
 */
import { RefreshCw, Upload } from "lucide-react";
import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { api } from "@/api/client";
import { useCurrentUser } from "@/api/session";
import type { ProjectFile } from "@/api/types";
import { formatDateShort, humanize } from "@/lib/format";
import { extractionStatusInfo, fileStatusInfo } from "@/lib/labels";
import {
  Button,
  ConfirmDialog,
  Field,
  InlineError,
  StatusChip,
  Textarea,
  VerifiedMark,
  toastError,
  type ButtonProps,
} from "@/ui";
import { markBusy, useProjectMutation, type BoqRow } from "./api";
import { fileReviewInfo } from "./lib";
import { Bidi } from "./parts";

/* ------------------------------------------------------------------ three facts */

export function reviewedLine(f: ProjectFile): string | null {
  if (!f.reviewed_by) return null;
  return `By ${f.reviewed_by}${f.reviewed_at ? ` · ${formatDateShort(f.reviewed_at)}` : ""}`;
}

/** Transfer, extraction and human review are three separate facts: three chips, never merged. */
export function FileFacts({ file, labelled }: { file: ProjectFile; labelled?: boolean }) {
  const previousError = useRef<string | null>(file.error);
  useEffect(() => { if (file.error) previousError.current = file.error; }, [file.error]);
  const facts = [
    { label: "Transfer", info: fileStatusInfo(file.status), detail: file.status === "ready" ? null : file.error || (previousError.current ? `Previous attempt: ${previousError.current}` : null) },
    { label: "Extraction", info: extractionStatusInfo(file.extraction_status), detail: file.extraction_status === "failed" ? file.error || previousError.current : null },
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

/** Retrying asks the server to obtain this same file again; the original error stays visible. */
export function RetryFileButton({ file, className }: { file: ProjectFile; className?: string }) {
  const retry = useProjectMutation(async () => {
    const result = await api.post<{ started: boolean }>(`/files/${encodeURIComponent(file.id)}/retry`);
    markBusy(file.project_id);
    return result;
  }, {
    projectId: file.project_id,
    invalidate: [["file", file.id]],
    success: (r) => r.started ? `Trying ${file.name} again.` : "This file is already downloading.",
  });
  if (file.status === "ready" || file.status === "downloading" || (file.source !== "email_attachment" && !file.link_id)) return null;
  return <Button size="sm" variant="secondary" icon={<RefreshCw />} loading={retry.isPending} className={className} onClick={() => retry.mutate()}>
    {file.status === "not_downloaded" ? "Download attachment" : "Retry download"}
  </Button>;
}

export function FileTransferError({ file }: { file: ProjectFile }) {
  const previous = useRef(file.error);
  useEffect(() => { if (file.error) previous.current = file.error; }, [file.error]);
  if (file.status === "ready") return null;
  const error = file.error || (previous.current ? `Previous attempt: ${previous.current}` : null);
  return error ? <p className="mt-1 max-w-[18rem] break-words text-xs text-block">{error}</p> : null;
}

export const fileContentUrl = (id: string) => `/api/files/${encodeURIComponent(id)}/content`;

/** Save the original file (the backend sends it as an attachment). */
export function downloadOriginal(id: string) {
  const a = document.createElement("a");
  a.href = fileContentUrl(id);
  a.download = "";
  a.click();
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
      markBusy(projectId);
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

/** "Items · row 7" / "Page 3 · row 12". */
export function boqSource(r: BoqRow): string {
  const where = r.sheet || (r.page ? `Page ${r.page}` : "");
  return [where, r.row ? `row ${r.row}` : ""].filter(Boolean).join(" · ") || "—";
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
