import { Folder, FolderPlus, Trash2 } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { Button, EmptyState, IconButton } from "@/ui";
import { FolderPicker } from "./FolderPicker";

const lastPart = (p: string) => p.split(/[\\/]+/).filter(Boolean).pop() ?? p;

/** Chosen company folders with add (folder picker) and remove. Saving is the parent's job. */
export function FolderSources({
  folders,
  onChange,
  canEdit,
  busy,
  className,
  compact,
}: {
  folders: string[];
  onChange: (folders: string[]) => void;
  canEdit: boolean;
  busy?: boolean;
  className?: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const picker = (
    <FolderPicker
      open={open}
      onOpenChange={setOpen}
      chosen={folders}
      onChoose={(p) => onChange([...folders.filter((f) => f !== p), p])}
    />
  );

  if (folders.length === 0) {
    return (
      <div className={className}>
        <EmptyState
          compact={compact}
          icon={<Folder />}
          title="No folders yet"
          action={
            canEdit ? (
              <Button icon={<FolderPlus />} onClick={() => setOpen(true)} loading={busy}>
                Choose folder
              </Button>
            ) : null
          }
        >
          Add the folders where you keep old quotations, catalogues and company profiles. They teach the
          system what you actually deliver.
        </EmptyState>
        {picker}
      </div>
    );
  }

  return (
    <div className={className}>
      <ul className="divide-y divide-line">
        {folders.map((f) => (
          <li key={f} className={cn("flex items-center gap-3 py-3", compact ? "px-0" : "px-5")}>
            <span className="grid size-9 shrink-0 place-items-center rounded-md bg-sunken text-ink-2" aria-hidden>
              <Folder className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-ink">{lastPart(f)}</p>
              <p className="break-all font-mono text-xs text-ink-3">{f}</p>
            </div>
            {canEdit ? (
              <IconButton label={`Remove ${lastPart(f)}`} disabled={busy} onClick={() => onChange(folders.filter((x) => x !== f))}>
                <Trash2 />
              </IconButton>
            ) : null}
          </li>
        ))}
      </ul>
      {canEdit ? (
        <div className={cn("border-t border-line py-3", compact ? "px-0" : "px-5")}>
          <Button variant="secondary" size="sm" icon={<FolderPlus />} onClick={() => setOpen(true)} disabled={busy}>
            Add another folder
          </Button>
        </div>
      ) : null}
      {picker}
    </div>
  );
}
