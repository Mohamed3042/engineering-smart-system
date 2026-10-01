import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { formatRelative } from "@/lib/format";
import { connectionStatusInfo } from "@/lib/labels";
import { Button, Dot, Field, Input, Select, Skeleton, StatusChip, toastError } from "@/ui";
import { activateConnection, connectionApi, invalidateConnections, MANAGE_HINT, useAiProviders, useCanManage } from "../api";
import { connectionIssue } from "../issues";
import type { ConnectionRow, TestResult } from "../types";
import { aiProviderLabel } from "../vocab";
import { SecretInput, SecretNote } from "./bits";
import { IssueBanner } from "./IssueBanner";

const KEY_HINT: Record<string, string> = {
  openai: "Create a key at platform.openai.com → API keys.",
  anthropic: "Create a key in the Claude Console → API keys.",
  google: "Create a key in Google AI Studio → Get API key.",
  azure_openai: "Key 1 or Key 2 from your Azure OpenAI resource → Keys and Endpoint.",
  openai_compatible: "The key your gateway gives you, for example OpenRouter.",
};

const BASE_URL_HINT: Record<string, string> = {
  openai: "Leave empty to use api.openai.com.",
  azure_openai: "Your resource address, for example https://your-resource.openai.azure.com",
  openai_compatible: "The gateway's API address, for example https://openrouter.ai/api/v1",
};

function isUrl(v: string) {
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Provider + API key + optional endpoint, saved encrypted and tested (state 03; error state 72).
 * The backend stores the key on save, so "test" always saves first.
 */
export function ApiKeyForm({
  connections,
  onConnected,
  autoFocus,
}: {
  connections: ConnectionRow[];
  onConnected?: (conn: ConnectionRow, result: TestResult) => void;
  autoFocus?: boolean;
}) {
  const qc = useQueryClient();
  const canManage = useCanManage();
  const providers = useAiProviders();
  const apiConns = connections.filter((c) => c.kind === "ai" && c.method === "api");
  const active = apiConns.find((c) => c.is_active) ?? null;
  const ids = { provider: useId(), key: useId(), base: useId(), version: useId() };

  const [provider, setProvider] = useState(active?.provider ?? "openai");
  const existing = useMemo(
    () => apiConns.find((c) => c.provider === provider && c.is_active) ?? apiConns.find((c) => c.provider === provider) ?? null,
    [apiConns, provider],
  );
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState<string>(existing?.config?.base_url ?? "");
  const [apiVersion, setApiVersion] = useState<string>(existing?.config?.extra?.api_version ?? "");
  const [errors, setErrors] = useState<{ key?: string; base?: string }>({});
  const [result, setResult] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const baseRef = useRef<HTMLInputElement>(null);

  // Switching provider loads that provider's saved endpoint (keys are never loaded).
  const loadedFor = useRef(existing?.id ?? null);
  useEffect(() => {
    if ((existing?.id ?? null) === loadedFor.current) return;
    loadedFor.current = existing?.id ?? null;
    setBaseUrl(existing?.config?.base_url ?? "");
    setApiVersion(existing?.config?.extra?.api_version ?? "");
  }, [existing]);

  const def = providers.data?.find((p) => p.key === provider);
  const needsBase = def?.fields.includes("base_url") ?? (provider === "azure_openai" || provider === "openai_compatible");
  const offersBase = needsBase || (def?.optional.includes("base_url") ?? provider === "openai");
  const offersVersion = def?.optional.includes("api_version") ?? provider === "azure_openai";
  const storedKey = existing?.secrets?.api_key;
  const configChanged =
    (baseUrl.trim() || "") !== (existing?.config?.base_url ?? "") ||
    (apiVersion.trim() || "") !== (existing?.config?.extra?.api_version ?? "");
  const hasChanges = !existing || apiKey.trim() !== "" || configChanged || !existing.is_active;

  // The connection whose state we show: the one just tested, else the saved one.
  const shown = result?.connection.provider === provider ? result.connection : existing;
  const issue = shown ? connectionIssue(shown) : null;

  async function run(mode: "save" | "test") {
    const next: typeof errors = {};
    if (mode === "save") {
      if (!apiKey.trim() && !storedKey?.set) next.key = "Paste the API key.";
      if (needsBase && !baseUrl.trim()) next.base = "Enter the endpoint address.";
      else if (baseUrl.trim() && !isUrl(baseUrl.trim())) next.base = "Enter a full address starting with https://";
    }
    setErrors(next);
    if (next.key) return keyRef.current?.focus();
    if (next.base) return baseRef.current?.focus();

    setBusy(mode);
    try {
      let conn = existing;
      if (mode === "save") {
        const config: Record<string, unknown> = {};
        if (offersBase) config.base_url = baseUrl.trim() || null;
        if (offersVersion) config.extra = { ...(existing?.config?.extra ?? {}), api_version: apiVersion.trim() || undefined };
        const secrets = apiKey.trim() ? { api_key: apiKey.trim() } : undefined;
        if (conn) {
          conn = await connectionApi.update(conn.id, { config, secrets });
          if (!conn.is_active) await activateConnection(conn, connections);
        } else {
          conn = await connectionApi.create({
            kind: "ai",
            method: "api",
            provider,
            name: aiProviderLabel(provider),
            config,
            secrets,
          });
        }
        setApiKey("");
      }
      if (!conn) return;
      const res = await connectionApi.test(conn.id);
      setResult(res);
      await invalidateConnections(qc, { models: true });
      if (res.ok) onConnected?.(res.connection, res);
    } catch (err) {
      toastError(err, mode === "save" ? "The key could not be saved" : "The test could not run");
    } finally {
      setBusy(null);
    }
  }

  if (providers.isLoading) {
    return (
      <div className="space-y-4" aria-label="Loading">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-40" />
      </div>
    );
  }

  const switching = active && active.provider !== provider;

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        void run(hasChanges ? "save" : "test");
      }}
    >
      {issue && shown ? (
        <IssueBanner
          issue={issue}
          raw={shown.last_error}
          busy={busy === "test" ? "test" : null}
          disabled={!canManage || busy !== null}
          on={{
            replace_key: () => keyRef.current?.focus(),
            test: () => void run("test"),
            edit: () => baseRef.current?.focus(),
          }}
        />
      ) : null}

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Provider" htmlFor={ids.provider}>
          <Select
            id={ids.provider}
            value={provider}
            disabled={!canManage || busy !== null}
            onChange={(e) => {
              setProvider(e.target.value);
              setApiKey("");
              setErrors({});
              setResult(null);
            }}
            options={(providers.data ?? []).map((p) => ({ value: p.key, label: p.label }))}
          />
        </Field>
        <Field
          label="API key"
          htmlFor={ids.key}
          error={errors.key}
          hint={
            <span className="block space-y-0.5">
              <span className="block">{KEY_HINT[provider] ?? "The key from your provider account."}</span>
              <SecretNote />
            </span>
          }
        >
          <SecretInput
            id={ids.key}
            ref={keyRef}
            value={apiKey}
            autoFocus={autoFocus}
            invalid={!!errors.key}
            disabled={!canManage || busy !== null}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={storedKey?.set ? `Saved key ${storedKey.hint ?? ""} · type to replace` : "Paste the key"}
          />
        </Field>
        {offersBase ? (
          <Field
            label="Base URL"
            htmlFor={ids.base}
            optional={!needsBase}
            required={needsBase}
            error={errors.base}
            hint={BASE_URL_HINT[provider]}
            className={offersVersion ? undefined : "sm:col-span-2"}
          >
            <Input
              id={ids.base}
              ref={baseRef}
              type="url"
              inputMode="url"
              spellCheck={false}
              value={baseUrl}
              invalid={!!errors.base}
              disabled={!canManage || busy !== null}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://"
            />
          </Field>
        ) : null}
        {offersVersion ? (
          <Field label="API version" htmlFor={ids.version} optional hint="Leave empty for the default version.">
            <Input
              id={ids.version}
              spellCheck={false}
              value={apiVersion}
              disabled={!canManage || busy !== null}
              onChange={(e) => setApiVersion(e.target.value)}
              placeholder="2024-10-21"
            />
          </Field>
        ) : null}
      </div>

      {switching ? (
        <p className="text-sm text-ink-2">
          Saving switches the engine from {aiProviderLabel(active.provider)} to {aiProviderLabel(provider)}. You then choose a
          model of the new provider.
        </p>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Button type="submit" loading={busy === "save"} disabled={!canManage || busy !== null} className="w-full sm:w-auto">
          {!existing ? "Save and test connection" : apiKey.trim() ? "Save new key and test" : hasChanges ? "Save and test" : "Test again"}
        </Button>
        {existing && hasChanges && !apiKey.trim() && storedKey?.set ? (
          <Button variant="secondary" loading={busy === "test"} disabled={busy !== null} onClick={() => void run("test")} className="w-full sm:w-auto">
            Test saved key
          </Button>
        ) : null}
        <TestState conn={shown} result={result?.connection.provider === provider ? result : null} testing={busy !== null} />
      </div>
      {!canManage ? <p className="text-sm text-ink-3">{MANAGE_HINT}</p> : null}
    </form>
  );
}

function TestState({ conn, result, testing }: { conn: ConnectionRow | null; result: TestResult | null; testing: boolean }) {
  if (testing) return <span className="text-sm text-ink-3">Testing the connection…</span>;
  if (!conn) {
    return (
      <span className="inline-flex items-center gap-2 text-sm text-ink-3">
        <Dot tone="muted" /> Not tested yet
      </span>
    );
  }
  const info = connectionStatusInfo(conn.status);
  return (
    <span className="flex flex-wrap items-center gap-2 text-sm text-ink-3">
      <StatusChip info={info} size="sm" />
      {conn.status === "connected" && typeof result?.models === "number"
        ? `This key can use ${result.models} models.`
        : conn.last_checked_at
          ? `Checked ${formatRelative(conn.last_checked_at).toLowerCase()}`
          : "Not tested yet"}
    </span>
  );
}
