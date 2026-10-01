/** Small pieces shared by the inbox table, the phone list and the email page. */
import { MailMinus, Paperclip } from "lucide-react";
import { useCategories } from "@/api/session";
import type { Email } from "@/api/types";
import { cn } from "@/lib/cn";
import { formatRelative, isRtl } from "@/lib/format";
import { intentInfo } from "@/lib/labels";
import { Button, Chip, StatusChip } from "@/ui";
import { canUnsubscribe, type EmailListItem } from "./api";
import { iconFor } from "./categoryIcon";
import { GROUP_LABEL, LOW_CONFIDENCE, MAIL_GROUPS, isMailGroup } from "./labels";

export function senderName(e: Pick<Email, "from_name" | "from_email">): string {
  return e.from_name?.trim() || e.from_email || "Unknown sender";
}

export const dirOf = (text: string | null | undefined) => (isRtl(text) ? "rtl" : "auto");

export function MailDate({ date, className }: { date: string | null; className?: string }) {
  return (
    <time dateTime={date ?? undefined} className={cn("whitespace-nowrap tabular", className)}>
      {formatRelative(date)}
    </time>
  );
}

export function SenderCell({ email }: { email: EmailListItem }) {
  const name = email.from_name?.trim();
  return (
    <div className="min-w-0">
      <p className="truncate font-medium text-ink" title={name || email.from_email} dir={dirOf(name)}>
        {name || email.from_email || "Unknown sender"}
      </p>
      {name ? (
        <p className="truncate text-sm text-ink-3" title={email.from_email}>
          {email.from_email}
        </p>
      ) : null}
      {email.direction === "outbound" ? (
        <Chip size="sm" tone="muted" className="mt-1">
          Sent by us
        </Chip>
      ) : null}
    </div>
  );
}

export function SubjectCell({ email, clamp = 1 }: { email: EmailListItem; clamp?: 1 | 2 }) {
  const files = email.attachments?.length ?? 0;
  return (
    <div className="min-w-0">
      <p className="flex items-start gap-1.5">
        <span className={cn("min-w-0 break-words font-medium text-ink", clamp === 1 ? "line-clamp-1" : "line-clamp-2")} dir={dirOf(email.subject)}>
          {email.subject || "(no subject)"}
        </span>
        {files ? (
          <span className="mt-0.5 inline-flex shrink-0 items-center gap-0.5 text-xs text-ink-3" title={`${files} attachment${files === 1 ? "" : "s"}`}>
            <Paperclip className="size-3.5" aria-hidden />
            <span className="tabular">{files}</span>
            <span className="sr-only">attachments</span>
          </span>
        ) : null}
      </p>
      {email.snippet ? (
        <p className="mt-0.5 line-clamp-2 break-words text-sm text-ink-3" dir={dirOf(email.snippet)}>
          {email.snippet}
        </p>
      ) : null}
    </div>
  );
}

/** Category with its icon; uncertain classifications get an amber mark with words. */
export function CategoryCell({ email, iconName }: { email: EmailListItem; iconName?: string }) {
  const Icon = iconFor(iconName);
  const uncertain = email.category_source !== "user" && email.category_confidence < LOW_CONFIDENCE;
  return (
    <div className="min-w-0 space-y-1">
      <p className="flex items-start gap-2 text-sm text-ink">
        <Icon className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
        <span className="min-w-0 break-words">{email.category_label || email.category}</span>
      </p>
      {uncertain ? <LowConfidenceChip /> : null}
    </div>
  );
}

export function LowConfidenceChip({ className }: { className?: string }) {
  return (
    <StatusChip info={{ label: "Check category", tone: "review" }} size="sm" className={className} />
  );
}

/** Intent chip; the neutral "Other" stays plain text so real signals stand out. */
export function IntentLabel({ intent, className }: { intent: string; className?: string }) {
  const info = intentInfo(intent);
  if (info.tone === "muted") return <span className={cn("text-sm text-ink-3", className)}>{info.label}</span>;
  return <StatusChip info={info} size="sm" className={className} />;
}

export function UnsubscribeButton({
  email,
  onUnsubscribe,
  className,
  size = "sm",
}: {
  email: Pick<Email, "list_unsubscribe" | "unsubscribed_at">;
  onUnsubscribe: () => void;
  className?: string;
  size?: "sm" | "md";
}) {
  if (email.unsubscribed_at)
    return (
      <Chip tone="muted" size="sm" className={className}>
        Unsubscribed
      </Chip>
    );
  if (!canUnsubscribe(email)) return <span className={cn("text-sm text-ink-3", className)}>No unsubscribe link</span>;
  return (
    <Button
      variant="secondary"
      size={size}
      icon={<MailMinus />}
      className={className}
      onClick={(e) => {
        e.stopPropagation();
        onUnsubscribe();
      }}
    >
      Unsubscribe
    </Button>
  );
}

/** Category options for selects and menus, in group order. */
export function useCategoryChoices() {
  const { data } = useCategories();
  return (data ?? [])
    .slice()
    .sort((a, b) => {
      const ga = isMailGroup(a.group) ? MAIL_GROUPS.indexOf(a.group) : 9;
      const gb = isMailGroup(b.group) ? MAIL_GROUPS.indexOf(b.group) : 9;
      return ga - gb || a.order - b.order;
    })
    .map((c) => ({
      key: c.key,
      label: c.label,
      group: c.group,
      groupLabel: isMailGroup(c.group) ? GROUP_LABEL[c.group] : c.group,
      icon: c.icon,
    }));
}
