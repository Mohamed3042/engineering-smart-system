/**
 * Helpers for filing a message under a project: what the message says (a tender number, a closing
 * date, a name for a new project) and which open projects it probably belongs to. Everything here is
 * a suggestion that is shown with its reason. A person decides.
 */
import type { Email } from "@/api/types";
import type { ProjectChoice } from "./api";
import { stripPrefixes } from "./mailto";

/** Eastern Arabic digits to 0-9, so "٢٠٢٦" is read as a year. */
const toAscii = (s: string) =>
  s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0));

/** Lower case, no Arabic marks, one spelling of the Arabic letters people mix up. For comparing, never for showing. */
export function fold(s: string): string {
  return toAscii(s.toLowerCase())
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه");
}

/** A name inside a sentence, isolated so an Arabic name does not reorder the English words around it. */
export const isolate = (text: string) => `\u2068${text}\u2069`;

/** A project name from a subject: "RE: FW: Marina Tower A" → "Marina Tower A". */
export function projectNameFromSubject(subject: string | null | undefined): string {
  return stripPrefixes(subject).replace(/\s+/g, " ").slice(0, 120);
}

/* ------------------------------------------------------------------ what the message says */

export interface Found {
  value: string;
  /** The sentence it was read from, shown next to the field so a person can check it. */
  quote: string;
}

/** Same patterns as the mailbox scan (backend/ess/pipeline/scan.py TENDER_PATTERNS), plus the Arabic word for tender. */
const TENDER_PATTERNS = [
  /\bRFP[-\s]?(\d{5,})\b/i,
  /\bKOC[-\s]?(\d{5,})\b/i,
  /\bCAPT\.?\s*No\.?\s*([A-Z]{2,5}\s*\/\s*\d{2,5})/i,
  /\b(?:tender|rfq|rfp|bid)\s*(?:no\.?|number|#|ref\.?)\s*[:\-]?\s*([A-Z0-9][A-Z0-9/\-.]{3,30})/i,
  /(?:مناقصة|مناقصه)\s*(?:رقم)?\s*[:#]?\s*([A-Z0-9][A-Z0-9/\-.]{3,30})/i,
];

/** 'RFP-2143588', 'KOC-2143588', 'Tender No. RFP 2143588.' → '2143588': one tender, many spellings. */
export function canonicalTender(value: string): string {
  const v = value.replace(/\s+/g, "").toUpperCase().replace(/^[.,;:()]+|[.,;:()]+$/g, "");
  const m = v.match(/^(?:RFP|KOC|RFQ)[-/]?(\d{5,})$/);
  return m ? m[1] : v;
}

/** The line a match is on, trimmed to a window around it when the line is long. Shown as the evidence for a prefilled field. */
function sentenceAround(text: string, start: number, end: number): string {
  const from = text.lastIndexOf("\n", start) + 1;
  const to = text.indexOf("\n", end);
  const line = text.slice(from, to === -1 ? text.length : to);
  if (line.length <= 200) return line.trim().replace(/\s+/g, " ");
  const a = Math.max(from, start - 70);
  const b = Math.min(to === -1 ? text.length : to, end + 110);
  return `${a > from ? "…" : ""}${text.slice(a, b).trim().replace(/\s+/g, " ")}${b < (to === -1 ? text.length : to) ? "…" : ""}`;
}

/** Tender numbers in the text, canonical spelling, in order of appearance. */
function tenderNumbers(text: string): { value: string; quote: string }[] {
  const out: { value: string; quote: string }[] = [];
  for (const rx of TENDER_PATTERNS) {
    for (const m of text.matchAll(new RegExp(rx.source, `${rx.flags}g`))) {
      const value = canonicalTender(m[1]);
      if (value.length >= 4 && /\d/.test(value) && !out.some((o) => o.value === value)) {
        out.push({ value, quote: sentenceAround(text, m.index ?? 0, (m.index ?? 0) + m[0].length) });
      }
    }
  }
  return out;
}

const DATE = String.raw`(\d{1,2}(?:st|nd|rd|th)?[\s/\-.](?:\d{1,2}|[A-Za-z]{3,9})['’]?[\s/\-.,]*\d{2,4})`;
/** Closing-date wording, as in backend/ess/pipeline/changes.py. The customer's own wording is day first. */
const CLOSING = [
  new RegExp(String.raw`(?:closing|submission|due|bid)\s+date\s*(?:is|:)?\s*(?:on\s+or\s+before\s+)?${DATE}`, "i"),
  new RegExp(String.raw`(?:on\s+or\s+before|not\s+later\s+than|latest\s+by)\s+${DATE}`, "i"),
  new RegExp(String.raw`(?:closing|submission|due|tender)?\s*(?:date)?[^\n.]{0,60}?extended\s+(?:to|till|until|up\s*to)\s+${DATE}`, "i"),
];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "08/10/2026", "8-10-26", "8th Oct 2026" → "2026-10-08" (day first), or null when it is not a real date. */
export function parseDayFirst(raw: string): string | null {
  const t = raw.replace(/(\d)(?:st|nd|rd|th)\b/gi, "$1").replace(/['’]/g, " ").trim();
  let d: number;
  let mo: number;
  let y: number;
  let m = t.match(/^(\d{1,2})[\s/\-.](\d{1,2})[\s/\-.,]+(\d{2,4})$/);
  if (m) {
    d = Number(m[1]);
    mo = Number(m[2]);
    y = Number(m[3]);
  } else if ((m = t.match(/^(\d{1,2})[\s/\-.]([A-Za-z]{3,9})[\s/\-.,]*(\d{2,4})$/))) {
    const idx = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    if (idx < 0) return null;
    d = Number(m[1]);
    mo = idx + 1;
    y = Number(m[3]);
  } else {
    return null;
  }
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (y < 2000 || y > 2100 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export interface Suggestions {
  tenderNo: Found | null;
  dueDate: Found | null;
}

/** A tender number and a closing date, when the subject or text states them. */
export function suggestFromMail(email: Pick<Email, "subject" | "body_text" | "snippet">): Suggestions {
  const text = toAscii(`${email.subject ?? ""}\n${(email.body_text || email.snippet || "").slice(0, 20_000)}`);
  const tender = tenderNumbers(text)[0] ?? null;
  let dueDate: Found | null = null;
  for (const rx of CLOSING) {
    const m = rx.exec(text);
    const iso = m ? parseDayFirst(m[1]) : null;
    if (m && iso) {
      dueDate = { value: iso, quote: sentenceAround(text, m.index, m.index + m[0].length) };
      break;
    }
  }
  return { tenderNo: tender, dueDate };
}

/* ------------------------------------------------------------------ which project it belongs to */

/** Words that say what kind of mail it is, not which building or tender. */
const STOP = new Set(
  [
    "the", "and", "for", "with", "from", "our", "your", "this", "that", "have", "are", "was", "will",
    "request", "quotation", "quote", "enquiry", "inquiry", "rfq", "proposal", "tender", "project", "please",
    "kindly", "regarding", "offer", "new", "update", "reminder", "addendum", "fwd",
    "طلب", "عرض", "سعر", "اسعار", "في", "من", "على", "الى", "إلى", "عن", "مع", "هذا", "هذه",
  ].map(fold),
);

interface Word {
  key: string;
  word: string;
}

/** The distinctive words of a text: no numbers, no filler, Arabic "al-" removed so "المبنى" and "مبنى" meet. */
function wordsOf(text: string): Word[] {
  const seen = new Set<string>();
  const out: Word[] = [];
  for (const word of text.match(/[\p{L}\p{N}]+/gu) ?? []) {
    let key = fold(word);
    if (key.startsWith("ال") && key.length > 4) key = key.slice(2);
    if (key.length < 3 || /^\d+$/.test(key) || STOP.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, word });
  }
  return out;
}

const sameWord = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 5 && (a.startsWith(b) || b.startsWith(a)));

export interface MailFacts {
  subjectWords: Word[];
  tenders: string[];
  /** Folded subject and start of the text, for a tender number written in an odd way. */
  haystack: string;
  customerId: string | null;
  category: string;
}

export function mailFacts(email: Email): MailFacts {
  const text = toAscii(`${email.subject ?? ""}\n${(email.body_text || email.snippet || "").slice(0, 6000)}`);
  return {
    subjectWords: wordsOf(projectNameFromSubject(email.subject)),
    tenders: tenderNumbers(text).map((t) => t.value),
    haystack: fold(text),
    customerId: email.customer_id,
    category: email.category,
  };
}

export interface ProjectMatch {
  score: number;
  /** Why it is suggested, in words. Empty when nothing links the message to the project. */
  reasons: string[];
}

/** From this score a project is listed under "Likely matches". */
export const LIKELY = 30;

export function matchProject(p: ProjectChoice, mail: MailFacts): ProjectMatch {
  let score = 0;
  const reasons: string[] = [];
  if (p.tender_no) {
    const own = canonicalTender(p.tender_no);
    const typed = fold(p.tender_no.trim());
    if (own.length >= 4 && (mail.tenders.includes(own) || (typed.length >= 5 && mail.haystack.includes(typed)))) {
      score += 100;
      reasons.push("Same tender number");
    }
  }
  if (mail.customerId && p.customer?.id === mail.customerId) {
    score += 25;
    reasons.push("Same customer");
  }
  const shared = wordsOf(p.name).filter((w) => mail.subjectWords.some((s) => sameWord(s.key, w.key)));
  if (shared.length) {
    score += shared.length >= 3 ? 60 : shared.length === 2 ? 40 : 15;
    reasons.push(`Subject matches: ${shared.slice(0, 3).map((w) => w.word).join(", ")}`);
  }
  if (score > 0 && p.service_family === mail.category) score += 3;
  return { score, reasons };
}

export interface RankedProject {
  project: ProjectChoice;
  match: ProjectMatch;
}

/**
 * Open projects that fit the search, likely matches first. The server already sorts by closing date,
 * and that order is kept among projects with the same score.
 */
export function rankProjects(projects: ProjectChoice[], mail: MailFacts, query: string, excludeId?: string | null): RankedProject[] {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  const out: RankedProject[] = [];
  for (const project of projects) {
    if (project.archived_at || project.id === excludeId) continue;
    if (terms.length) {
      const hay = fold([project.name, project.customer?.name, project.tender_no, project.code, project.location].filter(Boolean).join(" "));
      if (!terms.every((t) => hay.includes(t))) continue;
    }
    out.push({ project, match: matchProject(project, mail) });
  }
  return out.sort((a, b) => b.match.score - a.match.score);
}
