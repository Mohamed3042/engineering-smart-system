/**
 * Phone editor chrome: a compact sticky bar (reference, status, the one next step, a section list) and
 * a chip row that jumps to the sections. Both read the same section list, so what needs a person is
 * marked the same way in both.
 */
import { ArrowLeft, ChevronDown, ChevronRight, Clock, EllipsisVertical } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "@/lib/cn";
import { Button, Chip, Count, Drawer, IconButton, Menu, type MenuItem } from "@/ui";
import type { Quote } from "../api";
import { QuoteStatusChip } from "../components";
import type { ApprovalFlow, NextStep } from "./ApprovalPanel";
import { jumpTo } from "./sections";

export interface NavSection {
  id: string;
  /** Short label for the chip. */
  chip: string;
  /** Name in the section list. */
  title: string;
  /** One line: where the section stands. */
  summary: ReactNode;
  /** Something here needs a person. */
  attention?: boolean;
  /** How many things need a person (shown on the chip). */
  badge?: number;
}

/** Height of the app's own phone header (workspace, search, bell): the bar sticks right under it. */
function useShellHeaderHeight(): number {
  const [height, setHeight] = useState(78);
  useLayoutEffect(() => {
    const el = document.getElementById("main")?.previousElementSibling;
    if (!(el instanceof HTMLElement)) return;
    const measure = () => setHeight(Math.round(el.getBoundingClientRect().height));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return height;
}

const STATE_TONE = { review: "text-review", brand: "text-brand-ink", muted: "text-ink-3" } as const;

function BarAction({ next }: { next: NextStep }) {
  const text = (
    <>
      <span className="sm:hidden">{next.short ?? next.label}</span>
      <span className="max-sm:hidden">{next.label}</span>
    </>
  );
  const cls = "shrink-0";
  if (next.to)
    return (
      <Button asChild className={cls}>
        <Link to={next.to}>{text}</Link>
      </Button>
    );
  return (
    <Button
      className={cls}
      loading={next.loading}
      onClick={() => (next.jump ? jumpTo(next.jump.id, { focus: next.jump.focus }) : next.run?.())}
    >
      {text}
    </Button>
  );
}

/** Sticky bar under the app header on phones and tablets. */
export function PhoneBar({
  q,
  flow,
  sections,
  menu,
}: {
  q: Pick<Quote, "reference" | "version" | "status">;
  flow: ApprovalFlow;
  sections: NavSection[];
  menu: MenuItem[];
}) {
  const top = useShellHeaderHeight();
  const [listOpen, setListOpen] = useState(false);
  return (
    <>
      <div
        className="sticky z-20 -mx-4 -mt-5 mb-4 border-b border-line bg-surface px-4 py-2 sm:-mx-6 sm:px-6 md:-mt-10 lg:hidden"
        style={{ top }}
      >
        <div className="flex items-center gap-1.5">
          {/* On the narrowest phones the room goes to the reference and the next step: "All quotations" is in the menu. */}
          <Link
            to="/quotations"
            aria-label="Back to the quotations"
            className="-ml-2 grid size-10 shrink-0 place-items-center rounded-md text-ink-2 hover:bg-hover hover:text-ink max-[380px]:hidden"
          >
            <ArrowLeft className="size-5" aria-hidden />
          </Link>
          <div className="min-w-0 flex-1">
            <button
              type="button"
              onClick={() => setListOpen(true)}
              aria-haspopup="dialog"
              aria-label={`${q.reference || "Draft"} v${q.version}. Jump to a section`}
              className="-mx-1 flex max-w-full items-center gap-1 rounded px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              <span className="truncate text-lg font-semibold leading-6 text-ink tabular">{q.reference || "Draft"}</span>
              <span className="shrink-0 font-medium text-ink-3 tabular">v{q.version}</span>
              <ChevronDown className="size-4 shrink-0 text-ink-3" aria-hidden />
            </button>
            <div className="flex flex-wrap items-center gap-x-2 text-sm">
              <span className="shrink-0">
                <QuoteStatusChip q={q} size="sm" />
              </span>
              {flow.state.text ? <span className={cn("font-medium", STATE_TONE[flow.state.tone])}>{flow.state.text}</span> : null}
            </div>
          </div>
          {flow.next ? <BarAction next={flow.next} /> : null}
          <Menu
            items={menu}
            trigger={
              <IconButton label="More actions" variant="ghost" tooltip={false}>
                <EllipsisVertical />
              </IconButton>
            }
          />
        </div>
      </div>
      <SectionList open={listOpen} onOpenChange={setListOpen} sections={sections} />
    </>
  );
}

/* ------------------------------------------------------------------ section list (bottom sheet) */

function SectionList({ open, onOpenChange, sections }: { open: boolean; onOpenChange: (o: boolean) => void; sections: NavSection[] }) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange} title="Jump to a section" description="Sections that need you are marked.">
      <ul className="-mx-2 divide-y divide-line">
        {sections.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => {
                onOpenChange(false);
                jumpTo(s.id, { delay: 180 });
              }}
              className="flex min-h-14 w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand"
            >
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2 font-medium text-ink">
                  {s.title}
                  {s.attention ? (
                    <Chip tone="review" size="sm" icon={<Clock aria-hidden />}>
                      {s.badge ? `${s.badge} to do` : "To do"}
                    </Chip>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-sm text-ink-3 [overflow-wrap:anywhere]">{s.summary}</span>
              </span>
              <ChevronRight className="size-5 shrink-0 text-ink-3" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ chip row */

const chipCls =
  "inline-flex h-9 shrink-0 items-center gap-2 rounded-full border bg-surface px-3.5 text-sm font-medium outline-none transition-colors " +
  "hover:border-ink-3 hover:text-ink focus-visible:ring-2 focus-visible:ring-brand";

/** Chips that jump to each section; amber with a count where a person has something to do. Scrolls sideways. */
export function SectionChips({ sections, className }: { sections: NavSection[]; className?: string }) {
  const ref = useRef<HTMLElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setEdges({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, sections.length]);
  const fade = "pointer-events-none absolute inset-y-0 w-8 from-canvas to-transparent";
  return (
    <div className={cn("relative lg:hidden", className)}>
      <nav
        ref={ref}
        aria-label="Jump to a section"
        onScroll={measure}
        className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:-mx-6 sm:px-6 [&::-webkit-scrollbar]:hidden"
      >
        {sections.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            onClick={(e) => {
              e.preventDefault();
              jumpTo(s.id);
            }}
            className={cn(chipCls, s.attention ? "border-review-line text-ink" : "border-line-strong text-ink-2")}
          >
            {s.chip}
            {s.attention ? <Count value={s.badge ?? 1} tone="review" /> : null}
          </a>
        ))}
      </nav>
      {edges.left ? <div aria-hidden className={cn(fade, "-left-4 bg-gradient-to-r sm:-left-6")} /> : null}
      {edges.right ? <div aria-hidden className={cn(fade, "-right-4 bg-gradient-to-l sm:-right-6")} /> : null}
    </div>
  );
}
