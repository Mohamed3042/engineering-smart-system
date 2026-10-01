import { Plus, X } from "lucide-react";
import { forwardRef, useEffect, useRef, useState, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { isRtl } from "@/lib/format";
import { Button, IconButton, Input } from "@/ui";
import { parseAmount } from "../lib";

function show(value: number | null | undefined, digits: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "";
  if (digits === null) return String(value);
  return value.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/**
 * Number field that only ever commits a number or null. While focused it shows the plain number;
 * otherwise it is grouped ("12,500.000"). Empty stays empty: nothing is filled in for the person.
 */
export function AmountInput({
  value,
  onChange,
  digits = null,
  className,
  invalidHint = "Enter a number",
  ...rest
}: {
  value: number | null | undefined;
  onChange: (v: number | null) => void;
  /** Decimals when not focused; null shows the number as typed. */
  digits?: number | null;
  invalidHint?: string;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
}) {
  const [text, setText] = useState(() => show(value ?? null, digits));
  const [invalid, setInvalid] = useState(false);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setText(show(value ?? null, digits));
      setInvalid(false);
    }
  }, [value, digits]);
  return (
    <Input
      {...rest}
      inputMode="decimal"
      autoComplete="off"
      value={text}
      invalid={invalid}
      title={invalid ? invalidHint : undefined}
      className={cn("text-right tabular", className)}
      onFocus={() => {
        focused.current = true;
        setText(value === null || value === undefined ? "" : String(value));
      }}
      onChange={(e) => {
        const t = e.target.value;
        setText(t);
        if (t.trim() === "") {
          setInvalid(false);
          onChange(null);
          return;
        }
        const n = parseAmount(t);
        setInvalid(n === null);
        if (n !== null) onChange(n);
      }}
      onBlur={() => {
        focused.current = false;
        setInvalid(false);
        setText(show(value ?? null, digits));
      }}
    />
  );
}

/** Textarea that grows with its content (Chromium `field-sizing`), Arabic-aware. */
export const AutoTextarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { quiet?: boolean }>(
  function AutoTextarea({ className, quiet, value, rows = 1, ...rest }, ref) {
    const text = typeof value === "string" ? value : "";
    return (
      <textarea
        ref={ref}
        rows={rows}
        value={value}
        dir={isRtl(text) ? "rtl" : "auto"}
        className={cn(
          "block w-full resize-none rounded-md text-base text-ink placeholder:text-ink-3 [field-sizing:content]",
          "transition-[border-color,box-shadow,background-color] duration-150 focus:outline-none",
          quiet
            ? "border border-transparent bg-transparent px-2 py-1.5 hover:border-line-strong focus:border-brand focus:bg-surface focus:ring-2 focus:ring-brand/20"
            : "border border-line-strong bg-surface px-3 py-2 hover:border-ink-3 focus:border-brand focus:ring-2 focus:ring-brand/20",
          "disabled:cursor-not-allowed disabled:border-transparent disabled:bg-transparent disabled:text-ink",
          className,
        )}
        {...rest}
      />
    );
  },
);

/** Editable list of short lines (exclusions, clarifications). */
export function ListEditor({
  items,
  onChange,
  addLabel,
  placeholder,
  disabled,
  itemLabel,
  removeLabel = "Remove",
  empty,
  rtl,
}: {
  items: string[];
  onChange: (items: string[]) => void;
  addLabel: string;
  placeholder?: string;
  disabled?: boolean;
  itemLabel: (i: number) => string;
  removeLabel?: string;
  empty?: string;
  /** Arabic quotation: right to left. */
  rtl?: boolean;
}) {
  const dir = rtl ? "rtl" : undefined;
  const [adding, setAdding] = useState("");
  const add = () => {
    const t = adding.trim();
    if (!t) return;
    onChange([...items, t]);
    setAdding("");
  };
  return (
    <div className="space-y-2">
      {items.length === 0 && empty ? <p className="text-sm text-ink-3">{empty}</p> : null}
      <ul className="space-y-2">
        {items.map((it, i) => (
          <li key={i} className="flex items-start gap-2">
            <span aria-hidden className="mt-3 size-1.5 shrink-0 rounded-full bg-ink-3" />
            <AutoTextarea
              aria-label={itemLabel(i)}
              value={it}
              dir={dir}
              disabled={disabled}
              onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))}
              className="min-h-10 py-2"
            />
            {!disabled ? (
              <IconButton label={`${removeLabel}: ${it.slice(0, 40) || itemLabel(i)}`} size="sm" className="mt-1" onClick={() => onChange(items.filter((_, j) => j !== i))}>
                <X />
              </IconButton>
            ) : null}
          </li>
        ))}
      </ul>
      {!disabled ? (
        <div className="flex gap-2">
          <Input
            value={adding}
            dir={dir}
            placeholder={placeholder}
            aria-label={addLabel}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
          <Button variant="secondary" icon={<Plus />} onClick={add} disabled={!adding.trim()} className="shrink-0">
            Add
          </Button>
        </div>
      ) : null}
    </div>
  );
}
