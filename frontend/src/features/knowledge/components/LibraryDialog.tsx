/**
 * Reference libraries shipped with the app: regional vocabulary (Gulf, UK and Europe, North America, Russia and
 * CIS, South Asia, in English, Arabic and Russian) and common standards. Picking from them adds a finding you
 * state yourself, so nothing from a library becomes a finding without a click.
 */
import { Check, Plus } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useCategoryLabel } from "@/api/session";
import { Button, Chip, Dialog, EmptyState, ErrorState, LoadingRows, SearchInput, Segmented, toast, toastError } from "@/ui";
import { useAddKnowledge, useKnowledge, useRegions, useStandardsLibrary, useUpdateKnowledge, type RegionTerm } from "../api";
import { languageLabel, regionLabel } from "../model";

const PAGE = 12;

function Shell({
  open,
  onOpenChange,
  title,
  description,
  filters,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: string;
  filters: ReactNode;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description={description} size="xl">
      <div className="space-y-4">
        {filters}
        {children}
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ terms */

export function TermLibraryDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const library = useRegions();
  const add = useAddKnowledge();
  const items = useKnowledge().data?.items ?? [];
  const [q, setQ] = useState("");
  const [region, setRegion] = useState("all");
  const [language, setLanguage] = useState("all");
  const [limit, setLimit] = useState(PAGE);

  const have = useMemo(() => new Set(items.filter((i) => i.kind === "term").map((i) => `${i.label.trim().toLowerCase()}|${i.region ?? ""}`)), [items]);
  const needle = q.trim().toLowerCase();

  // ponytail: filters the whole shipped library (about 45 concepts) in the browser; index it if the library grows into the thousands.
  const concepts = useMemo(() => {
    return (library.data?.concepts ?? [])
      .map((c) => ({
        ...c,
        terms: c.terms.filter(
          (t) =>
            (region === "all" || t.region === region) &&
            (language === "all" || t.language === language) &&
            (!needle || t.term.toLowerCase().includes(needle) || c.canonical.toLowerCase().includes(needle)),
        ),
      }))
      .filter((c) => c.terms.length > 0);
  }, [library.data, region, language, needle]);

  const addTerm = (t: RegionTerm) =>
    add.mutate(
      { kind: "term", label: t.term, language: t.language, region: t.region },
      {
        onSuccess: () => toast.success(`Added: ${t.term}`, { description: `${languageLabel(t.language)} · ${regionLabel(t.region)}. Confirmed by you.` }),
        onError: (err) => toastError(err, "The term could not be added"),
      },
    );

  const regions = library.data?.regions ?? [];
  return (
    <Shell
      open={open}
      onOpenChange={onOpenChange}
      title="Regional vocabulary"
      description="How the same equipment is named in different regions and languages. Choose the words your customers use."
      filters={
        <div className="space-y-3">
          <SearchInput value={q} onChange={(v) => { setQ(v); setLimit(PAGE); }} placeholder="Search a word" label="Search the vocabulary" className="sm:max-w-sm" />
          <Segmented
            label="Region"
            value={region}
            onChange={(v) => { setRegion(v); setLimit(PAGE); }}
            options={[{ value: "all", label: "All regions" }, ...regions.map((r) => ({ value: r.key, label: r.label })), { value: "global", label: "Everywhere" }]}
          />
          <Segmented
            label="Language"
            value={language}
            onChange={(v) => { setLanguage(v); setLimit(PAGE); }}
            options={[{ value: "all", label: "Any language" }, { value: "en", label: "English" }, { value: "ar", label: "Arabic" }, { value: "ru", label: "Russian" }]}
          />
        </div>
      }
    >
      {library.isLoading ? (
        <LoadingRows rows={4} />
      ) : library.isError ? (
        <ErrorState error={library.error} onRetry={() => library.refetch()} compact />
      ) : concepts.length === 0 ? (
        <EmptyState compact title="Nothing matches">
          Try another word, region or language.
        </EmptyState>
      ) : (
        <>
          <ul className="divide-y divide-line">
            {concepts.slice(0, limit).map((c) => (
              <li key={c.key} className="py-3">
                <p className="font-medium text-ink">{c.canonical}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {c.terms.map((t) => {
                    const added = have.has(`${t.term.trim().toLowerCase()}|${t.region}`);
                    return (
                      <button
                        key={`${t.term}|${t.region}|${t.language}`}
                        type="button"
                        disabled={added || add.isPending}
                        onClick={() => addTerm(t)}
                        aria-label={added ? `${t.term} is already added` : `Add ${t.term}, ${languageLabel(t.language)}, ${regionLabel(t.region)}`}
                        className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-2.5 py-1 text-sm text-ink hover:bg-hover disabled:cursor-default disabled:bg-sunken disabled:text-ink-3"
                      >
                        {added ? <Check className="size-3.5 text-brand" aria-hidden /> : <Plus className="size-3.5 text-ink-3" aria-hidden />}
                        <span dir="auto">{t.term}</span>
                        <span className="text-xs text-ink-3">
                          {t.language.toUpperCase()} · {regionLabel(t.region)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </li>
            ))}
          </ul>
          {concepts.length > limit ? (
            <Button variant="secondary" onClick={() => setLimit((n) => n + PAGE)}>
              Show more ({concepts.length - limit} left)
            </Button>
          ) : null}
        </>
      )}
    </Shell>
  );
}

/* ------------------------------------------------------------------ standards */

export function StandardLibraryDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const library = useStandardsLibrary(open);
  const regions = useRegions();
  const add = useAddKnowledge();
  const update = useUpdateKnowledge();
  const categoryLabel = useCategoryLabel();
  const items = useKnowledge().data?.items ?? [];
  const [q, setQ] = useState("");
  const [region, setRegion] = useState("all");
  const [limit, setLimit] = useState(PAGE);
  const [adding, setAdding] = useState<string | null>(null);

  const have = useMemo(() => new Set(items.filter((i) => i.kind === "standard").map((i) => i.label.trim().toLowerCase())), [items]);
  const needle = q.trim().toLowerCase();
  const rows = useMemo(
    () =>
      (library.data?.standards ?? []).filter(
        (s) =>
          (region === "all" || s.region.includes(region)) &&
          (!needle || s.code.toLowerCase().includes(needle) || s.title.toLowerCase().includes(needle)),
      ),
    [library.data, region, needle],
  );

  async function addStandard(code: string, title: string, appliesTo: string[]) {
    setAdding(code);
    try {
      const item = await add.mutateAsync({ kind: "standard", label: code, description: title });
      if (appliesTo.length) await update.mutateAsync({ id: item.id, patch: { value: { applies_to: appliesTo } } });
      toast.success(`Added: ${code}`, { description: "Confirmed by you." });
    } catch (err) {
      toastError(err, "The standard could not be added");
    } finally {
      setAdding(null);
    }
  }

  return (
    <Shell
      open={open}
      onOpenChange={onOpenChange}
      title="Standards library"
      description="Standards often named in tenders and specifications. Add the ones your quotations refer to."
      filters={
        <div className="space-y-3">
          <SearchInput value={q} onChange={(v) => { setQ(v); setLimit(PAGE); }} placeholder="Search a code or title" label="Search the standards" className="sm:max-w-sm" />
          <Segmented
            label="Region"
            value={region}
            onChange={(v) => { setRegion(v); setLimit(PAGE); }}
            options={[{ value: "all", label: "All regions" }, ...(regions.data?.regions ?? []).map((r) => ({ value: r.key, label: r.label })), { value: "global", label: "Everywhere" }]}
          />
        </div>
      }
    >
      {library.isLoading ? (
        <LoadingRows rows={4} />
      ) : library.isError ? (
        <ErrorState error={library.error} onRetry={() => library.refetch()} compact />
      ) : rows.length === 0 ? (
        <EmptyState compact title="No standard matches">
          Try another code, title or region.
        </EmptyState>
      ) : (
        <>
          <ul className="divide-y divide-line">
            {rows.slice(0, limit).map((s) => {
              const added = have.has(s.code.trim().toLowerCase());
              return (
                <li key={s.code} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:gap-4">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-ink">{s.code}</p>
                    <p className="text-sm text-ink-2">{s.title}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {s.region.map((r) => (
                        <Chip key={r} size="sm" tone="neutral">
                          {regionLabel(r)}
                        </Chip>
                      ))}
                      {s.applies_to.map((a) => (
                        <Chip key={a} size="sm" tone="muted">
                          {categoryLabel(a)}
                        </Chip>
                      ))}
                    </div>
                    {s.notes ? <p className="mt-1.5 text-sm text-ink-3">{s.notes}</p> : null}
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={added ? <Check /> : <Plus />}
                    disabled={added || adding !== null}
                    loading={adding === s.code}
                    onClick={() => void addStandard(s.code, s.title, s.applies_to)}
                    className="w-full sm:w-auto"
                  >
                    {added ? "Added" : "Add"}
                  </Button>
                </li>
              );
            })}
          </ul>
          {rows.length > limit ? (
            <Button variant="secondary" onClick={() => setLimit((n) => n + PAGE)}>
              Show more ({rows.length - limit} left)
            </Button>
          ) : null}
        </>
      )}
    </Shell>
  );
}
