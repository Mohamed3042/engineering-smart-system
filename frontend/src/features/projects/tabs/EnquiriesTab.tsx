/**
 * Enquiries: one row per contractor asking for this project. Each enquiry owns its contact,
 * closing-date history, our status, the customer's response (sent is not accepted) and its quotation.
 */
import { CalendarClock, Ellipsis, FilePlus2, History, MessageSquareReply, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "@/api/client";
import type { Quotation } from "@/api/types";
import { cn } from "@/lib/cn";
import { formatDate, formatDateTime } from "@/lib/format";
import { customerResponseInfo, enquiryStatusInfo, quotationStatusInfo } from "@/lib/labels";
import { customerHref, quotationHref } from "@/lib/routes";
import {
  Banner,
  Button,
  DateInput,
  Dialog,
  EmptyState,
  EvidenceQuote,
  evidenceHref,
  Field,
  IconButton,
  InlineError,
  Menu,
  Panel,
  Popover,
  Select,
  StatusChip,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Textarea,
  type MenuItem,
} from "@/ui";
import { useProjectMutation, type EnquiryRow } from "../api";
import { historySource, replacedDates, withSource } from "../lib";
import { Bidi, DueDate } from "../parts";
import type { TabProps } from "../ProjectLayout";

const RESPONSES = ["none", "awaiting", "clarification", "accepted", "rejected"];
const NEEDS_NOTE = new Set(["accepted", "rejected", "clarification"]);

export function EnquiriesTab({ detail }: TabProps) {
  const p = detail.project;
  const navigate = useNavigate();
  const [responding, setResponding] = useState<EnquiryRow | null>(null);
  const [dating, setDating] = useState<EnquiryRow | null>(null);

  const create = useProjectMutation(
    (e: EnquiryRow) => api.post<Quotation>("/quotations", { project_id: p.id, enquiry_id: e.id }),
    {
      projectId: p.id,
      invalidate: [["quotations"], ["enquiries"]],
      success: (q) => `Quotation ${q.reference || ""} created. Prices start empty.`,
      onSuccess: (q) => navigate(quotationHref(q.id)),
    },
  );
  const setStatus = useProjectMutation(
    ({ e, status }: { e: EnquiryRow; status: string }) => api.patch(`/enquiries/${e.id}`, { status }),
    {
      projectId: p.id,
      invalidate: [["enquiries"]],
      success: (_r, v) => `Our status: ${enquiryStatusInfo(v.status).label}`,
    },
  );

  const quoteFor = (e: EnquiryRow): Quotation | undefined =>
    detail.quotations.find((q) => q.id === e.quotation_id) ??
    detail.quotations.find((q) => q.enquiry_id === e.id && q.status !== "superseded");

  if (!detail.enquiries.length) {
    return (
      <Panel>
        <EmptyState icon={<UsersRound />} title="No contractor enquiries yet">
          Each contractor who asks us to price this project becomes one enquiry, with its own closing date, response and
          quotation. They appear here when the mailbox scan links their email to this project.
        </EmptyState>
      </Panel>
    );
  }

  const menuFor = (e: EnquiryRow): MenuItem[] => [
    { label: "Record customer response", icon: <MessageSquareReply />, onSelect: () => setResponding(e) },
    { label: "Change closing date", icon: <CalendarClock />, onSelect: () => setDating(e) },
    ...(
      [
        ["quoted", "Mark as quoted"],
        ["declined", "Mark as declined"],
        ["won", "Mark as won"],
        ["lost", "Mark as lost"],
        ["open", "Reopen"],
      ] as const
    )
      .filter(([s]) => s !== e.status)
      .map(([s, label], i) => ({
        label,
        separatorBefore: i === 0,
        onSelect: () => setStatus.mutate({ e, status: s }),
      })),
  ];

  const quotationCell = (e: EnquiryRow, full?: boolean) => {
    const q = quoteFor(e);
    if (q) {
      return (
        <div className={cn("flex flex-col items-start gap-2", full && "items-stretch")}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink">{q.reference || "Draft quotation"}</span>
            <span className="text-sm text-ink-3">v{q.version}</span>
            <StatusChip info={quotationStatusInfo(q.status)} size="sm" />
          </div>
          <Button asChild size="sm" variant="secondary" className={full ? "w-full" : undefined}>
            <Link to={quotationHref(q.id)}>Open quotation</Link>
          </Button>
        </div>
      );
    }
    return (
      <Button
        size="sm"
        icon={<FilePlus2 />}
        className={full ? "w-full" : undefined}
        loading={create.isPending && create.variables?.id === e.id}
        disabled={!!p.archived_at}
        onClick={() => create.mutate(e)}
      >
        Create quotation for this contractor
      </Button>
    );
  };

  return (
    <div className="space-y-4">
      <p className="max-w-[75ch] text-sm text-ink-3">
        {detail.enquiries.length === 1
          ? "One contractor asked for this project."
          : `${detail.enquiries.length} contractors asked for this project. Each one gets its own quotation and answer.`}{" "}
        Sending an offer does not mean the customer accepted it.
      </p>

      <Panel className="hidden overflow-hidden lg:block">
        <Table>
          <THead>
            <tr>
              <TH>Contractor</TH>
              <TH>Closing date</TH>
              <TH>Our status</TH>
              <TH>Customer response</TH>
              <TH>Quotation</TH>
              <TH>
                <span className="sr-only">Actions</span>
              </TH>
            </tr>
          </THead>
          <TBody>
            {detail.enquiries.map((e) => (
              <TR key={e.id}>
                <TD className="max-w-[16rem]">
                  <ContractorName e={e} />
                  <div className="mt-0.5 text-sm text-ink-3">
                    {enquiryMeta(e)}
                  </div>
                  <Contact e={e} className="mt-2" />
                </TD>
                <TD className="max-w-[15rem]">
                  <ClosingDate e={e} detail={detail} />
                </TD>
                <TD className="max-w-[13rem]">
                  <OurStatus e={e} />
                </TD>
                <TD>
                  <div className="flex flex-col items-start gap-1.5">
                    <StatusChip info={customerResponseInfo(e.customer_response || "none")} size="sm" />
                    {e.customer_response_at ? (
                      <span className="text-xs text-ink-3">{formatDate(e.customer_response_at)}</span>
                    ) : null}
                    <Button variant="link" size="sm" onClick={() => setResponding(e)} disabled={!!p.archived_at}>
                      Record response
                    </Button>
                  </div>
                </TD>
                <TD>{quotationCell(e)}</TD>
                <TD className="w-12">
                  <Menu
                    trigger={
                      <IconButton label="Enquiry actions" size="sm" disabled={!!p.archived_at}>
                        <Ellipsis />
                      </IconButton>
                    }
                    items={menuFor(e)}
                  />
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Panel>

      <ul className="space-y-3 lg:hidden" aria-label="Enquiries">
        {detail.enquiries.map((e) => (
          <li key={e.id} className="rounded-xl border border-line bg-surface p-4 shadow-panel">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <ContractorName e={e} />
                <div className="mt-0.5 text-sm text-ink-3">
                  {enquiryMeta(e)}
                </div>
              </div>
              <Menu
                trigger={
                  <IconButton label="Enquiry actions" size="sm" disabled={!!p.archived_at}>
                    <Ellipsis />
                  </IconButton>
                }
                items={menuFor(e)}
              />
            </div>
            <dl className="mt-3 grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-sm">
              <dt className="text-ink-3">Contact</dt>
              <dd className="min-w-0">
                <Contact e={e} />
              </dd>
              <dt className="text-ink-3">Closing date</dt>
              <dd className="min-w-0">
                <ClosingDate e={e} detail={detail} />
              </dd>
              <dt className="text-ink-3">Our status</dt>
              <dd className="min-w-0">
                <OurStatus e={e} />
              </dd>
              <dt className="text-ink-3">Customer response</dt>
              <dd className="min-w-0">
                <StatusChip info={customerResponseInfo(e.customer_response || "none")} size="sm" />
                {e.customer_response_at ? <div className="mt-1 text-xs text-ink-3">{formatDate(e.customer_response_at)}</div> : null}
              </dd>
            </dl>
            <div className="mt-3 grid gap-2 border-t border-line pt-3">
              <Button variant="secondary" size="sm" icon={<MessageSquareReply />} onClick={() => setResponding(e)} disabled={!!p.archived_at}>
                Record customer response
              </Button>
              {quotationCell(e, true)}
            </div>
          </li>
        ))}
      </ul>

      <ResponseDialog enquiry={responding} projectId={p.id} onClose={() => setResponding(null)} />
      <ClosingDateDialog enquiry={dating} projectId={p.id} onClose={() => setDating(null)} />
    </div>
  );
}

/* ------------------------------------------------------------------ cells */

const enquiryMeta = (e: EnquiryRow) =>
  [e.ref, e.received_at ? `received ${formatDate(e.received_at)}` : null].filter(Boolean).join(" · ");

function ContractorName({ e }: { e: EnquiryRow }) {
  if (!e.customer) return <span className="font-semibold text-ink">Unknown sender</span>;
  return (
    <Link to={customerHref(e.customer.id)} className="font-semibold text-ink hover:underline">
      <Bidi text={e.customer.name} className="break-words" />
    </Link>
  );
}

function Contact({ e, className }: { e: EnquiryRow; className?: string }) {
  const c = e.contact ?? {};
  if (!c.name && !c.email) return <span className={cn("text-ink-3", className)}>—</span>;
  return (
    <div className={cn("min-w-0", className)}>
      {c.name ? <Bidi text={String(c.name)} as="div" className="break-words text-ink" /> : null}
      {c.email ? (
        <a href={`mailto:${c.email}`} className="block break-all text-sm text-ink-3 hover:text-ink hover:underline">
          {String(c.email)}
        </a>
      ) : null}
      {c.phone ? <div className="text-sm text-ink-3 tabular">{String(c.phone)}</div> : null}
    </div>
  );
}

/** Our status (open, quoted …) and our response: whether and when our offer went out. */
function OurStatus({ e }: { e: EnquiryRow }) {
  const ours = (e.our_response ?? {}) as { status?: string; detail?: string; date?: string };
  const offered = ours.status === "quoted";
  return (
    <div className="flex flex-col items-start gap-1">
      <StatusChip info={enquiryStatusInfo(e.status)} size="sm" />
      <p className="text-xs text-ink-3">
        {offered ? `Offer sent${ours.date ? ` ${formatDate(ours.date)}` : ""}` : "No offer sent yet"}
        {offered && ours.detail ? (
          <>
            {" · "}
            <Bidi text={ours.detail} />
          </>
        ) : null}
      </p>
    </div>
  );
}

function ClosingDate({ e, detail }: { e: EnquiryRow; detail: TabProps["detail"] }) {
  // Each history entry holds a date that was replaced, newest first.
  const earlier = replacedDates(e);
  const withQuotes = earlier.some((h) => h.evidence?.quote || h.note);
  return (
    <div className="flex items-start gap-1">
      <div className="min-w-0">
        <DueDate value={e.due_date} />
        {earlier.length ? (
          <ul className="mt-1 space-y-0.5 text-xs text-ink-3" aria-label="Earlier closing dates">
            {earlier.map((h, i) => {
              const ev = h.evidence ? withSource(h.evidence, detail.emails, detail.files) : null;
              const href = ev ? evidenceHref(ev) : null;
              return (
                <li key={i}>
                  <s className="tabular">{formatDate(h.value)}</s> · {historySource(h)}
                  {href?.startsWith("/") ? (
                    <>
                      {" · "}
                      <Link to={href} className="text-brand-ink hover:underline">
                        {ev?.source_type === "email" ? "email" : "source"}
                      </Link>
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
      {withQuotes ? (
        <Popover
          align="start"
          className="w-[min(26rem,calc(100vw-2rem))]"
          trigger={
            <IconButton label="Closing date history" size="sm">
              <History />
            </IconButton>
          }
        >
          <p className="mb-2 text-sm font-semibold text-ink">Closing date history</p>
          <ol className="max-h-[60vh] space-y-3 overflow-y-auto">
            <li className="text-sm">
              <span className="font-semibold text-ink tabular">{formatDate(e.due_date, "No closing date")}</span>
              <span className="ml-2 text-xs text-ink-3">Current</span>
            </li>
            {earlier.map((h, i) => {
              const ev = h.evidence ? withSource(h.evidence, detail.emails, detail.files) : null;
              return (
                <li key={i} className="text-sm">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <s className="text-ink-3 tabular">{formatDate(h.value)}</s>
                    <span className="text-xs text-ink-3">Superseded · {historySource(h)}</span>
                  </div>
                  {h.note ? <Bidi text={h.note} as="p" className="mt-0.5 text-xs text-ink-3" /> : null}
                  {ev?.quote ? <EvidenceQuote evidence={ev} className="mt-1.5" /> : null}
                </li>
              );
            })}
          </ol>
        </Popover>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ dialogs */

function ResponseDialog({ enquiry, projectId, onClose }: { enquiry: EnquiryRow | null; projectId: string; onClose: () => void }) {
  const [value, setValue] = useState("awaiting");
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  useEffect(() => {
    if (enquiry) {
      setValue(enquiry.customer_response && enquiry.customer_response !== "none" ? enquiry.customer_response : "awaiting");
      setNote("");
      setNoteError(null);
    }
  }, [enquiry]);
  const save = useProjectMutation(
    () => api.patch(`/enquiries/${enquiry?.id}`, { customer_response: value, note: note.trim() }),
    {
      projectId,
      invalidate: [["enquiries"]],
      toastErrors: false,
      success: () => `Customer response recorded: ${customerResponseInfo(value).label}`,
      onSuccess: onClose,
    },
  );
  const submit = () => {
    if (NEEDS_NOTE.has(value) && !note.trim()) {
      setNoteError("Say where the customer's answer is, for example the email and its date.");
      return;
    }
    save.mutate();
  };
  return (
    <Dialog
      open={!!enquiry}
      onOpenChange={(o) => !o && !save.isPending && onClose()}
      title="Record customer response"
      description={enquiry?.customer ? `${enquiry.customer.name}${enquiry.ref ? ` · ${enquiry.ref}` : ""}` : enquiry?.ref}
      hideClose={save.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={save.isPending}>
            Save response
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Banner tone="neutral" title="Sent is not accepted">
          Record acceptance only when you have the customer's written answer.
        </Banner>
        <Field label="Customer response">
          <Select
            value={value}
            onChange={(ev) => setValue(ev.target.value)}
            options={RESPONSES.map((r) => ({ value: r, label: customerResponseInfo(r).label }))}
          />
        </Field>
        <Field
          label="Evidence"
          required={NEEDS_NOTE.has(value)}
          optional={!NEEDS_NOTE.has(value)}
          error={noteError}
          hint="Where the answer is: the email, letter or call, and its date."
        >
          <Textarea
            rows={3}
            value={note}
            invalid={!!noteError}
            onChange={(ev) => {
              setNote(ev.target.value);
              if (noteError) setNoteError(null);
            }}
            placeholder="Email from the contractor, 3 Oct: accepts our offer"
          />
        </Field>
        {enquiry?.customer_response_at ? (
          <p className="text-sm text-ink-3">
            Last recorded {formatDateTime(enquiry.customer_response_at)}: {customerResponseInfo(enquiry.customer_response).label}
          </p>
        ) : null}
        <InlineError error={save.error} />
      </div>
    </Dialog>
  );
}

function ClosingDateDialog({ enquiry, projectId, onClose }: { enquiry: EnquiryRow | null; projectId: string; onClose: () => void }) {
  const [date, setDate] = useState("");
  useEffect(() => {
    if (enquiry) setDate(enquiry.due_date ?? "");
  }, [enquiry]);
  const save = useProjectMutation(() => api.patch(`/enquiries/${enquiry?.id}`, { due_date: date }), {
    projectId,
    invalidate: [["enquiries"]],
    toastErrors: false,
    success: () => `Closing date set to ${formatDate(date)}`,
    onSuccess: onClose,
  });
  return (
    <Dialog
      open={!!enquiry}
      onOpenChange={(o) => !o && !save.isPending && onClose()}
      title="Change closing date"
      description={enquiry?.customer?.name ?? enquiry?.ref}
      size="sm"
      hideClose={save.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!date || date === enquiry?.due_date}>
            Save closing date
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="New closing date" hint="The earlier date stays in the history, with your name.">
          <DateInput value={date} onChange={setDate} />
        </Field>
        {enquiry?.due_date ? <p className="text-sm text-ink-3">Current: {formatDate(enquiry.due_date)}</p> : null}
        <InlineError error={save.error} />
      </div>
    </Dialog>
  );
}
