import { useWorkspace } from "@/api/session";
import { useEffect } from "react";
import { useLocation } from "react-router";
import { useCanManage } from "@/features/connections/api";
import { Panel, PanelBody, PanelHeader } from "@/ui";
import { ExportImportPanel } from "./ExportImport";
import { QuotationDefaultsPanel } from "./QuotationDefaults";
import { SettingsPage } from "./SettingsPage";
import { WorkspaceForm } from "./WorkspaceForm";

/** Settings › Workspace: company details, quotation defaults, export and import. */
export function WorkspacePage() {
  const workspace = useWorkspace();
  const canEdit = useCanManage();
  const { hash } = useLocation();
  useEffect(() => {
    if (hash === "#quotation-defaults") document.getElementById("quotation-defaults")?.scrollIntoView({ block: "start" });
  }, [hash, workspace]);
  return (
    <SettingsPage title="Workspace" meta="Company details, regional settings and defaults for this workspace." width="narrow">
      <Panel>
        <PanelHeader title="Company" description="Used on quotations, in mail sorting and to tell your own mail from customer mail." />
        <PanelBody className="pb-5 pt-5">
          <WorkspaceForm mode="edit" workspace={workspace} canEdit={canEdit} />
        </PanelBody>
      </Panel>
      <section id="quotation-defaults" className="scroll-mt-24" aria-label="Quotation defaults">
        <QuotationDefaultsPanel workspace={workspace} canEdit={canEdit} />
      </section>
      <ExportImportPanel workspace={workspace} canEdit={canEdit} />
    </SettingsPage>
  );
}
