/**
 * Pure helpers for the quotation builder: money, line totals, gates (what blocks approval and
 * sending), labels and API error explanations. No React here except the role hook.
 */
import { ApiError } from "@/api/client";
import { useCurrentUser } from "@/api/session";
import type { Evidence, Project, ScopeItem, Workspace } from "@/api/types";
import { formatDate, formatMoney, humanize } from "@/lib/format";
import { requestKindLabel, reviewStatusInfo, serviceFamilyFallback, workTypeLabel } from "@/lib/labels";
import { projectHref, quotationHref } from "@/lib/routes";
import type { Line, Paper, Quote, QuoteDetail, SignatoryRow, TemplateInfo, Term } from "./api";

/* ------------------------------------------------------------------ roles */

export const ROLE_RANK: Record<string, number> = { viewer: 0, sales: 1, engineer: 2, admin: 3, owner: 4 };

/** "Approving needs the engineer role (you are sales)." or null when allowed. */
export function useRoleGate() {
  const user = useCurrentUser();
  const role = user?.role ?? "viewer";
  return (minimum: "sales" | "engineer" | "admin", action: string): string | null =>
    (ROLE_RANK[role] ?? 0) >= ROLE_RANK[minimum] ? null : `${action} needs the ${minimum} role (you are ${role}).`;
}

/* ------------------------------------------------------------------ money */

const THREE_DECIMALS = new Set(["KWD", "KD", "BHD", "OMR", "JOD", "IQD", "LYD", "TND"]);

export function moneyDigits(currency?: string | null): number {
  return THREE_DECIMALS.has((currency ?? "").toUpperCase()) ? 3 : 2;
}

export function money(n: number | null | undefined, currency?: string | null, withCode = true): string {
  return formatMoney(n, withCode ? (currency ?? undefined) : undefined, moneyDigits(currency));
}

/** "12,500.5" / "12 500" / " 7 " → number; anything else → null. */
export function parseAmount(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/[,\s]/g, "");
  if (!/^[-+]?\d*\.?\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function round(n: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function lineTotal(line: Line): number | null {
  const qty = parseAmount(line.qty);
  const price = parseAmount(line.unit_price);
  if (qty === null || price === null) return null;
  return round(qty * price, 3);
}

export function hasPrice(line: Line): boolean {
  return parseAmount(line.unit_price) !== null;
}

/** Matches backend drafting.missing_prices: a line needs a price unless it is "included". */
export function missingPriceLines(items: Line[] | undefined): number[] {
  return (items ?? []).flatMap((l, i) => (!hasPrice(l) && !l.included ? [i + 1] : []));
}

export interface Totals {
  total: number | null;
  /** Lines that count towards the total (not optional, not included). */
  counted: number;
  missing: number;
  optionalTotal: number | null;
  optionalCount: number;
}

export function totals(items: Line[] | undefined): Totals {
  let sum = 0;
  let counted = 0;
  let missing = 0;
  let opt = 0;
  let optionalCount = 0;
  for (const line of items ?? []) {
    if (line.included) continue;
    const t = lineTotal(line);
    if (line.optional) {
      optionalCount++;
      if (t !== null) opt += t;
      continue;
    }
    counted++;
    if (t === null) missing++;
    else sum += t;
  }
  return {
    total: counted > 0 && missing === 0 ? round(sum, 3) : null,
    counted,
    missing,
    optionalTotal: optionalCount ? round(opt, 3) : null,
    optionalCount,
  };
}

/* ------------------------------------------------------------------ labels */

export function languageLabel(lang?: string | null): string {
  return lang === "ar" ? "Arabic" : lang === "en" ? "English" : humanize(lang ?? "") || "—";
}

export function templateName(templates: TemplateInfo[] | undefined, key: string | null | undefined): string {
  if (!key) return "—";
  return templates?.find((t) => t.key === key)?.label.en ?? humanize(key);
}

export function revisionLabel(q: Pick<Quote, "reference" | "version">): string {
  return `${q.reference || "Draft"} v${q.version}`;
}

export function pdfFileName(q: Pick<Quote, "pdf_path" | "reference" | "version" | "id">): string {
  if (q.pdf_path) return q.pdf_path.split(/[\\/]/).pop() || q.pdf_path;
  return `${(q.reference || q.id).replace(/\//g, "-")}-v${q.version}.pdf`;
}

export function createdByLabel(createdBy: string | null | undefined): string {
  switch (createdBy) {
    case "ai":
      return "Drafted by AI";
    case "mcp":
      return "Drafted by AI (MCP)";
    case "rules":
      return "Drafted from the template rules";
    default:
      return createdBy ? `Created by ${createdBy}` : "Created";
  }
}

export function paperModeLabel(mode?: string | null): string {
  return mode === "preprinted" ? "Pre-printed paper" : "Full letterhead";
}

export function paperName(papers: Paper[] | undefined, id: string | null | undefined, fallbackDefault?: string | null): string {
  const wanted = id || fallbackDefault;
  if (!wanted) return "Neutral specimen";
  return papers?.find((p) => p.id === wanted)?.name ?? wanted;
}

export function signatoryLabel(s: Pick<SignatoryRow, "full_name" | "initials"> | null | undefined): string {
  if (!s) return "—";
  return `${s.full_name || s.initials} (${s.initials})`;
}

export function matchSummary(match: Record<string, unknown> | null | undefined, customerName?: (id: string) => string): string {
  const m = match ?? {};
  const parts: string[] = [];
  if (m.service_family) parts.push(serviceFamilyFallback(String(m.service_family)));
  if (m.work_type) parts.push(workTypeLabel(String(m.work_type)));
  if (m.request_kind) parts.push(requestKindLabel(String(m.request_kind)));
  if (m.customer_id) parts.push(customerName ? customerName(String(m.customer_id)) : "One customer");
  return parts.length ? parts.join(" · ") : "Every project";
}

export const isFrozen = (status: string) => status === "approved" || status === "sent" || status === "superseded";

/* ------------------------------------------------------------------ terms */

/** Price-like terms are filled by a person on each quotation; never given a default. */
export const PRICE_TERMS = new Set(["contract_value"]);

export function termText(terms: Term[] | undefined, key: string): string {
  return terms?.find((t) => t.key === key)?.text ?? "";
}

export function setTerm(terms: Term[] | undefined, key: string, label: string, text: string | null): Term[] {
  const list = [...(terms ?? [])];
  const i = list.findIndex((t) => t.key === key);
  if (i >= 0) list[i] = { ...list[i], text };
  else list.push({ key, label, text });
  return list;
}

/** Clarifications are stored as strings by the drafting step; tolerate objects too. */
export function clarificationText(c: unknown): string {
  if (typeof c === "string") return c;
  if (c && typeof c === "object") {
    const o = c as Record<string, unknown>;
    return String(o.text ?? o.question ?? o.label ?? JSON.stringify(o));
  }
  return String(c ?? "");
}

/* ------------------------------------------------------------------ evidence */

function norm(text: unknown): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function firstEvidence(e: unknown): Evidence | null {
  if (!e) return null;
  if (Array.isArray(e)) return (e.find((x) => x && typeof x === "object") as Evidence | undefined) ?? null;
  if (typeof e === "object") return e as Evidence;
  return null;
}

/** The source of a line: its own `source`, else the project scope item with the same description. */
export function lineEvidence(line: Line, scope: ScopeItem[] | undefined): Evidence | null {
  if (line.source && typeof line.source === "object") return line.source as Evidence;
  const own = firstEvidence((line as Record<string, unknown>).evidence);
  if (own) return own;
  const d = norm(line.description);
  if (!d || !scope?.length) return null;
  const hit = scope.find((s) => norm(s.description) === d) ?? scope.find((s) => {
    const sd = norm(s.description);
    return sd.length > 12 && (sd.includes(d) || d.includes(sd));
  });
  return hit ? firstEvidence(hit.evidence) : null;
}

/* ------------------------------------------------------------------ gates */

export type GateState = "done" | "open" | "blocked";

export interface Gate {
  key: string;
  label: string;
  state: GateState;
  detail: string;
  fix?: { to: string; label: string };
}

export function engineeringRequired(ws: Workspace | null | undefined): boolean {
  return (ws?.settings?.quotations?.require_engineer_review ?? true) !== false;
}

/**
 * What stands between this quotation and sending, in the order a person resolves it:
 * engineering review, impact review after a new revision, prices, commercial approval.
 */
export function quoteGates(q: Quote, project: Project | null | undefined, ws: Workspace | null | undefined): Gate[] {
  const gates: Gate[] = [];
  const reviewHref = q.project_id ? projectHref(q.project_id, "review") : undefined;
  if (engineeringRequired(ws)) {
    const rs = project?.review_status ?? "not_started";
    const info = reviewStatusInfo(rs);
    gates.push({
      key: "engineering",
      label: "Engineering review",
      state: rs === "approved" ? "done" : rs === "changes_requested" ? "blocked" : "open",
      detail: rs === "approved" ? "Technical scope approved" : rs === "not_started" ? "Not started" : info.label,
      fix: rs === "approved" || !reviewHref ? undefined : { to: reviewHref, label: "Open engineering review" },
    });
  }
  if (q.impact_review?.required) {
    gates.push({
      key: "impact",
      label: "New technical revision",
      state: "blocked",
      detail: `The engineer must review it first${q.impact_review.reason ? `: ${String(q.impact_review.reason)}` : ""}.`,
      fix: reviewHref ? { to: reviewHref, label: "Review the revision" } : undefined,
    });
  }
  const missing = q.missing_prices ?? [];
  gates.push({
    key: "prices",
    label: "Prices",
    state: missing.length ? "open" : "done",
    detail: missing.length
      ? `Missing on ${missing.length === 1 ? "line" : "lines"} ${missing.join(", ")}`
      : "Every line has a price or is marked included",
    fix: missing.length ? { to: quotationHref(q.id), label: "Enter prices" } : undefined,
  });
  const commercial: Record<string, [GateState, string]> = {
    draft: ["open", "Not submitted for approval"],
    changes_requested: ["blocked", "Changes requested"],
    needs_review: ["open", "Waiting for approval"],
    approved: ["done", q.approved_by ? `Approved by ${q.approved_by}, ${formatDate(q.approved_at)}` : "Approved"],
    sent: ["done", q.approved_by ? `Approved by ${q.approved_by}` : "Approved"],
    superseded: ["blocked", "Superseded by a newer revision"],
  };
  const [state, detail] = commercial[q.status] ?? ["open", humanize(q.status)];
  gates.push({ key: "commercial", label: "Commercial approval", state, detail });
  return gates;
}

/** Reasons the Approve button is disabled (empty when a person may approve). */
export function approveBlockers(q: Quote, project: Project | null | undefined, ws: Workspace | null | undefined): Gate[] {
  if (!["needs_review", "draft"].includes(q.status)) return [];
  return quoteGates(q, project, ws).filter((g) => g.key !== "commercial" && g.state !== "done");
}

/* ------------------------------------------------------------------ API errors */

export interface Explained {
  title: string;
  message: string;
  fix?: { to: string; label: string };
}

/** 409/403 answers from approve, send, submit and edit as plain explanations with a way to fix. */
export function explainError(err: unknown, q?: Pick<Quote, "id" | "project_id" | "status"> | null): Explained | null {
  if (!(err instanceof ApiError)) return null;
  const review = q?.project_id ? projectHref(q.project_id, "review") : undefined;
  switch (err.code) {
    case "review_required":
      return {
        title: "Engineering review first",
        message: "The engineer review must approve the technical scope before the quotation can be approved.",
        fix: review ? { to: review, label: "Open engineering review" } : undefined,
      };
    case "impact_review":
      return {
        title: "A new technical revision needs review",
        message: err.message,
        fix: review ? { to: review, label: "Review the revision" } : undefined,
      };
    case "prices_missing":
      return {
        title: "Prices are missing",
        message: `${err.message} AI never writes prices: a person enters each one.`,
        fix: q ? { to: quotationHref(q.id), label: "Enter prices" } : undefined,
      };
    case "frozen":
      return { title: "This revision is frozen", message: "Approved and sent quotations cannot change. Create a revision to edit it." };
    case "not_approved":
      return { title: "Not approved yet", message: "Only an approved quotation can be sent." };
    case "bad_state":
      return { title: "The status changed", message: `${err.message}. Reload to see the current status.` };
    case "no_recipient":
      return { title: "Add a recipient", message: "Add at least one e-mail address in To." };
    case "confirm_required":
      return { title: "Confirm first", message: "Tick the confirmation before sending." };
    case "not_connected":
      return {
        title: "No mailbox connected",
        message: err.message,
        fix: { to: "/settings/connections", label: "Open connections" },
      };
    case "forbidden":
      return { title: "Not allowed for your role", message: err.message };
    case "note_required":
      return { title: "Say what must change", message: "Write a short note for the person who prepares the quotation." };
    case "signature_not_found":
      return { title: "No signature found", message: `${err.message} Draw a box around the signature and try again.` };
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ misc */

export function detailFor(q: Quote, d: QuoteDetail | undefined): QuoteDetail | undefined {
  return d && d.quotation.id === q.id ? d : undefined;
}

/** `to=a@x, b@y; send_now=True; draft=r-1` → ["a@x", "b@y"] (backend send record note). */
export function parseSendNote(note: string | null | undefined): { to: string[]; sendNow: boolean | null; draftId: string | null } {
  const text = note ?? "";
  const to = /to=([^;]*)/.exec(text)?.[1]?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  const sn = /send_now=(\w+)/.exec(text)?.[1];
  const draft = /draft=([^;]*)/.exec(text)?.[1]?.trim() || null;
  return { to, sendNow: sn ? sn.toLowerCase() === "true" : null, draftId: draft };
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function splitAddresses(text: string): string[] {
  return text
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ------------------------------------------------------------------ template defaults */

const AR_CURRENCY: Record<string, string> = {
  KWD: "د.ك", KD: "د.ك", SAR: "ر.س", AED: "د.إ", QAR: "ر.ق", BHD: "د.ب", OMR: "ر.ع", USD: "دولار", EUR: "يورو",
};

/** Same as backend templates.currency_label. */
export function currencyLabel(currency: string | null | undefined, language: string): string {
  const code = (currency || "KWD").toUpperCase();
  return language === "ar" ? (AR_CURRENCY[code] ?? code) : code;
}

export function fillPlaceholders(text: string, values: Record<string, string | null | undefined>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (values[k] ?? m) || "");
}

/** What a fresh draft of this template prints: default terms, price unit, total row, wording. */
export function templateDefaults(template: TemplateInfo | undefined, language: string, currency: string | null | undefined) {
  const lang = template?.languages.includes(language) ? language : "en";
  const copy = template?.copy[lang];
  const cur = currencyLabel(currency, lang);
  return {
    language: lang,
    terms: (copy?.terms ?? []).map((t) => ({ key: t.key, label: fillPlaceholders(t.label, { currency: cur }), text: t.text })),
    priceUnit: copy?.default_price_unit ?? null,
    showTotal: template?.show_total ?? true,
    intro: copy?.intro ?? [],
    scope: copy?.scope ?? [],
    closing: copy?.closing ?? [],
    exclusions: copy?.exclusions ?? [],
    totalLabel: copy?.total_label ? fillPlaceholders(copy.total_label, { currency: cur }) : null,
  };
}
