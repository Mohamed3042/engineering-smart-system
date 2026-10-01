/**
 * Sections of the quotation editor.
 *
 * On desktop a section is the usual panel. Below the desktop layout (phones and tablets) it is a card
 * that opens and closes: one line of summary while it is closed, a flag when something needs a person,
 * and it starts open only when it holds a blocker. Jumping to a section (the chip row, the section
 * list, a checklist link) opens it first, then scrolls below the sticky bars.
 */
import { ChevronDown } from "lucide-react";
import { Collapsible } from "radix-ui";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Panel, PanelBody, PanelHeader } from "@/ui";
import type { JumpFocus } from "../lib";

/* ------------------------------------------------------------------ narrow screens */

/** Below the desktop layout (1024px) the editor is a single column of cards. */
const NARROW = "(max-width: 1023.98px)";

function subscribeNarrow(onChange: () => void) {
  const mq = window.matchMedia(NARROW);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** True below the desktop breakpoint. */
export function useNarrow(): boolean {
  return useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia(NARROW).matches,
    () => false,
  );
}

/* ------------------------------------------------------------------ jumping */

const OPEN_SECTION = "ess:quotation-open-section";

/** Asks a collapsed section to open. Sections that are not collapsed (or not on the page) ignore it. */
export function openSection(id: string) {
  window.dispatchEvent(new CustomEvent(OPEN_SECTION, { detail: id }));
}

/** The first visible, empty price or quantity field inside `root`. */
function emptyField(root: HTMLElement, kind: JumpFocus): HTMLInputElement | null {
  const prefix = kind === "price" ? "Unit price" : "Quantity";
  for (const field of root.querySelectorAll<HTMLInputElement>(`input[aria-label^="${prefix}"]`)) {
    // Two layouts are in the page (table and cards): only the visible one has an offsetParent.
    if (field.offsetParent !== null && !field.disabled && !field.value.trim()) return field;
  }
  return null;
}

/**
 * Opens a section, scrolls it below the sticky bars and moves focus into it: onto the first empty
 * price or quantity when asked, else onto the section itself so a screen reader announces it.
 */
export function jumpTo(id: string, opts: { focus?: JumpFocus; delay?: number } = {}) {
  openSection(id);
  window.setTimeout(() => {
    const el = document.getElementById(id);
    if (!el) return;
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const field = opts.focus ? emptyField(el, opts.focus) : null;
    const target = field ? (field.closest<HTMLElement>("li, tr") ?? field) : el;
    target.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
    (field ?? el).focus({ preventScroll: true });
  }, opts.delay ?? 60);
}

/* ------------------------------------------------------------------ section */

export interface EditorSectionProps {
  /** Anchor id: links such as #line-items and the jump helpers find the section by it. */
  id: string;
  title: ReactNode;
  /** A short note under the title (desktop header; inside the open card on narrow screens). */
  description?: ReactNode;
  /** One line shown under the title while the card is closed. */
  summary?: ReactNode;
  /** A chip or short note beside the title that says something needs a person. */
  flag?: ReactNode;
  /** Narrow screens: start open. Only sections that hold a blocker should. */
  defaultOpen?: boolean;
  /** "narrow" (default): collapsible below the desktop layout only. "always": collapsible everywhere. */
  collapsible?: "narrow" | "always";
  /** Header buttons on desktop; the first row inside the open card on narrow screens. */
  actions?: ReactNode;
  /** No padding around the content (lists and tables that run edge to edge). */
  flush?: boolean;
  className?: string;
  children: ReactNode;
}

export function EditorSection({
  id,
  title,
  description,
  summary,
  flag,
  defaultOpen = false,
  collapsible = "narrow",
  actions,
  flush,
  className,
  children,
}: EditorSectionProps) {
  const narrow = useNarrow();
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<string>).detail === id) setOpen(true);
    };
    window.addEventListener(OPEN_SECTION, on);
    return () => window.removeEventListener(OPEN_SECTION, on);
  }, [id]);

  const headingId = `${id}-title`;
  const frame = cn("scroll-mt-36 outline-none lg:scroll-mt-6", className);

  if (!narrow && collapsible === "narrow") {
    return (
      <section id={id} aria-labelledby={headingId} tabIndex={-1} className={frame}>
        <Panel as="div">
          <PanelHeader
            title={
              <span id={headingId} className="flex flex-wrap items-center gap-2">
                {title}
                {flag}
              </span>
            }
            description={description}
            actions={actions}
          />
          {flush ? children : <PanelBody>{children}</PanelBody>}
        </Panel>
      </section>
    );
  }

  const toolbar = description || actions;
  return (
    <section id={id} aria-labelledby={headingId} tabIndex={-1} className={frame}>
      <Collapsible.Root open={open} onOpenChange={setOpen} className="rounded-xl border border-line bg-surface shadow-panel">
        <h2>
          <Collapsible.Trigger className="group flex min-h-14 w-full items-start gap-3 rounded-xl px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand sm:px-5">
            <ChevronDown
              aria-hidden
              className="mt-0.5 size-5 shrink-0 text-ink-3 transition-transform duration-200 group-data-[state=closed]:-rotate-90"
            />
            <span className="min-w-0 flex-1">
              <span id={headingId} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base font-semibold text-ink">
                {title}
                {flag}
              </span>
              {!open && summary ? (
                <span className="mt-0.5 line-clamp-2 text-sm font-normal text-ink-3 [overflow-wrap:anywhere]">{summary}</span>
              ) : null}
            </span>
          </Collapsible.Trigger>
        </h2>
        <Collapsible.Content className="border-t border-line">
          {description ? <p className="px-4 pt-3 text-sm text-ink-3 sm:px-5">{description}</p> : null}
          {actions ? <div className="flex flex-wrap items-center gap-2 px-4 pt-3 sm:px-5">{actions}</div> : null}
          {flush ? (
            <div className={cn(toolbar && "mt-3 border-t border-line")}>{children}</div>
          ) : (
            <div className="px-4 py-4 sm:px-5">{children}</div>
          )}
        </Collapsible.Content>
      </Collapsible.Root>
    </section>
  );
}
