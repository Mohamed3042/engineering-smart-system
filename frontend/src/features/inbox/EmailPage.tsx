/**
 * One message (mockup 13): the original sender and the receiving mailbox as separate fields, the
 * text, attachments and links with their status, how it was filed and why, the linked project and
 * customer, and unsubscribe behind a confirmation. Mail that no project claims gets human recovery
 * actions: file it under a project, or open a project from it. Reply and Forward hand the message to
 * the person's own mail program; nothing here sends, replies or deletes mail.
 */
import { Archive, ArchiveRestore, ArrowRightLeft, Clock, FolderInput, FolderPlus, MailMinus, Unlink2 } from "lucide-react";
import { useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import { isApiError } from "@/api/client";
import { dueLabel, formatDate, formatDateTime } from "@/lib/format";
import { customerKindLabel, stageInfo } from "@/lib/labels";
import { customerHref, projectHref } from "@/lib/routes";
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  KeyValue,
  LoadingRows,
  Page,
  PageHeader,
  Panel,
  PanelBody,
  PanelHeader,
  StatusChip,
  toast,
  toastError,
} from "@/ui";
import { parseUnsubscribe, useEmail, useUpdateEmail, type EmailDetail } from "./api";
import { CategoryPanel } from "./CategoryPanel";
import { AttachmentsPanel, LinksPanel, MessagePanel, ThreadPanel, type FileState } from "./EmailMessage";
import { HandOff } from "./HandOff";
import { emailStateInfo } from "./labels";
import { CreateProjectDialog, ProjectPickerDialog } from "./LinkDialogs";
import { IntentLabel, dirOf, senderName } from "./parts";
import { UnsubscribeDialog } from "./UnsubscribeDialog";
import { useReturnFocus } from "./useReturnFocus";

/**
 * Where the message is filed, and how a person changes that. Unlinked work mail waits for a person,
 * so the actions sit right beside the status (and, on a phone, ahead of the message text).
 */
function ProjectPanel({ detail, onFile, onCreate }: { detail: EmailDetail; onFile: () => void; onCreate: () => void }) {
  const { email, project, customer, category } = detail;
  const work = category?.group === "work";
  return (
    <Panel className={!project && work ? "order-first lg:order-none" : undefined}>
      <PanelHeader title="Project and customer" />
      <PanelBody className="space-y-4">
        {project ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Link to={projectHref(project.id)} className="block break-words font-semibold text-ink hover:text-brand-ink hover:underline" dir={dirOf(project.name)}>
                {project.name}
              </Link>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <StatusChip info={stageInfo(project.stage)} size="sm" />
                {project.due_date ? (
                  <span className="text-sm text-ink-2 tabular">
                    Closes {formatDate(project.due_date)} · {dueLabel(project.due_date)}
                  </span>
                ) : null}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="secondary" size="sm">
                <Link to={projectHref(project.id)}>Open project</Link>
              </Button>
              <Button variant="ghost" size="sm" icon={<ArrowRightLeft />} onClick={onFile}>
                Move to another project
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <Chip tone={work ? "review" : "neutral"} icon={work ? <Clock aria-hidden /> : <Unlink2 aria-hidden />}>
              Not linked to a project
            </Chip>
            <p className="text-sm text-ink-2">
              {work ? (
                <>
                  The mailbox scan did not match this message to an enquiry{email.state === "needs_review" ? ", so it is waiting for a person" : ""}. File it
                  under an open project, or open a new project from it.
                </>
              ) : (
                "This is not work mail, so it does not need a project. If it belongs to one, you can still file it."
              )}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap lg:flex-col">
              <Button variant={work ? "primary" : "secondary"} icon={<FolderInput />} onClick={onFile} className="w-full sm:w-auto lg:w-full">
                File under a project
              </Button>
              <Button variant="secondary" icon={<FolderPlus />} onClick={onCreate} className="w-full sm:w-auto lg:w-full">
                Create project from this message
              </Button>
            </div>
          </div>
        )}
        {customer ? (
          <KeyValue
            labelWidth="sm"
            items={[
              {
                label: "Customer",
                value: (
                  <Link to={customerHref(customer.id)} className="font-medium text-brand-ink hover:underline">
                    {customer.name}
                  </Link>
                ),
                hint: customerKindLabel(customer.kind || "other"),
              },
            ]}
          />
        ) : (
          <p className="text-sm text-ink-3">
            No customer on file for <span className="break-all">{email.from_email || "this sender"}</span>.
          </p>
        )}
      </PanelBody>
    </Panel>
  );
}

/** The list-unsubscribe header names where the request would go. Nothing is sent from this panel. */
function UnsubscribePanel({ detail, onOpen }: { detail: EmailDetail; onOpen: () => void }) {
  const { email } = detail;
  if (!email.list_unsubscribe && !email.unsubscribed_at) return null;
  const addr = parseUnsubscribe(email.list_unsubscribe);
  const where = addr.https ?? addr.mailto;
  return (
    <Panel>
      <PanelHeader title="Unsubscribe" />
      <PanelBody className="space-y-3">
        {email.unsubscribed_at ? (
          <p className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
            <Chip tone="muted" size="sm">
              Unsubscribed
            </Chip>
            on {formatDate(email.unsubscribed_at)}
          </p>
        ) : (
          <>
            <p className="text-sm text-ink-2">
              {where ? (
                <>
                  The sender lists <span className="break-all font-medium text-ink">{where}</span> for unsubscribing.
                </>
              ) : (
                "The sender has an unsubscribe header the app cannot use."
              )}{" "}
              Nothing is sent until you confirm.
            </p>
            <Button variant="secondary" icon={<MailMinus />} className="w-full sm:w-auto" onClick={onOpen}>
              Unsubscribe…
            </Button>
          </>
        )}
      </PanelBody>
    </Panel>
  );
}

function Detail({
  detail,
  backTo,
  refresh,
}: {
  detail: EmailDetail;
  backTo: string;
  /** The last refresh of this message: when it failed, file and link state is not shown as fact. */
  refresh: { failed: boolean; fetching: boolean; retry: () => void };
}) {
  const { email, thread, project } = detail;
  const update = useUpdateEmail();
  const [unsub, setUnsub] = useState(false);
  const [dialog, setDialog] = useState<"file" | "create" | null>(null);
  // The picker and the create dialog hand over to each other; focus goes back once, to the button that started it.
  useReturnFocus(dialog !== null);
  const archived = email.state === "archived";
  const state = emailStateInfo(email.state);

  const move = () =>
    update.mutate(
      { id: email.id, patch: { state: archived ? (email.project_id ? "linked" : "needs_review") : "archived" } },
      {
        onSuccess: () => toast.success(archived ? "Moved back to your inbox" : "Archived", { description: archived ? undefined : "It stays in the mailbox. Find it under Archived." }),
        onError: (err) => toastError(err, "That change did not save"),
      },
    );

  const files: FileState = {
    known: !refresh.failed && Array.isArray(detail.files) && Array.isArray(detail.links),
    files: detail.files ?? [],
    links: detail.links ?? [],
    hasProject: !!project,
    projectId: project?.id ?? null,
    emailId: email.id,
    refreshing: refresh.fetching,
    onRetryStatus: refresh.retry,
    onFileUnder: () => setDialog("file"),
  };

  return (
    <>
      <PageHeader
        back={{ to: backTo, label: "Inbox" }}
        title={
          <span className="break-words" dir={dirOf(email.subject)}>
            {email.subject || "(no subject)"}
          </span>
        }
        status={
          <span className="flex flex-wrap items-center gap-2">
            {email.intent && email.intent !== "other" ? <IntentLabel intent={email.intent} /> : null}
            {email.state !== "new" && email.state !== "linked" ? <StatusChip info={state} /> : null}
            {email.direction === "outbound" ? <Chip tone="muted">Sent by us</Chip> : null}
          </span>
        }
        meta={
          <>
            <span className="break-words">
              <bdi dir="auto">{senderName(email)}</bdi> · <span dir="ltr" className="tabular">{formatDateTime(email.date)}</span>
            </span>
            <HandOff email={email} className="mt-3" />
          </>
        }
        actions={
          <Button variant="secondary" icon={archived ? <ArchiveRestore /> : <Archive />} onClick={move} loading={update.isPending} className="w-full md:w-auto">
            {archived ? "Move back to inbox" : "Archive"}
          </Button>
        }
      />

      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <div className="contents lg:block lg:min-w-0 lg:space-y-6">
          <MessagePanel email={email} />
          <AttachmentsPanel email={email} state={files} />
          <LinksPanel email={email} state={files} />
        </div>
        <aside aria-label="How this message is filed" className="contents lg:block lg:space-y-6">
          <CategoryPanel detail={detail} />
          <ProjectPanel detail={detail} onFile={() => setDialog("file")} onCreate={() => setDialog("create")} />
          <UnsubscribePanel detail={detail} onOpen={() => setUnsub(true)} />
        </aside>
      </div>

      <div className="mt-6">
        <ThreadPanel thread={thread} currentId={email.id} />
      </div>

      <UnsubscribeDialog target={unsub ? email : null} onOpenChange={(o) => !o && setUnsub(false)} />
      <ProjectPickerDialog
        detail={detail}
        open={dialog === "file"}
        onOpenChange={(o) => setDialog(o ? "file" : null)}
        onCreateInstead={() => setDialog("create")}
      />
      <CreateProjectDialog detail={detail} open={dialog === "create"} onOpenChange={(o) => setDialog(o ? "create" : null)} />
    </>
  );
}

export function EmailPage() {
  const { emailId = "" } = useParams();
  const location = useLocation();
  const q = useEmail(emailId);
  // The list passes its own query string, so Back returns to the same filtered view.
  const from = (location.state as { from?: string } | null)?.from;

  if (q.isError && isApiError(q.error) && q.error.status === 404) {
    return (
      <Page>
        <EmptyState
          title="This email is not in the workspace"
          action={
            <Button variant="secondary" asChild>
              <Link to="/inbox">Back to the inbox</Link>
            </Button>
          }
        >
          It may have been removed, or the link is from another workspace.
        </EmptyState>
      </Page>
    );
  }

  const group = q.data?.category?.group;
  const backTo = from ? `/inbox${from}` : group && group !== "work" ? `/inbox?group=${group}` : "/inbox";

  return (
    <Page>
      {q.data ? (
        <Detail detail={q.data} backTo={backTo} refresh={{ failed: q.isRefetchError, fetching: q.isFetching, retry: () => void q.refetch() }} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <Panel>
          <LoadingRows rows={6} />
        </Panel>
      )}
    </Page>
  );
}
