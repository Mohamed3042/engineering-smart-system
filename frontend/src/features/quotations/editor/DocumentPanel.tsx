/**
 * How the PDF looks: template and language, company paper (full letterhead or pre-printed body
 * only), signatory (with or without a signature image) and the company stamp, per page.
 * Choices are part of the working copy and saved with "Save changes".
 *
 * Templates the company switched off stay in the picker as unavailable, with the reason and a link to
 * Quotation setup; the placement dialog shows the real pages of the PDF.
 */
import { BookmarkPlus, CircleAlert, Signature, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import {
  Banner,
  Button,
  Chip,
  Dialog,
  Field,
  IconButton,
  Input,
  Segmented,
  Select,
  Switch,
  toast,
} from "@/ui";
import { usePapers, useSignatories, type Quote, type StampPlacement, type StampSettings, type TemplateInfo } from "../api";
import { dotted, PaperSchematic, SwitchedOffNote } from "../components";
import {
  isTemplateFallback,
  languageLabel,
  PAPERS_SETUP,
  paperModeLabel,
  parseAmount,
  signatoryLabel,
  templateDefaults,
  templateEnabled,
  templateName,
  templateOptions,
  termChanges,
  termStatus,
} from "../lib";
import { PageStage, type StampMark } from "./PagePreview";
import type { AreaProps } from "./QuotationArea";
import { EditorSection } from "./sections";
import type { Draft } from "./useDraft";

const mm = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));

function placementText(p: StampPlacement | undefined): string | null {
  if (!p) return null;
  const parts = [
    p.x_mm != null ? `${p.x_mm} mm from the left` : null,
    p.y_mm != null ? `${p.y_mm} mm from the top` : null,
    p.width_mm != null ? `${p.width_mm} mm wide` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

function documentPlacement(s: StampSettings): StampPlacement | undefined {
  const d = s.default ?? {};
  const x = d.x_mm ?? s.x_mm;
  const y = d.y_mm ?? s.y_mm;
  const w = d.width_mm ?? s.width_mm;
  return x == null && y == null && w == null ? undefined : { x_mm: x, y_mm: y, width_mm: w };
}

export function stampSummary(s: StampSettings): string {
  const show = s.show !== false;
  const pages = Object.entries(s.pages ?? {});
  const where = placementText(documentPlacement(s)) ?? "the paper's default position";
  const pageNotes = pages
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([n, p]) => {
      const stamped = p.show === undefined ? show : p.show !== false;
      return `page ${n}: ${!stamped ? "no stamp" : placementText(p) ? "stamp moved" : "stamped"}`;
    });
  return [show ? `On every page, at ${where}` : "Not printed on the pages", ...pageNotes].join(" · ");
}

/* ------------------------------------------------------------------ what the choices are */

/** The template, paper and signatory the working copy points at, with one line that says so. */
export function useDocumentChoices(d: Draft, templates: TemplateInfo[] | undefined) {
  const papers = usePapers();
  const sigs = useSignatories();
  const template = templates?.find((t) => t.key === d.template_key);
  const paperList = papers.data?.items ?? [];
  const defaultPaperId = papers.data?.default ?? null;
  const paperId = d.data.paper_id || defaultPaperId;
  const paper = paperList.find((p) => p.id === paperId);
  const sigList = sigs.data ?? [];
  const sig = sigList.find((s) => s.id === d.signatory_id) ?? (d.signatory_id ? undefined : sigList.find((s) => s.is_default));
  const templateOff = Boolean(template) && !templateEnabled(template as TemplateInfo, d.language);
  const summary = dotted([
    templateName(templates, d.template_key),
    languageLabel(d.language),
    paper ? <bdi>{paper.name}</bdi> : paperList.length || papers.isLoading ? null : "Specimen letterhead",
    sig ? <bdi>{signatoryLabel(sig)}</bdi> : null,
  ]);
  return { papers, sigs, template, paperList, defaultPaperId, paperId, paper, sigList, sig, templateOff, summary };
}

export type DocumentChoices = ReturnType<typeof useDocumentChoices>;

/* ------------------------------------------------------------------ panel */

export function DocumentPanel({
  q,
  draft,
  readOnly,
  templates,
  templatesError,
  currency,
  choices,
  onSaveRule,
  onEditStamp,
}: {
  q: Quote;
  draft: AreaProps["draft"];
  readOnly: boolean;
  templates: TemplateInfo[] | undefined;
  /** The template list could not be read. */
  templatesError?: boolean;
  currency: string;
  choices: DocumentChoices;
  onSaveRule: () => void;
  onEditStamp: () => void;
}) {
  const d = draft.draft;
  const saved = draft.base ?? d;
  const { papers, sigs, template, paperList, defaultPaperId, paper, sigList, sig, templateOff } = choices;
  const hasArabic = template ? template.languages.includes("ar") : true;
  const templateChanged = saved.template_key !== d.template_key || saved.language !== d.language;

  const applyDefaults = () => {
    const def = templateDefaults(template, d.language, currency);
    // Wording a person accepted from the customer stays agreed.
    const accepted = new Map(
      termChanges(q.data)
        .filter((c) => termStatus(c) === "accepted" && c.to)
        .map((c) => [c.key, String(c.to)]),
    );
    draft.update((data) => ({
      ...data,
      terms: def.terms.map((t) => (accepted.has(t.key) ? { ...t, text: accepted.get(t.key) ?? t.text } : t)),
      exclusions: def.exclusions,
      price_unit: def.priceUnit,
      show_total: def.showTotal,
    }));
    toast.success("Template defaults applied", {
      description: "Terms, exclusions, price unit and total follow the template. Accepted customer wording is kept. Save to keep it.",
    });
  };

  const options = templateOptions(templates, d.language, d.template_key);
  const defaultPaperName = paperList.find((p) => p.id === defaultPaperId)?.name;
  const stamp: StampSettings = d.data.stamp ?? {};
  const stampMissing = q.assets_status?.stamp === "missing";
  const reason = saved.template_key === d.template_key ? q.template_reason : "";

  return (
    <EditorSection
      id="document"
      title="Template, paper and signature"
      description="How the PDF looks. Saved with the quotation."
      summary={choices.summary}
      flag={
        templateOff ? (
          <Chip tone="review" size="sm" icon={<TriangleAlert aria-hidden />}>
            Template switched off
          </Chip>
        ) : null
      }
      actions={
        <Button variant="ghost" size="sm" icon={<BookmarkPlus />} onClick={onSaveRule}>
          Save as template rule
        </Button>
      }
    >
      <div className="space-y-5">
        {templateChanged && !readOnly ? (
          <Banner
            tone="review"
            title={`Terms still follow ${templateName(templates, saved.template_key)} (${languageLabel(saved.language)})`}
            actions={
              <Button size="sm" variant="secondary" onClick={applyDefaults}>
                Use the new template's defaults
              </Button>
            }
          >
            The chosen template prints its own headings and wording. Its default terms, exclusions and price unit apply only if you
            choose so.
          </Banner>
        ) : null}

        <div className="grid gap-x-6 gap-y-6 md:grid-cols-2 xl:grid-cols-4">
          {/* Template and language */}
          <div className="space-y-3">
            <Field label="Template" htmlFor="doc-template" hint={saved.template_key === d.template_key ? undefined : "Not saved yet"}>
              <Select
                id="doc-template"
                value={d.template_key}
                disabled={readOnly}
                options={options.length ? options : [{ value: d.template_key, label: templateName(templates, d.template_key) }]}
                onChange={(e) => {
                  const next = templates?.find((t) => t.key === e.target.value);
                  draft.setChoice({
                    template_key: e.target.value,
                    language: next && !next.languages.includes(d.language) ? "en" : d.language,
                  });
                }}
              />
            </Field>
            {templatesError ? <p className="text-sm text-block">The templates could not be read, so only this one is listed.</p> : null}
            {reason ? (
              <p className={isTemplateFallback(reason, templateName(templates, d.template_key)) ? "text-sm text-review" : "text-sm text-ink-3"}>
                <span className="font-medium">Why this template: </span>
                {reason}
              </p>
            ) : null}
            <SwitchedOffNote templates={templates} language={d.language} current={d.template_key} changed={templateChanged} />
            <div className="space-y-1.5">
              <p className="text-sm font-medium text-ink">Language</p>
              {readOnly ? (
                <p className="text-base text-ink">{languageLabel(d.language)}</p>
              ) : (
                <Segmented
                  label="Quotation language"
                  value={d.language}
                  onChange={(v) => draft.setChoice({ language: v })}
                  options={[{ value: "en", label: "English" }, ...(hasArabic ? [{ value: "ar", label: "Arabic" }] : [])]}
                />
              )}
              <p className="text-sm text-ink-3">
                {hasArabic ? "Headings and template wording follow the language; lines and terms keep their text." : "This template has no Arabic version."}
              </p>
            </div>
            {!readOnly && !templateChanged ? (
              <Button variant="link" size="sm" onClick={applyDefaults}>
                Use the template's default terms
              </Button>
            ) : null}
          </div>

          {/* Paper */}
          <div className="space-y-2">
            {papers.isError ? (
              <Field label="Paper">
                <p className="text-sm text-block">The installed papers could not be read.</p>
              </Field>
            ) : paperList.length === 0 && !papers.isLoading ? (
              <Field label="Paper">
                <p className="text-sm text-ink-2">
                  No company paper is installed. PDFs use a neutral specimen letterhead.{" "}
                  <Link to="/quotations/setup/letterhead" className="font-medium text-brand-ink underline-offset-4 hover:underline">
                    Install the letterhead
                  </Link>
                </p>
              </Field>
            ) : (
              <Field label="Paper" htmlFor="doc-paper">
                <Select
                  id="doc-paper"
                  value={d.data.paper_id ?? ""}
                  disabled={readOnly || papers.isLoading}
                  placeholder={`Workspace default${defaultPaperName ? ` (${defaultPaperName})` : ""}`}
                  options={paperList.map((p) => ({
                    value: p.id,
                    label: `${p.name} · ${paperModeLabel(p.mode)}${p.languages.length && !p.languages.includes(d.language) ? ` (no ${languageLabel(d.language)})` : ""}`,
                  }))}
                  onChange={(e) => draft.setField("paper_id", e.target.value || null)}
                />
              </Field>
            )}
            {paper ? (
              <p className="text-sm text-ink-3">
                {paper.mode === "preprinted"
                  ? "Prints the body only, on white. Load the company's pre-printed paper in the printer."
                  : "Prints the full letterhead: header and footer on plain paper."}
              </p>
            ) : d.data.paper_id && !papers.isLoading && paperList.length ? (
              <p className="text-sm text-review">Paper "{d.data.paper_id}" is not installed: the PDF uses a neutral specimen letterhead.</p>
            ) : null}
            {paper?.warnings.map((w) => (
              <p key={w} className="text-sm text-review">
                {w}
              </p>
            ))}
            {paperList.length > 1 ? (
              <Link to={PAPERS_SETUP} className="inline-block text-sm font-medium text-brand-ink underline-offset-4 hover:underline">
                Change the default paper
              </Link>
            ) : null}
          </div>

          {/* Signatory */}
          <div className="space-y-2">
            <Field label="Signatory" htmlFor="doc-signatory">
              <Select
                id="doc-signatory"
                value={d.signatory_id ?? ""}
                disabled={readOnly || sigs.isLoading}
                placeholder={d.signatory_id ? undefined : "Workspace default"}
                options={sigList
                  .map((s) => ({ value: s.id, label: `${s.full_name || s.initials} (${s.initials})${s.is_default ? " · default" : ""}` }))
                  .concat(
                    d.signatory_id && !sigs.isLoading && !sigList.some((s) => s.id === d.signatory_id)
                      ? [{ value: d.signatory_id, label: "Removed signatory: choose another" }]
                      : [],
                  )}
                onChange={(e) => e.target.value && draft.setChoice({ signatory_id: e.target.value })}
              />
            </Field>
            {sigs.isError ? <p className="text-sm text-block">The signatories could not be read.</p> : null}
            {sig ? (
              sig.has_signature_image ? (
                <Chip tone="brand" size="sm" icon={<Signature aria-hidden />}>
                  Signature image on file
                </Chip>
              ) : (
                <Chip tone="review" size="sm" icon={<CircleAlert aria-hidden />}>
                  No signature image
                </Chip>
              )
            ) : null}
            <p className="text-sm text-ink-3">
              {sig && !sig.has_signature_image ? "The approved PDF leaves the signature space blank. " : ""}
              Drafts never carry the signature.
            </p>
            {sig && !sig.has_signature_image ? (
              <Link to="/quotations/setup/signatories" className="text-sm font-medium text-brand-ink underline-offset-4 hover:underline">
                Import a signature
              </Link>
            ) : null}
          </div>

          {/* Stamp */}
          <div className="space-y-2">
            <Switch
              checked={stamp.show !== false}
              disabled={readOnly}
              onChange={(v) => draft.setField("stamp", { ...stamp, show: v })}
              label="Company stamp"
              description={stamp.show !== false ? "Printed on the approved PDF" : "Not printed"}
            />
            <p className="text-sm text-ink-3">{stampSummary(stamp)}</p>
            {stampMissing ? <p className="text-sm text-review">No stamp image is installed: PDFs print without a stamp.</p> : null}
            <Button variant="link" size="sm" onClick={onEditStamp}>
              {readOnly ? "View stamp placement" : "Edit stamp placement"}
            </Button>
          </div>
        </div>
      </div>
    </EditorSection>
  );
}

/* ------------------------------------------------------------------ stamp placement */

interface PageRow {
  page: string;
  show: boolean;
  x: string;
  y: string;
  w: string;
}

export function StampDialog({
  open,
  onOpenChange,
  q,
  value,
  readOnly,
  paperMode,
  onApply,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** The quotation, for the real pages of its PDF. */
  q: Quote;
  value: StampSettings;
  readOnly: boolean;
  paperMode?: string;
  onApply: (s: StampSettings) => void;
}) {
  const [show, setShow] = useState(true);
  const [def, setDef] = useState({ x: "", y: "", w: "" });
  const [pages, setPages] = useState<PageRow[]>([]);
  const [newPage, setNewPage] = useState("");
  const current = useRef(value);
  current.current = value;

  // Load the saved settings each time the dialog opens; edits stay local until "Apply".
  useEffect(() => {
    if (!open) return;
    const value = current.current;
    const p = documentPlacement(value);
    setShow(value.show !== false);
    setDef({ x: mm(p?.x_mm), y: mm(p?.y_mm), w: mm(p?.width_mm) });
    setPages(
      Object.entries(value.pages ?? {})
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([page, o]) => ({ page, show: o.show === undefined ? value.show !== false : o.show !== false, x: mm(o.x_mm), y: mm(o.y_mm), w: mm(o.width_mm) })),
    );
    setNewPage("");
  }, [open]);

  const placement = (x: string, y: string, w: string): StampPlacement => {
    const out: StampPlacement = {};
    const px = parseAmount(x);
    const py = parseAmount(y);
    const pw = parseAmount(w);
    if (px !== null) out.x_mm = px;
    if (py !== null) out.y_mm = py;
    if (pw !== null) out.width_mm = pw;
    return out;
  };

  const apply = () => {
    const out: StampSettings = { show };
    const docPlacement = placement(def.x, def.y, def.w);
    if (Object.keys(docPlacement).length) out.default = docPlacement;
    const byPage: Record<string, StampPlacement> = {};
    for (const r of pages) byPage[r.page] = { show: r.show, ...placement(r.x, r.y, r.w) };
    if (Object.keys(byPage).length) out.pages = byPage;
    onApply(out);
  };

  const addPage = () => {
    const n = Math.trunc(Number(newPage));
    if (!n || n < 1 || n > 999 || pages.some((p) => p.page === String(n))) return;
    setPages([...pages, { page: String(n), show: !show, x: "", y: "", w: "" }].sort((a, b) => Number(a.page) - Number(b.page)));
    setNewPage("");
  };

  const px = parseAmount(def.x);
  const py = parseAmount(def.y);
  const pw = parseAmount(def.w);
  const preview = px !== null && py !== null ? { x: px, y: py, width: pw ?? 36, show } : null;
  const widthOff = pw !== null && (pw < 18 || pw > 58);
  const final = q.status === "approved" || q.status === "sent";

  /** The stamp as the form has it now, on the page being shown (an approved PDF already carries the real one). */
  const markFor = (page: number): StampMark | null => {
    if (final) return null;
    const row = pages.find((r) => r.page === String(page));
    if (!(row ? row.show : show)) return null;
    const x = parseAmount(row?.x) ?? px;
    const y = parseAmount(row?.y) ?? py;
    const w = parseAmount(row?.w) ?? pw;
    return x !== null && y !== null ? { x, y, width: w ?? 36 } : null;
  };

  const numberField = (label: string, v: string, set: (v: string) => void, id: string) => (
    <Field label={label} htmlFor={id}>
      <Input id={id} inputMode="decimal" value={v} disabled={readOnly} placeholder="Paper default" onChange={(e) => set(e.target.value)} />
    </Field>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Stamp placement"
      description="Where the company stamp prints on the approved PDF. Drafts never carry the stamp."
      size="lg"
      footer={
        readOnly ? (
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={apply}>Apply to this quotation</Button>
          </>
        )
      }
    >
      <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-4 sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-6">
        {/* The real pages stay in view while the fields below are edited. */}
        <div className="sticky top-0 self-start">
          <PageStage
            q={q}
            enabled={open}
            markFor={markFor}
            fallback={
              <div className="mx-auto w-28">
                <PaperSchematic mode={paperMode} stamp={preview} label="Page layout with the stamp position" />
              </div>
            }
          />
          <p className="mt-2 text-xs text-ink-3">
            {final ? "The approved PDF carries the stamp." : preview ? "The dashed circle is the stamp position." : "The paper's default position applies."}
          </p>
        </div>
        <div className="min-w-0 space-y-5">
          <Switch checked={show} disabled={readOnly} onChange={setShow} label="Stamp every page" description="Pages listed below can differ." />
          <div>
            <p className="text-sm font-medium text-ink">Position on every page (millimetres)</p>
            <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
              {numberField("From left", def.x, (x) => setDef({ ...def, x }), "stamp-x")}
              {numberField("From top", def.y, (y) => setDef({ ...def, y }), "stamp-y")}
              {numberField("Width", def.w, (w) => setDef({ ...def, w }), "stamp-w")}
            </div>
            <p className={widthOff ? "mt-2 text-sm text-review" : "mt-2 text-sm text-ink-3"}>
              Width 18 to 58 mm. Every position is fitted inside the printable area above the footer. Empty fields keep the paper's
              default.
            </p>
          </div>

          <div>
            <p className="text-sm font-medium text-ink">Pages that differ</p>
            {pages.length === 0 ? <p className="mt-1 text-sm text-ink-3">None. Every page follows the settings above.</p> : null}
            <ul className="mt-2 divide-y divide-line">
              {pages.map((r, i) => {
                const set = (patch: Partial<PageRow>) => setPages(pages.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                return (
                  <li key={r.page} className="space-y-2 py-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="w-16 text-sm font-medium text-ink">Page {r.page}</span>
                      {readOnly ? (
                        <span className="text-sm text-ink-2">{r.show ? "Stamped" : "No stamp"}</span>
                      ) : (
                        <Segmented
                          label={`Stamp on page ${r.page}`}
                          value={r.show ? "show" : "hide"}
                          onChange={(v) => set({ show: v === "show" })}
                          options={[
                            { value: "show", label: "Stamp" },
                            { value: "hide", label: "No stamp" },
                          ]}
                        />
                      )}
                      {!readOnly ? (
                        <IconButton label={`Remove page ${r.page}`} size="sm" className="ml-auto" onClick={() => setPages(pages.filter((_, j) => j !== i))}>
                          <Trash2 />
                        </IconButton>
                      ) : null}
                    </div>
                    {r.show ? (
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        {numberField("From left", r.x, (x) => set({ x }), `stamp-${r.page}-x`)}
                        {numberField("From top", r.y, (y) => set({ y }), `stamp-${r.page}-y`)}
                        {numberField("Width", r.w, (w) => set({ w }), `stamp-${r.page}-w`)}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {!readOnly ? (
              <div className="mt-2 flex items-end gap-2">
                <Field label="Page number" htmlFor="stamp-new-page" className="w-32">
                  <Input
                    id="stamp-new-page"
                    type="number"
                    min={1}
                    value={newPage}
                    onChange={(e) => setNewPage(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addPage();
                      }
                    }}
                  />
                </Field>
                <Button variant="secondary" onClick={addPage} disabled={!newPage}>
                  Add page
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
