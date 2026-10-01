/**
 * Change review (mockups 73, 74, 75): one detected change: what it was, what it is now, the quoted
 * sentence, the affected enquiry. A pending closing-date change applies only after a person confirms
 * it; a technical revision is not covered by an earlier engineer approval.
 */
import { ArrowDown, ArrowRight, CalendarCheck, Check, SearchX } from "lucide-react";
import { useId, useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "@/api/client";
import type { ProjectChange } from "@/api/types";
import { formatDate, formatDateTime } from "@/lib/format";
import { emailHref, projectHref } from "@/lib/routes";
import {
  Banner,
  Button,
  ConfirmDialog,
  EmptyState,
  EvidenceQuote,
  Field,
  KeyValue,
  Panel,
  PanelBody,
  PanelHeader,
  StatusChip,
  Textarea,
} from "@/ui";
import { useProjectMutation, type EnquiryRow } from "../api";
import { changeKindInfo, displayValue, withSource } from "../lib";
import { Bidi } from "../parts";
import type { TabProps } from "../ProjectLayout";

/** Changes that a previous engineer approval does not cover (backend/ess/pipeline/state.py). */
const REVISION_KINDS = new Set(["technical_revision", "addendum", "scope_change"]);

export function ChangeTab({ detail }: TabProps) {
  const { index = "" } = useParams();
  const p = detail.project;
  const i = /^\d+$/.test(index) ? Number(index) : -1;
  const change = i >= 0 ? p.changes?.[i] : undefined;
  if (!change) {
    return (
      <Panel>
        <EmptyState
          icon={<SearchX />}
          title="This change does not exist"
          action={
            <Button asChild variant="secondary">
              <Link to={projectHref(p.id)}>Open project</Link>
            </Button>
          }
        >
          It may have been removed, or the address is wrong. Open changes are listed on the project overview.
        </EmptyState>
      </Panel>
    );
  }
  return <ChangeView key={i} detail={detail} change={change} index={i} />;
}

function enquiryName(e: EnquiryRow): string {
  return e.customer?.name ?? "Unknown contractor";
}

function ChangeView({ detail, change, index }: TabProps & { change: ProjectChange; index: number }) {
  const p = detail.project;
  const id = useId();
  const kind = changeKindInfo(change.kind);
  const ev = change.evidence ? withSource(change.evidence, detail.emails, detail.files) : null;
  const emailId = change.email_id ?? (ev?.source_type === "email" ? ev.source_id : undefined);
  const email = emailId ? detail.emails.find((e) => e.id === emailId) : undefined;
  const enquiryId = change.enquiry_id ?? (typeof email?.enquiry_id === "string" ? email.enquiry_id : undefined);
  const enquiry = enquiryId ? detail.enquiries.find((e) => e.id === enquiryId) : undefined;

  const deadline = change.kind === "deadline_changed";
  const pending = deadline && !!change.pending_confirmation && !change.acknowledged;
  const revision = REVISION_KINDS.has(change.kind);
  const hasValues = (change.old_value ?? null) !== null || (change.new_value ?? null) !== null;
  // A deadline always shows before → after; an addendum number or a new scope line has no "before".
  const showOld = deadline || (change.old_value ?? null) !== null;
  // The backend applies a pending date to the named enquiry, or to every open one when none is named.
  const targets = change.enquiry_id ? (enquiry ? [enquiry] : []) : detail.enquiries.filter((e) => e.status === "open");
  const oldFor = (e: EnquiryRow) => e.due_date ?? (typeof change.old_value === "string" ? change.old_value : null);

  const [note, setNote] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const ack = useProjectMutation(
    (apply: boolean) =>
      api.post(`/projects/${encodeURIComponent(p.id)}/changes/${index}/acknowledge`, note.trim() ? { apply, note: note.trim() } : { apply }),
    {
      projectId: p.id,
      invalidate: [["enquiries"]],
      success: (_r, apply) => (pending && apply ? `Closing date changed to ${displayValue(change.new_value)}` : "Change acknowledged"),
      onSuccess: () => setConfirmOpen(false),
    },
  );

  const reviewApproved = detail.review?.decision === "approved";
  const revisionText = detail.review?.supersedes_id
    ? "The previous engineer approval does not cover this revision. A new review round is open."
    : reviewApproved
      ? "The engineer approval on record was given before this change and does not cover it. Review the scope again."
      : "No engineer approval covers this revision yet. The review must check it before the quotation is approved.";

  return (
    <div className="space-y-6">
      {change.acknowledged ? (
        <Banner tone="brand" title="Acknowledged" icon={<Check aria-hidden />}>
          By {change.acknowledged_by ?? "a person"}
          {change.acknowledged_at ? ` on ${formatDateTime(change.acknowledged_at)}` : ""}.
          {typeof change.applied === "string" && change.applied ? ` Closing date set to ${displayValue(change.applied)}.` : ""}
          {typeof change.note === "string" && change.note ? <Bidi text={change.note} as="p" className="mt-1 text-ink" /> : null}
        </Banner>
      ) : pending ? (
        <Banner tone="review" title="Needs your confirmation before the closing date changes">
          A new closing date was found in the customer's email. Check the quoted sentence, then confirm or keep the current date.
        </Banner>
      ) : null}
      {revision ? (
        <Banner
          tone="review"
          title="Engineer review needed for this revision"
          actions={
            <Button asChild size="sm" variant="secondary" className="w-full sm:w-auto">
              <Link to={projectHref(p.id, "review")}>Open review</Link>
            </Button>
          }
        >
          {revisionText}
        </Banner>
      ) : null}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <Panel className="min-w-0">
          <PanelHeader
            title={
              <span className="flex flex-wrap items-center gap-2">
                <StatusChip info={kind} size="sm" />
                <Bidi text={change.title} />
              </span>
            }
            description={change.date ? `Detected ${formatDate(change.date)}` : "Detection date not recorded"}
          />
          {hasValues && !showOld ? (
            <div className="border-b border-line px-5 py-4">
              <p className="text-sm text-ink-3">{kind.label}</p>
              <Bidi text={displayValue(change.new_value)} as="p" className="mt-1 text-2xl font-semibold text-ink tabular" />
            </div>
          ) : hasValues ? (
            <div className="grid grid-cols-1 border-b border-line md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
              <div className="px-5 py-4">
                <p className="text-sm text-ink-3">{deadline ? "Previous closing date" : "Before"}</p>
                <Bidi
                  text={change.old_value == null || change.old_value === "" ? "Not recorded" : displayValue(change.old_value)}
                  as="p"
                  className="mt-1 text-2xl font-semibold text-ink-2 tabular"
                />
              </div>
              <div className="flex items-center justify-center px-2 text-ink-3" aria-hidden>
                <ArrowRight className="hidden size-6 md:block" />
                <ArrowDown className="size-6 md:hidden" />
              </div>
              <div className="border-t border-line px-5 py-4 md:border-l md:border-t-0">
                <p className="text-sm text-ink-3">{deadline ? "New closing date" : "Now"}</p>
                <Bidi
                  text={change.new_value == null || change.new_value === "" ? "Not stated" : displayValue(change.new_value)}
                  as="p"
                  className="mt-1 text-2xl font-semibold text-ink tabular"
                />
              </div>
            </div>
          ) : null}
          <PanelBody>
            {ev?.quote ? (
              <EvidenceQuote evidence={ev} />
            ) : (
              <p className="text-sm text-ink-3">No sentence was quoted for this change. Open the source email to check it.</p>
            )}
          </PanelBody>
        </Panel>

        <div className="space-y-6">
          <Panel>
            <PanelHeader title="Details" />
            <PanelBody>
              <KeyValue
                labelWidth="sm"
                items={[
                  { label: "Kind", value: kind.label },
                  { label: "Detected", value: change.date ? formatDateTime(change.date) : null },
                  {
                    label: "Enquiry",
                    value: enquiry ? (
                      <Link to={projectHref(p.id, "enquiries")} className="text-brand-ink hover:underline">
                        <Bidi text={enquiryName(enquiry)} />
                        {enquiry.ref ? ` · ${enquiry.ref}` : ""}
                      </Link>
                    ) : deadline && !change.enquiry_id ? (
                      "Every open enquiry"
                    ) : null,
                    hint: enquiry ? `Closing date now ${formatDate(enquiry.due_date, "not set")}` : undefined,
                  },
                  {
                    label: "Source",
                    value: email ? (
                      <Link to={emailHref(email.id)} className="text-brand-ink hover:underline">
                        <Bidi text={email.from_name || email.from_email} />
                        {email.date ? ` · ${formatDate(email.date)}` : ""}
                      </Link>
                    ) : null,
                    hint: email?.subject ? <Bidi text={email.subject} /> : undefined,
                  },
                  {
                    label: "Status",
                    value: change.acknowledged ? "Acknowledged" : pending ? "Waits for confirmation" : "Open",
                  },
                ]}
              />
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHeader title="Actions" />
            <PanelBody className="space-y-3">
              {!change.acknowledged ? (
                <>
                  <Field label="Note" optional htmlFor={`${id}-note`}>
                    <Textarea
                      id={`${id}-note`}
                      rows={2}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="What you did about it"
                    />
                  </Field>
                  {pending ? (
                    <>
                      <Button className="w-full" icon={<CalendarCheck />} disabled={!targets.length} onClick={() => setConfirmOpen(true)}>
                        Confirm new closing date
                      </Button>
                      {!targets.length ? (
                        <p className="text-sm text-ink-3">There is no open enquiry to update. Acknowledge the change instead.</p>
                      ) : null}
                      <Button
                        variant="secondary"
                        className="h-auto min-h-10 w-full whitespace-normal py-2"
                        loading={ack.isPending && ack.variables === false}
                        onClick={() => ack.mutate(false)}
                      >
                        Acknowledge, keep the current date
                      </Button>
                    </>
                  ) : (
                    <Button className="w-full" icon={<Check />} loading={ack.isPending} onClick={() => ack.mutate(false)}>
                      Acknowledge
                    </Button>
                  )}
                </>
              ) : null}
              {revision ? (
                <Button asChild variant="secondary" className="w-full">
                  <Link to={projectHref(p.id, "review")}>Open review</Link>
                </Button>
              ) : null}
              <Button asChild variant="secondary" className="w-full">
                <Link to={projectHref(p.id)}>Open project</Link>
              </Button>
            </PanelBody>
          </Panel>
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Change the closing date?"
        description="The closing date and its reminders change only now, with your confirmation. The earlier date stays in the history with your name and this email as the source."
        confirmLabel="Confirm new closing date"
        loading={ack.isPending}
        onConfirm={() => ack.mutate(true)}
      >
        <ul className="space-y-3">
          {targets.map((e) => (
            <li key={e.id} className="rounded-lg bg-sunken px-3 py-2.5">
              <p className="font-medium text-ink">
                <Bidi text={enquiryName(e)} />
                {e.ref ? <span className="font-normal text-ink-3"> · {e.ref}</span> : null}
              </p>
              <p className="mt-1 text-ink-2 tabular">
                From <span className="text-ink">{formatDate(oldFor(e), "no date")}</span> to{" "}
                <strong className="font-semibold text-ink">{displayValue(change.new_value)}</strong>
              </p>
            </li>
          ))}
        </ul>
      </ConfirmDialog>
    </div>
  );
}
