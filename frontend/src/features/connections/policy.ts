/**
 * The AI quality policy as the screen edits it. The hard floor lives in backend/ess/ai/policy.py (code,
 * not config); the numbers below only keep the form from offering values the backend would raise anyway.
 */
import type { AiPolicy } from "./types";

// ponytail: mirrors the constants in policy.py by hand (GET /ai/policy does not return the floor). Serve them from the backend if they ever change.
export const FLOOR = {
  minScore: 0.9,
  maxExamAgeDays: 30,
  minContextTokens: 128_000,
  maxCriticalFailures: 0,
  /** An admin may treat a "standard" model as frontier only after a full exam at this score. */
  promotionMinScore: 0.95,
} as const;

export interface CapabilityDef {
  key: string;
  label: string;
  detail: string;
  /** Required by the floor: cannot be switched off. */
  locked?: boolean;
}

export const CAPABILITIES: CapabilityDef[] = [
  { key: "structured_output", label: "Structured output", detail: "Answers in a fixed format that can be checked.", locked: true },
  { key: "vision", label: "Vision", detail: "Reads drawings and scanned pages. Drawing study always needs it." },
  { key: "tool_use", label: "Tool use", detail: "Can call functions." },
  { key: "pdf_input", label: "PDF input", detail: "Reads PDF files directly." },
];

export const CONTEXT_CHOICES = [128_000, 200_000, 400_000, 1_000_000];

export interface PolicyDraft {
  minScorePct: string;
  maxAgeDays: string;
  minContext: number;
  capabilities: string[];
  /** Standard-tier models may sort mail (critical tasks are frontier only, always). */
  standardForSorting: boolean;
  blockedProviders: string[];
  blockedPatterns: string[];
  promoted: string[];
  notes: string;
}

const pctText = (score: number) => String(Math.round(score * 1000) / 10);

export function draftFromPolicy(p: AiPolicy): PolicyDraft {
  return {
    minScorePct: pctText(p.min_score),
    maxAgeDays: String(p.max_exam_age_days),
    minContext: p.min_context_tokens,
    capabilities: [...(p.required_capabilities ?? [])],
    standardForSorting: (p.allowed_tiers?.classify_email ?? ["frontier", "standard"]).includes("standard"),
    blockedProviders: [...(p.blocked_providers ?? [])],
    blockedPatterns: [...(p.blocked_patterns ?? [])],
    promoted: [...(p.promoted_models ?? [])],
    notes: p.notes ?? "",
  };
}

/** The whole policy to send back: edited fields from the draft, everything else as the server gave it. */
export function policyFromDraft(d: PolicyDraft, base: AiPolicy): AiPolicy {
  return {
    ...base,
    min_score: Number(d.minScorePct) / 100,
    max_exam_age_days: Math.round(Number(d.maxAgeDays)),
    min_context_tokens: d.minContext,
    required_capabilities: [...new Set(["structured_output", ...d.capabilities])],
    allowed_tiers: { ...base.allowed_tiers, classify_email: d.standardForSorting ? ["frontier", "standard"] : ["frontier"] },
    blocked_providers: d.blockedProviders,
    blocked_patterns: d.blockedPatterns,
    promoted_models: d.promoted,
    notes: d.notes,
  };
}

export type PolicyErrors = Partial<Record<"minScore" | "maxAge", string>>;

export function validateDraft(d: PolicyDraft): PolicyErrors {
  const e: PolicyErrors = {};
  const score = Number(d.minScorePct);
  if (!d.minScorePct.trim() || Number.isNaN(score) || score < FLOOR.minScore * 100 || score > 100) {
    e.minScore = `Enter a score from ${FLOOR.minScore * 100} to 100. The floor is ${FLOOR.minScore * 100}%.`;
  }
  const days = Number(d.maxAgeDays);
  if (!d.maxAgeDays.trim() || !Number.isInteger(days) || days < 1 || days > FLOOR.maxExamAgeDays) {
    e.maxAge = `Enter a whole number of days from 1 to ${FLOOR.maxExamAgeDays}.`;
  }
  return e;
}

export const sameDraft = (a: PolicyDraft, b: PolicyDraft) => JSON.stringify(a) === JSON.stringify(b);

/** Values the backend changed or dropped when it stored the policy (it clamps to the floor). */
export function appliedDifferences(sent: AiPolicy, saved: AiPolicy): string[] {
  const out: string[] = [];
  if (Math.abs(sent.min_score - saved.min_score) > 1e-9) out.push(`Minimum score became ${pctText(saved.min_score)}%.`);
  if (sent.max_exam_age_days !== saved.max_exam_age_days) out.push(`Exam validity became ${saved.max_exam_age_days} days.`);
  if (sent.min_context_tokens !== saved.min_context_tokens) out.push(`Minimum context became ${saved.min_context_tokens.toLocaleString("en-GB")} tokens.`);
  for (const p of sent.blocked_patterns ?? []) if (!(saved.blocked_patterns ?? []).includes(p.trim())) out.push(`The pattern “${p}” is not valid and was ignored.`);
  for (const m of sent.promoted_models ?? []) if (!(saved.promoted_models ?? []).includes(m.trim())) out.push(`“${m}” was ignored: write promoted models as provider:model.`);
  return out;
}
