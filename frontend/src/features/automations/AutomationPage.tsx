/**
 * One workflow (mockup 37): how it really starts (from the server, with the reason), its ordered
 * steps with the human gates marked, "Run now", and its recent runs. An admin can edit it (name,
 * how it starts, the steps), switch it off, or delete it when it is not built in.
 */
import { Clock, History, Pencil, Play, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { isApiError } from "@/api/client";
import { useCurrentUser, useSession } from "@/api/session";
import { formatDateTime, pluralize } from "@/lib/format";
import { runHref } from "@/lib/routes";
import {
  Banner,
  Button,
  Chip,
  ConfirmDialog,
  EmptyState,
  InlineError,
  KeyValue,
  ListRow,
  LoadingRows,
  Page,
  PageHeader,
  Panel,
  PanelBody,
  PanelHeader,
  QueryState,
  RowChevron,
  Section,
  StatusChip,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  toast,
  toastError,
} from "@/ui";
import { useAutomation, useDeleteAutomation, useRunNow, useStepCatalog, type AutomationDetail, type CatalogStep, type Run } from "./api";
import { configuredTrigger, formatDuration, isAdmin, runStateInfo, runTriggerLabel, stepDoes, stepEnabled, triggerSummary } from "./lib";
import { EnabledSwitch, gateLabels, LastRun, TriggerStatusBlock } from "./parts";
import { WorkflowEditor } from "./WorkflowEditor";

/** The settings a person changed from the standard, in the catalogue's words: "Most threads per run: 200". */
function changedSettings(step: { type: string; config?: Record<string, unknown> }, catalog: CatalogStep[] | undefined): string[] {
  const defs = catalog?.find((c) => c.type === step.type)?.config ?? [];
  return defs.filter((d) => step.config?.[d.key] !== undefined && step.config[d.key] !== "").map((d) => `${d.label}: ${String(step.config?.[d.key])}`);
}

function Steps({ data }: { data: AutomationDetail }) {
  const steps = data.automation.steps;
  const catalog = useStepCatalog().data;
  return (
    <Panel>
      <PanelHeader
        title="Steps"
        description="They run in this order. A step marked Needs approval stops the run until a person continues it. Steps that are off are skipped."
      />
      {steps.length === 0 ? (
        <EmptyState compact title="This workflow has no steps">
          A run of it would finish at once.
        </EmptyState>
      ) : (
        <ol className="divide-y divide-line">
          {steps.map((s, i) => {
            const on = stepEnabled(s);
            const does = stepDoes(s.type);
            const settings = changedSettings(s, catalog);
            return (
              <li key={`${s.key}-${i}`} className="flex gap-4 px-5 py-4">
                <span
                  aria-hidden
                  className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border border-line-strong text-sm font-semibold text-ink-2 tabular"
                >
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                    <p className="font-semibold text-ink">
                      <span className="sr-only">Step {i + 1}: </span>
                      {s.label}
                    </p>
                    {s.requires_approval && on ? (
                      <Chip tone="review" size="sm" icon={<Clock aria-hidden />}>
                        Needs approval
                      </Chip>
                    ) : null}
                    {!on ? (
                      <Chip tone="muted" size="sm">
                        Off, skipped
                      </Chip>
                    ) : null}
                  </div>
                  {does ? <p className="mt-1 text-sm text-ink-2">{does}</p> : null}
                  {settings.length ? <p className="mt-1 text-sm text-ink-2">{settings.join(" · ")}</p> : null}
                  <p className="mt-1 text-xs text-ink-3">
                    Type <span className="font-mono">{s.type}</span>
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}

function Settings({ data, canEdit }: { data: AutomationDetail; canEdit: boolean }) {
  const a = data.automation;
  const session = useSession();
  const navigate = useNavigate();
  const del = useDeleteAutomation();
  const [confirm, setConfirm] = useState(false);
  const builtIn = !!data.built_in;
  const needsMail = a.trigger === "new_email" || a.steps.some((s) => s.type === "sync_mail" && stepEnabled(s));
  const noMailbox = needsMail && a.trigger !== "manual" && !!session.data && !session.data.mail;

  const remove = () =>
    del.mutate(a.id, {
      onSuccess: () => {
        toast.success(`Workflow deleted: ${a.name}`);
        setConfirm(false);
        navigate("/automations");
      },
    });

  return (
    <Panel>
      <PanelHeader title="Settings" />
      <PanelBody className="space-y-4">
        <div>
          <EnabledSwitch automation={a} canEdit={canEdit} />
          {!canEdit ? <p className="mt-1.5 text-sm text-ink-3">Only admins can switch a workflow on or off.</p> : null}
        </div>
        <KeyValue
          labelWidth="sm"
          items={[
            { label: "Set to", value: configuredTrigger(a) },
            { label: "Last run", value: <LastRun run={data.runs[0]} /> },
            { label: "Runs", value: <span className="tabular">{a.runs_count}</span> },
          ]}
        />
        {noMailbox && a.enabled ? (
          <p className="rounded-lg bg-review-soft px-3 py-2 text-sm text-review">
            No mailbox is connected, so this workflow does not start by itself.{" "}
            <Link to="/settings/connections" className="font-medium underline underline-offset-2">
              Connect the mailbox
            </Link>
          </p>
        ) : null}
        {builtIn ? (
          <p className="text-sm text-ink-3">This workflow is built in. It can be switched off but not deleted.</p>
        ) : canEdit ? (
          <Button variant="quiet-danger" icon={<Trash2 />} onClick={() => setConfirm(true)} className="w-full sm:w-auto">
            Delete workflow
          </Button>
        ) : null}
      </PanelBody>
      <ConfirmDialog
        open={confirm}
        onOpenChange={(o) => {
          setConfirm(o);
          if (!o) del.reset();
        }}
        title={`Delete ${a.name}?`}
        description="The workflow is removed for everyone in this workspace."
        confirmLabel="Delete workflow"
        variant="danger"
        loading={del.isPending}
        onConfirm={remove}
      >
        <div className="space-y-3">
          <p className="text-base text-ink-2">
            It will no longer run, and its past runs will no longer be listed here. This cannot be undone. To keep it for later, switch it off instead.
          </p>
          <InlineError error={del.error} />
        </div>
      </ConfirmDialog>
    </Panel>
  );
}

function RunsList({ runs }: { runs: Run[] }) {
  const navigate = useNavigate();
  return (
    <Section title="Recent runs" description={runs.length ? `${pluralize(runs.length, "run")}, newest first` : undefined}>
      {runs.length === 0 ? (
        <Panel>
          <EmptyState compact icon={<History />} title="No runs yet">
            Press Run now to start the first run. Every step it takes is recorded here.
          </EmptyState>
        </Panel>
      ) : (
        <>
          <Panel className="hidden overflow-hidden lg:block">
            <Table>
              <THead>
                <tr>
                  <TH>State</TH>
                  <TH>Started</TH>
                  <TH>Took</TH>
                  <TH>Started by</TH>
                  <TH>Result</TH>
                  <TH className="w-10">
                    <span className="sr-only">Open</span>
                  </TH>
                </tr>
              </THead>
              <TBody>
                {runs.map((r) => (
                  <TR key={r.id} onClick={() => navigate(runHref(r.id))}>
                    <TD>
                      <StatusChip info={runStateInfo(r.status)} size="sm" />
                    </TD>
                    <TD className="whitespace-nowrap tabular">
                      <Link to={runHref(r.id)} onClick={(e) => e.stopPropagation()} className="hover:text-brand-ink hover:underline">
                        {formatDateTime(r.started_at)}
                      </Link>
                    </TD>
                    <TD className="whitespace-nowrap text-ink-2 tabular">{formatDuration(r.started_at, r.finished_at) ?? "—"}</TD>
                    <TD className="text-ink-2">{runTriggerLabel(r.trigger)}</TD>
                    <TD className="max-w-[26rem] text-sm text-ink-2">
                      <p className={r.error ? "line-clamp-2 break-words text-block" : "line-clamp-2 break-words"}>{r.error || r.summary || "—"}</p>
                    </TD>
                    <TD className="w-10 pt-5">
                      <RowChevron />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Panel>
          <div className="space-y-3 lg:hidden">
            {runs.map((r) => (
              <ListRow
                key={r.id}
                to={runHref(r.id)}
                title={formatDateTime(r.started_at)}
                subtitle={`${runTriggerLabel(r.trigger)}${formatDuration(r.started_at, r.finished_at) ? ` · took ${formatDuration(r.started_at, r.finished_at)}` : ""}`}
                aside={<StatusChip info={runStateInfo(r.status)} size="sm" />}
              >
                {r.error || r.summary ? <p className={r.error ? "line-clamp-3 text-block" : "line-clamp-3"}>{r.error || r.summary}</p> : null}
              </ListRow>
            ))}
          </div>
        </>
      )}
    </Section>
  );
}

function Detail({ data, id }: { data: AutomationDetail; id: string }) {
  const a = data.automation;
  const navigate = useNavigate();
  const run = useRunNow(id);
  const canEdit = isAdmin(useCurrentUser()?.role);
  const [editing, setEditing] = useState(false);
  const waiting = data.runs.filter((r) => r.status === "waiting_approval");
  const gates = gateLabels(a);
  const summary = triggerSummary(a, data.trigger_status);

  const start = () =>
    run.mutate(undefined, {
      onSuccess: (r) => {
        toast.success("Run started", { description: "Follow it step by step on the next page." });
        navigate(runHref(r.run_id));
      },
      onError: (err) => toastError(err, "The run did not start"),
    });

  return (
    <>
      <PageHeader
        back={{ to: "/automations", label: "Automations" }}
        title={a.name}
        status={<StatusChip info={a.enabled ? { label: "Switched on", tone: "brand" } : { label: "Switched off", tone: "muted" }} size="md" />}
        meta={
          <>
            {a.description ? <p>{a.description}</p> : null}
            <TriggerStatusBlock summary={summary} className={a.description ? "mt-3" : undefined} />
          </>
        }
        actions={
          <>
            <Button icon={<Play />} loading={run.isPending} onClick={start}>
              Run now
            </Button>
            {canEdit && !editing ? (
              <Button variant="secondary" icon={<Pencil />} onClick={() => setEditing(true)}>
                Edit workflow
              </Button>
            ) : null}
          </>
        }
      />
      {waiting.length ? (
        <Banner
          className="mb-6"
          tone="review"
          title={waiting.length === 1 ? "A run is waiting for approval" : `${waiting.length} runs are waiting for approval`}
          actions={
            <Button asChild variant="secondary" size="sm">
              <Link to={runHref(waiting[0].id)}>Open the run</Link>
            </Button>
          }
        >
          It stopped at a step that needs a person{gates.length ? `: ${gates.join(", ")}` : ""}. Nothing moves on until someone continues it.
        </Banner>
      ) : null}
      {editing ? (
        <div className="mb-8">
          <WorkflowEditor
            mode="edit"
            automation={a}
            status={summary}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              toast.success("Workflow saved", { description: "Run now and the schedule use the new steps from the next run." });
            }}
          />
        </div>
      ) : (
        <div className="mb-8 flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
          <Steps data={data} />
          <Settings data={data} canEdit={canEdit} />
        </div>
      )}
      <RunsList runs={data.runs} />
    </>
  );
}

export function AutomationPage() {
  const { automationId = "" } = useParams();
  const q = useAutomation(automationId);

  if (q.isError && isApiError(q.error) && q.error.status === 404) {
    return (
      <Page>
        <EmptyState
          title="This workflow is not in the workspace"
          action={
            <Button variant="secondary" asChild>
              <Link to="/automations">Back to automations</Link>
            </Button>
          }
        >
          The link may be from another workspace, or the workflow was deleted.
        </EmptyState>
      </Page>
    );
  }

  return (
    <Page>
      <QueryState
        query={q}
        loading={
          <Panel>
            <LoadingRows rows={5} />
          </Panel>
        }
      >
        {(data) => <Detail data={data} id={automationId} />}
      </QueryState>
    </Page>
  );
}
