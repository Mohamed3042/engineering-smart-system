/**
 * Connect or edit the mailbox: Gmail through Google sign-in, any mailbox through IMAP, or a Gmail MCP
 * server. One form for Settings (inside a dialog) and for the setup wizard (inline). Mail is only read.
 * Secrets are typed once, sent to the backend, and never shown again.
 */
import { CircleCheck, LogIn, Mail, Network, Server, Upload } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { formatRelative } from "@/lib/format";
import { connectionStatusInfo } from "@/lib/labels";
import {
  Button,
  ChoiceCards,
  Chip,
  Field,
  InlineError,
  Input,
  Segmented,
  Select,
  StatusChip,
  Switch,
  toast,
  toastError,
} from "@/ui";
import { connectionApi, invalidateConnections, MANAGE_HINT, testSummary, useCanManage, useGoogleSignIn } from "../api";
import { connectionIssue } from "../issues";
import type { ConnectionRow, TestResult } from "../types";
import { mailMethodLabel } from "../vocab";
import { Disclosure, SecretInput, SecretNote } from "./bits";
import { IssueBanner } from "./IssueBanner";

export type MailMethod = "oauth" | "imap" | "mcp";

/** What the backend keeps in a mailbox connection's config (backend/ess/pipeline/connect.py: mail_source_for). */
interface MailConfig {
  account?: string | null;
  host?: string;
  port?: number;
  username?: string;
  ssl?: boolean;
  smtp_host?: string;
  smtp_port?: number;
  transport?: string;
  url?: string;
  command?: string;
  args?: string[];
}

const IMAP_PRESETS = [
  { key: "gmail", label: "Gmail (with an app password)", host: "imap.gmail.com", port: 993, smtp: "smtp.gmail.com", smtpPort: 587 },
  { key: "microsoft", label: "Microsoft 365 or Outlook", host: "outlook.office365.com", port: 993, smtp: "smtp.office365.com", smtpPort: 587 },
  { key: "other", label: "Another provider", host: "", port: 993, smtp: "", smtpPort: 587 },
];

function presetFor(host: string | undefined) {
  return IMAP_PRESETS.find((p) => p.host && p.host === host)?.key ?? "other";
}

const providerOf = (m: MailMethod) => (m === "imap" ? "imap" : "gmail");
const hostLike = (v: string) => /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(v);

function isHttpUrl(v: string) {
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** A Google client file holds an "installed" or "web" section. Check before uploading. */
async function checkClientFile(file: File): Promise<string | null> {
  try {
    const json = JSON.parse(await file.text()) as Record<string, unknown>;
    return json.installed || json.web ? null : "This is not a Google client file. It should be the client_secret_….json from Google Cloud.";
  } catch {
    return "This file is not valid JSON. Choose the client_secret_….json you downloaded from Google Cloud.";
  }
}

type Errors = Partial<Record<"file" | "host" | "port" | "username" | "password" | "url" | "command", string>>;

export function MailboxForm({
  conn,
  connections,
  onBusyChange,
  onConnected,
  defaultUsername,
  autoFocus,
}: {
  /** Edit this connection; without it the form adds a new one. */
  conn?: ConnectionRow | null;
  connections: ConnectionRow[];
  onBusyChange?: (busy: boolean) => void;
  onConnected?: (conn: ConnectionRow, result: TestResult) => void;
  defaultUsername?: string;
  autoFocus?: boolean;
}) {
  const qc = useQueryClient();
  const canManage = useCanManage();
  const signIn = useGoogleSignIn();
  const uid = useId();
  const id = (s: string) => `${uid}-${s}`;
  const [saved, setSaved] = useState<ConnectionRow | null>(null);
  // after a first save the form keeps editing that connection instead of adding a second one
  const target = conn ?? saved;
  const cfg: MailConfig = target?.config ?? {};

  const [method, setMethod] = useState<MailMethod>((target?.method as MailMethod | undefined) ?? "oauth");
  const [errors, setErrors] = useState<Errors>({});
  const [result, setResult] = useState<TestResult | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusyState] = useState(false);
  const setBusy = (b: boolean) => {
    setBusyState(b);
    onBusyChange?.(b);
  };

  // Gmail
  const [account, setAccount] = useState<string>(cfg.account ?? (target ? "" : (defaultUsername ?? "")));
  const [clientFile, setClientFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // IMAP
  const [preset, setPreset] = useState(presetFor(cfg.host));
  const [host, setHost] = useState<string>(cfg.host ?? "");
  const [port, setPort] = useState<string>(String(cfg.port ?? 993));
  const [ssl, setSsl] = useState<boolean>(cfg.ssl ?? true);
  const [username, setUsername] = useState<string>(cfg.username ?? defaultUsername ?? "");
  const [password, setPassword] = useState("");
  const [smtpHost, setSmtpHost] = useState<string>(cfg.smtp_host ?? "");
  const [smtpPort, setSmtpPort] = useState<string>(String(cfg.smtp_port ?? 587));
  // MCP
  const [transport, setTransport] = useState<"http" | "stdio">(cfg.transport === "stdio" ? "stdio" : "http");
  const [url, setUrl] = useState<string>(cfg.url ?? "");
  const [token, setToken] = useState("");
  const [command, setCommand] = useState<string>(cfg.command ?? "");
  const [args, setArgs] = useState<string>(Array.isArray(cfg.args) ? cfg.args.join(" ") : "");

  const refs = {
    host: useRef<HTMLInputElement>(null),
    port: useRef<HTMLInputElement>(null),
    username: useRef<HTMLInputElement>(null),
    password: useRef<HTMLInputElement>(null),
    url: useRef<HTMLInputElement>(null),
    command: useRef<HTMLInputElement>(null),
  };

  // Typing the mailbox address in the setup wizard pre-fills the IMAP user name once.
  const filled = useRef(false);
  useEffect(() => {
    if (!filled.current && !username && defaultUsername) {
      filled.current = true;
      setUsername(defaultUsername);
    }
  }, [defaultUsername, username]);

  const activeMail = connections.find((c) => c.kind === "mail" && c.is_active && c.id !== target?.id) ?? null;
  const storedClient = target?.secrets?.client_config?.set ?? false;
  const storedToken = target?.secrets?.token?.set ?? false;
  const storedPassword = target?.secrets?.password;
  const storedBearer = target?.secrets?.token;
  const locked = !canManage || busy;

  function applyPreset(key: string) {
    setPreset(key);
    const p = IMAP_PRESETS.find((x) => x.key === key);
    if (p && p.host) {
      setHost(p.host);
      setPort(String(p.port));
      setSmtpHost(p.smtp);
      setSmtpPort(String(p.smtpPort));
    }
  }

  async function pickFile(file: File | undefined) {
    if (!file) return;
    const problem = await checkClientFile(file);
    setErrors((e) => ({ ...e, file: problem ?? undefined }));
    setClientFile(problem ? null : file);
  }

  function validate(): Errors {
    const e: Errors = {};
    if (method === "oauth") {
      if (!clientFile && !storedClient) e.file = "Upload the client file from Google Cloud first.";
    } else if (method === "imap") {
      if (!host.trim()) e.host = "Enter the mail server address, for example imap.example.com.";
      else if (!hostLike(host.trim())) e.host = "Enter only the server name, without https:// or a path.";
      const n = Number(port);
      if (!Number.isInteger(n) || n < 1 || n > 65535) e.port = "Enter a port between 1 and 65535 (usually 993).";
      if (!username.trim()) e.username = "Enter the mailbox user name, usually the full address.";
      if (!password.trim() && !storedPassword?.set) e.password = "Enter the mailbox password or app password.";
    } else if (transport === "http") {
      if (!url.trim()) e.url = "Enter the address of the MCP server.";
      else if (!isHttpUrl(url.trim())) e.url = "Enter a full address starting with https://";
    } else if (!command.trim()) {
      e.command = "Enter the command that starts the MCP server.";
    }
    return e;
  }

  function buildConfig(): Record<string, unknown> {
    if (method === "oauth") return { account: account.trim() || null };
    if (method === "imap") {
      const c: Record<string, unknown> = { host: host.trim(), port: Number(port), username: username.trim(), ssl };
      if (smtpHost.trim()) {
        c.smtp_host = smtpHost.trim();
        c.smtp_port = Number(smtpPort) || 587;
      }
      return c;
    }
    return transport === "http"
      ? { transport: "http", url: url.trim() }
      : { transport: "stdio", command: command.trim(), args: args.trim() ? args.trim().split(/\s+/) : [] };
  }

  function buildSecrets(): Record<string, string> | undefined {
    if (method === "imap" && password.trim()) return { password: password.trim() };
    if (method === "mcp" && token.trim() && transport === "http") return { token: token.trim() };
    return undefined;
  }

  async function run(e?: FormEvent, opts: { signInAgain?: boolean } = {}) {
    e?.preventDefault();
    const found = validate();
    setErrors(found);
    setFailure(null);
    if (found.file) return;
    if (found.host) return refs.host.current?.focus();
    if (found.port) return refs.port.current?.focus();
    if (found.username) return refs.username.current?.focus();
    if (found.password) return refs.password.current?.focus();
    if (found.url) return refs.url.current?.focus();
    if (found.command) return refs.command.current?.focus();

    setBusy(true);
    try {
      const config = buildConfig();
      const secrets = buildSecrets();
      let next: ConnectionRow = target
        ? await connectionApi.update(target.id, { config, secrets })
        : await connectionApi.create({ kind: "mail", method, provider: providerOf(method), name: mailMethodLabel(method), config, secrets });
      setSaved(next);
      if (method === "oauth") {
        if (clientFile) {
          next = await connectionApi.uploadClientConfig(next.id, clientFile);
          setSaved(next);
          setClientFile(null);
        }
        await invalidateConnections(qc);
        const hasToken = next.secrets?.token?.set ?? false;
        if (!hasToken || opts.signInAgain) {
          // ponytail: full-page redirect, because the backend callback returns to /settings/connections. A popup would keep the wizard in place but needs a polling step.
          // Google takes over the page; the return trip lands on Settings › Mailbox & services
          await signIn.mutateAsync(next.id);
        } else {
          toast.success("Mailbox settings saved");
        }
        return;
      }
      const res = await connectionApi.test(next.id);
      setSaved(res.connection);
      setResult(res);
      setPassword("");
      setToken("");
      await invalidateConnections(qc);
      if (res.ok) onConnected?.(res.connection, res);
    } catch (err) {
      setFailure(err);
      toastError(err, "The mailbox could not be saved");
    } finally {
      setBusy(false);
    }
  }

  async function retest() {
    if (!target) return;
    setBusy(true);
    try {
      const res = await connectionApi.test(target.id);
      setSaved(res.connection);
      setResult(res);
      await invalidateConnections(qc);
      if (res.ok) onConnected?.(res.connection, res);
    } catch (err) {
      toastError(err, "The test could not run");
    } finally {
      setBusy(false);
    }
  }

  const shown = result?.connection ?? target;
  const issue = shown && method !== "oauth" ? connectionIssue(shown) : null;
  const methodLocked = !!target;

  const submitLabel =
    method === "oauth"
      ? storedToken
        ? "Save"
        : "Save and sign in with Google"
      : target
        ? "Save and test"
        : "Connect mailbox";

  return (
    <form onSubmit={run} noValidate className="space-y-6">
      {!methodLocked ? (
        <ChoiceCards
          label="How the mailbox connects"
          columns={3}
          value={method}
          onChange={(v) => {
            setMethod(v as MailMethod);
            setErrors({});
            setResult(null);
            setFailure(null);
          }}
          options={[
            {
              value: "oauth",
              icon: <Mail aria-hidden />,
              label: "Gmail",
              badge: (
                <Chip size="sm" tone="brand">
                  Recommended
                </Chip>
              ),
              description: "Sign in with Google. Read access only.",
            },
            { value: "imap", icon: <Server aria-hidden />, label: "Any mailbox (IMAP)", description: "Server, user name and an app password." },
            { value: "mcp", icon: <Network aria-hidden />, label: "Gmail through MCP", description: "Point the app at a Gmail MCP server." },
          ]}
        />
      ) : (
        <p className="text-sm text-ink-3">{mailMethodLabel(method)}</p>
      )}

      {!methodLocked && activeMail ? (
        <p className="rounded-lg border border-line bg-sunken px-4 py-3 text-sm text-ink-2">
          This becomes the mailbox the app reads. {activeMail.account || mailMethodLabel(activeMail.method)} stays saved but is no longer read.
        </p>
      ) : null}

      {/* ------------------------------------------------------------ Gmail */}
      {method === "oauth" ? (
        <div className="space-y-5">
          <Field
            label="Gmail address"
            htmlFor={id("account")}
            optional
            hint="Helps Google pick the right account when you sign in."
          >
            <Input
              id={id("account")}
              type="email"
              inputMode="email"
              value={account}
              disabled={locked}
              autoFocus={autoFocus}
              autoComplete="off"
              spellCheck={false}
              placeholder="sales@yourcompany.com"
              onChange={(e) => setAccount(e.target.value)}
            />
          </Field>

          <div className="space-y-2">
            <p className="text-sm font-medium text-ink">Google client file</p>
            {storedClient && !clientFile ? (
              <p className="flex items-center gap-2 text-sm text-ink-2">
                <CircleCheck className="size-4 text-brand" aria-hidden />
                Client file saved. It is stored encrypted and never shown again.
              </p>
            ) : null}
            {clientFile ? <p className="break-all text-sm text-ink-2">Selected: {clientFile.name}</p> : null}
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              className="sr-only"
              tabIndex={-1}
              aria-label="Google client file"
              onChange={(e) => {
                void pickFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <Button
              variant="secondary"
              size="sm"
              icon={<Upload />}
              disabled={locked}
              onClick={() => fileInput.current?.click()}
              aria-invalid={errors.file ? true : undefined}
            >
              {storedClient || clientFile ? "Choose another client file" : "Upload client file"}
            </Button>
            {errors.file ? (
              <p className="text-sm text-block" role="alert">
                {errors.file}
              </p>
            ) : (
              <p className="text-sm text-ink-3">The client_secret_….json from Google Cloud → Credentials → OAuth client ID.</p>
            )}
          </div>

          <Disclosure title="How to get the client file" summary="Five steps in Google Cloud">
            <ol className="list-decimal space-y-1.5 pl-5 text-sm text-ink-2">
              <li>Open console.cloud.google.com and create or pick a project.</li>
              <li>APIs &amp; Services → Library → Gmail API → Enable.</li>
              <li>OAuth consent screen: type Internal for a Google Workspace domain, otherwise External with yourself as a test user.</li>
              <li>Credentials → Create credentials → OAuth client ID → Desktop app. Download the JSON.</li>
              <li>Upload it here, then sign in with Google.</li>
            </ol>
            <p className="mt-3 text-sm text-ink-3">
              A Web application client also needs this redirect address:{" "}
              <span className="break-all font-mono text-xs text-ink-2">{`${window.location.origin}/api/oauth/google/callback`}</span>
            </p>
          </Disclosure>
          <p className="text-sm text-ink-3">
            Google is asked for read access to mail and attachments, and to save a quotation as a draft reply. Nothing is sent unless a person presses
            Send on an approved quotation.
          </p>
        </div>
      ) : null}

      {/* ------------------------------------------------------------ IMAP */}
      {method === "imap" ? (
        <div className="space-y-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Mail provider" htmlFor={id("preset")} className="sm:col-span-2" hint="Picks the usual server settings. You can change them.">
              <Select
                id={id("preset")}
                value={preset}
                disabled={locked}
                options={IMAP_PRESETS.map((p) => ({ value: p.key, label: p.label }))}
                onChange={(e) => applyPreset(e.target.value)}
              />
            </Field>
            <Field label="Server address" htmlFor={id("host")} required error={errors.host}>
              <Input
                id={id("host")}
                ref={refs.host}
                value={host}
                invalid={!!errors.host}
                disabled={locked}
                autoFocus={autoFocus}
                spellCheck={false}
                autoCapitalize="off"
                placeholder="imap.example.com"
                onChange={(e) => setHost(e.target.value)}
              />
            </Field>
            <div className="grid grid-cols-[1fr_auto] items-end gap-4">
              <Field label="Port" htmlFor={id("port")} required error={errors.port}>
                <Input id={id("port")} ref={refs.port} inputMode="numeric" value={port} invalid={!!errors.port} disabled={locked} onChange={(e) => setPort(e.target.value)} />
              </Field>
              <div className="pb-2">
                <Switch label="SSL" checked={ssl} disabled={locked} onChange={setSsl} className="gap-3" />
              </div>
            </div>
            <Field label="User name" htmlFor={id("user")} required error={errors.username} hint="Usually the full mailbox address.">
              <Input
                id={id("user")}
                ref={refs.username}
                value={username}
                invalid={!!errors.username}
                disabled={locked}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setUsername(e.target.value)}
              />
            </Field>
            <Field
              label="Password or app password"
              htmlFor={id("password")}
              required={!storedPassword?.set}
              error={errors.password}
              hint={<SecretNote>Stored encrypted on this computer. It is never shown again.</SecretNote>}
            >
              <SecretInput
                id={id("password")}
                ref={refs.password}
                revealLabel="password"
                value={password}
                invalid={!!errors.password}
                disabled={locked}
                placeholder={storedPassword?.set ? `Saved ${storedPassword.hint ?? ""} · type to replace` : "Paste the app password"}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
          </div>
          <Disclosure title="Sending (optional)" summary="Only used after a person approves a quotation">
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="SMTP server" htmlFor={id("smtp")} optional>
                <Input id={id("smtp")} value={smtpHost} disabled={locked} spellCheck={false} placeholder="smtp.example.com" onChange={(e) => setSmtpHost(e.target.value)} />
              </Field>
              <Field label="SMTP port" htmlFor={id("smtp-port")} optional>
                <Input id={id("smtp-port")} inputMode="numeric" value={smtpPort} disabled={locked} onChange={(e) => setSmtpPort(e.target.value)} />
              </Field>
            </div>
          </Disclosure>
        </div>
      ) : null}

      {/* ------------------------------------------------------------ MCP */}
      {method === "mcp" ? (
        <div className="space-y-5">
          <Segmented
            label="How the MCP server is reached"
            value={transport}
            onChange={(v) => setTransport(v as "http" | "stdio")}
            options={[
              { value: "http", label: "Web address" },
              { value: "stdio", label: "Local command" },
            ]}
          />
          {transport === "http" ? (
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Server address" htmlFor={id("url")} required error={errors.url} className="sm:col-span-2">
                <Input
                  id={id("url")}
                  ref={refs.url}
                  type="url"
                  inputMode="url"
                  value={url}
                  invalid={!!errors.url}
                  disabled={locked}
                  autoFocus={autoFocus}
                  spellCheck={false}
                  placeholder="https://"
                  onChange={(e) => setUrl(e.target.value)}
                />
              </Field>
              <Field label="Token" htmlFor={id("token")} optional className="sm:col-span-2" hint={<SecretNote>Sent as a Bearer token. Stored encrypted; never shown again.</SecretNote>}>
                <SecretInput
                  id={id("token")}
                  revealLabel="token"
                  value={token}
                  disabled={locked}
                  placeholder={storedBearer?.set ? `Saved ${storedBearer.hint ?? ""} · type to replace` : "Paste the token"}
                  onChange={(e) => setToken(e.target.value)}
                />
              </Field>
            </div>
          ) : (
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Command" htmlFor={id("command")} required error={errors.command}>
                <Input
                  id={id("command")}
                  ref={refs.command}
                  value={command}
                  invalid={!!errors.command}
                  disabled={locked}
                  autoFocus={autoFocus}
                  spellCheck={false}
                  placeholder="npx"
                  onChange={(e) => setCommand(e.target.value)}
                />
              </Field>
              <Field label="Arguments" htmlFor={id("args")} optional hint="Separated by spaces.">
                <Input id={id("args")} value={args} disabled={locked} spellCheck={false} onChange={(e) => setArgs(e.target.value)} />
              </Field>
            </div>
          )}
          <p className="text-sm text-ink-3">The server must offer tools to search and read mail threads. Attachments need a server with an attachment tool.</p>
        </div>
      ) : null}

      {/* ------------------------------------------------------------ outcome */}
      {issue && shown ? (
        <IssueBanner
          issue={issue}
          raw={shown.last_error}
          busy={null}
          disabled={locked}
          on={{
            replace_password: () => refs.password.current?.focus(),
            edit: () => (refs.url.current ?? refs.host.current ?? refs.command.current)?.focus(),
            test: () => void retest(),
          }}
        />
      ) : result?.ok ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-brand-line bg-brand-soft px-4 py-3 text-sm text-brand-ink" role="status">
          <StatusChip info={connectionStatusInfo("connected")} size="sm" />
          <span>{testSummary(result)}</span>
        </div>
      ) : null}
      <InlineError error={failure} />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Button type="submit" loading={busy} disabled={!canManage} className="w-full sm:w-auto">
          {submitLabel}
        </Button>
        {method === "oauth" && target && storedClient ? (
          <Button variant="secondary" icon={<LogIn />} disabled={locked} onClick={() => void run(undefined, { signInAgain: true })} className="w-full sm:w-auto">
            Sign in with Google again
          </Button>
        ) : null}
        {shown?.last_checked_at && method !== "oauth" ? (
          <span className="text-sm text-ink-3">Checked {formatRelative(shown.last_checked_at).toLowerCase()}</span>
        ) : null}
      </div>
      {!canManage ? <p className="text-sm text-ink-3">{MANAGE_HINT}</p> : null}
    </form>
  );
}
