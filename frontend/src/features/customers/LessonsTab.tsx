/**
 * Lessons for this customer: corrections people made that concern this company, whether filed
 * under the customer itself, its mail domain or one of its senders. Each can be switched off.
 * Nothing is retrained; the system simply stops using a lesson that is off.
 */
import { GraduationCap } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router";
import { useCategoryLabel } from "@/api/session";
import type { Customer, Lesson } from "@/api/types";
import { cn } from "@/lib/cn";
import { formatDate, pluralize } from "@/lib/format";
import { Button, Chip, EmptyState, ErrorState, ListRow, LoadingRows, Panel, Switch, Table, TBody, TD, TH, THead, TR, toast, toastError } from "@/ui";
import { useLessons, useToggleLesson } from "./api";
import { useCustomerContext } from "./CustomerLayout";
import { lessonKindLabel, lessonScopeLabel, lessonValue } from "./lib";

/** Own scope, the mail domain, and senders at that domain (the backend filters by one scope at a time). */
function useCustomerLessons(c: Customer) {
  const domain = c.domain;
  const own = useLessons({ scope: "customer", scope_key: c.id });
  const dom = useLessons({ scope: "domain", scope_key: domain }, !!domain);
  const senders = useLessons({ scope: "sender" }, !!domain);
  const items = useMemo(() => {
    const all: Lesson[] = [
      ...(own.data?.items ?? []),
      ...(dom.data?.items ?? []),
      ...(senders.data?.items ?? []).filter((l) => !!domain && l.scope_key.toLowerCase().endsWith(`@${domain.toLowerCase()}`)),
    ];
    const seen = new Set<string>();
    return all
      .filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true)))
      .sort((a, b) => new Date(b.last_seen_at).getTime() - new Date(a.last_seen_at).getTime());
  }, [own.data, dom.data, senders.data, domain]);
  const queries = [own, ...(domain ? [dom, senders] : [])];
  return {
    items,
    isLoading: queries.some((q) => q.isLoading),
    error: queries.find((q) => q.isError)?.error,
    refetch: () => queries.forEach((q) => q.refetch()),
  };
}

export function LessonsTab() {
  const { detail } = useCustomerContext();
  const lessons = useCustomerLessons(detail.customer);
  const toggle = useToggleLesson();
  const catLabel = useCategoryLabel();
  const active = lessons.items.filter((l) => l.active).length;

  const setActive = (l: Lesson, on: boolean) =>
    toggle.mutate(
      { id: l.id, active: on },
      {
        onSuccess: () => toast.success(on ? "Lesson switched on" : "Lesson switched off"),
        onError: (err) => toastError(err, "The lesson was not changed"),
      },
    );

  const renderSwitch = (l: Lesson) => (
    <Switch
      checked={l.active}
      disabled={toggle.isPending && toggle.variables?.id === l.id}
      onChange={(on) => setActive(l, on)}
      className="w-44"
      label={
        <>
          {l.active ? "In use" : "Switched off"}
          <span className="sr-only"> lesson: {l.subject || lessonKindLabel(l.kind)}</span>
        </>
      }
    />
  );

  const renderChange = (l: Lesson) => {
    const fmt = l.kind === "category_correction" ? catLabel : undefined;
    const before = lessonValue(l.before, fmt);
    const after = lessonValue(l.after, fmt);
    return (
      <div className="space-y-1.5">
        {before || after ? (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {before ? (
              <Chip size="sm" tone="muted" className="max-w-[16rem]" title={before}>
                {before}
              </Chip>
            ) : null}
            {before && after ? (
              <span aria-label="changed to" className="text-ink-3">
                →
              </span>
            ) : null}
            {after ? (
              <Chip size="sm" tone="brand" className="max-w-[16rem]" title={after}>
                {after}
              </Chip>
            ) : null}
          </p>
        ) : (
          <span className="text-sm text-ink-3">No before and after recorded</span>
        )}
        {l.note ? <p className="break-words text-sm text-ink-2">“{l.note}”</p> : null}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">Lessons for this customer</h2>
          <p className="text-sm text-ink-3">
            {lessons.items.length
              ? `${pluralize(lessons.items.length, "correction")} people made · ${active} in use. A lesson that is switched off is ignored.`
              : "Corrections people made to the system’s work for this company."}
          </p>
        </div>
        <Button variant="ghost" size="sm" asChild>
          <Link to="/settings/learning">All lessons</Link>
        </Button>
      </div>

      {lessons.isLoading ? (
        <Panel>
          <LoadingRows rows={3} />
        </Panel>
      ) : lessons.error ? (
        <Panel>
          <ErrorState error={lessons.error} onRetry={lessons.refetch} />
        </Panel>
      ) : lessons.items.length === 0 ? (
        <Panel>
          <EmptyState icon={<GraduationCap />} title="Nothing learned about this company yet">
            When someone re-files a mail from this company, edits a draft or leaves a review note on one of its projects, the lesson appears
            here. You can switch each one off.
          </EmptyState>
        </Panel>
      ) : (
        <>
          <Panel className="hidden overflow-hidden lg:block">
            <Table>
              <THead>
                <tr>
                  <TH>Lesson</TH>
                  <TH>Before → after</TH>
                  <TH className="text-right">Times</TH>
                  <TH>By</TH>
                  <TH>Last seen</TH>
                  <TH>Status</TH>
                </tr>
              </THead>
              <TBody>
                {lessons.items.map((l) => (
                  <TR key={l.id} className={cn(!l.active && "text-ink-3")}>
                    <TD className="min-w-[14rem] max-w-[22rem]">
                      <p className="text-sm text-ink-3">{lessonKindLabel(l.kind)}</p>
                      <p className="break-words font-medium text-ink">{l.subject || "—"}</p>
                      <p className="text-xs text-ink-3">{lessonScopeLabel(l)}</p>
                    </TD>
                    <TD className="min-w-[14rem] max-w-[22rem]">{renderChange(l)}</TD>
                    <TD className="text-right tabular">{l.count}×</TD>
                    <TD className="text-ink-2">{l.created_by || "—"}</TD>
                    <TD className="whitespace-nowrap text-ink-2 tabular">{formatDate(l.last_seen_at)}</TD>
                    <TD>{renderSwitch(l)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Panel>

          <div className="space-y-3 lg:hidden">
            {lessons.items.map((l) => (
              <ListRow
                key={l.id}
                title={<span className="break-words">{l.subject || lessonKindLabel(l.kind)}</span>}
                subtitle={`${lessonKindLabel(l.kind)} · ${lessonScopeLabel(l)}`}
                footer={renderSwitch(l)}
                className={cn(!l.active && "opacity-80")}
              >
                {renderChange(l)}
                <p className="mt-2 text-xs text-ink-3 tabular">
                  {l.count > 1 ? `Corrected ${l.count} times` : "Corrected once"} · last {formatDate(l.last_seen_at)}
                  {l.created_by ? ` · by ${l.created_by}` : ""}
                </p>
              </ListRow>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
