import { useQueryClient } from "@tanstack/react-query";
import { Bot, Check, Circle, Mail, Plus, Search, ShieldCheck } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { stepIndex } from "@/app/setup";
import { useSession } from "@/api/session";
import { LearningSources } from "@/features/knowledge/components/LearningSources";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { modelStatusInfo, connectionStatusInfo } from "@/lib/labels";
import {
  Banner,
  Button,
  ConfirmDialog,
  EmptyState,
  LoadingRows,
  Panel,
  PanelBody,
  PanelHeader,
  QueryState,
  StatusChip,
  toast,
  toastError,
} from "@/ui";
import {
  invalidateConnections,
  useActivateConnection,
  useAiStatus,
  useCanManage,
  useConnections,
  useGoogleSignIn,
  useRemoveConnection,
} from "../api";
import { ConnectionRowView } from "../components/ConnectionRowView";
import { IconTile } from "../components/bits";
import { MailboxDialog } from "../components/MailboxDialog";
import { SearchServiceDialog } from "../components/SearchServiceDialog";
import { SharedLinksSection } from "../components/SharedLinks";
import type { ConnectionRow } from "../types";
import { aiProviderLabel, mailMethodLabel, searchProviderLabel } from "../vocab";

function Tick({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {ok ? <Check className="size-3.5 text-brand" aria-hidden /> : <Circle className="size-3.5" aria-hidden />}
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ mailbox */

function MailboxSection({ connections, canManage }: { connections: ConnectionRow[]; canManage: boolean }) {
  const mail = connections.filter((c) => c.kind === "mail");
  const [dialog, setDialog] = useState<{ conn: ConnectionRow | null } | null>(null);
  const [removing, setRemoving] = useState<ConnectionRow | null>(null);
  const remove = useRemoveConnection();
  const activate = useActivateConnection();
  const signIn = useGoogleSignIn();

  const recoveryFor = (c: ConnectionRow) => ({
    // without the client file Google cannot be asked: open the settings where it is uploaded
    reconnect: () =>
      c.secrets?.client_config?.set
        ? signIn.mutate(c.id, { onError: (err) => toastError(err, "Google sign-in could not start") })
        : setDialog({ conn: c }),
    upload_config: () => setDialog({ conn: c }),
    replace_password: () => setDialog({ conn: c }),
    edit: () => setDialog({ conn: c }),
  });

  const confirmRemove = () => {
    if (!removing) return;
    const name = removing.account || mailMethodLabel(removing.method);
    remove.mutate(removing.id, {
      onSuccess: () => {
        toast.success("Mailbox removed", { description: `${name} is no longer read.` });
        setRemoving(null);
      },
      onError: (err) => {
        setRemoving(null);
        toastError(err, "The mailbox could not be removed");
      },
    });
  };

  return (
    <Panel>
      <PanelHeader
        title="Mailbox"
        description="The app reads enquiry mail and attachments. It never deletes, moves or sends anything on its own."
        actions={
          mail.length > 0 ? (
            <Button variant="secondary" size="sm" icon={<Plus />} disabled={!canManage} onClick={() => setDialog({ conn: null })}>
              Add mailbox
            </Button>
          ) : null
        }
      />
      {mail.length === 0 ? (
        <EmptyState
          icon={<Mail />}
          title="No mailbox connected"
          action={
            <Button icon={<Plus />} disabled={!canManage} onClick={() => setDialog({ conn: null })}>
              Connect mailbox
            </Button>
          }
        >
          Connect the mailbox customers write to. Enquiries become projects and every file the customer sent is collected. Mail is only read.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {mail.map((c) => (
            <ConnectionRowView
              key={c.id}
              conn={c}
              icon={<Mail />}
              title={mailMethodLabel(c.method)}
              subtitle={c.account || c.config?.account || c.config?.username || undefined}
              description="Used to read enquiry mail and attachments. Sending always needs a person's approval."
              canManage={canManage}
              showActive={mail.length > 1}
              onEdit={() => setDialog({ conn: c })}
              onRemove={() => setRemoving(c)}
              onMakeActive={() =>
                activate.mutate(
                  { conn: c, all: connections },
                  {
                    onSuccess: () => toast.success("Mailbox switched", { description: `${c.account || mailMethodLabel(c.method)} is now the one the app reads.` }),
                    onError: (err) => toastError(err, "Could not switch mailbox"),
                  },
                )
              }
              recovery={recoveryFor(c)}
              recoveryBusy={signIn.isPending && signIn.variables === c.id ? "reconnect" : null}
            >
              {c.method === "oauth" ? (
                <p className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-3 sm:pl-14">
                  <Tick ok={!!c.secrets?.client_config?.set}>Client file {c.secrets?.client_config?.set ? "saved" : "missing"}</Tick>
                  <Tick ok={!!c.secrets?.token?.set}>Google sign-in {c.secrets?.token?.set ? "done" : "not done yet"}</Tick>
                </p>
              ) : null}
            </ConnectionRowView>
          ))}
        </ul>
      )}

      <MailboxDialog open={dialog !== null} onOpenChange={(o) => !o && setDialog(null)} conn={dialog?.conn} connections={connections} />

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing ? removing.account || mailMethodLabel(removing.method) : "mailbox"}?`}
        confirmLabel="Remove mailbox"
        variant="danger"
        loading={remove.isPending}
        onConfirm={confirmRemove}
      >
        <div className="space-y-2 text-base text-ink-2">
          <p>The app stops reading this mailbox. New enquiries no longer arrive until a mailbox is connected again.</p>
          <p>Mail already saved on this computer, and every project made from it, stays.</p>
          <p>
            The sign-in details kept for this mailbox (client file, token or password) are deleted from this computer.
            {removing?.method === "oauth" ? " To also withdraw Google's access, remove the app in your Google Account under Security." : ""}
          </p>
        </div>
      </ConfirmDialog>
    </Panel>
  );
}

/* ------------------------------------------------------------------ web search */

function SearchSection({ connections, canManage, kind = "search" }: { connections: ConnectionRow[]; canManage: boolean; kind?: "search" | "reader" }) {
  const search = connections.filter((c) => c.kind === kind);
  const [dialog, setDialog] = useState<{ conn: ConnectionRow | null } | null>(null);
  const [removing, setRemoving] = useState<ConnectionRow | null>(null);
  const remove = useRemoveConnection();
  const activate = useActivateConnection();

  return (
    <Panel>
      <PanelHeader
        title={kind === "reader" ? "Page reading" : "Web search"}
        description={kind === "reader" ? "Optional. Use Firecrawl to read public websites alongside Tavily, Exa or another search service." : "Optional. Used only for customer research. Web results are context for a profile; they never decide what your company does."}
        actions={
          <Button variant="secondary" size="sm" icon={<Plus />} disabled={!canManage} onClick={() => setDialog({ conn: null })}>
            {kind === "reader" ? "Connect Firecrawl" : "Add search service"}
          </Button>
        }
      />
      {search.length === 0 ? (
        <PanelBody>
          <div className="flex items-start gap-4">
            <IconTile>
              <Search />
            </IconTile>
            <div className="min-w-0">
              <p className="font-semibold text-ink">{kind === "reader" ? "Direct page reading" : "DuckDuckGo, no key"}</p>
              <p className="text-sm text-ink-3">
                {kind === "reader" ? "Public pages are read directly by the app, or through your search service when it includes page reading." : "Customer research uses DuckDuckGo when no service is connected. Add Tavily or Exa for a free monthly allowance with your own key."}
              </p>
            </div>
          </div>
        </PanelBody>
      ) : (
        <ul className="divide-y divide-line">
          {search.map((c) => (
            <ConnectionRowView
              key={c.id}
              conn={c}
              icon={<Search />}
              title={searchProviderLabel(c.provider)}
              description="Used for customer research. Web results are context, never proof."
              canManage={canManage}
              showActive
              onEdit={() => setDialog({ conn: c })}
              onRemove={() => setRemoving(c)}
              onMakeActive={() =>
                activate.mutate(
                  { conn: c, all: connections },
                  { onSuccess: () => toast.success(`${searchProviderLabel(c.provider)} is now used`), onError: (err) => toastError(err, "Could not switch") },
                )
              }
              recovery={{ replace_key: () => setDialog({ conn: c }), edit: () => setDialog({ conn: c }) }}
            />
          ))}
        </ul>
      )}
      <SearchServiceDialog kind={kind} open={dialog !== null} onOpenChange={(o) => !o && setDialog(null)} conn={dialog?.conn} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing ? searchProviderLabel(removing.provider) : "search service"}?`}
        confirmLabel="Remove search service"
        variant="danger"
        loading={remove.isPending}
        onConfirm={() =>
          removing &&
          remove.mutate(removing.id, {
            onSuccess: () => {
              toast.success("Search service removed");
              setRemoving(null);
            },
            onError: (err) => {
              setRemoving(null);
              toastError(err, "The search service could not be removed");
            },
          })
        }
      >
        <div className="space-y-2 text-base text-ink-2">
          <p>Customer research falls back to DuckDuckGo without a key. Profiles already built stay as they are.</p>
          <p>The stored key is deleted from this computer.</p>
        </div>
      </ConfirmDialog>
    </Panel>
  );
}

/* ------------------------------------------------------------------ AI engine */

function AiEngineSummary() {
  const status = useAiStatus();
  const s = status.data;
  let detail = "Not connected. Mail is sorted by rules only, and nothing is read or drafted by AI.";
  let chip = connectionStatusInfo("not_connected");
  if (s?.method === "api" && s.api) {
    detail = `${aiProviderLabel(s.api.provider)} · ${s.api.model ?? "no model chosen yet"}`;
    chip = s.api.model ? modelStatusInfo(s.api.eligibility ?? "needs_evaluation") : { label: "Choose a model", tone: "review" };
  } else if (s?.method === "mcp" && s.mcp) {
    detail = s.mcp.declared ? `MCP client ${s.mcp.declared.client || "connected"} · ${s.mcp.declared.model_id}` : "MCP: waiting for an AI client to declare its model";
    chip = s.mcp.eligibility ? modelStatusInfo(s.mcp.eligibility) : { label: "Waiting for client", tone: "review" };
  }
  return (
    <Panel>
      <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-4">
          <IconTile tone={chip.tone === "brand" ? "brand" : "neutral"}>
            <Bot />
          </IconTile>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <p className="font-semibold text-ink">AI engine</p>
              {status.isLoading ? null : <StatusChip info={chip} size="sm" />}
            </div>
            <p className="text-sm text-ink-3">{status.isError ? "The AI status could not load." : detail}</p>
          </div>
        </div>
        <Button asChild variant="secondary" size="sm" className="w-full sm:w-auto">
          <Link to="/settings/ai">Manage AI engine</Link>
        </Button>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ page */

/** Settings › Mailbox & services. */
export function ConnectionsPage() {
  const connections = useConnections();
  const canManage = useCanManage();
  const session = useSession();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const gmail = params.get("gmail");
  const [resume, setResume] = useState(false);
  const setupOpen = stepIndex(session.data?.workspace?.setup_step) <= stepIndex("mail");

  // the return trip from Google: say what happened, then drop the parameter
  useEffect(() => {
    if (!gmail) return;
    if (gmail === "connected") {
      toast.success("Gmail connected", { description: "The app can now read this mailbox." });
      setResume(true);
    } else {
      toast.error("Google sign-in did not finish", { description: "Open the mailbox below to see what Google reported, then try again." });
    }
    void invalidateConnections(qc);
    setParams(
      (p) => {
        p.delete("gmail");
        return p;
      },
      { replace: true },
    );
  }, [gmail, qc, setParams]);

  return (
    <SettingsPage title="Mailbox & services" meta="Where the app reads mail and files from. Everything here is read only; sending needs a person's approval.">
      {resume && setupOpen ? (
        <Banner
          tone="brand"
          title="Gmail is connected"
          actions={
            <Button asChild size="sm">
              <Link to="/setup/mail">Continue setup</Link>
            </Button>
          }
        >
          You were in the middle of setting up this workspace.
        </Banner>
      ) : null}

      <QueryState
        query={connections}
        loading={
          <Panel>
            <LoadingRows rows={2} />
          </Panel>
        }
      >
        {(rows) => (
          <>
            <MailboxSection connections={rows} canManage={canManage} />
            <Panel>
              <PanelHeader
                title="Company documents"
                description="Old quotations, catalogues and company profiles on this computer. Business learning reads them to learn what you actually deliver. Files are read, never changed or moved."
              />
              <LearningSources canEdit={canManage} />
            </Panel>
            <SharedLinksSection />
            <SearchSection connections={rows} canManage={canManage} />
            <SearchSection kind="reader" connections={rows} canManage={canManage} />
          </>
        )}
      </QueryState>

      <AiEngineSummary />

      <Panel>
        <PanelBody className="flex items-start gap-4">
          <IconTile>
            <ShieldCheck />
          </IconTile>
          <div className="min-w-0 space-y-1">
            <p className="font-semibold text-ink">Permissions and safety</p>
            <p className="text-sm text-ink-2">Mail and files are read to prepare quotation drafts. Nothing is sent to a customer until a person approves the exact revision.</p>
            <p className="text-sm text-ink-3">Keys, passwords and tokens are stored encrypted on this computer and are never shown again.</p>
          </div>
        </PanelBody>
      </Panel>
    </SettingsPage>
  );
}
