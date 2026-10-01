import { useWorkspace } from "@/api/session";
import { Switch, toast, toastError } from "@/ui";
import { knowledgeSources, useSaveWorkspace } from "../api";
import { FolderSources } from "./FolderSources";

/**
 * Where business learning reads: company folders on this computer and, if allowed, public web pages.
 * Saved in the workspace as soon as something changes, so there is no separate Save step to forget.
 */
export function LearningSources({ canEdit, compact }: { canEdit: boolean; compact?: boolean }) {
  const workspace = useWorkspace();
  const save = useSaveWorkspace();
  const sources = knowledgeSources(workspace);

  const write = (patch: Partial<typeof sources>, done?: string) =>
    save.mutate(
      { settings: { knowledge_sources: { ...sources, ...patch } } },
      {
        onSuccess: () => done && toast.success(done),
        onError: (err) => toastError(err, "The sources could not be saved"),
      },
    );

  return (
    <div className="space-y-5">
      <FolderSources
        folders={sources.folders}
        canEdit={canEdit}
        busy={save.isPending}
        compact={compact}
        onChange={(folders) => write({ folders }, folders.length > sources.folders.length ? "Folder added" : "Folder removed")}
      />
      <div className={compact ? "" : "px-5 pb-4"}>
        <Switch
          label="Also look at public web pages about the company"
          description="Pages found by web search count as context only. They never prove what you deliver."
          checked={sources.web}
          disabled={!canEdit || save.isPending}
          onChange={(web) => write({ web })}
        />
      </div>
    </div>
  );
}
