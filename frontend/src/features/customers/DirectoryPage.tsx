/**
 * Customer directory (mockup 30): searchable, filterable, sortable and paged; cards on phones.
 * The backend returns the whole list; tag / status / research / watching filters, sorting and
 * paging run in the browser until the API pages server-side.
 */
import { Plus, RefreshCw, SlidersHorizontal, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { customerKindLabel } from "@/lib/labels";
import { formatRelative, pluralize } from "@/lib/format";
import { customerHref } from "@/lib/routes";
import {
  Avatar,
  Button,
  ConfirmDialog,
  Count,
  Drawer,
  EmptyState,
  ErrorState,
  Field,
  ListRow,
  LoadingRows,
  Page,
  PageHeader,
  Pager,
  Panel,
  Popover,
  RowChevron,
  SearchInput,
  Select,
  Skeleton,
  Spinner,
  Switch,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  toast,
  toastError,
} from "@/ui";
import { AddCompanyDialog } from "./AddCompanyDialog";
import { tagsOf, useCustomers, useOpportunities, useRetagAll, type CustomerRow } from "./api";
import { CUSTOMER_KINDS, displayTags, locationLine } from "./lib";
import { CustomersNav, KindLabel, ProfileChip, TagChips, WatchingMark } from "./parts";

const PAGE_SIZE = 25;

type SortKey = "last_seen" | "enquiries" | "projects" | "name";

const SORTS: { value: SortKey; label: string }[] = [
  { value: "last_seen", label: "Last seen (newest)" },
  { value: "enquiries", label: "Most enquiries" },
  { value: "projects", label: "Most projects" },
  { value: "name", label: "Name (A–Z)" },
];

const RESEARCH_OPTIONS = [
  { value: "none", label: "No research" },
  { value: "researching", label: "Researching" },
  { value: "partial", label: "Partly researched" },
  { value: "ready", label: "Profile ready" },
];

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "prospect", label: "Prospect" },
  { value: "dormant", label: "Dormant" },
];

const WATCH_OPTIONS = [
  { value: "on", label: "Watching for news" },
  { value: "off", label: "Not watching" },
];

const time = (v: string | null) => (v ? new Date(v).getTime() : 0);

function sortRows(rows: CustomerRow[], sort: SortKey): CustomerRow[] {
  const out = [...rows];
  switch (sort) {
    case "name":
      return out.sort((a, b) => a.name.localeCompare(b.name));
    case "enquiries":
      return out.sort((a, b) => b.enquiry_count - a.enquiry_count || time(b.last_seen) - time(a.last_seen));
    case "projects":
      return out.sort((a, b) => b.project_count - a.project_count || time(b.last_seen) - time(a.last_seen));
    default:
      return out.sort((a, b) => time(b.last_seen) - time(a.last_seen));
  }
}

/** Filters live in the URL so a filtered list can be shared and survives going back. */
function useFilters() {
  const [params, setParams] = useSearchParams();
  const get = (k: string) => params.get(k) ?? "";
  const f = {
    q: get("q"),
    role: get("role"),
    tag: get("tag"),
    research: get("research"),
    status: get("status"),
    watch: get("watch"),
    all: get("all") === "1",
    sort: (SORTS.some((s) => s.value === get("sort")) ? get("sort") : "last_seen") as SortKey,
    page: Math.max(1, Number(get("page")) || 1),
  };
  const update = (patch: Partial<Record<keyof typeof f, string | boolean | number | null>>, keepPage = false) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          const s = v === true ? "1" : v === false || v === null || v === undefined ? "" : String(v);
          if (!s || (k === "sort" && s === "last_seen") || (k === "page" && s === "1")) next.delete(k);
          else next.set(k, s);
        }
        if (!keepPage && !("page" in patch)) next.delete("page");
        return next;
      },
      { replace: true },
    );
  };
  const extraCount = [f.status, f.watch, f.all ? "1" : ""].filter(Boolean).length;
  const activeCount = [f.role, f.tag, f.research].filter(Boolean).length + extraCount;
  return { f, update, activeCount, extraCount };
}

export function DirectoryPage() {
  const navigate = useNavigate();
  const { f, update, activeCount, extraCount } = useFilters();
  const [qInput, setQInput] = useState(f.q);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [retagOpen, setRetagOpen] = useState(false);

  // Debounce the search box into the URL; take the URL value only when it changed elsewhere
  // (back button, Clear filters), never while the person is typing.
  const pushedQ = useRef(f.q);
  useEffect(() => {
    const q = qInput.trim();
    if (q === pushedQ.current) return;
    const t = window.setTimeout(() => {
      pushedQ.current = q;
      update({ q });
    }, 250);
    return () => window.clearTimeout(t);
  }, [qInput]);
  useEffect(() => {
    if (f.q !== pushedQ.current) {
      pushedQ.current = f.q;
      setQInput(f.q);
    }
  }, [f.q]);

  const list = useCustomers({ q: f.q, kind: f.role, work_only: !f.all });
  const suggested = useOpportunities("suggested");
  const retagAll = useRetagAll();

  const rows = useMemo(() => {
    let r = list.data?.items ?? [];
    if (f.tag) r = r.filter((c) => tagsOf(c).some((t) => t.tag === f.tag));
    if (f.research) r = r.filter((c) => (c.profile_status || "none") === f.research);
    if (f.status) r = r.filter((c) => c.status === f.status);
    if (f.watch) r = r.filter((c) => !!c.monitoring === (f.watch === "on"));
    return sortRows(r, f.sort);
  }, [list.data, f.tag, f.research, f.status, f.watch, f.sort]);

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(f.page, pages);
  const offset = (page - 1) * PAGE_SIZE;
  const pageRows = rows.slice(offset, offset + PAGE_SIZE);

  const tagOptions = useMemo(() => {
    const opts = (list.data?.tags ?? []).map(([t, n]) => ({ value: t, label: `${t} (${n})` }));
    if (f.tag && !opts.some((o) => o.value === f.tag)) opts.unshift({ value: f.tag, label: f.tag });
    return opts;
  }, [list.data?.tags, f.tag]);

  const anyFilter = activeCount > 0 || !!f.q;
  const clearFilters = () => {
    pushedQ.current = "";
    setQInput("");
    update({ q: "", role: "", tag: "", research: "", status: "", watch: "", all: false });
  };

  const total = list.data?.total ?? 0;
  const meta = list.data
    ? `${pluralize(total, "company", "companies")}${f.all ? "" : " we work with"}`
    : "Companies we work with, their roles and what they ask for";

  const runRetagAll = () =>
    retagAll.mutate(undefined, {
      onSuccess: (r) => {
        setRetagOpen(false);
        toast.success(`Tags rebuilt for ${pluralize(r.retagged, "company", "companies")}`);
      },
      onError: (err) => toastError(err, "Re-tagging did not finish"),
    });

  const primaryFilters = (
    <>
      <Field label="Role" htmlFor="flt-role" className="min-w-0">
        <Select
          id="flt-role"
          value={f.role}
          onChange={(e) => update({ role: e.target.value })}
          placeholder="All roles"
          options={CUSTOMER_KINDS.map((k) => ({ value: k, label: customerKindLabel(k) }))}
        />
      </Field>
      <Field label="Tag" htmlFor="flt-tag" className="min-w-0">
        <Select id="flt-tag" value={f.tag} onChange={(e) => update({ tag: e.target.value })} placeholder="All tags" options={tagOptions} />
      </Field>
      <Field label="Research" htmlFor="flt-research" className="min-w-0">
        <Select
          id="flt-research"
          value={f.research}
          onChange={(e) => update({ research: e.target.value })}
          placeholder="Any research status"
          options={RESEARCH_OPTIONS}
        />
      </Field>
    </>
  );

  const extraFilters = (
    <>
      <Field label="Customer status" htmlFor="flt-status">
        <Select id="flt-status" value={f.status} onChange={(e) => update({ status: e.target.value })} placeholder="Any status" options={STATUS_OPTIONS} />
      </Field>
      <Field label="News watch" htmlFor="flt-watch">
        <Select id="flt-watch" value={f.watch} onChange={(e) => update({ watch: e.target.value })} placeholder="Watching or not" options={WATCH_OPTIONS} />
      </Field>
      <Switch
        checked={f.all}
        onChange={(v) => update({ all: v })}
        label="Include all senders"
        description="Also show suppliers and companies that never sent an enquiry."
      />
    </>
  );

  return (
    <Page>
      <PageHeader
        title="Customers"
        meta={meta}
        actions={
          <>
            <Button variant="secondary" icon={<RefreshCw />} onClick={() => setRetagOpen(true)} disabled={!total}>
              Re-tag all
            </Button>
            <AddCompanyDialog trigger={<Button icon={<Plus />}>Add company</Button>} />
          </>
        }
      />
      <CustomersNav suggested={suggested.data?.length} />

      {/* toolbar */}
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-end">
        <SearchInput
          value={qInput}
          onChange={setQInput}
          label="Search companies"
          placeholder="Search by name or domain"
          className="lg:w-72 xl:w-80"
        />
        <div className="hidden min-w-0 flex-1 grid-cols-3 gap-3 lg:grid xl:max-w-2xl">{primaryFilters}</div>
        <div className="hidden lg:block">
          <Popover
            align="end"
            className="w-80 space-y-4"
            trigger={
              <Button variant="secondary" icon={<SlidersHorizontal />}>
                More filters
                {extraCount ? <Count value={extraCount} tone="brand" /> : null}
              </Button>
            }
          >
            {extraFilters}
          </Popover>
        </div>
        <div className="flex gap-2 lg:hidden">
          <Button variant="secondary" icon={<SlidersHorizontal />} onClick={() => setFiltersOpen(true)} className="flex-1">
            Filters
            {activeCount ? <Count value={activeCount} tone="brand" /> : null}
          </Button>
          <Select
            aria-label="Sort companies"
            value={f.sort}
            onChange={(e) => update({ sort: e.target.value }, true)}
            options={SORTS}
            className="flex-1"
          />
        </div>
      </div>

      <div className="mb-3 flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-3">
        {list.data ? (
          <span className="tabular">
            {rows.length === total ? pluralize(total, "company", "companies") : `${rows.length} of ${pluralize(total, "company", "companies")} match`}
          </span>
        ) : (
          <Skeleton className="h-4 w-28" />
        )}
        {list.isFetching && !list.isLoading ? <Spinner className="size-4" label="Updating" /> : null}
        {anyFilter ? (
          <Button variant="link" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        ) : null}
      </div>

      {list.isLoading ? (
        <Panel>
          <LoadingRows rows={8} />
        </Panel>
      ) : list.isError ? (
        <Panel>
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        </Panel>
      ) : total === 0 && !anyFilter ? (
        <Panel>
          <EmptyState
            icon={<Users />}
            title="No customers yet"
            action={
              <>
                <AddCompanyDialog trigger={<Button icon={<Plus />}>Add company</Button>} />
                <Button variant="secondary" asChild>
                  <Link to="/automations#mailbox-scans">Scan the mailbox</Link>
                </Button>
              </>
            }
          >
            Companies appear here when a mailbox scan finds their enquiries. You can also add one by hand.
          </EmptyState>
        </Panel>
      ) : rows.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<Users />}
            title="No companies match"
            action={
              <Button variant="secondary" onClick={clearFilters}>
                Clear filters
              </Button>
            }
          >
            {f.all ? "Try a shorter search or fewer filters." : "Try fewer filters, or include all senders under More filters."}
          </EmptyState>
        </Panel>
      ) : (
        <>
          {/* desktop table */}
          <Panel className="hidden overflow-hidden lg:block">
            <Table>
              <THead>
                <tr>
                  <TH sort={f.sort === "name" ? "asc" : null} onSort={() => update({ sort: "name" }, false)}>
                    Company
                  </TH>
                  <TH>Role</TH>
                  <TH>Tags</TH>
                  <TH className="text-right" sort={f.sort === "enquiries" ? "desc" : null} onSort={() => update({ sort: "enquiries" })}>
                    Enquiries
                  </TH>
                  <TH className="text-right" sort={f.sort === "projects" ? "desc" : null} onSort={() => update({ sort: "projects" })}>
                    Projects
                  </TH>
                  <TH sort={f.sort === "last_seen" ? "desc" : null} onSort={() => update({ sort: "last_seen" })}>
                    Last seen
                  </TH>
                  <TH>Research</TH>
                  <TH className="w-10">
                    <span className="sr-only">Open</span>
                  </TH>
                </tr>
              </THead>
              <TBody>
                {pageRows.map((c) => {
                  const loc = locationLine(c.city, c.country);
                  return (
                    <TR key={c.id} onClick={() => navigate(customerHref(c.id))}>
                      <TD className="min-w-[15rem] max-w-[22rem]">
                        <Link
                          to={customerHref(c.id)}
                          onClick={(e) => e.stopPropagation()}
                          className="font-semibold text-ink outline-none hover:text-brand-ink hover:underline focus-visible:ring-2 focus-visible:ring-brand"
                        >
                          {c.name}
                        </Link>
                        <p className="mt-0.5 truncate text-sm text-ink-3">
                          {c.domain || "No domain"}
                          {loc ? ` · ${loc}` : ""}
                        </p>
                      </TD>
                      <TD className="min-w-[9rem]">
                        <KindLabel kind={c.kind} confidence={c.kind_confidence} />
                      </TD>
                      <TD className="min-w-[13rem] max-w-[20rem]">
                        <TagChips tags={displayTags(tagsOf(c), c.kind)} />
                      </TD>
                      <TD className="text-right tabular">{c.enquiry_count}</TD>
                      <TD className="text-right tabular">{c.project_count}</TD>
                      <TD className="whitespace-nowrap text-ink-2">{formatRelative(c.last_seen)}</TD>
                      <TD>
                        <div className="flex flex-col items-start gap-1">
                          <ProfileChip status={c.profile_status} />
                          {c.monitoring ? <WatchingMark /> : null}
                        </div>
                      </TD>
                      <TD className="pt-5">
                        <RowChevron />
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
            <Pager offset={offset} limit={PAGE_SIZE} total={rows.length} onChange={(o) => update({ page: o / PAGE_SIZE + 1 })} />
          </Panel>

          {/* phone and tablet cards */}
          <div className="space-y-3 lg:hidden">
            {pageRows.map((c) => (
              <ListRow
                key={c.id}
                to={customerHref(c.id)}
                leading={<Avatar name={c.name} />}
                title={c.name}
                subtitle={[customerKindLabel(c.kind || "other"), c.domain].filter(Boolean).join(" · ")}
                aside={<ProfileChip status={c.profile_status} />}
              >
                <TagChips tags={displayTags(tagsOf(c), c.kind)} />
                <p className="mt-2.5 text-sm text-ink-3 tabular">
                  {pluralize(c.enquiry_count, "enquiry", "enquiries")} · {pluralize(c.project_count, "project")} · Last seen{" "}
                  {formatRelative(c.last_seen).toLowerCase()}
                  {c.monitoring ? " · Watching" : ""}
                </p>
              </ListRow>
            ))}
            {rows.length > PAGE_SIZE ? (
              <Panel>
                <Pager offset={offset} limit={PAGE_SIZE} total={rows.length} onChange={(o) => update({ page: o / PAGE_SIZE + 1 })} />
              </Panel>
            ) : null}
          </div>
        </>
      )}

      <Drawer
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
        title="Filter companies"
        footer={
          <>
            <Button variant="secondary" className="flex-1" onClick={clearFilters} disabled={!anyFilter}>
              Clear
            </Button>
            <Button className="flex-1" onClick={() => setFiltersOpen(false)}>
              Show {pluralize(rows.length, "company", "companies")}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {primaryFilters}
          {extraFilters}
        </div>
      </Drawer>

      <ConfirmDialog
        open={retagOpen}
        onOpenChange={setRetagOpen}
        title="Re-tag all companies?"
        confirmLabel="Re-tag all"
        loading={retagAll.isPending}
        onConfirm={runRetagAll}
      >
        <p className="text-base text-ink-2">
          Reads each company’s mail and projects again and rebuilds the automatic tags and suggested services. Tags people added
          stay, and dismissed suggestions stay dismissed.
        </p>
        <p className="mt-2 text-sm text-ink-3">With many companies this can take a minute.</p>
      </ConfirmDialog>
    </Page>
  );
}
