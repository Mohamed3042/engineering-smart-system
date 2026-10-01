import { Mail } from "lucide-react";
import { useState } from "react";
import { useWorkspace } from "@/api/session";
import { testSummary, useConnections, useGoogleSignIn, useTestConnection } from "@/features/connections/api";
import { IconTile } from "@/features/connections/components/bits";
import { IssueBanner } from "@/features/connections/components/IssueBanner";
import { MailboxForm } from "@/features/connections/components/MailboxForm";
import { connectionIssue } from "@/features/connections/issues";
import { mailMethodLabel } from "@/features/connections/vocab";
import { formatRelative } from "@/lib/format";
import { connectionStatusInfo } from "@/lib/labels";
import { Button, Panel, PanelBody, PanelHeader, QueryState, StatusChip, toast, toastError } from "@/ui";
import { StepHeader, StepNav } from "./StepFrame";

/** Step 4: connect the mailbox, read only. A connected mailbox is shown as a summary, not as a form. */
export function MailStep() {
  const connections = useConnections();
  const workspace = useWorkspace();
  const signIn = useGoogleSignIn();
  const test = useTestConnection();
  const [changing, setChanging] = useState(false);

  const mail = (connections.data ?? []).filter((c) => c.kind === "mail");
  const current = mail.find((c) => c.is_active) ?? mail[0] ?? null;
  const connected = current?.status === "connected";
  const issue = current && current.method === "oauth" ? connectionIssue(current) : null;

  return (
    <>
      <StepHeader
        title="Connect the mailbox"
        description="The app reads enquiry mail and attachments so it can open projects. It never deletes, moves or sends anything on its own."
      />
      <QueryState query={connections}>
        {(rows) =>
          connected && current && !changing ? (
            <Panel>
              <PanelBody className="space-y-4 py-5">
                <div className="flex items-start gap-4">
                  <IconTile tone="brand">
                    <Mail />
                  </IconTile>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <p className="font-semibold text-ink">{mailMethodLabel(current.method)}</p>
                      <StatusChip info={connectionStatusInfo(current.status)} size="sm" />
                    </div>
                    <p className="break-all text-base text-ink-2">{current.account || current.config?.account || current.config?.username}</p>
                    {current.last_checked_at ? <p className="text-sm text-ink-3">Checked {formatRelative(current.last_checked_at).toLowerCase()}</p> : null}
                  </div>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    variant="secondary"
                    loading={test.isPending}
                    onClick={() =>
                      test.mutate(current.id, {
                        onSuccess: (res) => (res.ok ? toast.success("Mailbox works", { description: testSummary(res) }) : toast.error("The test failed", { description: res.error ?? undefined })),
                        onError: (err) => toastError(err, "The test could not run"),
                      })
                    }
                    className="w-full sm:w-auto"
                  >
                    Test again
                  </Button>
                  <Button variant="ghost" onClick={() => setChanging(true)} className="w-full sm:w-auto">
                    Use a different mailbox
                  </Button>
                </div>
              </PanelBody>
            </Panel>
          ) : (
            <div className="space-y-4">
              {issue && current && !changing ? (
                <IssueBanner
                  issue={issue}
                  raw={current.last_error}
                  on={{
                    reconnect: current.secrets?.client_config?.set
                      ? () => signIn.mutate(current.id, { onError: (err) => toastError(err, "Google sign-in could not start") })
                      : undefined,
                  }}
                  busy={signIn.isPending ? "reconnect" : null}
                />
              ) : null}
              <Panel>
                <PanelHeader
                  title={changing ? "Add another mailbox" : current ? "Finish connecting the mailbox" : "Mailbox"}
                  description="Read access only. Keys and passwords are stored encrypted on this computer."
                  actions={
                    changing ? (
                      <Button variant="ghost" size="sm" onClick={() => setChanging(false)}>
                        Keep the current mailbox
                      </Button>
                    ) : null
                  }
                />
                <PanelBody className="py-5">
                  <MailboxForm
                    key={changing ? "new" : (current?.id ?? "new")}
                    conn={changing ? null : current}
                    connections={rows}
                    defaultUsername={workspace.primary_email}
                    autoFocus
                    onConnected={() => {
                      setChanging(false);
                      toast.success("Mailbox connected");
                    }}
                  />
                </PanelBody>
              </Panel>
            </div>
          )
        }
      </QueryState>

      <StepNav
        continueDisabled={!connected || changing}
        reason="Connect the mailbox first, or skip."
        skip="Skip for now"
        skipHint="Nothing is read until a mailbox is connected. Do it later in Settings, under Mailbox & services."
      />
    </>
  );
}
