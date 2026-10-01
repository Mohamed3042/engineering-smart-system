import { CalendarDays, ChevronDown } from "lucide-react";
import { useState } from "react";
import { formatDateShort } from "@/lib/format";
import { Button } from "./Button";
import { DateInput, Field } from "./Form";
import { Popover } from "./Overlay";

export interface DateRangeValue {
  from: string; // YYYY-MM-DD or ""
  to: string;
}

function iso(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function monthsBack(n: number): DateRangeValue {
  const to = new Date();
  const from = new Date(to.getFullYear(), to.getMonth() - n, to.getDate());
  return { from: iso(from), to: iso(to) };
}

export const DATE_PRESETS: { label: string; range: () => DateRangeValue }[] = [
  { label: "Last 30 days", range: () => ({ from: iso(new Date(Date.now() - 30 * 86_400_000)), to: iso(new Date()) }) },
  { label: "Last 2 months", range: () => monthsBack(2) },
  { label: "Last 6 months", range: () => monthsBack(6) },
  { label: "Last 12 months", range: () => monthsBack(12) },
  { label: "All time", range: () => ({ from: "", to: "" }) },
];

export function formatRange(v: DateRangeValue): string {
  if (!v.from && !v.to) return "All time";
  return `${v.from ? formatDateShort(v.from) : "Start"} – ${v.to ? formatDateShort(v.to) : "Today"}`;
}

/** Date-range button with presets and two date fields. */
export function DateRangePicker({ value, onChange, className }: { value: DateRangeValue; onChange: (v: DateRangeValue) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setDraft(value);
      }}
      align="end"
      className="w-[min(22rem,calc(100vw-2rem))]"
      trigger={
        <Button variant="secondary" className={className} icon={<CalendarDays />} iconRight={<ChevronDown className="text-ink-3" />}>
          <span className="tabular">{formatRange(value)}</span>
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {DATE_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setDraft(p.range())}
              className="h-8 rounded-full border border-line-strong px-3 text-sm text-ink-2 hover:border-ink-3 hover:text-ink"
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From">
            <DateInput value={draft.from} max={draft.to || undefined} onChange={(from) => setDraft({ ...draft, from })} />
          </Field>
          <Field label="To">
            <DateInput value={draft.to} min={draft.from || undefined} onChange={(to) => setDraft({ ...draft, to })} />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => {
              onChange(draft);
              setOpen(false);
            }}
          >
            Apply
          </Button>
        </div>
      </div>
    </Popover>
  );
}
