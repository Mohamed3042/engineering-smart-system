/**
 * Page viewer for a PDF or an image, made for checking the source of a fact:
 * - zoom: Fit width, 100%, 150%, 200%, 300%, plus and minus, pinch on touch screens, Ctrl + wheel;
 * - pan by scrolling (drag with a mouse), the page image gets sharper when it is zoomed in;
 * - page controls: previous, next, a jump field, arrow keys; the page number is kept in the URL by
 *   the file screen (?page=N);
 * - a full-screen view that works on phones.
 * 100% is the printed size of the page (96 pixels per inch), as in a PDF reader.
 */
import { ChevronLeft, ChevronRight, FileQuestion, Maximize2, Minus, Plus, RefreshCw, X } from "lucide-react";
import { Dialog as D } from "radix-ui";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { Link } from "react-router";
import type { ProjectFile } from "@/api/types";
import { cn } from "@/lib/cn";
import { projectHref } from "@/lib/routes";
import { Button, EmptyState, IconButton, Input, Panel, Select, Skeleton } from "@/ui";
import { DownloadButton, fileContentUrl, OpenOriginalButton } from "./fileParts";
import { useDebounced } from "./hooks";
import { isImageFile, isPdfFile } from "./lib";
import { Bidi } from "./parts";

const CSS_DPI = 96;
/** Zoom steps. 50% and 75% only count when they are above Fit width: a big drawing sheet fits at 20%, a phone shows an A4 page at 40%. */
const ZOOM_STOPS = [0.5, 0.75, 1, 1.5, 2, 3];
const MAX_ZOOM = 3;
/** Resolutions of the page image the server draws (50 to 300 dpi). The sharper ones are asked for when zoomed in. */
const DPI_STEPS = [110, 150, 200, 300];
/** The biggest page image asked for. Phones run out of memory sooner than computers. */
const maxPixels = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches ? 16_000_000 : 36_000_000;

export type Zoom = "fit" | number;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const pct = (z: number) => `${Math.round(z * 100)}%`;

/** The lowest resolution that is sharp enough for the wanted pixels per inch, within the memory limit. */
function pickDpi(wanted: number, pageInches: { w: number; h: number } | null): number {
  const cap = pageInches ? Math.floor(Math.sqrt(maxPixels() / (pageInches.w * pageInches.h))) : DPI_STEPS[DPI_STEPS.length - 1];
  const allowed = DPI_STEPS.filter((d) => d <= Math.max(cap, DPI_STEPS[0]));
  return allowed.find((d) => d >= wanted) ?? allowed[allowed.length - 1];
}

const pageUrl = (id: string, page: number, dpi: number, attempt: number) =>
  `/api/files/${encodeURIComponent(id)}/pages/${page}.png?dpi=${dpi}${attempt ? `&retry=${attempt}` : ""}`;

const presetStops = (fit: number | null) => ZOOM_STOPS.filter((s) => s >= 1 || (fit !== null && s > fit * 1.05));

/** The next preset zoom above or below the current one; below the lowest preset it is Fit width. */
function stepZoom(scale: number, fit: number, dir: 1 | -1): Zoom {
  const eps = 0.005;
  const stops = presetStops(fit);
  if (dir > 0) return stops.find((s) => s > scale + eps) ?? MAX_ZOOM;
  return [...stops].reverse().find((s) => s < scale - eps && s > fit + eps) ?? "fit";
}

interface ViewerApi {
  zoomTo: (z: Zoom) => void;
  zoomStep: (dir: 1 | -1) => void;
  /** True when arrow keys should move the zoomed page instead of changing the page. */
  scrollsSideways: () => boolean;
}

export interface PageViewerProps {
  file: ProjectFile;
  page: number;
  /** Pages of the file; 0 when not known. */
  total: number;
  onPage: (n: number) => void;
  /** The fact whose page is shown: marks the page. */
  marker?: { label: string } | null;
  onClearMarker?: () => void;
}

/* ------------------------------------------------------------------ states without a page view */

function NotReady({ file }: { file: ProjectFile }) {
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

function NoPageView({ file }: { file: ProjectFile }) {
  return (
    <Panel>
      <EmptyState
        compact
        icon={<FileQuestion />}
        title="No page view for this file type"
        action={
          <>
            <OpenOriginalButton file={file} />
            <DownloadButton file={file} />
          </>
        }
      >
        Spreadsheets and documents show their extracted text and BOQ rows. Open the original to see the whole file.
      </EmptyState>
    </Panel>
  );
}

/* ------------------------------------------------------------------ the viewer */

export function PageViewer(props: PageViewerProps) {
  const { file } = props;
  if (file.status !== "ready") return <NotReady file={file} />;
  const pdf = isPdfFile(file);
  if (!pdf && !isImageFile(file)) return <NoPageView file={file} />;
  return <Viewer {...props} pdf={pdf} />;
}

function Viewer({ file, pdf, page, total, onPage, marker, onClearMarker }: PageViewerProps & { pdf: boolean }) {
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [full, setFull] = useState(false);
  const apiRef = useRef<ViewerApi | null>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const last = pdf ? (total || Number.POSITIVE_INFINITY) : 1;

  const go = useCallback(
    (n: number) => {
      const target = clamp(Math.round(n), 1, last);
      if (target !== page) onPage(target);
    },
    [page, last, onPage],
  );
  const live = useRef({ go, page, pdf });
  live.current = { go, page, pdf };

  // Arrow keys change the page, + and - zoom, 0 fits the width. Typing and other dialogs are left alone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], [role='tablist'], [role='menu'], [role='listbox'], [role='slider']")) return;
      const dialog = target?.closest("[role='dialog'], [role='alertdialog']");
      if (dialog && !dialog.hasAttribute("data-page-viewer")) return;
      const { go: goTo, page: now, pdf: paged } = live.current;
      const api = apiRef.current;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (!paged || (target?.hasAttribute("data-page-scroller") && api?.scrollsSideways())) return;
        e.preventDefault();
        goTo(now + (e.key === "ArrowRight" ? 1 : -1));
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        api?.zoomStep(1);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        api?.zoomStep(-1);
      } else if (e.key === "0") {
        e.preventDefault();
        api?.zoomTo("fit");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const body = (variant: "inline" | "fullscreen") => (
    <ViewerBody
      variant={variant}
      file={file}
      pdf={pdf}
      page={page}
      total={total}
      last={last}
      go={go}
      zoom={zoom}
      onZoom={setZoom}
      apiRef={apiRef}
      marker={marker}
      onClearMarker={onClearMarker}
      onFullscreen={() => setFull(true)}
      openRef={openRef}
    />
  );

  return (
    <>
      <Panel className="overflow-hidden">
        {full ? (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
            <p className="text-ink-2">The page is open in full screen.</p>
            <Button variant="secondary" onClick={() => setFull(false)}>
              Close full screen
            </Button>
          </div>
        ) : (
          body("inline")
        )}
      </Panel>
      <D.Root open={full} onOpenChange={setFull}>
        <D.Portal>
          <D.Content
            data-page-viewer
            className="fixed inset-0 z-50 flex flex-col bg-canvas outline-none animate-fade-in"
            // the button that opened it is rebuilt meanwhile: give focus back to the new one
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              openRef.current?.focus();
            }}
          >
            <D.Description className="sr-only">
              The page of {file.name}. Use the arrow keys to change the page, plus and minus to zoom, and Escape to close.
            </D.Description>
            {full ? body("fullscreen") : null}
          </D.Content>
        </D.Portal>
      </D.Root>
    </>
  );
}

/* ------------------------------------------------------------------ controls */

function PageControls({
  page,
  total,
  last,
  go,
  nextDisabled,
  className,
}: {
  page: number;
  total: number;
  last: number;
  go: (n: number) => void;
  /** The next page cannot be shown (the file has fewer pages than expected). */
  nextDisabled?: boolean;
  className?: string;
}) {
  const id = useId();
  const [draft, setDraft] = useState(String(page));
  useEffect(() => setDraft(String(page)), [page]);
  const commit = () => {
    const n = Number.parseInt(draft, 10);
    if (!Number.isFinite(n)) {
      setDraft(String(page));
      return;
    }
    go(n);
    setDraft(String(clamp(n, 1, last)));
  };
  return (
    <div className={cn("flex items-center gap-1", className)}>
      <Button variant="ghost" aria-label="Previous page" icon={<ChevronLeft />} disabled={page <= 1} onClick={() => go(page - 1)}>
        <span className="hidden xl:inline">Previous</span>
      </Button>
      <form
        className="flex items-center gap-2 text-sm text-ink-2"
        onSubmit={(e) => {
          e.preventDefault();
          commit();
        }}
      >
        <label htmlFor={id}>Page</label>
        <Input
          id={id}
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          value={draft}
          onChange={(e) => setDraft(e.target.value.replace(/\D/g, ""))}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={commit}
          className="h-10 w-14 px-1 text-center tabular"
        />
        {total ? <span className="tabular">of {total}</span> : null}
      </form>
      <Button variant="ghost" aria-label="Next page" iconRight={<ChevronRight />} disabled={page >= last || nextDisabled} onClick={() => go(page + 1)}>
        <span className="hidden xl:inline">Next</span>
      </Button>
      <p className="sr-only" aria-live="polite">
        Page {page}
        {total ? ` of ${total}` : ""}
      </p>
    </div>
  );
}

function ZoomControls({
  zoom,
  fit,
  onZoom,
  onStep,
  className,
}: {
  zoom: Zoom;
  fit: number | null;
  onZoom: (z: Zoom) => void;
  onStep: (dir: 1 | -1) => void;
  className?: string;
}) {
  const stops = presetStops(fit);
  const preset = zoom === "fit" ? "fit" : stops.find((s) => Math.abs(s - zoom) < 0.005);
  const value = preset === undefined ? "custom" : String(preset);
  const options = [
    { value: "fit", label: fit ? `Fit width (${pct(fit)})` : "Fit width" },
    ...stops.map((s) => ({ value: String(s), label: pct(s) })),
    ...(zoom !== "fit" && preset === undefined ? [{ value: "custom", label: pct(zoom) }] : []),
  ];
  return (
    <div className={cn("flex items-center gap-1", className)}>
      <IconButton label="Zoom out" disabled={zoom === "fit"} onClick={() => onStep(-1)}>
        <Minus />
      </IconButton>
      <Select
        aria-label="Zoom"
        value={value}
        options={options}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "fit") onZoom("fit");
          else if (v !== "custom") onZoom(Number(v));
        }}
        className="min-w-0 flex-1 sm:w-44 sm:flex-none"
      />
      <IconButton label="Zoom in" disabled={zoom !== "fit" && zoom >= MAX_ZOOM - 0.005} onClick={() => onStep(1)}>
        <Plus />
      </IconButton>
    </div>
  );
}

/* ------------------------------------------------------------------ toolbar, page and gestures */

interface Shown {
  src: string;
  page: number;
  dpi: number;
  nw: number;
  nh: number;
}

function ViewerBody({
  variant,
  file,
  pdf,
  page,
  total,
  last,
  go,
  zoom,
  onZoom,
  apiRef,
  marker,
  onClearMarker,
  onFullscreen,
  openRef,
}: {
  variant: "inline" | "fullscreen";
  file: ProjectFile;
  pdf: boolean;
  page: number;
  total: number;
  last: number;
  go: (n: number) => void;
  zoom: Zoom;
  onZoom: (z: Zoom) => void;
  apiRef: RefObject<ViewerApi | null>;
  marker?: { label: string } | null;
  onClearMarker?: () => void;
  onFullscreen: () => void;
  openRef: RefObject<HTMLButtonElement | null>;
}) {
  const full = variant === "fullscreen";
  const pad = full ? 8 : 12;
  const scroller = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [boxW, setBoxW] = useState(0);
  const [shown, setShown] = useState<Shown | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pannable, setPannable] = useState(false);
  const [dragging, setDragging] = useState(false);

  // size of the page in inches (an image: natural pixels at 96 per inch)
  const current = shown && shown.page === page ? shown : null;
  const inches = current ? { w: current.nw / current.dpi, h: current.nh / current.dpi } : null;
  const lastInches = useRef(inches);
  if (inches) lastInches.current = inches;
  const estimate = inches ?? lastInches.current;

  const fitFor = (w: number | null) => (w && boxW ? Math.max(0.02, (boxW - pad * 2) / (w * CSS_DPI)) : null);
  const fit = fitFor(inches?.w ?? null);
  const scale = zoom === "fit" ? fit : zoom;
  const cssW = inches && scale ? inches.w * CSS_DPI * scale : null;

  // The image is asked for in the resolution the zoom needs, once the zoom has settled. The estimate
  // from the previous page keeps a page change from asking twice.
  const estScale = zoom === "fit" ? fitFor(estimate?.w ?? null) : zoom;
  const settled = useDebounced(estScale ?? 0, 250);
  const dpr = typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio || 1, 3);
  const wantDpi = pdf ? pickDpi(settled * CSS_DPI * dpr, estimate) : CSS_DPI;
  const wantSrc = pdf ? pageUrl(file.id, page, wantDpi, attempt) : `${fileContentUrl(file.id)}${attempt ? `?retry=${attempt}` : ""}`;

  useEffect(() => {
    if (shown?.src === wantSrc) return;
    let live = true;
    const im = new Image();
    im.onload = () => {
      if (!live) return;
      setShown({ src: wantSrc, page, dpi: wantDpi, nw: im.naturalWidth, nh: im.naturalHeight });
      setFailed(null);
    };
    im.onerror = () => live && setFailed(wantSrc);
    im.src = wantSrc;
    return () => {
      live = false;
      im.onload = null;
      im.onerror = null;
    };
  }, [wantSrc, wantDpi, page, shown?.src]);

  // the next page is fetched ahead so that the arrow keys feel instant
  useEffect(() => {
    if (!pdf || !current || !Number.isFinite(last) || page >= last) return;
    const im = new Image();
    im.src = pageUrl(file.id, page + 1, current.dpi, 0);
  }, [pdf, current, page, last, file.id]);

  // new page: back to its top-left corner
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0, left: 0 });
  }, [page]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const read = () => setBoxW(el.clientWidth);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const can = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
    setPannable((p) => (p === can ? p : can));
  });

  /** Zoom and keep the point under `focal` (screen position) where it is; the middle of the view by default. */
  const applyZoom = useCallback(
    (next: Zoom, focal?: { x: number; y: number }) => {
      const el = scroller.current;
      const img = imgRef.current;
      if (!el || !img) {
        onZoom(next);
        return;
      }
      const box = el.getBoundingClientRect();
      const before = img.getBoundingClientRect();
      const fx = focal?.x ?? box.left + el.clientWidth / 2;
      const fy = focal?.y ?? box.top + el.clientHeight / 2;
      const ax = before.width ? (fx - before.left) / before.width : 0.5;
      const ay = before.height ? (fy - before.top) / before.height : 0.5;
      flushSync(() => onZoom(next));
      const after = img.getBoundingClientRect();
      el.scrollLeft += after.left + ax * after.width - fx;
      el.scrollTop += after.top + ay * after.height - fy;
    },
    [onZoom],
  );

  const live = useRef({ scale: 1, fit: 1, zoom, applyZoom });
  live.current = { scale: scale ?? 1, fit: fit ?? 1, zoom, applyZoom };
  useLayoutEffect(() => {
    apiRef.current = {
      zoomTo: (z) => live.current.applyZoom(z),
      zoomStep: (dir) => live.current.applyZoom(stepZoom(live.current.scale, live.current.fit, dir)),
      scrollsSideways: () => {
        const el = scroller.current;
        return !!el && el.scrollWidth > el.clientWidth + 1;
      },
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef]);

  // Pinch with two fingers, double-tap, Ctrl + wheel (a trackpad pinch), drag with the mouse.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const touches = new Map<number, { x: number; y: number }>();
    let pinch: { d0: number; z0: number } | null = null;
    let drag: { id: number; x: number; y: number; left: number; top: number } | null = null;
    let tap: { x: number; y: number; at: number; moved: boolean } | null = null;
    let lastTap: { x: number; y: number; at: number } | null = null;

    const snap = (z: number): Zoom => (z <= live.current.fit * 1.04 ? "fit" : Math.min(MAX_ZOOM, z));

    const down = (e: PointerEvent) => {
      if (e.pointerType === "touch") {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touches.size === 2) {
          const [a, b] = [...touches.values()];
          pinch = { d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), z0: live.current.scale };
          tap = null;
        } else {
          tap = { x: e.clientX, y: e.clientY, at: Date.now(), moved: false };
        }
      } else if (
        e.pointerType === "mouse" &&
        e.button === 0 &&
        !(e.target instanceof Element && e.target.closest("button, a, input, select, textarea")) &&
        (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
      ) {
        drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
        el.setPointerCapture(e.pointerId);
        setDragging(true);
      }
    };
    const move = (e: PointerEvent) => {
      if (touches.has(e.pointerId)) {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 10) tap.moved = true;
        if (pinch && touches.size === 2) {
          const [a, b] = [...touches.values()];
          const ratio = Math.hypot(a.x - b.x, a.y - b.y) / pinch.d0;
          const z = clamp(pinch.z0 * ratio, live.current.fit, MAX_ZOOM);
          live.current.applyZoom(snap(z), { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        }
      } else if (drag && e.pointerId === drag.id) {
        el.scrollLeft = drag.left - (e.clientX - drag.x);
        el.scrollTop = drag.top - (e.clientY - drag.y);
      }
    };
    const up = (e: PointerEvent) => {
      if (touches.has(e.pointerId)) {
        touches.delete(e.pointerId);
        if (touches.size < 2) pinch = null;
        // two quick taps in the same place: Fit width <-> at least 100%
        if (tap && !tap.moved && e.type === "pointerup" && Date.now() - tap.at < 300) {
          if (lastTap && tap.at - lastTap.at < 350 && Math.hypot(tap.x - lastTap.x, tap.y - lastTap.y) < 30) {
            const { zoom: z, fit: f, applyZoom: apply } = live.current;
            apply(z === "fit" ? Math.min(MAX_ZOOM, Math.max(1, f * 2)) : "fit", { x: tap.x, y: tap.y });
            lastTap = null;
          } else {
            lastTap = { x: tap.x, y: tap.y, at: tap.at };
          }
        }
        tap = null;
      }
      if (drag && e.pointerId === drag.id) {
        drag = null;
        setDragging(false);
      }
    };
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const z = clamp(live.current.scale * Math.exp(-e.deltaY * 0.004), live.current.fit, MAX_ZOOM);
      live.current.applyZoom(z <= live.current.fit * 1.02 ? "fit" : z, { x: e.clientX, y: e.clientY });
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("wheel", wheel);
    };
  }, []);

  const pageFailed = failed === wantSrc && !current;
  const marked = !!marker;
  const innerW = Math.max(0, boxW - pad * 2);

  const pageControls = pdf ? (
    <PageControls
      page={page}
      total={total}
      last={last}
      go={go}
      nextDisabled={pageFailed}
      className={full ? "" : "w-full justify-between sm:w-auto sm:justify-start"}
    />
  ) : null;
  const zoomControls = (
    <ZoomControls
      zoom={zoom}
      fit={fit}
      onZoom={(z) => live.current.applyZoom(z)}
      onStep={(dir) => live.current.applyZoom(stepZoom(live.current.scale, live.current.fit, dir))}
      className={full ? "" : "min-w-0 flex-1 sm:flex-none"}
    />
  );

  return (
    <div className={cn(full && "flex h-full min-h-0 flex-1 flex-col")}>
      {full ? (
        <div className="flex items-center gap-3 border-b border-line bg-surface px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
          <D.Close asChild>
            <Button variant="secondary" icon={<X />}>
              Close
            </Button>
          </D.Close>
          <D.Title className="min-w-0 flex-1 truncate text-base font-semibold text-ink">
            <Bidi text={file.name} />
          </D.Title>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-3 py-2">
          {pageControls}
          <div className="flex w-full items-center gap-2 sm:w-auto">
            {zoomControls}
            <IconButton ref={openRef} label="Full screen" onClick={onFullscreen}>
              <Maximize2 />
            </IconButton>
          </div>
        </div>
      )}

      {marker ? (
        <div className="flex items-center gap-2 border-b border-brand-line bg-brand-soft px-3 py-1.5 text-sm text-brand-ink">
          <span className="min-w-0 flex-1 truncate">
            Source of <strong className="font-semibold">{marker.label}</strong>
            {pdf ? ` · page ${page}` : ""}
          </span>
          {onClearMarker ? (
            <Button size="sm" variant="ghost" onClick={onClearMarker}>
              Clear
            </Button>
          ) : null}
        </div>
      ) : null}

      <div
        ref={scroller}
        data-page-scroller
        tabIndex={0}
        role="region"
        aria-label={`${pdf ? `Page ${page}${total ? ` of ${total}` : ""} of ` : ""}${file.name}. Scroll to move around the page.`}
        className={cn(
          "relative touch-pan-x touch-pan-y overflow-auto overscroll-contain bg-sunken outline-none [scrollbar-gutter:stable]",
          "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand",
          full ? "min-h-0 flex-1" : "max-h-[75dvh] xl:max-h-[calc(100dvh-10rem)]",
          pannable && (dragging ? "cursor-grabbing select-none" : "cursor-grab"),
        )}
      >
        <div className="mx-auto flex w-max min-w-full justify-center" style={{ padding: pad }}>
          {pageFailed ? (
            <div className="rounded-lg bg-surface" style={{ width: innerW || undefined }}>
              <EmptyState
                compact
                title="This page could not be shown"
                action={
                  <>
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
                    <OpenOriginalButton file={file} />
                  </>
                }
              >
                The page image did not render. Open the original to view it.
              </EmptyState>
            </div>
          ) : current ? (
            <img
              ref={imgRef}
              src={current.src}
              alt={pdf ? `Page ${page} of ${file.name}` : file.name}
              draggable={false}
              style={{ width: cssW ?? innerW, maxWidth: "none" }}
              className={cn("block h-auto select-none bg-surface shadow-panel", marked && "ring-2 ring-brand ring-offset-2 ring-offset-sunken")}
            />
          ) : (
            <div className="min-h-[50dvh]" style={{ width: innerW || undefined }}>
              <Skeleton className="h-[50dvh] w-full rounded-none" />
            </div>
          )}
        </div>
        {!current && !pageFailed ? <span className="sr-only" role="status">Loading the page</span> : null}
      </div>

      {full ? (
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 border-t border-line bg-surface px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          {pageControls}
          <div className="flex w-full items-center justify-center gap-2 sm:w-auto">{zoomControls}</div>
        </div>
      ) : null}
    </div>
  );
}
