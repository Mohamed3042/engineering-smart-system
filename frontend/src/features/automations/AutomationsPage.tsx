/**
 * Automations (mockup 36): the workflows that prepare the work. A workflow never sends anything
 * or approves engineering; steps marked "Needs approval" stop the run until a person continues it.
 * Each workflow says how it really starts (from the server: "Manual — Run now", "Every hour"…) and
 * why, on the desktop table and on the phone cards alike.
 */
import { Plus, Workflow } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { useCurrentUser } from "@/api/session";
import { pluralize } from "@/lib/format";
import { automationHref } from "@/lib/routes";
import { Button, EmptyState, ListRow, LoadingRows, Page, PageHeader, Panel, QueryState, RowChevron, Table, TBody, TD, TH, THead, TR } from "@/ui";
import { useAutomations, type AutomationRow } from "./api";
import { NEW_WORKFLOW_PATH, isAdmin, triggerSummary } from "./lib";
import { EnabledSwitch, gateLabels, LastRun, NeedsApproval, TriggerStatusBlock, stop } from "./parts";

function Desktop({ rows, canEdit }: { rows: AutomationRow[]; canEdit: boolean }) {
  const navigate = useNavigate();
  return (
    <Panel className="hidden overflow-hidden lg:block">
      <Table>
        <THead>
          <tr>
            <TH>Workflow</TH>
            <TH>Starts</TH>
            <TH>Last run</TH>
            <TH className="text-right">Runs</TH>
            <TH>Status</TH>
            <TH className="w-10">
              <span className="sr-only">Open</span>
            </TH>
          </tr>
        </THead>
        <TBody>
          {rows.map((a) => (
            <TR key={a.id} onClick={() => navigate(automationHref(a.id))}>
              <TD className="min-w-[15rem] max-w-[24rem]">
                <Link
                  to={automationHref(a.id)}
                  onClick={stop}
                  className="font-semibold text-ink outline-none hover:text-brand-ink hover:underline focus-visible:ring-2 focus-visible:ring-brand"
                >
                  {a.name}
                </Link>
                {a.description ? <p className="mt-0.5 line-clamp-2 text-sm text-ink-3">{a.description}</p> : null}
                <div className="mt-2">
                  <NeedsApproval labels={gateLabels(a)} />
                </div>
              </TD>
              <TD className="min-w-[16rem] max-w-[22rem]">
                <TriggerStatusBlock summary={triggerSummary(a, a.trigger_status)} />
              </TD>
              <TD>
                <LastRun run={a.last_run} />
              </TD>
              <TD className="text-right tabular">{a.runs_count}</TD>
              <TD onClick={stop}>
                <EnabledSwitch automation={a} canEdit={canEdit} className="w-40" />
              </TD>
              <TD className="pt-5">
                <RowChevron />
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </Panel>
  );
}

function Phone({ rows, canEdit }: { rows: AutomationRow[]; canEdit: boolean }) {
  return (
    <div className="space-y-3 lg:hidden">
      {rows.map((a) => (
        <ListRow
          key={a.id}
          to={automationHref(a.id)}
          title={a.name}
          footer={
            <div className="flex items-center justify-between gap-3">
              <EnabledSwitch automation={a} canEdit={canEdit} />
              <Button asChild variant="secondary" size="sm">
                <Link to={automationHref(a.id)}>Open workflow</Link>
              </Button>
            </div>
          }
        >
          {a.description ? <p className="line-clamp-3">{a.description}</p> : null}
          <TriggerStatusBlock summary={triggerSummary(a, a.trigger_status)} className="mt-3" />
          <div className="mt-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <LastRun run={a.last_run} />
            <p className="text-sm text-ink-3 tabular">{pluralize(a.runs_count, "run")}</p>
          </div>
          <div className="mt-3">
            <NeedsApproval labels={gateLabels(a)} />
          </div>
        </ListRow>
      ))}
    </div>
  );
}

export function AutomationsPage() {
  const q = useAutomations();
  const canEdit = isAdmin(useCurrentUser()?.role);
  const newWorkflow = canEdit ? (
    <Button asChild icon={<Plus />}>
      <Link to={NEW_WORKFLOW_PATH}>New workflow</Link>
    </Button>
  ) : (
    <Button icon={<Plus />} disabled title="Only admins can create workflows">
      New workflow
    </Button>
  );
  return (
    <Page>
      <PageHeader title="Automations" meta="Automation prepares the work. People approve engineering and sending." actions={newWorkflow} />
      {!canEdit ? <p className="mb-3 text-sm text-ink-3">Only admins can create, edit or switch off workflows.</p> : null}
      <QueryState
        query={q}
        loading={
          <Panel>
            <LoadingRows rows={4} />
          </Panel>
        }
        isEmpty={(rows) => rows.length === 0}
        empty={
          <Panel>
            <EmptyState icon={<Workflow />} title="No workflows yet" action={canEdit ? <Button asChild icon={<Plus />}><Link to={NEW_WORKFLOW_PATH}>New workflow</Link></Button> : undefined}>
              A workflow lists the steps the system runs for you, such as reading new mail or drafting a quotation. Build one from the steps
              the system offers.
            </EmptyState>
          </Panel>
        }
      >
        {(rows) => (
          <>
            <Desktop rows={rows} canEdit={canEdit} />
            <Phone rows={rows} canEdit={canEdit} />
          </>
        )}
      </QueryState>
    </Page>
  );
}
