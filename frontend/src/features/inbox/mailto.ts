/**
 * Reply and forward hand the message to a person's own mail program. The app never sends, replies
 * or forwards mail (the mailbox is read-only), so these functions only build a link: the message in
 * Gmail when the mailbox gave us its address, otherwise a mailto: link with the address, the subject
 * and, for a forward, a short header and the quoted text.
 */
import type { Email } from "@/api/types";
import { formatDateTime } from "@/lib/format";

/** Mail programs and browsers cut long links. Stay under the limit the common ones accept. */
export const MAILTO_LIMIT = 1800;

type Source = Pick<Email, "from_name" | "from_email" | "to" | "subject" | "date" | "body_text" | "snippet" | "direction" | "view_url">;

const enc = encodeURIComponent;

/** The message's own page in the mailbox (Gmail), when it is a web address. */
export function viewUrlOf(email: Pick<Email, "view_url">): string | null {
  return email.view_url && /^https?:\/\//i.test(email.view_url) ? email.view_url : null;
}

/** "RE: Re: Fwd: Quote" → "Quote" (also the Arabic reply prefix), so one "Re:" or "Fwd:" is added. */
export function stripPrefixes(subject: string | null | undefined): string {
  return (subject ?? "").replace(/^(?:\s*(?:re|fw|fwd|aw|tr|sv|vs|wg|رد|إعادة توجيه|اعادة توجيه)\s*:\s*)+/i, "").trim();
}

/** Cut text without splitting a surrogate pair: encodeURIComponent throws on a lone surrogate. */
function safeSlice(text: string, end: number): string {
  const s = text.slice(0, end);
  const last = s.charCodeAt(s.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? s.slice(0, -1) : s;
}

function shorten(text: string, max: number): string {
  return text.length > max ? `${safeSlice(text, max - 1).trimEnd()}…` : text;
}

/** Message text made safe for a link: no stray surrogates or control characters, tidy blank lines, CRLF line breaks. */
function clean(text: string): string {
  return text
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/\r\n?|\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(/\n/g, "\r\n");
}

/** The longest start of `text` whose encoded form fits in `budget` characters. */
function fit(text: string, budget: number): string {
  if (budget <= 0) return "";
  if (enc(text).length <= budget) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (enc(safeSlice(text, mid)).length <= budget) lo = mid;
    else hi = mid - 1;
  }
  return safeSlice(text, lo);
}

/** An address in the "to" part of a link: the @ stays readable. */
const encAddr = (a: string) => enc(a.trim()).replace(/%40/g, "@");

/** Reply: to the original sender (to the recipients when the message is one we sent), "Re: …". */
export function replyMailto(email: Source): string {
  const people = email.direction === "outbound" ? (email.to ?? []) : [email.from_email];
  const to = people.filter(Boolean).map(encAddr).join(",");
  const subject = shorten(clean(`Re: ${stripPrefixes(email.subject)}`).replace(/\r\n/g, " "), 150);
  return `mailto:${to}?subject=${enc(subject)}`;
}

/** Forward: no recipient, "Fwd: …", and a short header followed by the quoted text. Always under MAILTO_LIMIT. */
export function forwardMailto(email: Source): string {
  const subject = shorten(clean(`Fwd: ${stripPrefixes(email.subject)}`).replace(/\r\n/g, " "), 120);
  const start = `mailto:?subject=${enc(subject)}&body=`;
  const when = email.date ? formatDateTime(email.date) : "";
  const name = email.from_name?.trim();
  const from = name ? `${shorten(clean(name), 60)} <${email.from_email}>` : email.from_email;
  const to = (email.to ?? []).join(", ");
  const subjectLine = `Subject: ${shorten(clean(email.subject ?? ""), 100)}`;
  const rule = "---------- Forwarded message ----------";
  // From the full header to the bare rule: the first that leaves room for some of the text.
  const headers = [
    [rule, `From: ${from}`, when && `Date: ${when}`, subjectLine, to && `To: ${shorten(to, 120)}`],
    [rule, `From: ${from}`, when && `Date: ${when}`, subjectLine],
    [rule, `From: ${from}`],
    [rule],
  ].map((lines) => `${lines.filter(Boolean).join("\r\n")}\r\n\r\n`);
  const room = MAILTO_LIMIT - start.length;
  const header = headers.find((h) => enc(h).length <= room - 200) ?? headers[headers.length - 1];
  const left = room - enc(header).length;
  const body = clean(email.body_text || email.snippet || "");
  const note = "\r\n\r\n[Shortened. Open the original message for the rest.]";
  let text = fit(body, left);
  if (text.length < body.length) text = fit(body, left - enc(note).length).trimEnd() + note;
  return start + enc(header + text);
}
