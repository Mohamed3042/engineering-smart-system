/**
 * Inputs (mockups 18, 19, 49, 64): what is still missing and how to get it, every file with its three
 * separate facts (transfer, extraction, human review), and the shared links. ?link=<id> scrolls to
 * and highlights that link.
 */
import { Download, Ellipsis, FileSearch, FolderOpen, Link2, Mail, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api } from "@/api/client";
import type { ProjectFile, ScopeItem } from "@/api/types";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { docKindLabel, extractionStatusInfo, fileSourceLabel, fileStatusInfo, linkStatusInfo, type StatusInfo } from "@/lib/labels";
import { emailHref, fileHref, projectHref } from "@/lib/routes";
import {
  Button,
  ConfirmDialog,
  CollapsibleSection,
  EmptyState,
  IconButton,
  ListRow,
  Menu,
  Panel,
  PanelHeader,
  Section,
  StatusChip,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  type MenuItem,
} from "@/ui";
import { markBusy, useProjectMutation, useProjectWork, type ProjectDetail } from "../api";
import { downloadOriginal, FileFacts, FileTransferError, MarkReviewedDialog, reviewedLine, RetryFileButton, UploadButton } from "../fileParts";
import { fileReviewInfo, firstEvidence, LINK_NEEDS_DECISION, LINK_NEEDS_RECOVERY, linkRecoveryText } from "../lib";
import { Bidi, FileIcon } from "../parts";
import type { TabProps } from "../ProjectLayout";
import { AddLinkDialog, LinkOrigin, LinksSection, linkTitle, OpenLink, useLinkActions, type LinkActions } from "./inputLinks";

export function InputsTab({ detail }: TabProps) {
  const p = detail.project;
  const [params] = useSearchParams();
  const highlight = params.get("link");
  const [addLink, setAddLink] = useState(false);
  const [reviewing, setReviewing] = useState<ProjectFile | null>(null);
  const { actions, dialogs } = useLinkActions(detail);

  // ?link=<id>: bring the visible copy of that link (missing-inputs item first, else the list row) into view.
  useEffect(() => {
    if (!highlight) return;
    const el = Array.from(document.querySelectorAll<HTMLElement>(`[data-link-anchor="${CSS.escape(highlight)}"]`)).find(
      (n) => n.offsetParent !== null,
    );
    el?.scrollIntoView({ block: "center" });
  }, [highlight]);

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <p className="max-w-[70ch] text-sm text-ink-3">
          Files and shared links the customer sent. ZIP files are unpacked and every file inside is added. Nothing is downloaded
          from a link until a person approves it.
        </p>
        <div className="grid grid-cols-2 gap-2 md:flex md:shrink-0">
          <UploadButton projectId={p.id} className="w-full md:w-auto" />
          <Button variant="secondary" icon={<Link2 />} className="w-full md:w-auto" onClick={() => setAddLink(true)}>
            Add link
          </Button>
        </div>
      </div>

      <MissingInputs detail={detail} actions={actions} highlight={highlight} onAddLink={() => setAddLink(true)} />
      <WorkStatus detail={detail} />
      <FilesSection detail={detail} onReview={setReviewing} onAddLink={() => setAddLink(true)} />
      <LinksSection detail={detail} actions={actions} highlight={highlight} onAdd={() => setAddLink(true)} />

      {dialogs}
      <MarkReviewedDialog file={reviewing} onClose={() => setReviewing(null)} />
      <AddLinkDialog open={addLink} onOpenChange={setAddLink} projectId={p.id} />
    </div>
  );
}

function WorkStatus({ detail }: TabProps) {
  const work = useProjectWork(detail.project.id);
  const attachments = detail.files.filter((f) => f.source === "email_attachment");
  const ready = attachments.filter((f) => f.status === "ready");
  const failed = attachments.filter((f) => ["failed", "expired", "needs_login"].includes(f.status));
  const priorErrors = useRef(new Map<string, string>());
  useEffect(() => { attachments.forEach((f) => { if (f.error) priorErrors.current.set(f.id, f.error); }); }, [attachments]);
  const retry = useProjectMutation(async () => {
    const result = await api.post<{ started: boolean }>(`/projects/${encodeURIComponent(detail.project.id)}/fetch-attachments`, { retry_failed: true });
    markBusy(detail.project.id);
    return result;
  }, { projectId: detail.project.id, success: (r) => r.started ? "Trying the failed attachments again." : "Attachments are already downloading." });
  if (!attachments.length && !work.data?.busy && !work.isError) return null;
  const active = [work.data?.attachments ? "Downloading attachments" : null, work.data?.downloads.length ? "Downloading shared files" : null,
    work.data?.extracting ? "Reading files" : null, work.data?.analyzing ? "Studying the documents" : null].filter(Boolean);
  return <Panel>
    <PanelHeader title="File collection and reading" description={work.isError ? "Background status unavailable. File states below show the last saved result." : !work.data ? "Checking background work…" : active.length ? `${active.join(" · ")}. This view keeps checking until the work finishes.` : "No background work is running."}
      actions={work.isError ? <Button size="sm" variant="secondary" onClick={() => work.refetch()}>Retry status</Button> : failed.length ?
        <Button size="sm" variant="secondary" icon={<RefreshCw />} loading={retry.isPending} disabled={work.data?.attachments} onClick={() => retry.mutate()}>Retry all failed attachments</Button> : undefined} />
    <div className="px-5 py-3" aria-live="polite">
      {attachments.length ? <p className="text-sm text-ink-2">{ready.length} of {attachments.length} attachments downloaded{failed.length ? ` · ${failed.length} failed` : ""}. Downloaded files still need extraction and human review.</p> : null}
      {work.data?.attachments && priorErrors.current.size ? <CollapsibleSection title="Previous download errors" summary={priorErrors.current.size} className="mt-3">
        <ul className="space-y-2 text-sm text-ink-2">{attachments.filter((f) => priorErrors.current.has(f.id)).map((f) => <li key={f.id}><Bidi text={f.name} className="font-medium" />: {priorErrors.current.get(f.id)}</li>)}</ul>
      </CollapsibleSection> : null}
    </div>
  </Panel>;
}

/* ------------------------------------------------------------------ missing inputs */

interface Missing {
  key: string;
  /** Link id, for ?link= highlighting. */
  linkId?: string;
  title: ReactNode;
  status: StatusInfo;
  detail: ReactNode;
  /** Secondary actions first, the one primary action last (bottom on phones). */
  actions: ReactNode;
}

const INPUT_BLOCKERS = new Set(["missing_files", "expired_link", "missing_drawing"]);
const NOT_OBTAINED = new Set(["not_downloaded", "failed", "expired", "needs_login"]);
const BTN = "w-full sm:w-auto";

const qtyMissing = (s: ScopeItem) => s.qty === null || s.qty === undefined || String(s.qty).trim() === "";
/** A stated quantity whose quote was not found in the source, or that has no quote at all. */
const qtyUnverified = (s: ScopeItem) => {
  const ev = firstEvidence(s.evidence);
  return !qtyMissing(s) && (!ev?.quote || ev.verified === false);
};

function MissingInputs({
  detail,
  actions,
  highlight,
  onAddLink,
}: {
  detail: ProjectDetail;
  actions: LinkActions;
  highlight: string | null;
  onAddLink: () => void;
}) {
  const p = detail.project;
  const [resolving, setResolving] = useState<number | null>(null);
  const fetchAttachments = useProjectMutation(
    async () => {
      const r = await api.post<{ started: boolean }>(`/projects/${encodeURIComponent(p.id)}/fetch-attachments`);
      markBusy(p.id);
      return r;
    },
    {
      projectId: p.id,
      success: (r) => (r.started ? "Downloading the attachments from the mailbox." : "The attachments are already downloading."),
    },
  );
  const resolve = useProjectMutation((i: number) => api.post(`/projects/${encodeURIComponent(p.id)}/blockers/${i}/resolve`), {
    projectId: p.id,
    success: "Marked as resolved",
    onSuccess: () => setResolving(null),
  });

  const items: Missing[] = [];

  for (const l of detail.links) {
    const decide = LINK_NEEDS_DECISION.has(l.status);
    if (!decide && !LINK_NEEDS_RECOVERY.has(l.status)) continue;
    items.push({
      key: `link-${l.id}`,
      linkId: l.id,
      title: (
        <>
          Files behind the {linkTitle(l)} <span className="font-normal text-ink-3">· {l.host || "unknown host"}</span>
        </>
      ),
      status: linkStatusInfo(l.status),
      detail: (
        <>
          <p>
            {decide
              ? "Not downloaded yet. Approve the download, or open the link yourself and upload the files."
              : linkRecoveryText(l)}
          </p>
          <LinkOrigin link={l} detail={detail} className="mt-1" />
        </>
      ),
      actions: decide ? (
        <>
          <Button size="sm" variant="ghost" className={BTN} onClick={() => actions.reject(l)}>
            Reject
          </Button>
          <OpenLink url={l.url} className={BTN} />
          <Button size="sm" icon={<Download />} className={BTN} onClick={() => actions.approve(l)}>
            Approve download
          </Button>
        </>
      ) : (
        <>
          <Button size="sm" variant="ghost" className={BTN} onClick={() => actions.resolve(l)}>
            Obtained another way
          </Button>
          <OpenLink url={l.url} className={BTN} />
          {l.status === "failed" ? (
            <>
              <UploadButton projectId={p.id} size="sm" variant="secondary" className={BTN}>
                Upload files
              </UploadButton>
              <Button
                size="sm"
                icon={<RefreshCw />}
                className={BTN}
                loading={actions.retrying === l.id}
                onClick={() => actions.retry(l)}
              >
                Retry download
              </Button>
            </>
          ) : (
            <UploadButton projectId={p.id} size="sm" className={BTN}>
              Upload files
            </UploadButton>
          )}
        </>
      ),
    });
  }

  const waiting = detail.files.filter((f) => f.status === "not_downloaded" && f.source === "email_attachment");
  if (waiting.length) {
    items.push({
      key: "attachments",
      title:
        waiting.length === 1 ? (
          <>
            Email attachment <Bidi text={waiting[0].name} className="break-all" />
          </>
        ) : (
          `${waiting.length} email attachments`
        ),
      status: fileStatusInfo("not_downloaded"),
      detail: (
        <>
          <p>Still in the mailbox. Download them into the project; they are read automatically afterwards.</p>
          {waiting.length > 1 ? <p className="mt-1 break-words text-ink-3">{waiting.map((f) => f.name).join(", ")}</p> : null}
        </>
      ),
      actions: (
        <Button size="sm" icon={<Mail />} className={BTN} loading={fetchAttachments.isPending} onClick={() => fetchAttachments.mutate()}>
          Download attachments
        </Button>
      ),
    });
  }

  for (const f of detail.files) {
    if (!NOT_OBTAINED.has(f.status) || (f.status === "not_downloaded" && f.source === "email_attachment")) continue;
    // Uploaded by hand under the same name: the gap is closed even though this copy stays failed.
    if (detail.files.some((o) => o.id !== f.id && o.status === "ready" && o.name === f.name)) continue;
    items.push({
      key: `file-${f.id}`,
      title: <Bidi text={f.name} className="break-all" />,
      status: fileStatusInfo(f.status),
      detail: (
        <p>
          {f.error ? `${f.error.replace(/\.?\s*$/, ".")} ` : ""}
          {f.email_id ? "Save the attachment from the email and upload it here." : "Get the file from the sender and upload it here."}
        </p>
      ),
      actions: (
        <>
          <RetryFileButton file={f} className={BTN} />
          {f.email_id ? (
            <Button asChild size="sm" variant="secondary" className={BTN}>
              <Link to={emailHref(f.email_id)}>
                <Mail aria-hidden />
                Open email
              </Link>
            </Button>
          ) : f.source_url ? (
            <OpenLink url={f.source_url} className={BTN} />
          ) : null}
          <UploadButton projectId={p.id} size="sm" className={BTN} docKind={f.doc_kind && f.doc_kind !== "other" ? f.doc_kind : undefined}>
            Upload file
          </UploadButton>
        </>
      ),
    });
  }

  (p.blockers ?? []).forEach((b, i) => {
    if (b.resolved || b.link_id || !INPUT_BLOCKERS.has(b.kind ?? "")) return;
    const derived = b.source === "derived";
    const drawing = b.kind === "missing_drawing";
    items.push({
      key: `blocker-${i}`,
      title: <Bidi text={b.text} />,
      status: { label: drawing ? "Drawing missing" : "Files missing", tone: "block" },
      detail: (
        <p>
          {!derived
            ? "Upload what is missing, then mark this as resolved."
            : drawing
              ? "Upload the drawing. This clears itself once a drawing is among the downloaded files."
              : "Upload the files, or add the link the customer sent. This clears itself once a file is downloaded."}
        </p>
      ),
      actions: (
        <>
          {!derived ? (
            <Button size="sm" variant="ghost" className={BTN} onClick={() => setResolving(i)}>
              Mark resolved
            </Button>
          ) : null}
          {derived && !drawing ? (
            <Button size="sm" variant="secondary" icon={<Link2 />} className={BTN} onClick={onAddLink}>
              Add link
            </Button>
          ) : null}
          <UploadButton projectId={p.id} size="sm" className={BTN} docKind={drawing ? "drawing" : undefined}>
            {drawing ? "Upload drawing" : "Upload files"}
          </UploadButton>
        </>
      ),
    });
  });

  const scope = p.scope_items ?? [];
  const notStated = scope.filter(qtyMissing);
  const unverified = scope.filter(qtyUnverified);
  if (notStated.length) {
    items.push({
      key: "qty-missing",
      title: notStated.length === 1 ? "Quantity not stated" : `${notStated.length} quantities not stated`,
      status: { label: "Not stated", tone: "review" },
      detail: (
        <>
          <ul className="list-disc space-y-0.5 pl-5">
            {notStated.map((s, i) => (
              <li key={i}>
                <Bidi text={s.description} />
              </li>
            ))}
          </ul>
          <p className="mt-1 text-ink-3">The documents give no quantity. Upload the BOQ or ask the customer; a quantity is never assumed.</p>
        </>
      ),
      actions: (
        <>
          <Button asChild size="sm" variant="secondary" className={BTN}>
            <Link to={projectHref(p.id, "analysis")}>View scope</Link>
          </Button>
          <UploadButton projectId={p.id} size="sm" docKind="boq" className={BTN}>
            Upload BOQ
          </UploadButton>
        </>
      ),
    });
  }
  if (unverified.length) {
    items.push({
      key: "qty-unverified",
      title: unverified.length === 1 ? "Quantity without a confirmed source" : `${unverified.length} quantities without a confirmed source`,
      status: { label: "Not verified", tone: "review" },
      detail: (
        <>
          <ul className="list-disc space-y-0.5 pl-5">
            {unverified.map((s, i) => (
              <li key={i}>
                <Bidi text={`${s.description}: ${String(s.qty)}${s.unit ? ` ${s.unit}` : ""}`} />
              </li>
            ))}
          </ul>
          <p className="mt-1 text-ink-3">
            No quote was found word for word in the documents. Check the source before you rely on these quantities.
          </p>
        </>
      ),
      actions: (
        <Button asChild size="sm" className={BTN}>
          <Link to={projectHref(p.id, "analysis")}>Check in Analysis</Link>
        </Button>
      ),
    });
  }

  if (!items.length) return null;
  return (
    <Panel>
      <PanelHeader
        title={`Missing inputs (${items.length})`}
        description="Needed before the scope can be checked. Each item says how to get it."
      />
      <ul className="divide-y divide-line">
        {items.map((it) => (
          <li
            key={it.key}
            data-link-anchor={it.linkId}
            className={cn(
              "flex flex-col gap-3 px-5 py-4 lg:flex-row lg:items-start lg:gap-6",
              it.linkId && it.linkId === highlight && "bg-brand-soft/60",
            )}
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <StatusChip info={it.status} size="sm" />
                <p className="min-w-0 break-words font-semibold text-ink">{it.title}</p>
              </div>
              <div className="mt-1 text-sm text-ink-2">{it.detail}</div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end lg:max-w-[55%] lg:shrink-0">{it.actions}</div>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={resolving !== null}
        onOpenChange={(o) => !o && setResolving(null)}
        title="Mark this as resolved?"
        description="Use this when the missing input has arrived another way. The item leaves the list; add it again if it comes back."
        confirmLabel="Mark resolved"
        loading={resolve.isPending}
        onConfirm={() => resolving !== null && resolve.mutate(resolving)}
      >
        {resolving !== null ? (
          <Bidi text={p.blockers[resolving]?.text} as="p" className="rounded-lg bg-sunken px-3 py-2 text-ink" />
        ) : null}
      </ConfirmDialog>
    </Panel>
  );
}

/* ------------------------------------------------------------------ files */

function fileMeta(f: ProjectFile, detail: ProjectDetail): string {
  const email = f.email_id ? detail.emails.find((e) => e.id === f.email_id) : undefined;
  const origin = `${fileSourceLabel(f.source)}${email ? ` from ${email.from_name || email.from_email}` : ""}`;
  return [docKindLabel(f.doc_kind), f.size ? formatBytes(f.size) : null, origin].filter(Boolean).join(" · ");
}

function FilesSection({
  detail,
  onReview,
  onAddLink,
}: {
  detail: ProjectDetail;
  onReview: (f: ProjectFile) => void;
  onAddLink: () => void;
}) {
  const p = detail.project;
  const [showReviewed, setShowReviewed] = useState(false);
  const files = [...detail.files].sort((a, b) => Number(!!a.reviewed_by) - Number(!!b.reviewed_by));
  const reviewed = files.filter((f) => f.reviewed_by && f.status === "ready");
  const navigate = useNavigate();

  const menu = (f: ProjectFile): MenuItem[] => {
    const ready = f.status === "ready";
    const items: MenuItem[] = [{ label: "Open file", icon: <FileSearch />, onSelect: () => navigate(fileHref(f.id)) }];
    if (!f.reviewed_by) {
      items.push({
        label: ready ? "Mark reviewed" : "Mark reviewed (download it first)",
        icon: <ShieldCheck />,
        disabled: !ready,
        onSelect: () => onReview(f),
      });
    }
    if (ready) items.push({ label: "Download original", icon: <Download />, onSelect: () => downloadOriginal(f.id) });
    if (f.email_id) items.push({ label: "Open source email", icon: <Mail />, onSelect: () => navigate(emailHref(f.email_id ?? "")) });
    return items;
  };
  const menuButton = (f: ProjectFile, className?: string) => (
    <Menu
      trigger={
        <IconButton label={`Actions for ${f.name}`} size="sm" className={className}>
          <Ellipsis />
        </IconButton>
      }
      items={menu(f)}
    />
  );

  return (
    <Section title={`Files (${files.length})`} description="Downloaded, read and reviewed are three separate facts.">
      {files.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<FolderOpen />}
            title="No files yet"
            action={
              <>
                <UploadButton projectId={p.id} />
                <Button variant="secondary" icon={<Link2 />} onClick={onAddLink}>
                  Add link
                </Button>
              </>
            }
          >
            Files appear here when the mailbox scan saves the customer's attachments or an approved link is downloaded. You can also
            add them yourself.
          </EmptyState>
        </Panel>
      ) : (
        <>
          <Panel className="hidden overflow-hidden lg:block">
            <Table>
              <THead>
                <tr>
                  <TH>File</TH>
                  <TH>Transfer</TH>
                  <TH>Extraction</TH>
                  <TH>Human review</TH>
                  <TH>
                    <span className="sr-only">Actions</span>
                  </TH>
                </tr>
              </THead>
              <TBody>
                {files.map((f) => (
                  <TR key={f.id}>
                    <TD className="max-w-[26rem]">
                      <div className="flex items-start gap-3">
                        <FileIcon file={f} className="mt-0.5" />
                        <div className="min-w-0">
                          <Link to={fileHref(f.id)} className="break-all font-medium text-ink hover:underline">
                            <Bidi text={f.name} />
                          </Link>
                          <p className="mt-0.5 text-sm text-ink-3">{fileMeta(f, detail)}</p>
                        </div>
                      </div>
                    </TD>
                    <TD>
                      <StatusChip info={fileStatusInfo(f.status)} size="sm" />
                      <FileTransferError file={f} />
                    </TD>
                    <TD>
                      <StatusChip info={extractionStatusInfo(f.extraction_status)} size="sm" />
                      {f.extraction_status === "failed" && f.error ? (
                        <p className="mt-1 line-clamp-2 max-w-[14rem] text-xs text-block" title={f.error}>
                          {f.error}
                        </p>
                      ) : null}
                    </TD>
                    <TD>
                      <StatusChip info={fileReviewInfo(f)} size="sm" />
                      {reviewedLine(f) ? <p className="mt-1 whitespace-nowrap text-xs text-ink-3">{reviewedLine(f)}</p> : null}
                    </TD>
                    <TD className="w-px">
                      <div className="flex items-center justify-end gap-1">
                        <RetryFileButton file={f} />
                        <Button asChild size="sm" variant="secondary">
                          <Link to={fileHref(f.id)}>Open</Link>
                        </Button>
                        {menuButton(f)}
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Panel>
          <ul className="space-y-3 lg:hidden" aria-label="Files">
            {files.filter((f) => showReviewed || !f.reviewed_by || f.status !== "ready").map((f) => (
              <li key={f.id}>
                <ListRow
                  leading={<FileIcon file={f} className="mt-0.5" />}
                  title={<Bidi text={f.name} className="break-all" />}
                  subtitle={fileMeta(f, detail)}
                  aside={menuButton(f, "-mr-2 -mt-1")}
                  footer={
                    f.status === "ready" ? (
                      <Button asChild className="w-full" variant={f.reviewed_by ? "secondary" : "primary"}>
                        <Link to={fileHref(f.id)}>{f.reviewed_by ? "Open file" : "Open and review"}</Link>
                      </Button>
                    ) : undefined
                  }
                >
                  <FileFacts file={f} labelled />
                  <RetryFileButton file={f} className="mt-3 w-full" />
                </ListRow>
              </li>
            ))}
          </ul>
          {reviewed.length ? <Button variant="secondary" className="w-full lg:hidden" aria-expanded={showReviewed} onClick={() => setShowReviewed((v) => !v)}>{showReviewed ? "Hide reviewed files" : `Show reviewed files (${reviewed.length})`}</Button> : null}
        </>
      )}
    </Section>
  );
}
