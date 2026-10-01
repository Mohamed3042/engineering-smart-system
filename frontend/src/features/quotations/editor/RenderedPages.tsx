import { ChevronLeft, ChevronRight, ExternalLink, RefreshCw } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button, Field, Input, LoadingRows } from "@/ui";
import { pageImageUrl, pdfUrl, useQuotationPages, type Quote } from "../api";
import { ExplainedError } from "../components";

/** Actual saved PDF pages. A guide is a requested position, never a claim that it was rendered. */
export function RenderedPages({ q, enabled = true, initialPage = 1, guide, onPageChange }: {
  q: Quote;
  enabled?: boolean;
  initialPage?: number;
  guide?: { x: number; y: number; width: number; label: string } | null;
  onPageChange?: (page: number) => void;
}) {
  const pages = useQuotationPages(q, enabled);
  const zoomId = useId();
  const [page, setPage] = useState(initialPage);
  const [zoom, setZoom] = useState(100);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const count = pages.data?.count;
  const current = Math.max(1, Math.min(page, count || page));
  const src = `${pageImageUrl(q, current, zoom > 100 ? 160 : 100)}&retry=${retry}`;
  useEffect(() => { setPage(initialPage); }, [initialPage, q.id]);
  useEffect(() => { setFailed(false); }, [src]);
  useEffect(() => { onPageChange?.(current); }, [current, onPageChange]);
  if (!enabled) return null;
  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" icon={<ChevronLeft />} disabled={current <= 1} onClick={() => setPage(current - 1)}>Previous</Button>
        <span className="text-sm text-ink-2 tabular" aria-live="polite">Page {current}{count ? ` of ${count}` : ""}</span>
        <Button variant="secondary" size="sm" icon={<ChevronRight />} disabled={!count || current >= count} onClick={() => setPage(current + 1)}>Next</Button>
        <Button variant="link" size="sm" asChild><a href={pdfUrl(q.id, q.pdf_rendered_at)} target="_blank" rel="noreferrer"><ExternalLink className="size-4" aria-hidden />Open PDF</a></Button>
      </div>
      {pages.isLoading ? <LoadingRows rows={2} /> : pages.isError ? (
        <div className="space-y-2"><ExplainedError error={pages.error} /><Button size="sm" variant="secondary" icon={<RefreshCw />} onClick={() => pages.refetch()}>Retry page preview</Button></div>
      ) : count ? (
        <>
          <Field label="Page zoom (%)" htmlFor={zoomId} className="max-w-36">
            <Input id={zoomId} type="number" min={100} max={250} step={25} value={zoom} onChange={(e) => setZoom(Math.min(250, Math.max(100, Number(e.target.value) || 100)))} />
          </Field>
          {failed ? (
            <div className="space-y-2 text-sm"><p className="text-block">This PDF page could not load.</p><Button variant="secondary" size="sm" icon={<RefreshCw />} onClick={() => setRetry((v) => v + 1)}>Retry image</Button></div>
          ) : (
            <div className="max-h-[65dvh] overflow-auto rounded-md border border-line bg-sunken" tabIndex={0} aria-label="Rendered PDF page. Scroll to inspect a zoomed page.">
              <div className="relative mx-auto" style={{ width: `${zoom}%` }}>
                <img src={src} alt={`Saved quotation PDF, page ${current}`} className="block h-auto w-full" onError={() => setFailed(true)} />
                {guide ? <div className="pointer-events-none absolute border-t-2 border-dashed border-brand text-xs font-medium text-brand-ink" style={{ left: `${guide.x / 210 * 100}%`, top: `${guide.y / 297 * 100}%`, width: `${guide.width / 210 * 100}%` }}><span className="bg-surface px-1">{guide.label}</span></div> : null}
              </div>
            </div>
          )}
        </>
      ) : <p className="text-sm text-ink-3">The PDF has no pages to preview.</p>}
      <p className="text-sm text-ink-3">The PDF image uses the saved version, including any photos moved to the annex. {guide ? "The dashed guide shows the requested position separately." : "Unsaved edits are not shown."}</p>
    </div>
  );
}
