/**
 * Classified inbox (mockups 12, 51, 52, 54): Work / Bills / Promotions / Other with counts, category
 * chips, search, show/hide, bulk actions and unsubscribe. Mail access is read-only: nothing here
 * sends, replies to, labels or deletes mail in the mailbox.
 */
import { EyeOff, Inbox as InboxIcon, Plug } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useCategories, useCategoryLabel, useSession } from "@/api/session";
import { cn } from "@/lib/cn";
import { formatRelative, pluralize } from "@/lib/format";
import {
  Button,
  Checkbox,
  EmptyState,
  FilterChips,
  LoadingRows,
  Page,
  PageHeader,
  Pager,
  Panel,
  QueryState,
  Segmented,
  SearchInput,
  Select,
  Spinner,
} from "@/ui";
import { groupCount, useEmails, useInboxSummary, type EmailQuery } from "./api";
import { BulkBar } from "./BulkBar";
import { Candidates } from "./Candidates";
import { EmailCards, EmailTable } from "./EmailList";
import { GROUP_HINT, GROUP_LABEL, MAIL_GROUPS, STATE_FILTERS, isMailGroup, type MailGroup } from "./labels";
import { UnsubscribeDialog, type UnsubscribeTarget } from "./UnsubscribeDialog";
import { VisibilityDrawer } from "./VisibilityDrawer";

const PAGE_SIZE = 50;

type Patch = Partial<Record<"group" | "category" | "state" | "q" | "sort" | "hidden" | "page", string | number | boolean | null>>;

/** Filters live in the URL, so the list survives going back from a message and can be shared. */
function useInboxFilters() {
  const [params, setParams] = useSearchParams();
  const g = params.get("group");
  const s = params.get("state");
  const f = {
    group: (isMailGroup(g) ? g : "work") as MailGroup,
    category: (params.get("category") ?? "").split(",").filter(Boolean),
    state: s && STATE_FILTERS.some((x) => x.value === s) ? s : "open",
    q: params.get("q") ?? "",
    sort: params.get("sort") === "oldest" ? "oldest" : "newest",
    hidden: params.get("hidden") === "1",
    page: Math.max(1, Number(params.get("page")) || 1),
  };
  const update = (patch: Patch) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          const text = v === true ? "1" : v === false || v === null || v === undefined ? "" : String(v);
          const isDefault = (k === "group" && text === "work") || (k === "state" && text === "open") || (k === "sort" && text === "newest") || (k === "page" && text === "1");
          if (!text || isDefault) next.delete(k);
          else next.set(k, text);
        }
        if (!("page" in patch)) next.delete("page"); // any other change starts again at page 1
        return next;
      },
      { replace: true },
    );
  return { f, update, key: params.toString() };
}

export function InboxPage() {
  const { f, update, key } = useInboxFilters();
  const session = useSession();
  const summary = useInboxSummary();
  const categories = useCategories();
  const categoryLabel = useCategoryLabel();
  const [unsub, setUnsub] = useState<UnsubscribeTarget | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Debounce the search box into the URL; take the URL value only when it changed elsewhere (back button, Clear filters).
  const [qInput, setQInput] = useState(f.q);
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

  // A different list means a different selection.
  useEffect(() => setSelected((cur) => (cur.size ? new Set() : cur)), [key]);
  useEffect(() => window.scrollTo(0, 0), [f.page]);

  const stateParam = STATE_FILTERS.find((x) => x.value === f.state)?.param;
  const query: EmailQuery = {
    group: f.group,
    category: f.category.join(",") || undefined,
    state: stateParam,
    q: f.q || undefined,
    sort: f.sort as "newest" | "oldest",
    page: f.page,
    page_size: PAGE_SIZE,
    include_hidden: f.hidden || undefined,
  };
  const emails = useEmails(query);
  const items = emails.data?.items ?? [];
  const total = emails.data?.total ?? 0;

  const iconNames = useMemo(() => new Map((categories.data ?? []).map((c) => [c.key, c.icon] as const)), [categories.data]);
  const mail = session.data?.mail ?? null;
  const groupInfo = summary.data?.groups[f.group];
  const groupHidden = summary.data?.group_visibility[f.group] === false;
  const groupCats = groupInfo?.categories ?? [];
  const chipCats = groupCats.filter((c) => c.count > 0 && (c.visible || f.hidden || groupHidden || f.category.includes(c.key)));
  const hiddenCount = groupHidden ? 0 : groupCats.filter((c) => !c.visible).reduce((n, c) => n + c.count, 0);
  const anyFilter = !!f.q || f.category.length > 0 || f.state !== "open";
  const clearFilters = () => {
    pushedQ.current = "";
    setQInput("");
    update({ q: "", category: "", state: "open" });
  };

  const onToggle = (id: string, on: boolean) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const onToggleAll = (on: boolean) => setSelected(on ? new Set(items.map((e) => e.id)) : new Set());
  const allSelected = items.length > 0 && items.every((e) => selected.has(e.id));

  const groupOptions = MAIL_GROUPS.map((g) => ({
    value: g,
    label: (
      <span className="inline-flex items-center gap-1.5">
        {GROUP_LABEL[g]}
        {summary.data?.group_visibility[g] === false ? (
          <>
            <EyeOff className="size-3.5 text-ink-3" aria-hidden />
            <span className="sr-only">(hidden)</span>
          </>
        ) : null}
      </span>
    ),
    count: groupCount(summary.data, g, f.hidden),
  }));

  const empty = !mail && summary.data && Object.values(summary.data.groups).every((g) => !g || g.total === 0) ? (
    <EmptyState
      icon={<Plug />}
      title="Connect the company mailbox"
      action={
        <Button asChild>
          <Link to="/settings/connections">Connect mailbox</Link>
        </Button>
      }
    >
      Mail from the connected mailbox is read, sorted into Work, Bills, Promotions and Other, and shown here. Access is read-only.
    </EmptyState>
  ) : anyFilter ? (
    <EmptyState
      icon={<InboxIcon />}
      title="No mail matches"
      action={
        <Button variant="secondary" onClick={clearFilters}>
          Clear filters
        </Button>
      }
    >
      Try a shorter search, another category, or choose All mail in the filter next to the search box.
    </EmptyState>
  ) : (
    <EmptyState icon={<InboxIcon />} title={`No ${GROUP_LABEL[f.group].toLowerCase()} mail`}>
      {GROUP_HINT[f.group]} appear here once the mailbox has been read{f.group === "work" ? " and a message is recognised as work" : ""}.
    </EmptyState>
  );

  return (
    <Page>
      <PageHeader
        title="Inbox"
        meta={
          mail ? (
            <span className="break-words">
              {mail.account || "Company mailbox"}
              {mail.last_sync ? ` · last sync ${formatRelative(mail.last_sync)}` : ""}
            </span>
          ) : (
            "No mailbox connected"
          )
        }
        actions={<VisibilityDrawer summary={summary.data} />}
      />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchInput
          value={qInput}
          onChange={setQInput}
          label="Search mail"
          placeholder="Search messages, senders or subjects"
          className="sm:flex-1"
        />
        <div className="flex gap-2">
          <Select
            aria-label="Which mail to show"
            value={f.state}
            onChange={(e) => update({ state: e.target.value })}
            options={STATE_FILTERS.map((x) => ({ value: x.value, label: x.label }))}
            className="min-w-0 flex-1 sm:w-48 sm:flex-none"
          />
          <Select
            aria-label="Sort order"
            value={f.sort}
            onChange={(e) => update({ sort: e.target.value })}
            options={[
              { value: "newest", label: "Newest first" },
              { value: "oldest", label: "Oldest first" },
            ]}
            className="min-w-0 flex-1 sm:w-40 sm:flex-none"
          />
        </div>
      </div>

      <Segmented label="Mail group" value={f.group} onChange={(g) => update({ group: g, category: "" })} options={groupOptions} />
      <p className="mt-2 text-sm text-ink-3">
        {GROUP_HINT[f.group]}
        {groupHidden ? `. ${GROUP_LABEL[f.group]} is switched off under Show and hide, so it stays out of combined lists. You can still read it here.` : ""}
      </p>

      {chipCats.length > 1 || hiddenCount > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
          {chipCats.length > 1 ? (
            <FilterChips
              label="Filter by category"
              value={f.category}
              onChange={(v) => update({ category: v.join(",") })}
              options={chipCats.map((c) => ({ value: c.key, label: categoryLabel(c.key), count: c.count }))}
            />
          ) : null}
          {hiddenCount > 0 ? (
            <Checkbox checked={f.hidden} onChange={(v) => update({ hidden: v })} label={`Include ${pluralize(hiddenCount, "hidden message")}`} />
          ) : null}
        </div>
      ) : null}

      <div className="mt-5">
        {f.group === "promotions" && !f.q && summary.data ? (
          <Candidates candidates={summary.data.unsubscribe_candidates} onUnsubscribe={setUnsub} />
        ) : null}

        <div className="mb-3 flex min-h-6 items-center gap-3 text-sm text-ink-3">
          {emails.data ? (
            <span className="tabular">
              {pluralize(total, "message")}
              {anyFilter ? " match" : ""}
            </span>
          ) : null}
          {emails.isFetching && !emails.isLoading ? <Spinner className="size-4" label="Updating" /> : null}
          {anyFilter && emails.data ? (
            <Button variant="link" size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          ) : null}
        </div>

        <QueryState
          query={emails}
          loading={
            <Panel>
              <LoadingRows rows={8} />
            </Panel>
          }
          isEmpty={(d) => d.items.length === 0}
          empty={<Panel>{empty}</Panel>}
        >
          {(d) => (
            <div className={cn("transition-opacity duration-150", emails.isPlaceholderData && "opacity-60")} aria-busy={emails.isFetching || undefined}>
              <Panel className="hidden overflow-hidden lg:block">
                <EmailTable
                  items={d.items}
                  group={f.group}
                  selected={selected}
                  onToggle={onToggle}
                  onToggleAll={onToggleAll}
                  onUnsubscribe={setUnsub}
                  iconOf={(k) => iconNames.get(k)}
                />
                <Pager offset={(d.page - 1) * d.page_size} limit={d.page_size} total={d.total} onChange={(o) => update({ page: o / d.page_size + 1 })} />
              </Panel>

              <div className="lg:hidden">
                <div className="mb-2 px-1">
                  <Checkbox
                    checked={allSelected ? true : selected.size > 0 ? "indeterminate" : false}
                    onChange={onToggleAll}
                    label="Select all on this page"
                  />
                </div>
                <EmailCards
                  items={d.items}
                  group={f.group}
                  selected={selected}
                  onToggle={onToggle}
                  onUnsubscribe={setUnsub}
                  iconOf={(k) => iconNames.get(k)}
                />
                {d.total > d.page_size ? (
                  <Panel className="mt-3">
                    <Pager offset={(d.page - 1) * d.page_size} limit={d.page_size} total={d.total} onChange={(o) => update({ page: o / d.page_size + 1 })} />
                  </Panel>
                ) : null}
              </div>
            </div>
          )}
        </QueryState>
      </div>

      {selected.size > 0 ? (
        <BulkBar ids={[...selected]} restoring={f.state === "archived" || f.state === "ignored"} onClear={() => setSelected(new Set())} />
      ) : null}

      <UnsubscribeDialog target={unsub} onOpenChange={(o) => !o && setUnsub(null)} />
    </Page>
  );
}
