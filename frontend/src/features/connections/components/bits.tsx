import { ArrowLeft, Check, ChevronDown, Copy, Eye, EyeOff, Lock } from "lucide-react";
import { Collapsible } from "radix-ui";
import { forwardRef, useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "@/lib/cn";
import { Button, Input, toast } from "@/ui";

/* ------------------------------------------------------------------ secret input */

/** Password-style field for keys and passwords, with a show/hide toggle. */
export const SecretInput = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { invalid?: boolean; revealLabel?: string }
>(function SecretInput({ className, invalid, revealLabel = "key", ...rest }, ref) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input
        ref={ref}
        type={shown ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="off"
        invalid={invalid}
        className={cn("pr-11", shown && "font-mono text-sm", className)}
        {...rest}
      />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? `Hide ${revealLabel}` : `Show ${revealLabel}`}
        aria-pressed={shown}
        className="absolute right-1 top-1 grid size-8 place-items-center rounded-md text-ink-3 hover:bg-hover hover:text-ink"
      >
        {shown ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
      </button>
    </div>
  );
});

/** "Stored encrypted on this computer" note under a secret field. */
export function SecretNote({ children }: { children?: ReactNode }) {
  return (
    <span className="flex items-start gap-1.5">
      <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>{children ?? "Stored encrypted on this computer. It is never shown again."}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ copy */

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({ text, label, size = "sm" }: { text: string; label: string; size?: "sm" | "md" }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <Button
      size={size}
      variant="secondary"
      aria-label={`Copy ${label}`}
      icon={copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      onClick={async () => {
        const ok = await copyText(text);
        if (!ok) {
          toast.error("Could not copy", { description: "Select the text and copy it by hand." });
          return;
        }
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1800);
      }}
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

/** A value to paste somewhere else: monospace block with a copy button. */
export function CopyField({ value, label, multiline }: { value: string; label: string; multiline?: boolean }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-line bg-sunken py-2 pl-3 pr-2">
      <code
        className={cn(
          "min-w-0 flex-1 py-1.5 font-mono text-sm text-ink",
          multiline ? "overflow-x-auto whitespace-pre" : "break-all",
        )}
        aria-label={label}
      >
        {value}
      </code>
      <CopyButton text={value} label={label} />
    </div>
  );
}

/* ------------------------------------------------------------------ layout bits */

/** Phones only: the settings section list is hidden on sub-pages, so give a way back. */
export function SettingsBack() {
  return (
    <Link
      to="/settings"
      className="mb-3 inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-ink-3 hover:text-ink lg:hidden"
    >
      <ArrowLeft className="size-4" aria-hidden />
      Settings
    </Link>
  );
}

/** Wizard footer: back/skip on the left, the next step on the right (full width on phones). */
export function StepFooter({ back, skip, hint, primary }: { back?: ReactNode; skip?: ReactNode; hint?: ReactNode; primary: ReactNode }) {
  return (
    <div className="mt-8 flex flex-col gap-4 border-t border-line pt-6 sm:flex-row-reverse sm:items-center sm:justify-between">
      <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
        {hint ? <p className="text-sm text-ink-3 sm:mr-2 sm:text-right">{hint}</p> : null}
        {primary}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {back}
        {skip}
      </div>
    </div>
  );
}

/** True on desktop widths (≥1024px). */
export function useIsDesktop(): boolean {
  const query = "(min-width: 1024px)";
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

/** Small icon tile used in connection rows. */
export function IconTile({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "brand" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-10 shrink-0 place-items-center rounded-lg [&_svg]:size-5",
        tone === "brand" ? "bg-brand-soft text-brand-ink" : "bg-sunken text-ink-2",
      )}
    >
      {children}
    </span>
  );
}

/**
 * A heading that opens and closes its content, without a frame. Use it inside a panel or dialog, where the
 * framed CollapsibleSection would make a card inside a card.
 */
export function Disclosure({ title, summary, defaultOpen, children }: { title: ReactNode; summary?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <Collapsible.Root defaultOpen={defaultOpen}>
      <Collapsible.Trigger className="group flex min-h-10 w-full items-center gap-2 rounded-md py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand">
        <ChevronDown className="size-4 shrink-0 text-ink-3 transition-transform duration-200 group-data-[state=closed]:-rotate-90" aria-hidden />
        <span className="font-medium text-ink">{title}</span>
        {summary ? <span className="min-w-0 truncate text-sm font-normal text-ink-3">{summary}</span> : null}
      </Collapsible.Trigger>
      <Collapsible.Content className="pb-1 pl-6 pt-2">{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}
