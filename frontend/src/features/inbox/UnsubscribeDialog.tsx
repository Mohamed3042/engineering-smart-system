/**
 * Unsubscribing contacts a third party, so it is a gate (mockup 53):
 * 1. POST /emails/{id}/unsubscribe {}            → what would happen (nothing is contacted)
 * 2. POST /emails/{id}/unsubscribe {confirm:true} → only after the person confirms here.
 */
import { CircleAlert, Info } from "lucide-react";
import { useEffect } from "react";
import type { Email } from "@/api/types";
import { ConfirmDialog, InlineError, KeyValue, Skeleton, toast } from "@/ui";
import { useUnsubscribe, useUnsubscribeCheck, type UnsubscribeMethod } from "./api";
import { dirOf, senderName } from "./parts";

export type UnsubscribeTarget = Pick<Email, "id" | "from_name" | "from_email" | "subject">;

const METHOD_TEXT: Record<UnsubscribeMethod, string> = {
  one_click:
    "The app sends the sender's own one-click unsubscribe request. Their mail already here is archived in the app.",
  link: "The sender asks you to finish on their website. After you confirm, the app gives you their unsubscribe page and archives their mail here.",
  mailto:
    "This sender only accepts an unsubscribe email. The app never sends mail, so send it from your mailbox if you want to stop it.",
  none: "This sender does not offer a way to unsubscribe.",
};

export function UnsubscribeDialog({
  target,
  onOpenChange,
}: {
  target: UnsubscribeTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const check = useUnsubscribeCheck();
  const run = useUnsubscribe();
  const open = !!target;
  const { mutate: runCheck, reset: resetCheck } = check;
  const { reset: resetRun } = run;

  useEffect(() => {
    if (!target) return;
    resetRun();
    runCheck(target.id);
    return () => resetCheck();
  }, [target, runCheck, resetCheck, resetRun]);

  const method = check.data?.method;
  const canConfirm = method === "one_click" || method === "link";
  const sender = target ? check.data?.sender || target.from_email : "";

  const confirm = () => {
    if (!target) return;
    run.mutate(target.id, {
      onSuccess: (res) => {
        if (res.status === "done") {
          toast.success(`Unsubscribed from ${sender}`, { description: "Their mail here is archived. Your mailbox is unchanged." });
          onOpenChange(false);
        } else if (res.status === "open_link" && res.url) {
          const url = res.url;
          toast.success("Finish on the sender's page", {
            description: "Their mail here is archived. Open their page to complete the unsubscribe.",
            duration: 20_000,
            action: { label: "Open page", onClick: () => window.open(url, "_blank", "noopener,noreferrer") },
          });
          onOpenChange(false);
        } else if (res.status === "needs_mail") {
          toast(res.message ?? "The sender asks for an unsubscribe email. Send it from your mailbox.");
          onOpenChange(false);
        } else if (res.status === "not_available") {
          toast("This sender does not offer a way to unsubscribe.");
          onOpenChange(false);
        }
        // "failed" stays open and shows the reason below
      },
    });
  };

  const failed = run.data?.status === "failed" ? run.data : null;

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onOpenChange(false);
      }}
      title={target ? `Unsubscribe from ${senderName(target)}?` : "Unsubscribe"}
      description="Unsubscribing contacts the sender. Nothing is deleted from your mailbox."
      confirmLabel="Unsubscribe"
      loading={run.isPending}
      disabled={!canConfirm || check.isPending}
      onConfirm={confirm}
    >
      {target ? (
        <div className="space-y-4">
          <KeyValue
            labelWidth="sm"
            items={[
              { label: "Sender", value: <span className="break-all">{sender}</span> },
              {
                label: "Source email",
                value: (
                  <span className="break-words" dir={dirOf(target.subject)}>
                    {target.subject || "(no subject)"}
                  </span>
                ),
              },
            ]}
          />
          {check.isPending ? (
            <div className="space-y-2" aria-label="Checking how this sender unsubscribes">
              <Skeleton className="w-3/4" />
              <Skeleton className="w-1/2" />
            </div>
          ) : check.isError ? (
            <InlineError error={check.error} />
          ) : method ? (
            <p className="flex items-start gap-2.5 text-sm text-ink-2">
              {canConfirm ? (
                <Info className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
              ) : (
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-review" aria-hidden />
              )}
              {METHOD_TEXT[method]}
            </p>
          ) : null}
          {failed ? (
            <InlineError
              error={
                new Error(
                  `The sender did not accept the request${failed.http_status ? ` (HTTP ${failed.http_status})` : ""}. Try again later, or use the unsubscribe link inside the message.`,
                )
              }
            />
          ) : null}
          {run.isError ? <InlineError error={run.error} /> : null}
        </div>
      ) : null}
    </ConfirmDialog>
  );
}
