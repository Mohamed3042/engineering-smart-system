/**
 * More inbox filters: Mail intent, Work type and "Not linked to a project". The quick filter sits in
 * the toolbar. Intent and work type live in a drawer (a bottom sheet on phones) with the same toggle
 * chips as the category filter, and whatever is chosen shows as a removable chip beside the button.
 * InboxPage keeps all of it in the URL.
 */
import { SlidersHorizontal, X } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { pluralize } from "@/lib/format";
import { intentInfo, workTypeLabel } from "@/lib/labels";
import { Button, Count, Drawer, FilterChips, Switch } from "@/ui";
import { INTENT_FILTERS, WORK_TYPES } from "./labels";

export interface ExtraFilters {
  /** Mail intents (what the message is for). */
  intent: string[];
  /** Work types of the project a message is filed under. */
  workType: string[];
  /** Mail that is not filed under a project. */
  unlinked: boolean;
}

/** The known choices first, then any value that came in from the address and is not in the list. */
function options(known: readonly string[], selected: string[], label: (k: string) => string) {
  return [...known, ...selected.filter((s) => !known.includes(s))].map((k) => ({ value: k, label: label(k) }));
}

const intentLabel = (k: string) => intentInfo(k).label;

/** "Addendum, Reminder +1": a chip stays one line however much is chosen. */
function summary(values: string[], label: (k: string) => string) {
  const names = values.map(label);
  return names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ");
}

function ActiveChip({ what, text, onRemove }: { what: string; text: string; onRemove: () => void }) {
  return (
    <button
      type="button"
      onClick={onRemove}
      aria-label={`Remove filter ${what}: ${text}`}
      className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border border-brand bg-brand-soft px-3 text-sm text-brand-ink transition-colors hover:bg-brand-soft/60"
    >
      <span className="truncate">
        {what}: {text}
      </span>
      <X className="size-3.5 shrink-0" aria-hidden />
    </button>
  );
}

export function MoreFilters({
  value,
  onChange,
  total,
  className,
}: {
  value: ExtraFilters;
  onChange: (patch: Partial<ExtraFilters>) => void;
  /** Messages the current filters match, for the button at the bottom of the drawer. */
  total?: number;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const chosen = value.intent.length + value.workType.length + (value.unlinked ? 1 : 0);

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <FilterChips
        label="Quick filters"
        value={value.unlinked ? ["unlinked"] : []}
        onChange={(v) => onChange({ unlinked: v.includes("unlinked") })}
        options={[{ value: "unlinked", label: "Not linked to a project" }]}
      />
      <Drawer
        open={open}
        onOpenChange={setOpen}
        title="Filter mail"
        description="These add to the search, the group and the category you chose."
        trigger={
          <Button variant="secondary" size="sm" icon={<SlidersHorizontal />}>
            Filters
            {value.intent.length + value.workType.length > 0 ? <Count value={value.intent.length + value.workType.length} tone="brand" /> : null}
          </Button>
        }
        footer={
          <>
            <Button variant="ghost" disabled={chosen === 0} onClick={() => onChange({ intent: [], workType: [], unlinked: false })}>
              Clear filters
            </Button>
            <Button className="flex-1" onClick={() => setOpen(false)}>
              {total === undefined ? "Show messages" : `Show ${pluralize(total, "message")}`}
            </Button>
          </>
        }
      >
        <div className="space-y-7">
          <section aria-labelledby="filter-intent" className="space-y-3">
            <div>
              <h3 id="filter-intent" className="text-base font-semibold text-ink">
                Mail intent
              </h3>
              <p className="text-sm text-ink-3">What the message is for. It is separate from the service family. Choose one or more.</p>
            </div>
            <FilterChips
              label="Mail intent"
              value={value.intent}
              onChange={(v) => onChange({ intent: v })}
              options={options(INTENT_FILTERS, value.intent, intentLabel)}
            />
          </section>
          <section aria-labelledby="filter-work" className="space-y-3">
            <div>
              <h3 id="filter-work" className="text-base font-semibold text-ink">
                Work type
              </h3>
              <p className="text-sm text-ink-3">The work type of the project a message is filed under. Mail with no project has none.</p>
            </div>
            {value.unlinked ? (
              <p className="rounded-lg border border-line bg-sunken px-3.5 py-2.5 text-sm text-ink-2">
                Not available together with “Not linked to a project”, because unlinked mail has no work type.
              </p>
            ) : (
              <FilterChips
                label="Work type"
                value={value.workType}
                onChange={(v) => onChange({ workType: v })}
                options={options(WORK_TYPES, value.workType, workTypeLabel)}
              />
            )}
          </section>
          <section>
            <Switch
              label="Only mail not linked to a project"
              description="Mail nobody has filed under a project yet. Open a message to file it."
              checked={value.unlinked}
              onChange={(v) => onChange({ unlinked: v })}
            />
          </section>
        </div>
      </Drawer>
      {value.intent.length ? (
        <ActiveChip what="Mail intent" text={summary(value.intent, intentLabel)} onRemove={() => onChange({ intent: [] })} />
      ) : null}
      {value.workType.length ? (
        <ActiveChip what="Work type" text={summary(value.workType, workTypeLabel)} onRemove={() => onChange({ workType: [] })} />
      ) : null}
    </div>
  );
}
