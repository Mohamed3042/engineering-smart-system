/**
 * The workflow editor: create a workflow, or change one. Name and description, how it starts (by
 * hand, on a schedule, when new mail arrives) and the steps: picked from the step catalogue in plain
 * words, in order, each with its own name, settings and on/off switch. The engineer review step is
 * locked: it stays in the workflow and cannot be switched off. Saving sends the whole workflow
 * (POST to create, PATCH to change); whatever the server refuses is shown, and nothing typed is lost.
 */
import { ArrowDown, ArrowUp, Hand, Lock, MailPlus, Plus, Timer, Trash2 } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useBlocker } from "react-router";
import { isApiError } from "@/api/client";
import type { Automation } from "@/api/types";
import {
  Banner,
  Button,
  ChoiceCards,
  Chip,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  LoadingRows,
  Panel,
  PanelBody,
  PanelHeader,
  Select,
  Switch,
  Textarea,
} from "@/ui";
import { useCreateAutomation, useStepCatalog, useUpdateAutomation, type CatalogConfig, type CatalogStep } from "./api";
import { stepDoes, type TriggerSummary } from "./lib";
import { TriggerStatusBlock } from "./parts";
import {
  MIN_INTERVAL,
  configId,
  draftFrom,
  emptyDraft,
  hasProblems,
  sameDraft,
  stepFromCatalog,
  toPayload,
  validate,
  type Draft,
  type DraftStep,
  type Problems,
  type Trigger,
  type Unit,
} from "./workflow";

/* ------------------------------------------------------------------ one setting of a step */

function ConfigField({ def, step, error, onChange }: { def: CatalogConfig; step: DraftStep; error?: string; onChange: (value: unknown) => void }) {
  const id = configId(step.uid, def.key);
  const value = step.config[def.key];
  if (def.type === "boolean") {
    return <Switch label={def.label} checked={value === undefined ? def.default === true : value === true} onChange={onChange} />;
  }
  const number = def.type === "number";
  return (
    <Field label={def.label} htmlFor={id} error={error} hint={def.default !== undefined ? `Standard: ${String(def.default)}` : undefined}>
      <Input
        id={id}
        type={number ? "number" : "text"}
        inputMode={number ? "numeric" : undefined}
        min={number ? 1 : undefined}
        value={value === undefined || value === null ? "" : String(value)}
        placeholder={def.default !== undefined ? String(def.default) : undefined}
        onChange={(e) => {
          const t = e.target.value;
          onChange(t === "" ? undefined : number && /^\d+$/.test(t) ? Number(t) : t);
        }}
      />
    </Field>
  );
}

/* ------------------------------------------------------------------ one step */

const quietDisabled = "aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent";

function StepRow({
  step,
  index,
  count,
  def,
  problems,
  onChange,
  onConfig,
  onMove,
  onRemove,
}: {
  step: DraftStep;
  index: number;
  count: number;
  def: CatalogStep | undefined;
  problems: Problems;
  onChange: (patch: Partial<DraftStep>) => void;
  onConfig: (key: string, value: unknown) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const locked = !!def?.locked;
  const name = step.label.trim() || def?.label || step.type;
  const first = index === 0;
  const last = index === count - 1;
  return (
    <li className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3 gap-y-3 px-5 py-4 sm:grid-cols-[1.75rem_minmax(0,1fr)_auto] sm:gap-x-4">
      <span
        aria-hidden
        className="col-start-1 row-start-1 mt-1 grid size-7 place-items-center rounded-full border border-line-strong text-sm font-semibold text-ink-2 tabular"
      >
        {index + 1}
      </span>
      <div className="col-start-2 row-start-1 min-w-0 space-y-3">
        <Field label={`Step ${index + 1} name`} htmlFor={`${step.uid}-label`}>
          <Input id={`${step.uid}-label`} value={step.label} placeholder={def?.label} dir="auto" onChange={(e) => onChange({ label: e.target.value })} />
        </Field>
        <div className="space-y-1">
          <p className="text-sm text-ink-2">{def?.description ?? stepDoes(step.type) ?? "A step of this workflow."}</p>
          {def && step.label.trim() && step.label.trim() !== def.label ? <p className="text-xs text-ink-3">Standard name: {def.label}</p> : null}
        </div>
        {locked ? (
          <p className="flex items-start gap-2 rounded-lg border border-review-line bg-review-soft px-3 py-2 text-sm text-review">
            <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              <span className="font-semibold">Locked.</span> An engineer always reviews before the quotation moves on, so this step stays on, always waits
              for a person, and cannot be removed.
            </span>
          </p>
        ) : null}
        {def?.config?.length ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {def.config.map((c) => (
              <ConfigField key={c.key} def={c} step={step} error={problems.config[configId(step.uid, c.key)]} onChange={(v) => onConfig(c.key, v)} />
            ))}
          </div>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2 sm:gap-x-6">
          <Switch
            label="Run this step"
            description={locked ? "Always on" : step.enabled ? "Switch it off to skip it" : "Skipped when the workflow runs"}
            checked={locked ? true : step.enabled}
            disabled={locked}
            onChange={(v) => onChange({ enabled: v })}
          />
          <Switch
            label="Wait for a person first"
            description={locked ? "Always on" : "The run stops here until someone continues it"}
            checked={locked ? true : step.requires_approval}
            disabled={locked}
            onChange={(v) => onChange({ requires_approval: v })}
          />
        </div>
      </div>
      <div className="col-span-2 flex items-center justify-end gap-1 sm:col-span-1 sm:col-start-3 sm:row-start-1 sm:flex-col sm:items-end sm:justify-start">
        <IconButton label={first ? `“${name}” is the first step` : `Move “${name}” up`} aria-disabled={first || undefined} className={quietDisabled} onClick={() => !first && onMove(-1)}>
          <ArrowUp />
        </IconButton>
        <IconButton label={last ? `“${name}” is the last step` : `Move “${name}” down`} aria-disabled={last || undefined} className={quietDisabled} onClick={() => !last && onMove(1)}>
          <ArrowDown />
        </IconButton>
        <IconButton
          label={locked ? "A locked step cannot be removed" : `Remove “${name}”`}
          aria-disabled={locked || undefined}
          className={`${quietDisabled} text-block hover:bg-block-soft hover:text-block`}
          onClick={() => !locked && onRemove()}
        >
          <Trash2 />
        </IconButton>
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ add a step */

function AddStepDialog({
  open,
  onOpenChange,
  catalog,
  taken,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  catalog: CatalogStep[];
  /** Locked step types the workflow already has. */
  taken: Set<string>;
  onAdd: (c: CatalogStep) => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a step"
      description="Steps run in the order they are listed. The step is added at the end; move it afterwards."
      size="lg"
    >
      <ul className="-my-2 divide-y divide-line">
        {catalog.map((c) => {
          const already = !!c.locked && taken.has(c.type);
          return (
            <li key={c.type}>
              <button
                type="button"
                disabled={already}
                onClick={() => {
                  onAdd(c);
                  onOpenChange(false);
                }}
                className="flex w-full items-start gap-3 rounded-lg px-2 py-3 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
              >
                <span aria-hidden className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-sunken text-ink-2">
                  <Plus className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold text-ink">
                    {c.label}
                    {c.locked ? (
                      <Chip tone="review" size="sm" icon={<Lock aria-hidden />}>
                        Locked gate
                      </Chip>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block text-sm text-ink-2">{c.description}</span>
                  {already ? <span className="mt-1 block text-xs text-ink-3">Already in this workflow.</span> : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ the form */

const UNIT_OPTIONS: { value: Unit; label: string }[] = [
  { value: "minutes", label: "minutes" },
  { value: "hours", label: "hours" },
  { value: "days", label: "days" },
];

const move = <T,>(list: T[], from: number, to: number): T[] => {
  const next = list.slice();
  [next[from], next[to]] = [next[to], next[from]];
  return next;
};

function EditorForm({
  mode,
  automation,
  status,
  catalog,
  onCancel,
  onSaved,
}: {
  mode: "create" | "edit";
  automation?: Automation;
  status?: TriggerSummary;
  catalog: CatalogStep[];
  onCancel: () => void;
  onSaved: (a: Automation) => void;
}) {
  const formId = useId();
  const create = useCreateAutomation();
  const update = useUpdateAutomation(automation?.id ?? "");
  const saving = create.isPending || update.isPending;
  const error = create.error ?? update.error;
  const [initial] = useState<Draft>(() => (automation ? draftFrom(automation) : emptyDraft()));
  const [draft, setDraft] = useState<Draft>(initial);
  const [showProblems, setShowProblems] = useState(false);
  const [adding, setAdding] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [focusUid, setFocusUid] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  // Set just before the page itself navigates away (after a save, or a confirmed discard) so the guard lets it go.
  const leaving = useRef(false);
  const dirty = !sameDraft(draft, initial);
  const problems = useMemo(() => validate(draft, catalog), [draft, catalog]);
  const shown: Problems = showProblems ? problems : { config: {} };

  // A message the server refused to save: tied to its field when it names one.
  const serverCode = isApiError(error) ? error.code : null;
  const serverName = serverCode === "name_required" && isApiError(error) ? error.message : undefined;
  const serverSteps = (serverCode === "steps_required" || serverCode === "bad_step") && isApiError(error) ? error.message : undefined;

  // Leaving with unsaved changes asks first: here (links, back) and when the tab closes.
  const blocker = useBlocker(() => dirty && !saving && !leaving.current);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    if (!focusUid) return;
    const el = document.getElementById(`${focusUid}-label`);
    el?.scrollIntoView({ block: "center" });
    el?.focus({ preventScroll: true });
    setFocusUid(null);
  }, [focusUid]);

  // The reason a save failed is read out and brought into view.
  useEffect(() => {
    if (error) document.getElementById(`${formId}-error`)?.scrollIntoView({ block: "center" });
  }, [error, formId]);

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setStep = (uid: string, patch: Partial<DraftStep>) => setDraft((d) => ({ ...d, steps: d.steps.map((s) => (s.uid === uid ? { ...s, ...patch } : s)) }));
  const setConfig = (uid: string, key: string, value: unknown) =>
    setDraft((d) => ({
      ...d,
      steps: d.steps.map((s) => {
        if (s.uid !== uid) return s;
        const config = { ...s.config };
        if (value === undefined) delete config[key];
        else config[key] = value;
        return { ...s, config };
      }),
    }));

  const moveStep = (uid: string, dir: -1 | 1) => {
    const i = draft.steps.findIndex((s) => s.uid === uid);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= draft.steps.length) return;
    const label = draft.steps[i].label.trim() || catalog.find((c) => c.type === draft.steps[i].type)?.label || "Step";
    setDraft((d) => ({ ...d, steps: move(d.steps, i, j) }));
    setSaid(`Moved “${label}” to position ${j + 1} of ${draft.steps.length}`);
  };

  const removeStep = (uid: string) => {
    const s = draft.steps.find((x) => x.uid === uid);
    setDraft((d) => ({ ...d, steps: d.steps.filter((x) => x.uid !== uid) }));
    if (s) setSaid(`Removed “${s.label.trim() || s.type}”`);
  };

  const addStep = (c: CatalogStep) => {
    const step = stepFromCatalog(c);
    setDraft((d) => ({ ...d, steps: [...d.steps, step] }));
    setFocusUid(step.uid);
    setSaid(`Added “${c.label}” as step ${draft.steps.length + 1}`);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setShowProblems(true);
    if (hasProblems(problems)) {
      const first =
        problems.name ? `${formId}-name` : problems.every ? `${formId}-every` : Object.keys(problems.config)[0] ?? (problems.steps ? `${formId}-add` : null);
      window.setTimeout(() => {
        const el = first ? document.getElementById(first) : null;
        el?.scrollIntoView({ block: "center" });
        el?.focus({ preventScroll: true });
      }, 0);
      return;
    }
    const body = toPayload(draft, catalog, mode);
    const done = (a: Automation) => {
      leaving.current = true;
      onSaved(a);
    };
    if (mode === "create") create.mutate(body, { onSuccess: done });
    else update.mutate(body, { onSuccess: done });
  };

  const taken = new Set(draft.steps.map((s) => s.type));
  const triggerOptions = [
    { value: "manual", label: "By hand", description: "Runs only when someone presses Run now.", icon: <Hand /> },
    {
      value: "schedule",
      label: "On a schedule",
      description: "Starts by itself at the interval you set, while background runs are on.",
      icon: <Timer />,
    },
    {
      value: "new_email",
      label: "When new mail arrives",
      description: "Starts after a mailbox check finds new mail. Needs a connected mailbox.",
      icon: <MailPlus />,
    },
  ];

  return (
    <form id={formId} onSubmit={submit} noValidate className="space-y-6">
      {error ? (
        <div id={`${formId}-error`}>
          <Banner tone="block" title={mode === "create" ? "The workflow was not created" : "The changes were not saved"}>
            {isApiError(error) ? error.message : "Something went wrong. Nothing you typed was lost; try again."}
          </Banner>
        </div>
      ) : null}

      <Panel>
        <PanelHeader title="Details" />
        <PanelBody className="space-y-4">
          <Field label="Name" required error={shown.name ?? serverName} htmlFor={`${formId}-name`}>
            <Input id={`${formId}-name`} value={draft.name} dir="auto" onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="Description" optional hint="What it does, in a sentence. People see this on the Automations page.">
            <Textarea rows={2} value={draft.description} dir="auto" onChange={(e) => set({ description: e.target.value })} />
          </Field>
          {mode === "create" ? (
            <Switch
              label="Switch it on now"
              description="A workflow that is switched off does not start by itself. Run now still works."
              checked={draft.enabled}
              onChange={(v) => set({ enabled: v })}
            />
          ) : null}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader title="How it starts" description="Run now is always available, whatever you choose." />
        <PanelBody className="space-y-4">
          <ChoiceCards label="How it starts" columns={3} value={draft.trigger} onChange={(v) => set({ trigger: v as Trigger })} options={triggerOptions} />
          {draft.trigger === "schedule" ? (
            <Field label="Run every" required error={shown.every} htmlFor={`${formId}-every`} hint={`At least ${MIN_INTERVAL} minutes.`}>
              <div className="flex gap-2">
                <Input
                  id={`${formId}-every`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={draft.every}
                  onChange={(e) => set({ every: e.target.value })}
                  className="w-28"
                />
                <Select
                  id={`${formId}-unit`}
                  aria-label="Unit of time"
                  value={draft.unit}
                  onChange={(e) => set({ unit: e.target.value as Unit })}
                  options={UNIT_OPTIONS}
                  className="w-36"
                />
              </div>
            </Field>
          ) : null}
          <div className="rounded-lg border border-line bg-sunken px-3.5 py-3">
            {status ? (
              <>
                <p className="mb-1 text-xs font-medium text-ink-3">Right now, as saved</p>
                <TriggerStatusBlock summary={status} />
              </>
            ) : (
              <p className="text-sm text-ink-2">After you save, the workflow page says whether it starts by itself right now and why.</p>
            )}
          </div>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader
          title="Steps"
          description="They run in this order. A step that is switched off is skipped."
          actions={
            draft.steps.length ? (
              <Button variant="secondary" size="sm" icon={<Plus />} onClick={() => setAdding(true)}>
                Add step
              </Button>
            ) : null
          }
        />
        {draft.steps.length === 0 ? (
          <EmptyState compact title="No steps yet" className={shown.steps || serverSteps ? "pb-4" : undefined}>
            Pick the first step from the list: reading mail, filing it, saving attachments, drafting a quotation and more.
            <span className="mt-4 flex justify-center">
              <Button id={`${formId}-add`} icon={<Plus />} onClick={() => setAdding(true)}>
                Add the first step
              </Button>
            </span>
          </EmptyState>
        ) : (
          <ol className="divide-y divide-line">
            {draft.steps.map((s, i) => (
              <StepRow
                key={s.uid}
                step={s}
                index={i}
                count={draft.steps.length}
                def={catalog.find((c) => c.type === s.type)}
                problems={shown}
                onChange={(patch) => setStep(s.uid, patch)}
                onConfig={(key, value) => setConfig(s.uid, key, value)}
                onMove={(dir) => moveStep(s.uid, dir)}
                onRemove={() => removeStep(s.uid)}
              />
            ))}
          </ol>
        )}
        {shown.steps || serverSteps ? (
          <p role="alert" className="border-t border-line px-5 py-3 text-sm text-block">
            {shown.steps ?? serverSteps}
          </p>
        ) : null}
        {draft.steps.length ? (
          <div className="border-t border-line px-5 py-3">
            <Button id={`${formId}-add`} variant="secondary" icon={<Plus />} onClick={() => setAdding(true)} className="w-full sm:w-auto">
              Add step
            </Button>
          </div>
        ) : null}
      </Panel>

      <p className="sr-only" role="status" aria-live="polite">
        {said}
      </p>

      <div className="sticky bottom-20 z-20 lg:bottom-4">
        <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-3 shadow-pop sm:flex-row sm:items-center">
          <p className="min-w-0 px-1 text-sm text-ink-2 empty:hidden" aria-live="polite">
            {saving ? "Saving…" : dirty ? (mode === "edit" ? "Unsaved changes. Run now still uses the saved workflow." : "Not saved yet.") : ""}
          </p>
          <div className="grid grid-cols-2 gap-2 sm:ml-auto sm:flex">
            <Button variant="secondary" onClick={() => (dirty ? setDiscard(true) : onCancel())} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" loading={saving} disabled={mode === "edit" && !dirty}>
              {mode === "create" ? "Create workflow" : "Save changes"}
            </Button>
          </div>
        </div>
      </div>

      <AddStepDialog open={adding} onOpenChange={setAdding} catalog={catalog} taken={taken} onAdd={addStep} />
      <ConfirmDialog
        open={discard}
        onOpenChange={setDiscard}
        title="Discard your changes?"
        confirmLabel="Discard changes"
        variant="danger"
        onConfirm={() => {
          setDiscard(false);
          leaving.current = true;
          onCancel();
        }}
      >
        <p className="text-base text-ink-2">Nothing you changed on this page has been saved. It will be lost.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={blocker.state === "blocked"}
        onOpenChange={(o) => !o && blocker.reset?.()}
        title="Leave without saving?"
        confirmLabel="Leave"
        cancelLabel="Keep editing"
        variant="danger"
        onConfirm={() => blocker.proceed?.()}
      >
        <p className="text-base text-ink-2">Your changes to this workflow have not been saved. If you leave now, they are lost.</p>
      </ConfirmDialog>
    </form>
  );
}

export function WorkflowEditor({
  mode,
  automation,
  status,
  onCancel,
  onSaved,
}: {
  mode: "create" | "edit";
  /** The workflow being changed (edit only). */
  automation?: Automation;
  /** How it starts right now, as saved (edit only). */
  status?: TriggerSummary;
  onCancel: () => void;
  onSaved: (a: Automation) => void;
}) {
  const catalog = useStepCatalog();
  if (catalog.isLoading) {
    return (
      <Panel>
        <LoadingRows rows={5} />
      </Panel>
    );
  }
  if (catalog.isError || !catalog.data) {
    return (
      <Panel>
        <ErrorState error={catalog.error} onRetry={() => catalog.refetch()} title="The list of steps could not load" />
      </Panel>
    );
  }
  return <EditorForm mode={mode} automation={automation} status={status} catalog={catalog.data} onCancel={onCancel} onSaved={onSaved} />;
}
