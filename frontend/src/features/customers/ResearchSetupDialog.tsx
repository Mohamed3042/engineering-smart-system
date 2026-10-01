/**
 * Research setup (mockup 32). The backend takes one choice, the evidence standard, plus whether to
 * keep watching the company for news. The cards spell out what each standard needs.
 */
import { Check, Globe, Mail, Search } from "lucide-react";
import { useState } from "react";
import type { Customer, ResearchReport } from "@/api/types";
import { pluralize } from "@/lib/format";
import { Button, ChoiceCards, Dialog, InlineError, Switch, toast } from "@/ui";
import { useStartResearch } from "./api";
import { RESEARCH_STANDARDS, standardInfo } from "./lib";

export function ResearchSetupDialog({
  customer,
  open,
  onOpenChange,
  onStarted,
  defaultStandard = "standard",
}: {
  customer: Customer;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onStarted?: (r: ResearchReport) => void;
  defaultStandard?: string;
}) {
  const [standard, setStandard] = useState(defaultStandard);
  const [monitor, setMonitor] = useState(customer.monitoring);
  const start = useStartResearch(customer.id);
  const info = standardInfo(standard);

  const submit = () =>
    start.mutate(
      { standard, monitor },
      {
        onSuccess: (r) => {
          toast.success(`Research started for ${customer.name}`, { description: "It usually takes one to three minutes. You can leave this page." });
          onOpenChange(false);
          onStarted?.(r);
        },
      },
    );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (start.isPending) return;
        if (o) {
          setStandard(defaultStandard);
          setMonitor(customer.monitoring);
          start.reset();
        }
        onOpenChange(o);
      }}
      size="lg"
      title={`Research ${customer.name}`}
      description="Searches the web and our own mail with this company. Every claim must quote where it came from."
      hideClose={start.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={start.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={start.isPending} icon={<Search />}>
            Start {info.label.toLowerCase()} research
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <section className="space-y-3">
          <div>
            <h3 className="font-semibold text-ink">Evidence standard</h3>
            <p className="text-sm text-ink-3">How much proof a finding needs before it counts. Anything below the bar is listed as a gap, not hidden.</p>
          </div>
          <ChoiceCards
            label="Evidence standard"
            value={standard}
            onChange={setStandard}
            columns={1}
            options={RESEARCH_STANDARDS.map((s) => ({
              value: s.value,
              label: s.label,
              badge:
                s.value === "standard" ? (
                  <span className="rounded-md bg-brand-soft px-1.5 py-0.5 text-xs font-medium text-brand-ink">Recommended</span>
                ) : undefined,
              description: (
                <>
                  {s.summary}
                  <span className="mt-0.5 block text-xs text-ink-3">{s.effort}</span>
                </>
              ),
            }))}
          />
        </section>

        <section className="grid gap-5 sm:grid-cols-2">
          <div>
            <h3 className="mb-2 font-semibold text-ink">{info.label} needs</h3>
            <ul className="space-y-1.5 text-sm text-ink-2">
              {info.needs.map((n) => (
                <li key={n} className="flex gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-brand-ink" aria-hidden />
                  {n}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-2 font-semibold text-ink">Where it looks</h3>
            <ul className="space-y-1.5 text-sm text-ink-2">
              <li className="flex gap-2">
                <Globe className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
                {customer.domain ? `Their website, ${customer.domain}` : "No domain on file, so the search uses the name only"}
              </li>
              <li className="flex gap-2">
                <Search className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
                Web search results, news sites and registries
              </li>
              <li className="flex gap-2">
                <Mail className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
                {customer.email_count
                  ? `Our ${pluralize(customer.email_count, "e-mail")} with them (newest 20)`
                  : "Our e-mails with them (none on file yet)"}
              </li>
            </ul>
          </div>
        </section>

        <p className="rounded-lg border border-line bg-sunken px-3.5 py-2.5 text-sm text-ink-2">
          Web results are context, not proof. The report shows the sentence each finding came from so a person can judge it.
        </p>

        <Switch
          checked={monitor}
          onChange={setMonitor}
          label="Keep watching this company for news"
          description="Adds it to the weekly check for news, new projects and tenders."
        />
        <InlineError error={start.error} />
      </div>
    </Dialog>
  );
}
