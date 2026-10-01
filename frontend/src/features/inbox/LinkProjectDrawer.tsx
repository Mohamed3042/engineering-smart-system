import { useDeferredValue, useState } from "react";
import { useCategories } from "@/api/session";
import { formatDate } from "@/lib/format";
import { Button, Drawer, Field, InlineError, Input, QueryState, SearchInput, Segmented, Select, toast } from "@/ui";
import { useLinkEmail, useLinkProjects, useProjectEnquiries, type EmailDetail, type NewProjectFromEmail } from "./api";
import { REQUEST_KIND_OPTIONS, WORK_TYPE_OPTIONS } from "./labels";

/** Filing is a deliberate choice: the original mailbox message stays as it is. */
export function LinkProjectDrawer({ detail, open, onOpenChange }: { detail: EmailDetail; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [mode, setMode] = useState("existing");
  const [search, setSearch] = useState("");
  const [projectId, setProjectId] = useState(detail.project?.id ?? "");
  const [enquiryId, setEnquiryId] = useState("");
  const [form, setForm] = useState<NewProjectFromEmail>({
    name: detail.email.subject.replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, ""),
    service_family: detail.category?.group === "work" ? detail.email.category : "other_work",
    work_type: "", request_kind: "direct_rfq", due_date: "", tender_no: "", location: "",
  });
  const projects = useLinkProjects(useDeferredValue(search.trim()), open && mode === "existing");
  const enquiries = useProjectEnquiries(mode === "existing" && open ? projectId : null);
  const categories = useCategories();
  const link = useLinkEmail();
  const update = (key: keyof NewProjectFromEmail, value: string) => setForm((f) => ({ ...f, [key]: value }));
  const validNewProject = !!form.name.trim() && WORK_TYPE_OPTIONS.some((choice) => choice.value === form.work_type);
  const save = () => {
    if (mode === "new" && !validNewProject) return;
    link.mutate(
      mode === "existing" ? { id: detail.email.id, project_id: projectId, enquiry_id: enquiryId || undefined } : { id: detail.email.id, create: { ...form, name: form.name.trim() } },
      { onSuccess: (result) => { toast.success(result.created ? "Project opened from the message" : "Message filed under the project"); onOpenChange(false); } },
    );
  };
  return (
    <Drawer open={open} onOpenChange={(v) => !link.isPending && onOpenChange(v)} title="File under a project" description="The conversation, attachments and shared links follow this choice. Messages already filed elsewhere stay there." footer={
      <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="secondary" disabled={link.isPending} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button onClick={save} loading={link.isPending} disabled={mode === "existing" ? !projectId || enquiries.isLoading || enquiries.isError : !validNewProject}>{mode === "existing" ? "File message" : "Open project"}</Button>
      </div>
    }>
      <fieldset disabled={link.isPending} className="space-y-5">
        <Segmented label="Where to file this message" value={mode} onChange={setMode} options={[{ value: "existing", label: "Choose project" }, { value: "new", label: "New project" }]} />
        {mode === "existing" ? <>
          <SearchInput label="Find a project" placeholder="Project, tender or code" value={search} onChange={setSearch} />
          <QueryState query={projects} compact>{(data) => <Field label="Project" required hint={data.items.length ? undefined : "No project matches. Try another search or open a new project."}>
            <Select dir="auto" value={projectId} onChange={(e) => { setProjectId(e.target.value); setEnquiryId(""); link.reset(); }} placeholder="Choose a project" options={[
              ...(projectId && !data.items.some((p) => p.id === projectId) ? [{ value: projectId, label: detail.project?.id === projectId ? detail.project.name : "Selected project" }] : []),
              ...data.items.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}${p.customer?.name ? ` · ${p.customer.name}` : ""}` })),
            ]} />
          </Field>}</QueryState>
          {projectId ? <QueryState query={enquiries} compact>{(rows) => <Field label="Customer enquiry" hint="Automatic creates or uses the sender's enquiry. Choose an existing enquiry when this message belongs to it.">
            <Select dir="auto" value={enquiryId} onChange={(e) => setEnquiryId(e.target.value)} options={[{ value: "", label: "Automatic — use the sender's enquiry" }, ...rows.map((e) => ({ value: e.id, label: `${e.contact.name || e.contact.email || e.ref}${e.due_date ? ` · closes ${formatDate(e.due_date)}` : ""}` }))]} />
          </Field>}</QueryState> : null}
        </> : <div className="space-y-4">
          <Field label="Project name" required><Input autoFocus dir="auto" value={form.name} onChange={(e) => update("name", e.target.value)} /></Field>
          <Field label="Service"><Select value={form.service_family} onChange={(e) => update("service_family", e.target.value)} options={(categories.data ?? []).filter((c) => c.group === "work").map((c) => ({ value: c.key, label: c.label }))} /></Field>
          <Field label="Work type" required hint="Choose the work type confirmed in the customer's request."><Select required value={form.work_type} onChange={(e) => update("work_type", e.target.value)} placeholder="Choose a work type" options={WORK_TYPE_OPTIONS} /></Field>
          <Field label="Request"><Select value={form.request_kind} onChange={(e) => update("request_kind", e.target.value)} options={REQUEST_KIND_OPTIONS} /></Field>
          <Field label="Tender number" optional><Input dir="auto" value={form.tender_no} onChange={(e) => update("tender_no", e.target.value)} /></Field>
          <Field label="Closing date" optional hint="Only enter a date confirmed in the customer's message."><Input type="date" value={form.due_date} onChange={(e) => update("due_date", e.target.value)} /></Field>
          <Field label="Location" optional><Input dir="auto" value={form.location} onChange={(e) => update("location", e.target.value)} /></Field>
        </div>}
        <InlineError error={link.error} />
      </fieldset>
    </Drawer>
  );
}
