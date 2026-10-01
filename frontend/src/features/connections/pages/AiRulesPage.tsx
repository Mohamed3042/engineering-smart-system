import { Lock } from "lucide-react";
import { Link } from "react-router";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { modelStatusInfo } from "@/lib/labels";
import { Button, LoadingRows, Panel, PanelBody, PanelHeader, QueryState, StatusChip } from "@/ui";
import { useAiPolicy, useAiStatus, useCanManage } from "../api";
import { ExamExplainer } from "../components/ExamExplainer";
import { PolicyForm } from "../components/PolicyForm";
import { FLOOR } from "../policy";
import { aiProviderLabel, formatTokens, pct } from "../vocab";

/** The rules that no setting, role or API call can lower. Mirrors backend/ess/ai/policy.py. */
const FLOOR_RULES: { rule: string; value: string }[] = [
  { rule: "Exam score at least", value: pct(FLOOR.minScore) },
  { rule: "Critical failures allowed in the exam", value: String(FLOOR.maxCriticalFailures) },
  { rule: "An exam counts for at most", value: `${FLOOR.maxExamAgeDays} days` },
  { rule: "Context window at least", value: `${FLOOR.minContextTokens.toLocaleString("en-GB")} tokens (${formatTokens(FLOOR.minContextTokens)})` },
  { rule: "Structured output", value: "always required" },
  { rule: "Drawing study", value: "needs vision" },
  { rule: "Reading requests and files, drawing study, quotation drafting, business discovery and customer research", value: "frontier models only" },
  { rule: "Mail sorting", value: "frontier or standard" },
  { rule: "Light, deprecated or refused models", value: "never, for any task" },
  { rule: "An exam result", value: "must be signed by this app" },
];

function FloorPanel() {
  return (
    <Panel>
      <PanelHeader
        title="The floor"
        description="These rules are fixed in the app. Your rules below can only be stricter; a weaker value is raised back to the floor."
      />
      <PanelBody>
        <ul className="divide-y divide-line">
          {FLOOR_RULES.map((r) => (
            <li key={r.rule} className="flex items-start gap-3 py-2.5">
              <Lock className="mt-1 size-4 shrink-0 text-ink-3" aria-hidden />
              <p className="min-w-0 flex-1 text-base text-ink">
                {r.rule} <span className="font-semibold">{r.value}</span>
                <span className="sr-only">. Locked.</span>
              </p>
            </li>
          ))}
        </ul>
      </PanelBody>
    </Panel>
  );
}

function CurrentEngine() {
  const status = useAiStatus();
  const s = status.data;
  const model = s?.method === "api" ? s.api?.model : s?.mcp?.declared?.model_id;
  const provider = s?.method === "api" ? s.api?.provider : s?.mcp?.declared?.provider;
  const eligibility = s?.method === "api" ? s.api?.eligibility : s?.mcp?.eligibility;
  return (
    <Panel>
      <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-ink">Your engine today</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-ink-3">
            {status.isLoading ? (
              "Checking…"
            ) : model ? (
              <>
                <span>
                  {aiProviderLabel(provider)} · <span className="font-mono">{model}</span>
                </span>
                {eligibility ? <StatusChip info={modelStatusInfo(eligibility)} size="sm" /> : null}
              </>
            ) : (
              "No model is in use. Mail is sorted by rules only."
            )}
          </p>
        </div>
        <Button asChild variant="secondary" size="sm" className="w-full sm:w-auto">
          <Link to="/settings/ai">Open AI engine</Link>
        </Button>
      </div>
    </Panel>
  );
}

/** Settings › AI quality rules: the locked floor, the workspace's stricter rules, and the exam explained. */
export function AiRulesPage() {
  const policy = useAiPolicy();
  const canManage = useCanManage();
  return (
    <SettingsPage
      title="AI quality rules"
      meta="Which AI models may work in this workspace. You can make the rules stricter; nobody can make them looser."
    >
      <FloorPanel />
      <QueryState
        query={policy}
        loading={
          <Panel>
            <LoadingRows rows={4} />
          </Panel>
        }
      >
        {(p) => <PolicyForm policy={p} canEdit={canManage} />}
      </QueryState>
      <ExamExplainer minScore={policy.data?.min_score} maxAgeDays={policy.data?.max_exam_age_days} />
      <CurrentEngine />
    </SettingsPage>
  );
}
