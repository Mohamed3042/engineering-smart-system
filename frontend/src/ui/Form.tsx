/**
 * Form controls. Every control has a visible label (Field) or an aria-label.
 * Errors are text, not only colour.
 */
import { Check, ChevronDown, Search, X } from "lucide-react";
import { Checkbox as C, RadioGroup as R, Switch as S } from "radix-ui";
import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/cn";

const control =
  "w-full rounded-md border border-line-strong bg-surface text-ink placeholder:text-ink-3 transition-[border-color,box-shadow] duration-150 " +
  "hover:border-ink-3 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20 " +
  "disabled:cursor-not-allowed disabled:bg-sunken disabled:text-ink-3 aria-[invalid=true]:border-block";

export function Field({
  label,
  hint,
  error,
  required,
  children,
  className,
  htmlFor,
  optional,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  optional?: boolean;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-ink">
        {label}
        {required ? <span className="text-block"> *</span> : null}
        {optional ? <span className="font-normal text-ink-3"> (optional)</span> : null}
      </label>
      {children}
      {error ? (
        <p className="text-sm text-block" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-sm text-ink-3">{hint}</p>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function Input({ className, invalid, ...rest }, ref) {
    return <input ref={ref} aria-invalid={invalid || undefined} className={cn(control, "h-10 px-3 text-base", className)} {...rest} />;
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(
  function Textarea({ className, invalid, rows = 4, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        rows={rows}
        aria-invalid={invalid || undefined}
        className={cn(control, "min-h-20 px-3 py-2 text-base leading-relaxed", className)}
        {...rest}
      />
    );
  },
);

export interface Option {
  value: string;
  label: string;
  disabled?: boolean;
}

/** Native select (best on phones), styled. */
export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement> & { options: Option[]; placeholder?: string; invalid?: boolean }
>(function Select({ options, placeholder, className, invalid, ...rest }, ref) {
  return (
    <div className={cn("relative", className)}>
      <select
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(control, "h-10 appearance-none pl-3 pr-9 text-base")}
        {...rest}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
    </div>
  );
});

export function SearchInput({
  value,
  onChange,
  placeholder = "Search",
  className,
  label = "Search",
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  label?: string;
  autoFocus?: boolean;
}) {
  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
      <input
        type="search"
        aria-label={label}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(control, "h-10 pl-9 pr-9 text-base [&::-webkit-search-cancel-button]:hidden")}
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange("")}
          className="absolute right-1.5 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded text-ink-3 hover:bg-hover hover:text-ink"
        >
          <X className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  description,
  disabled,
  id,
  className,
}: {
  checked: boolean | "indeterminate";
  onChange: (v: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
}) {
  const auto = useId();
  const cid = id ?? auto;
  const box = (
    <C.Root
      id={cid}
      checked={checked}
      disabled={disabled}
      onCheckedChange={(v) => onChange(v === true)}
      aria-label={typeof label === "string" ? undefined : "Select"}
      className={cn(
        "grid size-5 shrink-0 place-items-center rounded border border-line-strong bg-surface transition-colors",
        "data-[state=checked]:border-brand data-[state=checked]:bg-brand data-[state=indeterminate]:border-brand data-[state=indeterminate]:bg-brand",
        "disabled:opacity-50 hover:border-ink-3",
      )}
    >
      <C.Indicator>
        {checked === "indeterminate" ? (
          <span className="block h-0.5 w-2.5 rounded bg-white" />
        ) : (
          <Check className="size-3.5 text-white" strokeWidth={3} aria-hidden />
        )}
      </C.Indicator>
    </C.Root>
  );
  if (!label) return box;
  return (
    <div className={cn("flex items-start gap-3", className)}>
      <span className="mt-0.5">{box}</span>
      <label htmlFor={cid} className="min-w-0 cursor-pointer select-none">
        <span className="block text-base text-ink">{label}</span>
        {description ? <span className="block text-sm text-ink-3">{description}</span> : null}
      </label>
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  const sw = (
    <S.Root
      id={id}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onChange}
      aria-label={typeof label === "string" ? label : undefined}
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-full bg-line-strong transition-colors duration-150",
        "data-[state=checked]:bg-brand disabled:opacity-50",
      )}
    >
      <S.Thumb className="block size-5 translate-x-0.5 rounded-full bg-white shadow transition-transform duration-150 data-[state=checked]:translate-x-[22px]" />
    </S.Root>
  );
  if (!label) return sw;
  return (
    <div className={cn("flex items-start justify-between gap-4", className)}>
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <span className="block text-base text-ink">{label}</span>
        {description ? <span className="block text-sm text-ink-3">{description}</span> : null}
      </label>
      <span className="mt-0.5">{sw}</span>
    </div>
  );
}

export interface ChoiceOption {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  badge?: ReactNode;
}

/** Large option cards (engine method, research depth, template). */
export function ChoiceCards({
  value,
  onChange,
  options,
  columns = 2,
  label,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  options: ChoiceOption[];
  columns?: 1 | 2 | 3;
  label: string;
  className?: string;
}) {
  return (
    <R.Root
      value={value}
      onValueChange={onChange}
      aria-label={label}
      className={cn(
        "grid gap-3",
        columns === 3 ? "sm:grid-cols-3" : columns === 2 ? "sm:grid-cols-2" : "grid-cols-1",
        className,
      )}
    >
      {options.map((o) => (
        <R.Item
          key={o.value}
          value={o.value}
          disabled={o.disabled}
          className={cn(
            "group relative flex w-full items-start gap-3 rounded-xl border border-line-strong bg-surface p-4 text-left transition-[border-color,background-color,box-shadow]",
            "hover:border-ink-3 data-[state=checked]:border-brand data-[state=checked]:bg-brand-soft/50 data-[state=checked]:ring-1 data-[state=checked]:ring-brand",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {o.icon ? <span className="mt-0.5 text-brand-ink [&_svg]:size-6">{o.icon}</span> : null}
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2 font-semibold text-ink">
              {o.label}
              {o.badge}
            </span>
            {o.description ? <span className="mt-1 block text-sm text-ink-2">{o.description}</span> : null}
          </span>
          <span
            aria-hidden
            className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border border-line-strong group-data-[state=checked]:border-brand group-data-[state=checked]:bg-brand"
          >
            <span className="size-2 rounded-full bg-white opacity-0 group-data-[state=checked]:opacity-100" />
          </span>
        </R.Item>
      ))}
    </R.Root>
  );
}

/** Native date input, styled. Value is "YYYY-MM-DD". */
export function DateInput({
  value,
  onChange,
  min,
  max,
  className,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> & { value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="date"
      value={value}
      min={min}
      max={max}
      onChange={(e) => onChange(e.target.value)}
      className={cn(control, "h-10 px-3 text-base tabular", className)}
      {...rest}
    />
  );
}
