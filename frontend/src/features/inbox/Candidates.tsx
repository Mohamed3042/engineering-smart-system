import { MailMinus } from "lucide-react";
import { useState } from "react";
import { pluralize } from "@/lib/format";
import { Button, Panel, PanelHeader } from "@/ui";
import type { UnsubscribeCandidate } from "./api";
import { dirOf } from "./parts";
import type { UnsubscribeTarget } from "./UnsubscribeDialog";

const FIRST = 5;

/** Promotion senders with the most mail (GET /inbox/summary). Unsubscribing still goes through the confirm dialog. */
export function Candidates({ candidates, onUnsubscribe }: { candidates: UnsubscribeCandidate[]; onUnsubscribe: (t: UnsubscribeTarget) => void }) {
  const [all, setAll] = useState(false);
  if (candidates.length === 0) return null;
  const shown = all ? candidates : candidates.slice(0, FIRST);
  return (
    <Panel className="mb-4">
      <PanelHeader
        title="Senders you could unsubscribe from"
        description="The promotion senders with the most mail. Nothing is sent until you confirm."
        actions={
          candidates.length > FIRST ? (
            <Button variant="ghost" size="sm" onClick={() => setAll(!all)}>
              {all ? "Show fewer" : `Show all ${candidates.length}`}
            </Button>
          ) : null
        }
      />
      <ul className="divide-y divide-line">
        {shown.map((c) => (
          <li key={c.sender} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:gap-4">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-ink" dir={dirOf(c.name)}>
                {c.name || c.sender}
              </p>
              <p className="truncate text-sm text-ink-3" dir={dirOf(c.sample_subject)}>
                {c.name ? `${c.sender} · ` : ""}
                {pluralize(c.count, "message")} · {c.sample_subject || "(no subject)"}
              </p>
            </div>
            {c.can_unsubscribe ? (
              <Button
                variant="secondary"
                size="sm"
                icon={<MailMinus />}
                className="w-full sm:w-auto"
                onClick={() => onUnsubscribe({ id: c.email_id, from_name: c.name, from_email: c.sender, subject: c.sample_subject })}
              >
                Unsubscribe
              </Button>
            ) : (
              <span className="text-sm text-ink-3">No unsubscribe link</span>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
