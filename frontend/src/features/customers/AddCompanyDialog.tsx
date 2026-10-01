import { useQueryClient } from "@tanstack/react-query";
import { Info, Plus } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { api, isApiError } from "@/api/client";
import { useWorkspace } from "@/api/session";
import { customerKindLabel } from "@/lib/labels";
import { customerHref } from "@/lib/routes";
import { Button, Dialog, Field, InlineError, Input, Select, Switch, toast } from "@/ui";
import { useAddCustomer } from "./api";
import { CUSTOMER_KINDS, domainFromInput, parseTagInput, userTag } from "./lib";

interface Draft {
  name: string;
  domain: string;
  website: string;
  kind: string;
  country: string;
  city: string;
  tags: string;
  research: boolean;
}

const empty = (country: string): Draft => ({ name: "", domain: "", website: "", kind: "", country, city: "", tags: "", research: false });

/** Add a company by hand. Only what the person knows; research can fill the rest. */
export function AddCompanyDialog({ trigger }: { trigger: ReactNode }) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => empty(ws.country ?? ""));
  const [nameError, setNameError] = useState<string | null>(null);
  const [domainError, setDomainError] = useState<string | null>(null);
  const add = useAddCustomer();
  const [finishing, setFinishing] = useState(false);
  const busy = add.isPending || finishing;

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  function reset() {
    setDraft(empty(ws.country ?? ""));
    setNameError(null);
    setDomainError(null);
    add.reset();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setNameError(null);
    setDomainError(null);
    const name = draft.name.trim();
    if (!name) {
      setNameError("Enter the company name.");
      return;
    }
    const domain = domainFromInput(draft.domain) || domainFromInput(draft.website);
    if (domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
      setDomainError("Use a domain like example.com.");
      return;
    }
    let created;
    try {
      created = await add.mutateAsync({
        name,
        domain,
        website: draft.website.trim(),
        kind: draft.kind || undefined,
        country: draft.country.trim(),
        city: draft.city.trim(),
      });
    } catch (err) {
      if (isApiError(err, "exists")) setDomainError("This company is already in your customers.");
      else if (isApiError(err, "name_required")) setNameError("Enter the company name.");
      return;
    }
    // Follow-ups: tags and research. The company exists even if these fail.
    setFinishing(true);
    const tags = parseTagInput(draft.tags);
    let followUpFailed = false;
    try {
      if (tags.length) await api.patch(`/customers/${created.id}`, { tags: tags.map(userTag) });
      if (draft.research) await api.post(`/customers/${created.id}/research`, { standard: "standard" });
    } catch {
      followUpFailed = true;
    } finally {
      setFinishing(false);
      qc.invalidateQueries({ queryKey: ["customers"] });
    }
    if (followUpFailed) {
      toast.warning(`${name} added, but its tags or research did not start`, {
        description: "Add the tags or start research from the company page.",
        duration: 8000,
      });
    } else {
      toast.success(`${name} added`, { description: draft.research ? "Research started. It usually takes a minute or two." : undefined });
    }
    setOpen(false);
    reset();
    navigate(customerHref(created.id));
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (busy) return;
        setOpen(o);
        if (!o) reset();
      }}
      trigger={trigger}
      title="Add company"
      description="Add a customer that is not in your mail yet."
      hideClose={busy}
      footer={
        <>
          <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="add-company-form" loading={busy} icon={<Plus />}>
            Add company
          </Button>
        </>
      }
    >
      <form id="add-company-form" onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Company name" required htmlFor="ac-name" error={nameError}>
          <Input
            id="ac-name"
            autoFocus
            autoComplete="organization"
            value={draft.name}
            invalid={!!nameError}
            onChange={(e) => set("name", e.target.value)}
            placeholder="Company name"
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email domain" optional htmlFor="ac-domain" error={domainError} hint="Mail from this domain is linked to the company.">
            <Input
              id="ac-domain"
              inputMode="url"
              value={draft.domain}
              invalid={!!domainError}
              onChange={(e) => set("domain", e.target.value)}
              placeholder="example.com"
            />
          </Field>
          <Field label="Website" optional htmlFor="ac-website">
            <Input
              id="ac-website"
              inputMode="url"
              value={draft.website}
              onChange={(e) => set("website", e.target.value)}
              placeholder="https://example.com"
            />
          </Field>
        </div>
        <Field label="Role" optional htmlFor="ac-kind" hint="Leave it empty and the system works it out from their mail.">
          <Select
            id="ac-kind"
            value={draft.kind}
            onChange={(e) => set("kind", e.target.value)}
            placeholder="Not sure yet"
            options={CUSTOMER_KINDS.filter((k) => k !== "other").map((k) => ({ value: k, label: customerKindLabel(k) }))}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Country" optional htmlFor="ac-country">
            <Input id="ac-country" autoComplete="country" value={draft.country} onChange={(e) => set("country", e.target.value)} />
          </Field>
          <Field label="City" optional htmlFor="ac-city">
            <Input id="ac-city" autoComplete="address-level2" value={draft.city} onChange={(e) => set("city", e.target.value)} />
          </Field>
        </div>
        <Field label="Tags" optional htmlFor="ac-tags" hint="Separate tags with commas.">
          <Input id="ac-tags" value={draft.tags} onChange={(e) => set("tags", e.target.value)} placeholder="e.g. hospitals, repeat customer" />
        </Field>
        <Switch
          checked={draft.research}
          onChange={(v) => set("research", v)}
          label="Research this company after saving"
          description="Standard research: who they are, what they do and current projects, each with a quoted source."
        />
        <p className="flex items-start gap-2 text-sm text-ink-3">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          Add only what you know. Research and their mail fill the gaps later.
        </p>
        <InlineError error={add.isError && !isApiError(add.error, "exists") && !isApiError(add.error, "name_required") ? add.error : null} />
      </form>
    </Dialog>
  );
}
