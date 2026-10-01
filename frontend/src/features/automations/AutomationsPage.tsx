/**
 * Automations (mockup 36): the workflows that prepare the work. A workflow never sends anything
 * or approves engineering; steps marked "Needs approval" stop the run until a person continues it.
 */
import { Workflow } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { useCurrentUser } from "@/api/session";
import { pluralize } from "@/lib/format";
import { automationHref } from "@/lib/routes";
import { Button, EmptyState, ListRow, LoadingRows, Page, PageHeader, Panel, QueryState, RowChevron, Table, TBody, TD, TH, THead, TR } from "@/ui";
import { useAutomations, type AutomationRow } from "./api";
import { isAdmin, triggerInfo } from "./lib";
import { EnabledSwitch, gateLabels, LastRun, NeedsApproval, stop } from "./parts";

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
          {rows.map((a) => {
            const trigger = triggerInfo(a);
            return (
              <TR key={a.id} onClick={() => navigate(automationHref(a.id))}>
                <TD className="min-w-[18rem] max-w-[28rem]">
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
                <TD className="min-w-[10rem]">
                  <p className="text-ink">{trigger.label}</p>
                  {trigger.hint ? <p className="mt-0.5 text-sm text-ink-3">{trigger.hint}</p> : null}
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
            );
          })}
        </TBody>
      </Table>
    </Panel>
  );
}

function Phone({ rows, canEdit }: { rows: AutomationRow[]; canEdit: boolean }) {
  return (
    <div className="space-y-3 lg:hidden">
      {rows.map((a) => {
        const trigger = triggerInfo(a);
        return (
          <ListRow
            key={a.id}
            to={automationHref(a.id)}
            title={a.name}
            subtitle={trigger.label}
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
            <div className="mt-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
              <LastRun run={a.last_run} />
              <p className="text-sm text-ink-3 tabular">{pluralize(a.runs_count, "run")}</p>
            </div>
            <div className="mt-3">
              <NeedsApproval labels={gateLabels(a)} />
            </div>
          </ListRow>
        );
      })}
    </div>
  );
}

export function AutomationsPage() {
  const q = useAutomations();
  const canEdit = isAdmin(useCurrentUser()?.role);
  return (
    <Page>
      <PageHeader title="Automations" meta="Automation prepares the work. People approve engineering and sending." />
      {!canEdit ? <p className="mb-3 text-sm text-ink-3">Only admins can switch a workflow on or off.</p> : null}
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
            <EmptyState icon={<Workflow />} title="No workflows yet">
              A workflow lists the steps the system runs for you, such as reading new mail or drafting a quotation. New workspaces start with a
              few; they appear here once they exist.
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
