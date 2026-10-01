import type { ReactNode } from "react";
import { SettingsBack } from "@/features/connections/components/bits";
import { cn } from "@/lib/cn";
import { PageHeader } from "@/ui";

/**
 * Frame for a settings screen. SettingsLayout already supplies the outer padding and the section list,
 * so this adds the phone "back to Settings" link, the page header and a readable width.
 */
export function SettingsPage({
  title,
  meta,
  status,
  actions,
  width = "medium",
  children,
  className,
}: {
  title: ReactNode;
  meta?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  width?: "narrow" | "medium" | "full";
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", width === "narrow" && "max-w-[760px]", width === "medium" && "max-w-[980px]", className)}>
      <SettingsBack />
      <PageHeader title={title} meta={meta} status={status} actions={actions} />
      <div className="space-y-6 md:space-y-8">{children}</div>
    </div>
  );
}
