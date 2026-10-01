/**
 * Turns a connection's last error into a plain problem statement and recovery steps.
 * The raw message is always shown as well, so nothing is hidden behind the summary.
 */
import { aiProviderLabel, searchProviderLabel } from "./vocab";

export type Recovery = "reconnect" | "upload_config" | "replace_key" | "replace_password" | "edit" | "test";

export interface Issue {
  title: string;
  body: string;
  steps: string[];
  /** Main recovery action, then any secondary one. */
  actions: Recovery[];
  /** amber when a person just has to finish something, red when something failed */
  tone: "review" | "block";
}

interface ConnLike {
  kind: string;
  method: string;
  provider: string;
  status: string;
  last_error: string | null;
}

const NETWORK =
  /cannot reach|did not answer in time|proxyerror|connecterror|connection (refused|reset|aborted)|timed? ?out|name or service not known|getaddrinfo|name resolution|network is unreachable|no route to host|certificate verify|ssl:|eof occurred/i;
const OAUTH_EXPIRED = /invalid_grant|expired|revoked|token has been|refresh token/i;
const NOT_AUTHORISED = /not authori[sz]ed yet|finish the google sign-in/i;
const CLIENT_CONFIG = /client json|client_config|client_secret|oauth client/i;
const BAD_KEY =
  /api key (was )?rejected|rejected by|invalid[ _-]?(x-)?api[ _-]?key|incorrect api key|authentication_error|permission_denied|an api key is required|http 401|http 403|unauthori[sz]ed/i;
const MAIL_AUTH =
  /authenticationfailed|authentication failed|invalid credentials|login failed|\[auth\]|username and password not accepted|application-specific password|web login required/i;
const QUOTA = /http 429|rate limit|quota|insufficient_quota|billing|credit balance|resource_exhausted/i;
const NOT_FOUND = /http 404|was not found|not found \(|base_url .* required|base url/i;
const MCP_DOWN = /cannot connect to the mcp server/i;
const MCP_TOOLS = /lacks tools/i;

function hostIn(message: string): string | null {
  const m = /(?:reach|from|by) ([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?/i.exec(message);
  return m ? m[1] : null;
}

function serviceName(c: ConnLike): string {
  if (c.kind === "ai") return aiProviderLabel(c.provider);
  if (c.kind === "search") return searchProviderLabel(c.provider);
  if (c.method === "oauth") return "Gmail";
  if (c.method === "mcp") return "The MCP mail server";
  return "The mail server";
}

/** null when the connection has nothing to fix. */
export function connectionIssue(c: ConnLike): Issue | null {
  const err = c.last_error ?? "";
  const name = serviceName(c);

  if (c.status === "needs_auth" || NOT_AUTHORISED.test(err)) {
    if (CLIENT_CONFIG.test(err)) {
      return {
        title: "Upload the Google client file",
        body: "Google sign-in needs the OAuth client file from your Google Cloud project before you can sign in.",
        steps: ["Download the client JSON from Google Cloud (Credentials → OAuth client ID).", "Upload it here, then sign in with Google."],
        actions: ["upload_config"],
        tone: "review",
      };
    }
    return {
      title: "Finish Google sign-in",
      body: "The mailbox is added but Google has not given access yet. Nothing is read until you sign in.",
      steps: ["Sign in with the Google account of this mailbox and allow read access."],
      actions: ["reconnect"],
      tone: "review",
    };
  }
  if (c.status !== "error") return null;

  if (MCP_DOWN.test(err)) {
    return {
      title: "The MCP mail server did not answer",
      body: "The app could not open a session with the MCP server.",
      steps: ["Check the server address or command.", "Check the token, if the server needs one.", "Make sure the server is running, then test again."],
      actions: ["edit", "test"],
      tone: "block",
    };
  }
  if (MCP_TOOLS.test(err)) {
    return {
      title: "The MCP server is missing mail tools",
      body: "It must offer tools to search and read mail threads.",
      steps: ["Use Google's Gmail MCP server, or map the tools in the connection settings.", "Or connect the mailbox with Google sign-in or IMAP instead."],
      actions: ["edit"],
      tone: "block",
    };
  }
  if (NETWORK.test(err)) {
    const host = hostIn(err);
    return {
      title: `The app cannot reach ${host ?? name}`,
      body: "This computer could not open a connection. Your stored key or password was not rejected and stays as it is.",
      steps: [
        "Check that this computer is online.",
        host ? `If your company uses a proxy or firewall, allow ${host}.` : "If your company uses a proxy or firewall, allow the service's address.",
        "Then test again.",
      ],
      actions: ["test"],
      tone: "block",
    };
  }
  if (c.kind === "mail" && c.method === "oauth" && (OAUTH_EXPIRED.test(err) || CLIENT_CONFIG.test(err))) {
    if (CLIENT_CONFIG.test(err) && !OAUTH_EXPIRED.test(err)) {
      return {
        title: "The Google client file is missing or wrong",
        body: "Google sign-in needs the OAuth client JSON from your Google Cloud project.",
        steps: ["Download the client JSON again from Google Cloud.", "Upload it here, then sign in with Google."],
        actions: ["upload_config"],
        tone: "block",
      };
    }
    return {
      title: "Google sign-in expired",
      body: "New mail is not fetched until you sign in again. Mail already saved stays on this computer.",
      steps: ["Sign in with Google again and allow read access."],
      actions: ["reconnect"],
      tone: "block",
    };
  }
  if (c.kind === "mail" && MAIL_AUTH.test(err)) {
    return {
      title: "The mail server refused the sign-in",
      body: "The username or app password is wrong, or IMAP access is turned off for this mailbox.",
      steps: [
        "Create an app password (Gmail: Google Account → Security → App passwords).",
        "Check that IMAP is enabled for the mailbox.",
        "Replace the password and test again.",
      ],
      actions: ["replace_password", "test"],
      tone: "block",
    };
  }
  if (QUOTA.test(err)) {
    return {
      title: "Quota or rate limit reached",
      body: `${name} refused more requests on this account.`,
      steps: ["Check billing and usage limits in your provider account.", "Wait a few minutes and test again, or replace the key with one from another account."],
      actions: ["test", "replace_key"],
      tone: "block",
    };
  }
  if (BAD_KEY.test(err)) {
    return {
      title: `${name} did not accept this key`,
      body: "The key may be wrong, revoked, or missing permissions.",
      steps: ["Create a new key in your provider account.", "Replace the key here.", "Test again."],
      actions: ["replace_key", "test"],
      tone: "block",
    };
  }
  if (NOT_FOUND.test(err)) {
    return {
      title: "Address not found",
      body: "The service answered that the address does not exist. Check the base URL or endpoint.",
      steps: ["Correct the base URL.", "Test again."],
      actions: ["edit", "test"],
      tone: "block",
    };
  }
  return {
    title: "Connection test failed",
    body: "The service reported a problem. The full message is below.",
    steps: ["Check the settings of this connection.", "Test again."],
    actions: ["test", c.kind === "mail" && c.method === "imap" ? "replace_password" : c.kind === "mail" ? "edit" : "replace_key"],
    tone: "block",
  };
}

/** Recovery for a failed exam run ("exam could not run: …"). */
export function examRunIssue(message: string, provider: string): Issue {
  return (
    connectionIssue({ kind: "ai", method: "api", provider, status: "error", last_error: message }) ?? {
      title: "The exam could not run",
      body: message,
      steps: [],
      actions: ["test"],
      tone: "block",
    }
  );
}
