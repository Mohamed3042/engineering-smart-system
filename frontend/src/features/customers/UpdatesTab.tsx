/**
 * News, new projects, tenders and awards for one customer (mockup 34). "Check now" starts a web
 * check in the background; the tab polls until the check time changes.
 */
import { Newspaper, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatRelative, pluralize } from "@/lib/format";
import { Button, EmptyState, Panel, PanelBody, Segmented, Spinner, Switch, toast, toastError } from "@/ui";
import { useCheckUpdates, useCustomer, useSetMonitoring } from "./api";
import { useCustomerContext } from "./CustomerLayout";
import { UPDATE_FILTERS } from "./lib";
import { useReadMarks } from "./readState";
import { UpdateItem } from "./UpdateItem";

const CHECK_TIMEOUT_MS = 120_000;

export function UpdatesTab() {
  const { detail } = useCustomerContext();
  const c = detail.customer;
  const [checking, setChecking] = useState<{ since: string | null; count: number } | null>(null);
  // poll the customer while a check runs (the layout already observes the same query)
  const live = useCustomer(c.id, { refetchInterval: checking ? 3000 : false });
  const data = live.data ?? detail;
  const check = useCheckUpdates(c.id);
  const monitor = useSetMonitoring(c.id);
  const { isRead, markRead, markUnread } = useReadMarks();
  const [kind, setKind] = useState("all");

  // finished: the check time moved
  useEffect(() => {
    if (!checking || (data.customer.last_checked_at ?? null) === checking.since) return;
    const found = data.updates.length - checking.count;
    setChecking(null);
    toast.success(found > 0 ? `${pluralize(found, "new item")} found` : "Check finished: nothing new", {
      description: found > 0 ? undefined : "Nothing new was published about this company since the last check.",
    });
  }, [data, checking]);

  // still running after two minutes: stop waiting here; items appear when it finishes
  useEffect(() => {
    if (!checking) return;
    const t = window.setTimeout(() => {
      setChecking(null);
      toast.info("The check is taking longer than usual", { description: "New items will appear here when it finishes." });
    }, CHECK_TIMEOUT_MS);
    return () => window.clearTimeout(t);
  }, [checking]);

  const startCheck = () =>
    check.mutate(undefined, {
      onSuccess: (r) => {
        setChecking({ since: data.customer.last_checked_at ?? null, count: data.updates.length });
        if (!r.started) toast.info("A check for this company is already running");
      },
      onError: (err) => toastError(err, "The check did not start"),
    });

  const updates = useMemo(
    () =>
      [...data.updates].sort(
        (a, b) => new Date(b.published_at ?? b.found_at).getTime() - new Date(a.published_at ?? a.found_at).getTime(),
      ),
    [data.updates],
  );
  const counts = useMemo(() => {
    const m: Record<string, number> = { all: updates.length };
    updates.forEach((u) => (m[u.kind] = (m[u.kind] ?? 0) + 1));
    return m;
  }, [updates]);
  const shown = kind === "all" ? updates : updates.filter((u) => u.kind === kind);
  const unread = updates.filter((u) => !isRead(u));

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-ink">News and updates</h2>
          <p className="text-sm text-ink-3">
            {checking ? (
              <span className="inline-flex items-center gap-2">
                <Spinner className="size-4" label="Checking" /> Checking the web for news about {c.name}…
              </span>
            ) : data.customer.last_checked_at ? (
              `Last checked ${formatRelative(data.customer.last_checked_at).toLowerCase()}`
            ) : (
              "Not checked yet"
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Switch
            checked={data.customer.monitoring}
            disabled={monitor.isPending}
            onChange={(v) =>
              monitor.mutate(v, {
                onSuccess: () => toast.success(v ? "Watching for news every week" : "News watch switched off"),
                onError: (err) => toastError(err, "The news watch was not changed"),
              })
            }
            label="Watch weekly"
          />
          <Button variant="secondary" icon={<RefreshCw />} onClick={startCheck} loading={check.isPending || !!checking}>
            {checking ? "Checking" : "Check now"}
          </Button>
        </div>
      </div>

      {updates.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<Newspaper />}
            title={data.customer.last_checked_at ? "Nothing found yet" : "No news yet"}
            action={
              checking ? null : (
                <Button icon={<RefreshCw />} onClick={startCheck} loading={check.isPending}>
                  Check now
                </Button>
              )
            }
          >
            A check searches the web for news, new projects, tenders and contract awards that name this company. Turn on Watch weekly
            to repeat it automatically.
          </EmptyState>
        </Panel>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Segmented
              label="Show"
              value={kind}
              onChange={setKind}
              options={UPDATE_FILTERS.filter((f) => f.value === "all" || counts[f.value]).map((f) => ({
                value: f.value,
                label: f.label,
                count: counts[f.value] ?? 0,
              }))}
            />
            {unread.length ? (
              <Button variant="ghost" size="sm" onClick={() => markRead(unread.map((u) => u.id))}>
                Mark all as read
              </Button>
            ) : null}
          </div>
          <Panel>
            {shown.length === 0 ? (
              <PanelBody>
                <p className="text-sm text-ink-3">Nothing of this kind yet.</p>
              </PanelBody>
            ) : (
              <ul className="divide-y divide-line">
                {shown.map((u) => (
                  <UpdateItem key={u.id} update={u} read={isRead(u)} onRead={() => markRead([u.id])} onUnread={() => markUnread(u.id)} />
                ))}
              </ul>
            )}
          </Panel>
          <p className="text-xs text-ink-3">Read marks are kept on this device.</p>
        </>
      )}
    </div>
  );
}
