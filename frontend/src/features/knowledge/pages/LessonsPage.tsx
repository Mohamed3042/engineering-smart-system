import { ArrowRight, GraduationCap, Minus, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useCategoryLabel } from "@/api/session";
import type { Lesson } from "@/api/types";
import { MANAGE_HINT, useCanManage } from "@/features/connections/api";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { formatDate, formatRelative } from "@/lib/format";
import { Button, Chip, ConfirmDialog, EmptyState, FilterChips, Panel, PanelHeader, QueryState, Switch, toast, toastError } from "@/ui";
import { useDeleteLesson, useLessons, useUpdateLesson } from "../api";
import { lessonLines, lessonScope, type ChangeLine } from "../lessons";
import { lessonKindInfo, LESSON_KINDS } from "../model";

function Lines({ lines }: { lines: ChangeLine[] }) {
  if (lines.length === 0) return null;
  return (
    <ul className="space-y-1.5 text-sm text-ink-2">
      {lines.map((line, i) => {
        if (line.type === "move") {
          return (
            <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              {line.label ? <span className="text-ink-3">{line.label}</span> : null}
              <span className="rounded bg-sunken px-1.5 py-0.5 text-ink-2" dir="auto">
                {line.from}
              </span>
              <ArrowRight className="size-4 shrink-0 text-ink-3" aria-label="changed to" />
              <span className="rounded bg-brand-soft px-1.5 py-0.5 font-medium text-brand-ink" dir="auto">
                {line.to}
              </span>
            </li>
          );
        }
        if (line.type === "note") {
          return (
            <li key={i} className="rounded-md border border-line bg-sunken px-3 py-2 text-ink-2" dir="auto">
              “{line.text}”
            </li>
          );
        }
        const added = line.type === "added";
        return (
          <li key={i}>
            <p className="font-medium text-ink">{line.label}</p>
            <ul className="mt-0.5 space-y-0.5">
              {line.items.map((item) => (
                <li key={item} className="flex gap-2" dir="auto">
                  {added ? <Plus className="mt-0.5 size-4 shrink-0 text-brand" aria-label="Added" /> : <Minus className="mt-0.5 size-4 shrink-0 text-block" aria-label="Removed" />}
                  <span className="min-w-0 break-words">{item}</span>
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}

function LessonRow({ lesson, canManage, onDelete }: { lesson: Lesson; canManage: boolean; onDelete: (l: Lesson) => void }) {
  const categoryLabel = useCategoryLabel();
  const update = useUpdateLesson();
  const info = lessonKindInfo(lesson.kind);
  const lines = lessonLines(lesson, categoryLabel);
  const who = lesson.created_by || "Unknown";

  return (
    <li className="px-5 py-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Chip size="sm" tone="neutral">
              {info.label}
            </Chip>
            <span className="text-sm text-ink-3">{lessonScope(lesson, categoryLabel)}</span>
            {!lesson.active ? (
              <Chip size="sm" tone="muted">
                Switched off
              </Chip>
            ) : null}
          </div>
          <p className="break-words font-medium text-ink" dir="auto">
            {lesson.subject || info.label}
          </p>
          <Lines lines={lines} />
          <p className="text-sm text-ink-3">
            Seen {lesson.count === 1 ? "once" : `${lesson.count} times`} · by {who} · last {formatRelative(lesson.last_seen_at).toLowerCase()}
            <span className="sr-only"> (first {formatDate(lesson.created_at)})</span>
          </p>
        </div>
        <div className="flex items-center justify-between gap-4 sm:w-44 sm:shrink-0 sm:flex-col sm:items-stretch sm:justify-start">
          <Switch
            label="Use this lesson"
            checked={lesson.active}
            disabled={!canManage || update.isPending}
            onChange={(active) =>
              update.mutate(
                { id: lesson.id, patch: { active } },
                {
                  onSuccess: () => toast.success(active ? "Lesson switched on" : "Lesson switched off", { description: lesson.subject || info.label }),
                  onError: (err) => toastError(err, "The lesson could not be changed"),
                },
              )
            }
          />
          <Button variant="quiet-danger" size="sm" icon={<Trash2 />} disabled={!canManage} onClick={() => onDelete(lesson)} title={canManage ? undefined : MANAGE_HINT}>
            Delete
          </Button>
        </div>
      </div>
    </li>
  );
}

/** Settings › Learned corrections: what the system remembers from people's corrections. */
export function LessonsPage() {
  const lessons = useLessons({});
  const canManage = useCanManage();
  const remove = useDeleteLesson();
  const categoryLabel = useCategoryLabel();
  const [kinds, setKinds] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<Lesson | null>(null);

  const visible = useMemo(() => {
    const items = lessons.data?.items ?? [];
    return kinds.length ? items.filter((l) => kinds.includes(l.kind)) : items;
  }, [lessons.data, kinds]);
  const summary = lessons.data?.summary;
  const present = Object.entries(summary?.by_kind ?? {})
    .filter(([, n]) => n > 0)
    .map(([k, n]) => ({ value: k, label: lessonKindInfo(k).many, count: n }))
    .sort((a, b) => LESSON_KINDS.findIndex((x) => x.key === a.value) - LESSON_KINDS.findIndex((x) => x.key === b.value));
  const single = kinds.length === 1 ? lessonKindInfo(kinds[0]) : null;

  return (
    <SettingsPage
      title="Learned corrections"
      meta={
        summary
          ? `${summary.total} ${summary.total === 1 ? "lesson" : "lessons"}, ${summary.active} in use. The system learns from what your team corrects.`
          : "The system learns from what your team corrects: mail categories, templates, draft lines and engineer notes."
      }
    >
      <Panel>
        <PanelHeader
          title="What it remembers"
          description="Switch a lesson off to stop using it. Delete it to forget it. Neither changes mail, projects or quotations that already exist."
        />
        {present.length > 1 ? (
          <div className="space-y-2 border-b border-line px-5 py-3">
            <FilterChips label="Kind of correction" value={kinds} onChange={setKinds} options={present} />
            {single?.hint ? <p className="text-sm text-ink-3">{single.hint}</p> : null}
          </div>
        ) : null}
        <QueryState
          query={lessons}
          isEmpty={(d) => d.items.length === 0}
          empty={
            <EmptyState icon={<GraduationCap />} title="Nothing learned yet">
              When your team moves a message to another category, picks a different template, edits lines in an AI draft or leaves a review note, the system remembers it here.
              You can then switch each lesson off or delete it.
            </EmptyState>
          }
        >
          {() =>
            visible.length === 0 ? (
              <EmptyState compact title="No lesson of this kind">
                Clear the filter to see all lessons.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-line" aria-label="Learned corrections">
                {visible.map((l) => (
                  <LessonRow key={l.id} lesson={l} canManage={canManage} onDelete={setDeleting} />
                ))}
              </ul>
            )
          }
        </QueryState>
        {!canManage ? <p className="border-t border-line px-5 py-3 text-sm text-ink-3">{MANAGE_HINT}</p> : null}
      </Panel>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this lesson?"
        confirmLabel="Delete lesson"
        variant="danger"
        loading={remove.isPending}
        onConfirm={() =>
          deleting &&
          remove.mutate(deleting.id, {
            onSuccess: () => {
              toast.success("Lesson deleted");
              setDeleting(null);
            },
            onError: (err) => {
              setDeleting(null);
              toastError(err, "The lesson could not be deleted");
            },
          })
        }
      >
        {deleting ? (
          <div className="space-y-3 text-base text-ink-2">
            <div className="rounded-lg border border-line bg-sunken px-3 py-2.5">
              <p className="font-medium text-ink" dir="auto">
                {deleting.subject || lessonKindInfo(deleting.kind).label}
              </p>
              <p className="text-sm text-ink-3">
                {lessonKindInfo(deleting.kind).label} · {lessonScope(deleting, categoryLabel)} · seen {deleting.count === 1 ? "once" : `${deleting.count} times`}
              </p>
            </div>
            <p>The system forgets it. Mail categories, templates and drafts it already changed stay as they are.</p>
            <p>If people make the same correction again, it is learned again. This cannot be undone. To keep it but stop using it, switch it off instead.</p>
          </div>
        ) : null}
      </ConfirmDialog>
    </SettingsPage>
  );
}
