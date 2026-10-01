/**
 * /quotations/:id/preview (mockup 27): the rendered PDF with its DRAFT state, the unmet conditions
 * for final approval, and a plain statement that drafts carry no signature and no stamp.
 * Phones get the conditions first and an "Open PDF" button instead of an embedded viewer.
 */
import { useMutation } from "@tanstack/react-query";
import { CircleCheck, ExternalLink, FilePen, PenOff, RefreshCw, Save } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "@/api/client";
import { formatDateTime } from "@/lib/format";
import { quotationHref } from "@/lib/routes";
import { Banner, Button, Chip, KeyValue, Page, PageHeader, Panel, PanelBody, PanelHeader, toast, toastError } from "@/ui";
import { pdfUrl, useInvalidate } from "../api";
import { GateList, QuoteStatusChip } from "../components";
import { blockerGates, blockersOf, paperModeLabel, revisionLabel } from "../lib";
import type { AreaProps } from "./QuotationArea";
import { RenderedPages } from "./RenderedPages";

export function PreviewPage({ detail, draft, save, saving }: AreaProps) {
  const q = detail.quotation;
  const invalidate = useInvalidate();
  const [bump, setBump] = useState(0);
  const rev = revisionLabel(q);
  const final = q.status === "approved" || q.status === "sent";
  const blockers = blockersOf(q, detail);
  const src = pdfUrl(q.id, `${q.updated_at}|${q.pdf_rendered_at ?? ""}|${bump}`);
  // A draft is rendered without the signature on purpose: that is not a missing asset.
  const warnings = (q.assets_status?.warnings ?? []).filter((w) => final || !/^No signature image/i.test(w));

  const render = useMutation({
    mutationFn: () => api.post<{ pdf: string }>(`/quotations/${q.id}/render`),
    onSuccess: async () => {
      setBump((b) => b + 1);
      toast.success("PDF rendered again");
      await invalidate(["quotation", q.id]);
    },
    onError: (e) => toastError(e, "The PDF could not be rendered"),
  });

  const openPdf = (cls?: string) => (
    <Button variant="secondary" asChild className={cls}>
      <a href={src} target="_blank" rel="noreferrer">
        <ExternalLink className="size-[1.125rem]" aria-hidden />
        Open PDF
      </a>
    </Button>
  );

  return (
    <Page>
      <PageHeader
        back={{ to: quotationHref(q.id), label: "Back to the editor" }}
        title={<span className="tabular">{rev}</span>}
        status={
          <>
            <QuoteStatusChip q={q} />
            {!final ? (
              <Chip tone="review" icon={<FilePen aria-hidden />}>
                DRAFT · not signed
              </Chip>
            ) : null}
          </>
        }
        meta={`PDF preview${q.pdf_rendered_at ? ` · rendered ${formatDateTime(q.pdf_rendered_at)}` : ""}`}
        actions={
          <>
            <Button variant="secondary" icon={<RefreshCw />} onClick={() => render.mutate()} loading={render.isPending}>
              Re-render
            </Button>
            {openPdf("hidden md:inline-flex")}
          </>
        }
      />

      {draft.dirty ? (
        <Banner
          tone="review"
          title="Unsaved changes are not in this PDF"
          className="mb-6"
          actions={
            q.status === "approved" || q.status === "sent" ? null : (
              <Button size="sm" icon={<Save />} onClick={save} loading={saving}>
                Save changes
              </Button>
            )
          }
        >
          The PDF shows the last saved version of {rev}.
        </Banner>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-start">
        <Panel className="lg:col-start-2 lg:row-start-1">
          <PanelHeader title={final ? "Approved PDF" : "Draft PDF"} description={`Revision ${rev}`} />
          <PanelBody className="space-y-4">
            {final ? (
              <p className="flex items-start gap-2 text-sm text-ink-2">
                <CircleCheck className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
                <span>
                  Approved{q.approved_by ? ` by ${q.approved_by}` : ""}
                  {q.approved_at ? ` on ${formatDateTime(q.approved_at)}` : ""}. The PDF carries the signature and the company stamp
                  where they are installed.
                </span>
              </p>
            ) : (
              <>
                <p className="flex items-start gap-2 text-sm text-ink-2">
                  <PenOff className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
                  <span>
                    <span className="font-medium text-ink">This draft carries no signature and no stamp.</span> An empty signature
                    space means the quotation is not signed off. It is not an offer and must not be sent.
                  </span>
                </p>
                {blockers.length ? (
                  <div>
                    <p className="text-sm font-medium text-ink">Conditions for final approval ({blockers.length} open)</p>
                    <GateList gates={blockerGates(blockers, q, false)} compact className="mt-1" />
                  </div>
                ) : (
                  <p className="flex items-start gap-2 text-sm font-medium text-brand-ink">
                    <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
                    {q.status === "needs_review"
                      ? "Every condition for approval is met. It waits for approval."
                      : "Every condition for approval is met. Submit it for approval in the editor."}
                  </p>
                )}
              </>
            )}
            {warnings.length ? (
              <ul className="space-y-1.5">
                {warnings.map((w) => (
                  <li key={w} className="text-sm text-review">
                    {w}
                  </li>
                ))}
              </ul>
            ) : null}
            <KeyValue
              labelWidth="sm"
              items={[
                {
                  label: "Paper",
                  value: q.assets_status?.paper_name ?? (q.assets_status?.mode ? paperModeLabel(q.assets_status.mode) : "Not rendered yet"),
                },
                { label: "Rendered", value: q.pdf_rendered_at ? formatDateTime(q.pdf_rendered_at) : "On first open" },
              ]}
            />
            {openPdf("w-full md:hidden")}
            <Button variant="secondary" className="w-full" asChild>
              <Link to={quotationHref(q.id)}>Back to the editor</Link>
            </Button>
          </PanelBody>
        </Panel>

        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
          {!final ? (
            <p className="flex items-center gap-2 rounded-t-lg border border-b-0 border-review-line bg-review-soft px-4 py-2 text-sm font-semibold text-review">
              <FilePen className="size-4 shrink-0" aria-hidden />
              DRAFT · not approved, not signed, not for sending
            </p>
          ) : null}
          <div className="rounded-b-lg border border-line bg-surface p-4"><RenderedPages key={bump} q={q} /></div>
        </div>
      </div>
    </Page>
  );
}
