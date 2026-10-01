import { ChevronRight, CircleCheck, Download, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { SETUP_STEPS } from "@/app/setup";
import { cn } from "@/lib/cn";
import { pluralize } from "@/lib/format";
import { nextActionHref } from "@/lib/routes";
import { Banner, Button, Panel, PanelHeader } from "@/ui";
import { approvalsWaiting, type Dashboard } from "./dashboard";

/** Phone version of a banner: one tappable line, so the project list stays near the top. */
export function CompactNotice({
  to,
  children,
  tone = "neutral",
  icon,
  className,
}: {
  to: string;
  children: ReactNode;
  tone?: "neutral" | "review";
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <Link
      to={to}
      className={cn(
        "flex min-h-11 items-center gap-3 rounded-lg border px-3 py-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-brand [&_svg]:size-[18px] [&_svg]:shrink-0",
        tone === "review" ? "border-review-line bg-review-soft text-review" : "border-line bg-surface text-ink",
        className,
      )}
    >
      {icon ?? (tone === "review" ? <TriangleAlert aria-hidden /> : <Info aria-hidden className="text-ink-3" />)}
      <span className="min-w-0 flex-1">{children}</span>
      <ChevronRight aria-hidden className="text-ink-3" />
    </Link>
  );
}

/** Shown while the setup wizard is unfinished; leads to the step the workspace stopped at. */
export function SetupBanner({ step, className }: { step: string; className?: string }) {
  const info = SETUP_STEPS.find((s) => s.key === step);
  return (
    <>
      <CompactNotice tone="review" to={info ? `/setup/${info.key}` : "/setup"} className={cn("lg:hidden", className)}>
        Finish setup{info ? `: ${info.label}` : ""}
      </CompactNotice>
      <SetupBannerFull info={info} className={cn("hidden lg:flex", className)} />
    </>
  );
}

function SetupBannerFull({ info, className }: { info: (typeof SETUP_STEPS)[number] | undefined; className?: string }) {
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
    <>
      <div className={cn("space-y-2 lg:hidden", className)}>
        {quotations ? (
          <CompactNotice to="/quotations/approvals" icon={<CircleCheck aria-hidden className="text-brand" />}>
            {pluralize(quotations, "quotation")} to approve
          </CompactNotice>
        ) : null}
        {first ? (
          <CompactNotice
            to={nextActionHref(first.row.id, { kind: "resolve_link", link_id: first.blocker.link_id })}
            icon={<Download aria-hidden className="text-ink-3" />}
          >
            {pluralize(downloads.length, "download")} to approve
          </CompactNotice>
        ) : null}
      </div>
      <WaitingPanel data={data} className={cn("hidden lg:block", className)} />
    </>
  );
}

function WaitingPanel({ data, className }: { data: Dashboard; className?: string }) {
  const { quotations, downloads } = approvalsWaiting(data);
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
