/**
 * Approval and sending: the unmet conditions next to Approve, and the gates as ConfirmDialogs that
 * name the exact revision (approve, request changes, send, create revision). History of decisions.
 */
import { useMutation } from "@tanstack/react-query";
import { Check, CircleCheck, CircleX, ExternalLink, GitBranch, Mail, PenOff, Send } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { api } from "@/api/client";
import { useCurrentUser, useSession, useWorkspace } from "@/api/session";
import type { Approval } from "@/api/types";
import { cn } from "@/lib/cn";
import { formatDate, formatDateTime, isRtl } from "@/lib/format";
import { quotationHref } from "@/lib/routes";
import {
  Banner,
  Button,
  ChoiceCards,
  CollapsibleSection,
  ConfirmDialog,
  Dialog,
  Field,
  Input,
  KeyValue,
  Panel,
  PanelBody,
  PanelHeader,
  Textarea,
  Timeline,
  toast,
  type TimelineItem,
} from "@/ui";
import { pdfUrl, useInvalidate, useQuotations, useQuoteUpdated, quoteKeys, type Quote, type QuoteDetail, type SendResult } from "../api";
import { ExplainedError, GateList, QuoteStatusChip, Reason } from "../components";
import {
  blockerGates,
  blockersOf,
  describeApproval,
  EMAIL_RE,
  money,
  pdfFileName,
  revisionLabel,
  splitAddresses,
  totals,
  useRoleGate,
} from "../lib";

/** The newest revision of the same enquiry, for a superseded quotation. */
function useCurrentRevision(q: Quote) {
  const list = useQuotations({ project_id: q.project_id }, q.status === "superseded");
  if (q.status !== "superseded") return null;
  const newer = (list.data?.items ?? []).filter((x) => x.id !== q.id && x.enquiry_id === q.enquiry_id && x.version > q.version);
  return newer.sort((a, b) => b.version - a.version)[0] ?? null;
}

const DRAFT_NOTICE =
  "Draft PDFs carry no signature and no stamp. An empty signature space means the quotation is not signed off yet.";

export function ApprovalPanel({
  detail,
  dirty,
  onRevise,
  className,
}: {
  detail: QuoteDetail;
  dirty: boolean;
  onRevise: () => void;
  className?: string;
}) {
  const q = detail.quotation;
  const session = useSession();
  const roleGate = useRoleGate();
  const updated = useQuoteUpdated();
  const current = useCurrentRevision(q);
  const rev = revisionLabel(q);
  const blockers = blockersOf(q, detail);
  const n = blockers.length;
  const [approveOpen, setApproveOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);

  const submit = useMutation({
    mutationFn: () => api.post<Quote>(`/quotations/${q.id}/submit`),
    onSuccess: async (next) => {
      toast.success(`${rev} submitted for approval`, { description: "It waits in Approvals." });
      await updated(next);
    },
  });

  const saveFirst = dirty ? "Save your changes first." : null;
  const checklist =
    n > 0 ? (
      <div>
        <p className="text-sm font-medium text-ink">
          Before {rev} can be approved ({n} open):
        </p>
        <GateList gates={blockerGates(blockers, q, true)} compact className="mt-1" />
      </div>
    ) : (
      <p className="flex items-center gap-2 text-sm font-medium text-brand-ink">
        <CircleCheck className="size-5 shrink-0" aria-hidden />
        Every condition for approval is met.
      </p>
    );
  const lastRequest = [...(q.change_requests ?? [])].reverse().find((c) => c && c.note);
  const requestNote = lastRequest ? (
    <Banner
      tone={q.status === "changes_requested" ? "block" : "neutral"}
      title={`${q.status === "changes_requested" ? "Changes requested" : "Last change request"}${lastRequest.by ? ` by ${lastRequest.by}` : ""}${lastRequest.at ? `, ${formatDate(lastRequest.at)}` : ""}`}
    >
      <span dir={isRtl(lastRequest.note) ? "rtl" : "auto"} className="block whitespace-pre-line text-ink">
        {lastRequest.note}
      </span>
    </Banner>
  ) : null;

  let body: ReactNode = null;
  let actions: ReactNode = null;
  let error: unknown = null;
  switch (q.status) {
    case "draft":
    case "changes_requested": {
      error = submit.error;
      body = (
        <div className="space-y-4">
          {requestNote ?? <p className="text-sm text-ink-2">Submit it for approval when the lines, prices and terms are ready.</p>}
          {checklist}
        </div>
      );
      actions = (
        <>
          <Button className="w-full" icon={<Send />} onClick={() => submit.mutate()} loading={submit.isPending} disabled={Boolean(saveFirst)}>
            Submit for approval
          </Button>
          <Reason>{saveFirst ?? (n ? "You can submit now; approval stays blocked until every condition is met." : null)}</Reason>
        </>
      );
      break;
    }
    case "needs_review": {
      const reason =
        saveFirst ?? roleGate("engineer", "Approving a quotation") ?? (n ? `Approval waits for the ${n === 1 ? "open condition" : `${n} open conditions`}.` : null);
      body = (
        <div className="space-y-4">
          <p className="text-sm text-ink-2">Waits for commercial approval of this exact revision.</p>
          {requestNote}
          {checklist}
        </div>
      );
      actions = (
        <>
          <Button className="w-full" icon={<CircleCheck />} onClick={() => setApproveOpen(true)} disabled={Boolean(reason)}>
            Approve {rev}
          </Button>
          <Reason>{reason}</Reason>
          <Button variant="secondary" className="w-full" onClick={() => setChangesOpen(true)} disabled={Boolean(saveFirst)}>
            Request changes
          </Button>
        </>
      );
      break;
    }
    case "approved": {
      const mail = session.data?.mail;
      const reason =
        roleGate("engineer", "Sending a quotation") ??
        (mail && mail.status !== "connected" ? "Connect a mailbox first (Settings, Connections)." : null);
      body = (
        <div className="space-y-2 text-sm text-ink-2">
          <p>
            <span className="font-medium text-ink">Approved{q.approved_by ? ` by ${q.approved_by}` : ""}</span>
            {q.approved_at ? ` on ${formatDateTime(q.approved_at)}` : ""}. This revision is frozen: a change needs a new revision
            with fresh approval and send authorization.
          </p>
          {q.mail_draft_id ? (
            <p className="flex items-start gap-2">
              <Mail className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
              Saved as a mail draft. Send it from your mailbox, or send it from here.
            </p>
          ) : null}
        </div>
      );
      actions = (
        <>
          <Button className="w-full" icon={<Send />} onClick={() => setSendOpen(true)} disabled={Boolean(reason)}>
            Send quotation
          </Button>
          <Reason>{reason}</Reason>
          <Button variant="secondary" className="w-full" icon={<GitBranch />} onClick={onRevise}>
            Create revision
          </Button>
        </>
      );
      break;
    }
    case "sent": {
      const last = detail.approvals.filter((a) => a.action === "send_quotation").at(-1);
      const to = last ? describeApproval(last).recipients : [];
      body = (
        <div className="space-y-2 text-sm text-ink-2">
          <p>
            <span className="font-medium text-ink">Sent{q.sent_at ? ` on ${formatDateTime(q.sent_at)}` : ""}</span>
            {to.length ? ` to ${to.join(", ")}` : ""}.
          </p>
          <p>Sent is not accepted: the enquiry now waits for the customer's response.</p>
        </div>
      );
      actions = (
        <Button variant="secondary" className="w-full" icon={<GitBranch />} onClick={onRevise}>
          Create revision
        </Button>
      );
      break;
    }
    case "superseded":
      body = <p className="text-sm text-ink-2">A newer revision replaced this one. It stays on record as it was.</p>;
      actions = current ? (
        <Button className="w-full" asChild>
          <Link to={quotationHref(current.id)}>Open {revisionLabel(current)}</Link>
        </Button>
      ) : null;
      break;
  }

  const final = q.status === "approved" || q.status === "sent";
  return (
    <Panel className={className}>
      <PanelHeader title="Approval and sending" description={`Revision ${rev}`} actions={<QuoteStatusChip q={q} />} />
      <PanelBody className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
        <div className="min-w-0 space-y-4">
          {body}
          {!final && q.status !== "superseded" ? (
            <p className="flex items-start gap-2 text-sm text-ink-3">
              <PenOff className="mt-0.5 size-4 shrink-0" aria-hidden />
              {DRAFT_NOTICE}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-2">
          {actions}
          <ExplainedError error={error} q={q} />
        </div>
      </PanelBody>

      <ApproveDialog open={approveOpen} onOpenChange={setApproveOpen} detail={detail} />
      <RequestChangesDialog open={changesOpen} onOpenChange={setChangesOpen} q={q} />
      <SendDialog open={sendOpen} onOpenChange={setSendOpen} detail={detail} />
    </Panel>
  );
}

/* ------------------------------------------------------------------ approve */

function ApproveDialog({ open, onOpenChange, detail }: { open: boolean; onOpenChange: (o: boolean) => void; detail: QuoteDetail }) {
  const q = detail.quotation;
  const ws = useWorkspace();
  const user = useCurrentUser();
  const updated = useQuoteUpdated();
  const rev = revisionLabel(q);
  const [note, setNote] = useState("");
  const approve = useMutation({
    mutationFn: () => api.post<Quote>(`/quotations/${q.id}/approve`, { note: note.trim() }),
    onSuccess: async (next) => {
      toast.success(`${rev} approved`, { description: "The final PDF carries the signature and stamp. Sending is the next step." });
      onOpenChange(false);
      await updated(next);
    },
  });
  const { reset } = approve;
  useEffect(() => {
    if (open) {
      setNote("");
      reset();
    }
  }, [open, reset]);

  const currency = q.data.currency || ws.currency;
  const t = totals(q.data.items);
  const lines = q.data.items?.length ?? 0;
  const signer = detail.signatory;
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Approve ${rev}?`}
      description={`You approve this exact revision${user ? ` as ${user.name}` : ""}. The record names you, the date and the revision.`}
      confirmLabel={`Approve ${rev}`}
      loading={approve.isPending}
      onConfirm={() => approve.mutate()}
    >
      <div className="space-y-4">
        <KeyValue
          labelWidth="sm"
          items={[
            { label: "Revision", value: <span className="tabular">{rev}</span> },
            { label: "Addressed to", value: detail.customer?.name ?? q.data.to?.company ?? "—" },
            {
              label: "Total",
              value: t.total !== null ? <span className="tabular">{money(t.total, currency)}</span> : `${lines} ${lines === 1 ? "line" : "lines"}, no printed total`,
            },
            { label: "Signatory", value: signer ? `${signer.full_name || signer.initials} (${signer.initials})` : "Default signatory" },
          ]}
        />
        <div>
          <p className="text-sm font-medium text-ink">What happens</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-ink-2">
            <li>This revision is frozen. Any later change needs a new revision with fresh approval.</li>
            <li>The final PDF is rendered with the signature image and the company stamp, where they are installed.</li>
            <li>Nothing is sent yet. Sending is a separate, confirmed step.</li>
          </ul>
        </div>
        <Field label="Note" optional htmlFor="approve-note">
          <Textarea id="approve-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <ExplainedError error={approve.error} q={q} />
      </div>
    </ConfirmDialog>
  );
}

/* ------------------------------------------------------------------ request changes */

function RequestChangesDialog({ open, onOpenChange, q }: { open: boolean; onOpenChange: (o: boolean) => void; q: Quote }) {
  const updated = useQuoteUpdated();
  const rev = revisionLabel(q);
  const [note, setNote] = useState("");
  const [tried, setTried] = useState(false);
  const request = useMutation({
    mutationFn: () => api.post<Quote>(`/quotations/${q.id}/request-changes`, { note: note.trim() }),
    onSuccess: async (next) => {
      toast.success(`Changes requested on ${rev}`, { description: "The note is in the approval history." });
      onOpenChange(false);
      await updated(next);
    },
  });
  const { reset } = request;
  useEffect(() => {
    if (open) {
      setNote("");
      setTried(false);
      reset();
    }
  }, [open, reset]);
  const missing = !note.trim();
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !request.isPending && onOpenChange(o)}
      title={`Request changes to ${rev}`}
      description="The quotation goes back to the person who prepares it, with your note."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={request.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              setTried(true);
              if (!missing) request.mutate();
            }}
            loading={request.isPending}
          >
            Request changes
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="What must change" required htmlFor="rc-note" error={tried && missing ? "Write what must change." : undefined}>
          <Textarea
            id="rc-note"
            rows={5}
            value={note}
            invalid={tried && missing}
            dir={isRtl(note) ? "rtl" : "auto"}
            placeholder="e.g. Item 3: price the anchors separately. Validity must follow the customer's 90 days."
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        <p className="text-sm text-ink-3">The note is recorded in the approval history with your name and the date.</p>
        <ExplainedError error={request.error} q={q} />
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ send */

function SendDialog({ open, onOpenChange, detail }: { open: boolean; onOpenChange: (o: boolean) => void; detail: QuoteDetail }) {
  const q = detail.quotation;
  const session = useSession();
  const updated = useQuoteUpdated();
  const rev = revisionLabel(q);
  // Read the defaults when the dialog opens only: a background refetch must not wipe what the person typed.
  const defaults = useRef(detail.send_defaults);
  defaults.current = detail.send_defaults;
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [mode, setMode] = useState("");
  const recipients = splitAddresses(to);
  const bad = recipients.filter((r) => !EMAIL_RE.test(r));
  const send = useMutation({
    mutationFn: () =>
      api.post<SendResult>(`/quotations/${q.id}/send`, { to: recipients, subject, body, send_now: mode === "now", confirm: true }),
    onSuccess: async (r) => {
      if (r.sent)
        toast.success(`${rev} sent to ${recipients.join(", ")}`, {
          description: "The enquiry now waits for the customer's response. Sent is not accepted.",
        });
      else toast.success("Saved as a mail draft", { description: "Open the drafts in your mailbox to send it." });
      onOpenChange(false);
      await updated({ ...q, status: r.sent ? "sent" : q.status, mail_draft_id: r.draft_id });
    },
  });
  const { reset } = send;
  useEffect(() => {
    if (open) {
      setTo(defaults.current.to.join(", "));
      setSubject(defaults.current.subject);
      setBody(defaults.current.body);
      setMode("");
      reset();
    }
  }, [open, reset]);

  const mailbox = session.data?.mail?.account;
  const ready = recipients.length > 0 && bad.length === 0 && Boolean(mode) && subject.trim().length > 0;
  const confirmLabel = mode === "now" ? `Send now to ${recipients.length} ${recipients.length === 1 ? "recipient" : "recipients"}` : mode === "draft" ? "Save mail draft" : "Choose how to send";
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Send ${rev}`}
      description="Check the recipients, the message and the attachment. Sending does not mean the customer accepted."
      confirmLabel={confirmLabel}
      disabled={!ready}
      loading={send.isPending}
      onConfirm={() => send.mutate()}
    >
      <div className="space-y-4">
        <KeyValue
          labelWidth="sm"
          items={[
            { label: "From", value: mailbox ?? <span className="text-ink-3">The connected mailbox</span> },
            {
              label: "Approved",
              value: `${q.approved_by ?? "—"}${q.approved_at ? `, ${formatDate(q.approved_at)}` : ""}`,
              hint: `Revision ${rev}`,
            },
            {
              label: "Attachment",
              value: (
                <a
                  href={pdfUrl(q.id, q.pdf_rendered_at)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 break-all font-medium text-brand-ink underline-offset-4 hover:underline"
                >
                  {pdfFileName(q)}
                  <ExternalLink className="size-3.5 shrink-0" aria-hidden />
                </a>
              ),
            },
          ]}
        />
        <Field
          label="To"
          required
          htmlFor="send-to"
          hint="Separate addresses with commas. Taken from the enquiry's message headers."
          error={bad.length ? `Not an e-mail address: ${bad.join(", ")}` : recipients.length === 0 ? "Add at least one recipient." : undefined}
        >
          <Input id="send-to" dir="ltr" value={to} invalid={bad.length > 0} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="Subject" required htmlFor="send-subject">
          <Input id="send-subject" value={subject} dir={isRtl(subject) ? "rtl" : "auto"} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="Message" htmlFor="send-body">
          <Textarea id="send-body" rows={7} value={body} dir={isRtl(body) ? "rtl" : "auto"} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <ChoiceCards
          label="How to send"
          columns={1}
          value={mode}
          onChange={setMode}
          options={[
            { value: "draft", label: "Save as mail draft", description: "The message waits in your mailbox drafts. You send it from there." },
            { value: "now", label: "Send now", description: "The mailbox sends it at once. This cannot be undone." },
          ]}
        />
        <ExplainedError error={send.error} q={q} />
      </div>
    </ConfirmDialog>
  );
}

/* ------------------------------------------------------------------ revise */

export function ReviseDialog({
  open,
  onOpenChange,
  q,
  carry,
  leave,
  context,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  q: Quote;
  /** Unsaved edits to apply to the new revision (they could not be saved on a frozen one). */
  carry?: Record<string, unknown> | null;
  leave: (to: string) => void;
  context?: ReactNode;
}) {
  const invalidate = useInvalidate();
  const revise = useMutation({
    mutationFn: async () => {
      const next = await api.post<Quote>(`/quotations/${q.id}/revise`);
      if (carry) await api.put<Quote>(`/quotations/${next.id}`, carry);
      return next;
    },
    onSuccess: async (next) => {
      toast.success(`Revision v${next.version} created`, { description: "It starts as a draft: approval and send authorization are needed again." });
      onOpenChange(false);
      await invalidate(...quoteKeys(q.id, q.project_id));
      leave(quotationHref(next.id));
    },
  });
  const { reset } = revise;
  useEffect(() => {
    if (open) reset();
  }, [open, reset]);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Create revision v${q.version + 1}?`}
      description={`${revisionLabel(q)} stays on record exactly as it is.`}
      confirmLabel="Create revision"
      loading={revise.isPending}
      onConfirm={() => revise.mutate()}
    >
      <div className="space-y-3 text-sm text-ink-2">
        {context}
        <ul className="list-disc space-y-1 pl-5">
          <li>{revisionLabel(q)} is marked superseded and keeps its approval record.</li>
          <li>The new revision starts as a draft with the same lines, prices, terms and decisions.</li>
          <li>It needs approval and send authorization again before it can be sent.</li>
          {carry ? <li>Your unsaved changes are applied to the new revision.</li> : null}
        </ul>
        <ExplainedError error={revise.error} q={q} />
      </div>
    </ConfirmDialog>
  );
}

/* ------------------------------------------------------------------ history */

function revisionOf(a: Approval): { rev: string | null; pdf: string | null } {
  const [rev, pdf] = (a.revision ?? "").split(" pdf:");
  return { rev: rev || null, pdf: pdf || null };
}

function approvalItem(a: Approval, showRevision = true): TimelineItem {
  const info = describeApproval(a);
  const { rev, pdf } = revisionOf(a);
  return {
    title: `${info.label}${info.recipients.length ? ` to ${info.recipients.join(", ")}` : ""}`,
    when: formatDateTime(a.created_at),
    tone: info.tone,
    icon: info.tone === "block" ? <CircleX /> : <Check />,
    detail: (
      <div className="space-y-0.5">
        <p>
          By {a.decided_by || "—"}
          {showRevision && rev ? ` · ${rev}` : ""}
          {pdf ? (
            <span className="text-ink-3">
              {" "}
              · PDF <span className="font-mono text-xs">{pdf}</span>
            </span>
          ) : null}
        </p>
        {a.action !== "send_quotation" && a.note ? (
          <p dir={isRtl(a.note) ? "rtl" : "auto"} className={cn("whitespace-pre-line text-ink")}>
            {a.note}
          </p>
        ) : null}
      </div>
    ),
  };
}

export function HistoryPanel({ detail }: { detail: QuoteDetail }) {
  const rows = [...detail.approvals].sort((a, b) => b.created_at.localeCompare(a.created_at));
  return (
    <CollapsibleSection
      title="Approval history"
      summary={rows.length ? `${rows.length} ${rows.length === 1 ? "record" : "records"}` : "No decisions yet"}
    >
      {rows.length === 0 ? (
        <p className="text-sm text-ink-3">
          Approvals, change requests and sends appear here with the person, the date and the exact revision.
        </p>
      ) : (
        <Timeline items={rows.map((a) => approvalItem(a))} />
      )}
    </CollapsibleSection>
  );
}
