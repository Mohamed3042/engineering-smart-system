import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { connectionStatusInfo } from "@/lib/labels";
import { Button, Dialog, Field, InlineError, Select, StatusChip, toast, toastError } from "@/ui";
import { connectionApi, invalidateConnections, MANAGE_HINT, testSummary, useCanManage } from "../api";
import { connectionIssue } from "../issues";
import type { ConnectionRow, TestResult } from "../types";
import { SEARCH_PROVIDERS } from "../vocab";
import { SecretInput, SecretNote } from "./bits";
import { IssueBanner } from "./IssueBanner";

function SearchServiceForm({ conn, onDone }: { conn?: ConnectionRow | null; onDone: () => void }) {
  const qc = useQueryClient();
  const canManage = useCanManage();
  const [provider, setProvider] = useState(conn?.provider ?? "brave");
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<ConnectionRow | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);
  const target = conn ?? saved;
  const def = SEARCH_PROVIDERS.find((p) => p.key === provider);
  const stored = target?.secrets?.api_key;

  async function run(e: FormEvent) {
    e.preventDefault();
    setFailure(null);
    if (def?.needsKey && !key.trim() && !stored?.set) {
      setError("Paste the API key.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const secrets = key.trim() ? { api_key: key.trim() } : undefined;
      const row = target
        ? await connectionApi.update(target.id, { secrets })
        : await connectionApi.create({ kind: "search", method: "api", provider, name: def?.label.replace(" (no key)", "") ?? provider, secrets });
      setSaved(row);
      const res = await connectionApi.test(row.id);
      setSaved(res.connection);
      setResult(res);
      setKey("");
      await invalidateConnections(qc, { session: false });
      if (res.ok) {
        toast.success("Search service works", { description: testSummary(res) });
        onDone();
      }
    } catch (err) {
      setFailure(err);
      toastError(err, "The search service could not be saved");
    } finally {
      setBusy(false);
    }
  }

  const shown = result?.connection ?? target;
  const issue = shown && result && !result.ok ? connectionIssue(shown) : null;

  return (
    <form onSubmit={run} noValidate className="space-y-5">
      <Field label="Search service" htmlFor="search-provider" hint={def?.hint}>
        <Select
          id="search-provider"
          value={provider}
          disabled={!!target || busy || !canManage}
          options={SEARCH_PROVIDERS.map((p) => ({ value: p.key, label: p.label }))}
          onChange={(e) => {
            setProvider(e.target.value);
            setError(null);
          }}
        />
      </Field>
      {def?.needsKey ? (
        <Field label="API key" htmlFor="search-key" required={!stored?.set} error={error ?? undefined} hint={<SecretNote />}>
          <SecretInput
            id="search-key"
            value={key}
            invalid={!!error}
            disabled={busy || !canManage}
            autoFocus
            placeholder={stored?.set ? `Saved key ${stored.hint ?? ""} · type to replace` : "Paste the key"}
            onChange={(e) => setKey(e.target.value)}
          />
        </Field>
      ) : (
        <p className="text-sm text-ink-3">No key is needed. DuckDuckGo results are best effort and can be thinner.</p>
      )}
      {issue && shown ? (
        <IssueBanner
          issue={issue}
          raw={shown.last_error}
          disabled={busy}
          on={{ replace_key: () => document.getElementById("search-key")?.focus() }}
        />
      ) : result?.ok ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-ink-2" role="status">
          <StatusChip info={connectionStatusInfo("connected")} size="sm" /> {testSummary(result)}
        </div>
      ) : null}
      <InlineError error={failure} />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Button type="submit" loading={busy} disabled={!canManage} className="w-full sm:w-auto">
          {target ? "Save and test" : "Add and test"}
        </Button>
        {!canManage ? <p className="text-sm text-ink-3">{MANAGE_HINT}</p> : null}
      </div>
    </form>
  );
}

/** Add or change a web search service, used only for customer research. */
export function SearchServiceDialog({
  open,
  onOpenChange,
  conn,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conn?: ConnectionRow | null;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={conn ? "Search service settings" : "Add search service"}
      description="Used for customer research only. Web results are context for a customer's profile; they never decide what your company does."
    >
      <SearchServiceForm key={conn?.id ?? "new"} conn={conn} onDone={() => onOpenChange(false)} />
    </Dialog>
  );
}
