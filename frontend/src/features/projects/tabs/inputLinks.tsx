/**
 * Shared links of a project (mockups 19, 64): the list, the download approval gate, reject,
 * "Mark resolved" (the files came another way: not a rejection), retry, and the Add link dialog.
 * Nothing downloads before a person approves it.
 */
import { Ban, CircleCheck, Download, Ellipsis, ExternalLink, Link2, RefreshCw } from "lucide-react";
import { useEffect, useId, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { api } from "@/api/client";
import type { ProjectLink } from "@/api/types";
import { cn } from "@/lib/cn";
import { formatDate, formatDateShort } from "@/lib/format";
import { linkStatusInfo } from "@/lib/labels";
import { emailHref } from "@/lib/routes";
import {
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  InlineError,
  Input,
  KeyValue,
  ListRow,
  Menu,
  Panel,
  Section,
  StatusChip,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Textarea,
  type MenuItem,
} from "@/ui";
import { useProjectMutation, type ProjectDetail } from "../api";
import { detectHost, LINK_NEEDS_DECISION, LINK_NEEDS_RECOVERY, linkSourceLabel } from "../lib";
import { Bidi } from "../parts";

export interface LinkActions {
  approve: (l: ProjectLink) => void;
  /** A deliberate decision not to download from this link. */
  reject: (l: ProjectLink) => void;
  /** The files came another way: asks how, then records it. Not a rejection. */
  resolve: (l: ProjectLink) => void;
  retry: (l: ProjectLink) => void;
  /** Link whose retry request is running. */
  retrying: string | null;
}

/** Dialog state and requests for link decisions; render `dialogs` once. */
export function useLinkActions(detail: ProjectDetail) {
  const p = detail.project;
  const [approving, setApproving] = useState<ProjectLink | null>(null);
  const [rejecting, setRejecting] = useState<ProjectLink | null>(null);
  const [resolving, setResolving] = useState<ProjectLink | null>(null);

  const approve = useProjectMutation(
    (l: ProjectLink) => api.post<{ started: boolean }>(`/links/${encodeURIComponent(l.id)}/approve`),
    {
      projectId: p.id,
      invalidate: [["approvals"]],
      success: (_r, l) => `Download approved: ${l.host || "link"}. The browser on this computer is fetching the files.`,
      onSuccess: () => setApproving(null),
    },
  );
  const reject = useProjectMutation((link: ProjectLink) => api.post<ProjectLink>(`/links/${encodeURIComponent(link.id)}/reject`), {
    projectId: p.id,
    invalidate: [["approvals"]],
    success: (_r, l) => `Link rejected: ${l.host || "link"}`,
    onSuccess: () => setRejecting(null),
  });
  const resolve = useProjectMutation(
    ({ link, note }: { link: ProjectLink; note: string }) => api.post<ProjectLink>(`/links/${encodeURIComponent(link.id)}/resolve`, { note }),
    {
      projectId: p.id,
      invalidate: [["approvals"]],
      toastErrors: false,
      success: (_r, v) => `Obtained another way: ${v.link.host || "link"}. The project is not blocked by it any more.`,
      onSuccess: () => setResolving(null),
    },
  );
  const retry = useProjectMutation(
    (l: ProjectLink) => api.post<{ started: boolean }>(`/links/${encodeURIComponent(l.id)}/retry`),
    {
      projectId: p.id,
      success: (r, l) => (r.started ? `Downloading again from ${l.host || "the link"}` : "This download is already running."),
    },
  );

  const actions: LinkActions = {
    approve: setApproving,
    reject: setRejecting,
    resolve: (link) => {
      resolve.reset();
      setResolving(link);
    },
    retry: (l) => retry.mutate(l),
    retrying: retry.isPending ? (retry.variables?.id ?? null) : null,
  };

  const dialogs = (
    <>
      <ApproveLinkDialog
        link={approving}
        detail={detail}
        loading={approve.isPending}
        onClose={() => setApproving(null)}
        onConfirm={() => approving && approve.mutate(approving)}
      />
      <ConfirmDialog
        open={!!rejecting}
        onOpenChange={(o) => !o && setRejecting(null)}
        title={`Reject the download from ${rejecting?.host || "this link"}?`}
        description="Nothing is downloaded from this link. It stays listed as rejected; you can approve it later. If you already have the files, use Mark resolved instead."
        confirmLabel="Reject link"
        variant="danger"
        loading={reject.isPending}
        onConfirm={() => rejecting && reject.mutate(rejecting)}
      >
        {rejecting ? <p className="break-all rounded-lg bg-sunken px-3 py-2 font-mono text-sm text-ink-2">{rejecting.url}</p> : null}
      </ConfirmDialog>
      <ResolveLinkDialog
        link={resolving}
        loading={resolve.isPending}
        error={resolve.error}
        onClose={() => setResolving(null)}
        onSubmit={(note) => resolving && resolve.mutate({ link: resolving, note })}
      />
    </>
  );
  return { actions, dialogs };
}

/* ------------------------------------------------------------------ text */

export function linkTitle(l: ProjectLink): string {
  const label = linkSourceLabel(l.kind);
  return /link$/i.test(label) ? label : `${label} link`;
}

/** "Found in Sarah Mitchell's email · 24 Sep" (links to the email), or "Added by hand". */
export function LinkOrigin({ link, detail, className }: { link: ProjectLink; detail: ProjectDetail; className?: string }) {
  const e = link.email_id ? detail.emails.find((x) => x.id === link.email_id) : undefined;
  if (!e) return <p className={cn("text-xs text-ink-3", className)}>Added by hand</p>;
  return (
    <p className={cn("text-xs text-ink-3", className)}>
      Found in{" "}
      <Link to={emailHref(e.id)} className="text-brand-ink hover:underline">
        <Bidi text={`${e.from_name || e.from_email}'s email`} />
      </Link>
      {e.date ? ` · ${formatDateShort(e.date)}` : ""}
    </p>
  );
}

function statusDetail(l: ProjectLink): string | null {
  if (l.status === "resolved") return `Marked ${formatDateShort(l.updated_at)}`;
  if (l.status === "downloaded") return `${l.files_count} ${l.files_count === 1 ? "file" : "files"}`;
  if (l.approved_by && l.status !== "rejected") return `Approved by ${l.approved_by}${l.approved_at ? ` · ${formatDateShort(l.approved_at)}` : ""}`;
  return null;
}

/**
 * The status of a link. "Obtained another way" (the files are here) and "Rejected" (a decision not
 * to download) carry different icons as well as different words.
 */
export function LinkChip({ link }: { link: ProjectLink }) {
  const icon = link.status === "resolved" ? <CircleCheck aria-hidden /> : link.status === "rejected" ? <Ban aria-hidden /> : undefined;
  return <StatusChip info={linkStatusInfo(link.status)} size="sm" icon={icon} />;
}

/** Opens the shared link in the person's own browser (to download by hand). */
export function OpenLink({ url, className, label = "Open link" }: { url: string; className?: string; label?: string }) {
  return (
    <Button asChild size="sm" variant="secondary" className={className}>
      <a href={url} target="_blank" rel="noreferrer noopener">
        <ExternalLink aria-hidden />
        {label}
      </a>
    </Button>
  );
}

/* ------------------------------------------------------------------ list */

function linkMenu(l: ProjectLink, actions: LinkActions): MenuItem[] {
  const items: MenuItem[] = [];
  if (LINK_NEEDS_DECISION.has(l.status) || l.status === "rejected") {
    items.push({ label: "Approve download", icon: <Download />, onSelect: () => actions.approve(l) });
  }
  if (LINK_NEEDS_RECOVERY.has(l.status)) {
    items.push({ label: "Retry download", icon: <RefreshCw />, onSelect: () => actions.retry(l) });
  }
  items.push({ label: "Open link in browser", icon: <ExternalLink />, onSelect: () => window.open(l.url, "_blank", "noopener") });
  // Mark resolved: the files came another way. Reject: a deliberate decision not to download.
  if (LINK_NEEDS_DECISION.has(l.status) || LINK_NEEDS_RECOVERY.has(l.status)) {
    items.push({ label: "Mark resolved", icon: <CircleCheck />, separatorBefore: true, onSelect: () => actions.resolve(l) });
  }
  if (LINK_NEEDS_DECISION.has(l.status)) {
    items.push({ label: "Reject link", icon: <Ban />, danger: true, onSelect: () => actions.reject(l) });
  }
  return items;
}

/** The one visible action for a link; the rest are in the menu. */
function rowAction(l: ProjectLink, actions: LinkActions, className?: string) {
  if (LINK_NEEDS_DECISION.has(l.status)) {
    return (
      <Button size="sm" variant="secondary" icon={<Download />} className={className} onClick={() => actions.approve(l)}>
        Approve download
      </Button>
    );
  }
  if (l.status === "failed") {
    return (
      <Button
        size="sm"
        variant="secondary"
        icon={<RefreshCw />}
        className={className}
        loading={actions.retrying === l.id}
        onClick={() => actions.retry(l)}
      >
        Retry download
      </Button>
    );
  }
  return null;
}

export function LinksSection({
  detail,
  actions,
  highlight,
  onAdd,
}: {
  detail: ProjectDetail;
  actions: LinkActions;
  highlight: string | null;
  onAdd: () => void;
}) {
  const links = detail.links;
  return (
    <Section
      title={`Shared links (${links.length})`}
      description="Download links from the customer's emails. Each download waits for a person's approval."
    >
      {links.length === 0 ? (
        <Panel>
          <EmptyState
            compact
            icon={<Link2 />}
            title="No shared links"
            action={
              <Button variant="secondary" icon={<Link2 />} onClick={onAdd}>
                Add link
              </Button>
            }
          >
            Google Drive, WeTransfer, Dropbox, OneDrive or SharePoint links found in the customer's emails appear here.
          </EmptyState>
        </Panel>
      ) : (
        <>
          <Panel className="hidden overflow-hidden lg:block">
            <Table>
              <THead>
                <tr>
                  <TH>Link</TH>
                  <TH>Status</TH>
                  <TH>Note</TH>
                  <TH>
                    <span className="sr-only">Actions</span>
                  </TH>
                </tr>
              </THead>
              <TBody>
                {links.map((l) => (
                  <TR key={l.id} data-link-anchor={l.id} selected={highlight === l.id}>
                    <TD className="max-w-[26rem]">
                      <p className="font-medium text-ink">
                        {linkTitle(l)} <span className="font-normal text-ink-3">· {l.host || "unknown host"}</span>
                      </p>
                      <a
                        href={l.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="block truncate text-sm text-brand-ink hover:underline"
                        title={l.url}
                      >
                        {l.url}
                      </a>
                      <LinkOrigin link={l} detail={detail} className="mt-0.5" />
                    </TD>
                    <TD>
                      <LinkChip link={l} />
                      {statusDetail(l) ? <p className="mt-1 whitespace-nowrap text-xs text-ink-3">{statusDetail(l)}</p> : null}
                    </TD>
                    <TD className="max-w-[20rem]">
                      {l.error ? <p className="text-sm break-words text-block">{l.error}</p> : null}
                      {l.note ? <Bidi text={l.note} as="p" className="text-sm break-words text-ink-2" /> : null}
                      {!l.error && !l.note ? <span className="text-ink-3">—</span> : null}
                    </TD>
                    <TD className="w-px">
                      <div className="flex items-center justify-end gap-1">
                        {rowAction(l, actions)}
                        <Menu
                          trigger={
                            <IconButton label={`Actions for the ${l.host || "link"} link`} size="sm">
                              <Ellipsis />
                            </IconButton>
                          }
                          items={linkMenu(l, actions)}
                        />
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Panel>
          <ul className="space-y-3 lg:hidden" aria-label="Shared links">
            {links.map((l) => {
              const action = rowAction(l, actions, "w-full");
              return (
                <li key={l.id} data-link-anchor={l.id}>
                  <ListRow
                    className={cn(highlight === l.id && "ring-2 ring-brand")}
                    title={linkTitle(l)}
                    subtitle={l.host || "unknown host"}
                    aside={
                      <Menu
                        trigger={
                          <IconButton label={`Actions for the ${l.host || "link"} link`} size="sm" className="-mr-2 -mt-1">
                            <Ellipsis />
                          </IconButton>
                        }
                        items={linkMenu(l, actions)}
                      />
                    }
                    footer={action ?? undefined}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <LinkChip link={l} />
                      {statusDetail(l) ? <span className="text-xs text-ink-3">{statusDetail(l)}</span> : null}
                    </div>
                    <a href={l.url} target="_blank" rel="noreferrer noopener" className="mt-2 block break-all text-brand-ink hover:underline">
                      {l.url}
                    </a>
                    <LinkOrigin link={l} detail={detail} className="mt-1" />
                    {l.error ? <p className="mt-1 break-words text-block">{l.error}</p> : null}
                    {l.note ? <Bidi text={l.note} as="p" className="mt-1 break-words" /> : null}
                  </ListRow>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Section>
  );
}

/* ------------------------------------------------------------------ dialogs */

/** The download gate (mockup 19): names the host and that a browser on this computer downloads from it. */
function ApproveLinkDialog({
  link,
  detail,
  loading,
  onClose,
  onConfirm,
}: {
  link: ProjectLink | null;
  detail: ProjectDetail;
  loading: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const email = link?.email_id ? detail.emails.find((e) => e.id === link.email_id) : undefined;
  return (
    <ConfirmDialog
      open={!!link}
      onOpenChange={(o) => !o && onClose()}
      title={`Approve download from ${link?.host || "this link"}?`}
      description="A browser on this computer opens the link and downloads the files it offers into this project."
      confirmLabel="Approve download"
      loading={loading}
      onConfirm={onConfirm}
    >
      {link ? (
        <div className="space-y-4">
          <KeyValue
            labelWidth="sm"
            items={[
              { label: "Host", value: <span className="font-mono text-sm">{link.host || "—"}</span> },
              {
                label: "Link",
                value: (
                  <a href={link.url} target="_blank" rel="noreferrer noopener" className="break-all text-sm text-brand-ink hover:underline">
                    {link.url}
                  </a>
                ),
              },
              { label: "Kind", value: linkSourceLabel(link.kind) },
              {
                label: "Found in",
                value: email ? (
                  <Link to={emailHref(email.id)} className="text-brand-ink hover:underline">
                    <Bidi text={email.from_name || email.from_email} />
                    {email.date ? ` · ${formatDate(email.date)}` : ""}
                  </Link>
                ) : (
                  <Bidi text={link.note || "Added by hand"} />
                ),
              },
              { label: "Project", value: <Bidi text={detail.project.name} /> },
              { label: "Approves", value: "This link only" },
            ]}
          />
          <p className="text-sm text-ink-2">
            If the page asks for a sign-in, the download stops and the link is marked “Needs login”. You can also{" "}
            <a href={link.url} target="_blank" rel="noreferrer noopener" className="font-medium text-brand-ink underline">
              open the link yourself
            </a>
            , download the files and upload them here.
          </p>
        </div>
      ) : null}
    </ConfirmDialog>
  );
}

const RESOLVE_ANSWERS = ["I uploaded the files here", "The customer sent the files again", "I downloaded them from the link myself"];

/**
 * "Mark resolved": the files of this link were obtained another way. It asks how, so the record
 * says so; the link is then listed as "Obtained another way", never as rejected.
 */
function ResolveLinkDialog({
  link,
  loading,
  error,
  onClose,
  onSubmit,
}: {
  link: ProjectLink | null;
  loading: boolean;
  error: unknown;
  onClose: () => void;
  onSubmit: (note: string) => void;
}) {
  const id = useId();
  const [note, setNote] = useState("");
  const [missing, setMissing] = useState(false);
  const linkId = link?.id;
  useEffect(() => {
    if (linkId) {
      setNote("");
      setMissing(false);
    }
  }, [linkId]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = note.trim();
    if (!text) {
      setMissing(true);
      return;
    }
    onSubmit(text);
  };
  return (
    <Dialog
      open={!!link}
      onOpenChange={(o) => !o && !loading && onClose()}
      title={`Files from ${link?.host || "this link"} obtained another way`}
      description="Use this when you have these files already. The link is listed as “Obtained another way”, not as rejected, and it stops blocking the project. Nothing is downloaded."
      hideClose={loading}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button type="submit" form={id} icon={<CircleCheck />} loading={loading}>
            Mark resolved
          </Button>
        </>
      }
    >
      {link ? (
        <form id={id} onSubmit={submit} noValidate className="space-y-4">
          <p className="break-all rounded-lg bg-sunken px-3 py-2 font-mono text-sm text-ink-2">{link.url}</p>
          <Field
            label="How did you get the files?"
            required
            htmlFor={`${id}-note`}
            error={missing ? "Say how you got the files." : null}
            hint="Saved with your name and the date."
          >
            <Textarea
              id={`${id}-note`}
              rows={3}
              autoFocus
              value={note}
              invalid={missing}
              onChange={(e) => {
                setNote(e.target.value);
                if (missing) setMissing(false);
              }}
              placeholder="For example: the customer sent them again by email"
            />
          </Field>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Common answers">
            {RESOLVE_ANSWERS.map((answer) => (
              <button
                key={answer}
                type="button"
                onClick={() => {
                  setNote(answer);
                  setMissing(false);
                }}
                className="min-h-8 rounded-full border border-line-strong bg-surface px-3 py-1 text-left text-sm text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
              >
                {answer}
              </button>
            ))}
          </div>
          <InlineError error={error} />
        </form>
      ) : null}
    </Dialog>
  );
}

/** Add a shared link by hand (mockup 64). It waits for approval like any other link. */
export function AddLinkDialog({
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
}) {
  const id = useId();
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = useProjectMutation(
    (body: { url: string; note?: string }) => api.post<ProjectLink>(`/projects/${encodeURIComponent(projectId)}/links`, body),
    {
      projectId,
      toastErrors: false,
      success: (l) => `Link added: ${l.host || "link"}. Approve its download when you are ready.`,
      onSuccess: () => {
        setUrl("");
        setNote("");
        onOpenChange(false);
      },
    },
  );
  const { reset } = add;
  useEffect(() => {
    if (open) {
      setError(null);
      reset();
    }
  }, [open, reset]);

  const detected = detectHost(url);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const u = url.trim();
    if (!/^https?:\/\//i.test(u) || !detected) {
      setError("Enter the full link, starting with https://");
      return;
    }
    add.mutate(note.trim() ? { url: u, note: note.trim() } : { url: u });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !add.isPending && onOpenChange(o)}
      title="Add a link"
      description="A shared file or folder link from the customer, for example Google Drive, WeTransfer, Dropbox, OneDrive or SharePoint."
      hideClose={add.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={add.isPending}>
            Cancel
          </Button>
          <Button type="submit" form={id} icon={<Link2 />} loading={add.isPending}>
            Add link
          </Button>
        </>
      }
    >
      <form id={id} onSubmit={submit} noValidate className="space-y-4">
        <Field
          label="Link"
          required
          htmlFor={`${id}-url`}
          error={error}
          hint={detected ? `${detected.label} · ${detected.host}` : "Paste the full address from the email."}
        >
          <Input
            id={`${id}-url`}
            type="url"
            inputMode="url"
            autoFocus
            value={url}
            invalid={!!error}
            placeholder="https://"
            onChange={(e) => {
              setUrl(e.target.value);
              if (error) setError(null);
            }}
          />
        </Field>
        <Field label="Note" optional htmlFor={`${id}-note`} hint="Where the link came from, for example the customer's email of 3 Oct.">
          <Textarea id={`${id}-note`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <p className="text-sm text-ink-3">Adding a link downloads nothing. The download waits for your approval.</p>
        <InlineError error={add.error} />
      </form>
    </Dialog>
  );
}
