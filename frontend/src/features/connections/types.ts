/**
 * Shapes returned by the connection and AI endpoints (backend/ess/api/connections.py, api/ai.py),
 * narrowed from the loose shared types.
 */
import type { AIModelState, Connection, ISODateTime, OmitKnown } from "@/api/types";

export interface SecretHint {
  set: boolean;
  /** "…1234" or "stored"; the value itself is never returned. */
  hint: string | null;
}

export type ConnectionRow = Connection & { secrets?: Record<string, SecretHint> };

/** POST /api/connections/{id}/test */
export interface TestResult {
  ok: boolean;
  error?: string | null;
  account?: string | null;
  /** AI over API: number of models the key can use. */
  models?: number;
  /** Web search: number of results for a test query. */
  results?: number;
  /** Gmail API */
  messages_total?: number | null;
  /** IMAP */
  inbox_messages?: number | null;
  /** MCP mail: tools the server offers. */
  tools?: string[];
  /** AI over MCP: the last client seen. */
  client?: { client?: string; model?: string; at?: string } | null;
  message?: string;
  connection: ConnectionRow;
  [k: string]: unknown;
}

export interface ModelCapabilities {
  structured_output?: boolean | null;
  vision?: boolean | null;
  tool_use?: boolean | null;
  context_tokens?: number | null;
  pdf_input?: boolean | null;
}

export interface ExamCheck {
  check: string;
  passed: boolean;
  critical: boolean;
  weight: number;
  info: string;
}

export interface ExamCase {
  id: string;
  task: string;
  title: string;
  passed: boolean;
  score: number;
  details: ExamCheck[];
  error: string | null;
}

export interface CriticalFailure {
  case?: string;
  check?: string;
  detail?: string;
}

/** An exam record (ess/ai/qualification.py). A record the runner could not finish has string failures. */
export interface ExamRecord {
  provider?: string;
  model?: string;
  score?: number;
  passed?: boolean;
  critical_failures?: Array<CriticalFailure | string>;
  cases?: ExamCase[];
  ran_at?: string;
  exam_version?: string;
  tasks?: string[];
  task_results?: Record<string, { cases: number; passed: number; score: number }>;
  threshold?: number;
  /** "api" (run by this app) or "external" (answered by an MCP client) */
  mode?: string;
  duration_s?: number;
  signature?: string;
  [k: string]: unknown;
}

export type ModelItem = OmitKnown<AIModelState, "capabilities" | "exam"> & {
  capabilities: ModelCapabilities;
  exam: ExamRecord;
};

/** GET /api/ai/models */
export interface ModelsResponse {
  provider: string | null;
  selected: string | null;
  items: ModelItem[];
}

export interface TaskVerdict {
  status: string;
  reasons: string[];
}

/** GET /api/ai/status */
export interface AiStatus {
  method: "api" | "mcp" | null;
  api: {
    provider: string;
    model: string | null;
    status: string;
    eligibility: string | null;
    reasons: string[];
  } | null;
  mcp: {
    /** "declared" without a saved MCP connection, else the connection status. */
    status: string;
    declared: { provider: string; model_id: string; client: string; declared_at: string } | null;
    tasks: Record<string, TaskVerdict>;
    eligibility: string | null;
    reasons: string[];
    exam: ExamRecord | null;
    evaluated_at: ISODateTime | null;
  } | null;
  rules_only: boolean;
}

/** GET/PUT /api/ai/policy */
export interface AiPolicy {
  version: number;
  min_score: number;
  max_exam_age_days: number;
  min_context_tokens: number;
  required_capabilities: string[];
  task_capabilities: Record<string, string[]>;
  allowed_tiers: Record<string, string[]>;
  blocked_patterns: string[];
  blocked_providers: string[];
  promoted_models: string[];
  notes: string;
  max_critical_failures?: number;
  [k: string]: unknown;
}

/** GET /api/ai/providers */
export interface AiProvider {
  key: string;
  label: string;
  fields: string[];
  optional: string[];
}

/** A ready-to-copy client setup: a shell command or a JSON config. */
export interface McpClientSetup {
  name: string;
  kind: "command" | "json" | string;
  value: unknown;
}

/** GET /api/mcp/info */
export interface McpInfo {
  url: string;
  stdio_command: string;
  token_required: boolean;
  clients?: McpClientSetup[];
  rules: string[];
}
