import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { Automation, AutomationStep } from "@/api/types";
import { Button, Checkbox, Field, IconButton, InlineError, Input, Panel, PanelBody, PanelHeader, QueryState, Select, Textarea, toast } from "@/ui";
import { useSaveWorkflow, useStepCatalog, type StepCatalogItem, type WorkflowInput } from "./api";

/** An inline editor keeps the ordered steps visible on phones as well as desktops. */
export function WorkflowEditor({ automation, onCancel, onSaved }: { automation?: Automation; onCancel: () => void; onSaved: (id: string) => void }) {
  const catalog = useStepCatalog();
  const save = useSaveWorkflow();
  const [form, setForm] = useState<WorkflowInput>(() => ({
    name: automation?.name ?? "", description: automation?.description ?? "", trigger: automation?.trigger ?? "manual",
    interval_minutes: automation?.interval_minutes ?? 60, enabled: automation?.enabled ?? true,
    steps: automation?.steps.map((s) => ({ ...s, config: { ...s.config } })) ?? [],
  }));
  const [addType, setAddType] = useState("classify");
  const [attempted, setAttempted] = useState(false);
  const patch = <K extends keyof WorkflowInput>(key: K, value: WorkflowInput[K]) => setForm((f) => ({ ...f, [key]: value }));
  const patchStep = (index: number, values: Partial<AutomationStep>) => setForm((f) => ({ ...f, steps: f.steps.map((s, i) => i === index ? { ...s, ...values } : s) }));
  const move = (index: number, offset: number) => setForm((f) => { const steps = [...f.steps]; [steps[index], steps[index + offset]] = [steps[index + offset], steps[index]]; return { ...f, steps }; });
  const add = (item: StepCatalogItem) => patch("steps", [...form.steps, {
    key: `${item.type}_${crypto.randomUUID()}`, type: item.type, label: item.label, enabled: true,
    requires_approval: !!item.locked, config: Object.fromEntries((item.config ?? []).map((field) => [field.key, field.default])),
  }]);
  const intervalValid = form.trigger !== "schedule" || (Number.isInteger(form.interval_minutes) && (form.interval_minutes ?? 0) >= 15);
  const configValue = (step: AutomationStep, field: { key: string; default: number }) => step.config[field.key] === undefined ? field.default : step.config[field.key];
  const configValid = form.steps.every((step) => (catalog.data?.find((c) => c.type === step.type)?.config ?? []).every((field) => Number.isInteger(configValue(step, field)) && configValue(step, field) >= 1));
  const valid = !!form.name.trim() && form.steps.length > 0 && intervalValid && configValid;
  const submit = (e: FormEvent) => {
    e.preventDefault(); setAttempted(true);
    if (!valid || !catalog.data) return;
    const steps = form.steps.map((step) => ({ ...step, config: { ...step.config, ...Object.fromEntries((catalog.data.find((c) => c.type === step.type)?.config ?? []).map((field) => [field.key, configValue(step, field)])) } }));
    save.mutate({ id: automation?.id, body: { ...form, steps, name: form.name.trim(), interval_minutes: form.trigger === "schedule" ? form.interval_minutes : null } }, { onSuccess: (result) => { toast.success(automation ? "Workflow saved" : "Workflow created"); onSaved(result.id); } });
  };
  return <Panel>
    <PanelHeader title={automation ? "Edit workflow" : "New workflow"} description="Steps prepare the work. Engineer review remains a human gate; nothing here sends mail or enters prices." />
    <PanelBody>
      <form onSubmit={submit} className="space-y-6" noValidate>
        <fieldset disabled={save.isPending} className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Workflow name" required error={attempted && !form.name.trim() ? "Give the workflow a name." : undefined}><Input autoFocus dir="auto" value={form.name} onChange={(e) => patch("name", e.target.value)} /></Field>
          <Field label="Starts"><Select value={form.trigger} onChange={(e) => patch("trigger", e.target.value)} options={[{ value: "manual", label: "Manual — Run now" }, { value: "new_email", label: "When new mail arrives" }, { value: "schedule", label: "On a schedule" }]} /></Field>
          {form.trigger === "schedule" ? <Field label="Minutes between runs" hint="At least 15 minutes. The server must run its background scheduler." error={attempted && !intervalValid ? "Enter a whole number of at least 15 minutes." : undefined}><Input type="number" min={15} step={1} value={form.interval_minutes ?? ""} onChange={(e) => patch("interval_minutes", e.target.value === "" ? null : Number(e.target.value))} /></Field> : null}
          {form.trigger === "new_email" ? <p className="text-sm text-ink-3 sm:self-end">New-mail runs need a connected mailbox and the background scheduler. The workflow page reports whether both are ready.</p> : null}
          <Field label="Description" optional className="sm:col-span-2"><Textarea dir="auto" rows={2} value={form.description} onChange={(e) => patch("description", e.target.value)} /></Field>
        </div>
        <QueryState query={catalog} compact>{(items) => <div>
          <h2 className="text-lg font-semibold text-ink">Steps in order</h2>
          <p className="mt-1 text-sm text-ink-3">Switch a step off to skip it. Add a pause when a person needs to check its result.</p>
          {attempted && !form.steps.length ? <p role="alert" className="mt-2 text-sm text-block">Add at least one step.</p> : null}
          <ol className="mt-3 divide-y divide-line border-y border-line">
            {form.steps.map((step, index) => {
              const item = items.find((c) => c.type === step.type);
              const locked = item?.locked || step.type === "request_review";
              return <li key={step.key} className="space-y-3 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold text-ink"><span className="tabular">{index + 1}.</span> {item?.label ?? step.label}</p>
                  <div className="flex gap-1">
                    <IconButton label={`Move step ${index + 1} up`} disabled={index === 0 || save.isPending} onClick={() => move(index, -1)}><ArrowUp /></IconButton>
                    <IconButton label={`Move step ${index + 1} down`} disabled={index === form.steps.length - 1 || save.isPending} onClick={() => move(index, 1)}><ArrowDown /></IconButton>
                    <IconButton label={`Remove step ${index + 1}`} disabled={save.isPending || !!locked} onClick={() => patch("steps", form.steps.filter((_, i) => i !== index))}><Trash2 /></IconButton>
                  </div>
                </div>
                {item?.description ? <p className="text-sm text-ink-2">{item.description}</p> : null}
                <Field label={`Step ${index + 1} name`}><Input dir="auto" value={step.label} onChange={(e) => patchStep(index, { label: e.target.value })} /></Field>
                <div className="flex flex-wrap gap-x-5 gap-y-3">
                  <Checkbox label={locked ? "Required engineer review" : "Run this step"} checked={locked ? true : step.enabled !== false} disabled={!!locked || save.isPending} onChange={(enabled) => patchStep(index, { enabled })} />
                  <Checkbox label="Pause for approval" checked={locked ? true : !!step.requires_approval} disabled={!!locked || save.isPending} onChange={(requires_approval) => patchStep(index, { requires_approval })} />
                </div>
                {(item?.config ?? []).map((field) => <Field key={field.key} label={field.label} error={attempted && (!Number.isInteger(configValue(step, field)) || configValue(step, field) < 1) ? "Enter a whole number of at least 1." : undefined}><Input type="number" min={1} step={1} value={configValue(step, field) ?? ""} onChange={(e) => patchStep(index, { config: { ...step.config, [field.key]: e.target.value === "" ? null : Number(e.target.value) } })} /></Field>)}
                {locked ? <p className="text-sm text-ink-3">Engineer review cannot be switched off or removed here.</p> : null}
              </li>;
            })}
          </ol>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end">
            <Field label="Add a step" className="flex-1"><Select value={addType} onChange={(e) => setAddType(e.target.value)} options={items.map((c) => ({ value: c.type, label: c.label }))} /></Field>
            <Button variant="secondary" icon={<Plus />} disabled={save.isPending || !items.some((c) => c.type === addType)} onClick={() => { const item = items.find((c) => c.type === addType); if (item) add(item); }}>Add step</Button>
          </div>
        </div>}</QueryState>
        <Checkbox label="Switch this workflow on" checked={form.enabled} disabled={save.isPending} onChange={(value) => patch("enabled", value)} />
        <InlineError error={save.error} />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" disabled={save.isPending} onClick={onCancel}>Cancel</Button>
          <Button type="submit" loading={save.isPending} disabled={catalog.isLoading || catalog.isError}>{automation ? "Save workflow" : "Create workflow"}</Button>
        </div>
        </fieldset>
      </form>
    </PanelBody>
  </Panel>;
}
