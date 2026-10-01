import { useSetupNav } from "@/app/setup";
import { useSession } from "@/api/session";
import { useCanManage } from "@/features/connections/api";
import { describeScope, ScopeFields, useScope } from "@/features/knowledge/components/ScopeFields";
import { Banner, InlineError, Panel, PanelBody, PanelHeader } from "@/ui";
import { StepHeader, StepNav } from "./StepFrame";

/** Step 6: how much of the mailbox the first scan reads. */
export function ScopeStep() {
  const nav = useSetupNav();
  const scope = useScope();
  const canManage = useCanManage();
  const connected = useSession().data?.mail?.status === "connected";

  async function carryOn() {
    try {
      await scope.persist();
    } catch {
      return; // the error is shown on the page; stay here so nothing typed is lost
    }
    await nav.next();
  }

  return (
    <>
      <StepHeader
        title="What to read"
        description="Choose how far back the first scan goes. Mail is only read; nothing in the mailbox is changed. You can scan again later."
      />
      {!connected ? (
        <Banner tone="review" className="mb-6" title="No mailbox is connected yet">
          The scan needs one. You can set the scope now and connect the mailbox later in Settings, under Mailbox & services.
        </Banner>
      ) : null}
      <Panel>
        <PanelHeader title="Scan scope" description={describeScope(scope.draft)} />
        <PanelBody className="space-y-4 py-5">
          <ScopeFields draft={scope.draft} onChange={scope.setDraft} problem={scope.problem} disabled={!canManage || scope.saving} />
          <p className="text-sm text-ink-3">Mail you sent is read too: it shows what you really deliver, and counts more than mail you received.</p>
          <InlineError error={scope.error} />
        </PanelBody>
      </Panel>
      <StepNav
        onContinue={carryOn}
        continueDisabled={!!scope.problem}
        reason={scope.problem ?? undefined}
        loading={scope.saving}
        skip="Use the default"
        skipHint="The last 2 months, up to 2,000 conversations."
      />
    </>
  );
}
