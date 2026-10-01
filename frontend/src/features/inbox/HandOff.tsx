/**
 * Reply and Forward. The app never sends mail: these open the person's own mail program (or the
 * message in Gmail) and the hint under them says so.
 */
import { ExternalLink } from "lucide-react";
import { useId } from "react";
import type { Email } from "@/api/types";
import { cn } from "@/lib/cn";
import { Button } from "@/ui";
import { forwardMailto, replyMailto, viewUrlOf } from "./mailto";

export function HandOff({ email, className }: { email: Email; className?: string }) {
  const hintId = useId();
  const view = viewUrlOf(email);
  const items = view
    ? [
        { label: "Reply in Gmail", href: view },
        { label: "Forward in Gmail", href: view },
      ]
    : [
        { label: "Reply in your mail app", href: replyMailto(email) },
        { label: "Forward in your mail app", href: forwardMailto(email) },
      ];
  return (
    <div className={cn("min-w-0", className)}>
      <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
        {items.map((it) => (
          <Button key={it.label} asChild variant="secondary" className="w-full sm:w-auto">
            <a href={it.href} aria-describedby={hintId} {...(view ? { target: "_blank", rel: "noreferrer" } : {})}>
              {it.label}
              <ExternalLink aria-hidden />
              {view ? <span className="sr-only">(opens in a new tab)</span> : null}
            </a>
          </Button>
        ))}
      </div>
      <p id={hintId} className="mt-2 text-xs text-ink-3">
        {view ? "Opens Gmail in a new tab" : "Opens your mail program"}; nothing is sent from here.
      </p>
    </div>
  );
}
