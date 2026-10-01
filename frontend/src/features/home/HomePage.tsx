/**
 * Control center (mockups 11, 55, 56): every project in the chosen period, split into
 * Needs attention / In progress / Completed, with one next action per project.
 */
import { Bot, ChevronRight, FolderOpen, Mail, Plug } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { useCategoryLabel, useSession } from "@/api/session";
import type { SessionInfo } from "@/api/types";
import { cn } from "@/lib/cn";
import { formatRelative, pluralize } from "@/lib/format";
import { connectionStatusInfo } from "@/lib/labels";
import { nextActionHref } from "@/lib/routes";
import {
  Banner,
  Button,
  DATE_PRESETS,
  DateRangePicker,
  Dot,
  EmptyState,
  ErrorState,
  FilterChips,
  LoadingRows,
  Page,
  PageHeader,
  Panel,
  Select,
  Spinner,
  Tabs,
  TabsContent,
  formatRange,
  type DateRangeValue,
} from "@/ui";
import {
  BUCKETS,
  SORT_OPTIONS,
  isBucket,
  sortRows,
  useDashboard,
  type Bucket,
  type Dashboard,
  type DashboardRow,
  type SortKey,
  type SortState,
} from "./dashboard";
import { SetupBanner, WaitingForApproval } from "./Banners";
import { ProjectCard, ProjectTable } from "./ProjectList";
import { RecentActivity } from "./RecentActivity";

/* ------------------------------------------------------------------ URL state */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function defaultRange(): DateRangeValue {
  return DATE_PRESETS.find((p) => p.label === "Last 2 months")?.range() ?? { from: "", to: "" };
}

/** ?from=&to= in the URL (empty = open end); no params = the last two months. */
function readRange(p: URLSearchParams): DateRangeValue {
  if (!p.has("from") && !p.has("to")) return defaultRange();
  const clean = (v: string | null) => (v && DAY.test(v) ? v : "");
  return { from: clean(p.get("from")), to: clean(p.get("to")) };
}

const TAB_TEXT: Record<Bucket, { label: string; heading: (n: number) => string; emptyTitle: string; emptyBody: string }> = {
  needs_attention: {
    label: "Needs attention",
    heading: (n) => (n === 1 ? "1 project needs your attention" : `${n} projects need your attention`),
    emptyTitle: "Nothing waits for you",
    emptyBody: "Changed deadlines, new revisions, blockers and reviews appear here as soon as the mailbox brings them.",
  },
  in_progress: {
    label: "In progress",
    heading: (n) => `${pluralize(n, "project")} in progress`,
    emptyTitle: "No projects in progress",
    emptyBody: "A project moves here when nothing waits for a person and its due date is more than a week away.",
  },
  completed: {
    label: "Completed",
    heading: (n) => `${pluralize(n, "completed project")}`,
    emptyTitle: "No completed projects in this period",
    emptyBody: "Projects appear here once the quotation is sent or the project is archived.",
  },
};

/* ------------------------------------------------------------------ connection banner */

function ConnectionBanner({ session, className }: { session: SessionInfo; className?: string }) {
  const mail = session.mail ?? null;
  const ai = session.ai ?? null;
  const mailLink = (
    <Button asChild variant="secondary" size="sm">
      <Link to="/settings/connections">
        <Plug aria-hidden />
        Connect mailbox
      </Link>
    </Button>
  );
  const aiLink = (
    <Button asChild variant="secondary" size="sm">
      <Link to="/setup/engine">
        <Bot aria-hidden />
        Set up AI engine
      </Link>
    </Button>
  );
  if (!mail && !ai)
    return (
      <Banner
        className={className}
        title="Connect the mailbox and the AI engine"
        actions={
          <>
            {mailLink}
            {aiLink}
          </>
        }
      >
        New enquiries, changed deadlines and revisions come from the company mailbox (read-only). The AI engine
        reads the files and drafts quotations. Until both are connected, this page shows what was imported.
      </Banner>
    );
  if (!mail)
    return (
      <Banner className={className} title="Connect the company mailbox" actions={mailLink}>
        New enquiries, changed deadlines and revisions come from the mailbox. Access is read-only.
      </Banner>
    );
  if (!ai)
    return (
      <Banner className={className} title="Set up the AI engine" actions={aiLink}>
        It reads customer files and drafts quotations. Prices are always left for a person.
      </Banner>
    );
  if (mail.status !== "connected")
    return (
      <Banner
        className={className}
        tone="review"
        title={`Mailbox: ${connectionStatusInfo(mail.status).label}`}
        actions={
          <Button asChild variant="secondary" size="sm">
            <Link to="/settings/connections">
              <Plug aria-hidden />
              Check connection
            </Link>
          </Button>
        }
      >
        New mail is not read until the mailbox connection works again.
      </Banner>
    );
  return null;
}

/* ------------------------------------------------------------------ footer */

function MailboxStatus({ session, data }: { session: SessionInfo | undefined; data: Dashboard | undefined }) {
  const mail = session?.mail ?? null;
  if (!mail) {
    return (
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-3">
        <Dot tone="muted" />
        No mailbox connected
        <span aria-hidden>·</span>
        <Link to="/settings/connections" className="font-medium text-brand-ink underline-offset-4 hover:underline">
          Connect mailbox
        </Link>
      </p>
    );
  }
  const status = connectionStatusInfo(mail.status);
  const sync = mail.last_sync ?? data?.sync ?? null;
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-2">
      <Dot tone={status.tone} label={status.label} />
      <span className="min-w-0 break-all">{mail.account || "Company mailbox"}</span>
      {mail.status !== "connected" ? <span className="font-medium text-review">{status.label}</span> : null}
      <span aria-hidden>·</span>
      <span className="tabular">{sync ? `Last sync ${formatRelative(sync)}` : "Not synced yet"}</span>
    </p>
  );
}

function HomeFooter({ session, data }: { session: SessionInfo | undefined; data: Dashboard | undefined }) {
  const next = data?.buckets.needs_attention[0];
  const newWork = data?.inbox.unread_work ?? 0;
  return (
    <footer
      className={cn(
        "mt-8 flex flex-col items-center gap-3 border-t border-line pt-4 text-center",
        "lg:sticky lg:bottom-0 lg:z-10 lg:-mx-10 lg:mt-auto lg:flex-row lg:justify-between lg:bg-canvas lg:px-10 lg:py-3 lg:text-left",
      )}
    >
      <div className="flex min-w-0 flex-col items-center gap-1 lg:flex-row lg:gap-4">
        <MailboxStatus session={session} data={data} />
        {newWork > 0 ? (
          <Link
            to="/inbox?group=work&state=new"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-ink underline-offset-4 hover:underline"
          >
            <Mail className="size-4" aria-hidden />
            {pluralize(newWork, "new work email")}
          </Link>
        ) : null}
      </div>
      {next ? (
        <Button asChild size="lg" className="hidden lg:inline-flex">
          <Link to={nextActionHref(next.id, next.next_action)}>
            Review next item
            <ChevronRight aria-hidden />
          </Link>
        </Button>
      ) : null}
    </footer>
  );
}

/* ------------------------------------------------------------------ one tab */

function SortSelect({ sort, onChange, className }: { sort: SortState; onChange: (s: SortState) => void; className?: string }) {
  return (
    <label className={cn("flex items-center gap-2 text-sm text-ink-3", className)}>
      <span className="shrink-0">Sort by</span>
      <Select
        aria-label="Sort projects by"
        value={sort.key}
        onChange={(e) => {
          const opt = SORT_OPTIONS.find((o) => o.value === e.target.value) ?? SORT_OPTIONS[0];
          onChange({ key: opt.value, dir: opt.dir });
        }}
        options={SORT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        className="w-44 [&_select]:h-9 [&_select]:text-sm"
      />
    </label>
  );
}

function BucketView({
  bucket,
  rows,
  families,
  onFamilies,
  sort,
  onSort,
  emptyActions,
}: {
  bucket: Bucket;
  rows: DashboardRow[];
  families: string[];
  onFamilies: (v: string[]) => void;
  sort: SortState;
  onSort: (s: SortState) => void;
  emptyActions?: ReactNode;
}) {
  const label = useCategoryLabel();
  const text = TAB_TEXT[bucket];
  const familyOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.service_family, (counts.get(r.service_family) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || label(a[0]).localeCompare(label(b[0])))
      .map(([value, count]) => ({ value, label: label(value), count }));
  }, [rows, label]);
  const active = families.filter((f) => familyOptions.some((o) => o.value === f));
  const filtered = active.length ? rows.filter((r) => active.includes(r.service_family)) : rows;
  const sorted = useMemo(() => sortRows(filtered, sort), [filtered, sort]);

  if (!rows.length) {
    return (
      <Panel>
        <EmptyState icon={<FolderOpen />} title={text.emptyTitle} action={emptyActions}>
          {text.emptyBody}
        </EmptyState>
      </Panel>
    );
  }

  const heading = active.length ? `${sorted.length} of ${text.heading(rows.length)}` : text.heading(rows.length);
  const toggleSort = (key: SortKey) => {
    if (sort.key === key) onSort({ key, dir: sort.dir === "asc" ? "desc" : "asc" });
    else onSort({ key, dir: SORT_OPTIONS.find((o) => o.value === key)?.dir ?? "asc" });
  };

  return (
    <div className="space-y-4">
      {familyOptions.length > 1 ? (
        <FilterChips label="Filter by service family" value={active} onChange={onFamilies} options={familyOptions} />
      ) : null}

      {/* Phone and narrow screens: stacked cards */}
      <section className="xl:hidden" aria-label={heading}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h2 className="text-lg font-semibold text-ink">{heading}</h2>
          <SortSelect sort={sort} onChange={onSort} />
        </div>
        <div className="space-y-3">
          {sorted.map((row) => (
            <ProjectCard key={row.id} row={row} bucket={bucket} />
          ))}
        </div>
      </section>

      {/* Wide screens: one table in a panel */}
      <Panel className="hidden xl:block">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <h2 className="text-lg font-semibold text-ink">{heading}</h2>
          <SortSelect sort={sort} onChange={onSort} />
        </div>
        <ProjectTable rows={sorted} bucket={bucket} sort={sort} onSort={toggleSort} />
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ page */

export function HomePage() {
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const range = useMemo(() => readRange(params), [params]);
  const tabParam = params.get("tab");
  const tab: Bucket = isBucket(tabParam) ? tabParam : "needs_attention";
  const families = useMemo(() => (params.get("family") ?? "").split(",").filter(Boolean), [params]);
  const [sort, setSort] = useState<SortState>({ key: "due", dir: "asc" });
  const q = useDashboard(range);
  const data = q.data;

  const update = (patch: Record<string, string | null>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) next.delete(k);
          else next.set(k, v);
        }
        return next;
      },
      { replace: true },
    );

  const isAllTime = !range.from && !range.to;
  const mailbox = session.data?.mail?.account || session.data?.workspace?.primary_email || data?.workspace.primary_email;

  const emptyActions = (
    <>
      {!isAllTime ? (
        <Button variant="secondary" onClick={() => update({ from: "", to: "" })}>
          Show all time
        </Button>
      ) : null}
      {session.data && !session.data.mail ? (
        <Button asChild variant="secondary">
          <Link to="/settings/connections">
            <Plug aria-hidden />
            Connect mailbox
          </Link>
        </Button>
      ) : null}
    </>
  );

  const content = (bucket: Bucket) => {
    if (q.isLoading)
      return (
        <Panel>
          <LoadingRows rows={4} />
        </Panel>
      );
    if (q.isError && !data)
      return (
        <Panel>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Panel>
      );
    if (!data) return null;
    return (
      <div className={cn("transition-opacity duration-150", q.isFetching && q.isPlaceholderData && "opacity-60")} aria-busy={q.isFetching || undefined}>
        <BucketView
          bucket={bucket}
          rows={data.buckets[bucket] ?? []}
          families={families}
          onFamilies={(v) => update({ family: v.length ? v.join(",") : null })}
          sort={sort}
          onSort={setSort}
          emptyActions={emptyActions}
        />
      </div>
    );
  };

  return (
    <Page className="lg:flex lg:min-h-dvh lg:flex-col lg:pb-0">
      <div className="lg:flex-1">
        <PageHeader
          title="Control center"
          meta={
            <span className="break-words">
              Source: {mailbox || "no mailbox connected"}
              <span aria-hidden className="mx-2 text-line-strong">
                |
              </span>
              <span className="tabular">{formatRange(range)}</span>
            </span>
          }
          actions={
            <>
              {q.isFetching && !q.isLoading ? <Spinner label="Updating" /> : null}
              <DateRangePicker value={range} onChange={(v) => update({ from: v.from, to: v.to })} />
            </>
          }
        />

        {session.data && session.data.setup_step !== "done" ? (
          <SetupBanner step={session.data.setup_step} className="mb-6" />
        ) : session.data ? (
          <ConnectionBanner session={session.data} className="mb-6" />
        ) : null}

        {data ? <WaitingForApproval data={data} className="mb-6" /> : null}

        <Tabs
          value={tab}
          onChange={(v) => update({ tab: v === "needs_attention" ? null : v })}
          label="Projects by state"
          tabs={BUCKETS.map((b) => ({
            value: b,
            label: TAB_TEXT[b].label,
            count: data?.counts[b],
            countTone: b === "needs_attention" && (data?.counts[b] ?? 0) > 0 ? "review" : undefined,
          }))}
        >
          {BUCKETS.map((b) => (
            <TabsContent key={b} value={b}>
              {content(b)}
            </TabsContent>
          ))}
        </Tabs>

        {data?.today.length ? <RecentActivity className="mt-8" items={data.today} /> : null}
      </div>

      <HomeFooter session={session.data} data={data} />
    </Page>
  );
}
