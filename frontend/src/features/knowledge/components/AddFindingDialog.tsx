import { useId, useState, type FormEvent } from "react";
import { Button, Dialog, Field, InlineError, Input, Select, Textarea, toast } from "@/ui";
import { useAddKnowledge, useKnowledge } from "../api";
import { KIND_LABELS, LANGUAGE_OPTIONS, REGION_KEYS, regionLabel } from "../model";
import { TagInput } from "./TagInput";

const HINT: Record<string, string> = {
  service_family: "A line of work you quote, for example the equipment you supply and install.",
  work_type: "How you do the work, for example supply and installation or annual maintenance.",
  term: "A word customers use for something you do, in any language.",
  standard: "A standard your quotations refer to, for example EN 1808.",
  convention: "How your documents usually do something, for example payment terms.",
};

/**
 * Add a finding yourself. It is confirmed from the start (you are the owner stating it) and keeps a source line
 * saying who added it.
 */
export function AddFindingDialog({ kind, open, onOpenChange }: { kind: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const uid = useId();
  const add = useAddKnowledge();
  const existing = useKnowledge().data?.items ?? [];
  const [label, setLabel] = useState("");
  const [labelAr, setLabelAr] = useState("");
  const [description, setDescription] = useState("");
  const [aliases, setAliases] = useState<string[]>([]);
  const [region, setRegion] = useState("");
  const [language, setLanguage] = useState("");
  const [valueText, setValueText] = useState("");
  const [problem, setProblem] = useState<string | undefined>();
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const info = KIND_LABELS[kind] ?? KIND_LABELS.term;
  const wording = kind === "service_family" || kind === "work_type" || kind === "term";

  const reset = () => {
    setLabel("");
    setLabelAr("");
    setDescription("");
    setAliases([]);
    setRegion("");
    setLanguage("");
    setValueText("");
    setProblem(undefined);
    setFailure(null);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    const name = label.trim();
    if (!name) return setProblem("Enter a name.");
    if (existing.some((i) => i.kind === kind && i.label.trim().toLowerCase() === name.toLowerCase())) {
      return setProblem(`“${name}” is already in the list. Edit that one instead.`);
    }
    setProblem(undefined);
    setFailure(null);
    setBusy(true);
    try {
      await add.mutateAsync({
        kind,
        label: name,
        label_ar: labelAr.trim() || undefined,
        description: description.trim() || undefined,
        synonyms: aliases.length ? aliases : undefined,
        region: kind === "term" ? region || null : undefined,
        language: kind === "term" ? language || null : undefined,
        value: kind === "convention" && valueText.trim() ? valueText.trim() : undefined,
      });
      toast.success(`Added: ${name}`, { description: "Confirmed by you. You can edit it at any time." });
      onOpenChange(false);
      reset();
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (busy) return;
        onOpenChange(o);
        if (!o) reset();
      }}
      title={info.add}
      description={HINT[kind]}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={`${uid}-form`} loading={busy}>
            {info.add}
          </Button>
        </>
      }
    >
      <form id={`${uid}-form`} onSubmit={submit} noValidate className="space-y-5">
        <Field label={kind === "standard" ? "Standard code" : "Name"} htmlFor={`${uid}-label`} required error={problem}>
          <Input
            id={`${uid}-label`}
            value={label}
            invalid={!!problem}
            autoFocus
            dir="auto"
            autoComplete="off"
            placeholder={kind === "standard" ? "EN 1808" : undefined}
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>
        {wording ? (
          <Field label="Arabic name" htmlFor={`${uid}-ar`} optional>
            <Input id={`${uid}-ar`} value={labelAr} dir="rtl" lang="ar" onChange={(e) => setLabelAr(e.target.value)} />
          </Field>
        ) : null}
        {kind === "term" ? (
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Region" htmlFor={`${uid}-region`}>
              <Select
                id={`${uid}-region`}
                value={region}
                options={[{ value: "", label: "Any region" }, ...REGION_KEYS.map((k) => ({ value: k, label: regionLabel(k) }))]}
                onChange={(e) => setRegion(e.target.value)}
              />
            </Field>
            <Field label="Language" htmlFor={`${uid}-language`}>
              <Select id={`${uid}-language`} value={language} options={[{ value: "", label: "Any language" }, ...LANGUAGE_OPTIONS]} onChange={(e) => setLanguage(e.target.value)} />
            </Field>
          </div>
        ) : null}
        {wording ? (
          <Field label="Aliases (other names)" htmlFor={`${uid}-aliases`} optional hint="Press Enter after each.">
            <TagInput id={`${uid}-aliases`} value={aliases} placeholder="Add an alias" onChange={setAliases} />
          </Field>
        ) : null}
        <Field label={kind === "standard" ? "Title" : "Description"} htmlFor={`${uid}-description`} optional>
          <Textarea id={`${uid}-description`} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {kind === "convention" ? (
          <Field label="Value" htmlFor={`${uid}-value`} optional hint="How your documents usually do this.">
            <Textarea id={`${uid}-value`} rows={3} value={valueText} onChange={(e) => setValueText(e.target.value)} />
          </Field>
        ) : null}
        <InlineError error={failure} />
      </form>
    </Dialog>
  );
}
