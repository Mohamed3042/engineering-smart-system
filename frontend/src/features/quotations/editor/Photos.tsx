/**
 * Product reference photos: printed in an annex after the quotation (two per page) or placed on a
 * quotation page. Each photo shows a thumbnail with its caption and where it prints; the real pages of
 * the PDF below show where the photos and the stamp land. Uploads and changes apply at once (they are
 * not part of the unsaved working copy).
 */
import { useMutation } from "@tanstack/react-query";
import { EllipsisVertical, ImageIcon, ImageOff, ImagePlus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import { isRtl } from "@/lib/format";
import { Button, Dialog, EmptyState, Field, IconButton, Input, Menu, Segmented, toast, type MenuItem } from "@/ui";
import { photoUrl, useQuoteUpdated, type Photo, type Quote, type StampSettings } from "../api";
import { ExplainedError, FileButton } from "../components";
import { isFrozen } from "../lib";
import { stampSummary } from "./DocumentPanel";
import { PagesStrip } from "./PagePreview";
import { EditorSection } from "./sections";

type Placement = Photo["placement"];

export function photoPage(p: Placement): number | null {
  return p && typeof p === "object" && p.mode !== "annex" ? Math.max(1, Number(p.page) || 1) : null;
}

function placementLabel(p: Placement): string {
  const page = photoPage(p);
  return page ? `On page ${page}` : "Annex after the quotation";
}

function fileName(path?: string): string {
  return path ? (path.split(/[\\/]/).pop() ?? path) : "Photo";
}

/** One line for the folded section and the section list. */
export function photosSummary(q: Quote, stamp: StampSettings): string {
  const n = (q.data.photos ?? []).length;
  return `${n ? `${n} ${n === 1 ? "photo" : "photos"}` : "No photos"} · ${stamp.show === false ? "no stamp" : "stamp on the approved PDF"}`;
}

/* ------------------------------------------------------------------ one photo */

function PhotoThumb({ q, index, caption, onOpen, onMissing }: { q: Quote; index: number; caption?: string; onOpen: () => void; onMissing: () => void }) {
  const [failed, setFailed] = useState(false);
  const label = caption || `Reference photo ${index + 1}`;
  if (failed)
    return (
      <span role="img" aria-label="The photo file is missing" className="grid size-14 shrink-0 place-items-center rounded-md bg-sunken text-ink-3 sm:size-16">
        <ImageOff className="size-5" aria-hidden />
      </span>
    );
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open photo ${index + 1}: ${label}`}
      className="shrink-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
    >
      <img
        src={photoUrl(q.id, index, q.updated_at)}
        alt=""
        loading="lazy"
        onError={() => {
          setFailed(true);
          onMissing();
        }}
        className="size-14 rounded-md border border-line object-cover sm:size-16"
      />
    </button>
  );
}

function PhotoViewer({ q, index, onClose }: { q: Quote; index: number; onClose: () => void }) {
  const p = (q.data.photos ?? [])[index];
  const [failed, setFailed] = useState(false);
  if (!p) return null;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={p.caption || `Reference photo ${index + 1}`}
      description={`${placementLabel(p.placement)} · ${fileName(p.path)}`}
    >
      {failed ? (
        <EmptyState compact icon={<ImageOff />} title="The photo file is missing">
          Remove this photo and add it again.
        </EmptyState>
      ) : (
        <img
          src={photoUrl(q.id, index, q.updated_at)}
          alt={p.caption || `Reference photo ${index + 1}`}
          onError={() => setFailed(true)}
          className="mx-auto max-h-[70dvh] w-auto max-w-full rounded-md border border-line"
        />
      )}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ section */

export function PhotosPanel({
  q,
  stamp,
  dirty,
  onEditStamp,
}: {
  q: Quote;
  /** The stamp settings on screen. */
  stamp: StampSettings;
  dirty: boolean;
  onEditStamp: () => void;
}) {
  const photos = q.data.photos ?? [];
  const frozen = isFrozen(q.status);
  const updated = useQuoteUpdated();
  const [addOpen, setAddOpen] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const [pageViewer, setPageViewer] = useState<number | null>(null);
  const [missing, setMissing] = useState<Set<string>>(() => new Set());
  const change = useMutation({
    mutationFn: (next: Photo[]) => api.put<Quote>(`/quotations/${q.id}`, { data: { photos: next } }),
    onSuccess: async (saved) => {
      toast.success("Photos updated");
      await updated(saved);
    },
  });

  const menu = (i: number): MenuItem[] => {
    const p = photos[i];
    const page = photoPage(p.placement);
    const set = (placement: Placement) => change.mutate(photos.map((x, j) => (j === i ? { ...x, placement } : x)));
    return [
      page
        ? { label: "Print in the annex instead", onSelect: () => set("annex") }
        : { label: "Place on page 1 instead", onSelect: () => set({ mode: "page", page: 1 }) },
      { label: "Remove from the quotation", icon: <Trash2 />, danger: true, separatorBefore: true, onSelect: () => change.mutate(photos.filter((_, j) => j !== i)) },
    ];
  };

  return (
    <EditorSection
      id="photos"
      flush
      title="Reference photos and stamp"
      description="Product photos printed in an annex after the quotation, or placed on a page. The stamp prints on the approved PDF."
      summary={photosSummary(q, stamp)}
      actions={
        frozen ? null : (
          <Button variant="secondary" size="sm" icon={<ImagePlus />} onClick={() => setAddOpen(true)}>
            Add photo
          </Button>
        )
      }
    >
      {photos.length === 0 ? (
        <EmptyState compact icon={<ImageIcon />} title="No reference photos">
          Add a product photo when the customer should see what is offered. Photos are resized to print sharply.
        </EmptyState>
      ) : (
        <>
          <ul className="divide-y divide-line">
            {photos.map((p, i) => {
              const page = photoPage(p.placement);
              const gone = missing.has(`${i}:${p.path}`);
              return (
                <li key={`${i}:${p.path ?? ""}`} className="flex items-start gap-3 px-4 py-3 sm:px-5">
                  <PhotoThumb
                    q={q}
                    index={i}
                    caption={p.caption}
                    onOpen={() => setViewing(i)}
                    onMissing={() => setMissing((m) => new Set(m).add(`${i}:${p.path}`))}
                  />
                  <div className="min-w-0 flex-1">
                    <p dir={isRtl(p.caption) ? "rtl" : "auto"} className="font-medium text-ink">
                      {p.caption || <span className="font-normal text-ink-3">No caption</span>}
                    </p>
                    <p className="text-sm text-ink-3">
                      {placementLabel(p.placement)} · <span className="font-mono text-xs">{fileName(p.path)}</span>
                    </p>
                    {gone ? <p className="text-sm text-review">The photo file is missing. Remove it and add it again.</p> : null}
                    {page ? (
                      <Button variant="link" size="sm" onClick={() => setPageViewer(page)} className="mt-0.5">
                        See page {page}
                      </Button>
                    ) : null}
                  </div>
                  {!frozen ? (
                    <Menu
                      items={menu(i)}
                      trigger={
                        <IconButton label={`Actions for photo ${i + 1}`} size="sm" tooltip={false} disabled={change.isPending}>
                          <EllipsisVertical />
                        </IconButton>
                      }
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
          <PagesStrip q={q} dirty={dirty} viewer={pageViewer} onViewerChange={setPageViewer} className="border-t border-line px-4 py-4 sm:px-5" />
        </>
      )}
      <div className="flex flex-col gap-2 border-t border-line px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <p className="min-w-0 text-sm text-ink-2">
          <span className="font-medium text-ink">Stamp: </span>
          {stampSummary(stamp)}
        </p>
        <Button variant="secondary" size="sm" onClick={onEditStamp} className="max-sm:w-full">
          {frozen ? "View stamp placement" : "Edit stamp placement"}
        </Button>
      </div>
      {change.error ? (
        <div className="border-t border-line px-4 py-3 sm:px-5">
          <ExplainedError error={change.error} q={q} />
        </div>
      ) : null}
      <AddPhotoDialog open={addOpen} onOpenChange={setAddOpen} q={q} />
      {viewing !== null ? <PhotoViewer q={q} index={viewing} onClose={() => setViewing(null)} /> : null}
    </EditorSection>
  );
}

function AddPhotoDialog({ open, onOpenChange, q }: { open: boolean; onOpenChange: (o: boolean) => void; q: Quote }) {
  const updated = useQuoteUpdated();
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState("");
  const [where, setWhere] = useState<"annex" | "page">("annex");
  const [page, setPage] = useState("1");
  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Choose a photo first.");
      const fields = { caption: caption.trim(), placement: where };
      // The backend reads caption and placement from the query string; send them as form fields too.
      const qs = new URLSearchParams(fields).toString();
      let saved = await api.upload<Quote>(`/quotations/${q.id}/photos?${qs}`, file, fields);
      if (where === "page") {
        // A bare "page" is printed in the annex: store the page placement the renderer reads.
        const list = saved.data.photos ?? [];
        const n = Math.max(1, Math.trunc(Number(page)) || 1);
        saved = await api.put<Quote>(`/quotations/${q.id}`, {
          data: { photos: list.map((p, i) => (i === list.length - 1 ? { ...p, placement: { mode: "page", page: n } } : p)) },
        });
      }
      return saved;
    },
    onSuccess: async (saved) => {
      toast.success("Photo added", { description: where === "page" ? `Placed on page ${page}.` : "Printed in the annex after the quotation." });
      onOpenChange(false);
      await updated(saved);
    },
  });
  const { reset } = upload;
  useEffect(() => {
    if (open) {
      setFile(null);
      setCaption("");
      setWhere("annex");
      setPage("1");
      reset();
    }
  }, [open, reset]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !upload.isPending && onOpenChange(o)}
      title="Add a reference photo"
      description="JPEG or PNG. It is resized to at most 1600 pixels on the longest edge."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={upload.isPending}>
            Cancel
          </Button>
          <Button onClick={() => upload.mutate()} disabled={!file} loading={upload.isPending}>
            {file ? "Add photo" : "Choose a photo first"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <FileButton accept="image/jpeg,image/png,image/webp" onFile={setFile} icon={<ImagePlus />}>
            {file ? "Choose another photo" : "Choose a photo"}
          </FileButton>
          {file ? <span className="min-w-0 break-all text-sm text-ink-2">{file.name}</span> : <span className="text-sm text-ink-3">No photo chosen</span>}
        </div>
        <Field label="Caption" optional htmlFor="photo-caption" hint="Printed under the photo.">
          <Input id="photo-caption" value={caption} dir={isRtl(caption) ? "rtl" : "auto"} onChange={(e) => setCaption(e.target.value)} />
        </Field>
        <div className="space-y-2">
          <p className="text-sm font-medium text-ink">Where it prints</p>
          <Segmented
            label="Where the photo prints"
            value={where}
            onChange={(v) => setWhere(v === "page" ? "page" : "annex")}
            options={[
              { value: "annex", label: "Annex page" },
              { value: "page", label: "On a quotation page" },
            ]}
          />
          {where === "page" ? (
            <Field label="Page" htmlFor="photo-page" hint="If it would cover text, the stamp or the letterhead, it moves to a free spot or to the annex.">
              <Input id="photo-page" type="number" min={1} value={page} onChange={(e) => setPage(e.target.value)} className="w-28" />
            </Field>
          ) : null}
        </div>
        <ExplainedError error={upload.error} q={q} />
      </div>
    </Dialog>
  );
}
