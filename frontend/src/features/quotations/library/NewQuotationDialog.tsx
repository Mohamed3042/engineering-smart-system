import { useMutation } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "@/api/client";
import { useCategoryLabel, useWorkspace } from "@/api/session";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/format";
import { workTypeLabel } from "@/lib/labels";
import { quotationHref } from "@/lib/routes";
import { Button, Dialog, EmptyState, Field, InlineError, LoadingRows, SearchInput, Segmented, Select, toast } from "@/ui";
import { useInvalidate, useProject, useProjects, useTemplates, type Quote } from "../api";
import { explainError } from "../lib";

/** One radio row inside a bordered list. */
function RadioRow({
  name,
  checked,
  onChange,
  disabled,
  title,
  meta,
  aside,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  title: ReactNode;
  meta?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 px-4 py-3 transition-colors",
        checked ? "bg-brand-soft/60" : "hover:bg-canvas",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="mt-1 size-4 shrink-0 accent-[var(--color-brand)]"
      />
      <span className="min-w-0 flex-1">
        <span className="block text-base font-medium text-ink">{title}</span>
        {meta ? <span className="block text-sm text-ink-3">{meta}</span> : null}
      </span>
      {aside}
    </label>
  );
}

export function NewQuotationDialog({
  open,
  onOpenChange,
  initialProjectId,
  initialEnquiryId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialProjectId?: string | null;
  initialEnquiryId?: string | null;
}) {
  const ws = useWorkspace();
  const familyLabel = useCategoryLabel();
  const navigate = useNavigate();
  const invalidate = useInvalidate();
  const projects = useProjects(open);
  const templates = useTemplates();
  const [search, setSearch] = useState("");
  const [projectId, setProjectId] = useState<string>(initialProjectId ?? "");
  const [enquiryId, setEnquiryId] = useState<string>(initialEnquiryId ?? "");
  const [templateKey, setTemplateKey] = useState("");
  const defaultLanguage = (ws.settings?.quotations?.default_language as string | undefined) ?? "en";
  // "auto" = let the template rule decide (falling back to the workspace default language).
  const [language, setLanguage] = useState("auto");
  const project = useProject(projectId || null);

  useEffect(() => {
    if (open) {
      setProjectId(initialProjectId ?? "");
      setEnquiryId(initialEnquiryId ?? "");
      setTemplateKey("");
      setLanguage("auto");
      setSearch("");
    }
  }, [open, initialProjectId, initialEnquiryId]);

  const enquiries = project.data?.enquiries ?? [];
  useEffect(() => {
    // One enquiry per contractor: preselect the first that has no quotation yet.
    if (!project.data || enquiryId) return;
    const free = project.data.enquiries.find((e) => !e.quotation_id);
    if (free) setEnquiryId(free.id);
  }, [project.data, enquiryId]);

  const chosenTemplate = templates.data?.find((t) => t.key === templateKey);
  const arabicMissing = chosenTemplate ? !chosenTemplate.languages.includes("ar") : false;
  useEffect(() => {
    if (arabicMissing && language === "ar") setLanguage("en");
    // A chosen template needs a language; the rule cannot decide it any more.
    if (templateKey && language === "auto") setLanguage(defaultLanguage);
  }, [arabicMissing, language, templateKey, defaultLanguage]);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const all = projects.data?.items ?? [];
    return all
      .filter((p) => !needle || [p.name, p.code, p.customer?.name].filter(Boolean).join(" ").toLowerCase().includes(needle))
      .slice(0, 60);
  }, [projects.data, search]);

  const create = useMutation({
    mutationFn: () =>
      api.post<Quote>("/quotations", {
        project_id: projectId,
        enquiry_id: enquiryId || undefined,
        template_key: templateKey || undefined,
        language: language === "auto" ? undefined : language,
      }),
    onSuccess: async (q) => {
      toast.success(`Draft ${q.reference} created`, { description: "Prices are empty: enter each one before approval." });
      await invalidate(["quotations"], ["project", projectId], ["dashboard"]);
      onOpenChange(false);
      navigate(quotationHref(q.id));
    },
  });

  const explained = explainError(create.error);
  const templateOptions = [
    { value: "", label: "Let the template rules choose (recommended)" },
    ...(templates.data ?? [])
      .filter((t) => t.settings?.[language === "auto" ? defaultLanguage : language]?.enabled !== false)
      .map((t) => ({ value: t.key, label: `${t.label.en}${t.languages.includes("ar") ? "" : " (English only)"}` })),
  ];

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !create.isPending && onOpenChange(o)}
      title="New quotation"
      description="Choose the project and the contractor's enquiry. The draft starts with empty prices."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={() => create.mutate()} disabled={!projectId} loading={create.isPending}>
            Create draft
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <section className="space-y-2">
          <h3 className="text-base font-semibold text-ink">Project</h3>
          <SearchInput value={search} onChange={setSearch} placeholder="Search projects" label="Search projects" />
          <div className="max-h-64 overflow-y-auto rounded-lg border border-line" role="radiogroup" aria-label="Project">
            {projects.isLoading ? (
              <LoadingRows rows={3} />
            ) : projects.isError ? (
              <InlineError error={projects.error} className="p-4" />
            ) : rows.length === 0 ? (
              <EmptyState compact title="No project found">
                Projects appear when an enquiry arrives. Try another name.
              </EmptyState>
            ) : (
              <div className="divide-y divide-line">
                {rows.map((p) => (
                  <RadioRow
                    key={p.id}
                    name="project"
                    checked={projectId === p.id}
                    onChange={() => {
                      setProjectId(p.id);
                      setEnquiryId("");
                    }}
                    title={p.name}
                    meta={[familyLabel(p.service_family), workTypeLabel(p.work_type), p.customer?.name].filter(Boolean).join(" · ")}
                  />
                ))}
              </div>
            )}
          </div>
        </section>

        {projectId ? (
          <section className="space-y-2">
            <h3 className="text-base font-semibold text-ink">Enquiry</h3>
            <p className="text-sm text-ink-3">Each contractor's enquiry gets its own quotation, addressed to that contractor.</p>
            {project.isLoading ? (
              <LoadingRows rows={2} />
            ) : project.isError ? (
              <InlineError error={project.error} />
            ) : enquiries.length === 0 ? (
              <p className="rounded-lg border border-line bg-sunken px-4 py-3 text-sm text-ink-2">
                No enquiry is recorded for this project. The quotation is addressed to the project's customer.
              </p>
            ) : (
              <div className="divide-y divide-line rounded-lg border border-line" role="radiogroup" aria-label="Enquiry">
                {enquiries.map((e) => (
                  <RadioRow
                    key={e.id}
                    name="enquiry"
                    checked={enquiryId === e.id}
                    onChange={() => setEnquiryId(e.id)}
                    disabled={Boolean(e.quotation_id)}
                    title={e.customer?.name ?? e.contact?.name ?? e.ref}
                    meta={[
                      e.ref,
                      e.received_at ? `Received ${formatDate(e.received_at)}` : null,
                      e.due_date ? `Closes ${formatDate(e.due_date)}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    aside={
                      e.quotation_id ? (
                        <Link
                          to={quotationHref(e.quotation_id)}
                          className="shrink-0 text-sm font-medium text-brand-ink underline-offset-4 hover:underline"
                        >
                          Has a quotation
                        </Link>
                      ) : null
                    }
                  />
                ))}
              </div>
            )}
          </section>
        ) : null}

        <section className="grid gap-4 sm:grid-cols-[1fr_auto]">
          <Field label="Template" htmlFor="nq-template" hint={templateKey ? undefined : "Your template rules decide, then the project's work type."}>
            <Select id="nq-template" value={templateKey} onChange={(e) => setTemplateKey(e.target.value)} options={templateOptions} />
          </Field>
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-ink">Language</p>
            <Segmented
              label="Language"
              value={language}
              onChange={setLanguage}
              options={[
                ...(templateKey ? [] : [{ value: "auto", label: "As the rule says" }]),
                { value: "en", label: "English" },
                ...(arabicMissing ? [] : [{ value: "ar", label: "Arabic" }]),
              ]}
            />
            {arabicMissing ? (
              <p className="text-sm text-ink-3">This template has no Arabic version.</p>
            ) : language === "auto" ? (
              <p className="text-sm text-ink-3">A template rule may set it; otherwise {defaultLanguage === "ar" ? "Arabic" : "English"}.</p>
            ) : null}
          </div>
        </section>

        {create.error ? (
          explained ? (
            <div role="alert" className="rounded-lg border border-block-line bg-block-soft px-4 py-3 text-sm">
              <p className="font-semibold text-block">{explained.title}</p>
              <p className="mt-0.5 text-ink-2">{explained.message}</p>
            </div>
          ) : (
            <InlineError error={create.error} />
          )
        ) : null}
      </div>
    </Dialog>
  );
}
