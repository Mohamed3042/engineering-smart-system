import { Lock } from "lucide-react";
import { useState } from "react";
import { useCategories } from "@/api/session";
import type { KnowledgeItem } from "@/api/types";
import { Banner, Button, Checkbox, Dialog, Field, FilterChips, InlineError, Input, Select, Textarea, toast } from "@/ui";
import { useUpdateKnowledge, type KnowledgePatch } from "../api";
import {
  kindLabel,
  LANGUAGE_OPTIONS,
  mappedCategory,
  mergeSynonyms,
  originalOf,
  REGION_KEYS,
  regionLabel,
  SORTING_KINDS,
  synonymsOf,
  valueRecord,
} from "../model";
import { EvidenceDetails } from "./SourceEvidence";
import { TagInput } from "./TagInput";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function valueToText(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}

/** Text back to a value: plain text stays text; a structured value must still be valid JSON. */
function textToValue(text: string, previous: unknown): { value: unknown } | { error: string } {
  const t = text.trim();
  if (previous !== null && typeof previous === "object") {
    try {
      return { value: JSON.parse(t) };
    } catch {
      return { error: "This value is structured data. Write it as valid JSON, or restore the original." };
    }
  }
  return { value: t };
}

function EditorDialog({ item, canEdit, onClose }: { item: KnowledgeItem; canEdit: boolean; onClose: () => void }) {
  const update = useUpdateKnowledge();
  const categories = useCategories();
  const original = originalOf(item);
  const sorts = SORTING_KINDS.has(item.kind);
  const isTerm = item.kind === "term";
  const wording = item.kind === "service_family" || item.kind === "work_type" || isTerm;
  const record = valueRecord(item);
  const workCategories = (categories.data ?? []).filter((c) => c.group === "work");

  const [label, setLabel] = useState(item.label);
  const [labelAr, setLabelAr] = useState(item.label_ar ?? "");
  const [description, setDescription] = useState(item.description ?? "");
  const [aliases, setAliases] = useState(synonymsOf(item));
  const [region, setRegion] = useState(item.region ?? "");
  const [language, setLanguage] = useState(item.language ?? "");
  const [category, setCategory] = useState(mappedCategory(item) ?? "");
  const [appliesTo, setAppliesTo] = useState<string[]>(Array.isArray(record.applies_to) ? (record.applies_to as string[]) : []);
  const [valueText, setValueText] = useState(valueToText(item.value));
  const [apply, setApply] = useState(item.apply_to_classification);
  const [problem, setProblem] = useState<{ label?: string; value?: string }>({});

  const confirmed = item.status === "owner_confirmed";
  const locked = !canEdit || update.isPending;

  const regionOptions = [
    { value: "", label: "Any region" },
    ...[...new Set([...REGION_KEYS, ...(item.region ? [item.region] : [])])].map((k) => ({ value: k, label: regionLabel(k) })),
  ];
  const languageOptions = [
    { value: "", label: "Any language" },
    ...LANGUAGE_OPTIONS,
    ...(item.language && !LANGUAGE_OPTIONS.some((l) => l.value === item.language) ? [{ value: item.language, label: item.language.toUpperCase() }] : []),
  ];

  function buildPatch(): KnowledgePatch | { error: { label?: string; value?: string } } {
    if (!label.trim()) return { error: { label: "Enter a name." } };
    const patch: KnowledgePatch = {};
    if (label.trim() !== item.label) patch.label = label.trim();
    if (wording && labelAr.trim() !== (item.label_ar ?? "")) patch.label_ar = labelAr.trim();
    if (description.trim() !== (item.description ?? "")) patch.description = description.trim();
    if (wording && !same(aliases, synonymsOf(item))) patch.synonyms = mergeSynonyms(item.synonyms, aliases);
    if (isTerm && region !== (item.region ?? "")) patch.region = region || null;
    if (isTerm && language !== (item.language ?? "")) patch.language = language || null;
    if (sorts && category !== (mappedCategory(item) ?? "")) {
      const next = { ...record };
      if (category) next.category = category;
      else delete next.category;
      patch.value = next;
    }
    if (item.kind === "standard" && !same(appliesTo, Array.isArray(record.applies_to) ? record.applies_to : [])) {
      patch.value = { ...record, applies_to: appliesTo };
    }
    if (item.kind === "convention" && valueText.trim() !== valueToText(item.value).trim()) {
      const parsed = textToValue(valueText, item.value);
      if ("error" in parsed) return { error: { value: parsed.error } };
      patch.value = parsed.value;
    }
    if (sorts && confirmed && apply !== item.apply_to_classification) patch.apply_to_classification = apply;
    return patch;
  }

  function save(andConfirm: boolean) {
    const built = buildPatch();
    if ("error" in built) {
      setProblem(built.error);
      return;
    }
    setProblem({});
    const patch: KnowledgePatch = andConfirm ? { ...built, status: "owner_confirmed" } : built;
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    update.mutate(
      { id: item.id, patch },
      {
        onSuccess: () => {
          toast.success(andConfirm ? `Saved and confirmed: ${label.trim()}` : "Changes saved");
          onClose();
        },
      },
    );
  }

  const footer = (
    <>
      <Button variant="secondary" onClick={onClose} disabled={update.isPending}>
        Cancel
      </Button>
      {item.status === "suggested" ? (
        <>
          <Button variant="secondary" disabled={locked} onClick={() => save(false)}>
            Save changes
          </Button>
          <Button loading={update.isPending} disabled={!canEdit} onClick={() => save(true)}>
            Save and confirm
          </Button>
        </>
      ) : (
        <Button loading={update.isPending} disabled={!canEdit} onClick={() => save(false)}>
          Save changes
        </Button>
      )}
    </>
  );

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !update.isPending && onClose()}
      title={`Edit ${kindLabel(item.kind).toLowerCase()}`}
      description="Your wording replaces the preferred name. The original wording and its sources stay visible."
      size="lg"
      footer={footer}
    >
      <div className="space-y-5">
        <Field
          label="Original wording (as found)"
          htmlFor="fe-original"
          hint="Kept with its sources, even after you rename it. Mail and files still say it this way."
        >
          <div className="relative">
            <Input id="fe-original" readOnly value={original?.label ?? item.label} dir="auto" className="bg-sunken pr-10" />
            <Lock className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
          </div>
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label={item.kind === "standard" ? "Standard code" : "Preferred name"} htmlFor="fe-label" required error={problem.label}>
            <Input id="fe-label" value={label} invalid={!!problem.label} disabled={locked} dir="auto" onChange={(e) => setLabel(e.target.value)} />
          </Field>
          {wording ? (
            <Field label="Arabic name" htmlFor="fe-ar" optional>
              <Input id="fe-ar" value={labelAr} dir="rtl" lang="ar" disabled={locked} onChange={(e) => setLabelAr(e.target.value)} />
            </Field>
          ) : null}
          {isTerm ? (
            <>
              <Field label="Region" htmlFor="fe-region" hint="Where people use this wording.">
                <Select id="fe-region" value={region} options={regionOptions} disabled={locked} onChange={(e) => setRegion(e.target.value)} />
              </Field>
              <Field label="Language" htmlFor="fe-language">
                <Select id="fe-language" value={language} options={languageOptions} disabled={locked} onChange={(e) => setLanguage(e.target.value)} />
              </Field>
            </>
          ) : null}
        </div>

        {wording ? (
          <Field label="Aliases (other names)" htmlFor="fe-aliases" hint="Other ways customers write it, in any language. Press Enter after each.">
            <TagInput id="fe-aliases" value={aliases} disabled={locked} placeholder="Add an alias" onChange={setAliases} />
          </Field>
        ) : null}

        <Field label={item.kind === "standard" ? "Title" : "Description"} htmlFor="fe-description" optional>
          <Textarea id="fe-description" rows={3} value={description} disabled={locked} onChange={(e) => setDescription(e.target.value)} />
        </Field>

        {sorts ? (
          <Field
            label="Mail category"
            htmlFor="fe-category"
            hint="The category this wording sorts mail into once it is used for sorting. Left empty, a category is created from its name."
          >
            <Select
              id="fe-category"
              value={category}
              disabled={locked}
              options={[
                { value: "", label: "A new category from its name" },
                ...workCategories.map((c) => ({ value: c.key, label: c.label })),
                ...(category && !workCategories.some((c) => c.key === category) ? [{ value: category, label: category }] : []),
              ]}
              onChange={(e) => setCategory(e.target.value)}
            />
          </Field>
        ) : null}

        {item.kind === "standard" ? (
          <div role="group" aria-labelledby="fe-applies" className="space-y-2">
            <p id="fe-applies" className="text-sm font-medium text-ink">
              Applies to
            </p>
            <FilterChips
              label="Service families this standard applies to"
              value={appliesTo}
              onChange={setAppliesTo}
              options={[
                ...workCategories.map((c) => ({ value: c.key, label: c.label })),
                ...appliesTo.filter((k) => !workCategories.some((c) => c.key === k)).map((k) => ({ value: k, label: k })),
              ]}
            />
          </div>
        ) : null}

        {item.kind === "convention" ? (
          <Field label="Value" htmlFor="fe-value" error={problem.value} hint="How your documents usually do this.">
            <Textarea
              id="fe-value"
              rows={4}
              value={valueText}
              invalid={!!problem.value}
              disabled={locked}
              className={typeof item.value === "object" && item.value !== null ? "font-mono text-sm" : undefined}
              onChange={(e) => setValueText(e.target.value)}
            />
          </Field>
        ) : null}

        <div className="space-y-2">
          <p className="text-sm font-medium text-ink">Supporting sources</p>
          <EvidenceDetails evidence={item.evidence} />
        </div>

        <div className="space-y-3 border-t border-line pt-5">
          {confirmed ? (
            <Banner tone="brand" title="Confirmed by owner">
              {sorts ? "You decide separately whether this wording sorts mail." : "This finding can be used for drafting and review."}
            </Banner>
          ) : item.status === "rejected" ? (
            <Banner tone="neutral" title="Rejected">
              It is not suggested again. Move it back to review from the list if you change your mind.
            </Banner>
          ) : (
            <Banner tone="review" title="Needs owner review">
              {sorts ? "This wording is not used to sort mail until it is confirmed." : "It stays a suggestion until the owner confirms it."}
            </Banner>
          )}
          {sorts ? (
            <Checkbox
              checked={apply}
              disabled={locked || !confirmed}
              onChange={setApply}
              label="Use for mail sorting"
              description={confirmed ? "Applies to new mail only, after the owner confirmed it." : "Available after the owner confirms this wording."}
            />
          ) : null}
        </div>
        <InlineError error={update.error} />
      </div>

    </Dialog>
  );
}

/** Edit a finding's wording. The original wording and its sources stay visible and are never overwritten. */
export function FindingEditor({ item, onClose, canEdit }: { item: KnowledgeItem | null; onClose: () => void; canEdit: boolean }) {
  return item ? <EditorDialog key={item.id} item={item} canEdit={canEdit} onClose={onClose} /> : null;
}
