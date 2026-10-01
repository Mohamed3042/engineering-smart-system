/**
 * Template rules: "for projects like this → template, language, paper, signatory", in priority
 * order, with who made them (a person or learned from choices), how often they were used, an on/off
 * switch, edit and delete. Learned preferences are listed below for reference.
 */
import { useMutation } from "@tanstack/react-query";
import { EllipsisVertical, ListChecks, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "@/api/client";
import { useCategoryLabel } from "@/api/session";
import type { TemplateRule } from "@/api/types";
import { formatDate } from "@/lib/format";
import { workTypeLabel } from "@/lib/labels";
import {
  Button,
  Chip,
  CollapsibleSection,
  ConfirmDialog,
  EmptyState,
  IconButton,
  ListRow,
  LoadingRows,
  Menu,
  Panel,
  PanelHeader,
  QueryState,
  Switch,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  toast,
  toastError,
} from "@/ui";
import { useCustomers, useInvalidate, usePapers, useSignatories, useTemplateLessons, useTemplateRules, useTemplates } from "../api";
import { ExplainedError, Reason } from "../components";
import { languageLabel, matchSummary, paperName, signatoryLabel, templateName, useRoleGate } from "../lib";
import { RuleDialog } from "../RuleDialog";

export function RulesTab() {
  const rules = useTemplateRules();
  const templates = useTemplates();
  const papers = usePapers();
  const sigs = useSignatories();
  const customers = useCustomers();
  const familyLabel = useCategoryLabel();
  const invalidate = useInvalidate();
  const denied = useRoleGate()("engineer", "Changing template rules");
  const [editing, setEditing] = useState<TemplateRule | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<TemplateRule | null>(null);

  const customerName = (id: string) => customers.data?.items.find((c) => c.id === id)?.name ?? "One customer";
  const applies = (r: TemplateRule) => matchSummary(r.match, customerName, familyLabel);
  const uses = (r: TemplateRule) =>
    [
      templateName(templates.data, r.template_key),
      r.language ? languageLabel(r.language) : null,
      r.paper_id ? paperName(papers.data?.items, r.paper_id) : null,
      r.signatory_id ? signatoryLabel(sigs.data?.find((s) => s.id === r.signatory_id)) : null,
    ]
      .filter(Boolean)
      .join(" · ");
  const ruleName = (r: TemplateRule) => r.name || templateName(templates.data, r.template_key);

  const toggle = useMutation({
    mutationFn: (r: TemplateRule) => api.patch<TemplateRule>(`/template-rules/${r.id}`, { enabled: !r.enabled }),
    onSuccess: async (r) => {
      toast.success(r.enabled ? "Rule turned on" : "Rule turned off", { description: ruleName(r) });
      await invalidate(["template-rules"]);
    },
    onError: (e) => toastError(e),
  });
  const remove = useMutation({
    mutationFn: (r: TemplateRule) => api.del(`/template-rules/${r.id}`),
    onSuccess: async () => {
      toast.success("Template rule deleted");
      setDeleting(null);
      await invalidate(["template-rules"]);
    },
  });

  const menu = (r: TemplateRule) => [
    { label: "Edit rule", icon: <Pencil />, onSelect: () => setEditing(r), disabled: Boolean(denied) },
    { label: "Delete rule", icon: <Trash2 />, danger: true, separatorBefore: true, onSelect: () => setDeleting(r), disabled: Boolean(denied) },
  ];
  const source = (r: TemplateRule) =>
    r.source === "learned" ? (
      <Chip size="sm" tone="neutral">
        Learned
      </Chip>
    ) : (
      <Chip size="sm" tone="muted">
        Written by {r.created_by || "a person"}
      </Chip>
    );

  return (
    <div className="space-y-6">
      <Panel>
        <PanelHeader
          title="Template rules"
          description="Rules choose the template, language, paper and signatory of new quotations. Lower priority numbers are tried first."
          actions={
            <Button icon={<Plus />} onClick={() => setAdding(true)} disabled={Boolean(denied)}>
              Add rule
            </Button>
          }
        />
        {denied ? <Reason className="px-5 pt-3">{denied}</Reason> : null}
        <QueryState
          query={rules}
          loading={<LoadingRows rows={4} />}
          isEmpty={(d) => d.length === 0}
          empty={
            <EmptyState icon={<ListChecks />} title="No template rules yet">
              Without rules, the template follows the project's work type. Add a rule here, or save the choice from a quotation
              with "Save as template rule".
            </EmptyState>
          }
        >
          {(list) => (
            <>
              <div className="hidden lg:block">
                <Table>
                  <THead>
                    <tr>
                      <TH>Rule</TH>
                      <TH>Applies to</TH>
                      <TH>Uses</TH>
                      <TH className="text-right">Priority</TH>
                      <TH className="text-right">Used</TH>
                      <TH>On</TH>
                      <TH>
                        <span className="sr-only">Actions</span>
                      </TH>
                    </tr>
                  </THead>
                  <TBody>
                    {list.map((r) => (
                      <TR key={r.id} className={r.enabled ? undefined : "text-ink-3"}>
                        <TD>
                          <p className="font-medium text-ink">{ruleName(r)}</p>
                          <div className="mt-1">{source(r)}</div>
                        </TD>
                        <TD className="max-w-64 text-sm text-ink-2">{applies(r)}</TD>
                        <TD className="max-w-72 text-sm text-ink-2">{uses(r)}</TD>
                        <TD className="text-right tabular">{r.priority}</TD>
                        <TD className="whitespace-nowrap text-right text-sm text-ink-2 tabular">
                          {r.hits} {r.hits === 1 ? "time" : "times"}
                        </TD>
                        <TD>
                          <Switch
                            checked={r.enabled}
                            disabled={Boolean(denied) || toggle.isPending}
                            onChange={() => toggle.mutate(r)}
                            label={r.enabled ? "On" : "Off"}
                            className="w-24"
                          />
                        </TD>
                        <TD className="w-12">
                          <Menu
                            items={menu(r)}
                            trigger={
                              <IconButton label={`Actions for ${ruleName(r)}`} size="sm" tooltip={false}>
                                <EllipsisVertical />
                              </IconButton>
                            }
                          />
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
              <ul className="space-y-3 p-4 lg:hidden">
                {list.map((r) => (
                  <li key={r.id}>
                    <ListRow
                      title={ruleName(r)}
                      subtitle={applies(r)}
                      aside={
                        <Menu
                          items={menu(r)}
                          trigger={
                            <IconButton label={`Actions for ${ruleName(r)}`} size="sm" tooltip={false}>
                              <EllipsisVertical />
                            </IconButton>
                          }
                        />
                      }
                      footer={
                        <Switch
                          checked={r.enabled}
                          disabled={Boolean(denied) || toggle.isPending}
                          onChange={() => toggle.mutate(r)}
                          label={r.enabled ? "Rule is on" : "Rule is off"}
                        />
                      }
                    >
                      <p>Uses {uses(r)}</p>
                      <p className="mt-1 text-ink-3">
                        Priority {r.priority} · used {r.hits} {r.hits === 1 ? "time" : "times"}
                      </p>
                      <div className="mt-2">{source(r)}</div>
                    </ListRow>
                  </li>
                ))}
              </ul>
            </>
          )}
        </QueryState>
      </Panel>

      <LearnedPreferences />

      <RuleDialog open={adding} onOpenChange={setAdding} />
      <RuleDialog open={Boolean(editing)} onOpenChange={(o) => !o && setEditing(null)} rule={editing} />
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(o) => {
          if (!o) {
            setDeleting(null);
            remove.reset();
          }
        }}
        title={`Delete the rule "${deleting ? ruleName(deleting) : ""}"?`}
        description={deleting ? `New quotations for ${applies(deleting).toLowerCase()} no longer use it.` : undefined}
        confirmLabel="Delete rule"
        variant="danger"
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      >
        <p className="text-sm text-ink-2">Quotations already drafted keep their template. To pause the rule instead, turn it off.</p>
        <ExplainedError error={remove.error} className="mt-3" />
      </ConfirmDialog>
    </div>
  );
}

function LearnedPreferences() {
  const lessons = useTemplateLessons();
  const templates = useTemplates();
  const familyLabel = useCategoryLabel();
  const items = lessons.data?.items ?? [];
  if (!lessons.isLoading && !lessons.isError && items.length === 0) return null;
  return (
    <CollapsibleSection
      title="Learned from your choices"
      summary={lessons.isLoading ? "Loading" : `${items.length} ${items.length === 1 ? "preference" : "preferences"}`}
    >
      <p className="mb-3 text-sm text-ink-3">
        When people keep choosing the same template for a kind of project, new drafts follow that choice. A rule always wins.
      </p>
      <QueryState query={lessons} loading={<LoadingRows rows={2} />} compact>
        {() => (
          <ul className="divide-y divide-line">
            {items.map((l) => {
              const after = (l.after && typeof l.after === "object" ? l.after : {}) as Record<string, unknown>;
              const [family, work] = l.scope_key.split("|");
              return (
                <li key={l.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-medium text-ink">
                      {familyLabel(family)}
                      {work ? ` · ${workTypeLabel(work)}` : ""}
                    </p>
                    <p className="text-sm text-ink-2">
                      {templateName(templates.data, typeof after.template_key === "string" ? after.template_key : null)}
                      {typeof after.language === "string" ? ` · ${languageLabel(after.language)}` : ""}
                    </p>
                  </div>
                  <p className="text-sm text-ink-3">
                    Chosen {l.count} {l.count === 1 ? "time" : "times"} · last {formatDate(l.last_seen_at)}
                    {l.active ? "" : " · off"}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </QueryState>
    </CollapsibleSection>
  );
}
