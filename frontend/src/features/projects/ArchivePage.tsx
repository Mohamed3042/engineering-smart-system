/**
 * Project archive (mockup 68): archived projects with Restore. Sources, reviews and quotations
 * stay attached to an archived project.
 */
import { Archive, ArchiveRestore, FileText } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { api } from "@/api/client";
import { useCategoryLabel } from "@/api/session";
import { formatDate } from "@/lib/format";
import { projectHref } from "@/lib/routes";
import {
  Button,
  EmptyState,
  ErrorState,
  ListRow,
  LoadingRows,
  Page,
  PageHeader,
  Panel,
  SearchInput,
  Segmented,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/ui";
import { useProjectList, useProjectMutation, type ProjectSummary } from "./api";
import { familyLabel } from "./lib";
import { Bidi } from "./parts";

export function ArchivePage() {
  const query = useProjectList({ include_archived: true });
  const categoryLabel = useCategoryLabel();
  const [q, setQ] = useState("");
  const [family, setFamily] = useState("all");

  const restore = useProjectMutation((p: ProjectSummary) => api.post(`/projects/${p.id}/restore`), {
    invalidate: (_r, p) => [["project", p.id]],
    success: (_r, p) => `Restored: ${p.name} is back in Projects`,
  });

  const archived = useMemo(
    () =>
      (query.data?.items ?? [])
        .filter((p) => p.archived_at)
        .sort((a, b) => String(b.archived_at).localeCompare(String(a.archived_at))),
    [query.data],
  );
  const families = useMemo(() => [...new Set(archived.map((p) => p.service_family))], [archived]);
  const rows = archived.filter((p) => {
    if (family !== "all" && p.service_family !== family) return false;
    if (!q) return true;
    const hay = [p.name, p.code, p.tender_no, p.customer?.name].filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q.toLowerCase());
  });

  const restoreButton = (p: ProjectSummary, className?: string) => (
    <Button
      size="sm"
      icon={<ArchiveRestore />}
      className={className}
      loading={restore.isPending && restore.variables?.id === p.id}
      onClick={() => restore.mutate(p)}
    >
      Restore
    </Button>
  );
  const recordsButton = (p: ProjectSummary, className?: string) => (
    <Button asChild size="sm" variant="secondary" className={className}>
      <Link to={projectHref(p.id)}>
        <FileText aria-hidden />
        View records
      </Link>
    </Button>
  );

  return (
    <Page>
      <PageHeader
        back={{ to: "/projects", label: "Projects" }}
        title="Project archive"
        meta="Emails, files, reviews and quotations stay with each project. Restore a project to work on it again."
      />

      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center">
        <SearchInput value={q} onChange={setQ} placeholder="Search archived projects" label="Search archived projects" className="md:w-80" />
        {families.length > 1 ? (
          <Segmented
            label="Service family"
            value={family}
            onChange={setFamily}
            options={[{ value: "all", label: "All" }, ...families.map((k) => ({ value: k, label: familyLabel(k, categoryLabel) }))]}
          />
        ) : null}
      </div>

      {query.isLoading ? (
        <Panel>
          <LoadingRows rows={4} />
        </Panel>
      ) : query.isError ? (
        <Panel>
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        </Panel>
      ) : archived.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<Archive />}
            title="No archived projects"
            action={
              <Button asChild variant="secondary">
                <Link to="/projects">Go to projects</Link>
              </Button>
            }
          >
            When you archive a project it moves here with its emails, files, reviews and quotations. You can restore it at any time.
          </EmptyState>
        </Panel>
      ) : rows.length === 0 ? (
        <Panel>
          <EmptyState title="No archived projects match" compact action={<Button variant="secondary" onClick={() => { setQ(""); setFamily("all"); }}>Clear filters</Button>}>
            Try another search word.
          </EmptyState>
        </Panel>
      ) : (
        <>
          <Panel className="hidden overflow-hidden md:block">
            <Table>
              <THead>
                <tr>
                  <TH>Project</TH>
                  <TH>Customer</TH>
                  <TH>Service family</TH>
                  <TH>Archived</TH>
                  <TH className="text-right">Actions</TH>
                </tr>
              </THead>
              <TBody>
                {rows.map((p) => (
                  <TR key={p.id}>
                    <TD>
                      <Bidi text={p.name} as="div" className="font-semibold text-ink" />
                      <div className="mt-0.5 text-sm text-ink-3">{[p.code, p.tender_no ? `Tender ${p.tender_no}` : null].filter(Boolean).join(" · ")}</div>
                    </TD>
                    <TD>{p.customer ? <Bidi text={p.customer.name} /> : <span className="text-ink-3">—</span>}</TD>
                    <TD className="whitespace-nowrap">{familyLabel(p.service_family, categoryLabel)}</TD>
                    <TD className="whitespace-nowrap tabular">{formatDate(p.archived_at)}</TD>
                    <TD>
                      <div className="flex justify-end gap-2">
                        {restoreButton(p)}
                        {recordsButton(p)}
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Panel>
          <ul className="space-y-3 md:hidden" aria-label="Archived projects">
            {rows.map((p) => (
              <li key={p.id}>
                <ListRow
                  title={<Bidi text={p.name} />}
                  subtitle={familyLabel(p.service_family, categoryLabel)}
                  footer={
                    <div className="grid grid-cols-2 gap-2">
                      {restoreButton(p, "w-full")}
                      {recordsButton(p, "w-full")}
                    </div>
                  }
                >
                  <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1.5">
                    <dt className="text-ink-3">Customer</dt>
                    <dd className="min-w-0 break-words text-ink">{p.customer?.name ?? "—"}</dd>
                    <dt className="text-ink-3">Archived</dt>
                    <dd className="tabular text-ink">{formatDate(p.archived_at)}</dd>
                    <dt className="text-ink-3">Reference</dt>
                    <dd className="text-ink">{p.code}</dd>
                  </dl>
                </ListRow>
              </li>
            ))}
          </ul>
        </>
      )}
    </Page>
  );
}
