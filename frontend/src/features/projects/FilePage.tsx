/**
 * File viewer (mockups 20, 78): the page image with zoom, full screen and page controls (?page=N),
 * and beside it the facts read from the file: BOQ rows and project facts with the page they came
 * from (each page reference opens that page), drawing findings, extracted text and the three
 * separate file facts. Marking reviewed confirms a person read the file; it does not approve design
 * or prices.
 */
import { Mail, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import type { ProjectFile } from "@/api/types";
import { cn } from "@/lib/cn";
import { formatBytes, formatDate, isRtl } from "@/lib/format";
import { docKindLabel, fileSourceLabel } from "@/lib/labels";
import { emailHref, projectHref } from "@/lib/routes";
import {
  Button,
  EvidenceQuote,
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
  BoqSourceCell,
  DownloadButton,
  DrawingFindings,
  drawingPages,
  factsFromFile,
  FileFacts,
  MarkReviewedDialog,
  OpenOriginalButton,
  PageRef,
  QtyValue,
  type SourcedFact,
} from "./fileParts";
import { isImageFile, isPdfFile, pageNumber } from "./lib";
import { Bidi, NotFoundOrError, PanelSkeleton, WorkStatus } from "./parts";
import { PageViewer } from "./PageViewer";

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
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <PanelSkeleton lines={10} />
          <PanelSkeleton lines={5} />
        </div>
      </Page>
    );
  }
  if (query.isError || !query.data) return <NotFoundOrError error={query.error} onRetry={() => query.refetch()} what="file" />;
  return <FileView key={query.data.id} file={query.data} />;
}

/** The fact whose page the viewer shows. */
interface Marker {
  page: number;
  label: string;
}

function FileView({ file }: { file: ProjectFile }) {
  const project = useProject(file.project_id);
  const [params, setParams] = useSearchParams();
  const [reviewing, setReviewing] = useState(false);
  const [marker, setMarker] = useState<Marker | null>(null);
  const viewer = useRef<HTMLDivElement>(null);

  const ready = file.status === "ready";
  const pdf = ready && isPdfFile(file);
  const hasViewer = ready && (pdf || isImageFile(file));
  const total = file.pages || 0;
  const asked = Math.max(1, Math.floor(Number(params.get("page")) || 1));
  const page = pdf ? (total ? Math.min(asked, total) : asked) : 1;

  const setPage = useCallback(
    (n: number) => {
      setParams(
        (cur) => {
          const next = new URLSearchParams(cur);
          next.set("page", String(n));
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  // ?page=0, ?page=abc or a page past the end: the address shows the page that is on screen
  const addressPage = params.get("page");
  useEffect(() => {
    if (pdf && total && addressPage !== null && addressPage !== String(page)) setPage(page);
  }, [pdf, total, addressPage, page, setPage]);

  /** Show a page; with a label it is the source of that fact, and the viewer says so. */
  const showPage = (n: number, label?: string) => {
    setPage(n);
    setMarker(label ? { page: n, label } : null);
    // on a phone the viewer is above the list: bring it into view
    const el = viewer.current;
    if (el) {
      const top = el.getBoundingClientRect().top;
      if (top < 56 || top > window.innerHeight * 0.5) {
        const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        el.scrollIntoView({ block: "start", behavior: calm ? "auto" : "smooth" });
      }
    }
  };
  const activeMarker = marker && marker.page === page ? marker : null;

  const detail = project.data;
  const siblings = detail?.files ?? [];
  const facts = detail ? factsFromFile(detail, file) : [];
  const finding = drawingPages(file).find((d) => d.page === page)?.finding;
  const boq = boqRows(file);
  const email = file.email_id ? detail?.emails.find((e) => e.id === file.email_id) : undefined;
  const projectName = detail?.project.name;
  const shownPage = pdf ? page : undefined;

  const side = (
    <>
      {hasViewer && boq.length ? (
        <BoqPanel file={file} siblings={siblings} compact shownPage={shownPage} onShowPage={showPage} />
      ) : null}
      <SourcedFacts facts={facts} pdf={pdf} shownPage={shownPage} onShowPage={showPage} />
      {finding || (pdf && drawingPages(file).length) ? (
        <Findings file={file} page={page} finding={finding} onShowPage={(n) => showPage(n)} />
      ) : null}
      <FileDetails file={file} email={email} />
    </>
  );

  return (
    <Page>
      <PageHeader
        back={{ to: projectHref(file.project_id, "inputs"), label: projectName ? `${projectName} · Inputs` : "Project inputs" }}
        title={<Bidi text={file.name} className="break-all" />}
        meta={
          <div className="space-y-2">
            <FileFacts file={file} />
            <p>
              {[docKindLabel(file.doc_kind), file.size ? formatBytes(file.size) : null, total ? `${total} pages` : null, fileSourceLabel(file.source)]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
        }
        actions={
          <>
            {ready ? (
              <>
                <OpenOriginalButton file={file} className="flex-1 md:flex-none" />
                <DownloadButton file={file} className="flex-1 md:flex-none" />
              </>
            ) : null}
            {!file.reviewed_by ? (
              <Button icon={<ShieldCheck />} className="w-full md:w-auto" disabled={!ready} onClick={() => setReviewing(true)}>
                Mark reviewed
              </Button>
            ) : null}
            {!ready && !file.reviewed_by ? <p className="w-full text-sm text-ink-3 md:text-right">Download the file before marking it reviewed.</p> : null}
          </>
        }
      />

      <WorkStatus projectId={file.project_id} className="mb-6" />

      {hasViewer ? (
        <>
          <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
            <div ref={viewer} className="min-w-0 scroll-mt-20 xl:sticky xl:top-4">
              <PageViewer
                file={file}
                page={page}
                total={total}
                onPage={(n) => {
                  setPage(n);
                  setMarker(null);
                }}
                marker={activeMarker}
                onClearMarker={() => setMarker(null)}
              />
            </div>
            <div className="min-w-0 space-y-6">{side}</div>
          </div>
          <div className="mt-6">
            <TextPanel file={file} />
          </div>
        </>
      ) : (
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0 space-y-6">
            <PageViewer file={file} page={page} total={total} onPage={setPage} />
            {boq.length ? <BoqPanel file={file} siblings={siblings} shownPage={shownPage} onShowPage={showPage} /> : null}
            <TextPanel file={file} />
          </div>
          <div className="min-w-0 space-y-6">{side}</div>
        </div>
      )}

      <MarkReviewedDialog file={reviewing ? file : null} onClose={() => setReviewing(false)} />
    </Page>
  );
}

/* ------------------------------------------------------------------ side column */

function FileDetails({ file, email }: { file: ProjectFile; email?: { id: string; from_name: string; from_email: string; date: string | null } }) {
  const total = file.pages || 0;
  return (
    <Panel>
      <PanelHeader title="File" />
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

/** What the AI engine read on the sheet on screen, and the other sheets it read. */
function Findings({
  file,
  page,
  finding,
  onShowPage,
}: {
  file: ProjectFile;
  page: number;
  finding?: ReturnType<typeof drawingPages>[number]["finding"];
  onShowPage: (page: number) => void;
}) {
  const others = drawingPages(file).filter((d) => d.page !== page);
  return (
    <Panel>
      <PanelHeader
        title={finding ? `Drawing findings · page ${page}` : "Drawing findings"}
        description="Read from the sheet by the AI engine. Nothing was measured; dimensions need engineer verification."
      />
      <PanelBody className="space-y-4">
        {finding ? <DrawingFindings finding={finding} /> : <p className="text-sm text-ink-3">Nothing was read on page {page}.</p>}
        {others.length ? (
          <div>
            <p className="text-sm text-ink-3">{finding ? "Other sheets with findings" : "Sheets with findings"}</p>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {others.map((d) => (
                <PageRef key={d.page} page={d.page} label="its drawing findings" onShow={() => onShowPage(d.page)} />
              ))}
            </div>
          </div>
        ) : null}
      </PanelBody>
    </Panel>
  );
}

/** Project facts (requirements, scope items) whose quote comes from this file, each with its page. */
function SourcedFacts({
  facts,
  pdf,
  shownPage,
  onShowPage,
}: {
  facts: SourcedFact[];
  pdf: boolean;
  shownPage?: number;
  onShowPage: (page: number, label: string) => void;
}) {
  if (!facts.length) return null;
  return (
    <Panel>
      <PanelHeader
        title={`Facts from this file (${facts.length})`}
        description={
          pdf
            ? "Each fact with the sentence it came from. Pick its page to see it in the document."
            : "Each fact with the sentence it came from and where in the file it was read."
        }
      />
      <ul className="divide-y divide-line">
        {facts.map((f) => {
          const page = pdf ? pageNumber(f.evidence.page) : null;
          const evidence = pdf ? { ...f.evidence, page: null, source_label: "Read from this file" } : f.evidence;
          return (
            <li key={f.key} className={cn("px-5 py-4", page !== null && page === shownPage && "bg-brand-soft/50")}>
              <Bidi text={f.label} as="p" className="font-medium text-ink" />
              {f.value ? <Bidi text={f.value} as="p" className="mt-0.5 text-ink-2" /> : null}
              <EvidenceQuote
                evidence={evidence}
                href={null}
                className="mt-2"
                action={page ? <PageRef page={page} current={page === shownPage} label={f.label} onShow={() => onShowPage(page, f.label)} /> : undefined}
              />
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/* ------------------------------------------------------------------ BOQ */

/**
 * BOQ rows exactly as the file states them. A row read from a PDF page has a page reference that
 * opens that page; a row read from a spreadsheet names its sheet and row as text. Rows that came
 * from a PDF inside a ZIP link to that PDF's page.
 */
function BoqPanel({
  file,
  siblings,
  compact,
  shownPage,
  onShowPage,
}: {
  file: ProjectFile;
  siblings: ProjectFile[];
  /** Rows as stacked entries even on wide screens (the side column). */
  compact?: boolean;
  shownPage?: number;
  onShowPage: (page: number, label: string) => void;
}) {
  const rows = boqRows(file);
  const all = typeof file.extraction?.boq_items === "number" ? (file.extraction.boq_items as number) : null;
  const items = rows.map((r) => {
    const source = boqSource(r, file, siblings);
    const label = `BOQ row ${r.ref || r.description?.slice(0, 30) || ""}`.trim();
    return { r, source, label, onThisPage: !!source.page && source.target?.id === file.id && source.page === shownPage };
  });
  const cell = (it: (typeof items)[number]) => (
    <BoqSourceCell
      source={it.source}
      file={file}
      shownPage={shownPage}
      label={it.label}
      onShowPage={(p) => onShowPage(p, it.label)}
    />
  );
  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title={`BOQ rows (${rows.length})`}
        description={`${all !== null ? `${rows.length} of ${all} rows match the company's services. ` : ""}Quantities exactly as the file states them. Rates and prices are not read.`}
      />
      {!compact ? (
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
              {items.map((it, i) => (
                <TR key={i} selected={it.onThisPage}>
                  <TD className="whitespace-nowrap font-mono text-sm text-ink-2">{it.r.ref || "—"}</TD>
                  <TD>
                    <Bidi text={it.r.description || "—"} as="p" className="text-ink" />
                    {it.r.section ? <Bidi text={it.r.section} as="p" className="mt-0.5 text-xs text-ink-3" /> : null}
                  </TD>
                  <TD className="text-right">
                    <QtyValue qty={it.r.qty} text={it.r.qty_text} />
                  </TD>
                  <TD>{it.r.unit || <span className="text-ink-3">—</span>}</TD>
                  <TD>{cell(it)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      ) : null}
      <ul className={cn("divide-y divide-line", !compact && "md:hidden")}>
        {items.map((it, i) => (
          <li key={i} className={cn("px-5 py-4", it.onThisPage && "bg-brand-soft/50")}>
            <Bidi text={it.r.description || "—"} as="p" className="font-medium text-ink" />
            <dl className="mt-2 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
              <dt className="text-ink-3">Item</dt>
              <dd className="font-mono text-ink-2">{it.r.ref || "—"}</dd>
              <dt className="text-ink-3">Quantity</dt>
              <dd>
                <QtyValue qty={it.r.qty} text={it.r.qty_text} />
              </dd>
              <dt className="text-ink-3">Unit</dt>
              <dd className="text-ink">{it.r.unit || "—"}</dd>
              <dt className="pt-1 text-ink-3">Source</dt>
              <dd>{cell(it)}</dd>
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
