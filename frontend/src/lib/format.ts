/** Formatting helpers. Dates render as "15 Oct 2026"; times as "09:41". */

type DateInput = string | number | Date | null | undefined;

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  // Plain dates ("2026-10-11") are calendar days: parse as local midnight, not UTC.
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
const shortFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

export function formatDate(value: DateInput, fallback = "—"): string {
  const d = toDate(value);
  return d ? dateFmt.format(d) : fallback;
}

/** "8 Oct" when the year is the current year, else "8 Oct 2025". */
export function formatDateShort(value: DateInput, fallback = "—"): string {
  const d = toDate(value);
  if (!d) return fallback;
  return d.getFullYear() === new Date().getFullYear() ? shortFmt.format(d) : dateFmt.format(d);
}

export function formatTime(value: DateInput, fallback = "—"): string {
  const d = toDate(value);
  return d ? timeFmt.format(d) : fallback;
}

export function formatDateTime(value: DateInput, fallback = "—"): string {
  const d = toDate(value);
  return d ? `${dateFmt.format(d)}, ${timeFmt.format(d)}` : fallback;
}

/** "Today 09:41", "Yesterday", "3 days ago", else a date. */
export function formatRelative(value: DateInput, fallback = "—"): string {
  const d = toDate(value);
  if (!d) return fallback;
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days === 0) {
    const mins = Math.round((now.getTime() - d.getTime()) / 60_000);
    if (mins >= 0 && mins < 1) return "Just now";
    if (mins > 0 && mins < 60) return `${mins} min ago`;
    return `Today ${timeFmt.format(d)}`;
  }
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) return `${days} days ago`;
  return formatDateShort(d);
}

/** Whole days from today to the date (negative when past). */
export function daysUntil(value: DateInput): number | null {
  const d = toDate(value);
  if (!d) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((day - today) / 86_400_000);
}

/** "Due in 10 days", "Due today", "3 days overdue". */
export function dueLabel(value: DateInput): string | null {
  const n = daysUntil(value);
  if (n === null) return null;
  if (n === 0) return "Due today";
  if (n === 1) return "Due tomorrow";
  if (n > 1) return `Due in ${n} days`;
  return `${-n} ${n === -1 ? "day" : "days"} overdue`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatNumber(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatMoney(n: number | null | undefined, currency?: string, digits = 3): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const v = n.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return currency ? `${currency} ${v}` : v;
}

export function formatPercent(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

/** "engineer_review" → "Engineer review". */
export function humanize(key: string | null | undefined): string {
  if (!key) return "";
  const s = key.replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** True when the text is mainly Arabic script (use for dir="rtl"). */
export function isRtl(text: string | null | undefined): boolean {
  if (!text) return false;
  const arabic = (text.match(/[؀-ۿݐ-ݿ]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return arabic > latin;
}
