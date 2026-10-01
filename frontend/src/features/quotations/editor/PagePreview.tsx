/**
 * The real pages of the quotation PDF ("This is where it prints"): thumbnails, a larger view on tap or
 * click, and a button that renders the PDF again. A draft prints no stamp, so the stamp position is drawn
 * on the page as a dashed circle; an approved PDF already carries the real stamp.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, ExternalLink, RefreshCw, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { api } from "@/api/client";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/format";
import { Button, Dialog, IconButton, InlineError, Skeleton, toast } from "@/ui";
import { pageUrl, pdfUrl, type PagesInfo, type Quote, type StampSettings } from "../api";

/* ------------------------------------------------------------------ data */

/** True while the element is on screen or close to it (so a hidden section does not render the PDF). */
export function useInView<T extends Element>(rootMargin = "300px"): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver((entries) => setInView(entries.some((e) => e.isIntersecting)), { rootMargin });
    io.observe(el);
    return () => io.disconnect();
  }, [rootMargin]);
  return [ref, inView];
}

/**
 * Page count of the current PDF (the server renders it first when it is stale) and a "render again"
 * action. The images are fetched again when the PDF is rendered again.
 */
export function useQuotationPages(q: Pick<Quote, "id" | "updated_at">, enabled: boolean) {
  const qc = useQueryClient();
  const pages = useQuery({
    queryKey: ["quotation-pages", q.id, q.updated_at],
    queryFn: () => api.get<PagesInfo>(`/quotations/${q.id}/pages`),
    enabled,
    staleTime: 60_000,
    retry: 1,
    // After a save the old pages stay on screen until the new ones are rendered.
    placeholderData: keepPreviousData,
  });
  const render = useMutation({
    mutationFn: () => api.post<{ pdf: string }>(`/quotations/${q.id}/render`),
    onSuccess: async () => {
      await pages.refetch();
      await qc.invalidateQueries({ queryKey: ["quotation", q.id] });
      toast.success("PDF rendered again");
    },
  });
  return { pages, render };
}

/* ------------------------------------------------------------------ stamp position */

/** A stamp position in millimetres on an A4 page. */
export interface StampMark {
  x: number;
  y: number;
  width: number;
}

/** Where the saved stamp settings put the stamp on a page; null when it is hidden or the paper's own position applies. */
export function stampMarkFor(stamp: StampSettings | undefined, page: number): StampMark | null {
  const s = stamp ?? {};
  const own = s.pages?.[String(page)];
  if ((own?.show ?? s.show) === false) return null;
  const d = s.default ?? {};
  const x = own?.x_mm ?? d.x_mm ?? s.x_mm;
  const y = own?.y_mm ?? d.y_mm ?? s.y_mm;
  const w = own?.width_mm ?? d.width_mm ?? s.width_mm;
  return x != null && y != null ? { x, y, width: w ?? 36 } : null;
}

/* ------------------------------------------------------------------ one page */

/** One page image on an A4 box: a skeleton while it loads, a note if it fails, the stamp mark on top. */
export function PageImage({ src, alt, mark, className }: { src: string; alt: string; mark?: StampMark | null; className?: string }) {
  // Key the component by src so a new image starts in the loading state.
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  return (
    <span className={cn("relative block aspect-[210/297] overflow-hidden rounded-md border border-line bg-hover", className)}>
      {state === "loading" ? <Skeleton className="absolute inset-0 h-full rounded-none" /> : null}
      {state === "failed" ? (
        <span className="absolute inset-0 grid place-items-center p-2 text-center text-xs text-ink-3">This page could not load.</span>
      ) : (
        <img
          src={src}
          alt={alt}
          decoding="async"
          onLoad={() => setState("ready")}
          onError={() => setState("failed")}
          className="absolute inset-0 size-full object-contain"
        />
      )}
      {mark && state === "ready" ? (
        <span
          aria-hidden
          className="absolute rounded-full border-2 border-dashed border-review-mark bg-review-soft/60"
          style={{
            left: `${(mark.x / 210) * 100}%`,
            top: `${(mark.y / 297) * 100}%`,
            width: `${(mark.width / 210) * 100}%`,
            aspectRatio: "1",
          }}
        />
      ) : null}
    </span>
  );
}

/** The state of the page query as one short word for the caption. */
function pagesNote(final: boolean, anyMark: boolean, dirty?: boolean): string {
  const base = final
    ? "The approved PDF, with the signature and the stamp."
    : anyMark
      ? "The last saved version of the PDF. A draft prints no stamp: the dashed circle shows where it prints once approved."
      : "The last saved version of the PDF. A draft prints no signature and no stamp.";
  return dirty ? `${base} Unsaved changes are not shown.` : base;
}

/* ------------------------------------------------------------------ larger view */

export function PageViewer({
  q,
  page,
  count,
  version,
  markFor,
  onPage,
  onClose,
}: {
  q: Pick<Quote, "id" | "updated_at" | "pdf_rendered_at">;
  page: number;
  count: number;
  version: string | null | undefined;
  markFor: (page: number) => StampMark | null;
  onPage: (page: number) => void;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="xl"
      title={`Page ${page} of ${count}`}
      description="Where the stamp and the photos land on the printed page."
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-1">
          <IconButton label="Previous page" variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>
            <ChevronLeft />
          </IconButton>
          <IconButton label="Next page" variant="secondary" disabled={page >= count} onClick={() => onPage(page + 1)}>
            <ChevronRight />
          </IconButton>
          <span className="px-2 text-sm text-ink-2 tabular">
            Page {page} of {count}
          </span>
          <span className="ml-auto flex gap-1">
            <IconButton label={zoom ? "Fit the page to the screen" : "Zoom in"} variant="secondary" onClick={() => setZoom((z) => !z)}>
              {zoom ? <ZoomOut /> : <ZoomIn />}
            </IconButton>
            <Button variant="secondary" asChild className="px-3">
              <a href={pdfUrl(q.id, q.pdf_rendered_at)} target="_blank" rel="noreferrer">
                <ExternalLink aria-hidden />
                <span className="max-sm:sr-only">Open the PDF</span>
              </a>
            </Button>
          </span>
        </div>
        <div className={cn("mx-auto", zoom ? "w-[1000px] max-w-none" : "w-full max-w-[640px]")}>
          <PageImage
            key={`${page}:${zoom}:${version}`}
            src={pageUrl(q.id, page, zoom ? 170 : 110, version)}
            alt={`Page ${page} of ${count} of the quotation PDF`}
            mark={markFor(page)}
          />
        </div>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ strip of every page */

/**
 * Every page of the current PDF as a thumbnail, under "This is where it prints", with Re-render. It
 * loads only while it is on screen, so a long editor does not render the PDF at once.
 */
export function PagesStrip({
  q,
  dirty,
  className,
  viewer: shown,
  onViewerChange,
}: {
  q: Quote;
  dirty?: boolean;
  className?: string;
  /** The page shown larger (controlled by the caller, e.g. "See page 2" on a photo); omit to let the strip decide. */
  viewer?: number | null;
  onViewerChange?: (page: number | null) => void;
}) {
  const [ref, inView] = useInView<HTMLDivElement>();
  // A page asked for by the caller loads the strip even before it scrolls into view.
  const { pages, render } = useQuotationPages(q, inView || shown != null);
  const [own, setOwn] = useState<number | null>(null);
  const viewer = shown !== undefined ? shown : own;
  const setViewer = (n: number | null) => (onViewerChange ? onViewerChange(n) : setOwn(n));
  const final = q.status === "approved" || q.status === "sent";
  const data = pages.data;
  const version = data?.rendered_at ?? q.updated_at;
  const count = data?.count ?? 0;
  const markFor = (n: number) => (final ? null : stampMarkFor(q.data.stamp, n));
  const anyMark = Array.from({ length: count }, (_, i) => markFor(i + 1)).some(Boolean);

  const placeholder = (
    <div aria-hidden={!pages.isPending} className="mt-3 flex gap-3 overflow-hidden">
      {[0, 1, 2].map((i) => (
        <span key={i} className="block w-28 shrink-0 sm:w-32">
          <Skeleton className="aspect-[210/297] h-auto w-full rounded-md" />
        </span>
      ))}
    </div>
  );

  return (
    <div ref={ref} className={className}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-ink">This is where it prints</h3>
          <p className="text-sm text-ink-3">{pagesNote(final, anyMark, dirty)}</p>
        </div>
        <Button variant="secondary" size="sm" icon={<RefreshCw />} onClick={() => render.mutate()} loading={render.isPending}>
          Re-render
        </Button>
      </div>

      {data && count === 0 ? (
        <p className="mt-3 text-sm text-ink-3">The PDF has no pages yet. Use Re-render to try again.</p>
      ) : data ? (
        <>
          <ul className="-mx-1 mt-3 flex gap-3 overflow-x-auto px-1 pb-2" aria-label="Pages of the PDF">
            {Array.from({ length: count }, (_, i) => i + 1).map((n) => (
              <li key={n} className="w-28 shrink-0 sm:w-32">
                <button
                  type="button"
                  onClick={() => setViewer(n)}
                  aria-label={`Page ${n} of ${count}. Open a larger view`}
                  className="block w-full rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                >
                  <PageImage key={`${n}:${version}`} src={pageUrl(q.id, n, 60, version)} alt="" mark={markFor(n)} />
                  <span className="mt-1 block text-xs text-ink-3 tabular">Page {n}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="text-xs text-ink-3" role="status">
            {pages.isPlaceholderData ? "Updating the pages…" : `Rendered ${formatDateTime(data.rendered_at ?? q.pdf_rendered_at)}. Open a page to see it larger.`}
          </p>
        </>
      ) : pages.isError ? (
        <div className="mt-3 space-y-2">
          <InlineError error={pages.error} />
          <Button variant="secondary" size="sm" onClick={() => pages.refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <>
          {placeholder}
          {pages.isPending && inView ? (
            <p className="mt-2 text-sm text-ink-3" role="status">
              Rendering the PDF pages…
            </p>
          ) : null}
        </>
      )}

      {render.error ? <InlineError error={render.error} className="mt-2" /> : null}

      {viewer !== null && data ? (
        <PageViewer
          q={q}
          page={Math.min(Math.max(1, viewer), Math.max(1, count))}
          count={count}
          version={version}
          markFor={markFor}
          onPage={setViewer}
          onClose={() => setViewer(null)}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ one page with a chooser (stamp dialog) */

/**
 * One page at a time with a page chooser, for the stamp placement dialog. `markFor` draws the position
 * being edited (the form's values) on the real page.
 */
export function PageStage({
  q,
  markFor,
  enabled,
  fallback,
}: {
  q: Quote;
  markFor: (page: number) => StampMark | null;
  enabled: boolean;
  /** Shown when the real pages cannot be loaded. */
  fallback?: ReactNode;
}) {
  const { pages, render } = useQuotationPages(q, enabled);
  const [page, setPage] = useState(1);
  const [viewer, setViewer] = useState(false);
  const data = pages.data;
  const count = data?.count ?? 0;
  const current = Math.min(Math.max(1, page), Math.max(1, count));
  const version = data?.rendered_at ?? q.updated_at;

  if (pages.isError && !data)
    return (
      <div className="space-y-2">
        {fallback}
        <p role="alert" className="text-xs text-block">
          The real pages could not load.
        </p>
        <Button variant="secondary" size="sm" onClick={() => pages.refetch()}>
          Try again
        </Button>
      </div>
    );
  if (!data)
    return (
      <div role="status" aria-label="Rendering the PDF pages" className="space-y-2">
        <Skeleton className="aspect-[210/297] h-auto w-full rounded-md" />
        <p className="text-xs text-ink-3">Rendering the PDF pages…</p>
      </div>
    );
  return (
    <div className="space-y-2">
      {count > 1 ? (
        <div className="flex items-center justify-between gap-1">
          <IconButton label="Previous page" size="sm" variant="secondary" disabled={current <= 1} onClick={() => setPage(current - 1)}>
            <ChevronLeft />
          </IconButton>
          <span className="whitespace-nowrap text-xs text-ink-2 tabular" aria-live="polite">
            <span aria-hidden>
              {current} / {count}
            </span>
            <span className="sr-only">
              Page {current} of {count}
            </span>
          </span>
          <IconButton label="Next page" size="sm" variant="secondary" disabled={current >= count} onClick={() => setPage(current + 1)}>
            <ChevronRight />
          </IconButton>
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => setViewer(true)}
        aria-label={`Page ${current} of ${count}. Open a larger view`}
        className="block w-full rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
      >
        <PageImage key={`${current}:${version}`} src={pageUrl(q.id, current, 90, version)} alt="" mark={markFor(current)} />
      </button>
      <p className="text-xs font-medium text-ink-2">This is where it prints</p>
      <Button variant="ghost" size="sm" icon={<RefreshCw />} onClick={() => render.mutate()} loading={render.isPending} className="-ml-3">
        Re-render
      </Button>
      {render.error ? <InlineError error={render.error} /> : null}
      {viewer ? (
        <PageViewer q={q} page={current} count={count} version={version} markFor={markFor} onPage={setPage} onClose={() => setViewer(false)} />
      ) : null}
    </div>
  );
}
