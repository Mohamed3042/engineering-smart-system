import { useQuery } from "@tanstack/react-query";
import { ChevronRight, FileText, Folder, Mail, Search, Users, X } from "lucide-react";
import { Dialog as D } from "radix-ui";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { api } from "@/api/client";
import { cn } from "@/lib/cn";
import { formatDateShort } from "@/lib/format";
import { quotationStatusInfo, stageInfo } from "@/lib/labels";
import { Spinner } from "@/ui";

interface SearchResult {
  projects: { id: string; name: string; code: string; service_family: string; stage: string }[];
  emails: { id: string; subject: string; from: string; date: string | null; category: string }[];
  customers: { id: string; name: string; domain: string }[];
  quotations: { id: string; reference: string; status: string; project_id: string }[];
}

interface Hit {
  key: string;
  group: string;
  icon: ReactNode;
  title: string;
  subtitle: string;
  to: string;
}

function useDebounced<T>(value: T, ms = 200) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** ⌘K / Ctrl+K search across projects, emails, customers and quotations. */
export function GlobalSearch({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const term = useDebounced(q.trim());
  const listRef = useRef<HTMLDivElement>(null);

  const query = useQuery({
    queryKey: ["search", term],
    queryFn: () => api.get<SearchResult>("/search", { q: term }),
    enabled: open && term.length >= 2,
    staleTime: 10_000,
  });

  const hits: Hit[] = useMemo(() => {
    const r = query.data;
    if (!r) return [];
    return [
      ...r.projects.map((p) => ({
        key: `p${p.id}`,
        group: "Projects",
        icon: <Folder />,
        title: p.name,
        subtitle: [p.code, stageInfo(p.stage).label].filter(Boolean).join(" · "),
        to: `/projects/${p.id}`,
      })),
      ...r.emails.map((e) => ({
        key: `e${e.id}`,
        group: "Emails",
        icon: <Mail />,
        title: e.subject || "(no subject)",
        subtitle: [e.from, formatDateShort(e.date, "")].filter(Boolean).join(" · "),
        to: `/inbox/${encodeURIComponent(e.id)}`,
      })),
      ...r.quotations.map((x) => ({
        key: `q${x.id}`,
        group: "Quotations",
        icon: <FileText />,
        title: x.reference || "Draft quotation",
        subtitle: quotationStatusInfo(x.status).label,
        to: `/quotations/${x.id}`,
      })),
      ...r.customers.map((c) => ({
        key: `c${c.id}`,
        group: "Customers",
        icon: <Users />,
        title: c.name,
        subtitle: c.domain,
        to: `/customers/${c.id}`,
      })),
    ];
  }, [query.data]);

  useEffect(() => setActive(0), [term]);
  useEffect(() => {
    if (!open) setQ("");
  }, [open]);

  const go = (h: Hit) => {
    onOpenChange(false);
    navigate(h.to);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && hits[active]) {
      e.preventDefault();
      go(hits[active]);
    }
  };

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  let lastGroup = "";
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/65 animate-fade-in" />
        <D.Content
          onKeyDown={onKey}
          className="fixed inset-x-0 top-0 z-50 mx-auto flex max-h-[100dvh] w-full flex-col bg-surface shadow-pop outline-none animate-pop-in sm:top-[12vh] sm:max-h-[70vh] sm:max-w-2xl sm:rounded-xl"
        >
          <D.Title className="sr-only">Search</D.Title>
          <D.Description className="sr-only">Search projects, emails, quotations and customers</D.Description>
          <div className="flex items-center gap-3 border-b border-line px-4 py-3">
            <Search className="size-5 shrink-0 text-ink-3" aria-hidden />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search projects, emails, quotations or customers"
              aria-label="Search"
              role="combobox"
              aria-expanded={hits.length > 0}
              aria-controls="global-search-results"
              aria-activedescendant={hits[active] ? `gs-${hits[active].key}` : undefined}
              className="h-10 min-w-0 flex-1 bg-transparent text-lg text-ink outline-none placeholder:text-ink-3"
            />
            {query.isFetching ? <Spinner /> : null}
            <D.Close className="grid size-9 place-items-center rounded-md text-ink-3 hover:bg-hover hover:text-ink" aria-label="Close search">
              <X className="size-5" />
            </D.Close>
          </div>
          <div ref={listRef} id="global-search-results" role="listbox" className="min-h-0 flex-1 overflow-y-auto p-2">
            {term.length < 2 ? (
              <p className="px-3 py-8 text-center text-sm text-ink-3">Type at least two letters. Try a tender number, a building or a company.</p>
            ) : query.isError ? (
              <p className="px-3 py-8 text-center text-sm text-block">Search failed. Try again.</p>
            ) : query.data && hits.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-ink-3">Nothing matches “{term}”.</p>
            ) : (
              hits.map((h, i) => {
                const header = h.group !== lastGroup ? h.group : null;
                lastGroup = h.group;
                return (
                  <div key={h.key}>
                    {header ? <p className="px-3 pb-1 pt-3 text-xs font-semibold text-ink-3">{header}</p> : null}
                    <button
                      id={`gs-${h.key}`}
                      data-index={i}
                      role="option"
                      aria-selected={i === active}
                      onMouseMove={() => setActive(i)}
                      onClick={() => go(h)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left [&_svg]:size-5",
                        i === active ? "bg-brand-soft" : "hover:bg-hover",
                      )}
                    >
                      <span className="text-ink-3">{h.icon}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-ink">{h.title}</span>
                        {h.subtitle ? <span className="block truncate text-sm text-ink-3">{h.subtitle}</span> : null}
                      </span>
                      <ChevronRight className="text-ink-3" aria-hidden />
                    </button>
                  </div>
                );
              })
            )}
          </div>
          <div className="hidden items-center justify-end gap-2 border-t border-line px-4 py-2.5 text-xs text-ink-3 sm:flex">
            <kbd className="rounded border border-line px-1.5 py-0.5 font-sans">↑</kbd>
            <kbd className="rounded border border-line px-1.5 py-0.5 font-sans">↓</kbd> to move ·
            <kbd className="rounded border border-line px-1.5 py-0.5 font-sans">Enter</kbd> to open ·
            <kbd className="rounded border border-line px-1.5 py-0.5 font-sans">Esc</kbd> to close
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
