/**
 * Customer profile (mockup 31): how the system tags the company and why, what people taught it
 * about this customer, notes, key numbers, news watch, contacts and company details.
 */
import { ChevronRight, GraduationCap, Mail, Pencil, Phone, Plus, Tag as TagIcon, X } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useCategoryLabel } from "@/api/session";
import type { Customer, Lesson } from "@/api/types";
import { cn } from "@/lib/cn";
import { formatDate, formatRelative, pluralize } from "@/lib/format";
import { customerKindLabel } from "@/lib/labels";
import { automationHref, customerHref } from "@/lib/routes";
import {
  Button,
  Chip,
  Confidence,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  InlineError,
  Input,
  KeyValue,
  LoadingRows,
  Panel,
  PanelBody,
  PanelHeader,
  Popover,
  Select,
  Switch,
  Textarea,
  toast,
  toastError,
} from "@/ui";
import {
  tagsOf,
  useAutomationList,
  useLessons,
  useSetMonitoring,
  useToggleLesson,
  useUpdateCustomer,
  type CustomerDetail,
  type Tag,
} from "./api";
import { useCustomerContext } from "./CustomerLayout";
import {
  CUSTOMER_KINDS,
  customerStatusInfo,
  domainFromInput,
  lessonKindLabel,
  lessonScopeLabel,
  lessonValue,
  locationLine,
  TAG_GROUPS,
  tagGroup,
  userTag,
} from "./lib";
import { TagEvidenceList } from "./parts";

export function ProfileTab() {
  const { detail } = useCustomerContext();
  return (
    <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
      <div className="contents lg:block lg:space-y-6">
        <TagsPanel detail={detail} className="order-2" />
        <LessonsPanel customer={detail.customer} className="order-5" />
        <NotesPanel customer={detail.customer} className="order-6" />
      </div>
      <div className="contents lg:block lg:space-y-6">
        <GlancePanel detail={detail} className="order-1" />
        <WatchPanel customer={detail.customer} className="order-3" />
        <ContactsPanel detail={detail} className="order-4" />
        <DetailsPanel customer={detail.customer} className="order-7" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ tags */

function TagsPanel({ detail, className }: { detail: CustomerDetail; className?: string }) {
  const c = detail.customer;
  const tags = tagsOf(c);
  const update = useUpdateCustomer(c.id);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newTag, setNewTag] = useState("");

  const groups = TAG_GROUPS.map((g) => ({ ...g, items: tags.map((t, i) => ({ t, i })).filter(({ t }) => tagGroup(t) === g.kind) })).filter(
    (g) => g.items.length > 0,
  );

  const save = (next: Tag[], done: string) =>
    update.mutate(
      { tags: next },
      {
        onSuccess: () => toast.success(done),
        onError: (err) => toastError(err, "The tags were not saved"),
      },
    );

  const addTag = (e: FormEvent) => {
    e.preventDefault();
    const label = newTag.trim();
    if (!label) return;
    if (tags.some((t) => t.tag.toLowerCase() === label.toLowerCase())) {
      toast.info(`“${label}” is already a tag`);
      return;
    }
    save([...tags, userTag(label)], `Tag “${label}” added`);
    setNewTag("");
    setAdding(false);
  };

  return (
    <Panel className={className}>
      <PanelHeader
        title="How we tag this company"
        description="Found in their mail and projects. Open a tag to see where it came from."
        actions={
          <Popover
            open={adding}
            onOpenChange={setAdding}
            align="end"
            className="w-72"
            trigger={
              <Button variant="secondary" size="sm" icon={<Plus />}>
                Add tag
              </Button>
            }
          >
            <form onSubmit={addTag} className="space-y-3">
              <Field label="New tag" htmlFor="new-tag" hint="Tags you add stay when the system re-tags.">
                <Input id="new-tag" autoFocus value={newTag} onChange={(e) => setNewTag(e.target.value)} placeholder="e.g. framework agreement" />
              </Field>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={!newTag.trim()} loading={update.isPending}>
                  Add tag
                </Button>
              </div>
            </form>
          </Popover>
        }
      />
      {groups.length === 0 ? (
        <EmptyState compact icon={<TagIcon />} title="No tags yet">
          Tags come from this company’s mail and projects. Press Re-tag to read them again, or add a tag yourself.
        </EmptyState>
      ) : (
        <div className="divide-y divide-line">
          {groups.map((g) => (
            <section key={g.kind} aria-label={g.label} className="px-5 py-3">
              <h3 className="flex items-baseline gap-2 text-sm font-semibold text-ink">
                {g.label}
                <span className="font-normal text-ink-3">{g.hint}</span>
              </h3>
              <ul className="mt-1">
                {g.items.map(({ t, i }) => {
                  const id = `tag-${i}`;
                  const isOpen = open === id;
                  const n = t.evidence?.length ?? 0;
                  return (
                    <li key={id} className="border-t border-line first:border-t-0">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          aria-expanded={isOpen}
                          aria-controls={`${id}-ev`}
                          onClick={() => setOpen(isOpen ? null : id)}
                          className="-mx-2 flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left outline-none hover:bg-canvas focus-visible:ring-2 focus-visible:ring-brand"
                        >
                          <ChevronRight
                            aria-hidden
                            className={cn("size-4 shrink-0 text-ink-3 transition-transform duration-150", isOpen && "rotate-90")}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="text-base font-medium text-ink">{t.tag}</span>
                            {t.kind === "need" && t.offered === false ? (
                              <span className="ml-2 text-sm text-ink-3">not one of our services</span>
                            ) : null}
                          </span>
                          <span className="hidden text-xs text-ink-3 tabular sm:inline">
                            {t.source === "user" ? "Added by a person" : pluralize(n, "source")}
                          </span>
                          {t.source !== "user" && typeof t.confidence === "number" ? <Confidence value={t.confidence} className="text-xs" /> : null}
                        </button>
                        {t.source === "user" ? (
                          <IconButton
                            label={`Remove tag ${t.tag}`}
                            size="sm"
                            onClick={() => save(tags.filter((_, j) => j !== i), `Tag “${t.tag}” removed`)}
                          >
                            <X />
                          </IconButton>
                        ) : null}
                      </div>
                      {isOpen ? (
                        <div id={`${id}-ev`} className="pb-3 pl-6">
                          {t.source === "user" ? (
                            <p className="text-sm text-ink-3">A person added this tag. Re-tagging keeps it.</p>
                          ) : (
                            <TagEvidenceList items={t.evidence} projects={detail.projects} />
                          )}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ lessons */

/** Corrections people made that concern this customer: its own scope, its domain, its senders. */
function useCustomerLessons(c: Customer) {
  const domain = c.domain;
  const own = useLessons({ scope: "customer", scope_key: c.id });
  const dom = useLessons({ scope: "domain", scope_key: domain }, !!domain);
  const senders = useLessons({ scope: "sender" }, !!domain);
  const items = useMemo(() => {
    const all: Lesson[] = [
      ...(own.data?.items ?? []),
      ...(dom.data?.items ?? []),
      ...(senders.data?.items ?? []).filter((l) => !!domain && l.scope_key.toLowerCase().endsWith(`@${domain.toLowerCase()}`)),
    ];
    const seen = new Set<string>();
    return all
      .filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true)))
      .sort((a, b) => new Date(b.last_seen_at).getTime() - new Date(a.last_seen_at).getTime());
  }, [own.data, dom.data, senders.data, domain]);
  const queries = [own, ...(domain ? [dom, senders] : [])];
  return {
    items,
    isLoading: queries.some((q) => q.isLoading),
    error: queries.find((q) => q.isError)?.error,
    refetch: () => queries.forEach((q) => q.refetch()),
  };
}

function LessonsPanel({ customer, className }: { customer: Customer; className?: string }) {
  const lessons = useCustomerLessons(customer);
  const toggle = useToggleLesson();
  const catLabel = useCategoryLabel();
  const active = lessons.items.filter((l) => l.active).length;

  return (
    <Panel className={className}>
      <PanelHeader
        title="What we learned about this customer"
        description={
          lessons.items.length
            ? `${pluralize(lessons.items.length, "correction")} people made · ${active} in use`
            : "Corrections people made to the system’s work for this company."
        }
        actions={
          <Button variant="ghost" size="sm" asChild>
            <Link to="/settings/learning">All lessons</Link>
          </Button>
        }
      />
      {lessons.isLoading ? (
        <LoadingRows rows={2} />
      ) : lessons.error ? (
        <ErrorState compact error={lessons.error} onRetry={lessons.refetch} />
      ) : lessons.items.length === 0 ? (
        <EmptyState compact icon={<GraduationCap />} title="Nothing learned yet">
          When someone re-files a mail from this company, edits a draft or leaves a review note on one of its projects, the
          lesson appears here. You can switch each one off.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {lessons.items.map((l) => {
            const fmt = l.kind === "category_correction" ? catLabel : undefined;
            const before = lessonValue(l.before, fmt);
            const after = lessonValue(l.after, fmt);
            return (
              <li key={l.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start">
                <div className={cn("min-w-0 flex-1 space-y-1", !l.active && "opacity-70")}>
                  <p className="text-sm text-ink-3">
                    {lessonKindLabel(l.kind)} · {lessonScopeLabel(l)}
                  </p>
                  {l.subject ? <p className="break-words font-medium text-ink">{l.subject}</p> : null}
                  {before || after ? (
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                      {before ? <Chip size="sm" tone="muted">{before}</Chip> : null}
                      {before && after ? <span aria-label="changed to" className="text-ink-3">→</span> : null}
                      {after ? <Chip size="sm" tone="brand">{after}</Chip> : null}
                    </p>
                  ) : null}
                  {l.note ? <p className="text-sm text-ink-2">“{l.note}”</p> : null}
                  <p className="text-xs text-ink-3 tabular">
                    {l.count > 1 ? `Corrected ${l.count} times` : "Corrected once"} · last {formatDate(l.last_seen_at)}
                    {l.created_by ? ` · by ${l.created_by}` : ""}
                  </p>
                </div>
                <Switch
                  label="In use"
                  checked={l.active}
                  disabled={toggle.isPending && toggle.variables?.id === l.id}
                  onChange={(v) =>
                    toggle.mutate(
                      { id: l.id, active: v },
                      {
                        onSuccess: () => toast.success(v ? "Lesson switched on" : "Lesson switched off"),
                        onError: (err) => toastError(err, "The lesson was not changed"),
                      },
                    )
                  }
                  className="shrink-0 sm:w-28"
                />
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ notes */

function NotesPanel({ customer, className }: { customer: Customer; className?: string }) {
  const update = useUpdateCustomer(customer.id);
  const server = customer.notes ?? "";
  const [seen, setSeen] = useState(server);
  const [base, setBase] = useState(server);
  const [text, setText] = useState(server);
  // Follow changes from the server, but never overwrite what the person is typing.
  if (server !== seen) {
    setSeen(server);
    if (text === base) {
      setBase(server);
      setText(server);
    }
  }
  const dirty = text !== base;

  const save = () =>
    update.mutate(
      { notes: text },
      {
        onSuccess: () => {
          setBase(text);
          toast.success("Notes saved");
        },
      },
    );

  return (
    <Panel className={className}>
      <PanelHeader title="Notes" description="For your team. Not shown to the customer." />
      <PanelBody className="space-y-3">
        <Textarea
          aria-label="Notes about this customer"
          rows={6}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Payment habits, preferred contact, site rules…"
          dir="auto"
        />
        <InlineError error={update.error} />
        <div className="flex flex-wrap items-center justify-end gap-2">
          {dirty ? <span className="mr-auto text-sm text-review">Unsaved changes</span> : null}
          <Button variant="ghost" onClick={() => setText(base)} disabled={!dirty || update.isPending}>
            Discard
          </Button>
          <Button onClick={save} disabled={!dirty} loading={update.isPending}>
            Save notes
          </Button>
        </div>
      </PanelBody>
    </Panel>
  );
}

/* ------------------------------------------------------------------ side column */

function GlancePanel({ detail, className }: { detail: CustomerDetail; className?: string }) {
  const c = detail.customer;
  const suggested = detail.opportunities.filter((o) => o.status === "suggested").length;
  return (
    <Panel className={className}>
      <PanelHeader title="At a glance" />
      <PanelBody className="py-1">
        <KeyValue
          labelWidth="sm"
          items={[
            {
              label: "Enquiries",
              value: (
                <Link to={customerHref(c.id, "projects")} className="tabular hover:text-brand-ink hover:underline">
                  {c.enquiry_count}
                </Link>
              ),
            },
            { label: "Projects", value: <span className="tabular">{c.project_count}</span> },
            { label: "Quotations", value: <span className="tabular">{detail.quotations.length}</span> },
            { label: "E-mails", value: <span className="tabular">{c.email_count}</span> },
            {
              label: "Suggested",
              value: suggested ? (
                <Link to={customerHref(c.id, "opportunities")} className="hover:text-brand-ink hover:underline">
                  {pluralize(suggested, "service")} to review
                </Link>
              ) : (
                "None to review"
              ),
            },
            { label: "First seen", value: formatDate(c.first_seen) },
            { label: "Last seen", value: formatRelative(c.last_seen) },
          ]}
        />
      </PanelBody>
    </Panel>
  );
}

function WatchPanel({ customer, className }: { customer: Customer; className?: string }) {
  const monitor = useSetMonitoring(customer.id);
  const autos = useAutomationList();
  const watchAuto = autos.data?.find((a) => a.key === "customer_watch");
  return (
    <Panel className={className}>
      <PanelBody className="space-y-3">
        <Switch
          checked={customer.monitoring}
          disabled={monitor.isPending}
          onChange={(v) =>
            monitor.mutate(v, {
              onSuccess: () => toast.success(v ? `Watching ${customer.name} for news` : "News watch switched off"),
              onError: (err) => toastError(err, "The news watch was not changed"),
            })
          }
          label="Watch for news"
          description="Looks for news, new projects and tenders about this company."
        />
        <p className="text-sm text-ink-3">
          {customer.last_checked_at ? `Last checked ${formatRelative(customer.last_checked_at).toLowerCase()}.` : "Not checked yet."}{" "}
          <Link to={customerHref(customer.id, "updates")} className="font-medium text-brand-ink hover:underline">
            See updates
          </Link>
        </p>
        {customer.monitoring && watchAuto && !watchAuto.enabled ? (
          <p className="rounded-lg bg-review-soft px-3 py-2 text-sm text-review">
            The weekly check is switched off, so it only runs when you press Check now.{" "}
            <Link to={automationHref(watchAuto.id)} className="font-medium underline underline-offset-2">
              Open the automation
            </Link>
          </p>
        ) : null}
      </PanelBody>
    </Panel>
  );
}

function ContactsPanel({ detail, className }: { detail: CustomerDetail; className?: string }) {
  const contacts = detail.contacts;
  return (
    <Panel className={className}>
      <PanelHeader title="Contacts" description={contacts.length ? pluralize(contacts.length, "person", "people") : undefined} />
      {contacts.length === 0 ? (
        <PanelBody>
          <p className="text-sm text-ink-3">No contacts yet. People who write to us from this company are added here.</p>
        </PanelBody>
      ) : (
        <ul className="divide-y divide-line">
          {contacts.map((p) => (
            <li key={p.id} className="space-y-0.5 px-5 py-3">
              <p className="break-words font-medium text-ink">{p.name || p.email}</p>
              {p.title ? <p className="text-sm text-ink-2">{p.title}</p> : null}
              {p.email ? (
                <a href={`mailto:${p.email}`} className="flex min-w-0 items-center gap-1.5 text-sm text-brand-ink hover:underline">
                  <Mail className="size-3.5 shrink-0" aria-hidden />
                  <span className="truncate">{p.email}</span>
                </a>
              ) : null}
              {p.phone ? (
                <a href={`tel:${p.phone}`} className="flex items-center gap-1.5 text-sm text-ink-2 tabular hover:underline">
                  <Phone className="size-3.5 shrink-0" aria-hidden />
                  {p.phone}
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function DetailsPanel({ customer, className }: { customer: Customer; className?: string }) {
  const [editing, setEditing] = useState(false);
  const c = customer;
  return (
    <Panel className={className}>
      <PanelHeader
        title="Company details"
        actions={
          <Button variant="ghost" size="sm" icon={<Pencil />} onClick={() => setEditing(true)}>
            Edit
          </Button>
        }
      />
      <PanelBody className="py-1">
        <KeyValue
          labelWidth="sm"
          items={[
            { label: "Role", value: customerKindLabel(c.kind || "other") },
            { label: "Domain", value: c.domain || null },
            { label: "Website", value: c.website || null },
            { label: "Location", value: locationLine(c.city, c.country) || null },
            { label: "Status", value: customerStatusInfo(c.status).label },
          ]}
        />
      </PanelBody>
      <EditDetailsDialog customer={c} open={editing} onOpenChange={setEditing} />
    </Panel>
  );
}

function EditDetailsDialog({ customer, open, onOpenChange }: { customer: Customer; open: boolean; onOpenChange: (o: boolean) => void }) {
  const update = useUpdateCustomer(customer.id);
  const initial = () => ({
    name: customer.name,
    domain: customer.domain,
    website: customer.website,
    kind: customer.kind || "other",
    country: customer.country,
    city: customer.city,
    status: customer.status || "active",
  });
  const [d, setD] = useState(initial);
  const [nameError, setNameError] = useState<string | null>(null);
  const set = (k: keyof ReturnType<typeof initial>, v: string) => setD((x) => ({ ...x, [k]: v }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!d.name.trim()) {
      setNameError("Enter the company name.");
      return;
    }
    update.mutate(
      { ...d, name: d.name.trim(), domain: domainFromInput(d.domain), website: d.website.trim(), country: d.country.trim(), city: d.city.trim() },
      {
        onSuccess: () => {
          toast.success("Company details saved");
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (update.isPending) return;
        if (o) {
          setD(initial());
          setNameError(null);
          update.reset();
        }
        onOpenChange(o);
      }}
      title="Edit company details"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={update.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="edit-company-form" loading={update.isPending}>
            Save details
          </Button>
        </>
      }
    >
      <form id="edit-company-form" onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Company name" required htmlFor="ed-name" error={nameError}>
          <Input id="ed-name" value={d.name} invalid={!!nameError} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email domain" htmlFor="ed-domain" hint="Mail from this domain belongs to the company.">
            <Input id="ed-domain" value={d.domain} onChange={(e) => set("domain", e.target.value)} placeholder="example.com" />
          </Field>
          <Field label="Website" htmlFor="ed-website">
            <Input id="ed-website" value={d.website} onChange={(e) => set("website", e.target.value)} placeholder="https://example.com" />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Role" htmlFor="ed-kind">
            <Select
              id="ed-kind"
              value={d.kind}
              onChange={(e) => set("kind", e.target.value)}
              options={CUSTOMER_KINDS.map((k) => ({ value: k, label: customerKindLabel(k) }))}
            />
          </Field>
          <Field label="Status" htmlFor="ed-status">
            <Select
              id="ed-status"
              value={d.status}
              onChange={(e) => set("status", e.target.value)}
              options={[
                { value: "active", label: "Active" },
                { value: "prospect", label: "Prospect" },
                { value: "dormant", label: "Dormant" },
              ]}
            />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Country" htmlFor="ed-country">
            <Input id="ed-country" value={d.country} onChange={(e) => set("country", e.target.value)} />
          </Field>
          <Field label="City" htmlFor="ed-city">
            <Input id="ed-city" value={d.city} onChange={(e) => set("city", e.target.value)} />
          </Field>
        </div>
        <InlineError error={update.error} />
      </form>
    </Dialog>
  );
}
