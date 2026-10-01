/**
 * Projects (mockups 15, 16): one tab per service family, filters, a table on desktop and
 * stacked cards on phones. Each row carries one next action.
 */
import { Archive, FolderPlus, Plus, SearchX } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useCategories, useCategoryLabel } from "@/api/session";
import { PROJECT_STAGES, reviewStatusInfo, stageInfo } from "@/lib/labels";
import { projectHref } from "@/lib/routes";
import {
  Button,
  EmptyState,
  ErrorState,
  ListRow,
  LoadingRows,
  Page,
  PageHeader,
  Panel,
  SearchInput,
  Select,
  StatusChip,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Tabs,
  TabsContent,
  type SortDir,
} from "@/ui";
import { useProjectList, type ProjectSummary } from "./api";
import { actionSentence, familyLabel } from "./lib";
import { NewProjectDialog } from "./NewProjectDialog";
import { Bidi, BlockersChip, ChangesChip, DueDate, NextActionButton } from "./parts";

type SortKey = "due" | "name";

function matches(p: ProjectSummary, q: string): boolean {
  if (!q) return true;
  const hay = [p.name, p.code, p.ref, p.tender_no, p.location, p.customer?.name].filter(Boolean).join(" ").toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

function sortRows(rows: ProjectSummary[], key: SortKey, dir: SortDir): ProjectSummary[] {
  const sign = dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    if (key === "name") return sign * a.name.localeCompare(b.name);
    if (!a.due_date && !b.due_date) return a.name.localeCompare(b.name);
    if (!a.due_date) return 1; // no date last either way
    if (!b.due_date) return -1;
    return sign * a.due_date.localeCompare(b.due_date);
  });
}

export function ProjectsPage() {
  const [params, setParams] = useSearchParams();
  const family = params.get("family") || "all";
  const stage = params.get("stage") || "";
  const q = params.get("q") || "";
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "due", dir: "asc" });
  const [newOpen, setNewOpen] = useState(false);
  const navigate = useNavigate();

  const query = useProjectList();
  const { data: categories } = useCategories();
  const categoryLabel = useCategoryLabel();

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const items = useMemo(() => query.data?.items ?? [], [query.data]);

  const tabs = useMemo(() => {
    const counts = new Map<string, number>();
    items.forEach((p) => counts.set(p.service_family, (counts.get(p.service_family) ?? 0) + 1));
    const order = (categories ?? [])
      .filter((c) => c.group === "work")
      .sort((a, b) => a.order - b.order)
      .map((c) => c.key);
    const rest = [...counts.keys()].filter((k) => !order.includes(k));
    const others = [...order, ...rest].filter((k) => k !== "bmu" && k !== "wce" && counts.get(k));
    return [
      { value: "all", label: "All work", count: items.length },
      ...["bmu", "wce", ...others].map((k) => ({ value: k, label: familyLabel(k, categoryLabel), count: counts.get(k) ?? 0 })),
    ];
  }, [items, categories, categoryLabel]);

  const inFamily = useMemo(() => items.filter((p) => family === "all" || p.service_family === family), [items, family]);
  const stageOptions = useMemo(() => {
    const counts = new Map<string, number>();
    inFamily.forEach((p) => counts.set(p.stage, (counts.get(p.stage) ?? 0) + 1));
    return PROJECT_STAGES.filter((s) => s !== "archived").map((s) => ({
      value: s,
      label: `${stageInfo(s).label} (${counts.get(s) ?? 0})`,
    }));
  }, [inFamily]);

  const rows = useMemo(
    () => sortRows(inFamily.filter((p) => (!stage || p.stage === stage) && matches(p, q)), sort.key, sort.dir),
    [inFamily, stage, q, sort],
  );
  const filtered = !!stage || !!q;

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));

  return (
    <Page>
      <PageHeader
        title="Projects"
        meta={query.data ? `${query.data.total} open ${query.data.total === 1 ? "project" : "projects"}` : undefined}
        actions={
          <>
            <Button asChild variant="secondary" className="flex-1 sm:flex-none">
              <Link to="/projects/archive">
                <Archive aria-hidden />
                Archive
              </Link>
            </Button>
            <Button icon={<Plus />} onClick={() => setNewOpen(true)} className="flex-1 sm:flex-none">
              New project
            </Button>
          </>
        }
      />

      <Tabs value={family} onChange={(v) => setParam("family", v === "all" ? "" : v)} tabs={tabs} label="Service family">
        <TabsContent value={family}>
          <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center">
            <SearchInput
              value={q}
              onChange={(v) => setParam("q", v)}
              placeholder="Search name, tender or customer"
              label="Search projects"
              className="md:w-80"
            />
            <Select
              aria-label="Stage"
              value={stage}
              onChange={(e) => setParam("stage", e.target.value)}
              options={stageOptions}
              placeholder="All stages"
              className="md:w-60"
            />
            {filtered ? (
              <Button variant="ghost" onClick={() => setParams(family === "all" ? {} : { family }, { replace: true })}>
                Clear filters
              </Button>
            ) : null}
            {query.data && filtered ? (
              <p className="text-sm text-ink-3 md:ml-auto" aria-live="polite">
                {rows.length} of {inFamily.length} shown
              </p>
            ) : null}
          </div>

          {query.isLoading ? (
            <Panel>
              <LoadingRows rows={6} />
            </Panel>
          ) : query.isError ? (
            <Panel>
              <ErrorState error={query.error} onRetry={() => query.refetch()} />
            </Panel>
          ) : items.length === 0 ? (
            <Panel>
              <EmptyState
                icon={<FolderPlus />}
                title="No projects yet"
                action={
                  <Button icon={<Plus />} onClick={() => setNewOpen(true)}>
                    New project
                  </Button>
                }
              >
                Projects appear when the mailbox scan finds a customer enquiry. You can also create one by hand.
              </EmptyState>
            </Panel>
          ) : rows.length === 0 ? (
            <Panel>
              <EmptyState
                icon={<SearchX />}
                title={filtered ? "No projects match these filters" : "No projects in this service family"}
                action={
                  filtered ? (
                    <Button variant="secondary" onClick={() => setParams(family === "all" ? {} : { family }, { replace: true })}>
                      Clear filters
                    </Button>
                  ) : (
                    <Button icon={<Plus />} onClick={() => setNewOpen(true)}>
                      New project
                    </Button>
                  )
                }
              >
                {filtered
                  ? "Try another stage or search word."
                  : "Enquiries for this family appear here once the mailbox scan links them, or create one now."}
              </EmptyState>
            </Panel>
          ) : (
            <>
              <Panel className="hidden overflow-hidden lg:block">
                <Table>
                  <THead>
                    <tr>
                      <TH className="w-[30%]" sort={sort.key === "name" ? sort.dir : null} onSort={() => toggleSort("name")}>
                        Project
                      </TH>
                      <TH className="w-[18%]">Customer</TH>
                      <TH className="w-[16%]">Status</TH>
                      <TH className="w-[12%]" sort={sort.key === "due" ? sort.dir : null} onSort={() => toggleSort("due")}>
                        Closing date
                      </TH>
                      <TH className="w-[24%]">Next action</TH>
                    </tr>
                  </THead>
                  <TBody>
                    {rows.map((p) => (
                      <ProjectRow
                        key={p.id}
                        p={p}
                        showFamily={family === "all"}
                        familyName={familyLabel(p.service_family, categoryLabel)}
                        onOpen={() => navigate(projectHref(p.id))}
                      />
                    ))}
                  </TBody>
                </Table>
              </Panel>
              <ul className="space-y-3 lg:hidden" aria-label="Projects">
                {rows.map((p) => (
                  <li key={p.id}>
                    <ProjectCard p={p} familyName={family === "all" ? familyLabel(p.service_family, categoryLabel) : null} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </TabsContent>
      </Tabs>

      <NewProjectDialog open={newOpen} onOpenChange={setNewOpen} defaultFamily={family === "all" ? undefined : family} />
    </Page>
  );
}

function StatusChips({ p }: { p: ProjectSummary }) {
  return (
    <div className="flex flex-col items-start gap-1.5">
      <StatusChip info={stageInfo(p.stage)} size="sm" />
      {p.review_status && p.review_status !== "not_started" ? <StatusChip info={reviewStatusInfo(p.review_status)} size="sm" /> : null}
      <ChangesChip changes={p.open_changes} />
      <BlockersChip blockers={p.blockers} />
    </div>
  );
}

function ProjectRow({
  p,
  showFamily,
  familyName,
  onOpen,
}: {
  p: ProjectSummary;
  showFamily: boolean;
  familyName: string;
  onOpen: () => void;
}) {
  const sentence = actionSentence(p.next_action);
  const meta = [p.code, p.tender_no ? `Tender ${p.tender_no}` : null, showFamily ? familyName : null].filter(Boolean).join(" · ");
  return (
    <TR onClick={onOpen}>
      <TD>
        <Link
          to={projectHref(p.id)}
          onClick={(e) => e.stopPropagation()}
          className="rounded font-semibold text-ink hover:underline"
        >
          <Bidi text={p.name} />
        </Link>
        <div className="mt-0.5 text-sm text-ink-3">{meta}</div>
      </TD>
      <TD>
        {p.customer ? <Bidi text={p.customer.name} as="div" className="break-words" /> : <span className="text-ink-3">No customer</span>}
        {p.enquiries ? (
          <div className="mt-0.5 text-sm text-ink-3">
            {p.enquiries} {p.enquiries === 1 ? "enquiry" : "enquiries"}
          </div>
        ) : null}
      </TD>
      <TD>
        <StatusChips p={p} />
      </TD>
      <TD>
        <DueDate value={p.due_date} />
      </TD>
      <TD>
        {sentence ? <Bidi text={sentence} as="p" title={sentence} className="mb-2 line-clamp-2 text-sm text-ink-2" /> : null}
        <NextActionButton projectId={p.id} action={p.next_action} size="sm" className="max-w-full" />
      </TD>
    </TR>
  );
}

function ProjectCard({ p, familyName }: { p: ProjectSummary; familyName: string | null }) {
  const sentence = actionSentence(p.next_action) ?? (p.next_action?.label ? String(p.next_action.label) : null);
  return (
    <ListRow
      to={projectHref(p.id)}
      title={<Bidi text={p.name} />}
      subtitle={[p.customer?.name, p.code, familyName].filter(Boolean).join(" · ")}
      footer={
        p.next_action?.kind && p.next_action.kind !== "none" ? (
          <NextActionButton projectId={p.id} action={p.next_action} className="w-full" />
        ) : undefined
      }
    >
      <div className="flex flex-wrap gap-1.5">
        <StatusChip info={stageInfo(p.stage)} size="sm" />
        {p.review_status && p.review_status !== "not_started" ? <StatusChip info={reviewStatusInfo(p.review_status)} size="sm" /> : null}
        <ChangesChip changes={p.open_changes} />
        <BlockersChip blockers={p.blockers} />
      </div>
      <dl className="mt-3 grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-2">
        <dt className="text-ink-3">Closing date</dt>
        <dd className="min-w-0">
          <DueDate value={p.due_date} />
        </dd>
        <dt className="text-ink-3">Enquiries</dt>
        <dd className="tabular text-ink">{p.enquiries || "—"}</dd>
        {sentence ? (
          <>
            <dt className="text-ink-3">Next action</dt>
            <dd className="min-w-0 text-ink">
              <Bidi text={sentence} as="p" className="line-clamp-3" />
            </dd>
          </>
        ) : null}
      </dl>
    </ListRow>
  );
}
