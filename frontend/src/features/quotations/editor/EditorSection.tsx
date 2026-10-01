import { ChevronDown } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { useLocation } from "react-router";
import { isRtl } from "@/lib/format";

/** Keep every editor control mounted when a section is collapsed, so local form state survives. */
export function EditorSection({ id, title, summary, defaultOpen = false, children }: {
  id: string; title: string; summary?: string; defaultOpen?: boolean; children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (ref.current) ref.current.open = defaultOpen; }, [id]); // initial state only
  return (
    <details ref={ref} id={id} className="group scroll-mt-24">
      <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 rounded-xl border border-line bg-surface px-5 py-3 text-ink outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand group-open:mb-2 group-open:min-h-10 group-open:border-0 group-open:bg-transparent group-open:px-1 group-open:py-1 [&::-webkit-details-marker]:hidden">
        <ChevronDown className="size-5 shrink-0 -rotate-90 text-ink-3 transition-transform duration-200 group-open:rotate-0" aria-hidden />
        <span className="font-semibold group-open:text-sm group-open:font-medium"><span className="hidden group-open:inline">Collapse </span>{title}</span>
        {summary ? <bdi dir={isRtl(summary) ? "rtl" : "auto"} className="min-w-0 truncate text-sm text-ink-3 group-open:hidden">{summary}</bdi> : null}
      </summary>
      <div>{children}</div>
    </details>
  );
}

/** Native anchors and router links both reveal their target before scrolling, even on repeat clicks. */
export function openEditorSection(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el instanceof HTMLDetailsElement) el.open = true;
  let ancestor = el.parentElement;
  while (ancestor) {
    if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
    ancestor = ancestor.parentElement;
  }
  el.scrollIntoView({ block: "start" });
}

export function useEditorHashNavigation() {
  const { hash } = useLocation();
  useEffect(() => {
    const reveal = () => {
      try { if (window.location.hash) openEditorSection(decodeURIComponent(window.location.hash.slice(1))); } catch { /* Ignore malformed anchors. */ }
    };
    const timer = window.setTimeout(reveal, 60);
    window.addEventListener("hashchange", reveal);
    return () => { window.clearTimeout(timer); window.removeEventListener("hashchange", reveal); };
  }, [hash]);
}
