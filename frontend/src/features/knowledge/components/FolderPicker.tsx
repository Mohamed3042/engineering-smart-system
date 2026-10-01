/**
 * Company folder picker (mockup 65). Browses folders on this computer through GET /api/local-folders,
 * which returns names and document counts only, never file contents.
 */
import { ChevronRight, CornerLeftUp, Folder, FolderOpen, HardDrive, House, Lock } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { isApiError } from "@/api/client";
import { cn } from "@/lib/cn";
import { pluralize } from "@/lib/format";
import { Button, Chip, Dialog, ErrorState, Field, IconButton, Input, Skeleton } from "@/ui";
import { useLocalFolders } from "../api";

interface Crumb {
  label: string;
  path: string;
}

function crumbsOf(p: string): Crumb[] {
  const windows = /^[A-Za-z]:/.test(p) || (p.includes("\\") && !p.includes("/"));
  const sep = windows ? "\\" : "/";
  const parts = p.split(/[\\/]+/).filter(Boolean);
  const out: Crumb[] = [];
  let acc = "";
  if (!windows) out.push({ label: "/", path: "/" });
  parts.forEach((part, i) => {
    if (windows && i === 0) acc = `${part}${sep}`;
    else acc = windows ? `${acc}${acc.endsWith(sep) ? "" : sep}${part}` : `${acc}/${part}`;
    out.push({ label: part, path: acc });
  });
  return out;
}

function FolderRows() {
  return (
    <div role="status" aria-label="Loading folders" className="space-y-1 p-1">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex h-11 items-center gap-3 px-3">
          <Skeleton className="size-5 rounded" />
          <Skeleton className={cn("h-4", i % 2 ? "w-1/3" : "w-1/2")} />
        </div>
      ))}
    </div>
  );
}

export function FolderPicker({
  open,
  onOpenChange,
  onChoose,
  chosen = [],
  startPath,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (path: string) => void;
  /** Folders already added (marked and not offered twice). */
  chosen?: string[];
  startPath?: string | null;
}) {
  const [path, setPath] = useState<string | null>(startPath ?? null);
  const [selected, setSelected] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const q = useLocalFolders(path, open);

  useEffect(() => {
    if (open) {
      setPath(startPath ?? null);
      setSelected(null);
    }
  }, [open, startPath]);

  const current = q.data?.path ?? null;
  const target = selected ?? current;
  useEffect(() => setTyped(target ?? ""), [target]);

  const crumbs = useMemo(() => (current ? crumbsOf(current) : []), [current]);
  const already = (p: string | null) => Boolean(p && chosen.includes(p));
  const typedDirty = typed.trim() !== "" && typed.trim() !== (target ?? "");

  const go = (p: string | null) => {
    setPath(p);
    setSelected(null);
  };

  const errorView = () => {
    const err = q.error;
    if (isApiError(err, "forbidden"))
      return (
        <ErrorState compact error={err} title="Only an owner or admin can browse folders" className="py-8" />
      );
    if (isApiError(err, "no_folder") || isApiError(err, "permission"))
      return (
        <div className="px-4 py-8 text-center">
          <p className="font-semibold text-ink">{isApiError(err, "no_folder") ? "That folder was not found" : "No permission to read this folder"}</p>
          <p className="mt-1 break-all font-mono text-sm text-ink-3">{path}</p>
          <Button variant="secondary" className="mt-4" icon={<House />} onClick={() => go(null)}>
            Go to home folder
          </Button>
        </div>
      );
    return <ErrorState compact error={err} onRetry={() => q.refetch()} className="py-8" />;
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Choose company folder"
      description="Pick a folder with old quotations, catalogues or company documents."
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!target || typedDirty || already(target) || q.isError}
            onClick={() => {
              if (!target) return;
              onChoose(target);
              onOpenChange(false);
            }}
          >
            {already(target) ? "Already added" : "Use this folder"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-2">
          <nav aria-label="Folder location" className="min-w-0 flex-1">
            <ol className="flex flex-wrap items-center gap-x-1 gap-y-1 text-sm">
              {crumbs.length === 0 ? (
                <li>
                  <Skeleton className="h-5 w-40" />
                </li>
              ) : (
                crumbs.map((c, i) => {
                  const last = i === crumbs.length - 1;
                  return (
                    <li key={c.path} className="flex min-w-0 items-center gap-1">
                      {i > 0 ? <ChevronRight className="size-3.5 shrink-0 text-ink-3" aria-hidden /> : null}
                      {last ? (
                        <span aria-current="location" className="truncate font-medium text-ink">
                          {c.label === "/" ? <HardDrive className="size-4" aria-label="Root folder" /> : c.label}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => go(c.path)}
                          className="truncate rounded px-1 py-0.5 text-ink-3 hover:bg-hover hover:text-ink"
                        >
                          {c.label === "/" ? <HardDrive className="size-4" aria-label="Root folder" /> : c.label}
                        </button>
                      )}
                    </li>
                  );
                })
              )}
            </ol>
          </nav>
          <IconButton label="Up one level" size="sm" variant="secondary" disabled={!q.data?.parent} onClick={() => go(q.data?.parent ?? null)}>
            <CornerLeftUp />
          </IconButton>
          <IconButton label="Home folder" size="sm" variant="secondary" onClick={() => go(null)}>
            <House />
          </IconButton>
        </div>

        <div className="overflow-hidden rounded-lg border border-line">
          <div className="max-h-[min(20rem,40dvh)] overflow-y-auto">
            {q.isLoading ? (
              <FolderRows />
            ) : q.isError ? (
              errorView()
            ) : q.data && q.data.folders.length === 0 ? (
              <div className="flex flex-col items-center px-4 py-8 text-center">
                <FolderOpen className="size-6 text-ink-3" aria-hidden />
                <p className="mt-2 font-medium text-ink">No subfolders here</p>
                <p className="mt-0.5 text-sm text-ink-3">You can use this folder itself.</p>
              </div>
            ) : (
              <ul className="space-y-0.5 p-1" aria-label="Subfolders">
                {q.data?.folders.map((f) => {
                  const isSel = selected === f.path;
                  return (
                    <li key={f.path} className="flex items-center gap-1">
                      <button
                        type="button"
                        aria-pressed={isSel}
                        onClick={() => setSelected(isSel ? null : f.path)}
                        onDoubleClick={() => go(f.path)}
                        className={cn(
                          "flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-md px-3 text-left text-base transition-colors",
                          isSel ? "bg-brand-soft font-medium text-brand-ink" : "text-ink hover:bg-hover",
                        )}
                      >
                        <Folder className={cn("size-5 shrink-0", isSel ? "text-brand" : "text-ink-3")} aria-hidden />
                        <span className="min-w-0 flex-1 truncate">{f.name}</span>
                        {already(f.path) ? (
                          <Chip size="sm" tone="brand">
                            Added
                          </Chip>
                        ) : null}
                      </button>
                      <IconButton label={`Open ${f.name}`} size="sm" onClick={() => go(f.path)}>
                        <ChevronRight />
                      </IconButton>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {q.data ? (
            <p className="border-t border-line bg-sunken px-3 py-2 text-xs text-ink-3">
              {q.data.documents_here > 0
                ? `${pluralize(q.data.documents_here, "document")} directly in this folder`
                : "No documents directly in this folder"}
              {q.data.folders.length > 0 ? ` · ${pluralize(q.data.folders.length, "subfolder")}` : ""}
            </p>
          ) : null}
        </div>

        <Field label="Folder path" htmlFor="folder-path" hint="Type or paste a path, then press Enter to open it.">
          <Input
            id="folder-path"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && typed.trim()) {
                e.preventDefault();
                go(typed.trim());
              }
            }}
            spellCheck={false}
            autoComplete="off"
            className="font-mono text-sm"
          />
        </Field>

        <p className="flex items-start gap-2 text-sm text-ink-2">
          <Lock className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
          Read access only. Subfolders are included. Files are read on this computer and never changed or moved.
        </p>
      </div>
    </Dialog>
  );
}
