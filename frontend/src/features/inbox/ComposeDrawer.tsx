import { useState } from "react";
import type { Email } from "@/api/types";
import { formatDateTime } from "@/lib/format";
import { Button, Drawer, Field, Input, Textarea, toast, toastError } from "@/ui";

export type ComposeMode = "reply" | "forward";

/** Opens a draft in the person's mail app. This workspace has read-only mailbox access. */
export function ComposeDrawer({ email, mode, onClose }: { email: Email; mode: ComposeMode; onClose: () => void }) {
  const outbound = email.direction === "outbound";
  const [to, setTo] = useState(mode === "reply" ? outbound ? email.to.join(", ") : email.from_email : "");
  const [subject, setSubject] = useState(`${mode === "reply" ? /^re\s*:/i.test(email.subject) ? "" : "Re: " : /^fwd?\s*:/i.test(email.subject) ? "" : "Fwd: "}${email.subject}`);
  const original = [
    "", "", "----- Original message -----",
    `From: ${email.from_name ? `${email.from_name} <${email.from_email}>` : email.from_email}`,
    `Date: ${formatDateTime(email.date)}`, `To: ${email.to.join(", ")}`,
    ...(email.cc.length ? [`Cc: ${email.cc.join(", ")}`] : []), `Subject: ${email.subject}`, "", email.body_text || email.snippet || "",
  ].join("\n");
  const [body, setBody] = useState(original);
  const draftText = `To: ${to}\nSubject: ${subject}\n\n${body}`;
  const href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const copy = async () => {
    try { await navigator.clipboard.writeText(draftText); toast.success("Draft copied", { description: "Paste it into your mailbox and check the recipient before sending." }); }
    catch (err) { toastError(err, "The draft could not be copied. Select and copy its text below."); }
  };
  return <Drawer open onOpenChange={(open) => !open && onClose()} title={mode === "reply" ? "Reply to this message" : "Forward this message"} description="Prepare a draft, then send it yourself from your mailbox." width="lg" footer={
    <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-end">
      <Button variant="secondary" onClick={copy}>Copy draft</Button>
      {href.length < 8000 ? <Button asChild><a href={href}>Open in mail app</a></Button> : null}
    </div>
  }>
    <div className="space-y-4">
      <p className="text-sm text-ink-2">{mode === "reply" ? `Recipient comes from the saved ${outbound ? "To" : "From"} header. For a reply in the existing conversation, use the original message in your mailbox.` : "Add the recipients who should receive this message."} {email.attachments.length ? "Attach the original files yourself; a copied draft does not include attachments." : ""}</p>
      {email.view_url && /^https?:\/\//i.test(email.view_url) ? <Button asChild variant="secondary"><a href={email.view_url} target="_blank" rel="noreferrer">Open original in mailbox</a></Button> : null}
      <Field label="To" hint="Check every recipient before sending. Separate addresses with commas."><Input dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      <Field label="Subject"><Input dir="auto" value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
      <Field label="Message"><Textarea dir="auto" rows={13} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
      {href.length >= 8000 ? <p className="text-sm text-ink-3">This draft is too long for a mail-app link. Copy it or open the original message in your mailbox.</p> : null}
    </div>
  </Drawer>;
}
