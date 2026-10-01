/**
 * Quotation editor (mockup 26): header and facts, approval card with the unmet conditions, template /
 * paper / signature choices, line items, customer-requested term changes, terms, exclusions,
 * clarifications, notes and reference photos. Edits stay local until "Save changes".
 */
import { BookmarkPlus, EllipsisVertical, Eye, FolderOpen, GitBranch, Save } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { useCategoryLabel, useWorkspace } from "@/api/session";
import { formatDate, isRtl } from "@/lib/format";
import { workTypeLabel } from "@/lib/labels";
import { projectHref, quotationPreviewHref } from "@/lib/routes";
import {
  Button,
  ConfirmDialog,
  DateInput,
  Field,
  IconButton,
  Input,
  Menu,
  Page,
  PageHeader,
  Panel,
  PanelBody,
  PanelHeader,
  Select,
  Textarea,
  toast,
  type MenuItem,
} from "@/ui";
import { isApiError } from "@/api/client";
import { useCatalog, useTemplates, type CatalogItem, type PriceHint, type Term } from "../api";
import { ExplainedError, Fact, ImpactChip, QuoteStatusChip, TermStatusChip } from "../components";
import {
  clarificationText,
  createdByLabel,
  fillPlaceholders,
  isFrozen,
  languageLabel,
  moneyDigits,
  PRICE_TERMS,
  templateName,
  termChanges,
  termStatus,
} from "../lib";
import { RuleDialog } from "../RuleDialog";
import { ApprovalPanel, HistoryPanel, ReviseDialog } from "./ApprovalPanel";
import { DocumentPanel } from "./DocumentPanel";
import { EditorSection, openEditorSection, useEditorHashNavigation } from "./EditorSection";
import { AutoTextarea, ListEditor } from "./inputs";
import { CatalogDialog, ReuseDialog } from "./LineTools";
import { emptyLine, LineItems, lineLayout } from "./LineItems";
import { PhotosPanel } from "./Photos";
import type { AreaProps } from "./QuotationArea";
import { TermChangesPanel } from "./TermChanges";
import type { DraftLine } from "./useDraft";

const KEY_NAMES: Record<string, string> = {
  to: "addressee",
  project_name: "project name",
  subject: "subject",
  tender_no: "tender number",
  enquiry_ref: "enquiry reference",
  intro: "introduction",
  items: "line items",
  currency: "currency",
  price_unit: "price unit",
  terms: "terms",
  exclusions: "exclusions",
  notes: "notes",
  show_total: "total",
  stamp: "stamp",
  clarifications: "clarifications",
  date: "date",
  paper_id: "paper",
};

export function EditorPage({ detail, draft, save, saving, saveError, leave }: AreaProps) {
  const q = detail.quotation;
  const d = draft.draft;
  const ws = useWorkspace();
  const navigate = useNavigate();
  const familyLabel = useCategoryLabel();
  const templates = useTemplates();
  const template = templates.data?.find((t) => t.key === d.template_key);
  const frozen = isFrozen(q.status);
  const readOnly = frozen;
  const currency = d.data.currency || ws.currency || "KWD";
  const rtl = d.language === "ar";
  const changes = termChanges(q.data);
  useEditorHashNavigation();
  const waitingTerms = changes.filter((change) => termStatus(change) === "pending").length;

  const [reviseOpen, setReviseOpen] = useState(false);
  const [carry, setCarry] = useState(false);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [reuseOpen, setReuseOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);

  // Dated last-known prices for catalogue lines: guidance shown beside the price, never copied in.
  const catalog = useCatalog("", { language: d.language, limit: 100 });
  const [addedHints, setAddedHints] = useState<Map<string, PriceHint>>(() => new Map());
  const priceHints = useMemo(() => {
    const m = new Map(addedHints);
    for (const it of catalog.data?.items ?? []) if (it.price_hint) m.set(it.product_id, it.price_hint);
    return m;
  }, [catalog.data, addedHints]);

  const base = lineLayout(template, d.language);
  const layout = { ...base, defaultPriceUnit: d.data.price_unit || base.defaultPriceUnit };
  const copy = template?.copy[d.language] ?? template?.copy.en;

  const setLines = (items: DraftLine[]) => draft.setField("items", items);
  const appendLines = (lines: Partial<DraftLine>[]) =>
    draft.update((data) => ({ ...data, items: [...data.items, ...lines.map((l) => emptyLine(l))] }));
  const addCatalogItem = (it: CatalogItem) => {
    appendLines([
      {
        description: it.description,
        spec: it.spec,
        unit: it.unit,
        price_unit: layout.hasPriceUnit ? it.price_unit : undefined,
        catalog_id: it.product_id,
      },
    ]);
    const hint = it.price_hint;
    if (hint) setAddedHints((m) => new Map(m).set(it.product_id, hint));
    toast.success("Line added", { description: `${it.description}. The price stays empty for you to enter.` });
  };

  const openRevise = (withChanges: boolean) => {
    setCarry(withChanges);
    setReviseOpen(true);
  };

  const frozenSave = isApiError(saveError, "frozen");
  const menu: MenuItem[] = [
    { label: "Save this choice as a template rule", icon: <BookmarkPlus />, onSelect: () => setRuleOpen(true) },
    ...(q.project_id ? [{ label: "Open the project", icon: <FolderOpen />, onSelect: () => navigate(projectHref(q.project_id)) }] : []),
    ...(q.status === "approved" || q.status === "sent"
      ? [{ label: "Create revision", icon: <GitBranch />, onSelect: () => openRevise(false), separatorBefore: true }]
      : []),
  ];

  const contractor = detail.customer?.name ?? q.data.to?.company ?? null;
  const contact = detail.enquiry?.contact;

  return (
    <Page>
      <PageHeader
        back={{ to: "/quotations", label: "Quotations" }}
        title={
          <span className="tabular">
            {q.reference || "Draft"} <span className="font-semibold text-ink-3">v{q.version}</span>
          </span>
        }
        status={
          <>
            <QuoteStatusChip q={q} />
            <ImpactChip q={q} size="md" />
          </>
        }
        meta={createdByLabel(q.created_by)}
        actions={
          <>
            <Button variant="secondary" asChild>
              <Link to={quotationPreviewHref(q.id)}>
                <Eye className="size-[1.125rem]" aria-hidden />
                Preview PDF
              </Link>
            </Button>
            {!readOnly ? (
              <Button variant="secondary" icon={<Save />} onClick={save} loading={saving} disabled={!draft.dirty}>
                {draft.dirty ? "Save changes" : "Saved"}
              </Button>
            ) : null}
            <Menu
              items={menu}
              trigger={
                <IconButton label="More actions" variant="secondary" tooltip={false}>
                  <EllipsisVertical />
                </IconButton>
              }
            />
          </>
        }
      />

      <div className="mb-5">
      <EditorSection id="quotation-details" title="Quotation details" summary={[contractor, detail.project?.name].filter(Boolean).join(" · ")} defaultOpen={window.matchMedia("(min-width: 640px)").matches}>
      <div className="grid gap-x-8 gap-y-3 border-y border-line py-3 sm:grid-cols-2 lg:grid-cols-5">
        <Fact label="Contractor" hint={contact?.name ? [contact.name, contact.email].filter(Boolean).join(" · ") : undefined}>
          {contractor ? <span dir={isRtl(contractor) ? "rtl" : "auto"}>{contractor}</span> : <span className="text-ink-3">Not recorded</span>}
        </Fact>
        <Fact
          label="Project"
          hint={detail.project ? `${familyLabel(detail.project.service_family)} · ${workTypeLabel(detail.project.work_type)}` : undefined}
        >
          {detail.project ? (
            <Link to={projectHref(detail.project.id)} className="font-medium text-brand-ink underline-offset-4 hover:underline">
              {detail.project.name}
            </Link>
          ) : (
            "—"
          )}
        </Fact>
        <Fact
          label="Enquiry"
          hint={detail.enquiry?.due_date ? `Closes ${formatDate(detail.enquiry.due_date)}` : undefined}
        >
          {detail.enquiry ? (
            <Link
              to={projectHref(detail.enquiry.project_id, "enquiries")}
              className="font-medium text-brand-ink underline-offset-4 hover:underline"
            >
              {detail.enquiry.ref || "Open enquiry"}
            </Link>
          ) : (
            <span className="text-ink-3">No enquiry linked</span>
          )}
        </Fact>
        <Fact label="Template" hint={q.template_reason || undefined}>
          {templateName(templates.data, q.template_key)} · {languageLabel(q.language)}
        </Fact>
        <Fact label="Quotation date">{formatDate(q.data.date ?? q.created_at)}</Fact>
      </div>
      </EditorSection>
      </div>

      <nav aria-label="Quotation sections" className="mb-5 max-w-md">
        <Field label="Jump to section" htmlFor="quote-section">
          <Select id="quote-section" value="" placeholder="Choose a section" options={[
            { value: "approval", label: "Approval and sending" },
            { value: "line-items", label: "Line items, catalogue and reuse" },
            ...(changes.length ? [{ value: "term-changes", label: `Customer-requested terms${waitingTerms ? ` · ${waitingTerms} open` : ""}` }] : []),
            { value: "document", label: "Template, paper, signature and stamp" },
            { value: "letter-details", label: "Addressee, subject and date" },
            { value: "terms", label: "Agreed terms" },
            { value: "exclusions", label: "Exclusions" },
            { value: "clarifications", label: "Clarifications" },
            { value: "notes", label: "Notes" },
            { value: "photos", label: "Reference photos and page previews" },
            { value: "history", label: "Approval history" },
          ]} onChange={(e) => openEditorSection(e.target.value)} />
        </Field>
      </nav>

      <div className="space-y-4">
        <div id="approval" className="scroll-mt-24"><ApprovalPanel detail={detail} dirty={draft.dirty} onRevise={() => openRevise(false)} /></div>

        <EditorSection id="document" title="Template, paper and signature" summary={`${templateName(templates.data, d.template_key)} · ${languageLabel(d.language)}`}>
        <DocumentPanel
          q={q}
          draft={draft}
          readOnly={readOnly}
          templates={templates.data}
          currency={currency}
          onSaveRule={() => setRuleOpen(true)}
        />
        </EditorSection>

        <LetterDetails draft={draft} readOnly={readOnly} rtl={rtl} defaultIntro={copy?.intro ?? []} variables={q.data.variables} />

        <EditorSection id="line-items" title="Line items" summary={`${d.data.items.length} lines`} defaultOpen={!readOnly}>
          <LineItems
            lines={d.data.items}
            onChange={setLines}
            currency={currency}
            digits={moneyDigits(currency)}
            layout={layout}
            scope={detail.project?.scope_items}
            readOnly={readOnly}
            priceHints={priceHints}
            onCatalogue={() => setCatalogOpen(true)}
            onReuse={() => setReuseOpen(true)}
            showTotal={d.data.show_total ?? template?.show_total ?? true}
            canToggleTotal={Boolean(copy?.total_label)}
            onShowTotal={(v) => draft.setField("show_total", v)}
            rtl={rtl}
          />
        </EditorSection>

        {changes.length ? <EditorSection id="term-changes-section" title="Customer-requested term changes" summary={waitingTerms ? `${waitingTerms} awaiting a decision` : "Decisions recorded"} defaultOpen={waitingTerms > 0}>
        <TermChangesPanel detail={detail} dirty={draft.dirty} onRevise={() => openRevise(false)} />
        </EditorSection> : null}

        <EditorSection id="terms" title="Terms" summary={`${d.data.terms?.length ?? 0} agreed terms`}>
        <TermsPanel
          terms={d.data.terms ?? []}
          onChange={(terms) => draft.setField("terms", terms)}
          readOnly={readOnly}
          rtl={rtl}
          statusFor={(key) => {
            const c = changes.find((x) => x.key === key);
            return c ? <TermStatusChip change={c} size="sm" /> : null;
          }}
        />
        </EditorSection>

        <div className="grid gap-4 lg:grid-cols-2">
          <EditorSection id="exclusions" title="Exclusions" summary={`${d.data.exclusions?.length ?? 0} exclusions`}>
          <Panel>
            <PanelHeader title="Exclusions" description="Printed with the terms." />
            <PanelBody>
              <ListEditor
                items={d.data.exclusions ?? []}
                onChange={(v) => draft.setField("exclusions", v)}
                addLabel="Add an exclusion"
                placeholder="e.g. Civil works and power supply"
                disabled={readOnly}
                rtl={rtl}
                itemLabel={(i) => `Exclusion ${i + 1}`}
                empty="No exclusions."
              />
            </PanelBody>
          </Panel>
          </EditorSection>
          <EditorSection id="clarifications" title="Clarifications" summary={`${d.data.clarifications?.length ?? 0} open questions`}>
          <Panel>
            <PanelHeader title="Clarifications" description="Questions for the customer. Not printed on the quotation." />
            <PanelBody>
              <ListEditor
                items={(d.data.clarifications ?? []).map(clarificationText)}
                onChange={(v) => draft.setField("clarifications", v)}
                addLabel="Add a clarification"
                placeholder="e.g. Confirm the roof load capacity"
                disabled={readOnly}
                rtl={rtl}
                itemLabel={(i) => `Clarification ${i + 1}`}
                empty="No open questions."
              />
            </PanelBody>
          </Panel>
          </EditorSection>
        </div>

        <EditorSection id="notes" title="Notes" summary={d.data.notes ? "Notes recorded" : "No notes"}>
        <Panel>
          <PanelHeader title="Notes" description="Printed after the terms." />
          <PanelBody>
            {readOnly ? (
              <p dir={rtl || isRtl(d.data.notes) ? "rtl" : "auto"} className="whitespace-pre-line text-ink">
                {d.data.notes || <span className="text-ink-3">No notes.</span>}
              </p>
            ) : (
              <Textarea
                aria-label="Notes"
                value={d.data.notes ?? ""}
                dir={rtl ? "rtl" : isRtl(d.data.notes) ? "rtl" : "auto"}
                placeholder="Anything the customer should read after the terms"
                onChange={(e) => draft.setField("notes", e.target.value || null)}
              />
            )}
          </PanelBody>
        </Panel>
        </EditorSection>

        <EditorSection id="photos" title="Reference photos" summary={`${q.data.photos?.length ?? 0} photos`}>
        <PhotosPanel q={q} />
        </EditorSection>

        <HistoryPanel detail={detail} />
      </div>

      {draft.dirty ? (
        <SaveBar
          summary={
            [
              ...draft.changedKeys.map((k) => KEY_NAMES[k] ?? k),
              ...(draft.choiceChanged ? ["template, language or signatory"] : []),
            ].join(", ") || "changes"
          }
          frozen={frozen || frozenSave}
          saving={saving}
          onSave={save}
          onDiscard={() => setDiscardOpen(true)}
          error={
            saveError ? (
              <ExplainedError
                error={saveError}
                q={q}
                action={
                  frozenSave ? (
                    <Button size="sm" variant="secondary" icon={<GitBranch />} onClick={() => openRevise(true)}>
                      Create revision with these changes
                    </Button>
                  ) : null
                }
              />
            ) : null
          }
        />
      ) : null}

      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="Discard your changes?"
        description="The quotation goes back to the last saved version."
        confirmLabel="Discard changes"
        variant="danger"
        onConfirm={() => {
          draft.discard();
          setDiscardOpen(false);
        }}
      >
        <p className="text-sm text-ink-2">Unsaved edits to the lines, prices, terms and choices are lost.</p>
      </ConfirmDialog>

      <ReviseDialog
        open={reviseOpen}
        onOpenChange={setReviseOpen}
        q={q}
        carry={carry ? draft.body() : null}
        leave={leave}
      />
      <RuleDialog
        open={ruleOpen}
        onOpenChange={setRuleOpen}
        prefill={{
          name: detail.project ? `${familyLabel(detail.project.service_family)} · ${workTypeLabel(detail.project.work_type)}` : "",
          match: {
            service_family: detail.project?.service_family,
            work_type: detail.project?.work_type,
          },
          customer: q.customer_id ? { id: q.customer_id, name: detail.customer?.name ?? "this customer" } : null,
          template_key: d.template_key,
          language: d.language,
          paper_id: d.data.paper_id ?? null,
          signatory_id: d.signatory_id,
        }}
      />
      <CatalogDialog open={catalogOpen} onOpenChange={setCatalogOpen} language={d.language} onAdd={addCatalogItem} />
      <ReuseDialog
        open={reuseOpen}
        onOpenChange={setReuseOpen}
        current={q}
        onAdd={(lines) => {
          appendLines(lines);
          toast.success(`${lines.length} ${lines.length === 1 ? "line" : "lines"} added`, { description: "Quantities and prices stay empty for you to enter." });
        }}
      />
    </Page>
  );
}

/* ------------------------------------------------------------------ save bar */

function SaveBar({
  summary,
  frozen,
  saving,
  onSave,
  onDiscard,
  error,
}: {
  summary: string;
  frozen: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  error: ReactNode;
}) {
  return (
    <div className="sticky bottom-20 z-20 mt-6 lg:bottom-4">
      <div className="space-y-3 rounded-xl border border-line-strong bg-surface px-4 py-3 shadow-pop">
        {error}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <p className="min-w-0 flex-1 text-sm text-ink-2">
            <span className="font-medium text-ink">{frozen ? "Not saved: this revision is frozen." : "Unsaved changes"}</span>{" "}
            <span className="text-ink-3">({summary})</span>
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onDiscard} disabled={saving} className="max-sm:flex-1">
              Discard
            </Button>
            {!frozen ? (
              <Button icon={<Save />} onClick={onSave} loading={saving} className="max-sm:flex-1">
                Save changes
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ letter details */

function LetterDetails({
  draft,
  readOnly,
  rtl,
  defaultIntro,
  variables,
}: {
  draft: AreaProps["draft"];
  readOnly: boolean;
  rtl: boolean;
  defaultIntro: string[];
  variables?: Record<string, string>;
}) {
  const data = draft.draft.data;
  const to = data.to ?? {};
  const setTo = (k: keyof NonNullable<typeof data.to>, v: string) => draft.setField("to", { ...to, [k]: v || null });
  const dir = rtl ? "rtl" : undefined;
  const intro = Array.isArray(data.intro) ? data.intro.join("\n\n") : (data.intro ?? "");
  const introDefault = defaultIntro.map((p) => fillPlaceholders(p, variables ?? {})).join("\n\n");
  const text = (label: string, value: string | null | undefined, onChange: (v: string) => void, opts: { id: string; type?: string; hint?: string; ltr?: boolean }) => (
    <Field label={label} htmlFor={opts.id} hint={opts.hint}>
      <Input
        id={opts.id}
        type={opts.type}
        value={value ?? ""}
        disabled={readOnly}
        dir={opts.ltr ? "ltr" : dir}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
  return (
    <EditorSection
      id="letter-details"
      title="Addressee, subject and date"
      summary={[to.company ? `To ${to.company}` : "No addressee", data.subject].filter(Boolean).join(" · ")}
    >
      <div className="grid gap-x-6 gap-y-4 rounded-xl border border-line bg-surface p-5 md:grid-cols-2">
        {text("Company", to.company, (v) => setTo("company", v), { id: "to-company" })}
        {text("Attention", to.attention, (v) => setTo("attention", v), { id: "to-attention" })}
        {text("E-mail", to.email, (v) => setTo("email", v), { id: "to-email", type: "email", ltr: true })}
        {text("Phone", to.phone, (v) => setTo("phone", v), { id: "to-phone", ltr: true })}
        <Field label="Address" htmlFor="to-address" className="md:col-span-2">
          <Textarea
            id="to-address"
            rows={2}
            value={to.address ?? ""}
            disabled={readOnly}
            dir={dir}
            onChange={(e) => setTo("address", e.target.value)}
          />
        </Field>
        {text("Project name", data.project_name, (v) => draft.setField("project_name", v || null), { id: "q-project" })}
        {text("Subject", data.subject, (v) => draft.setField("subject", v || null), { id: "q-subject" })}
        {text("Tender no.", data.tender_no, (v) => draft.setField("tender_no", v || null), { id: "q-tender", ltr: true })}
        {text("Your reference", data.enquiry_ref, (v) => draft.setField("enquiry_ref", v || null), {
          id: "q-ref",
          ltr: true,
          hint: "The customer's enquiry or RFQ number.",
        })}
        <Field label="Quotation date" htmlFor="q-date">
          <DateInput id="q-date" value={data.date ?? ""} disabled={readOnly} onChange={(v) => draft.setField("date", v || null)} />
        </Field>
        {text("Currency", data.currency, (v) => draft.setField("currency", v.toUpperCase().slice(0, 3)), {
          id: "q-currency",
          ltr: true,
          hint: "Three-letter code, e.g. KWD.",
        })}
        <Field
          label="Introduction"
          htmlFor="q-intro"
          className="md:col-span-2"
          hint="Leave empty to print the template's own introduction. Separate paragraphs with an empty line."
        >
          <Textarea
            id="q-intro"
            rows={4}
            value={intro}
            disabled={readOnly}
            dir={dir ?? (isRtl(intro || introDefault) ? "rtl" : "auto")}
            placeholder={introDefault}
            onChange={(e) => draft.setField("intro", e.target.value.trim() ? e.target.value : null)}
          />
        </Field>
      </div>
    </EditorSection>
  );
}

/* ------------------------------------------------------------------ terms */

function TermsPanel({
  terms,
  onChange,
  readOnly,
  rtl,
  statusFor,
}: {
  terms: Term[];
  onChange: (terms: Term[]) => void;
  readOnly: boolean;
  rtl: boolean;
  statusFor: (key: string) => ReactNode;
}) {
  return (
    <Panel>
      <PanelHeader
        title="Terms"
        description="The agreed wording printed under the items. Customer requests are decided in the section above."
      />
      <PanelBody>
        {terms.length === 0 ? (
          <p className="text-sm text-ink-3">
            This quotation has no terms. Use the template's defaults under "Template, paper and signature" to add them.
          </p>
        ) : (
          <div className="grid gap-x-6 gap-y-5 md:grid-cols-2">
            {terms.map((t, i) => {
              const priceTerm = PRICE_TERMS.has(t.key);
              const empty = !(t.text ?? "").trim();
              const id = `term-${t.key}`;
              return (
                <Field
                  key={t.key}
                  htmlFor={id}
                  label={
                    <span className="inline-flex flex-wrap items-center gap-2">
                      {t.label}
                      {statusFor(t.key)}
                    </span>
                  }
                  hint={priceTerm ? "Entered by a person for this quotation. AI never writes prices." : undefined}
                >
                  {readOnly ? (
                    <p id={id} dir={rtl || isRtl(t.text) ? "rtl" : "auto"} className="whitespace-pre-line text-base text-ink">
                      {t.text || <span className="text-ink-3">Not filled</span>}
                    </p>
                  ) : (
                    <AutoTextarea
                      id={id}
                      value={t.text ?? ""}
                      dir={rtl ? "rtl" : undefined}
                      placeholder={priceTerm ? "Enter the value" : "Not filled"}
                      className={priceTerm && empty ? "border-review-line bg-review-soft/40" : undefined}
                      onChange={(e) => onChange(terms.map((x, j) => (j === i ? { ...x, text: e.target.value || null } : x)))}
                    />
                  )}
                </Field>
              );
            })}
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}
