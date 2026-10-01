import { X } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn";
import { isRtl } from "@/lib/format";

/**
 * Words as removable chips (aliases, domains, hosts, labels). Enter or comma adds, Backspace on an
 * empty field removes the last chip, pasting a list adds every entry.
 */
export function TagInput({
  value,
  onChange,
  placeholder = "Type and press Enter",
  id,
  label,
  normalize = (s) => s.trim(),
  validate,
  disabled,
  className,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  id?: string;
  /** Accessible name when no <Field> label points at `id`. */
  label?: string;
  normalize?: (s: string) => string;
  /** Return an error message to refuse an entry. */
  validate?: (s: string) => string | null;
  disabled?: boolean;
  className?: string;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = (raw: string) => {
    const parts = raw
      .split(/[,\n;]+/)
      .map(normalize)
      .filter(Boolean);
    if (parts.length === 0) return;
    const next = [...value];
    for (const p of parts) {
      const problem = validate?.(p) ?? null;
      if (problem) {
        setError(problem);
        return;
      }
      if (!next.some((x) => x.toLowerCase() === p.toLowerCase())) next.push(p);
    }
    setError(null);
    onChange(next);
    setDraft("");
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      if (draft.trim()) {
        e.preventDefault();
        add(draft);
      } else if (e.key === ",") e.preventDefault();
    } else if (e.key === "Backspace" && !draft && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div className={className}>
      <div
        className={cn(
          "flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-md border border-line-strong bg-surface px-2 py-1.5 transition-[border-color,box-shadow] duration-150",
          "focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/20 hover:border-ink-3",
          disabled && "pointer-events-none bg-sunken opacity-70",
          error && "border-block",
        )}
      >
        {value.map((t) => (
          <span
            key={t}
            dir={isRtl(t) ? "rtl" : "auto"}
            className="inline-flex max-w-full items-center gap-1 rounded-md bg-hover py-0.5 pl-2 pr-0.5 text-sm text-ink"
          >
            <span className="truncate">{t}</span>
            <button
              type="button"
              aria-label={`Remove ${t}`}
              onClick={() => onChange(value.filter((x) => x !== t))}
              className="grid size-6 shrink-0 place-items-center rounded text-ink-3 hover:bg-line hover:text-ink"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </span>
        ))}
        <input
          id={id}
          aria-label={label}
          aria-invalid={error ? true : undefined}
          value={draft}
          disabled={disabled}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={onKey}
          onBlur={() => draft.trim() && add(draft)}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text");
            if (/[,\n;]/.test(text)) {
              e.preventDefault();
              add(draft + text);
            }
          }}
          placeholder={value.length ? "" : placeholder}
          dir="auto"
          className="h-7 min-w-[8rem] flex-1 bg-transparent px-1 text-base text-ink outline-none placeholder:text-ink-3"
        />
      </div>
      {error ? (
        <p role="alert" className="mt-1.5 text-sm text-block">
          {error}
        </p>
      ) : null}
    </div>
  );
}
