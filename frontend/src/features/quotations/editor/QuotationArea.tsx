/**
 * /quotations/:id and /quotations/:id/preview. Loads the quotation once and keeps the person's
 * unsaved edits while they switch between the editor and the PDF preview.
 */
import { useMutation } from "@tanstack/react-query";
import { FileQuestion } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { Link, Navigate, Route, Routes, useBlocker, useNavigate, useParams } from "react-router";
import { api, isApiError } from "@/api/client";
import { quotationHref } from "@/lib/routes";
import { Button, ConfirmDialog, EmptyState, ErrorState, Page, Skeleton, toast } from "@/ui";
import { useQuotation, useQuoteUpdated, type Quote, type QuoteDetail } from "../api";
import { EditorPage } from "./EditorPage";
import { PreviewPage } from "./PreviewPage";
import { useDraft, type Draft, type DraftApi } from "./useDraft";

export interface AreaProps {
  detail: QuoteDetail;
  draft: DraftApi & { draft: Draft };
  save: () => void;
  saving: boolean;
  saveError: unknown;
  /** Navigate away on purpose (after a revision is created): skips the unsaved-changes prompt. */
  leave: (to: string) => void;
}

export function QuotationArea() {
  const { quotationId = "" } = useParams();
  // A new id (e.g. a revision) starts with a fresh working copy.
  return <Area key={quotationId} id={quotationId} />;
}

function AreaLoading() {
  return (
    <Page>
      <div role="status" aria-label="Loading quotation" className="space-y-6">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-9 w-72 max-w-full" />
        <div className="grid gap-4 sm:grid-cols-3">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
        <div className="space-y-3 rounded-xl border border-line bg-surface p-5">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
        <div className="space-y-3 rounded-xl border border-line bg-surface p-5">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      </div>
    </Page>
  );
}

function Area({ id }: { id: string }) {
  const query = useQuotation(id);
  const draft = useDraft(query.data?.quotation);
  const navigate = useNavigate();
  const updated = useQuoteUpdated();
  const leaving = useRef(false);

  const save = useMutation({
    mutationFn: ({ body }: { body: Record<string, unknown>; sent: Draft | null }) => api.put<Quote>(`/quotations/${id}`, body),
    onSuccess: async (saved, { sent }) => {
      draft.accept(saved, sent);
      toast.success("Changes saved", { description: "The PDF is rendered again from the saved version." });
      await updated(saved);
    },
  });
  const { body, draft: current } = draft;
  const doSave = useCallback(() => {
    const b = body();
    if (b) save.mutate({ body: b, sent: current });
  }, [body, current, save]);

  const leave = useCallback(
    (to: string) => {
      leaving.current = true;
      navigate(to);
    },
    [navigate],
  );

  if (query.isLoading) return <AreaLoading />;
  if (query.isError) {
    if (isApiError(query.error) && query.error.status === 404)
      return (
        <Page>
          <EmptyState
            icon={<FileQuestion />}
            title="Quotation not found"
            action={
              <Button variant="secondary" asChild>
                <Link to="/quotations">Open the quotation list</Link>
              </Button>
            }
          >
            It may belong to another workspace, or the link is incomplete.
          </EmptyState>
        </Page>
      );
    return (
      <Page>
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      </Page>
    );
  }
  if (!query.data || !draft.draft) return <AreaLoading />;

  const props: AreaProps = {
    detail: query.data,
    draft: draft as AreaProps["draft"],
    save: doSave,
    saving: save.isPending,
    saveError: save.error,
    leave,
  };
  return (
    <>
      <Routes>
        <Route index element={<EditorPage {...props} />} />
        <Route path="preview" element={<PreviewPage {...props} />} />
        <Route path="*" element={<Navigate to={quotationHref(id)} replace />} />
      </Routes>
      <LeaveGuard id={id} dirty={draft.dirty} leaving={leaving} />
    </>
  );
}

/** Asks before leaving the quotation with unsaved changes (moving between editor and preview is fine). */
function LeaveGuard({ id, dirty, leaving }: { id: string; dirty: boolean; leaving: { current: boolean } }) {
  const base = `/quotations/${id}`;
  const blocker = useBlocker(
    ({ nextLocation }) =>
      dirty && !leaving.current && nextLocation.pathname !== base && !nextLocation.pathname.startsWith(`${base}/`),
  );
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  return (
    <ConfirmDialog
      open={blocker.state === "blocked"}
      onOpenChange={(o) => {
        if (!o && blocker.state === "blocked") blocker.reset();
      }}
      title="Leave without saving?"
      description="Your changes to this quotation are not saved."
      confirmLabel="Leave and discard changes"
      cancelLabel="Stay and keep editing"
      variant="danger"
      onConfirm={() => blocker.state === "blocked" && blocker.proceed()}
    >
      <p className="text-sm text-ink-2">If you leave now, what you typed since the last save is lost.</p>
    </ConfirmDialog>
  );
}
