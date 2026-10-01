/**
 * Signatories: the people who sign quotations, which one is the default, and whether a signature
 * image is on file. "Import signature from a photo": detect where the signature (and the stamp) is
 * on a photo of a signed letter, show it, let the person correct the box, then import.
 */
import { useMutation } from "@tanstack/react-query";
import { CircleAlert, EllipsisVertical, ImageUp, Pencil, Plus, Signature, Star, Trash2, UserPen } from "lucide-react";
import { useEffect, useState, type PointerEvent } from "react";
import { api } from "@/api/client";
import { useWorkspace } from "@/api/session";
import {
  Button,
  Checkbox,
  Chip,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  ListRow,
  LoadingRows,
  Menu,
  Panel,
  PanelHeader,
  QueryState,
  Skeleton,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  toast,
  toastError,
  type MenuItem,
} from "@/ui";
import { useInvalidate, useSignatories, type Box, type SignatoryRow, type SignatureDetection } from "../api";
import { ExplainedError, FileButton, Reason } from "../components";
import { useRoleGate } from "../lib";

function SignatureChip({ s }: { s: SignatoryRow }) {
  return s.has_signature_image ? (
    <Chip tone="brand" size="sm" icon={<Signature aria-hidden />}>
      Signature on file
    </Chip>
  ) : (
    <Chip tone="review" size="sm" icon={<CircleAlert aria-hidden />}>
      No signature image
    </Chip>
  );
}

export function SignatoriesTab() {
  const sigs = useSignatories();
  const invalidate = useInvalidate();
  const denied = useRoleGate()("admin", "Changing signatories");
  const [editing, setEditing] = useState<SignatoryRow | "new" | null>(null);
  const [importing, setImporting] = useState<SignatoryRow | null>(null);
  const [removing, setRemoving] = useState<SignatoryRow | null>(null);

  const makeDefault = useMutation({
    mutationFn: (s: SignatoryRow) => api.patch(`/signatories/${s.id}`, { is_default: true }),
    onSuccess: async (_, s) => {
      toast.success(`${s.full_name || s.initials} is the default signatory`);
      await invalidate(["signatories"]);
    },
    onError: (e) => toastError(e),
  });
  const remove = useMutation({
    mutationFn: (s: SignatoryRow) => api.del(`/signatories/${s.id}`),
    onSuccess: async () => {
      toast.success("Signatory removed");
      setRemoving(null);
      await invalidate(["signatories"]);
    },
  });

  const menu = (s: SignatoryRow): MenuItem[] => [
    { label: "Edit details", icon: <Pencil />, onSelect: () => setEditing(s), disabled: Boolean(denied) },
    {
      label: s.has_signature_image ? "Replace signature from a photo" : "Import signature from a photo",
      icon: <ImageUp />,
      onSelect: () => setImporting(s),
      disabled: Boolean(denied),
    },
    ...(s.is_default ? [] : [{ label: "Make default", icon: <Star />, onSelect: () => makeDefault.mutate(s), disabled: Boolean(denied) }]),
    { label: "Remove signatory", icon: <Trash2 />, danger: true, separatorBefore: true, onSelect: () => setRemoving(s), disabled: Boolean(denied) },
  ];
  const actions = (s: SignatoryRow) => (
    <Menu
      items={menu(s)}
      trigger={
        <IconButton label={`Actions for ${s.full_name || s.initials}`} size="sm" tooltip={false}>
          <EllipsisVertical />
        </IconButton>
      }
    />
  );

  return (
    <Panel>
      <PanelHeader
        title="Signatories"
        description="People who sign quotations. Approved PDFs print the signature image; drafts never do."
        actions={
          <Button icon={<Plus />} onClick={() => setEditing("new")} disabled={Boolean(denied)}>
            Add signatory
          </Button>
        }
      />
      {denied ? <Reason className="px-5 pt-3">{denied}</Reason> : null}
      <QueryState
        query={sigs}
        loading={<LoadingRows rows={3} />}
        isEmpty={(d) => d.length === 0}
        empty={
          <EmptyState icon={<UserPen />} title="No signatories yet">
            Quotations are signed by a named person. Add the people who sign, then import each signature from a photo of a signed
            letter.
          </EmptyState>
        }
      >
        {(list) => (
          <>
            <div className="hidden lg:block">
              <Table>
                <THead>
                  <tr>
                    <TH>Signatory</TH>
                    <TH>Initials</TH>
                    <TH>Contact</TH>
                    <TH>Signature</TH>
                    <TH>
                      <span className="sr-only">Actions</span>
                    </TH>
                  </tr>
                </THead>
                <TBody>
                  {list.map((s) => (
                    <TR key={s.id}>
                      <TD>
                        <p className="flex flex-wrap items-center gap-2 font-medium text-ink">
                          {s.full_name || "—"}
                          {s.is_default ? (
                            <Chip size="sm" tone="neutral" icon={<Star aria-hidden />}>
                              Default
                            </Chip>
                          ) : null}
                        </p>
                        <p className="text-sm text-ink-3">{[s.title, s.company, s.city].filter(Boolean).join(" · ") || "—"}</p>
                      </TD>
                      <TD className="font-mono text-sm">{s.initials}</TD>
                      <TD className="text-sm text-ink-2">
                        <p>{s.email || "—"}</p>
                        {s.phone ? <p className="text-ink-3">{s.phone}</p> : null}
                      </TD>
                      <TD>
                        <SignatureChip s={s} />
                      </TD>
                      <TD className="w-64 text-right">
                        <div className="flex items-center justify-end gap-2">
                          {!s.has_signature_image ? (
                            <Button size="sm" variant="secondary" icon={<ImageUp />} onClick={() => setImporting(s)} disabled={Boolean(denied)}>
                              Import signature
                            </Button>
                          ) : null}
                          {actions(s)}
                        </div>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
            <ul className="space-y-3 p-4 lg:hidden">
              {list.map((s) => (
                <li key={s.id}>
                  <ListRow
                    title={s.full_name || s.initials}
                    subtitle={[s.title, s.initials].filter(Boolean).join(" · ")}
                    aside={actions(s)}
                    footer={
                      <Button
                        className="w-full"
                        variant={s.has_signature_image ? "secondary" : "primary"}
                        icon={<ImageUp />}
                        onClick={() => setImporting(s)}
                        disabled={Boolean(denied)}
                      >
                        {s.has_signature_image ? "Replace signature" : "Import signature from a photo"}
                      </Button>
                    }
                  >
                    <div className="flex flex-wrap gap-2">
                      <SignatureChip s={s} />
                      {s.is_default ? (
                        <Chip size="sm" tone="neutral" icon={<Star aria-hidden />}>
                          Default
                        </Chip>
                      ) : null}
                    </div>
                    {s.email || s.phone ? <p className="mt-2">{[s.email, s.phone].filter(Boolean).join(" · ")}</p> : null}
                  </ListRow>
                </li>
              ))}
            </ul>
          </>
        )}
      </QueryState>

      <SignatoryDialog value={editing} onClose={() => setEditing(null)} />
      <SignatureImportDialog sig={importing} onClose={() => setImporting(null)} />
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(o) => {
          if (!o) {
            setRemoving(null);
            remove.reset();
          }
        }}
        title={`Remove ${removing?.full_name || removing?.initials || "this signatory"}?`}
        description="They can no longer be chosen to sign quotations."
        confirmLabel="Remove signatory"
        variant="danger"
        loading={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
      >
        <p className="text-sm text-ink-2">
          Quotations that name this person print without a signatory until you choose another one. The signature image stays in the
          private folder.
        </p>
        <ExplainedError error={remove.error} className="mt-3" />
      </ConfirmDialog>
    </Panel>
  );
}

/* ------------------------------------------------------------------ add / edit */

const EMPTY = { initials: "", full_name: "", title: "", company: "", city: "", email: "", phone: "", is_default: false };

function SignatoryDialog({ value, onClose }: { value: SignatoryRow | "new" | null; onClose: () => void }) {
  const ws = useWorkspace();
  const invalidate = useInvalidate();
  const [f, setF] = useState(EMPTY);
  const [tried, setTried] = useState(false);
  const editing = value && value !== "new" ? value : null;
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, initials: f.initials.trim().toUpperCase(), phone: f.phone || null };
      return editing ? api.patch(`/signatories/${editing.id}`, body) : api.post("/signatories", body);
    },
    onSuccess: async () => {
      toast.success(editing ? "Signatory updated" : "Signatory added", {
        description: editing ? undefined : "Import the signature from a photo so approved PDFs carry it.",
      });
      onClose();
      await invalidate(["signatories"]);
    },
  });
  const { reset } = save;
  const open = value !== null;
  const companyName = ws.company_name;
  useEffect(() => {
    if (!value) return;
    reset();
    setTried(false);
    setF(
      value === "new"
        ? { ...EMPTY, company: companyName }
        : {
            initials: value.initials,
            full_name: value.full_name,
            title: value.title,
            company: value.company,
            city: value.city,
            email: value.email,
            phone: value.phone ?? "",
            is_default: value.is_default,
          },
    );
  }, [value, companyName, reset]);

  const missing = { initials: !f.initials.trim(), full_name: !f.full_name.trim() };
  const input = (k: keyof typeof EMPTY, label: string, opts: { required?: boolean; type?: string; hint?: string; disabled?: boolean } = {}) => (
    <Field
      label={label}
      required={opts.required}
      htmlFor={`sig-${k}`}
      hint={opts.hint}
      error={tried && opts.required && missing[k as "initials" | "full_name"] ? `Enter the ${label.toLowerCase()}.` : undefined}
    >
      <Input
        id={`sig-${k}`}
        type={opts.type}
        value={String(f[k])}
        disabled={opts.disabled}
        maxLength={k === "initials" ? 4 : undefined}
        onChange={(e) => setF({ ...f, [k]: k === "initials" ? e.target.value.toUpperCase() : e.target.value })}
      />
    </Field>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && !save.isPending && onClose()}
      title={editing ? `Edit ${editing.full_name || editing.initials}` : "Add a signatory"}
      description="Printed under the signature on every quotation they sign."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button
            loading={save.isPending}
            onClick={() => {
              setTried(true);
              if (!missing.initials && !missing.full_name) save.mutate();
            }}
          >
            {editing ? "Save signatory" : "Add signatory"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {input("full_name", "Full name", { required: true })}
        {input("initials", "Initials", {
          required: true,
          disabled: Boolean(editing),
          hint: editing ? "Initials name the signature file and the quotation numbers; they cannot change." : "Up to 4 letters. Used in quotation numbers.",
        })}
        {input("title", "Job title")}
        {input("company", "Company")}
        {input("city", "City")}
        {input("email", "E-mail", { type: "email" })}
        {input("phone", "Phone")}
        <div className="flex items-end pb-2">
          <Checkbox
            checked={f.is_default}
            onChange={(v) => setF({ ...f, is_default: v })}
            label="Default signatory"
            description="Signs new quotations unless a rule says otherwise."
          />
        </div>
      </div>
      <ExplainedError error={save.error} className="mt-4" />
    </Dialog>
  );
}

/* ------------------------------------------------------------------ signature import */

function BoxPicker({
  src,
  size,
  signature,
  stamp,
  onDraw,
}: {
  src: string;
  size: [number, number];
  signature: Box | null;
  stamp: Box | null;
  onDraw: (b: Box) => void;
}) {
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [W, H] = size;
  const point = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const clamp = (v: number) => Math.min(Math.max(v, 0), 1);
    return { x: clamp((e.clientX - r.left) / r.width) * W, y: clamp((e.clientY - r.top) / r.height) * H };
  };
  const live: Box | null = drag
    ? [Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1), Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0)]
    : null;
  const shown = live ?? signature;
  const pct = (b: Box) => ({
    left: `${(b[0] / W) * 100}%`,
    top: `${(b[1] / H) * 100}%`,
    width: `${(b[2] / W) * 100}%`,
    height: `${(b[3] / H) * 100}%`,
  });
  return (
    <div
      role="img"
      aria-label="Photo of the signed letter. Drag across it to draw a box around the signature."
      className="relative max-h-[55dvh] w-full cursor-crosshair touch-none select-none overflow-hidden rounded-lg border border-line bg-sunken"
      style={{ aspectRatio: `${W} / ${H}` }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const p = point(e);
        setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        const p = point(e);
        setDrag({ ...drag, x1: p.x, y1: p.y });
      }}
      onPointerUp={() => {
        if (live && live[2] > W * 0.02 && live[3] > H * 0.01) onDraw(live.map((v) => Math.round(v)) as Box);
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}
    >
      <img src={src} alt="" draggable={false} className="absolute inset-0 h-full w-full object-fill" />
      {stamp ? (
        <div className="absolute rounded-full border-2 border-dashed border-review-mark" style={pct(stamp)}>
          <span className="absolute left-1 top-1 rounded bg-review-soft px-1.5 py-0.5 text-xs font-medium text-review">Stamp, left out</span>
        </div>
      ) : null}
      {shown ? (
        <div className="absolute border-2 border-brand bg-brand/10" style={pct(shown)}>
          <span className="absolute left-0 top-0 rounded-br bg-brand px-1.5 py-0.5 text-xs font-medium text-white">Signature</span>
        </div>
      ) : null}
    </div>
  );
}

function SignatureImportDialog({ sig, onClose }: { sig: SignatoryRow | null; onClose: () => void }) {
  const invalidate = useInvalidate();
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [found, setFound] = useState<SignatureDetection | null>(null);
  const [drawn, setDrawn] = useState<Box | null>(null);
  const name = sig ? sig.full_name || sig.initials : "";

  const detect = useMutation({
    mutationFn: (f: File) => api.upload<SignatureDetection>(`/signatories/${sig?.id}/signature/detect`, f),
    onSuccess: (d) => {
      setFound(d);
      setDrawn(null);
    },
  });
  const done = async (description: string) => {
    toast.success(`Signature saved for ${name}`, { description });
    await invalidate(["signatories"]);
    onClose();
  };
  const cut = useMutation({
    mutationFn: () => {
      const b = drawn ?? found?.signature;
      if (!file || !b) throw new Error("Draw a box around the signature first.");
      const [x, y, w, h] = b;
      return api.upload(`/signatories/${sig?.id}/signature?mode=detect&x=${x}&y=${y}&w=${w}&h=${h}`, file);
    },
    onSuccess: () => done("Approved PDFs print it. Drafts never do."),
  });
  const raw = useMutation({
    mutationFn: (f: File) => api.upload(`/signatories/${sig?.id}/signature?mode=raw`, f),
    onSuccess: () => done("The PNG is used as it is. Approved PDFs print it; drafts never do."),
  });

  const resetDetect = detect.reset;
  const resetCut = cut.reset;
  const resetRaw = raw.reset;
  const sigId = sig?.id;
  useEffect(() => {
    if (!sigId) return;
    setFile(null);
    setFound(null);
    setDrawn(null);
    resetDetect();
    resetCut();
    resetRaw();
  }, [sigId, resetDetect, resetCut, resetRaw]);
  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  const choose = (f: File) => {
    setFile(f);
    setFound(null);
    setDrawn(null);
    cut.reset();
    detect.mutate(f);
  };
  const box = drawn ?? found?.signature ?? null;
  const busy = detect.isPending || cut.isPending || raw.isPending;

  return (
    <Dialog
      open={Boolean(sig)}
      onOpenChange={(o) => !o && !busy && onClose()}
      title={`Import the signature of ${name}`}
      description="From a photo or scan of a letter they signed in blue ink. The signature is cut out on a transparent background; the stamp is left out."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => cut.mutate()} disabled={!found || !box} loading={cut.isPending}>
            {found && !box ? "Draw a box first" : "Import this signature"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <FileButton accept="image/*" onFile={choose} icon={<ImageUp />} variant={file ? "secondary" : "primary"} disabled={busy}>
            {file ? "Choose another photo" : "Choose a photo"}
          </FileButton>
          {file ? <span className="min-w-0 break-all text-sm text-ink-2">{file.name}</span> : null}
        </div>

        {detect.isPending ? (
          <div role="status" aria-label="Looking for the signature" className="space-y-2">
            <Skeleton className="h-48 w-full" />
            <p className="text-sm text-ink-3">Looking for the signature and the stamp…</p>
          </div>
        ) : null}
        <ExplainedError error={detect.error} />

        {found && url ? (
          <div className="space-y-3">
            <BoxPicker src={url} size={found.size} signature={box} stamp={found.stamp} onDraw={setDrawn} />
            <p className="text-sm text-ink-2">
              {drawn ? (
                <>
                  <span className="font-medium text-ink">Your box is used.</span>{" "}
                  {found.signature ? (
                    <Button variant="link" size="sm" onClick={() => setDrawn(null)}>
                      Use the detected box again
                    </Button>
                  ) : null}
                </>
              ) : found.signature ? (
                <>
                  <span className="font-medium text-ink">Signature found, {found.confidence}% confident.</span> If the box is wrong,
                  drag across the photo to draw a new one.
                </>
              ) : (
                <>
                  <span className="font-medium text-review">No signature found.</span> Drag across the photo to draw a box around
                  the signature; inside a box, black pen works too.
                </>
              )}
            </p>
            {found.notes.length ? (
              <ul className="list-disc space-y-1 pl-5 text-sm text-ink-3">
                {found.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        <ExplainedError error={cut.error} />

        {!file ? (
          <div className="border-t border-line pt-4">
            <p className="text-sm text-ink-3">Already have a clean signature on a transparent background?</p>
            <FileButton accept="image/png" onFile={(f) => raw.mutate(f)} variant="ghost" size="sm" loading={raw.isPending} className="mt-1 -ml-3">
              Upload a transparent PNG as it is
            </FileButton>
            <ExplainedError error={raw.error} className="mt-2" />
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
