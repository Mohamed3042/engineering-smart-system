import { useCanManage } from "@/features/connections/api";
import { LearningSources } from "@/features/knowledge/components/LearningSources";
import { Panel, PanelHeader } from "@/ui";
import { StepHeader, StepNav } from "./StepFrame";

/** Step 5: the folders with old quotations and catalogues. They teach the system what the company really delivers. */
export function DocumentsStep() {
  const canManage = useCanManage();
  return (
    <>
      <StepHeader
        title="Company documents"
        description="Point the app at the folders where you keep old quotations, catalogues and company profiles. They show what you actually deliver."
      />
      <Panel>
        <PanelHeader
          title="Folders on this computer"
          description="Files are read on this computer and never changed or moved. Subfolders are included. With an AI engine connected, passages from them are sent to that provider when learning runs."
        />
        <LearningSources canEdit={canManage} />
      </Panel>
      <p className="mt-4 text-sm text-ink-3">
        Your own quotations count most as proof, then company documents, then mail you sent, then mail you received. Web pages are context only.
      </p>
      <StepNav skip="Skip for now" skipHint="Learning then reads mail only. You can add folders later in Settings, under Mailbox & services." />
    </>
  );
}
