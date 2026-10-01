/**
 * Product reference photos: printed in an annex after the quotation (two per page) or placed on a
 * quotation page. Uploads and changes apply at once (they are not part of the unsaved working copy).
 */
import { useMutation } from "@tanstack/react-query";
import { EllipsisVertical, ImageIcon, ImagePlus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import { isRtl } from "@/lib/format";
import { Button, Dialog, EmptyState, Field, IconButton, Input, Menu, Panel, PanelHeader, Segmented, toast, type MenuItem } from "@/ui";
import { useQuoteUpdated, type Photo, type Quote } from "../api";
import { ExplainedError, FileButton } from "../components";
import { isFrozen } from "../lib";

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
          frozen ? null : (
            <Button variant="secondary" size="sm" icon={<ImagePlus />} onClick={() => setAddOpen(true)}>
              Add photo
            </Button>
          )
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
              <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-md bg-sunken text-ink-3" aria-hidden>
                <ImageIcon className="size-5" />
              </span>
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
    </Panel>
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
