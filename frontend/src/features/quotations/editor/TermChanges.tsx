/**
 * Customer-requested term changes. Each detected request shows the template wording and the
 * requested wording together, the customer's own sentence and the enquiry, and what the quotation
 * actually prints (the agreed term). A person accepts the requested wording, keeps the template
 * wording with a reason, or asks the customer; nothing is preselected.
 */
import { useMutation } from "@tanstack/react-query";
import { ChevronDown, Clock, GitBranch } from "lucide-react";
import { Collapsible } from "radix-ui";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "@/api/client";
import { formatDate, formatDateTime, isRtl } from "@/lib/format";
import { projectHref } from "@/lib/routes";
import { Banner, Button, ChoiceCards, Chip, Dialog, EvidenceQuote, Field, Textarea, toast } from "@/ui";
import { useQuoteUpdated, type Quote, type QuoteDetail, type TermChange, type TermDecision } from "../api";
import { ExplainedError, Reason, TermStatusChip } from "../components";
import { detectedByLabel, isFrozen, revisionLabel, termChanges, termStatus, termText } from "../lib";
import { EditorSection, useNarrow } from "./sections";

const DECISION_LABEL: Record<TermDecision, string> = {
  accept: "Accept requested wording",
  retain: "Keep template wording",
  clarify: "Request clarification",
};

function Wording({ label, text, lang, strong }: { label: string; text: string | null | undefined; lang?: string; strong?: boolean }) {
  const t = (text ?? "").trim();
  return (
    <div className="min-w-0">
      <p className="text-sm text-ink-3">{label}</p>
      <p
        dir={lang === "ar" || isRtl(t) ? "rtl" : "auto"}
        className={strong ? "mt-0.5 whitespace-pre-line text-base font-medium text-ink" : "mt-0.5 whitespace-pre-line text-base text-ink"}
      >
        {t || <span className="font-normal text-ink-3">Empty</span>}
      </p>
    </div>
  );
}

function decisionSentence(c: TermChange): string {
  const s = termStatus(c);
  const verb = s === "accepted" ? "Accepted" : s === "retained" ? "Template wording kept" : s === "clarification" ? "Clarification requested" : "";
  return [
    verb + (c.decided_by ? ` by ${c.decided_by}` : ""),
    c.decided_at ? formatDateTime(c.decided_at) : null,
    c.revision ? `revision ${c.revision}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** One line for the folded section and the section list. */
export function termChangesSummary(changes: TermChange[]): string {
  const waiting = changes.filter((c) => termStatus(c) === "pending").length;
  return waiting
    ? `${changes.length} ${changes.length === 1 ? "request" : "requests"} · ${waiting} waiting for a decision`
    : `${changes.length} ${changes.length === 1 ? "request" : "requests"}, all decided`;
}

export function TermChangesPanel({ detail, dirty, onRevise }: { detail: QuoteDetail; dirty: boolean; onRevise: () => void }) {
  const q = detail.quotation;
  const changes = termChanges(q.data);
  const [deciding, setDeciding] = useState<TermChange | null>(null);
  const narrow = useNarrow();
  if (!changes.length) return null;
  const waiting = changes.filter((c) => termStatus(c) === "pending").length;
  const frozen = isFrozen(q.status);
  const enquiry = detail.enquiry;

  return (
    <>
      <EditorSection
        id="term-changes"
        flush
        defaultOpen={waiting > 0}
        title="Customer-requested term changes"
        description="Found in the customer's mail. A detected request is not part of the quotation until a person accepts it: the PDF prints the agreed term."
        summary={termChangesSummary(changes)}
        flag={
          waiting ? (
            <Chip tone="review" size="sm" icon={<Clock aria-hidden />}>
              {waiting} waiting for a decision
            </Chip>
          ) : null
        }
      >
        <ul className="divide-y divide-line">
          {changes.map((c) => {
            const status = termStatus(c);
            const agreed = termText(q.data.terms, c.key);
            const sameEnquiry = Boolean(c.enquiry_id && enquiry && c.enquiry_id === enquiry.id);
            const reason = q.status === "superseded" ? "This revision was replaced; decide on the current one." : !frozen && dirty ? "Save your changes first." : null;

            const provenance = (
              <p className="text-sm text-ink-3">
                {detectedByLabel(c.by)}
                {c.detected_at ? `, ${formatDate(c.detected_at)}` : ""}
                {c.enquiry_id && q.project_id ? (
                  <>
                    {" · "}
                    <Link to={projectHref(q.project_id, "enquiries")} className="font-medium text-brand-ink underline-offset-4 hover:underline">
                      {sameEnquiry && enquiry?.ref ? `Enquiry ${enquiry.ref}` : "The project's enquiry"}
                    </Link>
                  </>
                ) : null}
              </p>
            );
            const body = (
              <>
                <div className="grid gap-4 md:grid-cols-2">
                  <Wording label="Template wording" text={c.from} lang={q.language} />
                  <Wording label="Customer-requested wording" text={c.to} lang={q.language} strong />
                </div>

                <div>
                  <p className="mb-1.5 text-sm text-ink-3">The customer's sentence</p>
                  {c.evidence?.quote ? (
                    <EvidenceQuote evidence={c.evidence} />
                  ) : (
                    <p className="text-sm text-review">No source sentence was recorded. Check the customer's mail before you accept.</p>
                  )}
                </div>

                <dl className="grid gap-1 border-t border-line pt-3 sm:grid-cols-[14rem_1fr] sm:gap-x-6">
                  <dt className="text-sm text-ink-3">Agreed quotation term (prints on the PDF)</dt>
                  <dd dir={q.language === "ar" || isRtl(agreed) ? "rtl" : "auto"} className="whitespace-pre-line text-base text-ink">
                    {agreed || <span className="text-ink-3">Not filled</span>}
                  </dd>
                  {status !== "pending" ? (
                    <>
                      <dt className="text-sm text-ink-3">Decision</dt>
                      <dd className="text-sm text-ink-2">
                        {decisionSentence(c)}
                        {c.reason ? (
                          <span dir={isRtl(c.reason) ? "rtl" : "auto"} className="mt-0.5 block whitespace-pre-line text-ink">
                            {status === "clarification" ? "Question: " : "Reason: "}
                            {c.reason}
                          </span>
                        ) : null}
                      </dd>
                    </>
                  ) : null}
                </dl>

                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  {frozen && q.status !== "superseded" ? (
                    <Button variant="secondary" icon={<GitBranch />} onClick={onRevise} className="max-sm:w-full">
                      Create revision to change this
                    </Button>
                  ) : (
                    <Button
                      variant={status === "pending" ? "primary" : "secondary"}
                      onClick={() => setDeciding(c)}
                      disabled={Boolean(reason)}
                      className="max-sm:w-full"
                    >
                      {status === "pending" ? "Decide" : "Change decision"}
                    </Button>
                  )}
                  <Reason>{reason}</Reason>
                </div>
              </>
            );

            // Phones: a request nobody decided is open, a decided one folds to its decision.
            if (narrow)
              return (
                <li key={c.key}>
                  <Collapsible.Root defaultOpen={status === "pending"}>
                    <h3>
                      <Collapsible.Trigger className="group flex min-h-14 w-full items-start gap-3 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand">
                        <ChevronDown
                          aria-hidden
                          className="mt-0.5 size-5 shrink-0 text-ink-3 transition-transform duration-200 group-data-[state=closed]:-rotate-90"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base font-semibold text-ink">
                            {c.label || c.key}
                            <TermStatusChip change={c} size="sm" />
                          </span>
                          <span className="mt-0.5 block text-sm font-normal text-ink-3 group-data-[state=open]:hidden [overflow-wrap:anywhere]">
                            {status === "pending" ? (
                              <>
                                Asks for: <bdi>{(c.to ?? "").trim() || "a different wording"}</bdi>
                              </>
                            ) : (
                              decisionSentence(c)
                            )}
                          </span>
                        </span>
                      </Collapsible.Trigger>
                    </h3>
                    <Collapsible.Content className="space-y-4 px-4 pb-4">
                      {provenance}
                      {body}
                    </Collapsible.Content>
                  </Collapsible.Root>
                </li>
              );
            return (
              <li key={c.key} className="space-y-4 px-5 py-5">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold text-ink">{c.label || c.key}</h3>
                    {provenance}
                  </div>
                  <TermStatusChip change={c} />
                </div>
                {body}
              </li>
            );
          })}
        </ul>
        <p className="border-t border-line px-4 py-3 text-sm text-ink-3 sm:px-5">
          After approval, a different decision needs a new revision, with fresh approval and send authorization.
        </p>
      </EditorSection>
      <DecideDialog change={deciding} q={q} onClose={() => setDeciding(null)} />
    </>
  );
}

function DecideDialog({ change, q, onClose }: { change: TermChange | null; q: Quote; onClose: () => void }) {
  const updated = useQuoteUpdated();
  const [choice, setChoice] = useState<TermDecision | "">("");
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const decide = useMutation({
    mutationFn: (c: TermChange) =>
      api.post<Quote>(`/quotations/${q.id}/term-changes/${encodeURIComponent(c.key)}/decide`, {
        decision: choice,
        reason: reason.trim() || undefined,
      }),
    onSuccess: async (next, c) => {
      const label = c.label || c.key;
      const backToDraft = q.status === "needs_review" && next.status === "draft";
      toast.success(
        choice === "accept" ? `Requested wording accepted: ${label}` : choice === "retain" ? `Template wording kept: ${label}` : `Clarification requested: ${label}`,
        { description: backToDraft ? "The quotation went back to draft. Submit it for approval again." : `Recorded on ${revisionLabel(next)}.` },
      );
      onClose();
      await updated(next);
    },
  });
  const { reset } = decide;
  const key = change?.key;
  useEffect(() => {
    if (key) {
      setChoice("");
      setReason("");
      setTried(false);
      reset();
    }
  }, [key, reset]);

  if (!change) return null;
  const reasonMissing = choice === "retain" && !reason.trim();
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !decide.isPending && onClose()}
      title={`Decide: ${change.label || change.key}`}
      description="Choose what the quotation prints for this term. Your name, the date and the revision are recorded."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={decide.isPending}>
            Cancel
          </Button>
          <Button
            disabled={!choice}
            loading={decide.isPending}
            onClick={() => {
              setTried(true);
              if (choice && !reasonMissing) decide.mutate(change);
            }}
          >
            {choice ? DECISION_LABEL[choice] : "Choose a decision"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="space-y-4">
          <Wording label="Template wording" text={change.from} lang={q.language} />
          <Wording label="Customer-requested wording" text={change.to} lang={q.language} strong />
          {change.evidence?.quote ? (
            <div>
              <p className="mb-1.5 text-sm text-ink-3">The customer's sentence</p>
              <EvidenceQuote evidence={change.evidence} />
            </div>
          ) : null}
        </div>

        <ChoiceCards
          label="Decision"
          columns={1}
          value={choice}
          onChange={(v) => setChoice(v as TermDecision)}
          options={[
            {
              value: "accept",
              label: DECISION_LABEL.accept,
              description: "The quotation prints the customer's wording for this term.",
            },
            {
              value: "retain",
              label: DECISION_LABEL.retain,
              description: "The quotation keeps the template wording. Say why: the reason is recorded.",
            },
            {
              value: "clarify",
              label: DECISION_LABEL.clarify,
              description: "Nothing changes yet. Record the question you ask the customer.",
            },
          ]}
        />

        {choice === "retain" ? (
          <Field label="Reason" required htmlFor="term-reason" error={tried && reasonMissing ? "Say why the template wording stays." : undefined}>
            <Textarea
              id="term-reason"
              rows={3}
              value={reason}
              invalid={tried && reasonMissing}
              dir={isRtl(reason) ? "rtl" : "auto"}
              placeholder="e.g. Our standard validity applies to steel prices"
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
        ) : choice === "clarify" ? (
          <Field label="Question for the customer" optional htmlFor="term-question">
            <Textarea
              id="term-question"
              rows={3}
              value={reason}
              dir={isRtl(reason) ? "rtl" : "auto"}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
        ) : null}

        {q.status === "needs_review" && choice && choice !== "clarify" ? (
          <Banner tone="review" title="This quotation waits for approval">
            If the decision changes the printed term, the quotation goes back to draft and approval must be requested again.
          </Banner>
        ) : null}

        <ExplainedError error={decide.error} q={q} />
      </div>
    </Dialog>
  );
}
