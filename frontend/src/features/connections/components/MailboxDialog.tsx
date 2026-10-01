import { useState } from "react";
import { Dialog, toast } from "@/ui";
import type { ConnectionRow } from "../types";
import { MailboxForm } from "./MailboxForm";

/** Add a mailbox, or change the settings of a saved one (Settings › Mailbox & services). */
export function MailboxDialog({
  open,
  onOpenChange,
  conn,
  connections,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The mailbox to edit; without it a new one is added. */
  conn?: ConnectionRow | null;
  connections: ConnectionRow[];
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      title={conn ? "Mailbox settings" : "Add mailbox"}
      description="The app reads enquiry mail and attachments. It never deletes, moves or sends anything on its own."
      size="lg"
      hideClose={busy}
    >
      <MailboxForm
        key={conn?.id ?? "new"}
        conn={conn}
        connections={connections}
        onBusyChange={setBusy}
        onConnected={() => {
          toast.success("Mailbox connected");
          onOpenChange(false);
        }}
      />
    </Dialog>
  );
}
