/**
 * File viewer (mockups 20, 78): page images with a pager (?page=), extracted text, BOQ rows with
 * their source sheet and row, drawing findings, and the three separate facts. Marking reviewed
 * confirms a person read the file; it does not approve design or prices.
 */
import { ChevronLeft, ChevronRight, Download, FileQuestion, Mail, RefreshCw, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import type { ProjectFile } from "@/api/types";
import { cn } from "@/lib/cn";
import { formatBytes, formatDate, isRtl } from "@/lib/format";
import { docKindLabel, fileSourceLabel } from "@/lib/labels";
import { emailHref, projectHref } from "@/lib/routes";
import {
  Button,
  EmptyState,
  KeyValue,
  Page,
  PageHeader,
  Panel,
  PanelBody,
  PanelHeader,
  QueryState,
  Skeleton,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/ui";
import { useFile, useFileText, useProject } from "./api";
import {
  boqRows,
  boqSource,
  DrawingFindings,
  drawingPages,
  fileContentUrl,
  FileFacts,
  MarkReviewedDialog,
  QtyValue,
} from "./fileParts";
import { Bidi, NotFoundOrError, PanelSkeleton } from "./parts";

export function FilePage() {
  const { fileId = "" } = useParams();
  const query = useFile(fileId);
  if (query.isLoading) {
    return (
      <Page>
        <div className="mb-8 space-y-3" role="status" aria-label="Loading file">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-9 w-[28rem] max-w-full" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <PanelSkeleton lines={10} />
          <PanelSkeleton lines={5} />
        </div>
      </Page>
    );
  }
  if (query.isError || !query.data) return <NotFoundOrError error={query.error} onRetry={() => query.refetch()} what="file" />;
  return <FileView file={query.data} />;
}

const isPdf = (f: ProjectFile) => /pdf/i.test(f.mime) || /\.pdf$/i.test(f.name);
const isImage = (f: ProjectFile) => f.mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name);

function FileView({ file }: { file: ProjectFile }) {
  const project = useProject(file.project_id);
  const [params, setParams] = useSearchParams();
  const [reviewing, setReviewing] = useState(false);
  const ready = file.status === "ready";
  const total = file.pages || 0;
  const asked = Math.max(1, Math.floor(Number(params.get("page")) || 1));
  const page = total ? Math.min(asked, total) : asked;
  const setPage = (n: number) => {
    const next = new URLSearchParams(params);
    next.set("page", String(n));
    setParams(next, { replace: true });
  };
  const finding = drawingPages(file).find((d) => d.page === page)?.finding;
  const boq = boqRows(file);
  const email = file.email_id ? project.data?.emails.find((e) => e.id === file.email_id) : undefined;
  const projectName = project.data?.project.name;

  return (
    <Page>
      <PageHeader
        back={{ to: projectHref(file.project_id, "inputs"), label: projectName ? `${projectName} · Inputs` : "Project inputs" }}
        title={<Bidi text={file.name} className="break-all" />}
        status={<FileFacts file={file} />}
        meta={[docKindLabel(file.doc_kind), file.size ? formatBytes(file.size) : null, total ? `${total} pages` : null, fileSourceLabel(file.source)]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <>
            {ready ? (
              <Button asChild variant="secondary" className="flex-1 md:flex-none">
                <a href={fileContentUrl(file.id)} download>
                  <Download aria-hidden />
                  Download original
                </a>
              </Button>
            ) : null}
            {!file.reviewed_by ? (
              <Button icon={<ShieldCheck />} className="flex-1 md:flex-none" disabled={!ready} onClick={() => setReviewing(true)}>
                Mark reviewed
              </Button>
            ) : null}
            {!ready && !file.reviewed_by ? (
              <p className="w-full text-sm text-ink-3 md:text-right">Download the file before marking it reviewed.</p>
            ) : null}
          </>
        }
      />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <PageViewer file={file} page={page} total={total} onPage={setPage} />
          {boq.length ? <BoqPanel file={file} /> : null}
          <TextPanel file={file} />
        </div>
        <div className="space-y-6">
          <Panel>
            <PanelHeader title="Facts" />
            <PanelBody className="space-y-4">
              <FileFacts file={file} labelled />
              <KeyValue
                labelWidth="sm"
                items={[
                  { label: "Document kind", value: docKindLabel(file.doc_kind) },
                  {
                    label: "Source",
                    value: fileSourceLabel(file.source),
                    hint: email ? (
                      <Link to={emailHref(email.id)} className="text-brand-ink hover:underline">
                        <Mail className="mr-1 inline size-3.5" aria-hidden />
                        <Bidi text={`${email.from_name || email.from_email}${email.date ? ` · ${formatDate(email.date)}` : ""}`} />
                      </Link>
                    ) : file.source_url ? (
                      <a href={file.source_url} target="_blank" rel="noreferrer noopener" className="break-all text-brand-ink hover:underline">
                        {file.source_url}
                      </a>
                    ) : undefined,
                  },
                  { label: "Size", value: file.size ? formatBytes(file.size) : null },
                  { label: "Pages", value: total ? String(total) : null },
                  { label: "Added", value: formatDate(file.created_at) },
                ]}
              />
              <Warnings file={file} />
              <p className="border-t border-line pt-3 text-sm text-ink-3">
                Marking reviewed confirms you read this file. It does not approve the design, the quantities or prices.
              </p>
            </PanelBody>
          </Panel>
          {finding ? (
            <Panel>
              <PanelHeader
                title={`Drawing findings · page ${page}`}
                description="Read from the sheet by the AI engine. Nothing was measured; dimensions need engineer verification."
              />
              <PanelBody>
                <DrawingFindings finding={finding} />
              </PanelBody>
            </Panel>
          ) : null}
        </div>
      </div>

      <MarkReviewedDialog file={reviewing ? file : null} onClose={() => setReviewing(false)} />
    </Page>
  );
}

function Warnings({ file }: { file: ProjectFile }) {
  const warnings = Array.isArray(file.extraction?.warnings) ? (file.extraction.warnings as unknown[]).map(String) : [];
  if (!warnings.length) return null;
  return (
    <div>
      <p className="text-sm text-ink-3">Reading warnings</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-ink-2">
        {warnings.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ pages */

function PageViewer({ file, page, total, onPage }: { file: ProjectFile; page: number; total: number; onPage: (n: number) => void }) {
  const [failed, setFailed] = useState<number | null>(null);
  const [loaded, setLoaded] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);

  if (file.status !== "ready") {
    return (
      <Panel>
        <EmptyState
          compact
          icon={<FileQuestion />}
          title="Not downloaded yet"
          action={
            <Button asChild variant="secondary">
              <Link to={projectHref(file.project_id, "inputs")}>Fix it under Inputs</Link>
            </Button>
          }
        >
          The page view and the extracted text appear once the file is in the project.
        </EmptyState>
      </Panel>
    );
  }
  if (isImage(file)) {
    return (
      <Panel className="overflow-hidden">
        <div className="bg-sunken p-2 sm:p-4">
          <img src={fileContentUrl(file.id)} alt={file.name} className="mx-auto h-auto w-full max-w-full bg-surface" />
        </div>
      </Panel>
    );
  }
  if (!isPdf(file)) {
    return (
      <Panel>
        <EmptyState compact icon={<FileQuestion />} title="No page view for this file type">
          Spreadsheets and documents show their extracted text and BOQ rows below. Download the original to open it.
        </EmptyState>
      </Panel>
    );
  }

  const src = `/api/files/${encodeURIComponent(file.id)}/pages/${page}.png${attempt ? `?retry=${attempt}` : ""}`;
  return (
    <Panel className="overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <Button size="sm" variant="ghost" icon={<ChevronLeft />} disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <p className="text-sm text-ink-2 tabular" aria-live="polite">
          Page {page}
          {total ? ` of ${total}` : ""}
        </p>
        <Button
          size="sm"
          variant="ghost"
          iconRight={<ChevronRight />}
          disabled={(!!total && page >= total) || failed === page}
          onClick={() => onPage(page + 1)}
        >
          Next
        </Button>
      </div>
      <div className="bg-sunken p-2 sm:p-4">
        {failed === page ? (
          <EmptyState
            compact
            title="This page could not be shown"
            action={
              <Button
                variant="secondary"
                icon={<RefreshCw />}
                onClick={() => {
                  setFailed(null);
                  setAttempt((a) => a + 1);
                }}
              >
                Try again
              </Button>
            }
          >
            The page image did not render. Download the original to view it.
          </EmptyState>
        ) : (
          <div className="relative">
            {loaded !== page ? <Skeleton className="absolute inset-0 h-full min-h-[60vh] w-full" /> : null}
            <img
              key={src}
              src={src}
              alt={`Page ${page} of ${file.name}`}
              className={cn("relative mx-auto h-auto w-full max-w-full bg-surface shadow-panel", loaded !== page && "min-h-[60vh] opacity-0")}
              onLoad={() => setLoaded(page)}
              onError={() => setFailed(page)}
            />
          </div>
        )}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ BOQ */

function BoqPanel({ file }: { file: ProjectFile }) {
  const rows = boqRows(file);
  const all = typeof file.extraction?.boq_items === "number" ? (file.extraction.boq_items as number) : null;
  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title={`BOQ rows (${rows.length})`}
        description={`${all !== null ? `${rows.length} of ${all} rows match the company's services. ` : ""}Quantities exactly as the file states them. Rates and prices are not read.`}
      />
      <div className="hidden md:block">
        <Table>
          <THead>
            <tr>
              <TH>Item</TH>
              <TH>Description</TH>
              <TH className="text-right">Quantity</TH>
              <TH>Unit</TH>
              <TH>Source</TH>
            </tr>
          </THead>
          <TBody>
            {rows.map((r, i) => (
              <TR key={i}>
                <TD className="whitespace-nowrap font-mono text-sm text-ink-2">{r.ref || "—"}</TD>
                <TD>
                  <Bidi text={r.description || "—"} as="p" className="text-ink" />
                  {r.section ? <Bidi text={r.section} as="p" className="mt-0.5 text-xs text-ink-3" /> : null}
                </TD>
                <TD className="text-right">
                  <QtyValue qty={r.qty} text={r.qty_text} />
                </TD>
                <TD>{r.unit || <span className="text-ink-3">—</span>}</TD>
                <TD className="whitespace-nowrap text-sm text-ink-2">{boqSource(r)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>
      <ul className="divide-y divide-line md:hidden">
        {rows.map((r, i) => (
          <li key={i} className="px-5 py-4">
            <Bidi text={r.description || "—"} as="p" className="font-medium text-ink" />
            <dl className="mt-2 grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
              <dt className="text-ink-3">Item</dt>
              <dd className="font-mono text-ink-2">{r.ref || "—"}</dd>
              <dt className="text-ink-3">Quantity</dt>
              <dd>
                <QtyValue qty={r.qty} text={r.qty_text} />
              </dd>
              <dt className="text-ink-3">Unit</dt>
              <dd className="text-ink">{r.unit || "—"}</dd>
              <dt className="text-ink-3">Source</dt>
              <dd className="text-ink-2">{boqSource(r)}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/* ------------------------------------------------------------------ text */

function TextPanel({ file }: { file: ProjectFile }) {
  const ready = file.status === "ready";
  const text = useFileText(file.id, ready);
  const [all, setAll] = useState(false);
  const emptyText =
    file.extraction_status === "pending"
      ? "This file has not been read yet. Use Extract files on the project's Analysis tab."
      : file.extraction_status === "not_supported"
        ? "Scanned drawings and images have no text layer to read."
        : file.extraction_status === "failed"
          ? `Reading failed${file.error ? `: ${file.error}` : "."}`
          : "No text was found in this file.";
  return (
    <Panel>
      <PanelHeader
        title="Extracted text"
        description="As read from the file. Extracted is not reviewed."
        actions={
          text.data?.text && text.data.text.length > 4000 ? (
            <Button size="sm" variant="ghost" onClick={() => setAll((v) => !v)}>
              {all ? "Show less" : "Show all"}
            </Button>
          ) : undefined
        }
      />
      {!ready ? (
        <PanelBody>
          <p className="text-sm text-ink-3">The text is read once the file is downloaded.</p>
        </PanelBody>
      ) : (
        <QueryState
          query={text}
          compact
          loading={<PanelSkeleton lines={6} className="rounded-none border-0" />}
          isEmpty={(d) => !d.text.trim()}
          empty={
            <PanelBody>
              <p className="text-sm text-ink-3">{emptyText}</p>
            </PanelBody>
          }
        >
          {(d) => (
            <PanelBody>
              <pre
                dir={isRtl(d.text) ? "rtl" : "auto"}
                className={cn(
                  "overflow-auto whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-ink-2",
                  !all && "max-h-[32rem]",
                )}
              >
                {d.text}
              </pre>
            </PanelBody>
          )}
        </QueryState>
      )}
    </Panel>
  );
}
