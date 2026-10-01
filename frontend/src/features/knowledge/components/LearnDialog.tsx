import { useWorkspace } from "@/api/session";
import { useAiStatus, useCanManage } from "@/features/connections/api";
import { Banner, Button, Dialog, Panel, PanelHeader } from "@/ui";
import { knowledgeSources, useLearningProgress } from "../api";
import { DiscoveryProgress } from "./DiscoveryProgress";
import { LearningSources } from "./LearningSources";

function LearnBody({ onClose }: { onClose: () => void }) {
  const canManage = useCanManage();
  const workspace = useWorkspace();
  const progress = useLearningProgress();
  const ai = useAiStatus();
  const sources = knowledgeSources(workspace);
  return (
    <div className="space-y-6">
      {ai.data?.rules_only ? (
        <Banner tone="review" title="No eligible AI model is connected">
          Learning still runs, with rules only. Expect fewer and simpler findings. Connect an engine under AI engine in Settings for fuller results.
        </Banner>
      ) : null}
      <Panel>
        <PanelHeader
          title="Where it reads"
          description="Mail already in this workspace is always read. Add folders with old quotations, catalogues and company profiles: they count most."
        />
        <LearningSources canEdit={canManage} />
      </Panel>
      <DiscoveryProgress
        progress={progress}
        folders={sources.folders}
        web={sources.web}
        canRun={canManage}
        doneAction={<Button onClick={onClose}>Review findings</Button>}
      />
    </div>
  );
}

/** Business learning in a dialog: choose where it reads, run it, watch it, then review what it found. */
export function LearnDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Learn from files and mail"
      description="The app reads your mail and company folders and suggests what your company does. Nothing counts as fact until you confirm it."
      size="xl"
    >
      <LearnBody onClose={() => onOpenChange(false)} />
    </Dialog>
  );
}
