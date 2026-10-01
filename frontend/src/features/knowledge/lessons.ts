/**
 * Turns a stored lesson (backend/ess/learning.py) into lines a person can read: what changed, from what to what.
 * The shapes of `before` and `after` depend on the kind of correction.
 */
import type { Lesson } from "@/api/types";
import { humanize } from "@/lib/format";
import { workTypeLabel } from "@/lib/labels";
import { languageLabel, LESSON_SCOPES } from "./model";

export type ChangeLine =
  | { type: "move"; label?: string; from: string; to: string }
  | { type: "added"; label: string; items: string[] }
  | { type: "removed"; label: string; items: string[] }
  | { type: "note"; text: string };

const text = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "nothing";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
};

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => text(x)).filter((x) => x !== "nothing") : []);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function lessonLines(l: Lesson, categoryLabel: (key: string | null | undefined) => string): ChangeLine[] {
  const before = rec(l.before);
  const after = rec(l.after);
  const lines: ChangeLine[] = [];

  switch (l.kind) {
    case "category_correction":
      lines.push({ type: "move", label: "Mail category", from: categoryLabel(text(l.before)), to: categoryLabel(text(l.after)) });
      break;
    case "template_choice": {
      for (const [key, label] of [
        ["template_key", "Template"],
        ["language", "Language"],
        ["paper_id", "Paper"],
        ["signatory_id", "Signatory"],
      ] as const) {
        if (after[key] === undefined || after[key] === null) continue;
        const show = (v: unknown) => (key === "language" ? languageLabel(String(v)) : key === "template_key" ? workTypeLabel(String(v)) : text(v));
        lines.push({ type: "move", label, from: before[key] === undefined ? "the default" : show(before[key]), to: show(after[key]) });
      }
      break;
    }
    case "quotation_edit": {
      const subject = Array.isArray(after.subject) ? (after.subject as unknown[]) : null;
      if (subject) lines.push({ type: "move", label: "Subject", from: text(subject[0]), to: text(subject[1]) });
      if (strings(after.added_items).length) lines.push({ type: "added", label: "Lines added", items: strings(after.added_items) });
      if (strings(after.removed_items).length) lines.push({ type: "removed", label: "Lines removed", items: strings(after.removed_items) });
      if (strings(after.added_exclusions).length) lines.push({ type: "added", label: "Exclusions added", items: strings(after.added_exclusions) });
      if (strings(after.removed_exclusions).length) lines.push({ type: "removed", label: "Exclusions removed", items: strings(after.removed_exclusions) });
      break;
    }
    case "fact_correction":
      lines.push({ type: "move", from: text(l.before), to: text(l.after) });
      break;
    case "knowledge_feedback":
      lines.push({
        type: "move",
        label: humanize(l.scope_key) || "Finding",
        from: "suggested",
        to: l.after === "owner_confirmed" ? "confirmed by the owner" : l.after === "rejected" ? "rejected by the owner" : text(l.after),
      });
      break;
    default:
      break;
  }
  if (l.note) lines.push({ type: "note", text: l.note });
  return lines;
}

/** "Sender · sam@example.com", "Service family · Building Maintenance Units · Supply & installation". */
export function lessonScope(l: Lesson, categoryLabel: (key: string | null | undefined) => string): string {
  const scope = LESSON_SCOPES[l.scope] ?? humanize(l.scope);
  if (!l.scope_key) return scope;
  if (l.scope === "service_family") {
    const [family, workType] = l.scope_key.split("|");
    return [scope, categoryLabel(family), workType ? workTypeLabel(workType) : null].filter(Boolean).join(" · ");
  }
  if (l.scope === "workspace" && l.kind === "knowledge_feedback") return scope;
  return `${scope} · ${l.scope_key}`;
}
