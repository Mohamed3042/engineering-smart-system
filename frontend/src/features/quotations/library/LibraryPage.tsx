import { CircleCheck, Clock, FilePlus2, FileText, Plus, Settings2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useWorkspace } from "@/api/session";
import { cn } from "@/lib/cn";
import { formatDate, formatRelative } from "@/lib/format";
import { serviceFamilyShort } from "@/lib/labels";
import { quotationHref } from "@/lib/routes";
import {
  Button,
  Chip,
  Count,
  EmptyState,
  ErrorState,
  ListRow,
  LoadingRows,
  Page,
  PageHeader,
  Panel,
  RowChevron,
  SearchInput,
  Segmented,
  Select,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  type SortDir,
} from "@/ui";
import { useQuotations, useTemplates, type QuoteListItem } from "../api";
import { ImpactChip, QuoteStatusChip } from "../components";
import { languageLabel, money, pendingTermChanges, templateName, totals } from "../lib";
import { NewQuotationDialog } from "./NewQuotationDialog";

const STATUS_TABS = [
  { value: "all", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "needs_review", label: "Needs review" },
  { value: "changes_requested", label: "Changes requested" },
  { value: "approved", label: "Approved" },
  { value: "sent", label: "Sent" },
] as const;

type SortKey = "reference" | "updated";

/** Customer-requested terms nobody decided yet (they block approval). */
function TermsChip({ q }: { q: QuoteListItem }) {
  const n = pendingTermChanges(q.data).length;
  if (!n) return null;
  return (
    <Chip tone="review" size="sm" icon={<Clock aria-hidden />}>
      {n} {n === 1 ? "term" : "terms"} to decide
    </Chip>
  );
}

function PricesCell({ q, currency }: { q: QuoteListItem; currency: string }) {
  const items = q.data.items ?? [];
  const missing = q.missing_prices?.length ?? 0;
  if (!items.length) return <span className="text-sm text-ink-3">No lines</span>;
  if (missing)
    return (
      <span className="text-sm font-medium text-review tabular">
        {missing} of {items.length} missing
      </span>
    );
  const t = totals(items);
  if (t.missingQty)
    return (
      <span className="text-sm font-medium text-review tabular">
        {t.missingQty} without quantity
      </span>
    );
  return <span className="text-sm text-ink tabular">{t.total !== null ? money(t.total, currency) : "All priced"}</span>;
}

export function LibraryPage() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "all";
  const template = params.get("template") ?? "";
  const search = params.get("q") ?? "";
  const newFor = params.get("new");
  const [newOpen, setNewOpen] = useState(Boolean(newFor));
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "updated", dir: "desc" });

  const list = useQuotations({});
  const templates = useTemplates();

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value && value !== "all") next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const items = useMemo(() => {
    const rows = list.data?.items ?? [];
    const needle = search.trim().toLowerCase();
    const filtered = rows.filter((q) => {
      if (status !== "all" && q.status !== status) return false;
      if (template && q.template_key !== template) return false;
      if (!needle) return true;
      const hay = [q.reference, q.project?.name, q.customer?.name, templateName(templates.data, q.template_key), q.data.subject]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(needle);
    });
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) =>
      sort.key === "reference"
        ? a.reference.localeCompare(b.reference, undefined, { numeric: true }) * dir
        : (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0) * dir,
    );
  }, [list.data, status, template, search, sort, templates.data]);

  const counts = list.data?.counts ?? {};
  const total = list.data?.items.length ?? 0;
  // The approval queue holds quotations submitted for approval (approved ones wait to be sent, not approved).
  const waiting = counts.needs_review ?? 0;
  const filtersOn = status !== "all" || Boolean(template) || Boolean(search);
  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "updated" ? "desc" : "asc" }));

  const templateOptions = (templates.data ?? []).map((t) => ({ value: t.key, label: t.label.en }));

  return (
    <Page>
      <PageHeader
        title="Quotations"
        meta="Official quotations drafted from enquiries. A person enters every price."
        actions={
          <>
            <Button variant="secondary" asChild>
              <Link to="/quotations/approvals">
                <CircleCheck className="size-[1.125rem]" aria-hidden />
                Approvals
                {waiting ? <Count value={waiting} tone="review" /> : null}
              </Link>
            </Button>
            <Button variant="secondary" asChild>
              <Link to="/quotations/setup">
                <Settings2 className="size-[1.125rem]" aria-hidden />
                Quotation setup
              </Link>
            </Button>
            <Button icon={<Plus />} onClick={() => setNewOpen(true)} className="max-md:w-full">
              New quotation
            </Button>
          </>
        }
      />

      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center">
        <SearchInput
          value={search}
          onChange={(v) => set("q", v)}
          placeholder="Search reference, project or customer"
          label="Search quotations"
          className="lg:max-w-sm lg:flex-1"
        />
        <Segmented
          label="Status"
          value={status}
          onChange={(v) => set("status", v)}
          options={STATUS_TABS.map((t) => ({
            value: t.value,
            label: t.label,
            count: t.value === "all" ? total : (counts[t.value] ?? 0),
          }))}
        />
        <Select
          aria-label="Template"
          value={template}
          onChange={(e) => set("template", e.target.value)}
          placeholder="All templates"
          options={templateOptions}
          className="lg:ml-auto lg:w-56"
        />
      </div>

      {list.isLoading ? (
        <Panel>
          <LoadingRows rows={6} />
        </Panel>
      ) : list.isError ? (
        <Panel>
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        </Panel>
      ) : total === 0 ? (
        <Panel>
          <EmptyState
            icon={<FileText />}
            title="No quotations yet"
            action={
              <Button icon={<FilePlus2 />} onClick={() => setNewOpen(true)}>
                Start a quotation
              </Button>
            }
          >
            A draft appears here when an enquiry is ready to quote, or when you start one for a project. The official
            template is chosen for you; prices stay empty until a person enters them.
          </EmptyState>
        </Panel>
      ) : items.length === 0 ? (
        <Panel>
          <EmptyState
            compact
            title="No quotation matches"
            action={
              filtersOn ? (
                <Button variant="secondary" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                  Clear filters
                </Button>
              ) : null
            }
          >
            Try another reference, project or customer name, or clear the filters.
          </EmptyState>
        </Panel>
      ) : (
        <>
          {/* Desktop table */}
          <Panel className="hidden lg:block">
            <Table>
              <THead>
                <tr>
                  <TH sort={sort.key === "reference" ? sort.dir : null} onSort={() => toggleSort("reference")}>
                    Reference
                  </TH>
                  <TH>Project</TH>
                  <TH>Customer</TH>
                  <TH>Template</TH>
                  <TH>Status</TH>
                  <TH>Prices</TH>
                  <TH sort={sort.key === "updated" ? sort.dir : null} onSort={() => toggleSort("updated")}>
                    Updated
                  </TH>
                  <TH>
                    <span className="sr-only">Open</span>
                  </TH>
                </tr>
              </THead>
              <TBody>
                {items.map((q) => (
                  <TR key={q.id} onClick={() => navigate(quotationHref(q.id))}>
                    <TD className="whitespace-nowrap">
                      <Link
                        to={quotationHref(q.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="font-semibold text-brand-ink tabular underline-offset-4 hover:underline"
                      >
                        {q.reference || "Draft"}
                      </Link>
                      <span className="ml-1.5 text-sm text-ink-3 tabular">v{q.version}</span>
                    </TD>
                    <TD className="max-w-72">
                      <p className="line-clamp-2 text-ink">{q.project?.name ?? "—"}</p>
                      {q.project ? <p className="text-sm text-ink-3">{serviceFamilyShort(q.project.service_family)}</p> : null}
                    </TD>
                    <TD className="max-w-56">
                      <p className="line-clamp-2 text-ink-2">{q.customer?.name ?? "—"}</p>
                    </TD>
                    <TD className="whitespace-nowrap">
                      <p className="text-ink-2">{templateName(templates.data, q.template_key)}</p>
                      <p className="text-sm text-ink-3">{languageLabel(q.language)}</p>
                    </TD>
                    <TD>
                      <div className="flex flex-col items-start gap-1.5">
                        <QuoteStatusChip q={q} />
                        <ImpactChip q={q} />
                        <TermsChip q={q} />
                      </div>
                    </TD>
                    <TD className="whitespace-nowrap">
                      <PricesCell q={q} currency={q.data.currency || ws.currency} />
                    </TD>
                    <TD className="whitespace-nowrap text-sm text-ink-2" title={formatDate(q.updated_at)}>
                      {formatRelative(q.updated_at)}
                    </TD>
                    <TD className="w-10">
                      <RowChevron />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Panel>

          {/* Phone and tablet cards */}
          <ul className="space-y-3 lg:hidden">
            {items.map((q) => (
              <li key={q.id}>
                <ListRow
                  to={quotationHref(q.id)}
                  title={
                    <span className="tabular">
                      {q.reference || "Draft"} <span className="font-normal text-ink-3">v{q.version}</span>
                    </span>
                  }
                  aside={<QuoteStatusChip q={q} size="sm" />}
                  subtitle={q.project?.name ?? "No project"}
                  footer={
                    <div className="flex items-end justify-between gap-3">
                      <div className="text-sm">
                        <p className="text-ink-3">Updated</p>
                        <p className="text-ink-2">{formatDate(q.updated_at)}</p>
                      </div>
                      <PricesCell q={q} currency={q.data.currency || ws.currency} />
                    </div>
                  }
                >
                  <p className={cn("text-ink-2")}>
                    {[q.customer?.name, `${templateName(templates.data, q.template_key)} · ${languageLabel(q.language)}`]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {q.impact_review?.required || pendingTermChanges(q.data).length ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <ImpactChip q={q} />
                      <TermsChip q={q} />
                    </div>
                  ) : null}
                </ListRow>
              </li>
            ))}
          </ul>
        </>
      )}

      <NewQuotationDialog
        open={newOpen}
        onOpenChange={(o) => {
          setNewOpen(o);
          if (!o && newFor) set("new", "");
        }}
        initialProjectId={newFor}
        initialEnquiryId={params.get("enquiry")}
      />
    </Page>
  );
}
