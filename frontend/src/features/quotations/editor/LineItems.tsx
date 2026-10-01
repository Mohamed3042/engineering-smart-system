import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Copy,
  EllipsisVertical,
  History,
  ListPlus,
  PackageCheck,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { ScopeItem } from "@/api/types";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { Button, Chip, Count, EmptyState, IconButton, Input, Menu, Panel, PanelHeader, Select, Switch, type MenuItem } from "@/ui";
import type { PriceHint, TemplateInfo } from "../api";
import { EvidenceButton } from "../components";
import { lineEvidence, lineTotal, money, parseAmount, totals } from "../lib";
import { AmountInput, AutoTextarea } from "./inputs";
import { lineKey, type DraftLine } from "./useDraft";

export const UNIT_SUGGESTIONS = ["No.", "Nos", "Set", "Lot", "Each", "Unit", "m", "m²", "Day", "Week", "Month", "Visit", "Lump sum"];

export interface LineLayout {
  hasPriceUnit: boolean;
  hasTotal: boolean;
  /** Annual maintenance: price columns print only when a line carries a price. */
  pricesOptional: boolean;
  priceUnits: string[];
  defaultPriceUnit: string;
}

export function lineLayout(template: TemplateInfo | undefined, language: string): LineLayout {
  const copy = template?.copy[language] ?? template?.copy.en;
  const cols = new Set((copy?.columns ?? []).map((c) => c.key));
  const pricesOptional = Boolean(copy) && !cols.has("unit_price");
  return {
    hasPriceUnit: cols.has("price_unit"),
    hasTotal: cols.has("total") || pricesOptional || !copy,
    pricesOptional,
    priceUnits: copy?.price_units ?? [],
    defaultPriceUnit: copy?.default_price_unit ?? "",
  };
}

export function emptyLine(partial: Partial<DraftLine> = {}): DraftLine {
  return { description: "", spec: null, qty: null, unit: "", unit_price: null, total: null, ...partial, _k: lineKey() };
}

const priceOf = (l: DraftLine) => parseAmount(l.unit_price);

function PriceGuidance({ hint }: { hint?: PriceHint }) {
  if (!hint) return null;
  return (
    <p className="mt-1 flex items-start gap-1 text-xs text-ink-3">
      <History className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>
        <span className="font-medium text-ink-2">Old price, dated — guidance only.</span> {hint.text}
      </span>
    </p>
  );
}

interface Props {
  lines: DraftLine[];
  onChange: (lines: DraftLine[]) => void;
  currency: string;
  digits: number;
  layout: LineLayout;
  scope?: ScopeItem[];
  readOnly?: boolean;
  priceHints: Map<string, PriceHint>;
  onCatalogue: () => void;
  onReuse: () => void;
  showTotal: boolean;
  canToggleTotal: boolean;
  onShowTotal: (v: boolean) => void;
  title?: string;
  description?: string;
}

export function LineItems({
  lines,
  onChange,
  currency,
  digits,
  layout,
  scope,
  readOnly,
  priceHints,
  onCatalogue,
  onReuse,
  showTotal,
  canToggleTotal,
  onShowTotal,
  title = "Line items",
  description = "AI never writes prices. Each price is entered by a person.",
}: Props) {
  const t = totals(lines);
  const set = (i: number, patch: Partial<DraftLine>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const move = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= lines.length) return;
    const next = [...lines];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const remove = (i: number) => onChange(lines.filter((_, j) => j !== i));
  const duplicate = (i: number) => {
    const next = [...lines];
    next.splice(i + 1, 0, { ...lines[i], _k: lineKey(), unit_price: null, total: null, no: null });
    onChange(next);
  };
  const add = () => onChange([...lines, emptyLine({ price_unit: layout.hasPriceUnit ? null : undefined })]);

  const menuFor = (l: DraftLine, i: number): MenuItem[] => [
    { label: "Move up", icon: <ArrowUp />, onSelect: () => move(i, -1), disabled: i === 0 },
    { label: "Move down", icon: <ArrowDown />, onSelect: () => move(i, 1), disabled: i === lines.length - 1 },
    {
      label: l.optional ? "Make it a standard line" : "Mark as optional",
      icon: <Sparkles />,
      onSelect: () => set(i, { optional: !l.optional, included: false }),
      separatorBefore: true,
    },
    {
      label: l.included ? "Needs its own price" : "Mark as included",
      icon: <PackageCheck />,
      onSelect: () => set(i, { included: !l.included, optional: false, unit_price: l.included ? l.unit_price : null }),
    },
    { label: "Duplicate (without price)", icon: <Copy />, onSelect: () => duplicate(i) },
    { label: "Remove line", icon: <Trash2 />, onSelect: () => remove(i), danger: true, separatorBefore: true },
  ];

  const missing = t.missing;
  const flags = (l: DraftLine) => (
    <>
      {l.optional ? (
        <Chip size="sm" tone="neutral">
          Optional
        </Chip>
      ) : null}
      {l.included ? (
        <Chip size="sm" tone="brand">
          Included
        </Chip>
      ) : null}
      {l.catalog_id ? (
        <Chip size="sm" tone="muted" icon={<BookOpen aria-hidden />}>
          Catalogue
        </Chip>
      ) : null}
    </>
  );
  const needsPrice = (l: DraftLine) => !readOnly && !l.included && priceOf(l) === null;
  const priceCls = (l: DraftLine) => (needsPrice(l) && !layout.pricesOptional ? "border-review-line bg-review-soft/40" : "");

  const priceUnitOptions = layout.priceUnits.map((u) => ({ value: u, label: u }));

  const actions = readOnly ? null : (
    <>
      <Button variant="secondary" size="sm" icon={<BookOpen />} onClick={onCatalogue}>
        From catalogue
      </Button>
      <Button variant="secondary" size="sm" icon={<ListPlus />} onClick={onReuse}>
        Reuse lines
      </Button>
      <Button size="sm" icon={<Plus />} onClick={add}>
        Add line
      </Button>
    </>
  );

  return (
    <Panel>
      <PanelHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {title}
            {missing > 0 && !layout.pricesOptional ? (
              <Chip tone="review" size="sm">
                {missing} {missing === 1 ? "needs" : "need"} a price
              </Chip>
            ) : null}
          </span>
        }
        description={description}
        actions={actions}
      />
      <datalist id="quote-units">
        {UNIT_SUGGESTIONS.map((u) => (
          <option key={u} value={u} />
        ))}
      </datalist>

      {lines.length === 0 ? (
        <EmptyState
          compact
          icon={<ListPlus />}
          title="No lines yet"
          action={
            readOnly ? null : (
              <>
                <Button icon={<Plus />} onClick={add}>
                  Add line
                </Button>
                <Button variant="secondary" icon={<BookOpen />} onClick={onCatalogue}>
                  From catalogue
                </Button>
              </>
            )
          }
        >
          Add the items the customer asked for, insert them from the company catalogue, or reuse the lines of a recent
          quotation. Prices always start empty.
        </EmptyState>
      ) : (
        <>
          {/* Wide screens: table */}
          <div className="hidden xl:block">
            <table className="w-full border-collapse text-left text-base">
              <thead className="bg-sunken text-sm text-ink-2">
                <tr>
                  <th scope="col" className="w-12 py-3 pl-5 pr-2 font-medium">
                    No.
                  </th>
                  <th scope="col" className="px-2 py-3 font-medium">
                    Description
                  </th>
                  <th scope="col" className="w-40 px-2 py-3 font-medium">
                    Source
                  </th>
                  <th scope="col" className="w-24 px-2 py-3 text-right font-medium">
                    Qty
                  </th>
                  <th scope="col" className="w-28 px-2 py-3 font-medium">
                    Unit
                  </th>
                  <th scope="col" className="w-40 px-2 py-3 text-right font-medium">
                    {layout.pricesOptional ? `Unit price (${currency}, optional)` : `Unit price (${currency})`}
                  </th>
                  {layout.hasTotal ? (
                    <th scope="col" className="w-36 px-2 py-3 text-right font-medium">
                      Total ({currency})
                    </th>
                  ) : null}
                  <th scope="col" className="w-12 py-3 pl-2 pr-4">
                    <span className="sr-only">Line actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {lines.map((l, i) => {
                  const total = lineTotal(l);
                  const hint = l.catalog_id ? priceHints.get(String(l.catalog_id)) : undefined;
                  return (
                    <tr key={l._k} id={`line-${i + 1}`} className={cn("align-top", l.optional && "bg-canvas")}>
                      <td className="py-3 pl-5 pr-2 pt-5 text-sm text-ink-3 tabular">{typeof l.no === "string" && !/^\d+$/.test(l.no) ? l.no : i + 1}</td>
                      <td className="px-2 py-3">
                        {readOnly ? (
                          <div className="px-2 py-1.5">
                            <p className="whitespace-pre-line text-ink">{l.description || "—"}</p>
                            {l.spec ? <p className="mt-0.5 whitespace-pre-line text-sm text-ink-3">{l.spec}</p> : null}
                          </div>
                        ) : (
                          <>
                            <AutoTextarea
                              quiet
                              aria-label={`Description, line ${i + 1}`}
                              placeholder="Describe the item or work"
                              value={l.description ?? ""}
                              onChange={(e) => set(i, { description: e.target.value })}
                              className="font-medium"
                            />
                            <AutoTextarea
                              quiet
                              aria-label={`Specification, line ${i + 1}`}
                              placeholder="Specification (optional)"
                              value={l.spec ?? ""}
                              onChange={(e) => set(i, { spec: e.target.value || null })}
                              className="text-sm text-ink-2"
                            />
                          </>
                        )}
                        <div className="mt-1 flex flex-wrap gap-1.5 px-2 empty:hidden">{flags(l)}</div>
                      </td>
                      <td className="px-2 py-3 pt-5">
                        <EvidenceButton evidence={lineEvidence(l, scope)} />
                      </td>
                      <td className="px-2 py-3">
                        {readOnly ? (
                          <p className="px-3 py-2 text-right tabular">{l.qty ?? "—"}</p>
                        ) : (
                          <AmountInput
                            aria-label={`Quantity, line ${i + 1}`}
                            value={parseAmount(l.qty)}
                            onChange={(v) => set(i, { qty: v })}
                          />
                        )}
                      </td>
                      <td className="px-2 py-3">
                        {readOnly ? (
                          <p className="px-3 py-2">{l.unit || "—"}</p>
                        ) : (
                          <Input
                            aria-label={`Unit, line ${i + 1}`}
                            list="quote-units"
                            value={l.unit ?? ""}
                            onChange={(e) => set(i, { unit: e.target.value })}
                          />
                        )}
                      </td>
                      <td className="px-2 py-3">
                        {readOnly ? (
                          <p className="px-3 py-2 text-right tabular">
                            {l.included ? "Included" : priceOf(l) !== null ? money(priceOf(l), currency, false) : "—"}
                          </p>
                        ) : l.included ? (
                          <p className="px-3 py-2 text-right text-sm text-ink-2">Included</p>
                        ) : (
                          <AmountInput
                            aria-label={`Unit price in ${currency}, line ${i + 1}`}
                            placeholder="Enter price"
                            digits={digits}
                            value={priceOf(l)}
                            onChange={(v) => set(i, { unit_price: v })}
                            className={priceCls(l)}
                          />
                        )}
                        {layout.hasPriceUnit && !l.included ? (
                          readOnly ? (
                            <p className="px-3 text-right text-xs text-ink-3">per {l.price_unit || layout.defaultPriceUnit}</p>
                          ) : (
                            <Select
                              aria-label={`Price unit, line ${i + 1}`}
                              className="mt-1.5 [&_select]:h-8 [&_select]:text-sm"
                              value={l.price_unit ?? ""}
                              onChange={(e) => set(i, { price_unit: e.target.value || null })}
                              placeholder={`per ${layout.defaultPriceUnit || "unit"} (default)`}
                              options={priceUnitOptions}
                            />
                          )
                        ) : null}
                        <PriceGuidance hint={hint} />
                      </td>
                      {layout.hasTotal ? (
                        <td className="px-2 py-3 pt-5 text-right tabular">
                          {l.included ? (
                            <span className="text-sm text-ink-3">Included</span>
                          ) : total !== null ? (
                            <span className={cn("font-medium", l.optional ? "text-ink-3" : "text-ink")}>{money(total, currency, false)}</span>
                          ) : (
                            <span className="text-ink-3">—</span>
                          )}
                        </td>
                      ) : null}
                      <td className="py-3 pl-2 pr-4 pt-4">
                        {readOnly ? null : (
                          <Menu
                            items={menuFor(l, i)}
                            trigger={
                              <IconButton label={`Actions for line ${i + 1}`} size="sm" tooltip={false}>
                                <EllipsisVertical />
                              </IconButton>
                            }
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Narrow screens: one card per line */}
          <ol className="divide-y divide-line xl:hidden">
            {lines.map((l, i) => {
              const total = lineTotal(l);
              const hint = l.catalog_id ? priceHints.get(String(l.catalog_id)) : undefined;
              return (
                <li key={l._k} id={`line-m-${i + 1}`} className={cn("px-4 py-4 sm:px-5", l.optional && "bg-canvas")}>
                  <div className="flex items-start gap-2">
                    <span className="mt-2 w-6 shrink-0 text-sm font-medium text-ink-3 tabular">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      {readOnly ? (
                        <>
                          <p className="whitespace-pre-line font-medium text-ink">{l.description || "—"}</p>
                          {l.spec ? <p className="mt-0.5 whitespace-pre-line text-sm text-ink-3">{l.spec}</p> : null}
                        </>
                      ) : (
                        <>
                          <AutoTextarea
                            quiet
                            aria-label={`Description, line ${i + 1}`}
                            placeholder="Describe the item or work"
                            value={l.description ?? ""}
                            onChange={(e) => set(i, { description: e.target.value })}
                            className="-ml-2 font-medium"
                          />
                          <AutoTextarea
                            quiet
                            aria-label={`Specification, line ${i + 1}`}
                            placeholder="Specification (optional)"
                            value={l.spec ?? ""}
                            onChange={(e) => set(i, { spec: e.target.value || null })}
                            className="-ml-2 text-sm text-ink-2"
                          />
                        </>
                      )}
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <EvidenceButton evidence={lineEvidence(l, scope)} />
                        {flags(l)}
                      </div>
                    </div>
                    {readOnly ? null : (
                      <Menu
                        items={menuFor(l, i)}
                        trigger={
                          <IconButton label={`Actions for line ${i + 1}`} size="sm" tooltip={false}>
                            <EllipsisVertical />
                          </IconButton>
                        }
                      />
                    )}
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-3 pl-8 sm:grid-cols-4">
                    <label className="block min-w-0">
                      <span className="mb-1 block text-xs text-ink-3">Quantity</span>
                      {readOnly ? (
                        <span className="block tabular">{l.qty ?? "—"}</span>
                      ) : (
                        <AmountInput
                          aria-label={`Quantity, line ${i + 1}`}
                          value={parseAmount(l.qty)}
                          onChange={(v) => set(i, { qty: v })}
                        />
                      )}
                    </label>
                    <label className="block min-w-0">
                      <span className="mb-1 block text-xs text-ink-3">Unit</span>
                      {readOnly ? (
                        <span className="block">{l.unit || "—"}</span>
                      ) : (
                        <Input aria-label={`Unit, line ${i + 1}`} list="quote-units" value={l.unit ?? ""} onChange={(e) => set(i, { unit: e.target.value })} />
                      )}
                    </label>
                    <label className="block min-w-0">
                      <span className="mb-1 block text-xs text-ink-3">Unit price ({currency})</span>
                      {l.included ? (
                        <span className="block py-2 text-sm text-ink-2">Included</span>
                      ) : readOnly ? (
                        <span className="block tabular">
                          {priceOf(l) !== null ? money(priceOf(l), currency, false) : "—"}
                        </span>
                      ) : (
                        <AmountInput
                          aria-label={`Unit price in ${currency}, line ${i + 1}`}
                          placeholder="Enter price"
                          digits={digits}
                          value={priceOf(l)}
                          onChange={(v) => set(i, { unit_price: v })}
                          className={priceCls(l)}
                        />
                      )}
                    </label>
                    {layout.hasTotal ? (
                      <div className="min-w-0">
                        <span className="mb-1 block text-xs text-ink-3">Total ({currency})</span>
                        <span className={cn("block py-2 text-right font-semibold tabular sm:text-left", l.optional ? "text-ink-3" : "text-ink")}>
                          {l.included ? "Included" : total !== null ? money(total, currency, false) : "—"}
                        </span>
                      </div>
                    ) : null}
                    {layout.hasPriceUnit && !l.included ? (
                      <label className="col-span-2 block min-w-0">
                        <span className="mb-1 block text-xs text-ink-3">Price unit</span>
                        {readOnly ? (
                          <span className="block">{l.price_unit || layout.defaultPriceUnit}</span>
                        ) : (
                          <Select
                            aria-label={`Price unit, line ${i + 1}`}
                            value={l.price_unit ?? ""}
                            onChange={(e) => set(i, { price_unit: e.target.value || null })}
                            placeholder={`per ${layout.defaultPriceUnit || "unit"} (default)`}
                            options={priceUnitOptions}
                          />
                        )}
                      </label>
                    ) : null}
                  </div>
                  <div className="pl-8">
                    <PriceGuidance hint={hint} />
                  </div>
                </li>
              );
            })}
          </ol>

          {/* Totals */}
          <div className="space-y-2 border-t border-line bg-sunken/60 px-4 py-4 sm:px-5">
            {layout.hasTotal ? (
              <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                <span className="text-base font-semibold text-ink">Total ({currency})</span>
                <span className="text-xl font-bold text-ink tabular">
                  {t.total !== null ? money(t.total, currency, false) : t.counted === 0 ? "—" : "Not complete"}
                </span>
              </div>
            ) : null}
            {t.total === null && t.missing > 0 && layout.hasTotal ? (
              <p className="text-sm text-review">
                {formatNumber(t.missing)} of {formatNumber(t.counted)} priced {t.counted === 1 ? "line has" : "lines have"} no price yet. The PDF
                prints no total until every line is priced.
              </p>
            ) : null}
            {t.optionalCount > 0 ? (
              <div className="space-y-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 text-sm">
                  <span className="text-ink-2">
                    Optional lines, not in the total <Count value={t.optionalCount} />
                  </span>
                  <span className="text-ink-2 tabular">{t.optionalTotal !== null ? money(t.optionalTotal, currency, false) : "—"}</span>
                </div>
                <p className="text-sm text-review">
                  The PDF still prints optional lines as normal lines and adds them to its total. Check the PDF before you
                  submit.
                </p>
              </div>
            ) : null}
            {canToggleTotal && !readOnly ? (
              <Switch
                checked={showTotal}
                onChange={onShowTotal}
                label="Print the total on the PDF"
                description="Turn off for rates or when the customer asked for unit prices only."
                className="pt-1"
              />
            ) : null}
          </div>
        </>
      )}
    </Panel>
  );
}
