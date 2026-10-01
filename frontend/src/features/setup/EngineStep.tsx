import { useState } from "react";
import { useSetupNav } from "@/app/setup";
import { ApiKeyForm } from "@/features/connections/components/ApiKeyForm";
import { EngineMethodChooser, type EngineMethod } from "@/features/connections/components/EngineMethodChooser";
import { McpChecklist, McpEndpoint } from "@/features/connections/components/McpPanel";
import { useAiStatus, useConnections, useEnableMcp } from "@/features/connections/api";
import { aiProviderLabel } from "@/features/connections/vocab";
import { Banner, ConfirmDialog, Panel, PanelBody, PanelHeader, QueryState, toast, toastError } from "@/ui";
import { StepHeader, StepNav } from "./StepFrame";

/** Step 2: how the AI engine connects. A key is saved and tested; MCP shows what the AI client needs to do. */
export function EngineStep() {
  const nav = useSetupNav();
  const connections = useConnections();
  const status = useAiStatus({ poll: 5000 });
  const enable = useEnableMcp(connections.data ?? []);
  const [view, setView] = useState<EngineMethod | null>(null);
  const [confirm, setConfirm] = useState(false);
  const method: EngineMethod = view ?? status.data?.method ?? "api";
  const api = status.data?.api ?? null;
  const apiReady = api?.status === "connected";

  async function switchToMcpAndGo() {
    try {
      await enable.mutateAsync();
    } catch (err) {
      setConfirm(false);
      toastError(err, "MCP could not be switched on");
      return;
    }
    setConfirm(false);
    await nav.next();
  }

  async function carryOn() {
    if (method === "mcp" && status.data?.method === "api") {
      // an API key is in use: switching to MCP stops it, so ask first
      setConfirm(true);
      return;
    }
    if (method === "mcp" && status.data?.method !== "mcp") return switchToMcpAndGo();
    await nav.next();
  }

  return (
    <>
      <StepHeader
        title="Connect the AI engine"
        description="The AI reads requests and files and drafts quotations. An engineer reviews everything before anything is sent."
      />
      <div className="space-y-6">
        <EngineMethodChooser value={method} onChange={setView} current={status.data?.method} />

        {method === "api" ? (
          <Panel>
            <PanelHeader title="API key" description="Your own key. The app calls the model directly; the key is stored encrypted on this computer." />
            <PanelBody>
              <QueryState query={connections} compact>
                {(rows) => (
                  <ApiKeyForm
                    connections={rows}
                    autoFocus
                    onConnected={(conn, res) =>
                      toast.success(`${aiProviderLabel(conn.provider)} key works`, {
                        description: typeof res.models === "number" ? `It can use ${res.models} models. Next you choose one.` : "Next you choose a model.",
                      })
                    }
                  />
                )}
              </QueryState>
            </PanelBody>
          </Panel>
        ) : (
          <>
            <Panel>
              <PanelHeader title="Connect your AI client" description="Add this endpoint to Claude Desktop, Claude Code or another MCP client." />
              <PanelBody>
                <McpEndpoint />
              </PanelBody>
            </Panel>
            <Panel>
              <PanelHeader title="Live status" description="Updates by itself. You do not have to wait for it: the client can finish later." />
              <PanelBody className="py-1">
                <McpChecklist status={status.data} />
              </PanelBody>
            </Panel>
          </>
        )}

        {apiReady && method === "api" ? (
          <Banner tone="brand" title={`${aiProviderLabel(api?.provider)} is connected`}>
            Next you choose a model that passes the workspace rules.
          </Banner>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Use MCP instead of the API key?"
        confirmLabel="Use MCP"
        loading={enable.isPending}
        onConfirm={() => void switchToMcpAndGo()}
      >
        <div className="space-y-2 text-base text-ink-2">
          <p>
            An AI client you connect does the reading and drafting instead of the {aiProviderLabel(api?.provider)} key. The key stays stored but is not used
            while MCP is the engine.
          </p>
          <p>The client&apos;s model must pass the same qualification exam. Until it does, mail is sorted by rules only.</p>
        </div>
      </ConfirmDialog>

      <StepNav
        onContinue={carryOn}
        loading={enable.isPending}
        continueDisabled={method === "api" && !apiReady}
        reason="Save and test the key first, or skip."
        skip="Skip for now"
        onSkip={() => nav.goTo("mail")}
        skipHint="Without an AI engine, mail is sorted by rules only."
      />
    </>
  );
}
