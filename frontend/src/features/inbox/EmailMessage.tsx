/**
 * The message itself (mockup 13): header fields from the real headers, the text, attachments and
 * links with what happened to them, and the rest of the conversation.
 *
 * Sender names and addresses are isolated (<bdi>, dir="ltr") so an Arabic name never reorders the
 * date next to it. Attachment and link state comes with the message; when it cannot be read the
 * panels say "Status unavailable" with a Retry button instead of claiming something happened.
 */
import { CircleHelp, ExternalLink, FolderInput, LoaderCircle, Paperclip, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { Attachment, Email, ProjectFile, ProjectLink } from "@/api/types";
import { formatBytes, formatDateShort, formatDateTime, formatRelative, isRtl, pluralize } from "@/lib/format";
import { extractionStatusInfo, fileStatusInfo, linkStatusInfo, type StatusInfo } from "@/lib/labels";
import { emailHref, fileHref, nextActionHref, projectHref } from "@/lib/routes";
import { useSession } from "@/api/session";
import { Button, Chip, KeyValue, Panel, PanelBody, PanelHeader, StatusChip, toastError } from "@/ui";
import { hostOf, useRetryDownload, type ThreadMessage } from "./api";
import { linkKindLabel } from "./labels";
import { viewUrlOf } from "./mailto";
import { dirOf } from "./parts";

const BODY_LIMIT = 4000;

function Addresses({ list }: { list: string[] }) {
  return (
    <ul className="space-y-0.5">
      {list.map((a, i) => (
        <li key={i} className="break-all" dir="ltr">
          {a}
        </li>
      ))}
    </ul>
  );
}

/** From (the sender in the header) and Received in (our mailbox) are different facts. */
export function MessagePanel({ email }: { email: Email }) {
  const [full, setFull] = useState(false);
  const body = email.body_text ?? "";
  const long = body.length > BODY_LIMIT;
  const text = long && !full ? `${body.slice(0, BODY_LIMIT)}…` : body;
  const name = email.from_name?.trim();
  const view = viewUrlOf(email);
  const rows: { label: ReactNode; value: ReactNode; hint?: ReactNode }[] = [
    {
      label: "From",
      value: (
        <>
          <bdi className="font-medium" dir="auto">
            {name || email.from_email || "Unknown sender"}
          </bdi>
          {name ? (
            <span className="block break-all text-sm text-ink-2" dir="ltr">
              {email.from_email}
            </span>
          ) : null}
        </>
      ),
      hint: "The sender named in the message header",
    },
    {
      label: "Received in",
      value: email.account ? (
        <span className="break-all" dir="ltr">
          {email.account}
        </span>
      ) : null,
      hint: "The connected mailbox that holds this message",
    },
    { label: "To", value: email.to?.length ? <Addresses list={email.to} /> : null },
    ...(email.cc?.length ? [{ label: "Cc", value: <Addresses list={email.cc} /> }] : []),
    {
      label: "Date",
      value: (
        <time dateTime={email.date ?? undefined} dir="ltr">
          {formatDateTime(email.date)}
        </time>
      ),
    },
    ...(email.labels?.length ? [{ label: "Mail labels", value: <span className="text-ink-2">{email.labels.join(", ")}</span> }] : []),
    ...(view
      ? [
          {
            label: "Original",
            value: (
              <a href={view} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-brand-ink hover:underline">
                Open in the mailbox
                <ExternalLink className="size-3.5" aria-hidden />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            ),
          },
        ]
      : []),
  ];
  return (
    <Panel>
      <PanelBody className="py-1">
        <KeyValue labelWidth="sm" items={rows} />
      </PanelBody>
      <div className="border-t border-line px-5 py-5">
        {body ? (
          <>
            <div dir={isRtl(body) ? "rtl" : "auto"} className="whitespace-pre-wrap break-words text-base leading-relaxed text-ink">
              {text}
            </div>
            {long ? (
              <Button variant="link" size="sm" className="mt-3" onClick={() => setFull(!full)}>
                {full ? "Show less" : "Show the whole message"}
              </Button>
            ) : null}
          </>
        ) : (
          <div className="space-y-1 text-sm text-ink-3">
            <p>No message text was saved{email.snippet ? ". The mailbox preview reads:" : "."}</p>
            {email.snippet ? (
              <p dir={dirOf(email.snippet)} className="break-words text-base text-ink">
                {email.snippet}
              </p>
            ) : null}
          </div>
        )}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ attachments and links */

/** What the message's own response says about its files and links. */
export interface FileState {
  /** False when the server did not send file and link state, or the last refresh failed. Nothing is guessed then. */
  known: boolean;
  files: ProjectFile[];
  links: ProjectLink[];
  /** Files are saved into projects only. */
  hasProject: boolean;
  projectId: string | null;
  emailId: string;
  /** A refresh is running (the Retry button shows progress). */
  refreshing: boolean;
  onRetryStatus: () => void;
  onFileUnder: () => void;
}

/** The state could not be read: say so. Never a business fact such as "Not saved". The panel header has the Retry button. */
function StatusUnavailable() {
  return (
    <Chip tone="review" size="sm" icon={<CircleHelp aria-hidden />}>
      Status unavailable
    </Chip>
  );
}

/** One Retry for a whole panel when its state could not be read. */
function RetryStatus({ state }: { state: FileState }) {
  return (
    <Button variant="secondary" size="sm" icon={<RefreshCw />} loading={state.refreshing} onClick={state.onRetryStatus}>
      Retry
    </Button>
  );
}

/**
 * Try again for a failed download, with progress: the request starts it in the background, the page
 * looks again shortly and while it runs, and the spinner stays until the status settles (or 15 seconds).
 */
function useTryAgain(kind: "file" | "link", id: string, status: string, emailId: string) {
  const retry = useRetryDownload(emailId);
  const [trying, setTrying] = useState(false);
  const moved = useRef(false);
  const finish = useCallback(() => {
    setTrying(false);
    moved.current = false;
  }, []);
  useEffect(() => {
    if (!trying) return;
    if (status === "downloading" || status === "not_downloaded" || status === "approved") moved.current = true;
    else if (status === "ready" || status === "downloaded" || (status === "failed" && moved.current)) finish();
  }, [trying, status, finish]);
  useEffect(() => {
    if (!trying) return;
    const t = window.setTimeout(finish, 15_000);
    return () => window.clearTimeout(t);
  }, [trying, finish]);
  const start = () =>
    retry.mutate(
      { kind, id },
      {
        onSuccess: () => setTrying(true),
        onError: (err) => toastError(err, "The download was not started"),
      },
    );
  return { working: trying || retry.isPending, start };
}

function TryAgain({ kind, id, status, emailId, label }: { kind: "file" | "link"; id: string; status: string; emailId: string; label: string }) {
  const { working, start } = useTryAgain(kind, id, status, emailId);
  if (working) {
    return (
      <span role="status" className="inline-flex items-center gap-2 text-sm text-ink-2">
        <LoaderCircle className="size-4 animate-spin text-ink-3" aria-hidden />
        Trying again…
      </span>
    );
  }
  if (status !== "failed") return null;
  return (
    <Button variant="secondary" size="sm" icon={<RefreshCw />} onClick={start} aria-label={`Try again: ${label}`}>
      Try again
    </Button>
  );
}

const reviewInfo = (f: ProjectFile): StatusInfo => (f.reviewed_by ? { label: "Reviewed", tone: "brand" } : { label: "Not reviewed", tone: "muted" });

/** Downloaded, text extracted and reviewed by a person: three facts, three chips, never merged. */
function FileFacts({ file }: { file: ProjectFile }) {
  const facts: { label: string; info: StatusInfo; hint: string; icon?: ReactNode }[] = [
    {
      label: "Download",
      info: fileStatusInfo(file.status),
      hint: "Whether the file was copied from the mailbox into the project",
      icon: file.status === "downloading" ? <LoaderCircle className="animate-spin" aria-hidden /> : undefined,
    },
    { label: "Text", info: extractionStatusInfo(file.extraction_status), hint: "Whether the text of the file was read by the system" },
    { label: "Review", info: reviewInfo(file), hint: "Whether a person checked the file" },
  ];
  return (
    <ul className="flex flex-wrap items-center gap-1.5">
      {facts.map((f) => (
        <li key={f.label} title={f.hint}>
          <span className="sr-only">{f.label}: </span>
          <StatusChip info={f.info} size="sm" icon={f.icon} />
        </li>
      ))}
    </ul>
  );
}

/** A file that is still in the mailbox: say why nothing is happening and where to go. */
function WaitingNote({ state }: { state: FileState }) {
  const mail = useSession().data?.mail;
  return (
    <p className="text-sm text-ink-2">
      {mail === null ? (
        <>
          No mailbox is connected, so this attachment cannot be downloaded.{" "}
          <Link to="/settings/connections" className="font-medium text-brand-ink hover:underline">
            Connect the mailbox
          </Link>
        </>
      ) : (
        <>
          Not copied into the project yet.{" "}
          {state.projectId ? (
            <Link to={projectHref(state.projectId, "inputs")} className="font-medium text-brand-ink hover:underline">
              Download it from the project’s files
            </Link>
          ) : null}
        </>
      )}
    </p>
  );
}

function FileLine({ name, meta, file, state }: { name: string; meta?: string; file?: ProjectFile; state: FileState }) {
  const failed = file?.status === "failed";
  return (
    <li className="px-5 py-3">
      <div className="flex items-start gap-3">
        <Paperclip className="mt-1 size-4 shrink-0 text-ink-3" aria-hidden />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <div className="min-w-0">
              <p className="break-words font-medium text-ink" dir={dirOf(name)}>
                {name}
              </p>
              {meta ? <p className="text-xs text-ink-3 tabular">{meta}</p> : null}
            </div>
            {state.known && file ? (
              <Link to={fileHref(file.id)} className="shrink-0 text-sm font-medium text-brand-ink hover:underline">
                Open file<span className="sr-only">: {name}</span>
              </Link>
            ) : null}
          </div>
          {!state.known ? (
            <StatusUnavailable />
          ) : file ? (
            <>
              <FileFacts file={file} />
              {file.reviewed_by ? (
                <p className="text-xs text-ink-3">
                  Reviewed by {file.reviewed_by}
                  {file.reviewed_at ? ` · ${formatDateShort(file.reviewed_at)}` : ""}
                </p>
              ) : null}
              {failed && file.error ? <p className="break-words text-sm text-block">{file.error}</p> : null}
              {file.status === "not_downloaded" && file.source === "email_attachment" ? <WaitingNote state={state} /> : null}
              <TryAgain kind="file" id={file.id} status={file.status} emailId={state.emailId} label={name} />
            </>
          ) : !state.hasProject ? (
            <Chip tone="muted" size="sm">
              Not saved: no project yet
            </Chip>
          ) : (
            <div className="space-y-1">
              <Chip tone="muted" size="sm">
                No saved copy for this message
              </Chip>
              <p className="text-xs text-ink-3">
                The project may hold this file from another message.{" "}
                {state.projectId ? (
                  <Link to={projectHref(state.projectId, "inputs")} className="font-medium text-brand-ink hover:underline">
                    Open the project’s files
                  </Link>
                ) : null}
              </p>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

/** Each attachment with its saved file: by attachment id first, then by file name. Files with no attachment (unpacked from an archive) come last. */
function pairAttachments(attachments: Attachment[], files: ProjectFile[]) {
  const used = new Set<string>();
  const take = (match: (f: ProjectFile) => boolean) => {
    const f = files.find((x) => !used.has(x.id) && match(x));
    if (f) used.add(f.id);
    return f;
  };
  const paired = attachments.map((attachment) => ({
    attachment,
    file: (attachment.attachment_id ? take((f) => f.attachment_id === attachment.attachment_id) : undefined) ?? take((f) => f.name === attachment.filename),
  }));
  return { paired, extra: files.filter((f) => !used.has(f.id)) };
}

export function AttachmentsPanel({ email, state }: { email: Email; state: FileState }) {
  const list = email.attachments ?? [];
  const { paired, extra } = pairAttachments(list, state.known ? state.files : []);
  if (list.length === 0 && extra.length === 0) return null;
  return (
    <Panel>
      <PanelHeader
        title={`Attachments (${list.length})`}
        description={
          !state.known
            ? "The status of these files could not be loaded. Nothing below is guessed."
            : state.hasProject
              ? "Each file shows three separate facts: copied into the project, text read, and checked by a person."
              : "Files are saved into a project. File this message under one to save them."
        }
        actions={
          !state.known ? (
            <RetryStatus state={state} />
          ) : !state.hasProject ? (
            <Button variant="secondary" size="sm" icon={<FolderInput />} onClick={state.onFileUnder}>
              File under a project
            </Button>
          ) : null
        }
      />
      <ul className="divide-y divide-line">
        {paired.map(({ attachment: a, file }, i) => {
          const meta = [a.mime, a.size ? formatBytes(a.size) : null].filter(Boolean).join(" · ");
          return <FileLine key={`${a.filename}-${i}`} name={a.filename} meta={meta} file={file} state={state} />;
        })}
        {extra.map((f) => (
          <FileLine key={f.id} name={f.name} meta={f.summary || [f.mime, f.size ? formatBytes(f.size) : null].filter(Boolean).join(" · ")} file={f} state={state} />
        ))}
      </ul>
    </Panel>
  );
}

function LinkState({ link, kind, state }: { link?: ProjectLink; kind: string; state: FileState }) {
  if (!state.known) return <StatusUnavailable />;
  if (link) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip
          info={linkStatusInfo(link.status)}
          size="sm"
          icon={link.status === "downloading" ? <LoaderCircle className="animate-spin" aria-hidden /> : undefined}
        />
        {link.files_count ? <span className="text-xs text-ink-3 tabular">{pluralize(link.files_count, "file")}</span> : null}
        {link.status === "pending_approval" && state.projectId ? (
          <Button asChild variant="secondary" size="sm">
            <Link to={nextActionHref(state.projectId, { kind: "resolve_link", link_id: link.id })}>Review download</Link>
          </Button>
        ) : null}
        <TryAgain kind="link" id={link.id} status={link.status} emailId={state.emailId} label={link.host || link.url} />
        {link.status === "failed" && link.error ? <p className="basis-full break-words text-sm text-block">{link.error}</p> : null}
      </div>
    );
  }
  // An ordinary web page is never downloaded: that is a fact about the link, not a missing status.
  if (kind === "other")
    return (
      <Chip tone="muted" size="sm">
        Web page, not downloaded
      </Chip>
    );
  if (!state.hasProject)
    return (
      <Chip tone="muted" size="sm">
        Not downloaded: no project yet
      </Chip>
    );
  return (
    <div className="space-y-1">
      <Chip tone="muted" size="sm">
        No download record for this message
      </Chip>
      <p className="text-xs text-ink-3">The project may track this link from another message.</p>
    </div>
  );
}

export function LinksPanel({ email, state }: { email: Email; state: FileState }) {
  const list = email.links ?? [];
  if (list.length === 0) return null;
  return (
    <Panel>
      <PanelHeader
        title={`Links (${list.length})`}
        description={
          state.known
            ? "Download status comes from the project. Ordinary web links are not downloaded."
            : "The download status of these links could not be loaded. Nothing below is guessed."
        }
        actions={state.known ? null : <RetryStatus state={state} />}
      />
      <ul className="divide-y divide-line">
        {list.map((l, i) => {
          const kind = String(l.kind ?? "other");
          const label = typeof l.label === "string" ? l.label.trim() : "";
          return (
            <li key={`${l.url}-${i}`} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:gap-4">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-2 text-sm text-ink-3">
                  <span className="font-medium text-ink-2">{linkKindLabel(kind)}</span>
                  <span>{hostOf(l.url)}</span>
                </p>
                {label ? (
                  <p className="break-words text-base text-ink" dir={dirOf(label)}>
                    {label}
                  </p>
                ) : null}
                <a href={l.url} target="_blank" rel="noreferrer" className="break-all text-sm text-brand-ink hover:underline" dir="ltr">
                  {l.url}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </div>
              <LinkState link={state.links.find((p) => p.url === l.url)} kind={kind} state={state} />
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/* ------------------------------------------------------------------ conversation */

export function ThreadPanel({ thread, currentId }: { thread: ThreadMessage[]; currentId: string }) {
  if (thread.length < 2) return null;
  return (
    <Panel>
      <PanelHeader title={`Conversation (${thread.length} messages)`} description="Every message in this thread, oldest first." />
      <ul className="divide-y divide-line">
        {thread.map((t) => {
          const current = t.id === currentId;
          const who = t.from_name?.trim() || t.from_email;
          const body = (
            <div className="flex items-start gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <bdi className="font-medium text-ink" dir="auto">
                    {who}
                  </bdi>
                  {t.direction === "outbound" ? (
                    <Chip size="sm" tone="muted">
                      Sent by us
                    </Chip>
                  ) : null}
                  {current ? (
                    <Chip size="sm" tone="brand">
                      This message
                    </Chip>
                  ) : null}
                </p>
                {t.snippet ? (
                  <p className="mt-0.5 line-clamp-2 break-words text-sm text-ink-3" dir={dirOf(t.snippet)}>
                    {t.snippet}
                  </p>
                ) : null}
              </div>
              <time dateTime={t.date ?? undefined} dir="ltr" className="shrink-0 text-xs text-ink-3 tabular">
                {formatRelative(t.date)}
              </time>
            </div>
          );
          return (
            <li key={t.id}>
              {current ? (
                body
              ) : (
                <Link to={emailHref(t.id)} className="block hover:bg-canvas">
                  {body}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
