/**
 * Customer vocabulary: statuses, tag groups, research standards and evidence helpers.
 * Research criteria mirror EVIDENCE_STANDARDS in backend/ess/customers/research.py.
 */
import type { Evidence, Lesson } from "@/api/types";
import { formatDate, humanize } from "@/lib/format";
import type { StatusInfo } from "@/lib/labels";
import { emailHref, projectHref } from "@/lib/routes";
import type { CustomerProjectRef, ResearchSource, Tag, TagEvidence } from "./api";

function lookup(map: Record<string, StatusInfo>, key: string | null | undefined, fallback?: StatusInfo): StatusInfo {
  if (!key) return fallback ?? { label: "—", tone: "muted" };
  return map[key] ?? { label: humanize(key), tone: "neutral" };
}

/* ------------------------------------------------------------------ customer status */

const PROFILE_STATUS: Record<string, StatusInfo> = {
  none: { label: "No research", tone: "muted" },
  researching: { label: "Researching", tone: "neutral" },
  ready: { label: "Profile ready", tone: "brand" },
  partial: { label: "Partly researched", tone: "review" },
};
export const profileStatusInfo = (k?: string | null) => lookup(PROFILE_STATUS, k, PROFILE_STATUS.none);

const CUSTOMER_STATUS: Record<string, StatusInfo> = {
  active: { label: "Active", tone: "neutral" },
  prospect: { label: "Prospect", tone: "neutral" },
  dormant: { label: "Dormant", tone: "muted" },
};
export const customerStatusInfo = (k?: string | null) => lookup(CUSTOMER_STATUS, k);

/** Kinds the backend assigns (tagging.CUSTOMER_KINDS). */
export const CUSTOMER_KINDS = [
  "main_contractor",
  "subcontractor",
  "consultant",
  "developer",
  "government",
  "facility_management",
  "supplier",
  "other",
] as const;

/* ------------------------------------------------------------------ tags */

export const TAG_GROUPS: { kind: string; label: string; hint: string }[] = [
  { kind: "role", label: "Role", hint: "What kind of company this is" },
  { kind: "sector", label: "Sectors", hint: "Where their projects are" },
  { kind: "need", label: "Asked us for", hint: "Services named in their enquiries" },
  { kind: "behaviour", label: "Behaviour", hint: "How they work with us" },
  { kind: "relationship", label: "Relationship", hint: "Where the relationship stands" },
  { kind: "user", label: "Added by people", hint: "Tags a person added" },
];

/** Group key for a tag: person-added tags form their own group. */
export function tagGroup(t: Tag): string {
  if (t.source === "user") return "user";
  return TAG_GROUPS.some((g) => g.kind === t.kind) ? (t.kind as string) : "role";
}

/** Tags worth showing next to a name (the main role is shown separately as the kind). */
export function displayTags(tags: Tag[], kind: string): Tag[] {
  return tags.filter((t) => !(t.kind === "role" && !t.subtype && (t.key === kind || !t.key)));
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9؀-ۿ]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

export function userTag(label: string): Tag {
  return { tag: label.trim(), kind: "user", key: slug(label), confidence: 1, evidence: [], source: "user" };
}

/** Comma- or line-separated tag text → unique trimmed labels. */
export function parseTagInput(text: string): string[] {
  const seen = new Set<string>();
  return text
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter((t) => {
      const k = t.toLowerCase();
      if (!t || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

/** A tag's evidence as the shared Evidence shape (for EvidenceQuote), with a link where one exists. */
export function tagEvidence(e: TagEvidence, projects: CustomerProjectRef[] = []): { evidence: Evidence; href: string | null; isQuote: boolean } {
  const src = e.source ?? "";
  if (src === "email") {
    return {
      evidence: { quote: e.quote, source_type: "email", source_id: e.ref ?? undefined, source_label: e.date ? `E-mail, ${formatDate(e.date)}` : "E-mail" },
      href: e.ref ? emailHref(e.ref) : null,
      isQuote: true,
    };
  }
  if (src === "project") {
    const p = projects.find((x) => x.id === e.ref || x.name === e.ref);
    return {
      evidence: { quote: e.quote, source_type: "project", source_label: p ? `Project: ${p.name}` : "Project record" },
      href: p ? projectHref(p.id) : null,
      isQuote: true,
    };
  }
  // rules / mail / scan: a reason, not a quotation from a source
  return { evidence: { quote: e.quote, source_type: src, source_label: src === "mail" ? "Mail history" : "Name and signature cues" }, href: null, isQuote: false };
}

/* ------------------------------------------------------------------ opportunities */

/** Fit from the suggestion score (0..1). */
export function fitInfo(score: number | null | undefined): StatusInfo {
  const s = score ?? 0;
  if (s >= 0.6) return { label: "Strong fit", tone: "brand" };
  if (s >= 0.35) return { label: "Possible fit", tone: "neutral" };
  return { label: "Weak fit", tone: "muted" };
}

const OPP_STATUS: Record<string, StatusInfo> = {
  suggested: { label: "Needs review", tone: "review" },
  accepted: { label: "Accepted", tone: "brand" },
  dismissed: { label: "Dismissed", tone: "muted" },
};
export const opportunityStatusInfo = (k?: string | null) => lookup(OPP_STATUS, k);

/* ------------------------------------------------------------------ updates */

const UPDATE_KIND: Record<string, StatusInfo> = {
  news: { label: "News", tone: "neutral" },
  project: { label: "New project", tone: "brand" },
  tender: { label: "Tender", tone: "review" },
  contract_award: { label: "Contract award", tone: "brand" },
  people: { label: "People", tone: "neutral" },
  enquiry: { label: "Enquiry", tone: "neutral" },
};
export const updateKindInfo = (k?: string | null) => lookup(UPDATE_KIND, k);

export const UPDATE_FILTERS = [
  { value: "all", label: "All" },
  { value: "project", label: "Projects" },
  { value: "tender", label: "Tenders" },
  { value: "contract_award", label: "Awards" },
  { value: "news", label: "News" },
  { value: "people", label: "People" },
];

export function hostOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ research */

export interface StandardInfo {
  value: "basic" | "standard" | "deep";
  label: string;
  summary: string;
  needs: string[];
  effort: string;
}

export const RESEARCH_STANDARDS: StandardInfo[] = [
  {
    value: "basic",
    label: "Basic",
    summary: "Confirms who the company is. Any section may stay “not found”.",
    needs: [
      "One source confirms the company: its own website, a registry entry or our e-mails with them",
      "Claims quote their source; a search snippet is accepted as shown",
    ],
    effort: "Up to 3 searches and 3 pages",
  },
  {
    value: "standard",
    label: "Standard",
    summary: "Every claim quotes its source word for word. Key facts aim for two sources.",
    needs: [
      "Everything in Basic",
      "Quotes are checked against the page text",
      "What they do, size and current projects aim for two sources; one official source is enough",
    ],
    effort: "Up to 6 searches and 8 pages, news from the last 12 months",
  },
  {
    value: "deep",
    label: "Deep",
    summary: "Adds a 12-month news search and two independent sources for current projects.",
    needs: [
      "Everything in Standard",
      "News for the last 12 months must be searched",
      "Each current project needs two independent sources",
    ],
    effort: "Up to 10 searches and 14 pages",
  },
];

export const standardInfo = (k?: string | null) => RESEARCH_STANDARDS.find((s) => s.value === k) ?? RESEARCH_STANDARDS[1];

export const RESEARCH_SECTIONS: { key: string; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "business_lines", label: "Business lines" },
  { key: "projects_current", label: "Current projects" },
  { key: "projects_past", label: "Past projects" },
  { key: "news", label: "News" },
  { key: "people", label: "People" },
  { key: "relationship_with_us", label: "Relationship with us" },
  { key: "opportunities", label: "Opportunities" },
];
export const sectionLabel = (k?: string | null) => RESEARCH_SECTIONS.find((s) => s.key === k)?.label ?? humanize(k);

const SECTION_STATUS: Record<string, StatusInfo> = {
  found: { label: "Found", tone: "brand" },
  partial: { label: "Below standard", tone: "review" },
  not_found: { label: "Not found", tone: "muted" },
};
export const sectionStatusInfo = (k?: string | null) => lookup(SECTION_STATUS, k);

const RESEARCH_STATUS: Record<string, StatusInfo> = {
  running: { label: "Researching", tone: "neutral" },
  paused: { label: "Saved · paused", tone: "review" },
  done: { label: "Finished", tone: "neutral" },
  failed: { label: "Failed", tone: "block" },
};
export const researchStatusInfo = (k?: string | null) => lookup(RESEARCH_STATUS, k);

const SOURCE_KIND: Record<string, string> = {
  official: "Company website",
  registry: "Company registry",
  news: "News site",
  directory: "Directory",
  own_email: "Our e-mail",
  internal: "Our records",
  other: "Other website",
};
export const sourceKindLabel = (k?: string | null) => (k ? (SOURCE_KIND[k] ?? humanize(k)) : "Source");

const VERIFICATION: Record<string, string> = {
  page: "Quote found on the page",
  snippet: "Search snippet only",
  own_email: "From our records",
};
export const verificationLabel = (k?: string | null) => (k ? (VERIFICATION[k] ?? humanize(k)) : "");

const GAP_KIND: Record<string, StatusInfo> = {
  identity_unconfirmed: { label: "Identity not confirmed", tone: "block" },
  news_not_searched: { label: "News not searched", tone: "block" },
  below_standard: { label: "Below standard", tone: "review" },
  not_found: { label: "Not found", tone: "muted" },
  no_search_provider: { label: "No web search", tone: "review" },
  source_error: { label: "Source error", tone: "neutral" },
  unverified_claim_dropped: { label: "Claim dropped", tone: "neutral" },
  unverified_quote_dropped: { label: "Quote dropped", tone: "neutral" },
  ai_gap: { label: "Open question", tone: "neutral" },
};
export const gapKindInfo = (k?: string | null) => lookup(GAP_KIND, k);

/** Where a research source can be opened: web pages open in a new tab, our e-mails in the inbox. */
export function researchSourceHref(s: ResearchSource): string | null {
  const url = s.url ?? "";
  if (/^https?:\/\//i.test(url)) return url;
  const m = /^(?:email[\s:]|mail:)\s*(.+)$/i.exec(url);
  if (m) return emailHref(m[1].trim());
  return null;
}

export function researchSourceTitle(s: ResearchSource): string {
  if (s.kind === "own_email") return s.title && s.title !== "Our e-mail" ? s.title : "Our e-mail with them";
  if (s.kind === "internal") return s.title || "Our records";
  return s.title || hostOf(s.url) || s.url;
}

/* ------------------------------------------------------------------ lessons */

const LESSON_KIND: Record<string, string> = {
  category_correction: "Mail category corrected",
  template_choice: "Template chosen",
  quotation_edit: "Draft quotation edited",
  review_note: "Engineer review note",
  change_request: "Change requested",
  fact_correction: "Fact corrected",
  knowledge_feedback: "Business knowledge feedback",
};
export const lessonKindLabel = (k?: string | null) => (k ? (LESSON_KIND[k] ?? humanize(k)) : "Lesson");

export function lessonScopeLabel(l: Lesson): string {
  if (l.scope === "customer") return "This customer";
  if (l.scope === "domain") return `Mail from ${l.scope_key}`;
  if (l.scope === "sender") return `Mail from ${l.scope_key}`;
  return humanize(l.scope);
}

/** Short readable text for a lesson's before/after value (strings, keys or small objects). */
export function lessonValue(v: unknown, label?: (key: string) => string): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string") return label ? label(v) : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map((x) => lessonValue(x, label)).filter(Boolean).join(", ");
  if (typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== null && x !== undefined && !(Array.isArray(x) && x.length === 0))
      .map(([k, x]) => `${humanize(k)}: ${lessonValue(x) ?? "—"}`)
      .join(" · ");
  }
  return String(v);
}

/* ------------------------------------------------------------------ misc */

/** "https://www.example.com/about" or "info@example.com" → "example.com". */
export function domainFromInput(text: string): string {
  const t = text.trim().toLowerCase();
  if (!t) return "";
  const at = t.lastIndexOf("@");
  if (at >= 0) return t.slice(at + 1).replace(/[/\s].*$/, "");
  return t
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#:].*$/, "");
}

export function websiteHref(site: string | null | undefined): string | null {
  if (!site) return null;
  return /^https?:\/\//i.test(site) ? site : `https://${site}`;
}

export function locationLine(city?: string | null, country?: string | null): string {
  return [city, country].filter(Boolean).join(", ");
}
