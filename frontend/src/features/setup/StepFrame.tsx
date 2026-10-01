import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { stepIndex, useSetupNav } from "@/app/setup";
import { StepFooter } from "@/features/connections/components/bits";
import { Button, PageHeader, toastError } from "@/ui";

/** Title and one calm sentence for a wizard step. */
export function StepHeader({ title, description }: { title: ReactNode; description: ReactNode }) {
  return <PageHeader title={title} meta={description} className="md:mb-6" />;
}

/**
 * Back / Skip / Continue for a wizard step. Continue saves progress and moves on (useSetupNav.next); a step
 * with its own save passes `onContinue`. Skip moves on without finishing the step, and says what that costs.
 */
export function StepNav({
  onContinue,
  continueLabel = "Continue",
  continueDisabled,
  loading,
  reason,
  skip,
  onSkip,
  skipHint,
}: {
  onContinue?: () => void | Promise<void>;
  continueLabel?: string;
  continueDisabled?: boolean;
  loading?: boolean;
  /** Shown beside Continue while it is disabled: what is missing. */
  reason?: string;
  /** Label of the skip button; omit when the step cannot be skipped. */
  skip?: string;
  onSkip?: () => void;
  /** What skipping means ("Mail is sorted by rules only."). */
  skipHint?: string;
}) {
  const nav = useSetupNav();
  const first = stepIndex(nav.step) === 0;
  const busy = loading || nav.isSaving;
  // saving progress can fail (the server, or a role that may not change it): say so instead of failing silently
  const attempt = async (go: () => void | Promise<void>) => {
    try {
      await go();
    } catch (err) {
      toastError(err, "Your progress could not be saved");
    }
  };
  return (
    <>
      <StepFooter
        back={
          first ? null : (
            <Button variant="ghost" icon={<ArrowLeft />} onClick={nav.back} disabled={busy}>
              Back
            </Button>
          )
        }
        skip={
          skip ? (
            <Button variant="ghost" onClick={() => void attempt(onSkip ?? nav.next)} disabled={busy}>
              {skip}
            </Button>
          ) : null
        }
        hint={continueDisabled ? reason : undefined}
        primary={
          <Button
            size="lg"
            loading={busy}
            disabled={continueDisabled}
            onClick={() => void attempt(onContinue ?? nav.next)}
            className="w-full sm:w-auto"
          >
            {continueLabel}
          </Button>
        }
      />
      {skip && skipHint ? (
        <p className="mt-3 text-sm text-ink-3">
          <span className="font-medium text-ink-2">{skip}:</span> {skipHint}
        </p>
      ) : null}
    </>
  );
}
