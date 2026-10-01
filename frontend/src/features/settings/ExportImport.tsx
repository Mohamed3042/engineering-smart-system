import { Download, FileUp } from "lucide-react";
import { useRef, useState } from "react";
import type { Workspace } from "@/api/types";
import { formatBytes, formatDateTime, formatNumber, pluralize } from "@/lib/format";
import { Banner, Button, ConfirmDialog, InlineError, KeyValue, Panel, PanelBody, PanelHeader, toast, toastError } from "@/ui";
import { downloadSnapshot, useImportSnapshot } from "./api";
import type { ImportResult } from "./types";

const FORMAT = "ess-workspace-snapshot/1";

interface Picked {
  file: File;
  from: string;
  generatedAt: string | null;
  counts: { emails: number; customers: number; projects: number; knowledge: number };
}

/** Read the file in the browser first, so the confirmation can say exactly what it contains. */
async function inspect(file: File): Promise<Picked> {
  let data: unknown;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error("This file is not valid JSON. Choose a snapshot exported from this app.");
  }
  const snap = data as { format?: unknown; generated_at?: unknown; workspace?: { company_name?: string; name?: string }; [k: string]: unknown };
  if (!snap || snap.format !== FORMAT) throw new Error("This is not a workspace snapshot. Choose a .json file exported from this app.");
  const n = (k: string) => (Array.isArray(snap[k]) ? (snap[k] as unknown[]).length : 0);
  return {
    file,
    from: snap.workspace?.company_name || snap.workspace?.name || "an unnamed workspace",
    generatedAt: typeof snap.generated_at === "string" ? snap.generated_at : null,
    counts: { emails: n("emails"), customers: n("customers"), projects: n("projects"), knowledge: n("knowledge") },
  };
}

/** Export the workspace to a file, or import a snapshot into it (adds and updates; never deletes). */
export function ExportImportPanel({ workspace, canEdit }: { workspace: Workspace; canEdit: boolean }) {
  const [exporting, setExporting] = useState(false);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [pickError, setPickError] = useState<unknown>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const importer = useImportSnapshot();
  const name = workspace.company_name || workspace.name;

  async function onExport() {
    setExporting(true);
    try {
      await downloadSnapshot(workspace.name);
      toast.success("Export ready", { description: "The file contains mail, projects, customers and business knowledge. Keep it private." });
    } catch (err) {
      toastError(err, "The export could not be created");
    } finally {
      setExporting(false);
    }
  }

  async function onPick(file: File | undefined) {
    if (!file) return;
    setPickError(null);
    setResult(null);
    try {
      setPicked(await inspect(file));
    } catch (err) {
      setPickError(err);
    }
  }

  function runImport() {
    if (!picked) return;
    importer.mutate(picked.file, {
      onSuccess: (r) => {
        setResult(r);
        setPicked(null);
        toast.success("Snapshot imported");
      },
      onError: (err) => {
        setPicked(null);
        setPickError(err);
      },
    });
  }

  return (
    <Panel>
      <PanelHeader title="Export and import" description="Move a workspace between computers, or keep a copy before a big change." />
      <PanelBody className="space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="font-medium text-ink">Export this workspace</p>
            <p className="text-sm text-ink-3">A .json file with mail, customers, projects and business knowledge. Quotations, keys and passwords are not included.</p>
          </div>
          <Button variant="secondary" icon={<Download />} loading={exporting} onClick={onExport} className="w-full shrink-0 sm:w-auto">
            Export workspace
          </Button>
        </div>

        <div className="flex flex-col gap-3 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="font-medium text-ink">Import a snapshot</p>
            <p className="text-sm text-ink-3">
              Adds what is in the file to this workspace. You see exactly what it contains before anything changes.
            </p>
          </div>
          <input
            ref={input}
            type="file"
            accept=".json,application/json"
            className="sr-only"
            tabIndex={-1}
            aria-label="Snapshot file"
            onChange={(e) => {
              void onPick(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <Button
            variant="secondary"
            icon={<FileUp />}
            disabled={!canEdit}
            onClick={() => input.current?.click()}
            className="w-full shrink-0 sm:w-auto"
          >
            Choose snapshot file
          </Button>
        </div>
        {!canEdit ? <p className="text-sm text-ink-3">Only an owner or admin can import a snapshot.</p> : null}
        <InlineError error={pickError} />

        {result ? (
          <Banner tone="brand" title="Snapshot imported">
            {pluralize(result.counts.emails ?? 0, "email")}, {pluralize(result.counts.customers ?? 0, "customer")},{" "}
            {pluralize(result.counts.projects ?? 0, "project")} and {pluralize(result.counts.knowledge ?? 0, "business finding")} were added or
            updated. Quotes checked against their source: {formatNumber(result.evidence.verified)} of {formatNumber(result.evidence.checked)} found
            word for word.
          </Banner>
        ) : null}
      </PanelBody>

      <ConfirmDialog
        open={picked !== null}
        onOpenChange={(o) => !o && setPicked(null)}
        title={`Import this snapshot into ${name}?`}
        confirmLabel="Import snapshot"
        loading={importer.isPending}
        onConfirm={runImport}
      >
        {picked ? (
          <div className="space-y-4">
            <KeyValue
              labelWidth="sm"
              items={[
                { label: "File", value: <span className="break-all">{picked.file.name}</span>, hint: formatBytes(picked.file.size) },
                { label: "Exported from", value: picked.from, hint: picked.generatedAt ? formatDateTime(picked.generatedAt) : undefined },
                {
                  label: "Contains",
                  value: `${pluralize(picked.counts.emails, "email")}, ${pluralize(picked.counts.customers, "customer")}, ${pluralize(picked.counts.projects, "project")}, ${pluralize(picked.counts.knowledge, "business finding")}`,
                },
              ]}
            />
            <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">
              <li>Items that already exist here (same reference) are updated with the file&apos;s values.</li>
              <li>Nothing in this workspace is deleted.</li>
              <li>Business findings you already confirmed stay confirmed.</li>
              <li>Company details are only filled in where they are empty.</li>
            </ul>
            <p className="text-sm text-ink-3">There is no undo. Export this workspace first if you want a way back.</p>
          </div>
        ) : null}
      </ConfirmDialog>
    </Panel>
  );
}
