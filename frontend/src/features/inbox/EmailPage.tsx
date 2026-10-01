/**
 * One message (mockup 13): the original sender and the receiving mailbox as separate fields, the
 * text, attachments and links with their status, how it was filed and why, the linked project and
 * customer, and unsubscribe behind a confirmation. Nothing here sends, replies or deletes mail.
 */
import { Archive, ArchiveRestore, MailMinus } from "lucide-react";
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
  KeyValue,
  LoadingRows,
  Page,
  PageHeader,
  Panel,
  PanelBody,
  PanelHeader,
  QueryState,
  StatusChip,
  toast,
  toastError,
} from "@/ui";
import { parseUnsubscribe, useEmail, useProjectParts, useUpdateEmail, type EmailDetail } from "./api";
import { CategoryPanel } from "./CategoryPanel";
import { AttachmentsPanel, LinksPanel, MessagePanel, ThreadPanel } from "./EmailMessage";
import { emailStateInfo } from "./labels";
import { IntentLabel, dirOf, senderName } from "./parts";
import { UnsubscribeDialog } from "./UnsubscribeDialog";

function ProjectPanel({ detail }: { detail: EmailDetail }) {
  const { email, project, customer } = detail;
  return (
    <Panel>
      <PanelHeader title="Project and customer" />
      <PanelBody className="space-y-4">
        {project ? (
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
        ) : (
          <p className="text-sm text-ink-2">
            Not linked to a project yet. Work mail is linked when the mailbox scan matches it to an enquiry
            {email.state === "needs_review" ? "; this one is waiting for a person to check it" : ""}.
          </p>
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
          <p className="text-sm text-ink-3">No customer on file for {email.from_email || "this sender"}.</p>
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

function Detail({ detail, backTo }: { detail: EmailDetail; backTo: string }) {
  const { email, thread, project } = detail;
  const parts = useProjectParts(email.project_id);
  const update = useUpdateEmail();
  const [unsub, setUnsub] = useState(false);
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
          <span className="break-words">
            {senderName(email)} · <span className="tabular">{formatDateTime(email.date)}</span>
          </span>
        }
        actions={
          <Button variant="secondary" icon={archived ? <ArchiveRestore /> : <Archive />} onClick={move} loading={update.isPending}>
            {archived ? "Move back to inbox" : "Archive"}
          </Button>
        }
      />

      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <div className="min-w-0 space-y-6">
          <MessagePanel email={email} />
          <AttachmentsPanel
            email={email}
            parts={{ hasProject: !!project, loading: parts.isLoading, files: parts.data?.files, links: parts.data?.links, projectId: project?.id }}
          />
          <LinksPanel
            email={email}
            parts={{ hasProject: !!project, loading: parts.isLoading, files: parts.data?.files, links: parts.data?.links, projectId: project?.id }}
          />
        </div>
        <aside className="space-y-6">
          <CategoryPanel detail={detail} />
          <ProjectPanel detail={detail} />
          <UnsubscribePanel detail={detail} onOpen={() => setUnsub(true)} />
        </aside>
      </div>

      <div className="mt-6">
        <ThreadPanel thread={thread} currentId={email.id} />
      </div>

      <UnsubscribeDialog target={unsub ? email : null} onOpenChange={(o) => !o && setUnsub(false)} />
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
      <QueryState
        query={q}
        loading={
          <Panel>
            <LoadingRows rows={6} />
          </Panel>
        }
      >
        {(detail) => <Detail detail={detail} backTo={backTo} />}
      </QueryState>
    </Page>
  );
}
