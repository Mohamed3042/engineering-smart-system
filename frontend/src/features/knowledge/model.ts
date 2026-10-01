/**
 * Business-knowledge vocabulary: finding kinds, evidence source types and their weights,
 * claim basis, regions, languages and lesson kinds. Shapes follow backend/ess/knowledge and
 * backend/ess/learning.py.
 */
import type { Evidence, KnowledgeItem } from "@/api/types";
import { humanize } from "@/lib/format";
import { claimBasisLabel, type Tone } from "@/lib/labels";

export type KnowledgeKind = "service_family" | "work_type" | "term" | "standard" | "convention" | "identity";

export const KIND_LABELS: Record<string, { one: string; many: string; add: string }> = {
  service_family: { one: "Service family", many: "Service families", add: "Add service family" },
  work_type: { one: "Work type", many: "Work types", add: "Add work type" },
  term: { one: "Term", many: "Terms", add: "Add term" },
  standard: { one: "Standard", many: "Standards", add: "Add standard" },
  convention: { one: "Document convention", many: "Document conventions", add: "Add convention" },
  identity: { one: "Business identity", many: "Business identity", add: "Add identity" },
};

export const kindLabel = (k: string, many = false) => (KIND_LABELS[k] ? KIND_LABELS[k][many ? "many" : "one"] : humanize(k));

/** Only these kinds feed mail sorting (backend: _sync_category). */
export const SORTING_KINDS = new Set(["service_family", "term"]);

/* ------------------------------------------------------------------ evidence sources */

export interface SourceTypeInfo {
  label: string;
  plural: string;
  weight: number;
  /** Web pages give context; they never count as proof. */
  contextOnly?: boolean;
  order: number;
}

export const SOURCE_TYPES: Record<string, SourceTypeInfo> = {
  own_quotation: { label: "Own quotation", plural: "Own quotations", weight: 1, order: 0 },
  quotation_corpus: { label: "Own quotations", plural: "Own quotations", weight: 1, order: 0 },
  owner: { label: "Owner", plural: "Owner", weight: 1, order: 0 },
  company_doc: { label: "Company document", plural: "Company documents", weight: 0.9, order: 1 },
  sent_email: { label: "Sent mail", plural: "Sent mail", weight: 0.8, order: 2 },
  inbound_email: { label: "Received mail", plural: "Received mail", weight: 0.5, order: 3 },
  web: { label: "Web page", plural: "Web pages", weight: 0.2, contextOnly: true, order: 4 },
};

export function sourceInfo(type: string | undefined): SourceTypeInfo {
  const t = type ?? "";
  return SOURCE_TYPES[t] ?? { label: humanize(t) || "Source", plural: humanize(t) || "Sources", weight: 0, order: 5 };
}

export function evidenceWeight(e: Evidence): number {
  const w = typeof e.weight === "number" ? e.weight : Number(e.weight);
  return Number.isFinite(w) && w > 0 ? w : sourceInfo(e.source_type).weight;
}

/** Strongest source first. */
export function sortEvidence(list: Evidence[] | null | undefined): Evidence[] {
  return [...(list ?? [])].sort(
    (a, b) => evidenceWeight(b) - evidenceWeight(a) || sourceInfo(a.source_type).order - sourceInfo(b.source_type).order,
  );
}

/** "Own quotations ×2 · Received mail ×1" groups for a compact summary. */
export function evidenceGroups(list: Evidence[] | null | undefined) {
  const map = new Map<string, { type: string; info: SourceTypeInfo; count: number }>();
  for (const e of list ?? []) {
    const info = sourceInfo(e.source_type);
    const key = info.plural;
    const cur = map.get(key);
    if (cur) cur.count += 1;
    else map.set(key, { type: e.source_type ?? "", info, count: 1 });
  }
  return [...map.values()].sort((a, b) => a.info.order - b.info.order);
}

/** The evidence weight table shown to the owner (backend: knowledge/corpus.py SOURCE_WEIGHTS). */
export const WEIGHT_TABLE: { type: string; label: string; weight: number; note?: string }[] = [
  { type: "own_quotation", label: "Your own quotations", weight: 1.0 },
  { type: "company_doc", label: "Company documents", weight: 0.9 },
  { type: "sent_email", label: "Mail you sent", weight: 0.8 },
  { type: "inbound_email", label: "Mail you received", weight: 0.5 },
  { type: "web", label: "Web pages", weight: 0.2, note: "Context only, never proof" },
];

export const formatWeight = (w: number) => w.toFixed(1);

/** Link for an evidence source: mail opens in the inbox, web pages open the page. Files from
 * company folders stay on this computer and have no in-app viewer. */
export function evidenceLink(e: Evidence): string | null {
  const id = e.source_id ?? "";
  if (!id) return null;
  if (e.source_type === "sent_email" || e.source_type === "inbound_email" || e.source_type === "email")
    return `/inbox/${encodeURIComponent(id)}`;
  if (/^https?:\/\//i.test(id)) return id;
  if (typeof e.url === "string" && /^https?:\/\//i.test(e.url)) return e.url;
  return null;
}

/* ------------------------------------------------------------------ claim basis */

export interface ClaimInfo {
  label: string;
  tone: Tone;
  hint: string;
}

/** What the finding rests on: work the company delivered, its own catalogue, or only market words. */
export function claimInfo(k: string | null | undefined): ClaimInfo | null {
  switch (k) {
    case "delivered_work":
      return { label: claimBasisLabel(k), tone: "brand", hint: "Seen in your own quotations or sent mail." };
    case "both":
      return {
        label: "Delivered work and catalogue",
        tone: "brand",
        hint: "Seen in your quotations or sent mail, and in company documents.",
      };
    case "catalogue_claim":
      return {
        label: claimBasisLabel(k),
        tone: "neutral",
        hint: "Only company documents say so. Not yet seen in delivered work.",
      };
    case "market_vocabulary":
      return {
        label: claimBasisLabel(k),
        tone: "muted",
        hint: "Customers use these words. That alone does not prove you do this work.",
      };
    case "owner":
      return { label: claimBasisLabel(k), tone: "brand", hint: "Added or stated by a person." };
    default:
      return k ? { label: claimBasisLabel(k), tone: "neutral", hint: "" } : null;
  }
}

/* ------------------------------------------------------------------ regions & languages */

const REGION_FALLBACK: Record<string, string> = {
  GCC: "Gulf / Middle East",
  UK_EU: "UK / Europe",
  US: "North America",
  RU_CIS: "Russia / CIS",
  SOUTH_ASIA: "South Asia",
  global: "All regions",
};

export interface RegionDef {
  key: string;
  label: string;
}

/** Region label; the library calls the global region "GLOBAL", shown here as "All regions". */
export function regionLabel(key: string | null | undefined, regions?: RegionDef[]): string {
  if (!key) return "Any region";
  if (key === "global") return REGION_FALLBACK.global;
  return regions?.find((r) => r.key === key)?.label ?? REGION_FALLBACK[key] ?? key;
}

export const REGION_KEYS = ["GCC", "UK_EU", "US", "RU_CIS", "SOUTH_ASIA", "global"];

const LANGUAGES: Record<string, string> = {
  en: "English",
  ar: "Arabic",
  ru: "Russian",
  hi: "Hindi",
  ur: "Urdu",
  fr: "French",
};

export const languageLabel = (k: string | null | undefined) => (k ? (LANGUAGES[k] ?? k.toUpperCase()) : "Any language");
export const LANGUAGE_OPTIONS = Object.entries(LANGUAGES).map(([value, label]) => ({ value, label }));

/* ------------------------------------------------------------------ item helpers */

export const STATUS_ORDER: Record<string, number> = { suggested: 0, owner_confirmed: 1, rejected: 2 };

export function sortForReview(items: KnowledgeItem[]): KnowledgeItem[] {
  return [...items].sort(
    (a, b) =>
      (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3) ||
      (b.confidence ?? 0) - (a.confidence ?? 0) ||
      a.label.localeCompare(b.label),
  );
}

/** Mail category a service family or term feeds when used for sorting (value.category). */
export function mappedCategory(item: KnowledgeItem): string | null {
  const v = item.value;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const c = (v as Record<string, unknown>).category;
    return typeof c === "string" && c ? c : null;
  }
  return null;
}

export function valueRecord(item: KnowledgeItem): Record<string, unknown> {
  const v = item.value;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The wording before the owner's first edit (backend keeps it in `original`). */
export function originalOf(item: KnowledgeItem): Record<string, any> | null {
  const o = item.original as Record<string, any> | null | undefined;
  return o && typeof o === "object" && Object.keys(o).length > 0 ? o : null;
}

export function synonymsOf(item: KnowledgeItem): string[] {
  return (item.synonyms ?? []).map((s) => (typeof s === "string" ? s : String((s as { term?: string })?.term ?? s))).filter(Boolean);
}

/** Short text for a structured value (conventions, standards). */
export function formatValue(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map((x) => formatValue(x)).filter(Boolean).join(" · ") || null;
  if (typeof v === "object") {
    const parts = Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => {
        const f = formatValue(x);
        return f ? `${humanize(k)}: ${f}` : null;
      })
      .filter(Boolean);
    return parts.length ? parts.join(" · ") : null;
  }
  return null;
}

/* ------------------------------------------------------------------ roles */

const ROLE_RANK: Record<string, number> = { viewer: 0, sales: 1, engineer: 2, admin: 3, owner: 4 };

/** Same ranking as backend/ess/api/deps.py. */
export function hasRole(role: string | null | undefined, minimum: "viewer" | "sales" | "engineer" | "admin" | "owner") {
  return (ROLE_RANK[role ?? ""] ?? 0) >= ROLE_RANK[minimum];
}

/* ------------------------------------------------------------------ lessons */

export interface LessonKindInfo {
  key: string;
  label: string;
  many: string;
  hint: string;
}

export const LESSON_KINDS: LessonKindInfo[] = [
  {
    key: "category_correction",
    label: "Mail category",
    many: "Mail categories",
    hint: "Someone moved a message to another category. Mail from that sender is sorted the same way next time.",
  },
  {
    key: "template_choice",
    label: "Template choice",
    many: "Template choices",
    hint: "Someone chose another template, paper, language or signatory. After two choices it becomes the default for that kind of project.",
  },
  {
    key: "quotation_edit",
    label: "Quotation edit",
    many: "Quotation edits",
    hint: "Someone changed lines, exclusions or the subject of a drafted quotation.",
  },
  {
    key: "review_note",
    label: "Review note",
    many: "Review notes",
    hint: "An engineer asked for changes during a review.",
  },
  {
    key: "change_request",
    label: "Change request",
    many: "Change requests",
    hint: "Someone asked for changes to a quotation before approving it.",
  },
  {
    key: "fact_correction",
    label: "Fact correction",
    many: "Fact corrections",
    hint: "Someone corrected a project fact such as the service family or a requirement.",
  },
  {
    key: "knowledge_feedback",
    label: "Business finding",
    many: "Business findings",
    hint: "The owner confirmed or rejected a business finding.",
  },
];

export const lessonKindInfo = (k: string): LessonKindInfo =>
  LESSON_KINDS.find((x) => x.key === k) ?? { key: k, label: humanize(k), many: humanize(k), hint: "" };

export const LESSON_SCOPES: Record<string, string> = {
  workspace: "Whole workspace",
  customer: "Customer",
  sender: "Sender",
  domain: "Mail domain",
  service_family: "Service family",
};

/** New synonym list after the owner edited the tags: entries that stay keep their stored form (text or {term, …}). */
export function mergeSynonyms(original: unknown[] | null | undefined, tags: string[]): unknown[] {
  const text = (s: unknown) => (typeof s === "string" ? s : String((s as { term?: string } | null)?.term ?? s));
  const byText = new Map((original ?? []).map((s) => [text(s).toLowerCase(), s]));
  return tags.map((t) => byText.get(t.toLowerCase()) ?? t);
}

/** Owner decisions on a finding, in the words the screens use. */
export const STATUS_FILTERS = [
  { value: "all", label: "All" },
  { value: "suggested", label: "To review" },
  { value: "owner_confirmed", label: "Confirmed" },
  { value: "rejected", label: "Rejected" },
] as const;

export type StatusFilter = (typeof STATUS_FILTERS)[number]["value"];
