import { KeyRound, LogIn, Pencil, RefreshCw, Upload } from "lucide-react";
import type { ReactNode } from "react";
import { Banner, Button } from "@/ui";
import type { Issue, Recovery } from "../issues";

const ACTION: Record<Recovery, { label: string; icon: ReactNode }> = {
  reconnect: { label: "Sign in with Google again", icon: <LogIn aria-hidden /> },
  upload_config: { label: "Upload client file", icon: <Upload aria-hidden /> },
  replace_key: { label: "Replace key", icon: <KeyRound aria-hidden /> },
  replace_password: { label: "Replace password", icon: <KeyRound aria-hidden /> },
  edit: { label: "Edit settings", icon: <Pencil aria-hidden /> },
  test: { label: "Test again", icon: <RefreshCw aria-hidden /> },
};

/**
 * Problem + recovery steps for a connection (states 48 and 72). Handlers that are not passed are
 * left out, so a banner never offers an action the screen cannot perform.
 */
export function IssueBanner({
  issue,
  raw,
  on,
  busy,
  disabled,
  className,
}: {
  issue: Issue;
  /** The service's own message, shown under the steps. */
  raw?: string | null;
  on: Partial<Record<Recovery, () => void>>;
  busy?: Recovery | null;
  disabled?: boolean;
  className?: string;
}) {
  const actions = issue.actions.filter((a, i, all) => on[a] && all.indexOf(a) === i);
  return (
    <Banner
      tone={issue.tone}
      title={issue.title}
      className={className}
      actions={
        actions.length ? (
          <>
            {actions.map((a, i) => (
              <Button
                key={a}
                size="sm"
                variant={i === 0 ? "primary" : "secondary"}
                icon={ACTION[a].icon}
                loading={busy === a}
                disabled={disabled}
                onClick={on[a]}
              >
                {a === "reconnect" && issue.title.startsWith("Finish") ? "Sign in with Google" : ACTION[a].label}
              </Button>
            ))}
          </>
        ) : null
      }
    >
      <p>{issue.body}</p>
      {issue.steps.length ? (
        <ol className="mt-2 list-decimal space-y-0.5 pl-5">
          {issue.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      ) : null}
      {raw ? <p className="mt-2 break-words font-mono text-xs text-ink-3">Reported: {raw}</p> : null}
    </Banner>
  );
}
