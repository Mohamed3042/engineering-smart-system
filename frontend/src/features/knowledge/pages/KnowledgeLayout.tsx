import { Sparkles } from "lucide-react";
import { useState } from "react";
import { Outlet } from "react-router";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { Banner, Button, LinkTabs } from "@/ui";
import { useKnowledge } from "../api";
import { LearnDialog } from "../components/LearnDialog";

const TABS = [
  { path: "service-families", kind: "service_family", label: "Service families" },
  { path: "work-types", kind: "work_type", label: "Work types" },
  { path: "terms", kind: "term", label: "Terms" },
  { path: "standards", kind: "standard", label: "Standards" },
  { path: "conventions", kind: "convention", label: "Conventions" },
];

/** Settings › Business knowledge: what the company does, in its own words, with the proof under each finding. */
export function KnowledgeLayout() {
  const knowledge = useKnowledge();
  const [learn, setLearn] = useState(false);
  const counts = knowledge.data?.counts;
  const waiting = (knowledge.data?.items ?? []).filter((i) => i.status === "suggested" && i.kind !== "identity").length;

  return (
    <SettingsPage
      title="Business knowledge"
      width="full"
      meta="What your company does, in your own words. Findings come from your mail and documents; none counts as fact until you confirm it."
      actions={
        <Button variant="secondary" icon={<Sparkles />} onClick={() => setLearn(true)}>
          Learn from files and mail
        </Button>
      }
    >
      {waiting > 0 ? (
        <Banner tone="review" title={waiting === 1 ? "1 finding waits for your decision" : `${waiting} findings wait for your decision`}>
          Confirm or reject each one. Confirming a finding does not change how mail is sorted; that is a separate choice.
        </Banner>
      ) : null}
      <div className="space-y-5">
        <LinkTabs
          label="Business knowledge"
          tabs={TABS.map((t) => ({ to: `/settings/knowledge/${t.path}`, label: t.label, count: counts ? (counts[t.kind] ?? 0) : undefined }))}
        />
        <Outlet context={{ openLearn: () => setLearn(true) }} />
      </div>
      <LearnDialog open={learn} onOpenChange={setLearn} />
    </SettingsPage>
  );
}
