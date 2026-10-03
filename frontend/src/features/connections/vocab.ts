/**
 * Plain-language names for providers, methods, AI tasks, tiers and capabilities.
 * Task keys and tiers come from backend/ess/ai/policy.py; MCP tools from backend/ess/mcp_server.py.
 */
import { humanize } from "@/lib/format";
import type { StatusInfo } from "@/lib/labels";
import type { ModelCapabilities } from "./types";

export const AI_PROVIDER_LABEL: Record<string, string> = {
  groq: "Groq",
  mistral: "Mistral",
  sambanova: "SambaNova",
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  azure_openai: "Azure OpenAI",
  openai_compatible: "OpenAI-compatible",
  mcp: "MCP client",
};

export const aiProviderLabel = (k?: string | null) => (k ? (AI_PROVIDER_LABEL[k] ?? humanize(k)) : "—");

export const SEARCH_PROVIDERS: { key: string; label: string; needsKey: boolean; hint: string; signup?: string }[] = [
  { key: "tavily", label: "Tavily", needsKey: true, hint: "Free monthly credits. ESS uses Basic searches to conserve them.", signup: "https://app.tavily.com/" },
  { key: "exa", label: "Exa", needsKey: true, hint: "Free monthly credits. ESS uses Fast search with source highlights.", signup: "https://dashboard.exa.ai/api-keys" },
  { key: "firecrawl", label: "Firecrawl", needsKey: true, hint: "Search and page reading use your Firecrawl credits. ESS reads individual pages without starting a site crawl.", signup: "https://www.firecrawl.dev/app/api-keys" },
  { key: "brave", label: "Brave Search", needsKey: true, hint: "Key from the Brave Search API dashboard." },
  { key: "serpapi", label: "SerpApi", needsKey: true, hint: "Key from your SerpApi account." },
  { key: "duckduckgo", label: "DuckDuckGo (no key)", needsKey: false, hint: "Best effort, no key needed. Results can be thinner." },
];

export const searchProviderLabel = (k?: string | null) =>
  SEARCH_PROVIDERS.find((p) => p.key === k)?.label.replace(" (no key)", "") ?? humanize(k ?? "");

/** Name of a mailbox connection by method. */
export function mailMethodLabel(method?: string | null): string {
  if (method === "oauth") return "Gmail · Google sign-in";
  if (method === "imap") return "IMAP mailbox";
  if (method === "mcp") return "Gmail through MCP";
  return humanize(method ?? "Mailbox");
}

export interface TaskDef {
  key: string;
  label: string;
  detail: string;
  critical: boolean;
  /** The MCP tool that submits this work (null: no direct tool). */
  tool: string | null;
}

/** Every task the AI policy knows, in pipeline order. */
export const TASKS: TaskDef[] = [
  { key: "classify_email", label: "Mail sorting", detail: "Sorts incoming mail into work, bills and other groups.", critical: false, tool: "submit_classification" },
  { key: "extract_request", label: "Request reading", detail: "Reads enquiries: deadline, scope, parties and requirements.", critical: true, tool: "submit_project_facts" },
  { key: "analyze_document", label: "Document study", detail: "Studies BOQs, specifications and tender documents.", critical: true, tool: null },
  { key: "analyze_drawing", label: "Drawing study", detail: "Reads drawings: title blocks, levels, equipment marks. Needs vision.", critical: true, tool: "submit_drawing_findings" },
  { key: "draft_quotation", label: "Quotation drafting", detail: "Drafts quotation text and line items. Never prices.", critical: true, tool: "propose_quotation" },
  { key: "discover_business", label: "Business discovery", detail: "Suggests what your company does, from your own mail and files.", critical: true, tool: "add_knowledge" },
  { key: "research_customer", label: "Customer research", detail: "Builds customer profiles with cited web sources.", critical: true, tool: "submit_customer_research" },
];

export const taskLabel = (key: string) => TASKS.find((t) => t.key === key)?.label ?? humanize(key);

const TASK_STATUS: Record<string, StatusInfo> = {
  eligible: { label: "Eligible", tone: "brand" },
  refused: { label: "Not allowed", tone: "block" },
  needs_evaluation: { label: "Needs exam", tone: "review" },
  failed_evaluation: { label: "Failed exam", tone: "block" },
};
export const taskStatusInfo = (k?: string | null): StatusInfo =>
  (k && TASK_STATUS[k]) || { label: k ? humanize(k) : "Unknown", tone: "neutral" };

const TIER: Record<string, string> = {
  frontier: "Frontier",
  standard: "Standard",
  light: "Light",
  refused: "Refused tier",
};
export const tierLabel = (k?: string | null) => (k ? (TIER[k] ?? humanize(k)) : "—");

/** 1000000 → "1M", 128000 → "128k", 1048576 → "1M". */
export function formatTokens(n: number | null | undefined): string {
  if (!n) return "unknown";
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 || Math.abs(m - Math.round(m)) < 0.06 ? Math.round(m) : m.toFixed(1)}M`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function capabilitySummary(caps: ModelCapabilities): string[] {
  const out: string[] = [];
  if (caps.vision === true) out.push("Vision");
  else if (caps.vision === false) out.push("No vision");
  if (caps.context_tokens) out.push(`${formatTokens(caps.context_tokens)} context`);
  if (caps.structured_output === false) out.push("No structured output");
  else if (caps.structured_output === true) out.push("Structured output");
  return out;
}

export const yesNo = (v: boolean | null | undefined, unknown = "Unverified: the exam must prove it") =>
  v === true ? "Yes" : v === false ? "No" : unknown;

/** Score 0..1 → "96%". */
export function pct(score: number | null | undefined): string {
  if (score === null || score === undefined || Number.isNaN(score)) return "—";
  const v = score * 100;
  return `${Number.isInteger(Math.round(v * 10) / 10) ? Math.round(v) : (Math.round(v * 10) / 10).toFixed(1)}%`;
}

/** "classify_email: eligible" entries in AIModelState.reasons → per-task verdicts; other reasons stay general. */
export function splitReasons(reasons: string[] | null | undefined): { general: string[]; tasks: Record<string, string> } {
  const tasks: Record<string, string> = {};
  const general: string[] = [];
  const known = new Set(TASKS.map((t) => t.key));
  for (const r of reasons ?? []) {
    const m = /^([a-z_]+): ([a-z_]+)$/.exec(r);
    if (m && known.has(m[1])) tasks[m[1]] = m[2];
    else general.push(r);
  }
  return { general, tasks };
}

/** Readable model reason: drops the "Settings → AI → Run qualification" pointer we already show as a button. */
export function cleanReason(r: string): string {
  const s = r.replace(/\s*\(Settings → AI → Run qualification\)/, "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
