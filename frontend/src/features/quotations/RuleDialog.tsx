/**
 * Add or edit a template rule: "for projects like this → this template, language, paper and
 * signatory". Opened from Setup → Template rules and from the editor ("Save this choice as a
 * template rule", prefilled from the quotation; the customer restriction is never preselected).
 */
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import { useCategories, useCategoryLabel, useWorkspace } from "@/api/session";
import type { TemplateRule } from "@/api/types";
import { requestKindLabel, workTypeLabel } from "@/lib/labels";
import { Button, Checkbox, Dialog, Field, Input, Select, Switch, toast } from "@/ui";
import { useCustomers, useInvalidate, usePapers, useSignatories, useTemplates } from "./api";
import { ExplainedError, Reason } from "./components";
import { matchSummary, paperModeLabel, templateEnabled, templateName, useRoleGate } from "./lib";

const WORK_TYPES = [
  "supply_installation",
  "annual_maintenance",
  "maintenance",
  "service_repair",
  "inspection",
  "inspection_repair",
  "modernization",
  "rental",
  "equipment_rental",
  "tenders",
  "o_and_m",
];
const REQUEST_KINDS = ["tender_rfq", "direct_rfq", "revision", "o_and_m"];

export interface RulePrefill {
  name?: string;
  match?: TemplateRule["match"];
  /** Offered as "Only for <customer>" (unticked); used when saving a choice from a quotation. */
  customer?: { id: string; name: string } | null;
  template_key?: string;
  language?: string | null;
  paper_id?: string | null;
  signatory_id?: string | null;
}

interface Form {
  name: string;
  service_family: string;
  work_type: string;
  request_kind: string;
  customer_id: string;
  template_key: string;
  language: string;
  paper_id: string;
  signatory_id: string;
  priority: string;
  enabled: boolean;
}

export function RuleDialog({
  open,
  onOpenChange,
  rule,
  prefill,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Edit this rule; otherwise a new one. */
  rule?: TemplateRule | null;
  prefill?: RulePrefill;
}) {
  const invalidate = useInvalidate();
  const roleGate = useRoleGate();
  const familyLabel = useCategoryLabel();
  const categories = useCategories();
  const templates = useTemplates();
  const workspace = useWorkspace();
  const papers = usePapers();
  const sigs = useSignatories();
  const fromQuote = Boolean(prefill?.customer !== undefined && !rule);
  const customers = useCustomers(open && !fromQuote);
  const [f, setF] = useState<Form | null>(null);
  const [onlyCustomer, setOnlyCustomer] = useState(false);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      rule ? api.patch<TemplateRule>(`/template-rules/${rule.id}`, body) : api.post<TemplateRule>("/template-rules", body),
    onSuccess: async (saved) => {
      toast.success(rule ? "Template rule updated" : "Template rule saved", {
        description: `New quotations for ${matchSummary(saved.match, undefined, familyLabel).toLowerCase()} use ${templateName(templates.data, saved.template_key)}.`,
      });
      onOpenChange(false);
      await invalidate(["template-rules"]);
    },
  });

  const { reset } = save;
  const input = useRef({ rule, prefill });
  input.current = { rule, prefill };
  // Load the form when the dialog opens; edits stay local until saved.
  useEffect(() => {
    if (!open) return;
    reset();
    setOnlyCustomer(false);
    const { rule, prefill } = input.current;
    const src: Pick<RulePrefill, "name" | "template_key" | "language" | "paper_id" | "signatory_id"> = rule ?? prefill ?? {};
    const m: TemplateRule["match"] = rule?.match ?? prefill?.match ?? {};
    setF({
      name: src.name ?? "",
      service_family: m.service_family ?? "",
      work_type: m.work_type ?? "",
      request_kind: m.request_kind ?? "",
      customer_id: m.customer_id ?? "",
      template_key: src.template_key ?? "",
      language: src.language ?? "",
      paper_id: src.paper_id ?? "",
      signatory_id: src.signatory_id ?? "",
      priority: String(rule?.priority ?? (prefill ? 80 : 100)),
      enabled: rule?.enabled ?? true,
    });
  }, [open, reset]);

  if (!f) return null;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF({ ...f, [k]: v });
  const customerId = fromQuote ? (onlyCustomer ? (prefill?.customer?.id ?? "") : "") : f.customer_id;
  const match = {
    ...(f.service_family && { service_family: f.service_family }),
    ...(f.work_type && { work_type: f.work_type }),
    ...(f.request_kind && { request_kind: f.request_kind }),
    ...(customerId && { customer_id: customerId }),
  };
  const priority = Number(f.priority);
  const priorityBad = !Number.isInteger(priority) || priority < 0 || priority > 1000;
  const denied = roleGate("engineer", rule ? "Editing template rules" : "Adding template rules");
  const resolvedLanguage = f.language || (workspace.settings?.quotations?.default_language as string | undefined) || "en";
  const chosenTemplate = templates.data?.find((t) => t.key === f.template_key);
  const eligible = templateEnabled(chosenTemplate, resolvedLanguage);
  const ready = Boolean(f.template_key) && eligible && !priorityBad && !denied;
  const customerName = (id: string) =>
    id === prefill?.customer?.id ? prefill.customer.name : (customers.data?.items.find((c) => c.id === id)?.name ?? "One customer");

  const submit = () => {
    if (!ready) return;
    save.mutate({
      name: f.name.trim(),
      match,
      template_key: f.template_key,
      language: f.language || null,
      paper_id: f.paper_id || null,
      signatory_id: f.signatory_id || null,
      priority: fromQuote && onlyCustomer && !rule ? Math.min(priority, 50) : priority,
      ...(rule ? { enabled: f.enabled } : {}),
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !save.isPending && onOpenChange(o)}
      title={rule ? "Edit template rule" : fromQuote ? "Save this choice as a template rule" : "New template rule"}
      description="New quotations for matching projects start with this template, language, paper and signatory."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!ready} loading={save.isPending}>
            {rule ? "Save rule" : "Add rule"}
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <Field label="Name" optional htmlFor="rule-name" hint="Shown in the template reason of each quotation it chooses.">
          <Input id="rule-name" value={f.name} onChange={(e) => set("name", e.target.value)} />
        </Field>

        <fieldset className="space-y-3">
          <legend className="text-base font-semibold text-ink">When a project matches</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Service family" htmlFor="rule-family">
              <Select
                id="rule-family"
                value={f.service_family}
                placeholder="Any service family"
                options={(categories.data ?? [])
                  .filter((c) => c.is_work_type)
                  .map((c) => ({ value: c.key, label: c.label }))
                  .concat(
                    f.service_family && !(categories.data ?? []).some((c) => c.key === f.service_family)
                      ? [{ value: f.service_family, label: familyLabel(f.service_family) }]
                      : [],
                  )}
                onChange={(e) => set("service_family", e.target.value)}
              />
            </Field>
            <Field label="Work type" htmlFor="rule-work">
              <Select
                id="rule-work"
                value={f.work_type}
                placeholder="Any work type"
                options={[...new Set([...WORK_TYPES, ...(f.work_type ? [f.work_type] : [])])].map((k) => ({ value: k, label: workTypeLabel(k) }))}
                onChange={(e) => set("work_type", e.target.value)}
              />
            </Field>
            <Field label="Request kind" htmlFor="rule-kind">
              <Select
                id="rule-kind"
                value={f.request_kind}
                placeholder="Any request kind"
                options={[...new Set([...REQUEST_KINDS, ...(f.request_kind ? [f.request_kind] : [])])].map((k) => ({ value: k, label: requestKindLabel(k) }))}
                onChange={(e) => set("request_kind", e.target.value)}
              />
            </Field>
            {fromQuote ? (
              <div className="flex items-end pb-2">
                {prefill?.customer ? (
                  <Checkbox
                    checked={onlyCustomer}
                    onChange={setOnlyCustomer}
                    label={`Only for ${prefill.customer.name}`}
                    description="Otherwise every customer's projects of this kind."
                  />
                ) : (
                  <p className="text-sm text-ink-3">This quotation has no customer: the rule applies to every customer.</p>
                )}
              </div>
            ) : (
              <Field label="Customer" htmlFor="rule-customer">
                <Select
                  id="rule-customer"
                  value={f.customer_id}
                  placeholder={customers.isLoading ? "Loading customers…" : "Any customer"}
                  options={(customers.data?.items ?? [])
                    .map((c) => ({ value: c.id, label: c.name }))
                    .concat(f.customer_id && !customers.data?.items.some((c) => c.id === f.customer_id) ? [{ value: f.customer_id, label: "This customer" }] : [])}
                  onChange={(e) => set("customer_id", e.target.value)}
                />
              </Field>
            )}
          </div>
          <p className="text-sm text-ink-3">
            Applies to: <span className="font-medium text-ink-2">{matchSummary(match, customerName, familyLabel)}</span>
            {Object.keys(match).length === 0 ? ". Narrow it down unless every project should use this template." : ""}
          </p>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-base font-semibold text-ink">Use</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Template" required htmlFor="rule-template" error={f.template_key && templates.data && !eligible ? "This template is switched off for the selected language. Choose another template." : undefined}>
              <Select
                id="rule-template"
                value={f.template_key}
                placeholder="Choose a template"
                options={(templates.data ?? []).filter((t) => templateEnabled(t, resolvedLanguage) || t.key === f.template_key).map((t) => ({ value: t.key, label: `${t.label.en}${templateEnabled(t, resolvedLanguage) ? "" : " · switched off"}`, disabled: !templateEnabled(t, resolvedLanguage) }))}
                onChange={(e) => set("template_key", e.target.value)}
              />
            </Field>
            <Field label="Language" htmlFor="rule-language">
              <Select
                id="rule-language"
                value={f.language}
                placeholder="Workspace default"
                options={[
                  ...["en", "ar"].filter((language) => !chosenTemplate || (chosenTemplate.languages.includes(language) && templateEnabled(chosenTemplate, language))).map((language) => ({ value: language, label: language === "ar" ? "Arabic" : "English" })),
                ]}
                onChange={(e) => set("language", e.target.value)}
              />
            </Field>
            <Field label="Paper" htmlFor="rule-paper">
              <Select
                id="rule-paper"
                value={f.paper_id}
                placeholder="Workspace default"
                options={(papers.data?.items ?? [])
                  .map((p) => ({ value: p.id, label: `${p.name} · ${paperModeLabel(p.mode)}` }))
                  .concat(f.paper_id && !papers.data?.items.some((p) => p.id === f.paper_id) ? [{ value: f.paper_id, label: `${f.paper_id} (not installed)` }] : [])}
                onChange={(e) => set("paper_id", e.target.value)}
              />
            </Field>
            <Field label="Signatory" htmlFor="rule-signatory">
              <Select
                id="rule-signatory"
                value={f.signatory_id}
                placeholder="Workspace default"
                options={(sigs.data ?? []).map((s) => ({ value: s.id, label: `${s.full_name || s.initials} (${s.initials})` }))}
                onChange={(e) => set("signatory_id", e.target.value)}
              />
            </Field>
            <Field
              label="Priority"
              htmlFor="rule-priority"
              error={priorityBad ? "Enter a whole number from 0 to 1000." : undefined}
              hint="Lower numbers are tried first. When two rules match equally, the more specific one wins."
            >
              <Input id="rule-priority" type="number" min={0} max={1000} value={f.priority} invalid={priorityBad} onChange={(e) => set("priority", e.target.value)} />
            </Field>
            {rule ? (
              <div className="flex items-end pb-2">
                <Switch checked={f.enabled} onChange={(v) => set("enabled", v)} label="Rule is on" description="Off: kept, but not used." />
              </div>
            ) : null}
          </div>
        </fieldset>

        <Reason>{denied}</Reason>
        <ExplainedError error={save.error} />
      </div>
    </Dialog>
  );
}
