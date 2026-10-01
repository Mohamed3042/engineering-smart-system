/**
 * New workflow: the editor on its own page, so a long list of steps is comfortable on a phone.
 * Creating needs the admin role. After saving, the new workflow's own page opens.
 */
import { Link, useNavigate } from "react-router";
import { useCurrentUser } from "@/api/session";
import { automationHref } from "@/lib/routes";
import { Button, EmptyState, Page, PageHeader, toast } from "@/ui";
import { isAdmin } from "./lib";
import { WorkflowEditor } from "./WorkflowEditor";

export function NewAutomationPage() {
  const navigate = useNavigate();
  const canEdit = isAdmin(useCurrentUser()?.role);
  return (
    <Page width="medium">
      <PageHeader
        back={{ to: "/automations", label: "Automations" }}
        title="New workflow"
        meta="A workflow lists the steps the system runs for you, in order. It never sends anything or approves engineering by itself."
      />
      {canEdit ? (
        <WorkflowEditor
          mode="create"
          onCancel={() => navigate("/automations")}
          onSaved={(a) => {
            toast.success(`Workflow created: ${a.name}`, { description: "Run now is available on its page." });
            navigate(automationHref(a.id));
          }}
        />
      ) : (
        <EmptyState
          title="Only admins can create workflows"
          action={
            <Button variant="secondary" asChild>
              <Link to="/automations">Back to automations</Link>
            </Button>
          }
        >
          Ask an admin to create it, or to give you the admin role.
        </EmptyState>
      )}
    </Page>
  );
}
