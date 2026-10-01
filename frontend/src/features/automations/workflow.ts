/**
 * The workflow editor's draft: what a person is changing before it is saved. Pure functions, so the
 * rules (a name, at least one step, an interval of 15 minutes or more, whole-number settings, a
 * locked engineer review step) live in one place and match what the server accepts
 * (backend/ess/api/automations.py).
 */
import type { Automation } from "@/api/types";
import type { CatalogStep, StepPayload, WorkflowPayload } from "./api";

export type Trigger = "manual" | "schedule" | "new_email";
export type Unit = "minutes" | "hours" | "days";

export const UNIT_MINUTES: Record<Unit, number> = { minutes: 1, hours: 60, days: 1440 };
/** The server never runs a schedule more often than this. */
export const MIN_INTERVAL = 15;

export interface DraftStep {
  /** Only for React: a step has no key until the server gives it one. */
  uid: string;
  /** The server's key for a step that was already in the workflow. Kept so run history still points at it. */
  key?: string;
  type: string;
  label: string;
  enabled: boolean;
  requires_approval: boolean;
  config: Record<string, unknown>;
}

export interface Draft {
  name: string;
  description: string;
  trigger: Trigger;
  every: string;
  unit: Unit;
  enabled: boolean;
  steps: DraftStep[];
}

let counter = 0;
export const newUid = () => `step-${++counter}`;

export function splitInterval(minutes: number | null | undefined): { every: string; unit: Unit } {
  const m = minutes && minutes > 0 ? minutes : 60;
  if (m % 1440 === 0) return { every: String(m / 1440), unit: "days" };
  if (m % 60 === 0) return { every: String(m / 60), unit: "hours" };
  return { every: String(m), unit: "minutes" };
}

export function emptyDraft(): Draft {
  return { name: "", description: "", trigger: "manual", every: "1", unit: "hours", enabled: true, steps: [] };
}

const TRIGGERS: Trigger[] = ["manual", "schedule", "new_email"];

export function draftFrom(a: Automation): Draft {
  const { every, unit } = splitInterval(a.interval_minutes);
  return {
    name: a.name,
    description: a.description ?? "",
    trigger: (TRIGGERS as string[]).includes(a.trigger) ? (a.trigger as Trigger) : "manual",
    every,
    unit,
    enabled: a.enabled,
    steps: (a.steps ?? []).map((s) => ({
      uid: newUid(),
      key: s.key,
      type: s.type,
      label: s.label,
      // The server leaves `enabled` out of default steps: only an explicit false skips a step.
      enabled: s.enabled !== false,
      requires_approval: !!s.requires_approval,
      config: { ...(s.config ?? {}) },
    })),
  };
}

export function stepFromCatalog(c: CatalogStep): DraftStep {
  return { uid: newUid(), type: c.type, label: c.label, enabled: true, requires_approval: !!c.locked, config: {} };
}

export function intervalMinutes(d: Pick<Draft, "every" | "unit">): number | null {
  const n = Number(d.every);
  return d.every.trim() && Number.isFinite(n) ? Math.round(n * UNIT_MINUTES[d.unit]) : null;
}

/** Element id of one setting of one step, so a problem can be focused. */
export const configId = (uid: string, key: string) => `${uid}-cfg-${key}`;

export interface Problems {
  name?: string;
  every?: string;
  steps?: string;
  /** configId → message */
  config: Record<string, string>;
}

export const hasProblems = (p: Problems) => !!(p.name || p.every || p.steps || Object.keys(p.config).length);

export function validate(d: Draft, catalog: CatalogStep[]): Problems {
  const p: Problems = { config: {} };
  if (!d.name.trim()) p.name = "Give the workflow a name.";
  if (d.steps.length === 0) p.steps = "Add at least one step.";
  if (d.trigger === "schedule") {
    const n = Number(d.every);
    if (!d.every.trim() || !Number.isInteger(n) || n < 1) p.every = "Enter a whole number.";
    else if (n * UNIT_MINUTES[d.unit] < MIN_INTERVAL) p.every = `Use at least ${MIN_INTERVAL} minutes.`;
  }
  for (const s of d.steps) {
    for (const c of catalog.find((x) => x.type === s.type)?.config ?? []) {
      const v = s.config[c.key];
      if (c.type === "number" && v !== undefined && v !== "" && !(typeof v === "number" && Number.isInteger(v) && v >= 1)) {
        p.config[configId(s.uid, c.key)] = "Enter a whole number of 1 or more.";
      }
    }
  }
  return p;
}

/** What is sent. The locked engineer review step is always on and always waits for a person. */
export function toPayload(d: Draft, catalog: CatalogStep[], mode: "create" | "edit"): WorkflowPayload {
  const steps: StepPayload[] = d.steps.map((s) => {
    const def = catalog.find((c) => c.type === s.type);
    const locked = !!def?.locked;
    return {
      ...(s.key ? { key: s.key } : {}),
      type: s.type,
      label: s.label.trim() || def?.label || s.type,
      enabled: locked ? true : s.enabled,
      requires_approval: locked ? true : s.requires_approval,
      config: s.config,
    };
  });
  return {
    name: d.name.trim(),
    description: d.description.trim(),
    trigger: d.trigger,
    interval_minutes: d.trigger === "schedule" ? intervalMinutes(d) : null,
    steps,
    ...(mode === "create" ? { enabled: d.enabled } : {}),
  };
}

/** True when nothing a person can edit differs. */
export function sameDraft(a: Draft, b: Draft): boolean {
  const flat = (d: Draft) =>
    JSON.stringify([
      d.name,
      d.description,
      d.trigger,
      d.trigger === "schedule" ? [d.every, d.unit] : null,
      d.enabled,
      d.steps.map((s) => [s.key ?? null, s.type, s.label, s.enabled, s.requires_approval, s.config]),
    ]);
  return flat(a) === flat(b);
}
