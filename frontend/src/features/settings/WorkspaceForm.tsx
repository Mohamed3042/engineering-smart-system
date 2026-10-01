/**
 * Company details form. One form for the setup wizard (create, or continue editing) and for
 * Settings › Workspace (edit), so the fields, checks and wording never drift apart.
 */
import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Workspace } from "@/api/types";
import { useSaveWorkspace } from "@/features/knowledge/api";
import { TagInput } from "@/features/knowledge/components/TagInput";
import { LANGUAGE_OPTIONS } from "@/features/knowledge/model";
import { Button, Checkbox, Field, InlineError, Input, Select, toast } from "@/ui";
import { useCreateWorkspace } from "./api";
import {
  browserTimezone,
  COUNTRY_DEFAULTS,
  countryOptions,
  currencyOptions,
  domainOf,
  EMAIL_RE,
  normalizeDomain,
  regionOptions,
  timezoneOptions,
} from "./options";

interface Values {
  company_name: string;
  name: string;
  owner_name: string;
  primary_email: string;
  country: string;
  region: string;
  currency: string;
  timezone: string;
  languages: string[];
  own_domains: string[];
}

type Errors = Partial<Record<"company_name" | "name" | "owner_name" | "primary_email" | "languages", string>>;

function initialValues(ws?: Workspace | null): Values {
  if (!ws) {
    return {
      company_name: "",
      name: "",
      owner_name: "",
      primary_email: "",
      country: "",
      region: "",
      currency: "USD",
      timezone: browserTimezone(),
      languages: ["en"],
      own_domains: [],
    };
  }
  return {
    company_name: ws.company_name || ws.name,
    name: ws.name,
    owner_name: "",
    primary_email: ws.primary_email ?? "",
    country: ws.country ?? "",
    region: ws.region ?? "",
    currency: ws.currency || "USD",
    timezone: ws.timezone || "UTC",
    languages: ws.languages?.length ? ws.languages : ["en"],
    own_domains: ws.own_domains ?? [],
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Only the fields the person changed (the backend patches field by field). */
function changes(v: Values, ws: Workspace): Record<string, unknown> {
  const base = initialValues(ws);
  const out: Record<string, unknown> = {};
  for (const k of ["company_name", "name", "primary_email", "country", "region", "currency", "timezone", "languages", "own_domains"] as const) {
    if (!same(v[k], base[k])) out[k] = typeof v[k] === "string" ? (v[k] as string).trim() : v[k];
  }
  return out;
}

function validate(v: Values, mode: "create" | "edit"): Errors {
  const e: Errors = {};
  if (!v.company_name.trim()) e.company_name = "Enter the company name.";
  if (mode === "edit" && !v.name.trim()) e.name = "Enter a workspace name.";
  if (mode === "create" && !v.owner_name.trim()) e.owner_name = "Enter your name. You become the workspace owner.";
  const email = v.primary_email.trim();
  if (!email && mode === "create") e.primary_email = "Enter the mailbox address customers write to.";
  else if (email && !EMAIL_RE.test(email)) e.primary_email = "Enter a full address such as sales@yourcompany.com.";
  if (v.languages.length === 0) e.languages = "Choose at least one language.";
  return e;
}

export function WorkspaceForm({
  mode,
  workspace,
  canEdit = true,
  onSaved,
  submitLabel,
  leading,
  hideDomains,
  className,
}: {
  mode: "create" | "edit";
  workspace?: Workspace | null;
  canEdit?: boolean;
  /** Called after the workspace was created or saved (wizard: go to the next step). */
  onSaved?: (ws: Workspace) => void | Promise<void>;
  submitLabel?: string;
  /** Left of the submit button (Cancel, Back). */
  leading?: ReactNode;
  hideDomains?: boolean;
  className?: string;
}) {
  const create = useCreateWorkspace();
  const save = useSaveWorkspace();
  const [v, setV] = useState<Values>(() => initialValues(mode === "edit" ? workspace : null));
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<unknown>(null);
  const touched = useRef<Partial<Record<"region" | "currency" | "timezone" | "languages", boolean>>>({});
  const ids = { company: useId(), name: useId(), owner: useId(), email: useId(), country: useId(), region: useId(), currency: useId(), tz: useId(), langs: useId(), domains: useId() };
  const refs = { company: useRef<HTMLInputElement>(null), name: useRef<HTMLInputElement>(null), owner: useRef<HTMLInputElement>(null), email: useRef<HTMLInputElement>(null) };

  const busy = create.isPending || save.isPending;
  const patch = mode === "edit" && workspace ? changes(v, workspace) : {};
  const dirty = mode === "create" || Object.keys(patch).length > 0;
  const set = <K extends keyof Values>(k: K, value: Values[K]) => setV((cur) => ({ ...cur, [k]: value }));
  const disabled = !canEdit || busy;

  function pickCountry(code: string) {
    setV((cur) => {
      const next = { ...cur, country: code };
      const d = COUNTRY_DEFAULTS[code];
      // a new workspace starts from the country's usual region, currency, time zone and languages
      if (mode === "create" && d) {
        if (!touched.current.region) next.region = d.region;
        if (!touched.current.currency) next.currency = d.currency;
        if (!touched.current.timezone) next.timezone = d.timezone;
        if (!touched.current.languages) next.languages = d.languages;
      }
      return next;
    });
  }

  function toggleLanguage(code: string, on: boolean) {
    touched.current.languages = true;
    setV((cur) => ({ ...cur, languages: on ? [...new Set([...cur.languages, code])] : cur.languages.filter((l) => l !== code) }));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found = validate(v, mode);
    setErrors(found);
    setFormError(null);
    if (found.company_name) return refs.company.current?.focus();
    if (found.name) return refs.name.current?.focus();
    if (found.owner_name) return refs.owner.current?.focus();
    if (found.primary_email) return refs.email.current?.focus();
    if (found.languages) return;
    try {
      if (mode === "create") {
        const company = v.company_name.trim();
        const ws = await create.mutateAsync({
          name: company,
          company_name: company,
          primary_email: v.primary_email.trim(),
          region: v.region,
          country: v.country,
          languages: v.languages,
          currency: v.currency,
          timezone: v.timezone,
          owner_name: v.owner_name.trim(),
        });
        toast.success("Workspace created", { description: `${company} is ready. Next: connect the AI engine.` });
        await onSaved?.(ws);
      } else if (workspace) {
        if (Object.keys(patch).length > 0) {
          const ws = await save.mutateAsync(patch);
          toast.success("Workspace saved");
          await onSaved?.(ws);
        } else {
          await onSaved?.(workspace);
        }
      }
    } catch (err) {
      // keep everything the person typed; say what failed
      setFormError(err);
    }
  }

  const derivedDomain = domainOf(v.primary_email);

  return (
    <form onSubmit={submit} noValidate className={className}>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Company name" htmlFor={ids.company} required error={errors.company_name} hint="As it appears on quotations." className="sm:col-span-2">
          <Input
            id={ids.company}
            ref={refs.company}
            value={v.company_name}
            invalid={!!errors.company_name}
            disabled={disabled}
            autoComplete="organization"
            onChange={(e) => set("company_name", e.target.value)}
          />
        </Field>

        {mode === "edit" ? (
          <Field label="Workspace name" htmlFor={ids.name} required error={errors.name} hint="Shown in the app header and the workspace menu.">
            <Input id={ids.name} ref={refs.name} value={v.name} invalid={!!errors.name} disabled={disabled} onChange={(e) => set("name", e.target.value)} />
          </Field>
        ) : (
          <Field label="Your name" htmlFor={ids.owner} required error={errors.owner_name} hint="You become the workspace owner.">
            <Input
              id={ids.owner}
              ref={refs.owner}
              value={v.owner_name}
              invalid={!!errors.owner_name}
              disabled={disabled}
              autoComplete="name"
              onChange={(e) => set("owner_name", e.target.value)}
            />
          </Field>
        )}

        <Field
          label="Mailbox address"
          htmlFor={ids.email}
          required={mode === "create"}
          error={errors.primary_email}
          hint={derivedDomain ? `Mail from ${derivedDomain} counts as your own.` : "The address customers write to. Its domain counts as your own."}
        >
          <Input
            id={ids.email}
            ref={refs.email}
            type="email"
            inputMode="email"
            value={v.primary_email}
            invalid={!!errors.primary_email}
            disabled={disabled}
            autoComplete="email"
            spellCheck={false}
            onChange={(e) => set("primary_email", e.target.value)}
          />
        </Field>

        <Field label="Country" htmlFor={ids.country} hint={mode === "create" ? "Suggests the region, currency and time zone below." : undefined}>
          <Select id={ids.country} value={v.country} disabled={disabled} placeholder="Choose a country" options={countryOptions(v.country)} onChange={(e) => pickCountry(e.target.value)} />
        </Field>

        <Field label="Region" htmlFor={ids.region} hint="Which market vocabulary to expect in mail and documents.">
          <Select
            id={ids.region}
            value={v.region}
            disabled={disabled}
            placeholder="Choose a region"
            options={regionOptions(v.region)}
            onChange={(e) => {
              touched.current.region = true;
              set("region", e.target.value);
            }}
          />
        </Field>

        <Field label="Currency" htmlFor={ids.currency}>
          <Select
            id={ids.currency}
            value={v.currency}
            disabled={disabled}
            options={currencyOptions(v.currency)}
            onChange={(e) => {
              touched.current.currency = true;
              set("currency", e.target.value);
            }}
          />
        </Field>

        <Field label="Time zone" htmlFor={ids.tz}>
          <Select
            id={ids.tz}
            value={v.timezone}
            disabled={disabled}
            options={timezoneOptions(v.timezone)}
            onChange={(e) => {
              touched.current.timezone = true;
              set("timezone", e.target.value);
            }}
          />
        </Field>

        <div role="group" aria-labelledby={ids.langs} className="space-y-1.5 sm:col-span-2">
          <p id={ids.langs} className="text-sm font-medium text-ink">
            Languages of your mail and documents
          </p>
          <div className="flex flex-wrap gap-x-6 gap-y-2.5">
            {LANGUAGE_OPTIONS.map((l) => (
              <Checkbox
                key={l.value}
                label={l.label}
                checked={v.languages.includes(l.value)}
                disabled={disabled}
                onChange={(on) => toggleLanguage(l.value, on)}
              />
            ))}
          </div>
          {errors.languages ? (
            <p className="text-sm text-block" role="alert">
              {errors.languages}
            </p>
          ) : null}
        </div>

        {mode === "edit" && !hideDomains ? (
          <Field
            label="Your mail domains"
            htmlFor={ids.domains}
            hint="Mail from these domains is treated as yours (internal and sent), not as customer mail."
            className="sm:col-span-2"
          >
            <TagInput
              id={ids.domains}
              value={v.own_domains}
              disabled={disabled}
              placeholder="example.com"
              normalize={(s) => normalizeDomain(s) || s.trim()}
              validate={(s) => (normalizeDomain(s) ? null : `“${s}” is not a domain. Use a name like example.com.`)}
              onChange={(d) => set("own_domains", d)}
            />
          </Field>
        ) : null}
      </div>

      <InlineError error={formError} className="mt-4" />

      <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">{leading}</div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {!canEdit ? <p className="text-sm text-ink-3">Only an owner or admin can change this.</p> : null}
          <Button type="submit" size="md" loading={busy} disabled={!canEdit || (mode === "edit" && !dirty && !submitLabel)} className="w-full sm:w-auto">
            {submitLabel ?? (mode === "create" ? "Create workspace" : "Save changes")}
          </Button>
        </div>
      </div>
    </form>
  );
}
