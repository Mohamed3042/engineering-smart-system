import { Link } from "react-router";
import { useAiPolicy, useAiStatus, useConnections } from "@/features/connections/api";
import { McpChecklist, McpEngineDetails, mcpReadiness } from "@/features/connections/components/McpPanel";
import { ModelPicker } from "@/features/connections/components/ModelPicker";
import { aiProviderLabel } from "@/features/connections/vocab";
import { Banner, Button, EmptyState, Panel, PanelBody, PanelHeader, QueryState, Section } from "@/ui";
import { StepHeader, StepNav } from "./StepFrame";

/**
 * Step 3: the model. With an API key only eligible models can be selected, and the qualification exam is
 * run from here; with MCP the client's own model is examined and shown instead.
 */
export function ModelStep() {
  const status = useAiStatus({ poll: 5000 });
  const connections = useConnections();
  const policy = useAiPolicy();
  const s = status.data;

  const apiConns = (connections.data ?? []).filter((c) => c.kind === "ai" && c.method === "api");
  const shown = apiConns.find((c) => c.is_active) ?? apiConns[0] ?? null;
  const mcpMode = s?.method === "mcp";
  const apiReady = s?.api?.eligibility === "eligible";
  const mcpReady = mcpReadiness(s?.mcp).ready;
  const ready = mcpMode ? mcpReady : apiReady;

  return (
    <>
      <StepHeader
        title={mcpMode ? "Your AI client's model" : "Choose the model"}
        description="Only a model that meets the workspace rules and passed the qualification exam can do your work. Refused models stay listed with the reason."
      />
      <QueryState query={status}>
        {() =>
          mcpMode ? (
            <div className="space-y-6">
              <Panel>
                <PanelHeader title="Live status" description="The client declares its model, takes the exam, and then may do the tasks marked eligible." />
                <PanelBody className="py-1">
                  <McpChecklist status={s} />
                </PanelBody>
              </Panel>
              <Panel>
                <PanelHeader title="The client's model" />
                <PanelBody>{s ? <McpEngineDetails status={s} maxAgeDays={policy.data?.max_exam_age_days} minScore={policy.data?.min_score} /> : null}</PanelBody>
              </Panel>
            </div>
          ) : shown ? (
            <Section
              title={`${aiProviderLabel(shown.provider)} models`}
              description="Run the qualification exam on a model, then use it. The exam takes a few minutes and runs on your provider account."
            >
              <ModelPicker connectionId={shown.id} provider={shown.provider} compact />
            </Section>
          ) : (
            <Panel>
              <EmptyState
                title="No AI key yet"
                action={
                  <Button asChild variant="secondary">
                    <Link to="/setup/engine">Connect the AI engine</Link>
                  </Button>
                }
              >
                Models are listed once an API key passes its test. You can also skip this step and connect the engine later in Settings.
              </EmptyState>
            </Panel>
          )
        }
      </QueryState>
      {ready ? (
        <Banner tone="brand" className="mt-6" title={mcpMode ? "The client's model may work" : `${s?.api?.model ?? "The model"} is ready`}>
          It passed the exam. You can run it again, or choose another model, at any time in Settings.
        </Banner>
      ) : null}

      <StepNav
        continueDisabled={!ready}
        reason="Choose an eligible model, or skip."
        skip="Skip for now"
        skipHint="Without an eligible model, mail is sorted by rules only."
      />
    </>
  );
}
