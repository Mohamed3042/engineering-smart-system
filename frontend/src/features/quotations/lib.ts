/**
 * Pure helpers for the quotation builder: money, line totals, approval blockers, term changes,
 * labels and API error explanations. No React here except the role hook.
 */
import { ApiError } from "@/api/client";
import { useCurrentUser } from "@/api/session";
import type { Approval, Evidence, ScopeItem, Workspace } from "@/api/types";
import { formatMoney, humanize } from "@/lib/format";
import { requestKindLabel, serviceFamilyFallback, workTypeLabel, type StatusInfo, type Tone } from "@/lib/labels";
import { projectHref, quotationHref } from "@/lib/routes";
import type { ApprovalBlocker, Line, Paper, Quote, QuotationData, SignatoryRow, TemplateInfo, Term, TermChange, TermChangeStatus } from "./api";

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

/** Quantity × price, only when both are known (an unstated quantity never becomes 0). */
export function lineTotal(line: Line): number | null {
  const qty = parseAmount(line.qty);
  const price = parseAmount(line.unit_price);
  if (qty === null || price === null) return null;
  return round(qty * price, 3);
}

export function hasPrice(line: Line): boolean {
  return parseAmount(line.unit_price) !== null;
}

export interface Totals {
  /** Sum of the counted lines; null until every counted line has a quantity and a price. */
  total: number | null;
  /** Lines that count towards the total (not optional, not included). */
  counted: number;
  /** Lines without a price that are not "included" (the backend's missing_prices). */
  missingPrice: number;
  /** Lines without a stated quantity that are not "included" (the backend's quantities_missing). */
  missingQty: number;
  optionalTotal: number | null;
  optionalCount: number;
}

export function totals(items: Line[] | undefined): Totals {
  let sum = 0;
  let counted = 0;
  let missingPrice = 0;
  let missingQty = 0;
  let incomplete = false;
  let opt = 0;
  let optionalCount = 0;
  for (const line of items ?? []) {
    if (line.included) continue;
    if (!hasPrice(line)) missingPrice++;
    if (parseAmount(line.qty) === null) missingQty++;
    const t = lineTotal(line);
    if (line.optional) {
      optionalCount++;
      if (t !== null) opt += t;
      continue;
    }
    counted++;
    if (t !== null) sum += t;
    else incomplete = true;
  }
  return {
    total: counted > 0 && !incomplete ? round(sum, 3) : null,
    counted,
    missingPrice,
    missingQty,
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
  return mode === "preprinted" ? "Pre-printed paper (body only)" : "Full letterhead";
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

export function matchSummary(
  match: Record<string, unknown> | null | undefined,
  customerName?: (id: string) => string,
  familyLabel: (key: string) => string = serviceFamilyFallback,
): string {
  const m = match ?? {};
  const parts: string[] = [];
  if (m.service_family) parts.push(familyLabel(String(m.service_family)));
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

/** Clarifications are stored as strings by the drafting step; tolerate objects too. */
export function clarificationText(c: unknown): string {
  if (typeof c === "string") return c;
  if (c && typeof c === "object") {
    const o = c as Record<string, unknown>;
    return String(o.text ?? o.question ?? o.label ?? JSON.stringify(o));
  }
  return String(c ?? "");
}

/* ------------------------------------------------------------------ customer-requested term changes */

/** Older drafts carry no status: a change nobody decided is pending. */
export function termStatus(c: TermChange): TermChangeStatus {
  return c.status === "accepted" || c.status === "retained" || c.status === "clarification" ? c.status : "pending";
}

export const TERM_STATUS: Record<TermChangeStatus, StatusInfo> = {
  pending: { label: "Waiting for decision", tone: "review" },
  accepted: { label: "Requested wording accepted", tone: "brand" },
  retained: { label: "Template wording kept", tone: "neutral" },
  clarification: { label: "Clarification requested", tone: "review" },
};

export function termChanges(data: QuotationData | undefined): TermChange[] {
  return (data?.term_changes ?? []).filter((c): c is TermChange => Boolean(c && typeof c === "object" && c.key));
}

export function pendingTermChanges(data: QuotationData | undefined): TermChange[] {
  return termChanges(data).filter((c) => termStatus(c) === "pending");
}

export function detectedByLabel(by?: string | null): string {
  if (!by || by === "rules") return "Found by the mail rules";
  if (by.startsWith("mcp:")) return `Found by AI (${by.slice(4)})`;
  if (by === "ai" || by === "mcp") return "Found by AI";
  return `Found by ${by}`;
}

/* ------------------------------------------------------------------ approval blockers */

export function engineeringRequired(ws: Workspace | null | undefined): boolean {
  return (ws?.settings?.quotations?.require_engineer_review ?? true) !== false;
}

/** Unmet conditions for approval, exactly as the backend's approval gate lists them. */
export function blockersOf(q: Quote, from?: { approval_blockers?: ApprovalBlocker[] } | null): ApprovalBlocker[] {
  return from?.approval_blockers ?? q.approval_blockers ?? [];
}

export const BLOCKER_LABEL: Record<string, string> = {
  review_required: "Engineering review",
  impact_review: "New technical revision",
  prices_missing: "Prices",
  quantities_missing: "Quantities",
  terms_pending: "Customer-requested terms",
};

export type GateState = "done" | "open" | "blocked";

export interface Gate {
  key: string;
  label: string;
  state: GateState;
  detail: string;
  fix?: { to: string; label: string };
}

/** Unmet conditions as checklist rows; `inEditor` links to sections of the same page. */
export function blockerGates(blockers: ApprovalBlocker[], q: Pick<Quote, "id" | "project_id">, inEditor: boolean): Gate[] {
  const editor = inEditor ? "" : quotationHref(q.id);
  const review = q.project_id ? projectHref(q.project_id, "review") : undefined;
  return blockers.map((b) => {
    const fix =
      b.code === "review_required"
        ? review && { to: review, label: "Open engineering review" }
        : b.code === "impact_review"
          ? review && { to: review, label: "Review the revision" }
          : b.code === "prices_missing"
            ? { to: `${editor}#line-items`, label: "Enter prices" }
            : b.code === "quantities_missing"
              ? { to: `${editor}#line-items`, label: "Enter quantities" }
              : b.code === "terms_pending"
              ? { to: `${editor}#term-changes`, label: "Decide the terms" }
              : undefined;
    return {
      key: b.code,
      label: BLOCKER_LABEL[b.code] ?? humanize(b.code),
      state: b.code === "impact_review" ? "blocked" : "open",
      detail: b.message,
      fix: fix || undefined,
    };
  });
}

/** Match the backend's language resolution before checking the company switch. */
export function templateEnabled(template: TemplateInfo | undefined, language: string): boolean {
  if (!template) return false;
  const resolved = template.languages.includes(language) ? language : "en";
  return template.settings?.[resolved]?.enabled !== false;
}

/* ------------------------------------------------------------------ API errors */

export interface Explained {
  title: string;
  message: string;
  fix?: { to: string; label: string };
}

/** 4xx answers from approve, send, submit, decide and edit as plain explanations with a way to fix. */
export function explainError(err: unknown, q?: Pick<Quote, "id" | "project_id"> | null): Explained | null {
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
      return { title: "A new technical revision needs review", message: err.message, fix: review ? { to: review, label: "Review the revision" } : undefined };
    case "prices_missing":
      return {
        title: "Prices are missing",
        message: `${err.message} AI never writes prices: a person enters each one.`,
        fix: q ? { to: `${quotationHref(q.id)}#line-items`, label: "Enter prices" } : undefined,
      };
    case "quantities_missing":
      return {
        title: "Quantities are missing",
        message: err.message,
        fix: q ? { to: `${quotationHref(q.id)}#line-items`, label: "Enter quantities" } : undefined,
      };
    case "terms_pending":
      return {
        title: "Customer-requested terms need a decision",
        message: err.message,
        fix: q ? { to: `${quotationHref(q.id)}#term-changes`, label: "Decide the terms" } : undefined,
      };
    case "frozen":
      return {
        title: "This revision is frozen",
        message: "Approved and sent quotations cannot change. Create a revision: it needs approval and send authorization again.",
      };
    case "reason_required":
      return { title: "Give a reason", message: "Say why the template wording stays. The reason is recorded with the decision." };
    case "not_approved":
      return { title: "Not approved yet", message: "Only an approved quotation can be sent." };
    case "no_pdf":
      return { title: "Render the PDF first", message: err.message };
    case "bad_state":
      return { title: "The status changed", message: `${err.message}. Reload to see the current status.` };
    case "no_recipient":
      return { title: "Add a recipient", message: "Add at least one e-mail address in To." };
    case "confirm_required":
      return { title: "Confirm first", message: err.message };
    case "not_connected":
      return { title: "No mailbox connected", message: err.message, fix: { to: "/settings/connections", label: "Open connections" } };
    case "template_disabled":
    case "no_template_enabled":
      return { title: "Choose an enabled template", message: err.message, fix: { to: "/quotations/setup/templates", label: "Open template setup" } };
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
  const hit =
    scope.find((s) => norm(s.description) === d) ??
    scope.find((s) => {
      const sd = norm(s.description);
      return sd.length > 12 && (sd.includes(d) || d.includes(sd));
    });
  return hit ? firstEvidence(hit.evidence) : null;
}

/* ------------------------------------------------------------------ approval records */

/** One approval record in words: approved, changes requested, sent or saved as mail draft. */
export function describeApproval(a: Pick<Approval, "action" | "decision" | "note">): { label: string; tone: Tone; recipients: string[] } {
  if (a.action === "send_quotation") {
    const s = parseSendNote(a.note);
    return { label: s.sendNow === false ? "Saved as mail draft" : "Sent", tone: "brand", recipients: s.to };
  }
  if (a.action === "approve_quotation")
    return a.decision === "approved"
      ? { label: "Approved", tone: "brand", recipients: [] }
      : { label: "Changes requested", tone: "block", recipients: [] };
  return { label: `${humanize(a.action)}: ${humanize(a.decision).toLowerCase()}`, tone: "neutral", recipients: [] };
}

/* ------------------------------------------------------------------ misc */

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

/** Same as backend templates.fill_placeholders: "{currency}" → value; unknown names stay as they are. */
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
