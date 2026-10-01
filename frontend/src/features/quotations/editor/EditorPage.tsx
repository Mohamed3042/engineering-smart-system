/**
 * Quotation editor (mockup 26): header and facts, approval card with the unmet conditions, template /
 * paper / signature choices, line items, customer-requested term changes, terms, exclusions,
 * clarifications, notes and reference photos. Edits stay local until "Save changes".
 *
 * Desktop shows the panels in one fixed order. Phones put the work first (approval card, line items,
 * requests, terms) and fold what is secondary or done into cards with one line of summary; a sticky bar
 * shows the reference, the status and the one next step, and a chip row jumps to every section.
 */
import { ArrowLeft, BookmarkPlus, CircleDashed, EllipsisVertical, Eye, FolderOpen, GitBranch, Save } from "lucide-react";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { useCategoryLabel, useWorkspace } from "@/api/session";
import { formatDate, isRtl } from "@/lib/format";
import { workTypeLabel } from "@/lib/labels";
import { projectHref, quotationPreviewHref } from "@/lib/routes";
import {
  Banner,
  Button,
  Chip,
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
  Textarea,
  toast,
  type MenuItem,
} from "@/ui";
import { isApiError } from "@/api/client";
import { useCatalog, useTemplates, type CatalogItem, type PriceHint, type Term } from "../api";
import { dotted, ExplainedError, Fact, ImpactChip, QuoteStatusChip, TermStatusChip } from "../components";
import {
  clarificationText,
  createdByLabel,
  fillPlaceholders,
  isFrozen,
  isTemplateFallback,
  languageLabel,
  lineItemsSummary,
  moneyDigits,
  parseAmount,
  PRICE_TERMS,
  templateName,
  TEMPLATES_SETUP,
  termChanges,
  termStatus,
  totals,
} from "../lib";
import { RuleDialog } from "../RuleDialog";
import { ApprovalPanel, HistoryPanel, ReviseDialog, useApprovalFlow } from "./ApprovalPanel";
import { DocumentPanel, StampDialog, useDocumentChoices } from "./DocumentPanel";
import { AutoTextarea, ListEditor } from "./inputs";
import { CatalogDialog, ReuseDialog } from "./LineTools";
import { emptyLine, LineItems, lineLayout } from "./LineItems";
import { PhoneBar, SectionChips, type NavSection } from "./PhoneBar";
import { PhotosPanel, photosSummary } from "./Photos";
import type { AreaProps } from "./QuotationArea";
import { EditorSection, jumpTo, useNarrow } from "./sections";
import { TermChangesPanel, termChangesSummary } from "./TermChanges";
import type { DraftLine } from "./useDraft";

/** Links like /quotations/:id#line-items open the section (it may be folded) and scroll to it (after the shell's scroll-to-top). */
function useScrollToHash() {
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash) return;
    jumpTo(decodeURIComponent(hash.slice(1)), { delay: 80 });
  }, [hash]);
}

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

/** Desktop keeps the panels in this order; phones put the work first. */
const DESKTOP_ORDER = ["approval", "document", "letter", "line-items", "term-changes", "terms", "scope", "photos", "history"];
const PHONE_ORDER = ["approval", "line-items", "term-changes", "terms", "scope", "letter", "document", "photos", "history"];

function termsSummary(terms: Term[]): { text: ReactNode; empty: Term[] } {
  const empty = terms.filter((t) => PRICE_TERMS.has(t.key) && !(t.text ?? "").trim());
  const text = terms.length ? (
    <>
      {terms.length} {terms.length === 1 ? "term" : "terms"}
      {empty.length ? (
        <>
          {" · "}
          {empty.map((t, i) => (
            <Fragment key={t.key}>
              {i ? ", " : null}
              <bdi>{t.label}</bdi>
            </Fragment>
          ))}{" "}
          to fill
        </>
      ) : null}
    </>
  ) : (
    "No terms"
  );
  return { text, empty };
}

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
  const narrow = useNarrow();
  useScrollToHash();

  const [reviseOpen, setReviseOpen] = useState(false);
  const [carry, setCarry] = useState(false);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [reuseOpen, setReuseOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [stampOpen, setStampOpen] = useState(false);

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

  const flow = useApprovalFlow({ detail, dirty: draft.dirty, lines: d.data.items, save, saving });
  const choices = useDocumentChoices(d, templates.data);

  const frozenSave = isApiError(saveError, "frozen");
  const menu: MenuItem[] = [
    { label: "Save this choice as a template rule", icon: <BookmarkPlus />, onSelect: () => setRuleOpen(true) },
    ...(q.project_id ? [{ label: "Open the project", icon: <FolderOpen />, onSelect: () => navigate(projectHref(q.project_id)) }] : []),
    ...(q.status === "approved" || q.status === "sent"
      ? [{ label: "Create revision", icon: <GitBranch />, onSelect: () => openRevise(false), separatorBefore: true }]
      : []),
  ];
  const phoneMenu: MenuItem[] = [
    { label: "Preview PDF", icon: <Eye />, onSelect: () => navigate(quotationPreviewHref(q.id)) },
    ...menu,
    { label: "All quotations", icon: <ArrowLeft />, onSelect: () => navigate("/quotations"), separatorBefore: true },
  ];

  const contractor = detail.customer?.name ?? q.data.to?.company ?? null;
  const contact = detail.enquiry?.contact;
  const stamp = d.data.stamp ?? {};

  /* ---------------------------------------------------------------- section list (phones) */

  const live = totals(d.data.items);
  const linesToDo = d.data.items.filter(
    (l) => !l.included && (parseAmount(l.unit_price) === null || parseAmount(l.qty) === null),
  ).length;
  const waiting = changes.filter((c) => termStatus(c) === "pending").length;
  const termsInfo = termsSummary(d.data.terms ?? []);
  const exclusions = d.data.exclusions ?? [];
  const clarifications = d.data.clarifications ?? [];
  const scopeSummary = [
    exclusions.length ? `${exclusions.length} ${exclusions.length === 1 ? "exclusion" : "exclusions"}` : "No exclusions",
    clarifications.length ? `${clarifications.length} ${clarifications.length === 1 ? "question" : "questions"} for the customer` : "no questions",
    d.data.notes?.trim() ? "notes written" : "no notes",
  ].join(" · ");
  const to = d.data.to ?? {};
  const letterSummary = dotted([
    to.company ? (
      <>
        To <bdi>{to.company}</bdi>
      </>
    ) : (
      "No addressee"
    ),
    d.data.subject ? <bdi>{d.data.subject}</bdi> : null,
  ]);
  const records = detail.approvals.length;
  const open = flow.blockers.length;

  const sections: NavSection[] = [
    {
      id: "approval",
      chip: "Approval",
      title: "Approval and sending",
      summary: flow.state.text,
      attention: !frozen && open > 0,
      badge: open,
    },
    {
      id: "line-items",
      chip: "Items",
      title: "Line items",
      summary: lineItemsSummary(d.data.items, currency),
      attention: !readOnly && (d.data.items.length === 0 || live.missingPrice > 0 || live.missingQty > 0),
      badge: Math.max(1, linesToDo),
    },
    ...(changes.length
      ? [
          {
            id: "term-changes",
            chip: "Requests",
            title: "Customer-requested terms",
            summary: termChangesSummary(changes),
            attention: waiting > 0,
            badge: waiting,
          },
        ]
      : []),
    {
      id: "terms",
      chip: "Terms",
      title: "Terms",
      summary: termsInfo.text,
      attention: !readOnly && termsInfo.empty.length > 0,
      badge: termsInfo.empty.length,
    },
    { id: "scope", chip: "Scope", title: "Exclusions, questions and notes", summary: scopeSummary },
    { id: "letter", chip: "Letter", title: "Addressee, subject and date", summary: letterSummary },
    {
      id: "document",
      chip: "Template",
      title: "Template, paper and signature",
      summary: choices.summary,
      attention: choices.templateOff,
      badge: 1,
    },
    { id: "photos", chip: "Photos & stamp", title: "Reference photos and stamp", summary: photosSummary(q, stamp) },
    {
      id: "history",
      chip: "History",
      title: "Approval history",
      summary: records ? `${records} ${records === 1 ? "record" : "records"}` : "No decisions yet",
    },
  ];

  /* ---------------------------------------------------------------- blocks */

  const exclusionsEditor = (
    <ListEditor
      items={exclusions}
      onChange={(v) => draft.setField("exclusions", v)}
      addLabel="Add an exclusion"
      placeholder="e.g. Civil works and power supply"
      disabled={readOnly}
      rtl={rtl}
      itemLabel={(i) => `Exclusion ${i + 1}`}
      empty="No exclusions."
    />
  );
  const clarificationsEditor = (
    <ListEditor
      items={clarifications.map(clarificationText)}
      onChange={(v) => draft.setField("clarifications", v)}
      addLabel="Add a clarification"
      placeholder="e.g. Confirm the roof load capacity"
      disabled={readOnly}
      rtl={rtl}
      itemLabel={(i) => `Clarification ${i + 1}`}
      empty="No open questions."
    />
  );
  const notesEditor = readOnly ? (
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
  );

  const blocks: Record<string, ReactNode> = {
    approval: (
      <div id="approval" tabIndex={-1} className="scroll-mt-36 outline-none lg:scroll-mt-6">
        <ApprovalPanel flow={flow} detail={detail} dirty={draft.dirty} onRevise={() => openRevise(false)} />
      </div>
    ),
    document: (
      <DocumentPanel
        q={q}
        draft={draft}
        readOnly={readOnly}
        templates={templates.data}
        templatesError={templates.isError}
        currency={currency}
        choices={choices}
        onSaveRule={() => setRuleOpen(true)}
        onEditStamp={() => setStampOpen(true)}
      />
    ),
    letter: <LetterDetails draft={draft} readOnly={readOnly} rtl={rtl} defaultIntro={copy?.intro ?? []} variables={q.data.variables} summary={letterSummary} />,
    "line-items": (
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
    ),
    "term-changes": <TermChangesPanel detail={detail} dirty={draft.dirty} onRevise={() => openRevise(false)} />,
    terms: (
      <TermsPanel
        terms={d.data.terms ?? []}
        summary={termsInfo.text}
        flag={
          !readOnly && termsInfo.empty.length ? (
            <Chip tone="review" size="sm" icon={<CircleDashed aria-hidden />}>
              {termsInfo.empty.length} to fill
            </Chip>
          ) : null
        }
        onChange={(terms) => draft.setField("terms", terms)}
        readOnly={readOnly}
        rtl={rtl}
        statusFor={(key) => {
          const c = changes.find((x) => x.key === key);
          return c ? <TermStatusChip change={c} size="sm" /> : null;
        }}
      />
    ),
    scope: narrow ? (
      <EditorSection id="scope" title="Exclusions, questions and notes" summary={scopeSummary}>
        <div className="space-y-6">
          <div className="space-y-2">
            <div>
              <h3 className="text-base font-semibold text-ink">Exclusions</h3>
              <p className="text-sm text-ink-3">Printed with the terms.</p>
            </div>
            {exclusionsEditor}
          </div>
          <div className="space-y-2">
            <div>
              <h3 className="text-base font-semibold text-ink">Clarifications</h3>
              <p className="text-sm text-ink-3">Questions for the customer. Not printed on the quotation.</p>
            </div>
            {clarificationsEditor}
          </div>
          <div className="space-y-2">
            <div>
              <h3 className="text-base font-semibold text-ink">Notes</h3>
              <p className="text-sm text-ink-3">Printed after the terms.</p>
            </div>
            {notesEditor}
          </div>
        </div>
      </EditorSection>
    ) : (
      <>
        <div className="grid gap-6 lg:grid-cols-2">
          <Panel>
            <PanelHeader title="Exclusions" description="Printed with the terms." />
            <PanelBody>{exclusionsEditor}</PanelBody>
          </Panel>
          <Panel>
            <PanelHeader title="Clarifications" description="Questions for the customer. Not printed on the quotation." />
            <PanelBody>{clarificationsEditor}</PanelBody>
          </Panel>
        </div>
        <Panel>
          <PanelHeader title="Notes" description="Printed after the terms." />
          <PanelBody>{notesEditor}</PanelBody>
        </Panel>
      </>
    ),
    photos: <PhotosPanel q={q} stamp={stamp} dirty={draft.dirty} onEditStamp={() => setStampOpen(true)} />,
    history: <HistoryPanel detail={detail} />,
  };
  const order = narrow ? PHONE_ORDER : DESKTOP_ORDER;

  const fallback = isTemplateFallback(q.template_reason, templateName(templates.data, q.template_key));

  return (
    <Page>
      <PageHeader
        className="max-lg:hidden"
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

      {/* Phones and tablets: the sticky bar and the chip row replace the page header. */}
      <PhoneBar q={q} flow={flow} sections={sections} menu={phoneMenu} />
      <SectionChips sections={sections} className="mb-4" />

      <div className="-mt-2 mb-6 grid gap-x-8 gap-y-4 border-y border-line py-4 max-lg:hidden sm:grid-cols-2 lg:grid-cols-5">
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
        <Fact label="Template" hint={fallback ? "Another template than first proposed: see the note below." : q.template_reason || undefined}>
          {templateName(templates.data, q.template_key)} · {languageLabel(q.language)}
        </Fact>
        <Fact label="Quotation date">{formatDate(q.data.date ?? q.created_at)}</Fact>
      </div>

      {/* Phones: who and what, in three short lines. */}
      <div className="mb-5 space-y-0.5 lg:hidden">
        <p className="text-base font-semibold text-ink">
          {contractor ? <span dir={isRtl(contractor) ? "rtl" : "auto"}>{contractor}</span> : <span className="font-normal text-ink-3">No contractor recorded</span>}
        </p>
        <p className="text-sm text-ink-2">
          {detail.project ? (
            <Link to={projectHref(detail.project.id)} className="font-medium text-brand-ink underline-offset-4 hover:underline">
              {detail.project.name}
            </Link>
          ) : (
            "No project"
          )}
          {detail.enquiry ? (
            <>
              {" · "}
              <Link
                to={projectHref(detail.enquiry.project_id, "enquiries")}
                className="font-medium text-brand-ink underline-offset-4 hover:underline"
              >
                {detail.enquiry.ref || "Enquiry"}
              </Link>
            </>
          ) : null}
        </p>
        <p className="text-sm text-ink-3">
          {formatDate(q.data.date ?? q.created_at)} · {templateName(templates.data, q.template_key)} · {languageLabel(q.language)} · {createdByLabel(q.created_by)}
        </p>
      </div>

      {fallback ? (
        <Banner
          tone="review"
          className="mb-6"
          title="Another template was used"
          actions={
            <Button variant="secondary" size="sm" asChild>
              <Link to={TEMPLATES_SETUP}>Open Templates</Link>
            </Button>
          }
        >
          {q.template_reason}
        </Banner>
      ) : null}

      <div className="space-y-6">
        {order.map((id) => (
          <Fragment key={id}>{blocks[id]}</Fragment>
        ))}
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

      {flow.dialogs}

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
      <StampDialog
        open={stampOpen}
        onOpenChange={setStampOpen}
        q={q}
        value={stamp}
        readOnly={readOnly}
        paperMode={choices.paper?.mode}
        onApply={(s) => {
          draft.setField("stamp", s);
          setStampOpen(false);
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
  summary,
}: {
  draft: AreaProps["draft"];
  readOnly: boolean;
  rtl: boolean;
  defaultIntro: string[];
  variables?: Record<string, string>;
  summary: ReactNode;
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
    <EditorSection id="letter" collapsible="always" title="Addressee, subject and date" summary={summary}>
      <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">
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
  summary,
  flag,
  onChange,
  readOnly,
  rtl,
  statusFor,
}: {
  terms: Term[];
  summary: ReactNode;
  flag: ReactNode;
  onChange: (terms: Term[]) => void;
  readOnly: boolean;
  rtl: boolean;
  statusFor: (key: string) => ReactNode;
}) {
  return (
    <EditorSection
      id="terms"
      title="Terms"
      description="The agreed wording printed under the items. Customer requests are decided in the section above."
      summary={summary}
      flag={flag}
    >
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
    </EditorSection>
  );
}
