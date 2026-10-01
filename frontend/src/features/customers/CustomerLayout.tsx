/**
 * One customer: header (name, role, domain, place, website), actions and the tab bar.
 * Tabs are routes (lib/routes.ts customerHref) and read the same ["customer", id] query.
 */
import { ExternalLink, RefreshCw, Search, Users } from "lucide-react";
import { useState } from "react";
import { Link, Outlet, useNavigate, useOutletContext, useParams } from "react-router";
import { isApiError } from "@/api/client";
import { customerKindLabel } from "@/lib/labels";
import { pluralize } from "@/lib/format";
import { customerHref } from "@/lib/routes";
import { Button, EmptyState, ErrorState, LinkTabs, Page, PageHeader, Skeleton, toast, toastError } from "@/ui";
import { useCustomer, useResearchHistory, useRetag, type CustomerDetail } from "./api";
import { hostOf, locationLine, websiteHref } from "./lib";
import { ProfileChip, WatchingMark } from "./parts";
import { useReadMarks } from "./readState";
import { ResearchSetupDialog } from "./ResearchSetupDialog";

export interface CustomerContext {
  detail: CustomerDetail;
  openResearch: () => void;
  researchRunning: boolean;
}

export function useCustomerContext() {
  return useOutletContext<CustomerContext>();
}

function HeaderSkeleton() {
  return (
    <div className="mb-8 space-y-3" role="status" aria-label="Loading customer">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-9 w-80 max-w-full" />
      <Skeleton className="h-4 w-96 max-w-full" />
      <div className="flex gap-6 border-b border-line pb-3 pt-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-5 w-20" />
        ))}
      </div>
      <div className="grid gap-6 pt-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  );
}

export function CustomerLayout() {
  const { customerId = "" } = useParams();
  const navigate = useNavigate();
  const research = useResearchHistory(customerId);
  const researchRunning = !!research.data?.some((r) => r.status === "running");
  // While research runs the profile status changes when it finishes: keep the header fresh.
  const q = useCustomer(customerId, { refetchInterval: researchRunning ? 5000 : false });
  const retag = useRetag(customerId);
  const { isRead } = useReadMarks();
  const [researchOpen, setResearchOpen] = useState(false);

  if (q.isLoading) {
    return (
      <Page>
        <HeaderSkeleton />
      </Page>
    );
  }
  if (q.isError || !q.data) {
    const missing = isApiError(q.error) && q.error.status === 404;
    return (
      <Page>
        {missing ? (
          <EmptyState
            icon={<Users />}
            title="This customer is not in the workspace"
            action={
              <Button variant="secondary" asChild>
                <Link to="/customers">Back to customers</Link>
              </Button>
            }
          >
            It may have been merged or the link is from another workspace.
          </EmptyState>
        ) : (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        )}
      </Page>
    );
  }

  const detail = q.data;
  const c = detail.customer;
  const loc = locationLine(c.city, c.country);
  const site = websiteHref(c.website);
  const suggested = detail.opportunities.filter((o) => o.status === "suggested").length;
  const unread = detail.updates.filter((u) => !isRead(u)).length;
  const conf = c.kind_confidence ? `${Math.round(c.kind_confidence * 100)}% sure` : null;

  const runRetag = () =>
    retag.mutate(undefined, {
      onSuccess: (r) =>
        toast.success("Tags rebuilt", {
          description: `${pluralize(r.tags.length, "tag")} · ${pluralize(r.opportunities, "suggested service")}`,
        }),
      onError: (err) => toastError(err, "Re-tagging did not finish"),
    });

  const ctx: CustomerContext = { detail, openResearch: () => setResearchOpen(true), researchRunning };

  return (
    <Page>
      <PageHeader
        back={{ to: "/customers", label: "Customers" }}
        title={c.name}
        status={
          <span className="flex flex-wrap items-center gap-2">
            <ProfileChip status={researchRunning ? "researching" : c.profile_status} size="md" />
            {c.monitoring ? <WatchingMark className="text-sm" /> : null}
          </span>
        }
        meta={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              {customerKindLabel(c.kind || "other")}
              {conf ? <span className="text-ink-3"> ({conf})</span> : null}
            </span>
            {c.domain ? (
              <>
                <span aria-hidden>·</span>
                <span>{c.domain}</span>
              </>
            ) : null}
            {loc ? (
              <>
                <span aria-hidden>·</span>
                <span>{loc}</span>
              </>
            ) : null}
            {site ? (
              <>
                <span aria-hidden>·</span>
                <a
                  href={site}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-medium text-brand-ink hover:underline"
                >
                  {hostOf(site) || "Website"}
                  <ExternalLink className="size-3.5" aria-hidden />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              </>
            ) : null}
          </span>
        }
        actions={
          <>
            <Button variant="secondary" icon={<RefreshCw />} onClick={runRetag} loading={retag.isPending}>
              Re-tag
            </Button>
            <Button icon={<Search />} onClick={() => setResearchOpen(true)} loading={researchRunning} disabled={researchRunning}>
              {researchRunning ? "Researching" : "Research company"}
            </Button>
          </>
        }
      />
      <LinkTabs
        label="Customer sections"
        tabs={[
          { to: customerHref(c.id), label: "Profile", end: true },
          { to: customerHref(c.id, "projects"), label: "Projects", count: detail.projects.length },
          { to: customerHref(c.id, "research"), label: "Research" },
          { to: customerHref(c.id, "updates"), label: "Updates", count: unread || undefined, countTone: "brand" },
          { to: customerHref(c.id, "opportunities"), label: "Suggested services", count: suggested || undefined, countTone: "review" },
        ]}
      />
      <div className="pt-6">
        <Outlet context={ctx} />
      </div>
      <ResearchSetupDialog
        customer={c}
        open={researchOpen}
        onOpenChange={setResearchOpen}
        onStarted={() => navigate(customerHref(c.id, "research"))}
      />
    </Page>
  );
}
