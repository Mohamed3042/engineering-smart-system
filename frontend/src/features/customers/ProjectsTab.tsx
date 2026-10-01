/**
 * Projects and enquiries with one customer (mockup 59): stage, closing date (with earlier dates),
 * our reply, the customer's response and the quotation. Sent is not accepted.
 */
import { FolderOpen } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useCategoryLabel } from "@/api/session";
import type { Enquiry } from "@/api/types";
import { cn } from "@/lib/cn";
import { daysUntil, formatDate, formatDateShort, humanize } from "@/lib/format";
import { customerResponseInfo, enquiryStatusInfo, quotationStatusInfo, stageInfo, type StatusInfo } from "@/lib/labels";
import { projectHref, quotationHref } from "@/lib/routes";
import { EmptyState, ListRow, Panel, RowChevron, Segmented, StatusChip, Table, TBody, TD, TH, THead, TR } from "@/ui";
import type { CustomerProjectRef, CustomerQuotationRef } from "./api";
import { useCustomerContext } from "./CustomerLayout";

interface Row {
  key: string;
  project: CustomerProjectRef;
  enquiry: Enquiry | null;
  quotation: CustomerQuotationRef | null;
  closing: string | null;
  earlier: string[];
  received: string | null;
}

type Filter = "all" | "open" | "quoted" | "closed";

const OUR_REPLY: Record<string, StatusInfo> = {
  quoted: { label: "Quoted", tone: "brand" },
  forwarded: { label: "Forwarded internally", tone: "neutral" },
  declined: { label: "Declined by us", tone: "muted" },
  regretted: { label: "Regretted", tone: "muted" },
};

function ourReplyInfo(e: Enquiry | null): StatusInfo {
  if (!e) return { label: "—", tone: "muted" };
  const s = (e.our_response?.status as string | undefined) ?? "none";
  if (s === "none" || !s) return e.status === "open" ? { label: "No reply yet", tone: "review" } : { label: "No reply", tone: "muted" };
  return OUR_REPLY[s] ?? { label: humanize(s), tone: "neutral" };
}

function filterOf(r: Row): Exclude<Filter, "all"> {
  const st = r.enquiry?.status ?? "open";
  if (["won", "lost", "declined", "closed"].includes(st)) return "closed";
  if (st === "quoted" || r.enquiry?.our_response?.status === "quoted") return "quoted";
  return "open";
}

function ClosingDate({ date, earlier, open }: { date: string | null; earlier: string[]; open: boolean }) {
  if (!date) return <span className="text-ink-3">No date</span>;
  const n = daysUntil(date);
  const soon = open && n !== null && n >= 0 && n <= 7;
  const past = n !== null && n < 0;
  return (
    <div className="space-y-0.5">
      <p className="whitespace-nowrap tabular text-ink">{formatDate(date)}</p>
      <p className={cn("text-xs tabular", soon ? "font-medium text-review" : "text-ink-3")}>
        {past ? "Closed" : n === 0 ? "Closes today" : n === 1 ? "Closes tomorrow" : `In ${n} days`}
      </p>
      {earlier.length ? <p className="text-xs text-ink-3 tabular">Was {earlier.map((d) => formatDateShort(d)).join(", ")}</p> : null}
    </div>
  );
}

export function ProjectsTab() {
  const { detail } = useCustomerContext();
  const catLabel = useCategoryLabel();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>("all");

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const p of detail.projects) {
      const enquiries = detail.enquiries.filter((e) => e.project_id === p.id);
      const quotes = detail.quotations.filter((q) => q.project_id === p.id);
      const list: (Enquiry | null)[] = enquiries.length ? enquiries : [null];
      for (const e of list) {
        const quotation = (e?.quotation_id ? quotes.find((q) => q.id === e.quotation_id) : null) ?? quotes[0] ?? null;
        const closing = e?.due_date ?? p.due_date ?? null;
        const earlier = (e?.due_date_history ?? [])
          .map((h) => String(h.value ?? "").slice(0, 10))
          .filter((v) => v && v !== closing);
        out.push({
          key: `${p.id}-${e?.id ?? "p"}`,
          project: p,
          enquiry: e,
          quotation,
          closing,
          earlier: [...new Set(earlier)],
          received: e?.received_at ?? null,
        });
      }
    }
    return out.sort((a, b) => new Date(b.received ?? 0).getTime() - new Date(a.received ?? 0).getTime());
  }, [detail]);

  const counts = useMemo(() => {
    const c = { all: rows.length, open: 0, quoted: 0, closed: 0 };
    rows.forEach((r) => c[filterOf(r)]++);
    return c;
  }, [rows]);
  const shown = filter === "all" ? rows : rows.filter((r) => filterOf(r) === filter);

  if (rows.length === 0) {
    return (
      <Panel>
        <EmptyState icon={<FolderOpen />} title="No projects with this company yet">
          Projects appear here when an enquiry from this company is linked to one. Enquiries come in through the mailbox scan.
        </EmptyState>
      </Panel>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">Projects and enquiries</h2>
          <p className="text-sm text-ink-3">What this company asked us for, and where each request stands.</p>
        </div>
        <Segmented
          label="Show"
          value={filter}
          onChange={(v) => setFilter(v as Filter)}
          options={[
            { value: "all", label: "All", count: counts.all },
            { value: "open", label: "Open", count: counts.open },
            { value: "quoted", label: "Quoted", count: counts.quoted },
            { value: "closed", label: "Closed", count: counts.closed },
          ]}
        />
      </div>

      {shown.length === 0 ? (
        <Panel>
          <EmptyState compact title="Nothing in this group">
            Choose All to see every project with this company.
          </EmptyState>
        </Panel>
      ) : (
        <>
          <Panel className="hidden overflow-hidden lg:block">
            <Table>
              <THead>
                <tr>
                  <TH>Project</TH>
                  <TH>Stage</TH>
                  <TH>Closing date</TH>
                  <TH>Our reply</TH>
                  <TH>Customer response</TH>
                  <TH>Quotation</TH>
                  <TH className="w-10">
                    <span className="sr-only">Open</span>
                  </TH>
                </tr>
              </THead>
              <TBody>
                {shown.map((r) => {
                  const reply = ourReplyInfo(r.enquiry);
                  const detailText = r.enquiry?.our_response?.detail as string | undefined;
                  return (
                    <TR key={r.key} onClick={() => navigate(projectHref(r.project.id))}>
                      <TD className="min-w-[16rem] max-w-[24rem]">
                        <Link
                          to={projectHref(r.project.id)}
                          onClick={(e) => e.stopPropagation()}
                          className="font-semibold text-ink outline-none hover:text-brand-ink hover:underline focus-visible:ring-2 focus-visible:ring-brand"
                        >
                          {r.project.name}
                        </Link>
                        <p className="mt-0.5 text-sm text-ink-3">
                          {catLabel(r.project.service_family)}
                          {r.enquiry?.ref ? ` · ${r.enquiry.ref}` : ""}
                          {r.received ? ` · received ${formatDateShort(r.received)}` : ""}
                        </p>
                      </TD>
                      <TD>
                        <StatusChip info={stageInfo(r.project.stage)} size="sm" />
                      </TD>
                      <TD>
                        <ClosingDate date={r.closing} earlier={r.earlier} open={filterOf(r) === "open"} />
                      </TD>
                      <TD className="max-w-[15rem]">
                        <StatusChip info={reply} size="sm" />
                        {detailText ? (
                          <p className="mt-1 line-clamp-2 text-xs text-ink-3" title={detailText}>
                            {detailText}
                          </p>
                        ) : null}
                      </TD>
                      <TD>
                        <StatusChip info={customerResponseInfo(r.enquiry?.customer_response ?? "none")} size="sm" />
                        {r.enquiry && r.enquiry.status !== "open" ? (
                          <p className="mt-1 text-xs text-ink-3">Enquiry {enquiryStatusInfo(r.enquiry.status).label.toLowerCase()}</p>
                        ) : null}
                      </TD>
                      <TD>
                        {r.quotation ? (
                          <div className="space-y-1">
                            <Link
                              to={quotationHref(r.quotation.id)}
                              onClick={(e) => e.stopPropagation()}
                              className="block whitespace-nowrap font-medium text-brand-ink tabular hover:underline"
                            >
                              {r.quotation.reference || "Draft"}
                            </Link>
                            <StatusChip info={quotationStatusInfo(r.quotation.status)} size="sm" />
                          </div>
                        ) : (
                          <span className="text-sm text-ink-3">No quotation</span>
                        )}
                      </TD>
                      <TD className="pt-5">
                        <RowChevron />
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </Panel>

          <div className="space-y-3 lg:hidden">
            {shown.map((r) => (
              <ListRow
                key={r.key}
                to={projectHref(r.project.id)}
                title={r.project.name}
                subtitle={[catLabel(r.project.service_family), r.enquiry?.ref].filter(Boolean).join(" · ")}
                aside={<StatusChip info={stageInfo(r.project.stage)} size="sm" />}
              >
                <dl className="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-2">
                  <dt className="text-ink-3">Closing</dt>
                  <dd>
                    <ClosingDate date={r.closing} earlier={r.earlier} open={filterOf(r) === "open"} />
                  </dd>
                  <dt className="text-ink-3">Our reply</dt>
                  <dd>
                    <StatusChip info={ourReplyInfo(r.enquiry)} size="sm" />
                  </dd>
                  <dt className="text-ink-3">Customer</dt>
                  <dd>
                    <StatusChip info={customerResponseInfo(r.enquiry?.customer_response ?? "none")} size="sm" />
                  </dd>
                  <dt className="text-ink-3">Quotation</dt>
                  <dd className="min-w-0">
                    {r.quotation ? (
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-ink tabular">{r.quotation.reference || "Draft"}</span>
                        <StatusChip info={quotationStatusInfo(r.quotation.status)} size="sm" />
                      </span>
                    ) : (
                      <span className="text-ink-3">No quotation</span>
                    )}
                  </dd>
                </dl>
              </ListRow>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
