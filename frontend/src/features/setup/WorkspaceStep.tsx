import { useNavigate, useSearchParams } from "react-router";
import { useSetupNav } from "@/app/setup";
import { useSession } from "@/api/session";
import { useCanManage } from "@/features/connections/api";
import { WorkspaceForm } from "@/features/settings/WorkspaceForm";
import { Button, Panel, PanelBody } from "@/ui";
import { StepHeader } from "./StepFrame";

/**
 * Step 1: the company. Creates the workspace (or another one with ?new=1); with a workspace already in
 * place it edits that one, so going back never creates a duplicate.
 */
export function WorkspaceStep() {
  const session = useSession();
  const [params] = useSearchParams();
  const nav = useSetupNav();
  const navigate = useNavigate();
  const canManage = useCanManage();
  const workspace = session.data?.workspace ?? null;
  const another = params.get("new") === "1";
  const mode = !workspace || another ? "create" : "edit";

  return (
    <>
      <StepHeader
        title={mode === "create" ? "Create your workspace" : "Your company"}
        description="Every company gets its own mailbox, vocabulary, services and rules. You can change all of this later in Settings."
      />
      <Panel>
        <PanelBody className="py-5">
          <WorkspaceForm
            key={mode}
            mode={mode}
            workspace={mode === "edit" ? workspace : null}
            canEdit={mode === "create" || canManage}
            submitLabel={mode === "create" ? "Create workspace" : "Continue"}
            onSaved={() => (mode === "create" ? nav.goTo("engine") : nav.next())}
            leading={
              another && workspace ? (
                <Button variant="ghost" onClick={() => navigate("/")}>
                  Cancel
                </Button>
              ) : null
            }
          />
        </PanelBody>
      </Panel>
    </>
  );
}
