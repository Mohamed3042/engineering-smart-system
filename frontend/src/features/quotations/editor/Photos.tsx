/**
 * Product reference photos: printed in an annex after the quotation (two per page) or placed on a
 * quotation page. Uploads and changes apply at once (they are not part of the unsaved working copy).
 */
import { useMutation } from "@tanstack/react-query";
import { EllipsisVertical, Eye, ImageIcon, ImagePlus, Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import { isRtl } from "@/lib/format";
import { Button, Dialog, EmptyState, Field, IconButton, Input, Menu, Panel, PanelHeader, Segmented, toast, type MenuItem } from "@/ui";
import { photoImageUrl, useQuoteUpdated, type Photo, type Quote } from "../api";
import { ExplainedError, FileButton } from "../components";
import { isFrozen, parseAmount } from "../lib";
import { RenderedPages } from "./RenderedPages";

type Placement = Photo["placement"];

function pageOf(p: Placement): number | null {
  return p && typeof p === "object" && p.mode !== "annex" ? Math.max(1, Number(p.page) || 1) : null;
}

function placementLabel(p: Placement): string {
  const page = pageOf(p);
  return page ? `On page ${page}` : "Annex after the quotation";
}

function fileName(path?: string): string {
  return path ? (path.split(/[\\/]/).pop() ?? path) : "Photo";
}

export function PhotosPanel({ q }: { q: Quote }) {
  const photos = q.data.photos ?? [];
  const frozen = isFrozen(q.status);
  const updated = useQuoteUpdated();
  const [addOpen, setAddOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewPage, setPreviewPage] = useState(1);
  const [editing, setEditing] = useState<number | null>(null);
  const change = useMutation({
    mutationFn: (next: Photo[]) => api.put<Quote>(`/quotations/${q.id}`, { data: { photos: next } }),
    onSuccess: async (saved) => {
      toast.success("Photos updated");
      await updated(saved);
    },
  });

  const menu = (i: number): MenuItem[] => {
    const p = photos[i];
    const page = pageOf(p.placement);
    const set = (placement: Placement) => change.mutate(photos.map((x, j) => (j === i ? { ...x, placement } : x)));
    return [
      { label: "Edit caption and placement", icon: <Pencil />, onSelect: () => setEditing(i) },
      { label: "Inspect rendered PDF pages", icon: <Eye />, onSelect: () => { setPreviewPage(page ?? 1); setPreviewOpen(true); } },
      page
        ? { label: "Print in the annex instead", onSelect: () => set("annex") }
        : { label: "Place on page 1 instead", onSelect: () => set({ mode: "page", page: 1 }) },
      { label: "Remove from the quotation", icon: <Trash2 />, danger: true, separatorBefore: true, onSelect: () => change.mutate(photos.filter((_, j) => j !== i)) },
    ];
  };

  return (
    <Panel>
      <PanelHeader
        title="Reference photos"
        description="Product photos printed in an annex after the quotation, or placed on a page."
        actions={
          <>
          <Button variant="ghost" size="sm" icon={<Eye />} onClick={() => { setPreviewPage(1); setPreviewOpen(true); }}>View printed pages</Button>
          {frozen ? null : (
            <Button variant="secondary" size="sm" icon={<ImagePlus />} onClick={() => setAddOpen(true)}>
              Add photo
            </Button>
          )}
          </>
        }
      />
      {photos.length === 0 ? (
        <EmptyState compact icon={<ImageIcon />} title="No reference photos">
          Add a product photo when the customer should see what is offered. Photos are resized to print sharply.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {photos.map((p, i) => (
            <li key={`${p.path ?? i}`} className="flex items-start gap-3 px-5 py-3">
              <button type="button" className="shrink-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-brand" onClick={() => { setPreviewPage(pageOf(p.placement) ?? 1); setPreviewOpen(true); }} aria-label={`Inspect where photo ${i + 1} prints`}><PhotoThumbnail q={q} index={i} caption={p.caption} /></button>
              <div className="min-w-0 flex-1">
                <p dir={isRtl(p.caption) ? "rtl" : "auto"} className="font-medium text-ink">
                  {p.caption || <span className="font-normal text-ink-3">No caption</span>}
                </p>
                <p className="text-sm text-ink-3">
                  {placementLabel(p.placement)} · <span className="font-mono text-xs">{fileName(p.path)}</span>
                </p>
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
          ))}
        </ul>
      )}
      {change.error ? (
        <div className="border-t border-line px-5 py-3">
          <ExplainedError error={change.error} q={q} />
        </div>
      ) : null}
      <AddPhotoDialog open={addOpen} onOpenChange={setAddOpen} q={q} />
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen} title="Printed reference photos" description="The actual saved PDF. Photos that cannot fit safely on the requested page are printed in the annex." size="lg" footer={<Button variant="secondary" onClick={() => setPreviewOpen(false)}>Close</Button>}>
        <RenderedPages q={q} initialPage={previewPage} enabled={previewOpen} />
      </Dialog>
      <PhotoPlacementDialog q={q} index={editing} onClose={() => setEditing(null)} />
    </Panel>
  );
}

function AddPhotoDialog({ open, onOpenChange, q }: { open: boolean; onOpenChange: (o: boolean) => void; q: Quote }) {
  const updated = useQuoteUpdated();
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState("");
  const [where, setWhere] = useState<"annex" | "page">("annex");
  const [page, setPage] = useState("1");
  const [preview, setPreview] = useState<string | null>(null);
  const uploaded = useRef<Quote | null>(null);
  useEffect(() => {
    if (!file) { setPreview(null); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Choose a photo first.");
      const fields = { caption: caption.trim(), placement: "annex" };
      let saved = uploaded.current ?? await api.upload<Quote>(`/quotations/${q.id}/photos`, file, fields);
      uploaded.current = saved; // Retrying a placement failure must not upload the same photo twice.
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
      toast.success("Photo added", { description: where === "page" ? `Requested page ${page}. Check the printed pages: it may move to the annex to avoid covering text.` : "Printed in the annex after the quotation." });
      onOpenChange(false);
      await updated(saved);
    },
    onError: async () => { if (uploaded.current) await updated(uploaded.current); },
  });
  const { reset } = upload;
  useEffect(() => {
    if (open) {
      setFile(null);
      setCaption("");
      setWhere("annex");
      setPage("1");
      uploaded.current = null;
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
          <Button onClick={() => upload.mutate()} disabled={!file || (where === "page" && (!Number.isInteger(Number(page)) || Number(page) < 1))} loading={upload.isPending}>
            {file ? "Add photo" : "Choose a photo first"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <FileButton disabled={upload.isPending || Boolean(uploaded.current)} accept="image/jpeg,image/png,image/webp" onFile={setFile} icon={<ImagePlus />}>
            {file ? "Choose another photo" : "Choose a photo"}
          </FileButton>
          {file ? <span className="min-w-0 break-all text-sm text-ink-2">{file.name}</span> : <span className="text-sm text-ink-3">No photo chosen</span>}
        </div>
        {preview ? <img src={preview} alt="Selected reference photo" className="max-h-52 max-w-full rounded-md border border-line object-contain" /> : null}
        <Field label="Caption" optional htmlFor="photo-caption" hint="Printed under the photo.">
          <Input id="photo-caption" disabled={upload.isPending || Boolean(uploaded.current)} value={caption} dir={isRtl(caption) ? "rtl" : "auto"} onChange={(e) => setCaption(e.target.value)} />
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
        {upload.error && uploaded.current ? <p className="text-sm text-review">The photo was stored, but its page placement was not saved. Retry to apply the placement without uploading twice, or close and edit the stored photo.</p> : null}
      </div>
    </Dialog>
  );
}

function PhotoThumbnail({ q, index, caption }: { q: Quote; index: number; caption?: string }) {
  const [failed, setFailed] = useState(false);
  const src = photoImageUrl(q, index);
  useEffect(() => { setFailed(false); }, [src]);
  return failed ? <span className="grid h-20 w-24 place-items-center rounded-md border border-line bg-sunken p-2 text-xs text-ink-3"><ImageIcon className="size-5" aria-hidden />Image unavailable</span> : <img src={src} alt={caption || `Reference photo ${index + 1}`} loading="lazy" onError={() => setFailed(true)} className="h-20 w-24 rounded-md border border-line bg-sunken object-contain" />;
}

function PhotoPlacementDialog({ q, index, onClose }: { q: Quote; index: number | null; onClose: () => void }) {
  const updated = useQuoteUpdated();
  const [caption, setCaption] = useState("");
  const [where, setWhere] = useState("annex");
  const [page, setPage] = useState("1");
  const [x, setX] = useState("");
  const [y, setY] = useState("");
  const [width, setWidth] = useState("");
  const photo = index === null ? undefined : q.data.photos?.[index];
  const current = useRef(photo);
  current.current = photo;
  const change = useMutation({
    mutationFn: () => {
      const placement: Placement = where === "annex" ? "annex" : {
        mode: "page", page: Number(page),
        ...(parseAmount(x) !== null ? { x_mm: parseAmount(x)! } : {}),
        ...(parseAmount(y) !== null ? { y_mm: parseAmount(y)! } : {}),
        ...(parseAmount(width) !== null ? { width_mm: parseAmount(width)! } : {}),
      };
      return api.put<Quote>(`/quotations/${q.id}`, { data: { photos: (q.data.photos ?? []).map((p, i) => i === index ? { ...p, caption: caption.trim(), placement } : p) } });
    },
    onSuccess: async (saved) => { toast.success("Photo caption and placement saved"); onClose(); await updated(saved); },
  });
  const { reset } = change;
  useEffect(() => {
    const p = current.current;
    if (index === null || !p) return;
    reset(); setCaption(p.caption ?? "");
    const position = typeof p.placement === "object" ? p.placement : null;
    setWhere(pageOf(p.placement) ? "page" : "annex"); setPage(String(pageOf(p.placement) ?? 1));
    setX(position?.x_mm == null ? "" : String(position.x_mm));
    setY(position?.y_mm == null ? "" : String(position.y_mm));
    setWidth(position?.width_mm == null ? "" : String(position.width_mm));
  }, [index, reset]);
  if (index === null || !photo) return null;
  const invalidPosition = where === "page" && (
    !Number.isInteger(Number(page)) || Number(page) < 1 ||
    [x, y, width].some((v) => v !== "" && parseAmount(v) === null) ||
    (parseAmount(x) ?? 0) < 0 || (parseAmount(x) ?? 0) > 210 ||
    (parseAmount(y) ?? 0) < 0 || (parseAmount(y) ?? 0) > 297 ||
    (width !== "" && ((parseAmount(width) ?? 0) < 25 || (parseAmount(width) ?? 0) > 100))
  );
  return <Dialog open onOpenChange={(open) => !open && !change.isPending && onClose()} title="Photo caption and placement" description="Changes save immediately. The renderer moves a photo that would cover text or the letterhead." size="lg" footer={<><Button variant="secondary" disabled={change.isPending} onClick={onClose}>Cancel</Button><Button disabled={invalidPosition || isFrozen(q.status)} loading={change.isPending} onClick={() => !invalidPosition && change.mutate()}>Save photo</Button></>}>
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-4">
        <PhotoThumbnail q={q} index={index} caption={photo.caption} />
        <Field label="Caption" htmlFor="edit-photo-caption" optional><Input id="edit-photo-caption" value={caption} dir={isRtl(caption) ? "rtl" : "auto"} onChange={(e) => setCaption(e.target.value)} /></Field>
        <Segmented label="Where the photo prints" value={where} onChange={setWhere} options={[{ value: "annex", label: "Annex" }, { value: "page", label: "On a page" }]} />
        {where === "page" ? <>
          <Field label="Page" htmlFor="edit-photo-page"><Input id="edit-photo-page" type="number" min={1} value={page} onChange={(e) => setPage(e.target.value)} /></Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="From left (mm)" htmlFor="edit-photo-x"><Input id="edit-photo-x" inputMode="decimal" placeholder="Automatic" value={x} onChange={(e) => setX(e.target.value)} /></Field>
            <Field label="From top (mm)" htmlFor="edit-photo-y"><Input id="edit-photo-y" inputMode="decimal" placeholder="Automatic" value={y} onChange={(e) => setY(e.target.value)} /></Field>
            <Field label="Width (mm)" htmlFor="edit-photo-width" hint="25 to 100 mm"><Input id="edit-photo-width" inputMode="decimal" placeholder="55" value={width} onChange={(e) => setWidth(e.target.value)} /></Field>
          </div>
        </> : null}
        {invalidPosition ? <p role="alert" className="text-sm text-block">Use a whole page number, positions inside A4 (210 × 297 mm), and a width from 25 to 100 mm.</p> : null}
        <ExplainedError error={change.error} q={q} />
      </div>
      <RenderedPages q={q} initialPage={where === "page" && Number(page) > 0 ? Math.trunc(Number(page)) : 1} />
    </div>
  </Dialog>;
}
