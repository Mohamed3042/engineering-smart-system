/**
 * Choices for the workspace form (country, currency, time zone, region) and the role table.
 * Names come from the browser's Intl data, so they follow the codes rather than a copy of ours.
 */
import type { Option } from "@/ui";

/* ------------------------------------------------------------------ places and money */

const COUNTRY_CODES = [
  "KW", "SA", "AE", "QA", "BH", "OM", "EG", "JO", "IQ", "LB", "TR",
  "GB", "IE", "DE", "FR", "NL", "BE", "IT", "ES", "PT", "CH", "AT", "SE", "NO", "DK", "FI", "PL", "GR",
  "US", "CA", "AU", "NZ", "SG", "MY", "HK", "CN", "JP", "KR",
  "IN", "PK", "BD", "LK", "NP",
  "RU", "KZ", "UZ", "UA", "AZ", "GE", "AM",
  "ZA", "KE", "NG", "MA",
];

const CURRENCY_CODES = [
  "KWD", "SAR", "AED", "QAR", "BHD", "OMR", "EGP", "JOD", "IQD", "LBP", "TRY",
  "USD", "EUR", "GBP", "CHF", "CAD", "AUD", "NZD", "SGD", "MYR", "HKD", "CNY", "JPY",
  "INR", "PKR", "BDT", "LKR", "NPR", "RUB", "KZT", "UZS", "ZAR", "KES", "NGN", "MAD",
];

function displayName(type: "region" | "currency", code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type }).of(code) ?? code;
  } catch {
    return code;
  }
}

export const countryName = (code: string) => displayName("region", code);

/** The list, plus the current value when it is something we do not list (an imported workspace). */
function withCurrent(options: Option[], current: string | null | undefined): Option[] {
  if (current && !options.some((o) => o.value === current)) return [{ value: current, label: current }, ...options];
  return options;
}

export function countryOptions(current?: string | null): Option[] {
  const list = COUNTRY_CODES.map((c) => ({ value: c, label: countryName(c) })).sort((a, b) => a.label.localeCompare(b.label));
  return withCurrent(list, current);
}

export function currencyOptions(current?: string | null): Option[] {
  return withCurrent(
    CURRENCY_CODES.map((c) => ({ value: c, label: `${c} · ${displayName("currency", c)}` })),
    current,
  );
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function timezoneOptions(current?: string | null): Option[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = [];
  }
  if (!zones.includes("UTC")) zones = ["UTC", ...zones];
  return withCurrent(
    zones.map((z) => ({ value: z, label: z.replace(/_/g, " ") })),
    current,
  );
}

/** Stored as the label (the sample workspace uses "Gulf / Middle East"). */
export const WORKSPACE_REGIONS = ["Gulf / Middle East", "UK / Europe", "North America", "Russia / CIS", "South Asia"];

export function regionOptions(current?: string | null): Option[] {
  return withCurrent(
    WORKSPACE_REGIONS.map((r) => ({ value: r, label: r })),
    current,
  );
}

export interface CountryDefaults {
  region: string;
  currency: string;
  timezone: string;
  languages: string[];
}

const GULF = "Gulf / Middle East";
const EU = "UK / Europe";

/** What a person in this country most likely wants; applied only to fields they have not touched. */
export const COUNTRY_DEFAULTS: Record<string, CountryDefaults> = {
  KW: { region: GULF, currency: "KWD", timezone: "Asia/Kuwait", languages: ["en", "ar"] },
  SA: { region: GULF, currency: "SAR", timezone: "Asia/Riyadh", languages: ["en", "ar"] },
  AE: { region: GULF, currency: "AED", timezone: "Asia/Dubai", languages: ["en", "ar"] },
  QA: { region: GULF, currency: "QAR", timezone: "Asia/Qatar", languages: ["en", "ar"] },
  BH: { region: GULF, currency: "BHD", timezone: "Asia/Bahrain", languages: ["en", "ar"] },
  OM: { region: GULF, currency: "OMR", timezone: "Asia/Muscat", languages: ["en", "ar"] },
  EG: { region: GULF, currency: "EGP", timezone: "Africa/Cairo", languages: ["en", "ar"] },
  JO: { region: GULF, currency: "JOD", timezone: "Asia/Amman", languages: ["en", "ar"] },
  GB: { region: EU, currency: "GBP", timezone: "Europe/London", languages: ["en"] },
  IE: { region: EU, currency: "EUR", timezone: "Europe/Dublin", languages: ["en"] },
  DE: { region: EU, currency: "EUR", timezone: "Europe/Berlin", languages: ["en"] },
  FR: { region: EU, currency: "EUR", timezone: "Europe/Paris", languages: ["en", "fr"] },
  NL: { region: EU, currency: "EUR", timezone: "Europe/Amsterdam", languages: ["en"] },
  IT: { region: EU, currency: "EUR", timezone: "Europe/Rome", languages: ["en"] },
  ES: { region: EU, currency: "EUR", timezone: "Europe/Madrid", languages: ["en"] },
  US: { region: "North America", currency: "USD", timezone: "America/New_York", languages: ["en"] },
  CA: { region: "North America", currency: "CAD", timezone: "America/Toronto", languages: ["en"] },
  RU: { region: "Russia / CIS", currency: "RUB", timezone: "Europe/Moscow", languages: ["en", "ru"] },
  KZ: { region: "Russia / CIS", currency: "KZT", timezone: "Asia/Almaty", languages: ["en", "ru"] },
  IN: { region: "South Asia", currency: "INR", timezone: "Asia/Kolkata", languages: ["en", "hi"] },
  PK: { region: "South Asia", currency: "PKR", timezone: "Asia/Karachi", languages: ["en", "ur"] },
  BD: { region: "South Asia", currency: "BDT", timezone: "Asia/Dhaka", languages: ["en"] },
  LK: { region: "South Asia", currency: "LKR", timezone: "Asia/Colombo", languages: ["en"] },
};

/* ------------------------------------------------------------------ text fields */

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** "@Example.com", "https://www.example.com/path" → "example.com" (or "" when it is not a domain). */
export function normalizeDomain(raw: string): string {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^@/, "")
    .replace(/[/?#].*$/, "");
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s) ? s : "";
}

export function domainOf(email: string): string {
  return email.includes("@") ? normalizeDomain(email.split("@")[1] ?? "") : "";
}

/* ------------------------------------------------------------------ roles */

export type RoleKey = "owner" | "admin" | "engineer" | "sales" | "viewer";

export const ROLE_ORDER: RoleKey[] = ["owner", "admin", "engineer", "sales", "viewer"];
export const ROLE_RANK: Record<RoleKey, number> = { viewer: 0, sales: 1, engineer: 2, admin: 3, owner: 4 };
/** The owner role is created with the workspace and cannot be handed out or changed. */
export const ASSIGNABLE_ROLES: RoleKey[] = ["admin", "engineer", "sales", "viewer"];

export const ROLE_BLURB: Record<RoleKey, string> = {
  owner: "Everything, including the team. Created with the workspace; it cannot be changed.",
  admin: "Connections, AI, business knowledge, workspace settings and the team.",
  engineer: "Technical review, approving and sending quotations, template rules.",
  sales: "Reads mail and projects and prepares drafts. Cannot approve or send.",
  viewer: "Reads only.",
};

export const rankOf = (role: string | null | undefined) => ROLE_RANK[(role ?? "") as RoleKey] ?? 0;

export interface Permission {
  label: string;
  detail: string;
  /** Lowest role that may do it. Matches the checks in backend/ess/api (require_role) and the screens. */
  min: RoleKey;
}

// ponytail: written out by hand from the require_role calls in backend/ess/api; there is no endpoint for the role table.
export const PERMISSIONS: Permission[] = [
  { label: "Read mail, projects and quotations", detail: "Including every file and its source sentence.", min: "viewer" },
  { label: "Prepare drafts", detail: "Quotation drafts, mail category corrections, project notes.", min: "sales" },
  { label: "Approve the technical scope", detail: "The engineering review of a project.", min: "engineer" },
  { label: "Approve and send quotations", detail: "Approval and sending always name a person and a revision.", min: "engineer" },
  { label: "Set template rules", detail: "Which template, paper and signatory a kind of project uses.", min: "engineer" },
  { label: "Confirm business knowledge", detail: "What the company does, in its own words.", min: "admin" },
  { label: "Connect the mailbox and the AI engine", detail: "Keys, models, exams and AI quality rules.", min: "admin" },
  { label: "Change workspace settings", detail: "Company details, defaults, import and export.", min: "admin" },
  { label: "Edit templates, letterhead and signatories", detail: "What goes on an issued quotation.", min: "admin" },
  { label: "Manage the team", detail: "Invite people, change roles, deactivate.", min: "admin" },
];

export const canRole = (role: string | null | undefined, min: RoleKey) => rankOf(role) >= ROLE_RANK[min];
