/**
 * Actions for the selected rows (POST /api/emails/bulk). Every action opens a ConfirmDialog that
 * says exactly what changes. Mail is never deleted or changed in the mailbox itself.
 */
import { Archive, ArchiveRestore, Tags, X } from "lucide-react";
import { useState } from "react";
import { pluralize } from "@/lib/format";
import { Button, ConfirmDialog, Field, Select, toast, toastError } from "@/ui";
import { useBulkEmails, type BulkAction } from "./api";
import { useCategoryChoices } from "./parts";

type Dialog = "archive" | "restore" | "category" | null;

export function BulkBar({ ids, restoring, onClear }: { ids: string[]; restoring: boolean; onClear: () => void }) {
  const bulk = useBulkEmails();
  const choices = useCategoryChoices();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [category, setCategory] = useState("");
  const n = ids.length;
  const what = pluralize(n, "message");

  const run = (body: BulkAction, done: string) =>
    bulk.mutate(body, {
      onSuccess: (r) => {
        toast.success(done, { description: r.updated === n ? undefined : `${r.updated} of ${n} were found and changed.` });
        setDialog(null);
        setCategory("");
        onClear();
      },
      onError: (err) => toastError(err, "That change did not save"),
    });

  const close = (open: boolean) => {
    if (!open && !bulk.isPending) {
      setDialog(null);
      bulk.reset();
    }
  };

  return (
    <>
      <div className="sticky bottom-20 z-20 mt-4 lg:bottom-4">
        <div
          role="region"
          aria-label="Actions for selected messages"
          className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3 shadow-pop"
        >
          <p className="mr-auto px-1 font-semibold text-ink tabular">{n} selected</p>
          <Button variant="secondary" icon={<Tags />} onClick={() => setDialog("category")}>
            Change category
          </Button>
          {restoring ? (
            <Button variant="secondary" icon={<ArchiveRestore />} onClick={() => setDialog("restore")}>
              Move back to inbox
            </Button>
          ) : (
            <Button variant="secondary" icon={<Archive />} onClick={() => setDialog("archive")}>
              Archive
            </Button>
          )}
          <Button variant="ghost" icon={<X />} onClick={onClear}>
            Clear
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={dialog === "archive"}
        onOpenChange={close}
        title={`Archive ${what}?`}
        description="Archived mail leaves your open inbox."
        confirmLabel="Archive"
        loading={bulk.isPending}
        onConfirm={() => run({ ids, action: "archive" }, `${what} archived`)}
      >
        <p className="text-base text-ink-2">
          The mail stays in your mailbox and still turns up in search. To see it again, choose Archived in the filter next to the search
          box. You can move it back from there.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === "restore"}
        onOpenChange={close}
        title={`Move ${what} back to your inbox?`}
        confirmLabel="Move back"
        loading={bulk.isPending}
        onConfirm={() => run({ ids, action: "mark_reviewed" }, `${what} moved back`)}
      >
        <p className="text-base text-ink-2">Mail that belongs to a project returns as Linked to project. The rest returns as Needs review.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === "category"}
        onOpenChange={close}
        title={`Change the category of ${what}?`}
        confirmLabel="Change category"
        loading={bulk.isPending}
        disabled={!category}
        onConfirm={() => run({ ids, action: "set_category", category }, `${what} moved`)}
      >
        <div className="space-y-4">
          <Field label="New category" htmlFor="bulk-category">
            <Select
              id="bulk-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Choose a category"
              options={choices.map((c) => ({ value: c.key, label: `${c.groupLabel}: ${c.label}` }))}
            />
          </Field>
          <p className="text-sm text-ink-2">
            This files the selected mail under the new category now and teaches the system: later mail from these senders is filed
            the same way. You can switch each lesson off under Settings, Learned corrections.
          </p>
        </div>
      </ConfirmDialog>
    </>
  );
}
