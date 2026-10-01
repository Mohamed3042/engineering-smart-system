/**
 * Filing a message under a project by hand: the picker (also used to move a message to another
 * project) and "Create project from this message". Both call POST /api/emails/{id}/link and then
 * offer to open the project. Likely projects come first, each with the reason it is suggested.
 */
import { GraduationCap, Info } from "lucide-react";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { isApiError } from "@/api/client";
import { useCategories, useCategoryLabel } from "@/api/session";
import { dueLabel, formatDate, pluralize } from "@/lib/format";
import { requestKindLabel, workTypeLabel } from "@/lib/labels";
import { projectHref } from "@/lib/routes";
import { Button, Chip, DateInput, Dialog, EmptyState, ErrorState, Field, InlineError, Input, LoadingRows, SearchInput, Select, toast } from "@/ui";
import { useLinkEmail, useProjectChoices, type EmailDetail, type LinkResult, type NewProjectSpec } from "./api";
import { LIKELY, isolate, mailFacts, projectNameFromSubject, rankProjects, suggestFromMail, type RankedProject } from "./link";
import { REQUEST_KINDS, WORK_TYPES } from "./labels";
import { senderName } from "./parts";

/** How many projects the list shows before it asks for a search. */
const SHOW = 60;

/** Toast after a message was filed: what happened, and a way into the project. */
function useAfterLink(detail: EmailDetail, verb: "filed" | "moved" | "created") {
  const navigate = useNavigate();
  const label = useCategoryLabel();
  return (res: LinkResult) => {
    const changed = res.email.category !== detail.email.category;
    const title =
      verb === "created"
        ? `Project created: ${isolate(res.project.name)}`
        : verb === "moved"
          ? `Moved to ${isolate(res.project.name)}`
          : `Filed under ${isolate(res.project.name)}`;
    toast.success(title, {
      description: `The message and its conversation are filed there.${
        changed ? ` Its category is now ${label(res.email.category)}, and later mail from ${detail.email.from_email} is filed the same way.` : ""
      }`,
      duration: 15_000,
      action: { label: "Open project", onClick: () => navigate(projectHref(res.project.id)) },
    });
  };
}

/** Said before anything is saved: what moves, and the lesson a non-work message teaches. */
function FilingNote({ detail, creating, family }: { detail: EmailDetail; creating?: boolean; family?: string | null }) {
  const { email, thread, category, project } = detail;
  const label = useCategoryLabel();
  const others = Math.max(thread.length - 1, 0);
  const notWork = !!category && category.group !== "work";
  const what = others ? `This message and its conversation (${others + 1} messages)` : "This message";
  const verb = others ? "are" : "is";
  const text = creating
    ? `A new project is opened. ${what}, with attachments and shared links, ${verb} filed under it.`
    : project
      ? `${what}, with attachments and shared links, ${verb} moved from ${isolate(project.name)} to the project you choose.`
      : `${what}, with attachments and shared links, ${verb} filed under the project you choose.`;
  return (
    <div className="space-y-2 text-sm text-ink-2">
      <p className="flex gap-2.5 rounded-lg border border-line bg-sunken px-3.5 py-2.5">
        <Info className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
        <span>{text} Nothing is sent to anyone.</span>
      </p>
      {notWork ? (
        <p className="flex gap-2.5 rounded-lg border border-review-line bg-review-soft px-3.5 py-2.5 text-review">
          <GraduationCap className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            This message is filed as <span className="font-semibold">{category?.label ?? email.category}</span>. Filing it under a project says it is work mail: its
            category becomes {family ? <span className="font-semibold">{label(family)}</span> : "the project’s service family"}, and later mail from{" "}
            <span className="break-all font-medium">{email.from_email}</span> is filed the same way.
          </span>
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ picker */

function ProjectRow({ item, group, checked, onSelect }: { item: RankedProject; group: string; checked: boolean; onSelect: (id: string) => void }) {
  const { project: p, match } = item;
  return (
    <li>
      <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-line bg-surface p-3 transition-colors hover:bg-hover has-[:checked]:border-brand has-[:checked]:bg-brand-soft/50 has-[:checked]:ring-1 has-[:checked]:ring-brand has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand">
        <input type="radio" name={group} value={p.id} checked={checked} onChange={() => onSelect(p.id)} className="mt-1 size-4 shrink-0 accent-brand outline-none" />
        <span className="min-w-0 flex-1">
          <span className="block break-words font-semibold text-ink" dir="auto">
            {p.name}
          </span>
          <span className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-ink-2">
            {p.customer ? (
              <span className="break-words" dir="auto">
                {p.customer.name}
              </span>
            ) : null}
            {p.tender_no ? <span className="break-all">Tender {p.tender_no}</span> : null}
            {p.due_date ? (
              <span className="tabular">
                Closes {formatDate(p.due_date)} · {dueLabel(p.due_date)}
              </span>
            ) : (
              <span className="text-ink-3">No closing date</span>
            )}
            <span className="text-ink-3">{p.code}</span>
          </span>
          {match.reasons.length ? (
            <span className="mt-1.5 flex flex-wrap gap-1.5">
              {match.reasons.map((r) => (
                <Chip key={r} size="sm" tone="brand" className="max-w-full">
                  {r}
                </Chip>
              ))}
            </span>
          ) : null}
        </span>
      </label>
    </li>
  );
}

function RowGroup({ title, hint, items, group, selected, onSelect }: { title: string; hint?: string; items: RankedProject[]; group: string; selected: string | null; onSelect: (id: string) => void }) {
  if (!items.length) return null;
  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {hint ? <p className="text-xs text-ink-3">{hint}</p> : null}
      </div>
      <ul className="space-y-2">
        {items.map((it) => (
          <ProjectRow key={it.project.id} item={it} group={group} checked={selected === it.project.id} onSelect={onSelect} />
        ))}
      </ul>
    </section>
  );
}

/**
 * "File under a project" for unlinked mail, "Move to another project" for linked mail. Searchable
 * list of open projects; the likely ones (same tender number, same customer, words of the subject)
 * come first with the reason.
 */
export function ProjectPickerDialog({
  detail,
  open,
  onOpenChange,
  onCreateInstead,
}: {
  detail: EmailDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateInstead: () => void;
}) {
  const { email, project: current } = detail;
  const moving = !!current;
  const choices = useProjectChoices(open);
  const link = useLinkEmail();
  const after = useAfterLink(detail, moving ? "moved" : "filed");
  const group = useId();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const facts = useMemo(() => mailFacts(email), [email]);
  const { reset } = link;

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(null);
      reset();
    }
  }, [open, reset]);

  const ranked = useMemo(() => rankProjects(choices.data?.items ?? [], facts, query, current?.id), [choices.data, facts, query, current?.id]);
  const searching = query.trim().length > 0;
  const likely = searching ? [] : ranked.filter((r) => r.match.score >= LIKELY).slice(0, 6);
  const rest = searching ? ranked : ranked.filter((r) => !likely.includes(r));
  const shown = rest.slice(0, SHOW);
  const chosen = ranked.find((r) => r.project.id === selected)?.project ?? null;
  const fine = typeof window !== "undefined" && !!window.matchMedia?.("(pointer: fine)").matches;
  const total = choices.data?.items.length ?? 0;

  const submit = () => {
    if (!selected) return;
    link.mutate(
      { id: email.id, target: { project_id: selected } },
      {
        onSuccess: (res) => {
          onOpenChange(false);
          after(res);
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !link.isPending && onOpenChange(o)}
      title={moving ? "Move to another project" : "File under a project"}
      description={moving ? `Now filed under ${isolate(current?.name ?? "")}. Choose the project it belongs to instead.` : "Choose the open project this message belongs to."}
      size="lg"
      hideClose={link.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={link.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={link.isPending} disabled={!selected}>
            {moving ? "Move to this project" : "File under this project"}
          </Button>
          {link.isError ? <InlineError error={link.error} className="sm:order-first sm:mr-auto sm:self-center" /> : null}
        </>
      }
    >
      <div className="space-y-4">
        <FilingNote detail={detail} family={chosen?.service_family} />
        <div className="sticky top-0 z-10 -mx-5 space-y-2 bg-surface px-5 pb-2 pt-1 sm:-mx-6 sm:px-6">
          <SearchInput
            value={query}
            onChange={setQuery}
            label="Search projects"
            placeholder="Name, customer or tender number"
            autoFocus={fine}
          />
          <p className="min-h-5 text-sm text-ink-3" aria-live="polite">
            {chosen ? (
              <>
                Selected: <bdi className="font-medium text-ink">{chosen.name}</bdi>
              </>
            ) : choices.data && ranked.length ? (
              `${pluralize(ranked.length, "open project")}${searching ? " match" : ""}`
            ) : null}
          </p>
        </div>

        {choices.isLoading ? (
          <LoadingRows rows={4} />
        ) : choices.isError ? (
          <ErrorState compact error={choices.error} onRetry={() => choices.refetch()} title="The projects could not load" />
        ) : ranked.length === 0 ? (
          <EmptyState
            compact
            title={total === 0 ? "No open projects yet" : searching ? `No project matches “${query.trim()}”` : "No other open project"}
            action={
              <>
                {searching ? (
                  <Button variant="secondary" onClick={() => setQuery("")}>
                    Clear search
                  </Button>
                ) : null}
                <Button onClick={onCreateInstead}>Create project from this message</Button>
              </>
            }
          >
            {searching ? "Check the spelling, or open a new project from this message." : "Open a new project from this message to file it there."}
          </EmptyState>
        ) : (
          <fieldset className="space-y-5">
            <legend className="sr-only">Open projects</legend>
            <RowGroup
              title="Likely matches"
              hint="Same tender number, same customer, or words from the subject."
              items={likely}
              group={group}
              selected={selected}
              onSelect={setSelected}
            />
            <RowGroup
              title={likely.length ? "Other open projects" : searching ? "Matching projects" : "Open projects"}
              hint={likely.length || searching ? undefined : "Nothing in the message points to one of these. Search by name, customer or tender number."}
              items={shown}
              group={group}
              selected={selected}
              onSelect={setSelected}
            />
            {rest.length > shown.length ? (
              <p className="text-sm text-ink-3">
                Showing {shown.length} of {rest.length}. Type in the search box to narrow the list.
              </p>
            ) : null}
            <p className="text-sm text-ink-3">
              Not here?{" "}
              <button type="button" onClick={onCreateInstead} className="rounded font-medium text-brand-ink underline-offset-2 hover:underline">
                Create a project from this message
              </button>
              .
            </p>
          </fieldset>
        )}
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ create */

interface FormState {
  name: string;
  service_family: string;
  work_type: string;
  request_kind: string;
  due_date: string;
  tender_no: string;
  location: string;
}

/** Where a prefilled value came from, so a person can check it against the message. */
function Source({ quote }: { quote: string }): ReactNode {
  return (
    <>
      From the message: <span dir="auto">“{quote}”</span>
    </>
  );
}

/** Opens a project from the message: name from the subject, service family from the category, tender number and closing date when the text states them. */
export function CreateProjectDialog({ detail, open, onOpenChange }: { detail: EmailDetail; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { email } = detail;
  const formId = useId();
  const categories = useCategories();
  const link = useLinkEmail();
  const after = useAfterLink(detail, "created");
  const suggestions = useMemo(() => suggestFromMail(email), [email]);
  const families = useMemo(
    () =>
      (categories.data ?? [])
        .filter((c) => c.group === "work")
        .sort((a, b) => a.order - b.order)
        .map((c) => ({ value: c.key, label: c.label })),
    [categories.data],
  );
  const initial = (): FormState => ({
    name: projectNameFromSubject(email.subject),
    service_family: families.some((f) => f.value === email.category)
      ? email.category
      : families.some((f) => f.value === "other_work")
        ? "other_work"
        : (families[0]?.value ?? "other_work"),
    work_type: "supply_installation",
    request_kind: suggestions.tenderNo ? "tender_rfq" : "direct_rfq",
    due_date: suggestions.dueDate?.value ?? "",
    tender_no: suggestions.tenderNo?.value ?? "",
    location: "",
  });
  const [form, setForm] = useState<FormState>(initial);
  const [nameError, setNameError] = useState<string | null>(null);
  const { reset } = link;

  useEffect(() => {
    if (open) {
      setForm(initial());
      setNameError(null);
      reset();
    }
    // The form starts again each time the dialog opens, from the message as it is then.
  }, [open]);

  const set = (key: keyof FormState) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const name = form.name.trim();
    if (!name) {
      setNameError("Give the project a name.");
      return;
    }
    const spec: NewProjectSpec = {
      name,
      service_family: form.service_family,
      work_type: form.work_type,
      request_kind: form.request_kind,
      ...(form.tender_no.trim() ? { tender_no: form.tender_no.trim() } : {}),
      ...(form.due_date ? { due_date: form.due_date } : {}),
      ...(form.location.trim() ? { location: form.location.trim() } : {}),
    };
    link.mutate(
      { id: email.id, target: { create: spec } },
      {
        onSuccess: (res) => {
          onOpenChange(false);
          after(res);
        },
        onError: (err) => {
          if (isApiError(err, "name_required")) setNameError(err.message);
        },
      },
    );
  };

  const familyOptions = families.length ? families : [{ value: form.service_family, label: form.service_family }];
  const fieldError = isApiError(link.error, "name_required");

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !link.isPending && onOpenChange(o)}
      title="Create project from this message"
      description="Filled in from the message. Check it, then create the project."
      size="lg"
      hideClose={link.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={link.isPending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={link.isPending}>
            Create project and file the mail
          </Button>
          {link.isError && !fieldError ? <InlineError error={link.error} className="sm:order-first sm:mr-auto sm:self-center" /> : null}
        </>
      }
    >
      <div className="space-y-4">
        <FilingNote detail={detail} creating family={form.service_family} />
        <form id={formId} onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
          <Field label="Project name" required error={nameError} className="sm:col-span-2" hint="Taken from the subject. Change it to the building or tender name.">
            <Input
              value={form.name}
              dir="auto"
              autoFocus
              onChange={(e) => {
                set("name")(e.target.value);
                if (nameError) setNameError(null);
              }}
            />
          </Field>
          <Field label="Service family" hint={categoriesHint(email.category, families)}>
            <Select value={form.service_family} onChange={(e) => set("service_family")(e.target.value)} options={familyOptions} />
          </Field>
          <Field label="Work type">
            <Select value={form.work_type} onChange={(e) => set("work_type")(e.target.value)} options={WORK_TYPES.map((k) => ({ value: k, label: workTypeLabel(k) }))} />
          </Field>
          <Field label="Request kind">
            <Select value={form.request_kind} onChange={(e) => set("request_kind")(e.target.value)} options={REQUEST_KINDS.map((k) => ({ value: k, label: requestKindLabel(k) }))} />
          </Field>
          <Field
            label="Closing date"
            optional
            hint={suggestions.dueDate && form.due_date === suggestions.dueDate.value ? <Source quote={suggestions.dueDate.quote} /> : undefined}
          >
            <DateInput value={form.due_date} onChange={set("due_date")} />
          </Field>
          <Field
            label="Tender number"
            optional
            hint={suggestions.tenderNo && form.tender_no === suggestions.tenderNo.value ? <Source quote={suggestions.tenderNo.quote} /> : undefined}
          >
            <Input value={form.tender_no} onChange={(e) => set("tender_no")(e.target.value)} />
          </Field>
          <Field label="Location" optional>
            <Input value={form.location} dir="auto" onChange={(e) => set("location")(e.target.value)} />
          </Field>
        </form>
        <p className="text-xs text-ink-3">
          Sender: <span dir="auto">{senderName(email)}</span> <span dir="ltr">{email.from_email}</span>
        </p>
      </div>
    </Dialog>
  );
}

/** Says where the service family came from when it is not simply the message's own category. */
function categoriesHint(category: string, families: { value: string }[]): string | undefined {
  if (!families.length) return undefined;
  return families.some((f) => f.value === category) ? "From the category of the message." : "The message is not filed as work, so choose the family of the work.";
}
