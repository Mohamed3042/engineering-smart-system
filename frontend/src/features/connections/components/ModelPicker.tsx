import { Ban, CircleDashed, CircleX, FlaskConical, RefreshCw } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { modelStatusInfo } from "@/lib/labels";
import { cn } from "@/lib/cn";
import {
  Button,
  Chip,
  CollapsibleSection,
  Drawer,
  EmptyState,
  ErrorState,
  Panel,
  SearchInput,
  Segmented,
  Skeleton,
  StatusChip,
  toast,
  toastError,
} from "@/ui";
import { MANAGE_HINT, useAiModels, useAiPolicy, useCanManage, useRefreshModels } from "../api";
import { examKey, useExamRuns, useExamWatcher } from "../exam";
import type { ModelItem } from "../types";
import { aiProviderLabel, capabilitySummary, cleanReason, splitReasons, tierLabel } from "../vocab";
import { useIsDesktop } from "./bits";
import { ModelDetails, sortingOnly } from "./ModelDetails";

const GROUPS: { status: string; title: string; text: string }[] = [
  { status: "eligible", title: "Eligible", text: "Passed the workspace rules and the qualification exam. Can be selected." },
  {
    status: "needs_evaluation",
    title: "Needs qualification exam",
    text: "Allowed by the rules, but not examined here in the last 30 days. Run the exam before it can be selected.",
  },
  { status: "failed_evaluation", title: "Failed exam", text: "Took the exam and did not pass. Cannot be selected." },
  {
    status: "refused",
    title: "Refused",
    text: "Light, deprecated or unsafe models. They cannot be selected or examined, through the API or MCP.",
  },
];

const PREVIEW = 8;

function Indicator({ m, inUse }: { m: ModelItem; inUse: boolean }) {
  if (m.status === "eligible") {
    return (
      <span
        aria-hidden
        className={cn(
          "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border",
          inUse ? "border-brand bg-brand" : "border-line-strong bg-surface",
        )}
      >
        <span className={cn("size-2 rounded-full bg-white", inUse ? "opacity-100" : "opacity-0")} />
      </span>
    );
  }
  const Icon = m.status === "refused" ? Ban : m.status === "failed_evaluation" ? CircleX : CircleDashed;
  return <Icon aria-hidden className={cn("mt-0.5 size-5 shrink-0", m.status === "failed_evaluation" ? "text-block" : "text-ink-3")} />;
}

function ModelRow({ m, active, inUse, running, onOpen }: { m: ModelItem; active: boolean; inUse: boolean; running: boolean; onOpen: () => void }) {
  const refused = m.status === "refused";
  const reason = refused ? splitReasons(m.reasons).general[0] : null;
  const caps = capabilitySummary(m.capabilities ?? {});
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? "true" : undefined}
        className={cn(
          "flex w-full gap-3 rounded-lg px-3 py-3 text-left transition-colors",
          active ? "bg-brand-soft/70 ring-1 ring-brand-line" : "hover:bg-hover",
        )}
      >
        <Indicator m={m} inUse={inUse} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn("font-medium", refused ? "text-ink-2" : "text-ink")}>{m.display_name || m.model_id}</span>
            {inUse ? (
              <Chip size="sm" tone="brand">
                In use
              </Chip>
            ) : null}
            {sortingOnly(m) ? (
              <Chip size="sm" tone="neutral">
                Mail sorting only
              </Chip>
            ) : null}
          </span>
          <span className="mt-0.5 block break-all text-sm text-ink-3">
            <span className="font-mono text-xs">{m.model_id}</span> · {tierLabel(m.tier)}
            {caps.length ? ` · ${caps.join(" · ")}` : ""}
          </span>
          {reason ? <span className="mt-0.5 block text-sm text-ink-3">{cleanReason(reason)}</span> : null}
        </span>
        <span className="shrink-0">
          {running ? (
            <Chip size="sm" tone="neutral" icon={<FlaskConical aria-hidden />}>
              Exam running
            </Chip>
          ) : (
            <StatusChip info={modelStatusInfo(m.status)} size="sm" />
          )}
        </span>
      </button>
    </li>
  );
}

function Group({ title, text, count, children, collapsed }: { title: string; text: string; count: number; children: ReactNode; collapsed?: boolean }) {
  if (collapsed) {
    return (
      <CollapsibleSection title={`${title} (${count})`} summary={text}>
        {children}
      </CollapsibleSection>
    );
  }
  return (
    <section>
      <div className="px-3 pb-1">
        <h3 className="text-base font-semibold text-ink">
          {title} <span className="font-normal text-ink-3 tabular">({count})</span>
        </h3>
        <p className="text-sm text-ink-3">{text}</p>
      </div>
      {children}
    </section>
  );
}

/**
 * The model catalogue grouped by eligibility (state 05). Only eligible models can be chosen;
 * refused ones stay visible, greyed, with the reason.
 */
export function ModelPicker({
  connectionId,
  provider,
  onSelected,
  readOnlyNote,
  highlight,
}: {
  /** Active API connection (enables exam and selection). */
  connectionId: string | null;
  /** Provider to list; omitted: the backend's default (the API provider, else all). */
  provider?: string | null;
  onSelected?: (m: ModelItem) => void;
  readOnlyNote?: string;
  /** Mark a model as in use (e.g. the one an MCP client declared). */
  highlight?: { provider: string; model_id: string } | null;
}) {
  const runs = useExamRuns();
  const running = Object.keys(runs).length > 0;
  const models = useAiModels(provider ?? null, { poll: running ? 4000 : false });
  const policy = useAiPolicy();
  const refresh = useRefreshModels();
  const canManage = useCanManage();
  const isDesktop = useIsDesktop();
  useExamWatcher(models.data?.items);

  const [query, setQuery] = useState("");
  const [prov, setProv] = useState("all");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const items = useMemo(() => models.data?.items ?? [], [models.data]);
  const providers = useMemo(() => [...new Set(items.map((m) => m.provider))], [items]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(
      (m) =>
        (prov === "all" || m.provider === prov) &&
        (!q || m.model_id.toLowerCase().includes(q) || (m.display_name ?? "").toLowerCase().includes(q)),
    );
  }, [items, query, prov]);

  const isInUse = (m: ModelItem) =>
    highlight ? highlight.provider === m.provider && highlight.model_id === m.model_id : m.is_selected;
  const keyOf = (m: ModelItem) => examKey(m.provider, m.model_id);
  const defaultModel = items.find(isInUse) ?? items.find((m) => m.status === "eligible") ?? items[0];
  const current = items.find((m) => keyOf(m) === openKey) ?? defaultModel ?? null;

  if (models.isLoading) {
    return (
      <div className="space-y-3" role="status" aria-label="Loading models">
        <Skeleton className="h-10 w-full max-w-sm" />
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex gap-3 px-3 py-3">
            <Skeleton className="size-5 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
            <Skeleton className="h-6 w-24" />
          </div>
        ))}
      </div>
    );
  }
  if (models.isError) return <ErrorState error={models.error} onRetry={() => models.refetch()} />;

  const doRefresh = connectionId
    ? () =>
        refresh.mutate(connectionId, {
          onSuccess: (r) => toast.success("Model list refreshed", { description: `${r.models} models offered by your key, ${r.eligible} eligible.` }),
          onError: (err) => toastError(err, "The model list could not be refreshed"),
        })
    : null;

  if (!items.length) {
    return (
      <EmptyState
        compact
        title="No models listed yet"
        action={
          doRefresh ? (
            <Button variant="secondary" icon={<RefreshCw aria-hidden />} loading={refresh.isPending} disabled={!canManage} onClick={doRefresh}>
              Get models from the provider
            </Button>
          ) : null
        }
      >
        The list fills after the provider connection passes its test. Every model is then checked against the workspace rules.
      </EmptyState>
    );
  }

  const counts = Object.fromEntries(GROUPS.map((g) => [g.status, filtered.filter((m) => m.status === g.status).length]));
  const open = (m: ModelItem) => {
    setOpenKey(keyOf(m));
    if (!isDesktop) setDrawerOpen(true);
  };

  const details = current ? (
    <ModelDetails
      key={keyOf(current)}
      model={current}
      connectionId={connectionId}
      inUse={isInUse(current)}
      maxAgeDays={policy.data?.max_exam_age_days}
      minScore={policy.data?.min_score}
      onSelected={onSelected}
      readOnlyNote={readOnlyNote}
      hideHeader={!isDesktop}
    />
  ) : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <SearchInput value={query} onChange={setQuery} placeholder="Find a model" label="Find a model" className="sm:w-72" />
        {providers.length > 1 ? (
          <Segmented
            label="Provider"
            value={prov}
            onChange={setProv}
            options={[{ value: "all", label: "All" }, ...providers.map((p) => ({ value: p, label: aiProviderLabel(p) }))]}
          />
        ) : null}
        {doRefresh ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw aria-hidden />}
            loading={refresh.isPending}
            disabled={!canManage}
            title={canManage ? undefined : MANAGE_HINT}
            onClick={doRefresh}
            className="sm:ml-auto"
          >
            Refresh list
          </Button>
        ) : null}
      </div>
      <p className="text-sm text-ink-3 tabular">
        {counts.eligible} eligible · {counts.needs_evaluation} need the exam · {counts.failed_evaluation} failed · {counts.refused} refused
      </p>

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(340px,400px)] lg:items-start lg:gap-6">
        <div className="min-w-0 space-y-5">
          {filtered.length === 0 ? (
            <EmptyState compact title="No model matches">
              Try another name or provider.
            </EmptyState>
          ) : null}
          {GROUPS.map((g) => {
            const rows = filtered.filter((m) => m.status === g.status);
            if (!rows.length) return null;
            const limited = g.status === "needs_evaluation" && !showAll && !query && rows.length > PREVIEW + 2;
            const visible = limited ? rows.slice(0, PREVIEW) : rows;
            return (
              <Group key={g.status} title={g.title} text={g.text} count={rows.length} collapsed={g.status === "refused" && !query}>
                <ul className={cn("space-y-0.5", g.status === "refused" && !query && "-mx-3")} aria-label={g.title}>
                  {visible.map((m) => (
                    <ModelRow
                      key={keyOf(m)}
                      m={m}
                      active={isDesktop && current !== null && keyOf(current) === keyOf(m)}
                      inUse={isInUse(m)}
                      running={!!runs[keyOf(m)]}
                      onOpen={() => open(m)}
                    />
                  ))}
                </ul>
                {limited ? (
                  <Button variant="link" className="ml-3 mt-1" onClick={() => setShowAll(true)}>
                    Show all {rows.length}
                  </Button>
                ) : null}
              </Group>
            );
          })}
        </div>
        {isDesktop && details ? (
          <Panel className="sticky top-6 max-h-[calc(100dvh-3rem)] overflow-y-auto">
            <div className="px-5 py-5">{details}</div>
          </Panel>
        ) : null}
      </div>

      {!isDesktop && current ? (
        <Drawer
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          title={current.display_name || current.model_id}
          description={`${current.model_id} · ${aiProviderLabel(current.provider)} · ${tierLabel(current.tier)}`}
        >
          {details}
        </Drawer>
      ) : null}
    </div>
  );
}
