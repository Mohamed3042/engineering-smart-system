/**
 * Documents: the project's quotations (one per contractor), creating one, and the template rule
 * "use this template for projects like this". Prices always start empty.
 */
import { FilePlus2, FileText, LayoutTemplate, TriangleAlert } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "@/api/client";
import { useCategoryLabel } from "@/api/session";
import type { Quotation, TemplateRule } from "@/api/types";
import { formatDate, formatRelative } from "@/lib/format";
import { quotationStatusInfo, workTypeLabel } from "@/lib/labels";
import { quotationHref } from "@/lib/routes";
import {
  Button,
  ChoiceCards,
  Chip,
  Dialog,
  EmptyState,
  Field,
  InlineError,
  KeyValue,
  ListRow,
  LoadingRows,
  Panel,
  PanelBody,
  PanelHeader,
  QueryState,
  Section,
  Select,
  Skeleton,
  StatusChip,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/ui";
import {
  useProjectMutation,
  useProjectQuotations,
  useTemplateRules,
  useTemplates,
  type ProjectDetail,
  type QuotationRow,
  type TemplateInfo,
} from "../api";
import { Bidi } from "../parts";
import type { TabProps } from "../ProjectLayout";

export function DocumentsTab({ detail }: TabProps) {
  const p = detail.project;
  const navigate = useNavigate();
  const query = useProjectQuotations(p.id);
  const [choosing, setChoosing] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);

  const create = useProjectMutation(
    (enquiryId: string | null) =>
      api.post<Quotation>("/quotations", enquiryId ? { project_id: p.id, enquiry_id: enquiryId } : { project_id: p.id }),
    {
      projectId: p.id,
      invalidate: [["quotations"], ["enquiries"]],
      success: (q) => `Quotation ${q.reference || ""} created. Prices start empty.`,
      onSuccess: (q) => {
        setChoosing(false);
        navigate(quotationHref(q.id));
      },
    },
  );
  const startCreate = () => (detail.enquiries.length > 1 ? setChoosing(true) : create.mutate(detail.enquiries[0]?.id ?? null));

  const createButton = (className?: string) => (
    <Button
      icon={<FilePlus2 />}
      className={className}
      loading={create.isPending && !choosing}
      disabled={!!p.archived_at}
      onClick={startCreate}
    >
      Create quotation
    </Button>
  );

  return (
    <div className="space-y-8">
      <Section
        title="Quotations"
        description="One quotation per contractor. Each has its own version, approval and send record."
        actions={query.data?.items.length ? <div className="hidden sm:block">{createButton()}</div> : undefined}
      >
        <QueryState
          query={query}
          loading={
            <Panel>
              <LoadingRows rows={3} />
            </Panel>
          }
          isEmpty={(d) => d.items.length === 0}
          empty={
            <Panel>
              <EmptyState icon={<FileText />} title="No quotation yet" action={createButton()}>
                Create one per contractor. The draft takes the scope and the company template; prices start empty and are
                entered by a person.
              </EmptyState>
            </Panel>
          }
        >
          {(d) => <QuotationList rows={d.items} detail={detail} />}
        </QueryState>
        {query.data?.items.length ? <div className="sm:hidden">{createButton("w-full")}</div> : null}
      </Section>

      <TemplatePanel detail={detail} quotations={query.data?.items ?? []} onOpen={() => setTemplateOpen(true)} />

      <ChooseEnquiryDialog
        open={choosing}
        onOpenChange={(o) => !create.isPending && setChoosing(o)}
        detail={detail}
        quotations={query.data?.items ?? []}
        loading={create.isPending}
        error={create.error}
        onCreate={(id) => create.mutate(id)}
      />
      <TemplateRuleDialog
        open={templateOpen}
        onOpenChange={setTemplateOpen}
        detail={detail}
        quotations={query.data?.items ?? []}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ list */

function contractorOf(q: QuotationRow, detail: ProjectDetail): { name: string; ref: string | null } {
  const e = q.enquiry_id ? detail.enquiries.find((x) => x.id === q.enquiry_id) : undefined;
  return { name: q.customer?.name ?? e?.customer?.name ?? detail.customer?.name ?? "No contractor", ref: e?.ref || null };
}

function StatusCell({ q }: { q: QuotationRow }) {
  const missing = Array.isArray(q.missing_prices) ? q.missing_prices.length : 0;
  return (
    <div className="flex flex-col items-start gap-1.5">
      <StatusChip info={quotationStatusInfo(q.status)} size="sm" />
      {q.impact_review?.required ? (
        <Chip tone="review" size="sm" icon={<TriangleAlert aria-hidden />}>
          Needs impact review
        </Chip>
      ) : null}
      {missing && q.status === "draft" ? (
        <span className="text-xs text-ink-3">
          {missing} {missing === 1 ? "price" : "prices"} to enter
        </span>
      ) : null}
    </div>
  );
}

function QuotationList({ rows, detail }: { rows: QuotationRow[]; detail: ProjectDetail }) {
  return (
    <>
      <Panel className="hidden overflow-hidden lg:block">
        <Table>
          <THead>
            <tr>
              <TH>Reference</TH>
              <TH>Version</TH>
              <TH>Status</TH>
              <TH>Contractor / enquiry</TH>
              <TH>Updated</TH>
              <TH>
                <span className="sr-only">Open</span>
              </TH>
            </tr>
          </THead>
          <TBody>
            {rows.map((q) => {
              const c = contractorOf(q, detail);
              return (
                <TR key={q.id}>
                  <TD>
                    <Link to={quotationHref(q.id)} className="font-semibold text-ink hover:underline">
                      {q.reference || "Draft quotation"}
                    </Link>
                  </TD>
                  <TD className="tabular">v{q.version}</TD>
                  <TD>
                    <StatusCell q={q} />
                  </TD>
                  <TD className="max-w-[18rem]">
                    <Bidi text={c.name} as="div" className="break-words text-ink" />
                    {c.ref ? <div className="text-sm text-ink-3">{c.ref}</div> : null}
                  </TD>
                  <TD className="whitespace-nowrap text-ink-2">{formatRelative(q.updated_at)}</TD>
                  <TD className="w-px">
                    <Button asChild size="sm" variant="secondary">
                      <Link to={quotationHref(q.id)}>Open</Link>
                    </Button>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </Panel>
      <ul className="space-y-3 lg:hidden" aria-label="Quotations">
        {rows.map((q) => {
          const c = contractorOf(q, detail);
          return (
            <li key={q.id}>
              <ListRow
                to={quotationHref(q.id)}
                title={`${q.reference || "Draft quotation"} · v${q.version}`}
                subtitle={<Bidi text={[c.name, c.ref].filter(Boolean).join(" · ")} />}
              >
                <StatusCell q={q} />
                <p className="mt-2 text-xs text-ink-3">Updated {formatRelative(q.updated_at)}</p>
              </ListRow>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/* ------------------------------------------------------------------ create */

function ChooseEnquiryDialog({
  open,
  onOpenChange,
  detail,
  quotations,
  loading,
  error,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  detail: ProjectDetail;
  quotations: QuotationRow[];
  loading: boolean;
  error: unknown;
  onCreate: (enquiryId: string) => void;
}) {
  const [value, setValue] = useState("");
  useEffect(() => {
    if (open) setValue("");
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create quotation"
      description="Each contractor gets its own quotation. Choose who this one is for."
      hideClose={loading}
      footer={
        <>
          <Button variant="secondary" disabled={loading} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button icon={<FilePlus2 />} disabled={!value} loading={loading} onClick={() => onCreate(value)}>
            Create quotation
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <ChoiceCards
          label="Contractor"
          columns={1}
          value={value}
          onChange={setValue}
          options={detail.enquiries.map((e) => {
            const existing = quotations.find((q) => q.enquiry_id === e.id);
            return {
              value: e.id,
              label: <Bidi text={e.customer?.name ?? "Unknown contractor"} />,
              description: [
                e.ref,
                e.due_date ? `closing ${formatDate(e.due_date)}` : null,
                existing ? `already has ${existing.reference || "a quotation"} (${quotationStatusInfo(existing.status).label})` : null,
              ]
                .filter(Boolean)
                .join(" · "),
            };
          })}
        />
        {!value ? <p className="text-sm text-ink-3">Choose a contractor to continue.</p> : null}
        <InlineError error={error} />
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ template rule */

function templateLabel(t: TemplateInfo | undefined, key: string | null | undefined): string {
  if (!t) return key || "—";
  return typeof t.label === "string" ? t.label : t.label.en || t.key;
}

const LANGUAGE: Record<string, string> = { en: "English", ar: "Arabic" };

/** Rules this project matches: same service family and work type, optionally this customer. */
function matchingRules(rules: TemplateRule[] | undefined, detail: ProjectDetail) {
  const p = detail.project;
  const same = (r: TemplateRule) =>
    r.enabled && r.match.service_family === p.service_family && r.match.work_type === p.work_type && !r.match.request_kind;
  return {
    type: rules?.find((r) => same(r) && !r.match.customer_id),
    customer: p.customer_id ? rules?.find((r) => same(r) && r.match.customer_id === p.customer_id) : undefined,
  };
}

function TemplatePanel({ detail, quotations, onOpen }: { detail: ProjectDetail; quotations: QuotationRow[]; onOpen: () => void }) {
  const p = detail.project;
  const templates = useTemplates();
  const rules = useTemplateRules();
  const categoryLabel = useCategoryLabel();
  const byKey = (k: string | null | undefined) => templates.data?.find((t) => t.key === k);
  const { type, customer } = matchingRules(rules.data, detail);
  const used = quotations[0]?.template_key;
  const typeRule = rules.isLoading ? (
    <Skeleton className="h-4 w-32" />
  ) : rules.isError ? (
    <span className="text-ink-3">The rules could not load</span>
  ) : type ? (
    templateLabel(byKey(type.template_key), type.template_key)
  ) : (
    <span className="text-ink-3">No rule yet</span>
  );
  return (
    <Panel>
      <PanelHeader title="Quotation template" description="Which company template new quotations of this kind start from." />
      <PanelBody className="space-y-4">
        <KeyValue
          labelWidth="lg"
          items={[
            { label: "Recommended for this project", value: p.recommended_template ? templateLabel(byKey(p.recommended_template), p.recommended_template) : null },
            ...(used ? [{ label: "Used by the latest quotation", value: templateLabel(byKey(used), used) }] : []),
            {
              label: `${categoryLabel(p.service_family)} · ${workTypeLabel(p.work_type)}`,
              value: typeRule,
              hint: type ? `Rule set by ${type.created_by || "a person"}` : undefined,
            },
            ...(customer
              ? [
                  {
                    label: `${detail.customer?.name ?? "This customer"}'s projects`,
                    value: templateLabel(byKey(customer.template_key), customer.template_key),
                    hint: `Rule set by ${customer.created_by || "a person"}`,
                  },
                ]
              : []),
          ]}
        />
        <Button variant="secondary" icon={<LayoutTemplate />} className="h-auto min-h-10 w-full whitespace-normal py-2 sm:w-auto" onClick={onOpen}>
          Use this template for projects like this
        </Button>
      </PanelBody>
    </Panel>
  );
}

function TemplateRuleDialog({
  open,
  onOpenChange,
  detail,
  quotations,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  detail: ProjectDetail;
  quotations: QuotationRow[];
}) {
  const p = detail.project;
  const id = useId();
  const templates = useTemplates();
  const categoryLabel = useCategoryLabel();
  const [template, setTemplate] = useState("");
  const [scope, setScope] = useState<"project_type" | "customer">("project_type");
  const [language, setLanguage] = useState("");
  const kind = `${categoryLabel(p.service_family)} · ${workTypeLabel(p.work_type)}`;

  const save = useProjectMutation(
    () =>
      api.post<TemplateRule>(`/projects/${encodeURIComponent(p.id)}/template-preference`, {
        template_key: template,
        scope,
        ...(language ? { language } : {}),
      }),
    {
      invalidate: [["template-rules"]],
      toastErrors: false,
      success: () =>
        `Template rule saved: ${templateLabel(templates.data?.find((t) => t.key === template), template)} for ${
          scope === "customer" ? `${detail.customer?.name ?? "this customer"}'s projects` : kind
        }`,
      onSuccess: () => onOpenChange(false),
    },
  );
  const { reset } = save;
  const initial = p.recommended_template ?? quotations[0]?.template_key ?? "";
  useEffect(() => {
    if (open) {
      setTemplate(initial);
      setScope("project_type");
      setLanguage("");
      reset();
    }
  }, [open, initial, reset]);

  const chosen = templates.data?.find((t) => t.key === template);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !save.isPending && onOpenChange(o)}
      title="Use this template for projects like this"
      description="New quotations for matching projects start from this template. Existing quotations do not change."
      hideClose={save.isPending}
      footer={
        <>
          <Button variant="secondary" disabled={save.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!template || !chosen || chosen.enabled === false || chosen.available === false} loading={save.isPending} onClick={() => save.mutate()}>
            Save template rule
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="Template" required htmlFor={`${id}-template`} hint={!template ? "Choose the template to use." : undefined}>
          <Select
            id={`${id}-template`}
            value={template}
            onChange={(e) => {
              setTemplate(e.target.value);
              setLanguage("");
            }}
            placeholder={templates.isLoading ? "Loading templates…" : "Choose a template"}
            options={(templates.data ?? []).filter((t) => t.enabled !== false && t.available !== false).map((t) => ({ value: t.key, label: templateLabel(t, t.key) }))}
          />
        </Field>
        {templates.error ? <InlineError error={templates.error} /> : null}
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-ink">Applies to</p>
          <ChoiceCards
            label="Applies to"
            columns={1}
            value={scope}
            onChange={(v) => setScope(v === "customer" ? "customer" : "project_type")}
            options={[
              { value: "project_type", label: "Projects like this", description: kind },
              {
                value: "customer",
                label: "This customer's projects of this kind",
                description: detail.customer ? `${detail.customer.name} · ${kind}` : "This project has no customer.",
                disabled: !p.customer_id,
              },
            ]}
          />
        </div>
        {chosen?.languages && chosen.languages.length > 1 ? (
          <Field label="Language" optional htmlFor={`${id}-language`}>
            <Select
              id={`${id}-language`}
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              placeholder="As the quotation decides"
              options={chosen.languages.map((l) => ({ value: l, label: LANGUAGE[l] ?? l }))}
            />
          </Field>
        ) : null}
        <InlineError error={save.error} />
      </div>
    </Dialog>
  );
}
