/**
 * How a message was filed (mockup 13/54): the category with who decided it, how sure the system is,
 * the reason and the quoted evidence, and "Change category", which also teaches the system.
 */
import { GraduationCap } from "lucide-react";
import { useState } from "react";
import { useCategoryLabel, useSession } from "@/api/session";
import type { Email, Evidence } from "@/api/types";
import { humanize } from "@/lib/format";
import { Button, Confidence, Dialog, EvidenceQuote, Field, InlineError, KeyValue, Panel, PanelBody, PanelHeader, Select, toast } from "@/ui";
import { useUpdateEmail, type EmailDetail } from "./api";
import { iconFor } from "./categoryIcon";
import { GROUP_LABEL, LOW_CONFIDENCE, categorySourceLabel, isMailGroup } from "./labels";
import { IntentLabel, LowConfidenceChip, dirOf, useCategoryChoices } from "./parts";

/** Where in the message the AI found a quote (backend/ess/ai/tasks.py classify_email "source" keys). */
const QUOTE_SOURCE: Record<string, string> = {
  subject: "Subject line",
  body: "Message text",
  from: "Sender",
  attachments: "Attachment names",
  headers: "Mail headers",
};

/** Category evidence comes in two shapes: {quote, source: "subject"} or the snapshot {quote, source_label, verified}. */
function evidenceOf(email: Email): Evidence[] {
  return (email.category_evidence ?? [])
    .filter((e) => !!e?.quote)
    .map((e) => {
      const src = typeof e.source === "string" ? e.source : undefined;
      return {
        quote: e.quote,
        source_type: "email",
        source_label: e.source_label ?? (src ? (QUOTE_SOURCE[src] ?? humanize(src)) : "This message"),
        verified: e.verified,
      };
    });
}

/** Corrections for these categories are also learned for the whole sender domain (backend/ess/learning.py). */
const DOMAIN_LEARNED = ["promotions", "notifications", "bills", "vendor_offer"];

function ChangeCategoryDialog({ email, open, onOpenChange }: { email: Email; open: boolean; onOpenChange: (o: boolean) => void }) {
  const choices = useCategoryChoices();
  const label = useCategoryLabel();
  const own = useSession().data?.workspace?.own_domains ?? [];
  const update = useUpdateEmail();
  const [value, setValue] = useState(email.category);
  const sender = (email.from_email || "").toLowerCase();
  const domain = sender.includes("@") ? sender.split("@")[1] : "";
  const changed = value !== email.category;
  const learnsDomain = !!domain && !own.map((d) => d.toLowerCase()).includes(domain) && DOMAIN_LEARNED.includes(value);

  const save = () =>
    update.mutate(
      { id: email.id, patch: { category: value } },
      {
        onSuccess: () => {
          toast.success("Category changed", { description: `Later mail from ${email.from_email} is filed under ${label(value)}.` });
          onOpenChange(false);
        },
      },
    );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (update.isPending) return;
        if (o) {
          setValue(email.category);
          update.reset();
        }
        onOpenChange(o);
      }}
      title="Change category"
      description="Choose the category this message belongs in."
      hideClose={update.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={update.isPending}>
            Cancel
          </Button>
          <Button onClick={save} loading={update.isPending} disabled={!changed}>
            Change category
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Category" htmlFor="change-category">
          <Select
            id="change-category"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            options={choices.map((c) => ({ value: c.key, label: `${c.groupLabel}: ${c.label}` }))}
          />
        </Field>
        <p className="flex gap-2.5 rounded-lg border border-line bg-sunken px-3.5 py-2.5 text-sm text-ink-2">
          <GraduationCap className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
          <span>
            Saving also <span className="font-semibold text-ink">teaches the system</span>. From now on, mail from{" "}
            <span className="break-all font-medium text-ink">{email.from_email}</span> is filed under{" "}
            <span className="font-medium text-ink">{changed ? label(value) : "the category you choose"}</span>
            {learnsDomain ? (
              <>
                , and so is mail from anyone at <span className="font-medium text-ink">{domain}</span>
              </>
            ) : null}
            . You can switch the lesson off under Settings, Learned corrections.
          </span>
        </p>
        <InlineError error={update.error} />
      </div>
    </Dialog>
  );
}

export function CategoryPanel({ detail }: { detail: EmailDetail }) {
  const { email, category } = detail;
  const [open, setOpen] = useState(false);
  const Icon = iconFor(category?.icon);
  const byPerson = email.category_source === "user";
  const uncertain = !byPerson && email.category_confidence < LOW_CONFIDENCE;
  const group = category ? (isMailGroup(category.group) ? GROUP_LABEL[category.group] : humanize(category.group)) : null;
  const evidence = evidenceOf(email);

  return (
    <Panel>
      <PanelHeader
        title="How it was filed"
        actions={
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
            Change category
          </Button>
        }
      />
      <PanelBody className="space-y-4">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-sunken text-ink-2" aria-hidden>
            <Icon className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="break-words text-base font-semibold text-ink">{category?.label ?? email.category}</p>
            {group ? <p className="text-sm text-ink-3">{group} mail</p> : null}
          </div>
        </div>
        <KeyValue
          labelWidth="sm"
          items={[
            { label: "Decided by", value: categorySourceLabel(email.category_source) },
            {
              label: "Confidence",
              value: byPerson ? (
                "Set by a person"
              ) : (
                <span className="flex flex-wrap items-center gap-2">
                  <Confidence value={email.category_confidence} />
                  {uncertain ? <LowConfidenceChip /> : null}
                </span>
              ),
            },
            { label: "Mail intent", value: <IntentLabel intent={email.intent} /> },
          ]}
        />
        <div>
          <h3 className="text-sm font-semibold text-ink">Why this category</h3>
          <p className="mt-1 break-words text-sm text-ink-2" dir={dirOf(email.category_reason)}>
            {email.category_reason || "No reason was recorded."}
          </p>
          {evidence.length ? (
            <div className="mt-2 space-y-2">
              {evidence.map((ev, i) => (
                <EvidenceQuote key={i} evidence={ev} href={null} />
              ))}
            </div>
          ) : (
            <p className="mt-1 text-xs text-ink-3">No quote was recorded for this category.</p>
          )}
        </div>
      </PanelBody>
      <ChangeCategoryDialog email={email} open={open} onOpenChange={setOpen} />
    </Panel>
  );
}
