/**
 * The message itself (mockup 13): header fields from the real headers, the text, attachments and
 * links with what happened to them, and the rest of the conversation.
 */
import { ExternalLink, Paperclip } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { Email, ProjectFile, ProjectLink } from "@/api/types";
import { formatBytes, formatDateTime, formatRelative, isRtl, pluralize } from "@/lib/format";
import { fileStatusInfo, linkStatusInfo } from "@/lib/labels";
import { emailHref, fileHref, nextActionHref } from "@/lib/routes";
import { Button, Chip, KeyValue, Panel, PanelBody, PanelHeader, Skeleton, StatusChip } from "@/ui";
import { hostOf, useRetryEmailFile, useRetryEmailLink, type ThreadMessage } from "./api";
import { toast, toastError } from "@/ui";
import { linkKindLabel } from "./labels";
import { dirOf } from "./parts";

const BODY_LIMIT = 4000;

function Addresses({ list }: { list: string[] }) {
  return (
    <ul className="space-y-0.5">
      {list.map((a, i) => (
        <li key={i} className="break-all">
          <bdi dir="ltr">{a}</bdi>
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
  const view = email.view_url && /^https?:\/\//i.test(email.view_url) ? email.view_url : null;
  const rows: { label: ReactNode; value: ReactNode; hint?: ReactNode }[] = [
    {
      label: "From",
      value: (
        <>
          <bdi className="font-medium" dir={dirOf(name)}>
            {name || email.from_email || "Unknown sender"}
          </bdi>
          {name ? <bdi dir="ltr" className="block break-all text-sm text-ink-2">{email.from_email}</bdi> : null}
        </>
      ),
      hint: "The sender named in the message header",
    },
    {
      label: "Received in",
      value: email.account ? <bdi dir="ltr" className="break-all">{email.account}</bdi> : null,
      hint: "The connected mailbox that holds this message",
    },
    { label: "To", value: email.to?.length ? <Addresses list={email.to} /> : null },
    ...(email.cc?.length ? [{ label: "Cc", value: <Addresses list={email.cc} /> }] : []),
    { label: "Date", value: <time dir="ltr" dateTime={email.date ?? undefined}>{formatDateTime(email.date)}</time> },
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

interface ProjectParts {
  hasProject: boolean;
  loading: boolean;
  files?: ProjectFile[];
  links?: ProjectLink[];
  projectId?: string | null;
  error?: boolean;
  retry?: () => unknown;
}

function Unavailable({ retry }: { retry?: () => unknown }) {
  return <div className="flex flex-wrap items-center gap-2"><Chip tone="muted" size="sm">Status unavailable</Chip><Button variant="secondary" size="sm" onClick={retry}>Retry status</Button></div>;
}

function RetryFile({ file }: { file: ProjectFile }) {
  const retry = useRetryEmailFile();
  if (file.status !== "failed") return null;
  return <Button variant="secondary" size="sm" loading={retry.isPending} onClick={() => retry.mutate(file.id, { onSuccess: () => toast.success("File retry started"), onError: (e) => toastError(e, "The file could not be retried") })}>Try again</Button>;
}

function RetryLink({ link }: { link: ProjectLink }) {
  const retry = useRetryEmailLink();
  if (!["failed", "expired", "unavailable"].includes(link.status)) return null;
  return <Button variant="secondary" size="sm" loading={retry.isPending} onClick={() => retry.mutate(link.id, { onSuccess: () => toast.success("Link retry started"), onError: (e) => toastError(e, "The link could not be retried") })}>Try again</Button>;
}

export function AttachmentsPanel({ email, parts }: { email: Email; parts: ProjectParts }) {
  const list = email.attachments ?? [];
  if (list.length === 0) return null;
  return (
    <Panel>
      <PanelHeader
        title={`Attachments (${list.length})`}
        description="Saved means the file was downloaded into the project. Reading and review are shown on the project."
      />
      <ul className="divide-y divide-line">
        {list.map((a, i) => {
          const file = parts.files?.find(
            (f) => f.email_id === email.id && ((!!a.attachment_id && f.attachment_id === a.attachment_id) || f.name === a.filename),
          );
          const meta = [a.mime, a.size ? formatBytes(a.size) : null].filter(Boolean).join(" · ");
          return (
            <li key={`${a.filename}-${i}`} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
              <Paperclip className="size-4 shrink-0 text-ink-3" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="break-words font-medium text-ink" dir={dirOf(a.filename)}>
                  {a.filename}
                </p>
                {meta ? <p className="text-xs text-ink-3 tabular">{meta}</p> : null}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {parts.error ? <Unavailable retry={parts.retry} /> : file ? (
                  <>
                    <StatusChip info={fileStatusInfo(file.status)} size="sm" />
                    <Link to={fileHref(file.id)} className="text-sm font-medium text-brand-ink hover:underline">
                      Open file
                    </Link>
                    <RetryFile file={file} />
                  </>
                ) : parts.hasProject && parts.loading ? (
                  <Skeleton className="h-6 w-28" />
                ) : (
                  <Chip tone="muted" size="sm">
                    {parts.hasProject ? "Not saved to the project yet" : "Not saved: no project yet"}
                  </Chip>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function LinkState({ link, kind, parts }: { link?: ProjectLink; kind: string; parts: ProjectParts }) {
  if (parts.error) return <Unavailable retry={parts.retry} />;
  if (link) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip info={linkStatusInfo(link.status)} size="sm" />
        <RetryLink link={link} />
        {link.files_count ? <span className="text-xs text-ink-3 tabular">{pluralize(link.files_count, "file")}</span> : null}
        {link.status === "pending_approval" && parts.projectId ? (
          <Button asChild variant="secondary" size="sm">
            <Link to={nextActionHref(parts.projectId, { kind: "resolve_link", link_id: link.id })}>Review download</Link>
          </Button>
        ) : null}
      </div>
    );
  }
  if (parts.hasProject && parts.loading) return <Skeleton className="h-6 w-28" />;
  return (
    <Chip tone="muted" size="sm">
      {!parts.hasProject ? "Status unknown: no project yet" : kind === "other" ? "Web page, not downloaded" : "Not queued for download"}
    </Chip>
  );
}

export function LinksPanel({ email, parts }: { email: Email; parts: ProjectParts }) {
  const list = email.links ?? [];
  if (list.length === 0) return null;
  return (
    <Panel>
      <PanelHeader
        title={`Links (${list.length})`}
        description="Download status comes from the project. Ordinary web links are not downloaded."
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
                <a dir="ltr" href={l.url} target="_blank" rel="noreferrer" className="break-all text-sm text-brand-ink hover:underline">
                  {l.url}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </div>
              <LinkState link={parts.links?.find((p) => p.url === l.url)} kind={kind} parts={parts} />
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

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
                  <bdi className="font-medium text-ink" dir={dirOf(who)}>
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
              <time dir="ltr" dateTime={t.date ?? undefined} className="shrink-0 text-xs text-ink-3 tabular">
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
