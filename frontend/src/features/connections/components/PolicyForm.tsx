import { useMemo, useState, type FormEvent } from "react";
import { TagInput } from "@/features/knowledge/components/TagInput";
import {
  Banner,
  Button,
  Checkbox,
  Field,
  InlineError,
  Input,
  Panel,
  PanelBody,
  PanelHeader,
  Select,
  Switch,
  Textarea,
  toast,
} from "@/ui";
import { MANAGE_HINT, usePutPolicy } from "../api";
import { Disclosure } from "./bits";
import {
  appliedDifferences,
  CAPABILITIES,
  CONTEXT_CHOICES,
  draftFromPolicy,
  FLOOR,
  policyFromDraft,
  sameDraft,
  validateDraft,
  type PolicyDraft,
  type PolicyErrors,
} from "../policy";
import type { AiPolicy } from "../types";
import { AI_PROVIDER_LABEL, formatTokens } from "../vocab";

const PROVIDERS = Object.entries(AI_PROVIDER_LABEL).filter(([k]) => k !== "mcp");

function toggle(list: string[], value: string, on: boolean) {
  return on ? [...new Set([...list, value])] : list.filter((x) => x !== value);
}

/**
 * The workspace's own AI rules. Everything here can only make the floor stricter: the controls stop at the
 * floor, and the backend raises any value that gets below it, so a weaker rule never takes effect.
 */
export function PolicyForm({ policy, canEdit }: { policy: AiPolicy; canEdit: boolean }) {
  const put = usePutPolicy();
  const base = useMemo(() => draftFromPolicy(policy), [policy]);
  const [draft, setDraft] = useState<PolicyDraft>(base);
  const [errors, setErrors] = useState<PolicyErrors>({});
  const [applied, setApplied] = useState<string[]>([]);
  const dirty = !sameDraft(draft, base);
  const set = <K extends keyof PolicyDraft>(k: K, v: PolicyDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const locked = !canEdit || put.isPending;

  const contextOptions = [...new Set([...CONTEXT_CHOICES, draft.minContext])]
    .sort((a, b) => a - b)
    .map((n) => ({ value: String(n), label: `${n.toLocaleString("en-GB")} tokens (${formatTokens(n)})${n === FLOOR.minContextTokens ? " · floor" : ""}` }));

  function submit(e: FormEvent) {
    e.preventDefault();
    const found = validateDraft(draft);
    setErrors(found);
    if (found.minScore || found.maxAge) return;
    const next = policyFromDraft(draft, policy);
    put.mutate(next, {
      onSuccess: (saved) => {
        const diff = appliedDifferences(next, saved);
        setApplied(diff);
        setDraft(draftFromPolicy(saved));
        if (diff.length === 0) toast.success("AI quality rules saved", { description: "Models are checked against them again." });
        else toast("Saved, with limits applied", { description: "The backend raised or ignored some values. See the note on this page." });
      },
    });
  }

  return (
    <Panel>
      <PanelHeader
        title="Your rules"
        description="Make the floor stricter for this workspace. Values below the floor are not accepted. Saving checks every model against the new rules."
      />
      <form onSubmit={submit} noValidate>
        <PanelBody className="space-y-7">
          <div className="grid gap-5 sm:grid-cols-3">
            <Field label="Minimum exam score (%)" htmlFor="pol-score" error={errors.minScore} hint={`Floor ${FLOOR.minScore * 100}%. You can raise it.`}>
              <Input
                id="pol-score"
                type="number"
                inputMode="decimal"
                min={FLOOR.minScore * 100}
                max={100}
                step={1}
                value={draft.minScorePct}
                invalid={!!errors.minScore}
                disabled={locked}
                onChange={(e) => set("minScorePct", e.target.value)}
              />
            </Field>
            <Field label="Exam valid for (days)" htmlFor="pol-days" error={errors.maxAge} hint={`At most ${FLOOR.maxExamAgeDays}. You can shorten it.`}>
              <Input
                id="pol-days"
                type="number"
                inputMode="numeric"
                min={1}
                max={FLOOR.maxExamAgeDays}
                step={1}
                value={draft.maxAgeDays}
                invalid={!!errors.maxAge}
                disabled={locked}
                onChange={(e) => set("maxAgeDays", e.target.value)}
              />
            </Field>
            <Field label="Minimum context window" htmlFor="pol-context" hint="How much a model can read at once.">
              <Select
                id="pol-context"
                value={String(draft.minContext)}
                disabled={locked}
                options={contextOptions}
                onChange={(e) => set("minContext", Number(e.target.value))}
              />
            </Field>
          </div>

          <div role="group" aria-labelledby="pol-caps" className="space-y-3">
            <p id="pol-caps" className="text-sm font-medium text-ink">
              Capabilities every model must have
            </p>
            <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
              {CAPABILITIES.map((c) => (
                <Checkbox
                  key={c.key}
                  checked={c.locked ? true : draft.capabilities.includes(c.key)}
                  disabled={locked || c.locked}
                  onChange={(on) => set("capabilities", toggle(draft.capabilities, c.key, on))}
                  label={c.label}
                  description={c.locked ? `${c.detail} Required by the floor.` : c.detail}
                />
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Switch
              label="Standard models may sort mail"
              description="On: frontier and standard models can sort mail. Off: frontier only. Reading requests, files and drawings, drafting and research are always frontier only."
              checked={draft.standardForSorting}
              disabled={locked}
              onChange={(v) => set("standardForSorting", v)}
            />
          </div>

          <div role="group" aria-labelledby="pol-providers" className="space-y-3">
            <p id="pol-providers" className="text-sm font-medium text-ink">
              Providers that may not be used
            </p>
            <div className="flex flex-wrap gap-x-6 gap-y-2.5">
              {PROVIDERS.map(([key, label]) => (
                <Checkbox
                  key={key}
                  checked={draft.blockedProviders.includes(key)}
                  disabled={locked}
                  label={`Block ${label}`}
                  onChange={(on) => set("blockedProviders", toggle(draft.blockedProviders, key, on))}
                />
              ))}
            </div>
          </div>

          <Field
            label="Models that may not be used"
            htmlFor="pol-patterns"
            hint="Names or patterns, for example gpt-4* or provider:model-name. Start with re: for a regular expression."
          >
            <TagInput
              id="pol-patterns"
              value={draft.blockedPatterns}
              disabled={locked}
              placeholder="gpt-4*"
              validate={(s) => (s.length > 1 ? null : "Enter a model name or pattern.")}
              onChange={(v) => set("blockedPatterns", v)}
            />
          </Field>

          <Disclosure title="Advanced: promote a model" summary={draft.promoted.length ? `${draft.promoted.length} promoted` : "None"}>
            <div className="space-y-3">
              <p className="text-sm text-ink-2">
                The only way to loosen a rule. A new standard-tier model the catalogue does not know yet can be treated as frontier after it passes the
                full exam with a score of at least {Math.round(FLOOR.promotionMinScore * 100)}%. Light and refused models can never be promoted.
              </p>
              <Field label="Promoted models" htmlFor="pol-promoted" hint="Write each as provider:model, for example openai:gpt-6.">
                <TagInput
                  id="pol-promoted"
                  value={draft.promoted}
                  disabled={locked}
                  placeholder="provider:model"
                  validate={(s) => (/^[a-z0-9_-]+:.+$/i.test(s) ? null : "Write it as provider:model, for example openai:gpt-6.")}
                  onChange={(v) => set("promoted", v)}
                />
              </Field>
            </div>
          </Disclosure>

          <Field label="Notes for admins" htmlFor="pol-notes" optional hint="Why these rules are set. Shown to anyone who can change them.">
            <Textarea id="pol-notes" rows={3} value={draft.notes} disabled={locked} onChange={(e) => set("notes", e.target.value)} />
          </Field>

          {applied.length ? (
            <Banner tone="review" title="Saved, with limits applied">
              <ul className="list-disc space-y-0.5 pl-5">
                {applied.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </Banner>
          ) : null}
          <InlineError error={put.error} />

          <div className="flex flex-col-reverse gap-2 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-end">
            {!canEdit ? <p className="text-sm text-ink-3 sm:mr-auto">{MANAGE_HINT}</p> : null}
            <Button
              variant="secondary"
              disabled={!dirty || locked}
              onClick={() => {
                setDraft(base);
                setErrors({});
              }}
              className="w-full sm:w-auto"
            >
              Discard changes
            </Button>
            <Button type="submit" loading={put.isPending} disabled={!dirty || !canEdit} className="w-full sm:w-auto">
              Save quality rules
            </Button>
          </div>
        </PanelBody>
      </form>
    </Panel>
  );
}
