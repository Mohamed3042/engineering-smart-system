/**
 * New project (mockup 60, manual variant): a project for a tender or building that did not
 * arrive through the mailbox scan. POST /api/projects.
 */
import { useEffect, useId, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "@/api/client";
import { useCategories } from "@/api/session";
import type { Project } from "@/api/types";
import { requestKindLabel, workTypeLabel } from "@/lib/labels";
import { projectHref } from "@/lib/routes";
import { Button, DateInput, Dialog, Field, Input, InlineError, Select, Textarea } from "@/ui";
import { useCustomerOptions, useProjectMutation, useTeam } from "./api";
import { REQUEST_KINDS, WORK_TYPES } from "./lib";

interface FormState {
  name: string;
  customer_id: string;
  service_family: string;
  work_type: string;
  request_kind: string;
  due_date: string;
  tender_no: string;
  location: string;
  assigned_to: string;
  summary: string;
}

const blank = (family?: string): FormState => ({
  name: "",
  customer_id: "",
  service_family: family || "bmu",
  work_type: "supply_installation",
  request_kind: "tender_rfq",
  due_date: "",
  tender_no: "",
  location: "",
  assigned_to: "",
  summary: "",
});

export function NewProjectDialog({
  open,
  onOpenChange,
  defaultFamily,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  defaultFamily?: string;
}) {
  const formId = useId();
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState>(() => blank(defaultFamily));
  const [nameError, setNameError] = useState<string | null>(null);
  const { data: categories } = useCategories();
  const customers = useCustomerOptions(open);
  const team = useTeam(open);

  useEffect(() => {
    if (open) {
      setForm(blank(defaultFamily));
      setNameError(null);
    }
  }, [open, defaultFamily]);

  const create = useProjectMutation((body: Record<string, string>) => api.post<Project>("/projects", body), {
    success: (p) => `Project created: ${p.name}`,
    toastErrors: false,
    onSuccess: (p) => {
      onOpenChange(false);
      navigate(projectHref(p.id));
    },
  });

  const set = (key: keyof FormState) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) {
      setNameError("Enter the project or building name.");
      return;
    }
    const body: Record<string, string> = {};
    for (const [k, v] of Object.entries(form)) if (v.trim()) body[k] = v.trim();
    create.mutate(body);
  };

  const families = (categories ?? [])
    .filter((c) => c.group === "work")
    .sort((a, b) => a.order - b.order)
    .map((c) => ({ value: c.key, label: c.label }));

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !create.isPending && onOpenChange(o)}
      title="New project"
      description="For a tender or building that did not arrive by email. Enquiries from the mailbox are linked automatically."
      size="lg"
      hideClose={create.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={create.isPending}>
            Create project
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <Field label="Project name" required error={nameError} className="sm:col-span-2" htmlFor={`${formId}-name`}>
          <Input
            id={`${formId}-name`}
            value={form.name}
            invalid={!!nameError}
            autoFocus
            onChange={(e) => {
              set("name")(e.target.value);
              if (nameError) setNameError(null);
            }}
            placeholder="Building or tender name"
          />
        </Field>
        <Field
          label="Customer"
          optional
          className="sm:col-span-2"
          htmlFor={`${formId}-customer`}
          hint="Choosing a customer also records their enquiry for this project."
        >
          <Select
            id={`${formId}-customer`}
            value={form.customer_id}
            onChange={(e) => set("customer_id")(e.target.value)}
            placeholder={customers.isLoading ? "Loading customers…" : "No customer yet"}
            options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))}
          />
        </Field>
        <Field label="Service family" htmlFor={`${formId}-family`}>
          <Select
            id={`${formId}-family`}
            value={form.service_family}
            onChange={(e) => set("service_family")(e.target.value)}
            options={families.length ? families : [{ value: form.service_family, label: form.service_family }]}
          />
        </Field>
        <Field label="Work type" htmlFor={`${formId}-work`}>
          <Select
            id={`${formId}-work`}
            value={form.work_type}
            onChange={(e) => set("work_type")(e.target.value)}
            options={WORK_TYPES.map((k) => ({ value: k, label: workTypeLabel(k) }))}
          />
        </Field>
        <Field label="Request kind" htmlFor={`${formId}-kind`}>
          <Select
            id={`${formId}-kind`}
            value={form.request_kind}
            onChange={(e) => set("request_kind")(e.target.value)}
            options={REQUEST_KINDS.map((k) => ({ value: k, label: requestKindLabel(k) }))}
          />
        </Field>
        <Field label="Closing date" optional htmlFor={`${formId}-due`}>
          <DateInput id={`${formId}-due`} value={form.due_date} onChange={set("due_date")} />
        </Field>
        <Field label="Tender number" optional htmlFor={`${formId}-tender`}>
          <Input id={`${formId}-tender`} value={form.tender_no} onChange={(e) => set("tender_no")(e.target.value)} />
        </Field>
        <Field label="Location" optional htmlFor={`${formId}-location`}>
          <Input id={`${formId}-location`} value={form.location} onChange={(e) => set("location")(e.target.value)} />
        </Field>
        <Field label="Owner" optional htmlFor={`${formId}-owner`} className="sm:col-span-2">
          <Select
            id={`${formId}-owner`}
            value={form.assigned_to}
            onChange={(e) => set("assigned_to")(e.target.value)}
            placeholder="Nobody yet"
            options={(team.data ?? []).filter((m) => m.active).map((m) => ({ value: m.id, label: m.name }))}
          />
        </Field>
        <Field label="Summary" optional htmlFor={`${formId}-summary`} className="sm:col-span-2">
          <Textarea
            id={`${formId}-summary`}
            rows={3}
            value={form.summary}
            onChange={(e) => set("summary")(e.target.value)}
            placeholder="What the customer asks for, in a sentence or two"
          />
        </Field>
        {create.error ? <InlineError error={create.error} className="sm:col-span-2" /> : null}
      </form>
    </Dialog>
  );
}
