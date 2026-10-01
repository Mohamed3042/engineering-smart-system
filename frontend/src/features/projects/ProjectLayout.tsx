/**
 * One project: header (name, references, stage), URL tabs and the nested tab screens.
 * Tabs: Overview · Enquiries · Inputs · Analysis · Review · Documents, plus /changes/:index.
 */
import { Archive, ArchiveRestore, Ellipsis, RefreshCw } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { Link, Route, Routes, useLocation, useNavigate, useParams } from "react-router";
import { api } from "@/api/client";
import { useCategoryLabel } from "@/api/session";
import { requestKindLabel, stageInfo, workTypeLabel } from "@/lib/labels";
import { projectHref } from "@/lib/routes";
import {
  Banner,
  Button,
  Chip,
  ConfirmDialog,
  EmptyState,
  Field,
  IconButton,
  LinkTabs,
  Menu,
  Page,
  PageHeader,
  Skeleton,
  StatusChip,
  Textarea,
  toast,
} from "@/ui";
import { useProject, useProjectMutation, useProjectWork, type ProjectDetail } from "./api";
import { actionHref } from "./lib";
import { Bidi, DueDate, NextActionButton, NotFoundOrError, PanelSkeleton, WorkStatus } from "./parts";

const OverviewTab = lazy(() => import("./tabs/OverviewTab").then((m) => ({ default: m.OverviewTab })));
const EnquiriesTab = lazy(() => import("./tabs/EnquiriesTab").then((m) => ({ default: m.EnquiriesTab })));
const InputsTab = lazy(() => import("./tabs/InputsTab").then((m) => ({ default: m.InputsTab })));
const AnalysisTab = lazy(() => import("./tabs/AnalysisTab").then((m) => ({ default: m.AnalysisTab })));
const ReviewTab = lazy(() => import("./tabs/ReviewTab").then((m) => ({ default: m.ReviewTab })));
const DocumentsTab = lazy(() => import("./tabs/DocumentsTab").then((m) => ({ default: m.DocumentsTab })));
const ChangeTab = lazy(() => import("./tabs/ChangeTab").then((m) => ({ default: m.ChangeTab })));

export interface TabProps {
  detail: ProjectDetail;
}

function TabLoading() {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
      <PanelSkeleton lines={6} />
      <PanelSkeleton lines={4} />
    </div>
  );
}

function HeaderSkeleton() {
  return (
    <div className="mb-8 space-y-3" role="status" aria-label="Loading project">
      <Skeleton className="h-4 w-20" />
      <Skeleton className="h-9 w-[28rem] max-w-full" />
      <Skeleton className="h-4 w-80 max-w-full" />
      <Skeleton className="mt-6 h-11 w-full" />
    </div>
  );
}

export function ProjectLayout() {
  const { projectId = "" } = useParams();
  const query = useProject(projectId);

  if (query.isLoading) {
    return (
      <Page>
        <HeaderSkeleton />
        <TabLoading />
      </Page>
    );
  }
  if (query.isError || !query.data) {
    return <NotFoundOrError error={query.error} onRetry={() => query.refetch()} />;
  }
  return <ProjectFrame detail={query.data} />;
}

function ProjectFrame({ detail }: { detail: ProjectDetail }) {
  const p = detail.project;
  const location = useLocation();
  const navigate = useNavigate();
  const categoryLabel = useCategoryLabel();
  const { refresh } = useProjectWork(p.id);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [reason, setReason] = useState("");

  const restore = useProjectMutation(() => api.post(`/projects/${p.id}/restore`), {
    projectId: p.id,
    success: "Project restored",
  });
  const archive = useProjectMutation((r: string) => api.post(`/projects/${p.id}/archive`, r ? { reason: r } : {}), {
    projectId: p.id,
    toastErrors: true,
    onSuccess: () => {
      setArchiveOpen(false);
      toast.success(`Archived: ${p.name}`, {
        description: "Find it under Projects › Archive.",
        action: { label: "Undo", onClick: () => restore.mutate() },
      });
      navigate("/projects");
    },
  });

  const nextHref = actionHref(p.id, p.next_action);
  const showNext = !p.archived_at && nextHref.split("?")[0] !== location.pathname;
  const quotations = detail.quotations.filter((q) => q.status !== "superseded");

  const meta = (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {detail.customer ? <Bidi text={detail.customer.name} className="text-ink-2" /> : null}
        {[categoryLabel(p.service_family), workTypeLabel(p.work_type), requestKindLabel(p.request_kind)].map((t) => (
          <span key={t} className="before:mr-2 before:content-['·'] first:before:hidden">
            {t}
          </span>
        ))}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span>{p.code}</span>
        {p.tender_no ? <span>Tender {p.tender_no}</span> : null}
        <span className="inline-flex items-center gap-1.5">
          Closing
          <DueDate value={p.due_date} inline />
        </span>
      </div>
    </>
  );

  return (
    <Page>
      <PageHeader
        back={{ to: "/projects", label: "Projects" }}
        title={<Bidi text={p.name} />}
        status={
          <>
            <StatusChip info={stageInfo(p.stage)} />
            {p.archived_at ? <Chip tone="muted">Archived</Chip> : null}
          </>
        }
        meta={meta}
        actions={
          <>
            {showNext ? <NextActionButton projectId={p.id} action={p.next_action} className="flex-1 md:flex-none" /> : null}
            <Menu
              trigger={
                <IconButton label="Project actions" variant="secondary">
                  <Ellipsis />
                </IconButton>
              }
              items={[
                { label: "Refresh", icon: <RefreshCw />, onSelect: () => void refresh() },
                p.archived_at
                  ? { label: "Restore project", icon: <ArchiveRestore />, onSelect: () => restore.mutate(), separatorBefore: true }
                  : { label: "Archive project", icon: <Archive />, onSelect: () => setArchiveOpen(true), separatorBefore: true },
              ]}
            />
          </>
        }
      />

      <LinkTabs
        label="Project sections"
        className="mb-6"
        tabs={[
          { to: projectHref(p.id), label: "Overview", end: true },
          { to: projectHref(p.id, "enquiries"), label: "Enquiries", count: detail.enquiries.length },
          { to: projectHref(p.id, "inputs"), label: "Inputs", count: detail.files.length },
          { to: projectHref(p.id, "analysis"), label: "Analysis" },
          { to: projectHref(p.id, "review"), label: "Review" },
          { to: projectHref(p.id, "documents"), label: "Documents", count: quotations.length },
        ]}
      />

      <WorkStatus projectId={p.id} className="mb-6" />

      {p.archived_at ? (
        <Banner
          tone="neutral"
          className="mb-6"
          title="This project is archived"
          actions={
            <Button size="sm" variant="secondary" icon={<ArchiveRestore />} loading={restore.isPending} onClick={() => restore.mutate()}>
              Restore project
            </Button>
          }
        >
          It stays out of your active lists. Its emails, files, reviews and quotations are kept.
        </Banner>
      ) : null}

      <Suspense fallback={<TabLoading />}>
        <Routes>
          <Route index element={<OverviewTab detail={detail} />} />
          <Route path="enquiries" element={<EnquiriesTab detail={detail} />} />
          <Route path="inputs" element={<InputsTab detail={detail} />} />
          <Route path="analysis" element={<AnalysisTab detail={detail} />} />
          <Route path="review" element={<ReviewTab detail={detail} />} />
          <Route path="documents" element={<DocumentsTab detail={detail} />} />
          <Route path="changes/:index" element={<ChangeTab detail={detail} />} />
          <Route
            path="*"
            element={
              <EmptyState
                title="This section does not exist"
                action={
                  <Button asChild variant="secondary">
                    <Link to={projectHref(p.id)}>Open overview</Link>
                  </Button>
                }
              >
                Use the tabs above to continue.
              </EmptyState>
            }
          />
        </Routes>
      </Suspense>

      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={(o) => {
          setArchiveOpen(o);
          if (!o) setReason("");
        }}
        title={
          <span>
            Archive <Bidi text={p.name} />?
          </span>
        }
        description="The project leaves your active lists. Its emails, files, review notes and quotations stay in the archive."
        confirmLabel="Archive project"
        loading={archive.isPending}
        onConfirm={() => archive.mutate(reason.trim())}
      >
        <div className="space-y-4">
          <Field label="Reason" optional hint="For example: tender cancelled, awarded to another contractor.">
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <p className="text-sm text-ink-3">You can restore this project from the archive at any time.</p>
        </div>
      </ConfirmDialog>
    </Page>
  );
}
