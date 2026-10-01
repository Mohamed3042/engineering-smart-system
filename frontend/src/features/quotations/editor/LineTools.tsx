/**
 * Ways to add lines without typing them: the company catalogue (description, specification and unit;
 * the dated last-known price is shown as guidance and never copied) and the lines of an earlier
 * quotation (quantity and price stay empty: they belong to that other tender).
 */
import { ArrowLeft, BookOpen, History, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatDate, isRtl } from "@/lib/format";
import { Button, Checkbox, Dialog, EmptyState, LoadingRows, QueryState, SearchInput } from "@/ui";
import { ALL_STATUSES, useCatalog, useQuotations, type CatalogItem, type Line, type Quote } from "../api";
import { QuoteStatusChip } from "../components";
import { revisionLabel } from "../lib";

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function CatalogDialog({
  open,
  onOpenChange,
  language,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  language: string;
  onAdd: (item: CatalogItem) => void;
}) {
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim(), 250);
  const catalog = useCatalog(term, { language, limit: 30, enabled: open });
  useEffect(() => {
    if (open) setQ("");
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Add from the catalogue"
      description="Fills the description, specification and unit. The price stays empty; the last known price shows as dated guidance only."
      footer={
        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          Done
        </Button>
      }
    >
      <SearchInput value={q} onChange={setQ} placeholder="Search products in English or Arabic" label="Search the catalogue" autoFocus />
      <div className="mt-4">
        <QueryState
          query={catalog}
          loading={<LoadingRows rows={4} />}
          isEmpty={(d) => d.items.length === 0}
          empty={
            term ? (
              <EmptyState compact title="Nothing matches">
                Try another product name, or add the line by hand.
              </EmptyState>
            ) : (
              <EmptyState compact icon={<BookOpen />} title="No catalogue installed">
                The company catalogue is private data. Put its JSON file in the private folder (catalog/) to search products
                here.
              </EmptyState>
            )
          }
        >
          {(d) => (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {d.items.map((it) => (
                <li key={it.product_id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start">
                  <div className="min-w-0 flex-1">
                    <p dir={isRtl(it.description) ? "rtl" : "auto"} className="font-medium text-ink">
                      {it.description}
                    </p>
                    {it.spec ? (
                      <p dir={isRtl(it.spec) ? "rtl" : "auto"} className="mt-0.5 line-clamp-2 text-sm text-ink-3">
                        {it.spec}
                      </p>
                    ) : null}
                    <p className="mt-1 text-sm text-ink-2">
                      Unit: {it.unit}
                      {it.price_unit ? ` · priced per ${it.price_unit}` : ""}
                    </p>
                    {it.price_hint ? (
                      <p className="mt-1 flex items-start gap-1 text-xs text-ink-3">
                        <History className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                        <span dir={isRtl(it.price_hint.text) ? "rtl" : "auto"}>{it.price_hint.text}</span>
                      </p>
                    ) : (
                      <p className="mt-1 text-xs text-ink-3">No earlier price on record.</p>
                    )}
                  </div>
                  <Button variant="secondary" size="sm" icon={<Plus />} onClick={() => onAdd(it)} className="max-sm:w-full">
                    Add line
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      </div>
    </Dialog>
  );
}

export function ReuseDialog({
  open,
  onOpenChange,
  current,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  current: Quote;
  onAdd: (lines: Partial<Line>[]) => void;
}) {
  const list = useQuotations({ status: ALL_STATUSES }, open);
  const [search, setSearch] = useState("");
  const [pickId, setPickId] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(() => new Set());
  useEffect(() => {
    if (open) {
      setSearch("");
      setPickId(null);
      setChosen(new Set());
    }
  }, [open]);

  const candidates = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const same = (x: { project_id: string }) => Number(x.project_id === current.project_id);
    return (list.data?.items ?? [])
      .filter((x) => x.id !== current.id && (x.data.items?.length ?? 0) > 0)
      .filter((x) => !needle || [x.reference, x.project?.name, x.customer?.name].filter(Boolean).join(" ").toLowerCase().includes(needle))
      .sort((a, b) => same(b) - same(a) || b.updated_at.localeCompare(a.updated_at))
      .slice(0, 40);
  }, [list.data, search, current.id, current.project_id]);
  const picked = list.data?.items.find((x) => x.id === pickId);
  const lines = picked?.data.items ?? [];

  const add = () => {
    onAdd(
      lines
        .filter((_, i) => chosen.has(i))
        .map((l) => ({ description: l.description, spec: l.spec ?? null, unit: l.unit ?? "", price_unit: l.price_unit, catalog_id: l.catalog_id })),
    );
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Reuse lines from another quotation"
      description="Copies the description, specification and unit. Quantity and price stay empty: they belong to that other tender."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={add} disabled={chosen.size === 0}>
            {chosen.size ? `Add ${chosen.size} ${chosen.size === 1 ? "line" : "lines"}` : "Choose lines"}
          </Button>
        </>
      }
    >
      {!picked ? (
        <div className="space-y-4">
          <SearchInput value={search} onChange={setSearch} placeholder="Search reference, project or customer" label="Search quotations" />
          <QueryState
            query={list}
            loading={<LoadingRows rows={4} />}
            isEmpty={() => candidates.length === 0}
            empty={
              <EmptyState compact title={search ? "Nothing matches" : "No other quotation has lines yet"}>
                {search ? "Try another reference, project or customer." : "Lines of earlier quotations appear here to copy into this one."}
              </EmptyState>
            }
          >
            {() => (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {candidates.map((x) => (
                  <li key={x.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setPickId(x.id);
                        setChosen(new Set());
                      }}
                      className="flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-canvas sm:flex-row sm:items-center sm:gap-4"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium text-ink tabular">{revisionLabel(x)}</span>
                        <span className="block text-sm text-ink-3">
                          {[x.project?.name, x.customer?.name, x.project_id === current.project_id ? "Same project" : null]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-3 text-sm text-ink-2">
                        {x.data.items?.length} lines · {formatDate(x.updated_at)}
                        <QuoteStatusChip q={x} size="sm" />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </QueryState>
        </div>
      ) : (
        <div className="space-y-3">
          <Button variant="link" icon={<ArrowLeft />} onClick={() => setPickId(null)}>
            Other quotations
          </Button>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold text-ink tabular">{revisionLabel(picked)}</p>
            <Checkbox
              checked={chosen.size === 0 ? false : chosen.size === lines.length ? true : "indeterminate"}
              onChange={(v) => setChosen(v ? new Set(lines.map((_, i) => i)) : new Set())}
              label="Select all"
            />
          </div>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {lines.map((l, i) => (
              <li key={i} className="px-4 py-3">
                <Checkbox
                  checked={chosen.has(i)}
                  onChange={(v) => {
                    const next = new Set(chosen);
                    if (v) next.add(i);
                    else next.delete(i);
                    setChosen(next);
                  }}
                  label={<span dir={isRtl(l.description) ? "rtl" : "auto"}>{l.description || "No description"}</span>}
                  description={[l.spec, l.unit ? `Unit: ${l.unit}` : null].filter(Boolean).join(" · ") || undefined}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </Dialog>
  );
}
