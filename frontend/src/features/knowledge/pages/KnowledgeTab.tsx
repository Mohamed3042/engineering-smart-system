import { BookOpen, Library, Plus, Sparkles } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useOutletContext } from "react-router";
import type { KnowledgeItem } from "@/api/types";
import { useCanManage } from "@/features/connections/api";
import { Button, ConfirmDialog, EmptyState, Panel, QueryState, SearchInput, Segmented, Select, toast, toastError } from "@/ui";
import { useDeleteKnowledge, useKnowledge } from "../api";
import { AddFindingDialog } from "../components/AddFindingDialog";
import { FindingCard } from "../components/FindingCard";
import { FindingEditor } from "../components/FindingEditor";
import { StandardLibraryDialog, TermLibraryDialog } from "../components/LibraryDialog";
import { KIND_LABELS, kindLabel, LANGUAGE_OPTIONS, REGION_KEYS, regionLabel, sortForReview, STATUS_FILTERS, type StatusFilter } from "../model";

interface TabInfo {
  intro: string;
  empty: ReactNode;
  library?: "terms" | "standards";
}

const INFO: Record<string, TabInfo> = {
  service_family: {
    intro: "The lines of work you quote. A confirmed family tells the system which mail is an enquiry for you.",
    empty: "Service families appear after business learning reads your mail and company folders. You can also add one yourself.",
  },
  work_type: {
    intro: "How you do the work: supply and installation, maintenance, inspection, rental.",
    empty: "Work types appear after business learning has read your quotations and mail. You can also add one yourself.",
  },
  term: {
    intro: "The words customers use, by region and language. Confirm a wording, then choose whether it may sort mail.",
    empty: "Terms appear after business learning has read your mail and documents. You can also pick words from the regional vocabulary.",
    library: "terms",
  },
  standard: {
    intro: "Standards your quotations and customers refer to.",
    empty: "Standards appear when your documents and mail name them. You can also pick them from the standards library.",
    library: "standards",
  },
  convention: {
    intro: "How your documents usually do things: payment terms, validity, language.",
    empty: "Conventions appear after business learning has read your own quotations. You can also add one yourself.",
  },
};

/** One tab of Business knowledge: the findings of one kind, with the owner's decisions on each. */
export function KnowledgeTab({ kind }: { kind: string }) {
  const knowledge = useKnowledge();
  const canEdit = useCanManage();
  const remove = useDeleteKnowledge();
  const { openLearn } = useOutletContext<{ openLearn: () => void }>();
  const info = INFO[kind];
  const label = kindLabel(kind);
  const addLabel = KIND_LABELS[kind]?.add ?? "Add";
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [region, setRegion] = useState("");
  const [language, setLanguage] = useState("");
  const [editing, setEditing] = useState<KnowledgeItem | null>(null);
  const [deleting, setDeleting] = useState<KnowledgeItem | null>(null);
  const [adding, setAdding] = useState(false);
  const [library, setLibrary] = useState(false);

  // ponytail: filters in the browser over the whole list; a workspace holds a few hundred findings. Page it on the server past a few thousand.
  const all = useMemo(() => (knowledge.data?.items ?? []).filter((i) => i.kind === kind), [knowledge.data, kind]);
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sortForReview(
      all.filter(
        (i) =>
          (status === "all" || i.status === status) &&
          (!region || (i.region ?? "") === region) &&
          (!language || (i.language ?? "") === language) &&
          (!needle ||
            i.label.toLowerCase().includes(needle) ||
            (i.label_ar ?? "").includes(needle) ||
            (i.description ?? "").toLowerCase().includes(needle) ||
            (i.synonyms ?? []).some((s) => String(typeof s === "string" ? s : (s as { term?: string })?.term ?? "").toLowerCase().includes(needle))),
      ),
    );
  }, [all, q, status, region, language]);

  const counts = {
    all: all.length,
    suggested: all.filter((i) => i.status === "suggested").length,
    owner_confirmed: all.filter((i) => i.status === "owner_confirmed").length,
    rejected: all.filter((i) => i.status === "rejected").length,
  };

  const confirmDelete = () => {
    if (!deleting) return;
    remove.mutate(deleting.id, {
      onSuccess: () => {
        toast.success(`Deleted: ${deleting.label}`);
        setDeleting(null);
      },
      onError: (err) => {
        setDeleting(null);
        toastError(err, "The finding could not be deleted");
      },
    });
  };

  const addAction = (
    <Button size="sm" icon={<Plus />} disabled={!canEdit} onClick={() => setAdding(true)}>
      {addLabel}
    </Button>
  );

  return (
    <div className="space-y-4">
      <p className="text-base text-ink-3">{info.intro}</p>
      <Panel>
        <div className="flex flex-col gap-3 border-b border-line px-5 py-4 lg:flex-row lg:flex-wrap lg:items-center">
          <SearchInput value={q} onChange={setQ} placeholder={`Search ${label.toLowerCase()}`} label={`Search ${label.toLowerCase()}`} className="lg:w-64" />
          <Segmented
            label="Show"
            value={status}
            onChange={(v) => setStatus(v as StatusFilter)}
            options={STATUS_FILTERS.map((f) => ({ value: f.value, label: f.label, count: counts[f.value] }))}
          />
          {kind === "term" ? (
            <>
              <Select
                aria-label="Region"
                className="lg:w-48"
                value={region}
                options={[{ value: "", label: "Any region" }, ...REGION_KEYS.map((k) => ({ value: k, label: regionLabel(k) }))]}
                onChange={(e) => setRegion(e.target.value)}
              />
              <Select
                aria-label="Language"
                className="lg:w-40"
                value={language}
                options={[{ value: "", label: "Any language" }, ...LANGUAGE_OPTIONS]}
                onChange={(e) => setLanguage(e.target.value)}
              />
            </>
          ) : null}
          <div className="flex flex-wrap gap-2 lg:ml-auto">
            {info.library ? (
              <Button size="sm" variant="secondary" icon={<Library />} onClick={() => setLibrary(true)} disabled={!canEdit}>
                {info.library === "terms" ? "Regional vocabulary" : "Standards library"}
              </Button>
            ) : null}
            {addAction}
          </div>
        </div>

        <QueryState
          query={knowledge}
          isEmpty={(d) => !d.items.some((i) => i.kind === kind)}
          empty={
            <EmptyState
              icon={<BookOpen />}
              title={`No ${kindLabel(kind, true).toLowerCase()} yet`}
              action={
                <>
                  <Button variant="secondary" icon={<Sparkles />} onClick={openLearn}>
                    Learn from files and mail
                  </Button>
                  {canEdit ? (
                    <Button icon={<Plus />} onClick={() => setAdding(true)}>
                      {addLabel}
                    </Button>
                  ) : null}
                </>
              }
            >
              {info.empty}
            </EmptyState>
          }
        >
          {() =>
            visible.length === 0 ? (
              <EmptyState compact title="No finding matches">
                Change the search or the filters above.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-line" aria-label={kindLabel(kind, true)}>
                {visible.map((item) => (
                  <FindingCard key={item.id} item={item} canEdit={canEdit} onEdit={setEditing} onDelete={setDeleting} />
                ))}
              </ul>
            )
          }
        </QueryState>
      </Panel>

      <FindingEditor item={editing} canEdit={canEdit} onClose={() => setEditing(null)} />
      <AddFindingDialog kind={kind} open={adding} onOpenChange={setAdding} />
      {info.library === "terms" ? <TermLibraryDialog open={library} onOpenChange={setLibrary} /> : null}
      {info.library === "standards" ? <StandardLibraryDialog open={library} onOpenChange={setLibrary} /> : null}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete “${deleting?.label ?? ""}”?`}
        confirmLabel="Delete finding"
        variant="danger"
        loading={remove.isPending}
        onConfirm={confirmDelete}
      >
        <div className="space-y-2 text-base text-ink-2">
          <p>It disappears from this list and no longer helps with mail sorting or drafting. The mail and files it came from are not touched.</p>
          {deleting?.apply_to_classification ? <p>A mail category already created from it stays. Remove it under the inbox filters if you no longer want it.</p> : null}
          <p>If business learning finds it again, it comes back as a new suggestion. To keep it away, reject it instead.</p>
        </div>
      </ConfirmDialog>
    </div>
  );
}
