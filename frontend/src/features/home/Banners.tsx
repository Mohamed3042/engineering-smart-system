import { ChevronRight } from "lucide-react";
import { Link } from "react-router";
import { SETUP_STEPS } from "@/app/setup";
import { pluralize } from "@/lib/format";
import { nextActionHref } from "@/lib/routes";
import { Banner, Button, Panel, PanelHeader } from "@/ui";
import { approvalsWaiting, type Dashboard } from "./dashboard";

/** Shown while the setup wizard is unfinished; leads to the step the workspace stopped at. */
export function SetupBanner({ step, className }: { step: string; className?: string }) {
  const info = SETUP_STEPS.find((s) => s.key === step);
  return (
    <Banner
      className={className}
      tone="review"
      title="Finish setting up your workspace"
      actions={
        <Button asChild variant="secondary" size="sm">
          <Link to={info ? `/setup/${info.key}` : "/setup"}>
            Continue setup
            <ChevronRight aria-hidden />
          </Link>
        </Button>
      }
    >
      {info ? `Next step: ${info.label}${info.hint ? ` (${info.hint.toLowerCase()})` : ""}.` : "A few setup steps are left."}
    </Banner>
  );
}

/** Quotations and file downloads that wait for a person to decide. Hidden when nothing waits. */
export function WaitingForApproval({ data, className }: { data: Dashboard; className?: string }) {
  const { quotations, downloads } = approvalsWaiting(data);
  if (!quotations && downloads.length === 0) return null;
  const first = downloads[0];
  return (
    <Panel className={className}>
      <PanelHeader title="Waiting for approval" description="Nothing here moves until a person decides." />
      <ul className="divide-y divide-line">
        {quotations ? (
          <li className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:gap-4">
            <p className="min-w-0 flex-1 text-base text-ink">{pluralize(quotations, "quotation")} to approve</p>
            <Button asChild variant="secondary" size="sm" className="w-full sm:w-auto">
              <Link to="/quotations/approvals">Open approval queue</Link>
            </Button>
          </li>
        ) : null}
        {first ? (
          <li className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:gap-4">
            <div className="min-w-0 flex-1">
              <p className="text-base text-ink">{pluralize(downloads.length, "download")} to approve</p>
              <p className="line-clamp-2 break-words text-sm text-ink-3">
                {first.row.name}: {first.blocker.text}
                {downloads.length > 1 ? ` and ${downloads.length - 1} more` : ""}
              </p>
            </div>
            <Button asChild variant="secondary" size="sm" className="w-full sm:w-auto">
              <Link to={nextActionHref(first.row.id, { kind: "resolve_link", link_id: first.blocker.link_id })}>Review download</Link>
            </Button>
          </li>
        ) : null}
      </ul>
    </Panel>
  );
}
