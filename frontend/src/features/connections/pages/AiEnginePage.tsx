import { Bot, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { modelStatusInfo, type StatusInfo } from "@/lib/labels";
import {
  Banner,
  Button,
  Chip,
  ConfirmDialog,
  EmptyState,
  Panel,
  PanelBody,
  PanelHeader,
  QueryState,
  Section,
  StatusChip,
  toast,
  toastError,
} from "@/ui";
import { useActivateConnection, useAiPolicy, useAiStatus, useCanManage, useConnections, useEnableMcp, useRemoveConnection } from "../api";
import { ApiKeyForm } from "../components/ApiKeyForm";
import { ConnectionRowView } from "../components/ConnectionRowView";
import { EngineMethodChooser, type EngineMethod } from "../components/EngineMethodChooser";
import { McpChecklist, McpEndpoint, McpEngineDetails } from "../components/McpPanel";
import { ModelPicker } from "../components/ModelPicker";
import { IconTile } from "../components/bits";
import type { AiStatus, ConnectionRow } from "../types";
import { aiProviderLabel } from "../vocab";

/** What the engine is doing right now, in one sentence. */
function EngineBanner({ status }: { status: AiStatus }) {
  if (status.rules_only) {
    return (
      <Banner tone="review" title="No eligible AI model yet">
        Mail is sorted by rules only. Reading requests and files, studying drawings and drafting quotations stay off until a model meets the
        workspace rules and passes the qualification exam.
      </Banner>
    );
  }
  if (status.method === "api" && status.api) {
    return (
      <Banner tone="brand" title={`${status.api.model ?? "A model"} through ${aiProviderLabel(status.api.provider)} is in use`}>
        It passed the workspace rules and the qualification exam. An engineer still reviews everything before anything is sent.
      </Banner>
    );
  }
  return (
    <Banner tone="brand" title="An MCP client is doing the AI work">
      Its model passed the rules and the exam for the tasks marked eligible below. Every submission is checked, and nothing is sent without a person.
    </Banner>
  );
}

/* ------------------------------------------------------------------ API */

function ApiView({ status, connections }: { status: AiStatus; connections: ConnectionRow[] }) {
  const apiConns = connections.filter((c) => c.kind === "ai" && c.method === "api");
  const shown = apiConns.find((c) => c.is_active) ?? apiConns[0] ?? null;
  return (
    <>
      {status.method === "mcp" && shown ? (
        <Banner tone="neutral" title="An MCP client is the engine in use">
          Save the key below to use the API instead. The MCP connection stays saved.
        </Banner>
      ) : null}
      <Panel>
        <PanelHeader
          title="API key"
          description="Connect Groq, Mistral or SambaNova with a free-plan key, or use another provider. The app calls your chosen model directly."
        />
        <PanelBody>
          <ApiKeyForm connections={connections} />
        </PanelBody>
      </Panel>
      <Section
        title="Model"
        description="Only a model that meets the workspace rules and passed the qualification exam can be selected. Refused models stay listed with the reason."
      >
        {shown ? (
          <ModelPicker connectionId={shown.id} provider={shown.provider} />
        ) : (
          <Panel>
            <EmptyState compact title="Save an API key first">
              Models are listed once the key passes its test. Each one is then checked against the workspace rules, and you run the qualification exam on the one you want.
            </EmptyState>
          </Panel>
        )}
      </Section>
    </>
  );
}

/* ------------------------------------------------------------------ MCP */

function McpView({ status, connections }: { status: AiStatus; connections: ConnectionRow[] }) {
  const canManage = useCanManage();
  const policy = useAiPolicy();
  const [confirm, setConfirm] = useState(false);
  const inUse = status.method === "mcp";
  const apiActive = connections.find((c) => c.kind === "ai" && c.method === "api" && c.is_active) ?? null;

  const enable = useEnableMcp(connections);
  const switchOn = () =>
    enable.mutate(undefined, {
      onSuccess: () => {
        setConfirm(false);
        toast.success("MCP is now the AI engine", { description: "Connect your AI client with the setup below." });
      },
      onError: (err) => {
        setConfirm(false);
        toastError(err, "MCP could not be switched on");
      },
    });

  return (
    <>
      {!inUse ? (
        <Banner
          tone="review"
          title="MCP is not the engine in use yet"
          actions={
            <Button size="sm" disabled={!canManage} onClick={() => setConfirm(true)}>
              Use MCP as the AI engine
            </Button>
          }
        >
          Set up the client below at any time. Until you switch, the {apiActive ? `${aiProviderLabel(apiActive.provider)} key` : "current setting"} stays in use.
        </Banner>
      ) : null}

      <Panel>
        <PanelHeader title="Connect your AI client" description="Add this endpoint to Claude Desktop, Claude Code or another MCP client. No key is stored here." />
        <PanelBody>
          <McpEndpoint />
        </PanelBody>
      </Panel>
      <Panel>
        <PanelHeader title="Live status" description="Updates by itself while this page is open." />
        <PanelBody className="py-1">
          <McpChecklist status={status} />
        </PanelBody>
      </Panel>
      <Section title="The client's model" description="The model the client declared, its exam result and what it may do.">
        <Panel>
          <PanelBody>
            <McpEngineDetails status={status} maxAgeDays={policy.data?.max_exam_age_days} minScore={policy.data?.min_score} />
          </PanelBody>
        </Panel>
      </Section>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Use MCP as the AI engine?"
        confirmLabel="Use MCP"
        loading={enable.isPending}
        onConfirm={switchOn}
      >
        <div className="space-y-2 text-base text-ink-2">
          <p>An AI client you connect, such as Claude Code, does the reading and drafting instead of an API key.</p>
          {apiActive ? <p>The saved {aiProviderLabel(apiActive.provider)} key stays stored but is not used while MCP is the engine.</p> : null}
          <p>The client&apos;s model must pass the same qualification exam. Until it does, mail is sorted by rules only.</p>
        </div>
      </ConfirmDialog>
    </>
  );
}

/* ------------------------------------------------------------------ saved connections */

function SavedConnections({ status, connections, canManage }: { status: AiStatus; connections: ConnectionRow[]; canManage: boolean }) {
  const ai = connections.filter((c) => c.kind === "ai");
  const activate = useActivateConnection();
  const remove = useRemoveConnection();
  const [removing, setRemoving] = useState<ConnectionRow | null>(null);
  if (ai.length === 0) return null;

  const mcpChip: StatusInfo = status.mcp?.declared ? { label: "Client declared its model", tone: "brand" } : { label: "Waiting for a client", tone: "review" };
  const makeActive = (c: ConnectionRow) =>
    activate.mutate(
      { conn: c, all: connections },
      {
        onSuccess: () => toast.success(c.method === "mcp" ? "MCP is now the AI engine" : `${aiProviderLabel(c.provider)} is now the AI engine`),
        onError: (err) => toastError(err, "Could not switch the AI engine"),
      },
    );

  return (
    <Panel>
      <PanelHeader title="Saved AI connections" description="Keys and MCP clients stored on this computer. One is in use at a time." />
      <ul className="divide-y divide-line">
        {ai.map((c) =>
          c.method === "mcp" ? (
            <li key={c.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
              <div className="flex min-w-0 flex-1 items-start gap-4">
                <IconTile tone={status.mcp?.declared ? "brand" : "neutral"}>
                  <Bot />
                </IconTile>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <p className="font-semibold text-ink">MCP client</p>
                    <StatusChip info={mcpChip} size="sm" />
                    <Chip size="sm" tone={c.is_active ? "neutral" : "muted"}>
                      {c.is_active ? "In use" : "Not in use"}
                    </Chip>
                  </div>
                  <p className="text-sm text-ink-3">An AI client connects to this app and does the work. No key is stored.</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {!c.is_active ? (
                  <Button variant="secondary" size="sm" disabled={!canManage} onClick={() => makeActive(c)} className="flex-1 sm:flex-none">
                    Use this one
                  </Button>
                ) : null}
                <Button variant="quiet-danger" size="sm" icon={<Trash2 />} disabled={!canManage} onClick={() => setRemoving(c)}>
                  Remove
                </Button>
              </div>
            </li>
          ) : (
            <ConnectionRowView
              key={c.id}
              conn={c}
              icon={<Bot />}
              title={aiProviderLabel(c.provider)}
              subtitle={c.config?.model ? `Model: ${c.config.model}` : "No model chosen yet"}
              description={`API key ${c.secrets?.api_key?.set ? (c.secrets.api_key.hint ?? "stored") : "not stored"}${c.config?.base_url ? ` · ${c.config.base_url}` : ""}`}
              canManage={canManage}
              showActive
              hideIssue
              onMakeActive={() => makeActive(c)}
              onRemove={() => setRemoving(c)}
            />
          ),
        )}
      </ul>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={removing?.method === "mcp" ? "Remove the MCP connection?" : `Remove the ${removing ? aiProviderLabel(removing.provider) : ""} key?`}
        confirmLabel={removing?.method === "mcp" ? "Remove MCP connection" : "Remove key"}
        variant="danger"
        loading={remove.isPending}
        onConfirm={() =>
          removing &&
          remove.mutate(removing.id, {
            onSuccess: () => {
              toast.success(removing.method === "mcp" ? "MCP connection removed" : "Key removed");
              setRemoving(null);
            },
            onError: (err) => {
              setRemoving(null);
              toastError(err, "The connection could not be removed");
            },
          })
        }
      >
        <div className="space-y-2 text-base text-ink-2">
          {removing?.method === "mcp" ? (
            <p>The app stops treating an MCP client as its engine. The client can still call the endpoint, but its work is only accepted while MCP is the engine in use.</p>
          ) : (
            <p>The stored key is deleted from this computer. Until another engine is connected, mail is sorted by rules only and nothing is read or drafted by AI.</p>
          )}
          <p>Exams already taken stay on record. Nothing in your projects or quotations changes.</p>
        </div>
      </ConfirmDialog>
    </Panel>
  );
}

/* ------------------------------------------------------------------ page */

/** Settings › AI engine. */
export function AiEnginePage() {
  const status = useAiStatus({ poll: 5000 });
  const connections = useConnections();
  const canManage = useCanManage();
  const [view, setView] = useState<EngineMethod | null>(null);
  const method: EngineMethod = view ?? status.data?.method ?? "api";
  const headerChip: StatusInfo | null = status.data
    ? status.data.rules_only
      ? { label: "Rules only", tone: "review" }
      : modelStatusInfo("eligible")
    : null;

  return (
    <SettingsPage
      title="AI engine"
      width="full"
      meta="The AI does the reading and drafting. Every model must meet the workspace rules and pass the qualification exam first."
      status={headerChip ? <StatusChip info={headerChip} /> : null}
      actions={
        <Button asChild variant="secondary">
          <Link to="/settings/ai-rules">
            <ShieldCheck aria-hidden />
            AI quality rules
          </Link>
        </Button>
      }
    >
      <QueryState query={status}>
        {(s) => (
          <>
            <EngineBanner status={s} />
            <Panel>
              <PanelHeader title="How the AI connects" description="Choose one. You can set up the other at any time; only one is in use." />
              <PanelBody>
                <EngineMethodChooser value={method} onChange={setView} current={s.method} />
              </PanelBody>
            </Panel>
            <QueryState query={connections}>
              {(rows) => (
                <>
                  {method === "api" ? <ApiView status={s} connections={rows} /> : <McpView status={s} connections={rows} />}
                  <SavedConnections status={s} connections={rows} canManage={canManage} />
                </>
              )}
            </QueryState>
          </>
        )}
      </QueryState>
    </SettingsPage>
  );
}
